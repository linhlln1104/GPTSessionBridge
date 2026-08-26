import {
  createServer,
  request as createHttpRequest,
  type ClientRequest,
  type Server,
} from "node:http";

import {
  TOOL_WORKFLOW_ENVELOPE_BEGIN,
  TOOL_WORKFLOW_ENVELOPE_END,
  canonicalizeToolWorkflowJson,
  type JsonObject,
  type JsonValue,
} from "@gpt-session-bridge/protocol";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AgentSessionCoordinator,
  type AgentBrowserBinding,
  type AgentBrowserTurnBoundary,
} from "../src/browser/agent-session-coordinator.js";
import type {
  BrowserTurnHandle,
  BrowserTurnRequest,
  BrowserTurnSink,
  BrowserTurnTerminal,
} from "../src/browser/browser-session-coordinator.js";
import {
  ResponsesAgentRuntime,
  type ResponsesAgentRuntimeOptions,
} from "../src/http/responses-agent-runtime.js";
import type {
  ResolvedResponsesModelRoute,
  ResponsesAgentHttpHandler,
  ResponsesAgentHttpRequest,
} from "../src/http/responses-server.js";
import { ResponsesServerV2 } from "../src/http/responses-server-v2.js";

const NOW = 2_000_000;
const MODEL = `gptsessionbridge/web/route-v1-${"A".repeat(43)}`;
const DEFAULT_HEADERS = Object.freeze({
  clientRequestId: "request-fixture",
  threadId: "thread-fixture",
  turnMetadata: '{"turn_id":"turn-fixture"}',
});
const ROUTE: ResolvedResponsesModelRoute = Object.freeze({
  catalogRevision: "catalog-fixture",
  defaultReasoningEffort: "high",
  modelId: "model-web-fixture",
  profile: "agent-v2",
  sessionGeneration: 1,
  sessionId: "session-fixture",
});

describe("ResponsesAgentRuntime", () => {
  it("runs the synthetic initial -> official-child tool -> continuation -> final SSE flow", async () => {
    const fixture = await createFixture();
    try {
      expectTypeOf(fixture.runtime).toExtend<ResponsesAgentHttpHandler>();
      const initialResponse = fixture.http.open(initialBody(true));
      await eventually(() => fixture.boundary.turns.length === 1);
      await fixture.boundary.complete(
        0,
        assistantEnvelope({
          ...readRoundBinding(fixture.boundary.requireTurn(0).request),
          arguments: { cmd: "git status --short" },
          kind: "tool_call",
          tool: "exec_command",
        }),
      );

      const first = await initialResponse.result;
      expect(first.status).toBe(200);
      expect(first.contentType).toContain("text/event-stream");
      const firstEvents = parseSse(first.body);
      expect(firstEvents.map((event) => event["type"])).toEqual([
        "response.created",
        "response.in_progress",
        "response.output_item.added",
        "response.function_call_arguments.delta",
        "response.function_call_arguments.done",
        "response.output_item.done",
        "response.completed",
      ]);
      const call = readCompletedFunctionCall(firstEvents);
      expect(fixture.runtime.pendingCount).toBe(1);

      const continuationResponse = fixture.http.open(
        continuationBody(call, "official child output", true),
      );
      await eventually(() => fixture.boundary.turns.length === 2);
      await fixture.boundary.complete(
        1,
        assistantEnvelope({
          ...readRoundBinding(fixture.boundary.requireTurn(1).request),
          kind: "final",
          text: "Completed safely.",
        }),
      );

      const final = await continuationResponse.result;
      expect(final.status, final.body).toBe(200);
      const finalEvents = parseSse(final.body);
      expect(finalEvents.map((event) => event["sequence_number"])).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      expect(finalEvents.at(-1)).toMatchObject({
        response: {
          output: [{ content: [{ text: "Completed safely.", type: "output_text" }] }],
          status: "completed",
        },
        type: "response.completed",
      });
      expect(fixture.runtime.pendingCount).toBe(0);
      expect(fixture.boundary.turns).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });

  it("runs two official-child tool rounds from Codex cumulative continuation history", async () => {
    const fixture = await createFixture();
    try {
      const initialResponse = fixture.http.open(initialBody(true));
      await eventually(() => fixture.boundary.turns.length === 1);
      await fixture.boundary.complete(
        0,
        assistantEnvelope({
          ...readRoundBinding(fixture.boundary.requireTurn(0).request),
          arguments: { cmd: "git status --short" },
          kind: "tool_call",
          tool: "exec_command",
        }),
      );
      const firstHttp = await initialResponse.result;
      const firstCall = readCompletedFunctionCall(parseSse(firstHttp.body));

      const firstContinuation = fixture.http.open(
        cumulativeContinuationBody(
          [{ call: firstCall, output: "first official child output" }],
          true,
        ),
      );
      await eventually(() => fixture.boundary.turns.length === 2);
      await fixture.boundary.complete(
        1,
        assistantEnvelope({
          ...readRoundBinding(fixture.boundary.requireTurn(1).request),
          arguments: { cmd: "pwd" },
          kind: "tool_call",
          tool: "exec_command",
        }),
      );
      const secondHttp = await firstContinuation.result;
      const secondCall = readCompletedFunctionCall(parseSse(secondHttp.body));

      const secondContinuation = fixture.http.open(
        cumulativeContinuationBody(
          [
            { call: firstCall, output: "first official child output" },
            { call: secondCall, output: "second official child output" },
          ],
          true,
        ),
      );
      await eventually(() => fixture.boundary.turns.length === 3);
      await fixture.boundary.complete(
        2,
        assistantEnvelope({
          ...readRoundBinding(fixture.boundary.requireTurn(2).request),
          kind: "final",
          text: "Two rounds completed safely.",
        }),
      );

      const final = await secondContinuation.result;
      expect(final.status, final.body).toBe(200);
      expect(parseSse(final.body).at(-1)).toMatchObject({
        response: {
          output: [{ content: [{ text: "Two rounds completed safely.", type: "output_text" }] }],
          status: "completed",
        },
        type: "response.completed",
      });
      expect(fixture.runtime.pendingCount).toBe(0);
      expect(fixture.boundary.turns).toHaveLength(3);
    } finally {
      await fixture.close();
    }
  });

  it("writes the complete non-streaming Responses JSON lifecycle", async () => {
    const fixture = await createFixture();
    try {
      const pending = fixture.http.open(initialBody(false));
      await eventually(() => fixture.boundary.turns.length === 1);
      await fixture.boundary.complete(
        0,
        assistantEnvelope({
          ...readRoundBinding(fixture.boundary.requireTurn(0).request),
          kind: "final",
          text: "Direct final.",
        }),
      );

      const response = await pending.result;
      expect(response.status).toBe(200);
      expect(response.contentType).toContain("application/json");
      expect(JSON.parse(response.body)).toMatchObject({
        model: MODEL,
        output: [{ content: [{ text: "Direct final.", type: "output_text" }] }],
        reasoning: { effort: "high", summary: null },
        status: "completed",
      });
      expect(fixture.runtime.pendingCount).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("consumes a profile-drifted continuation and rejects its replay", async () => {
    const fixture = await createFixture();
    try {
      const call = await emitToolCall(fixture);
      const drifted = continuationBody(call, "official child output", true);
      const tools = drifted.tools;
      const exec = tools.find((tool) => tool.type === "function" && tool.name === "exec_command");
      if (exec === undefined) {
        throw new Error("Missing runtime fixture tool.");
      }
      exec.description = "Drifted tool contract";

      const rejected = await fixture.http.open(drifted).result;
      expect(rejected.status).toBe(409);
      expect(readErrorCode(rejected.body)).toBe("child_continuation_mismatch");
      expect(fixture.runtime.pendingCount).toBe(0);
      expect(fixture.boundary.turns).toHaveLength(1);

      const replay = await fixture.http.open(continuationBody(call, "official child output", true))
        .result;
      expect(replay.status).toBe(409);
      expect(readErrorCode(replay.body)).toBe("child_continuation_mismatch");
      expect(fixture.boundary.turns).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("binds continuation admission to the exact route and Codex headers", async () => {
    const fixture = await createFixture();
    try {
      const call = await emitToolCall(fixture);
      const rejected = await fixture.http.open(
        continuationBody(call, "official child output", true),
        { ...DEFAULT_HEADERS, threadId: "different-thread" },
      ).result;

      expect(rejected.status).toBe(409);
      expect(readErrorCode(rejected.body)).toBe("child_continuation_mismatch");
      expect(fixture.runtime.pendingCount).toBe(0);
      expect(fixture.boundary.turns).toHaveLength(1);

      const routeBoundCall = await emitToolCall(fixture);
      fixture.http.route = Object.freeze({ ...ROUTE, catalogRevision: "catalog-drift" });
      const routeRejected = await fixture.http.open(
        continuationBody(routeBoundCall, "official child output", true),
      ).result;
      expect(routeRejected.status).toBe(409);
      expect(readErrorCode(routeRejected.body)).toBe("child_continuation_mismatch");
      expect(fixture.runtime.pendingCount).toBe(0);
      expect(fixture.boundary.turns).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });

  it("expires pending calls and enforces the bounded workflow registry", async () => {
    let now = NOW;
    const fixture = await createFixture({
      maxPendingWorkflows: 1,
      now: () => now,
      pendingTtlMs: 1_000,
    });
    try {
      const call = await emitToolCall(fixture);
      const busy = await fixture.http.open(initialBody(true)).result;
      expect(busy.status).toBe(503);
      expect(readErrorCode(busy.body)).toBe("agent_runtime_unavailable");
      expect(fixture.boundary.turns).toHaveLength(1);

      now += 1_001;
      const expired = await fixture.http.open(continuationBody(call, "official child output", true))
        .result;
      expect(expired.status).toBe(409);
      expect(readErrorCode(expired.body)).toBe("child_continuation_mismatch");
      expect(fixture.runtime.pendingCount).toBe(0);
      expect(fixture.boundary.turns).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("cancels the browser workflow when the HTTP client disconnects", async () => {
    const fixture = await createFixture();
    try {
      const request = fixture.http.open(initialBody(true));
      void request.result.catch(() => undefined);
      await eventually(() => fixture.boundary.turns.length === 1);
      request.abort();

      await eventually(() => fixture.boundary.cancellations === 1);
      expect(fixture.runtime.pendingCount).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("cancels an in-flight browser workflow when the runtime closes", async () => {
    const fixture = await createFixture();
    try {
      const request = fixture.http.open(initialBody(true));
      await eventually(() => fixture.boundary.turns.length === 1);

      fixture.runtime.close();

      await eventually(() => fixture.boundary.cancellations === 1);
      expect(fixture.runtime.pendingCount).toBe(0);
      expect((await request.result).status).toBe(502);
    } finally {
      await fixture.close();
    }
  });
});

interface Fixture {
  readonly boundary: FakeAgentBoundary;
  close(): Promise<void>;
  readonly http: RuntimeHttpHarness;
  readonly runtime: ResponsesAgentRuntime;
}

async function createFixture(
  overrides: Partial<ResponsesAgentRuntimeOptions> = {},
): Promise<Fixture> {
  const boundary = new FakeAgentBoundary();
  let randomValue = 1;
  let responseValue = 1;
  const now = overrides.now ?? (() => NOW);
  const runtime = new ResponsesAgentRuntime({
    createBoundary: () => boundary,
    createCoordinator: (candidate) =>
      new AgentSessionCoordinator(candidate, {
        createRandomBytes: (size) => {
          const bytes = new Uint8Array(size);
          bytes.fill(randomValue);
          randomValue += 1;
          return bytes;
        },
        now,
      }),
    createRandomBytes: (size) => {
      const bytes = new Uint8Array(size);
      bytes.fill(randomValue);
      randomValue += 1;
      return bytes;
    },
    createResponsesBoundary: (profile) =>
      new ResponsesServerV2({
        identitySource: {
          createMessageId: () => `msg_${String(responseValue++).padStart(16, "0")}`,
          createResponseId: () => `resp_${String(responseValue++).padStart(16, "0")}`,
          nowEpochSeconds: () => 1_800_000_000,
        },
        toolProfile: profile,
      }),
    now,
    ...overrides,
  });
  const http = new RuntimeHttpHarness(runtime);
  await http.start();
  return {
    boundary,
    close: async () => {
      runtime.close();
      await http.close();
    },
    http,
    runtime,
  };
}

class RuntimeHttpHarness {
  readonly #runtime: ResponsesAgentRuntime;
  readonly #server: Server;
  #port: number | undefined;
  public route: ResolvedResponsesModelRoute = ROUTE;

  public constructor(runtime: ResponsesAgentRuntime) {
    this.#runtime = runtime;
    this.#server = createServer((request, response) => {
      void (async () => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk as Uint8Array));
        }
        const body = Buffer.concat(chunks);
        const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        await this.#runtime.handleRequest(
          Object.freeze({
            body,
            ...readHarnessHeaders(request.headers),
            model: parsed["model"] as string,
            response,
            route: this.route,
          }),
        );
      })().catch(() => response.destroy());
    });
  }

  public async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Runtime HTTP fixture did not bind.");
    }
    this.#port = address.port;
  }

  public open(
    body: Record<string, unknown>,
    headers: HarnessHeaders = DEFAULT_HEADERS,
  ): Readonly<{ abort(): void; result: Promise<HttpResult> }> {
    const port = this.#port;
    if (port === undefined) {
      throw new Error("Runtime HTTP fixture is not listening.");
    }
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    let client: ClientRequest | undefined;
    const result = new Promise<HttpResult>((resolve, reject) => {
      client = createHttpRequest(
        {
          headers: {
            "content-length": String(payload.byteLength),
            "content-type": "application/json",
            "thread-id": headers.threadId,
            "x-client-request-id": headers.clientRequestId,
            "x-codex-turn-metadata": headers.turnMetadata,
          },
          host: "127.0.0.1",
          method: "POST",
          path: "/v1/responses",
          port,
        },
        (response) => {
          const chunks: Uint8Array[] = [];
          response.on("data", (chunk: Uint8Array) => chunks.push(Buffer.from(chunk)));
          response.once("end", () => {
            resolve({
              body: Buffer.concat(chunks).toString("utf8"),
              contentType: response.headers["content-type"] ?? "",
              status: response.statusCode ?? 0,
            });
          });
        },
      );
      client.once("error", reject);
      client.end(payload);
    });
    return Object.freeze({
      abort: () => client?.destroy(),
      result,
    });
  }

  public async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
      this.#server.closeAllConnections();
    });
  }
}

interface HarnessHeaders {
  readonly clientRequestId: string;
  readonly threadId: string;
  readonly turnMetadata: string;
}

interface HttpResult {
  readonly body: string;
  readonly contentType: string;
  readonly status: number;
}

function readHarnessHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): Omit<ResponsesAgentHttpRequest, "body" | "model" | "response" | "route"> {
  const clientRequestId = readHeader(headers["x-client-request-id"]);
  const threadId = readHeader(headers["thread-id"]);
  const turnMetadata = readHeader(headers["x-codex-turn-metadata"]);
  return {
    ...(clientRequestId === undefined ? {} : { clientRequestId }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(turnMetadata === undefined ? {} : { turnMetadata }),
  };
}

function readHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

interface FakeTurn {
  readonly completion: Deferred<BrowserTurnTerminal>;
  readonly request: BrowserTurnRequest;
  readonly sink: BrowserTurnSink;
}

class FakeAgentBoundary implements AgentBrowserTurnBoundary {
  public binding: AgentBrowserBinding | undefined = browserBinding();
  public cancellations = 0;
  public readonly turns: FakeTurn[] = [];

  public noteAgentActivity(expected: AgentBrowserBinding): AgentBrowserBinding {
    if (!sameBinding(expected, this.binding)) {
      throw new Error("binding drift");
    }
    return expected;
  }

  public readBinding(): AgentBrowserBinding | undefined {
    return this.binding;
  }

  public startBoundTurn(
    expected: AgentBrowserBinding,
    request: BrowserTurnRequest,
    sink: BrowserTurnSink,
  ): BrowserTurnHandle {
    if (!sameBinding(expected, this.binding)) {
      throw new Error("atomic binding drift");
    }
    const completion = deferred<BrowserTurnTerminal>();
    let cancelled = false;
    this.turns.push({ completion, request, sink });
    return Object.freeze({
      cancel: () => {
        if (!cancelled) {
          cancelled = true;
          this.cancellations += 1;
          completion.resolve({ kind: "cancelled" });
        }
        return Promise.resolve();
      },
      completion: completion.promise,
      started: Promise.resolve(),
      turnId: `browser-turn-${String(this.turns.length)}`,
    });
  }

  public async complete(index: number, output: string): Promise<void> {
    const turn = this.requireTurn(index);
    await turn.sink.onDelta({ channel: "outputText", delta: output });
    turn.completion.resolve({ finishReason: "stop", kind: "completed" });
  }

  public requireTurn(index: number): FakeTurn {
    const turn = this.turns[index];
    if (turn === undefined) {
      throw new Error(`Missing synthetic browser turn ${String(index)}.`);
    }
    return turn;
  }
}

interface ActualTool {
  description?: string;
  name?: string;
  parameters?: Record<string, unknown>;
  search_context_size?: string;
  strict?: boolean;
  type: string;
}

function initialBody(stream: boolean): Record<string, unknown> & { tools: ActualTool[] } {
  return {
    include: ["reasoning.encrypted_content"],
    input: [
      {
        content: [{ text: "Developer context", type: "input_text" }],
        id: "msg_realdeveloper0001",
        role: "developer",
        type: "message",
      },
      {
        content: [{ text: "User request", type: "input_text" }],
        id: "msg_realuser00000001",
        role: "user",
        type: "message",
      },
    ],
    instructions: "Synthetic developer instructions",
    model: MODEL,
    parallel_tool_calls: true,
    prompt_cache_key: "compatibility-only-field",
    reasoning: { summary: "auto" },
    store: false,
    stream,
    stream_options: { include_obfuscation: false },
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [
      { name: "workspace", type: "namespace" },
      {
        description: "Execute a command through the official Codex child.",
        name: "exec_command",
        parameters: {
          additionalProperties: false,
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
          type: "object",
        },
        strict: false,
        type: "function",
      },
      { search_context_size: "medium", type: "web_search" },
    ],
  };
}

function continuationBody(
  call: Record<string, unknown>,
  output: string,
  stream: boolean,
): Record<string, unknown> & { tools: ActualTool[] } {
  return cumulativeContinuationBody([{ call, output }], stream);
}

function cumulativeContinuationBody(
  rounds: readonly Readonly<{
    call: Record<string, unknown>;
    output: string;
  }>[],
  stream: boolean,
): Record<string, unknown> & { tools: ActualTool[] } {
  const body = initialBody(stream);
  const input = body["input"] as unknown[];
  body["input"] = [
    ...input,
    ...rounds.flatMap(({ call, output }, index) => [
      {
        arguments: call["arguments"],
        call_id: call["call_id"],
        id: call["id"],
        name: call["name"],
        type: "function_call",
      },
      {
        call_id: call["call_id"],
        id: `fco_actualchildoutput${String(index + 1)}`,
        output,
        type: "function_call_output",
      },
    ]),
  ];
  return body;
}

async function emitToolCall(fixture: Fixture): Promise<Record<string, unknown>> {
  const pending = fixture.http.open(initialBody(true));
  const turnIndex = fixture.boundary.turns.length;
  await eventually(() => fixture.boundary.turns.length === turnIndex + 1);
  await fixture.boundary.complete(
    turnIndex,
    assistantEnvelope({
      ...readRoundBinding(fixture.boundary.requireTurn(turnIndex).request),
      arguments: { cmd: "git status --short" },
      kind: "tool_call",
      tool: "exec_command",
    }),
  );
  const response = await pending.result;
  expect(response.status).toBe(200);
  return readCompletedFunctionCall(parseSse(response.body));
}

function parseSse(body: string): Record<string, unknown>[] {
  return body
    .trim()
    .split("\n\n")
    .map((record) => {
      const data = record
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length);
      if (data === undefined) {
        throw new Error("Malformed synthetic SSE record.");
      }
      return JSON.parse(data) as Record<string, unknown>;
    });
}

function readCompletedFunctionCall(
  events: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const completed = events.find((event) => event["type"] === "response.completed");
  const response = completed?.["response"];
  const output = isRecord(response) ? response["output"] : undefined;
  const call = isUnknownArray(output) ? output[0] : undefined;
  if (!isRecord(call) || call["type"] !== "function_call") {
    throw new Error("Missing synthetic function call response.");
  }
  return call;
}

function readErrorCode(body: string): unknown {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed) || !isRecord(parsed["error"])) {
    return undefined;
  }
  return parsed["error"]["code"];
}

interface RoundBinding {
  readonly challenge: string;
  readonly manifestDigest: string;
  readonly round: number;
  readonly turn: string;
  readonly v: 2;
}

function readRoundBinding(request: BrowserTurnRequest): RoundBinding {
  const prompt = request.input[0]?.text;
  const publicLine = prompt
    ?.split("\n")
    .find((line) => line.startsWith("PUBLIC_BINDING "))
    ?.slice("PUBLIC_BINDING ".length);
  const encoded = publicLine ?? prompt?.split("\n")[1];
  if (encoded === undefined) {
    throw new Error("Missing synthetic round binding.");
  }
  const value = JSON.parse(encoded) as RoundBinding;
  return {
    challenge: value.challenge,
    manifestDigest: value.manifestDigest,
    round: value.round,
    turn: value.turn,
    v: value.v,
  };
}

function assistantEnvelope(
  value:
    | (RoundBinding & { readonly kind: "final"; readonly text: string })
    | (RoundBinding & {
        readonly arguments: JsonObject;
        readonly kind: "tool_call";
        readonly tool: string;
      }),
): string {
  return `${TOOL_WORKFLOW_ENVELOPE_BEGIN}\n${canonicalizeToolWorkflowJson(
    value as unknown as JsonValue,
  )}\n${TOOL_WORKFLOW_ENVELOPE_END}`;
}

function browserBinding(): AgentBrowserBinding {
  return Object.freeze({
    catalogRevision: ROUTE.catalogRevision,
    conversationOwnershipId: "ownership-fixture",
    documentGeneration: 1,
    documentId: "document-fixture",
    expiresAtMs: NOW + 60_000,
    issuedAtMs: NOW - 1_000,
    lastActivityAtMs: NOW - 500,
    leaseId: "lease-fixture",
    modelId: ROUTE.modelId,
    providerRoute: MODEL,
    sessionGeneration: ROUTE.sessionGeneration,
    sessionId: ROUTE.sessionId,
    tabId: 7,
  });
}

function sameBinding(left: AgentBrowserBinding, right: AgentBrowserBinding | undefined): boolean {
  return (
    right !== undefined &&
    canonicalizeToolWorkflowJson(left as unknown as JsonValue) ===
      canonicalizeToolWorkflowJson(right as unknown as JsonValue)
  );
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Synthetic runtime condition was not reached.");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}
