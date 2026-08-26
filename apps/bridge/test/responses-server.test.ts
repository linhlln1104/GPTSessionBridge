import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";

import { generateCapabilityToken, type CapabilityToken } from "@gpt-session-bridge/core/security";
import { BRIDGE_ERROR_CODES } from "@gpt-session-bridge/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  BrowserTurnHandle,
  BrowserTurnRequest,
  BrowserTurnSink,
  BrowserTurnTerminal,
} from "../src/browser/browser-session-coordinator.js";
import { createBrowserSessionError } from "../src/browser/browser-session-errors.js";
import {
  ResponsesServer,
  SESSION_NOT_CONNECTED_CODE,
  type ResponsesAgentHttpRequest,
  type ResponsesTurnCoordinator,
} from "../src/http/responses-server.js";

const PROVIDER_MODEL = "gptsessionbridge/web/route-v1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("ResponsesServer", () => {
  let coordinator: FakeTurnCoordinator;
  let server: ResponsesServer;
  let token: CapabilityToken;

  beforeEach(async () => {
    token = generateCapabilityToken();
    coordinator = new FakeTurnCoordinator();
    server = createServer(token, coordinator);
    await server.start();
  });

  afterEach(async () => {
    await server.close();
  });

  it("maps bounded user text to an exact browser route and returns non-stream JSON", async () => {
    coordinator.deltas = [
      { channel: "outputText", delta: "Hello" },
      { channel: "outputText", delta: " world" },
    ];
    const response = await post(server, token, {
      input: [
        {
          content: [{ text: "first", type: "input_text" }],
          role: "user",
          type: "message",
        },
      ],
      model: PROVIDER_MODEL,
      reasoning: { effort: "medium", summary: null },
      stream: false,
      store: false,
      text: { format: { type: "text" } },
      tool_choice: "none",
      tools: [],
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      model: PROVIDER_MODEL,
      object: "response",
      output: [
        {
          content: [{ text: "Hello world", type: "output_text" }],
          role: "assistant",
          status: "completed",
          type: "message",
        },
      ],
      status: "completed",
    });
    expect(coordinator.requests).toEqual([
      {
        catalogRevision: "catalog-a",
        input: [{ text: "first", type: "text" }],
        modelId: "web-model",
        reasoningEffort: "medium",
        sessionGeneration: 1,
        sessionId: "session-a",
        temporary: false,
      },
    ]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("emits the minimal Responses SSE lifecycle in order", async () => {
    coordinator.deltas = [
      { channel: "outputText", delta: "Hel" },
      { channel: "outputText", delta: "lo" },
    ];
    const response = await post(server, token, {
      input: "private-stream-prompt",
      model: PROVIDER_MODEL,
      reasoning: { effort: "low" },
      stream: true,
      stream_options: { include_obfuscation: false },
    });
    const body = await response.text();
    const events = parseSse(body);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(events.map((event) => event.event)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events.map((event) => event.data["sequence_number"])).toEqual(
      events.map((_, index) => index),
    );
    expect(events[4]?.data).toMatchObject({ delta: "Hel", type: "response.output_text.delta" });
    expect(events.at(-1)?.data).toMatchObject({
      response: { status: "completed" },
      type: "response.completed",
    });
    expect(body).not.toContain("private-stream-prompt");
  });

  it("dispatches an agent-v2 route before the text-only request parser", async () => {
    const requests: ResponsesAgentHttpRequest[] = [];
    const agentServer = createServer(token, coordinator, {
      agentHandler: {
        handleRequest(request): Promise<void> {
          requests.push(request);
          request.response.statusCode = 204;
          request.response.end();
          return Promise.resolve();
        },
      },
      profile: "agent-v2",
    });
    await server.close();
    server = agentServer;
    await server.start();

    const response = await fetch(`${server.address.baseUrl}/responses`, {
      body: JSON.stringify({
        input: [
          {
            content: [{ text: "agent prompt", type: "input_text" }],
            id: "msg_fixture",
            role: "user",
            type: "message",
          },
        ],
        model: PROVIDER_MODEL,
        parallel_tool_calls: true,
        stream: true,
        tools: [{ name: "exec_command", type: "function" }],
      }),
      headers: {
        ...authorizedHeaders(token),
        "thread-id": "thread-fixture",
        "x-client-request-id": "request-fixture",
        "x-codex-turn-metadata": '{"turn_id":"turn-fixture"}',
      },
      method: "POST",
    });

    expect(response.status).toBe(204);
    expect(coordinator.requests).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      clientRequestId: "request-fixture",
      model: PROVIDER_MODEL,
      threadId: "thread-fixture",
      turnMetadata: '{"turn_id":"turn-fixture"}',
      route: { profile: "agent-v2" },
    });
  });

  it("returns a safe disconnected error without reflecting request or browser text", async () => {
    const canary = "private-request-canary";
    coordinator.startError = createBrowserSessionError(
      BRIDGE_ERROR_CODES.SESSION_NOT_CONNECTED,
      `remote detail ${canary}`,
      true,
    );
    const response = await post(server, token, {
      input: canary,
      model: PROVIDER_MODEL,
      reasoning: { effort: "medium" },
    });
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toMatchObject({ error: { code: SESSION_NOT_CONNECTED_CODE } });
    expect(body).not.toContain(canary);
  });

  it("observes a rejected pre-ack start promise while completion settles the request", async () => {
    coordinator.startAcknowledgementError = new Error("synthetic pre-ack rejection");
    const response = await post(server, token, {
      input: "prompt",
      model: PROVIDER_MODEL,
      reasoning: { effort: "medium" },
    });

    expect(response.status).toBe(200);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  });

  it("requires the process capability and loopback request policy", async () => {
    const unauthenticated = await fetch(`${server.address.baseUrl}/responses`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toBe("Bearer");

    const malformed = await fetch(`${server.address.baseUrl}/responses`, {
      body: "{}",
      headers: {
        authorization: "Bearer invalid token",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(malformed.status).toBe(401);

    const rejectedHost = await rawRequest(server.address.port, {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Host: "example.invalid",
    });
    expect(rejectedHost.status).toBe(403);

    const rejectedOrigin = await rawRequest(server.address.port, {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Host: `127.0.0.1:${String(server.address.port)}`,
      Origin: "https://example.invalid",
    });
    expect(rejectedOrigin.status).toBe(403);
  });

  it("rejects malformed, oversized, non-JSON, unknown-model, and unknown-route requests", async () => {
    const headers = authorizedHeaders(token);
    const malformed = await fetch(`${server.address.baseUrl}/responses`, {
      body: "not-json",
      headers,
      method: "POST",
    });
    expect(malformed.status).toBe(400);

    const nonObject = await fetch(`${server.address.baseUrl}/responses`, {
      body: "[]",
      headers,
      method: "POST",
    });
    expect(nonObject.status).toBe(400);

    const nonJson = await fetch(`${server.address.baseUrl}/responses`, {
      body: "{}",
      headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
      method: "POST",
    });
    expect(nonJson.status).toBe(415);

    const oversized = await fetch(`${server.address.baseUrl}/responses`, {
      body: JSON.stringify({ input: "x".repeat(5_000) }),
      headers,
      method: "POST",
    });
    expect(oversized.status).toBe(413);

    const unknownModel = await post(server, token, {
      input: "hello",
      model: "unknown-model",
      reasoning: { effort: "medium" },
    });
    expect(unknownModel.status).toBe(400);
    await expect(unknownModel.json()).resolves.toMatchObject({
      error: { code: "model_not_found" },
    });

    const unknownRoute = await fetch(`${server.address.baseUrl}/unknown`, {
      body: "{}",
      headers,
      method: "POST",
    });
    expect(unknownRoute.status).toBe(404);
  });

  it.each([
    [
      { input: "prompt", model: PROVIDER_MODEL, tools: [{ type: "web_search" }] },
      "unsupported_tools",
    ],
    [
      {
        input: [
          {
            content: [
              { text: "first", type: "input_text" },
              { text: "second", type: "input_text" },
            ],
            role: "user",
          },
        ],
        model: PROVIDER_MODEL,
      },
      "unsupported_input",
    ],
    [
      {
        input: [
          {
            content: [{ image_url: "private-image-canary", type: "input_image" }],
            role: "user",
          },
        ],
        model: PROVIDER_MODEL,
      },
      "unsupported_input",
    ],
    [
      {
        input: [{ content: "private-assistant-canary", role: "assistant" }],
        model: PROVIDER_MODEL,
      },
      "unsupported_input",
    ],
    [
      { input: "prompt", instructions: "private-instructions-canary", model: PROVIDER_MODEL },
      "unsupported_request",
    ],
    [{ input: "prompt", max_output_tokens: 100, model: PROVIDER_MODEL }, "unsupported_request"],
    [{ input: "prompt", model: PROVIDER_MODEL, store: true }, "unsupported_request"],
  ] as const)("fails closed for unsupported Responses semantics", async (request, code) => {
    const response = await post(server, token, request);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({ error: { code } });
    expect(body).not.toContain("private-");
    expect(coordinator.requests).toHaveLength(0);
  });

  it("fails closed on the current Codex tool-bearing request contract", async () => {
    const response = await post(server, token, {
      client_metadata: { client: "synthetic-codex-contract" },
      include: [],
      input: [
        { content: "synthetic developer context", role: "developer" },
        { content: "synthetic user context", role: "user" },
        { content: "synthetic request", role: "user" },
      ],
      instructions: "synthetic instructions",
      model: PROVIDER_MODEL,
      parallel_tool_calls: true,
      prompt_cache_key: "synthetic-cache-key",
      reasoning: { effort: "medium" },
      store: false,
      stream: true,
      tool_choice: "auto",
      tools: Array.from({ length: 18 }, (_, index) => ({
        name: `synthetic_tool_${String(index)}`,
        type: "function",
      })),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unsupported_request" },
    });
    expect(coordinator.requests).toHaveLength(0);
  });

  it("cancels the browser turn when the streaming client disconnects", async () => {
    coordinator.autoComplete = false;
    const cancelled = coordinator.cancelled;
    const request = httpRequest(
      {
        headers: authorizedHeaders(token),
        host: "127.0.0.1",
        method: "POST",
        path: "/v1/responses",
        port: server.address.port,
      },
      (response) => {
        response.once("data", () => {
          response.destroy();
          request.destroy();
        });
      },
    );
    request.on("error", () => undefined);
    request.end(
      JSON.stringify({
        input: "disconnect-canary",
        model: PROVIDER_MODEL,
        reasoning: { effort: "medium" },
        stream: true,
      }),
    );

    await expect(cancelled).resolves.toBeUndefined();
    expect(coordinator.cancelCount).toBe(1);
  });

  it("does not submit a browser turn after the client disconnects before the response starts", async () => {
    coordinator.autoComplete = false;
    const request = httpRequest({
      headers: authorizedHeaders(token),
      host: "127.0.0.1",
      method: "POST",
      path: "/v1/responses",
      port: server.address.port,
    });
    request.on("error", () => undefined);
    const closed = new Promise<void>((resolve) => {
      request.once("close", resolve);
    });
    request.end(
      JSON.stringify({
        input: "pre-start-disconnect-canary",
        model: PROVIDER_MODEL,
        reasoning: { effort: "medium" },
      }),
      () => {
        request.destroy();
      },
    );

    await closed;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(coordinator.requests).toHaveLength(0);
  });

  it("fails the stream and cancels when the browser emits an unsupported channel", async () => {
    coordinator.deltas = [{ channel: "reasoning", delta: "private-reasoning-canary" }];
    const response = await post(server, token, {
      input: "prompt",
      model: PROVIDER_MODEL,
      reasoning: { effort: "medium" },
      stream: true,
    });
    const body = await response.text();
    const events = parseSse(body);

    expect(events.at(-1)?.event).toBe("response.failed");
    expect(events.at(-1)?.data).toMatchObject({
      response: { error: { code: "unsupported_output" }, status: "failed" },
    });
    expect(body).not.toContain("private-reasoning-canary");
    expect(coordinator.cancelCount).toBe(1);
  });

  it("bounds aggregate output by UTF-8 bytes and does not return partial non-stream text", async () => {
    await server.close();
    coordinator.deltas = [{ channel: "outputText", delta: "ééé" }];
    server = createServer(token, coordinator, { maxOutputBytes: 4 });
    await server.start();
    const response = await post(server, token, {
      input: "prompt",
      model: PROVIDER_MODEL,
      reasoning: { effort: "medium" },
    });
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(body)).toMatchObject({ error: { code: "response_too_large" } });
    expect(body).not.toContain("ééé");
    expect(coordinator.cancelCount).toBe(1);
  });

  it("fails closed instead of representing a length-limited turn as completed", async () => {
    coordinator.deltas = [{ channel: "outputText", delta: "partial-output-canary" }];
    coordinator.terminal = { finishReason: "length", kind: "completed" };
    const response = await post(server, token, {
      input: "prompt",
      model: PROVIDER_MODEL,
      reasoning: { effort: "medium" },
    });
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(body)).toMatchObject({ error: { code: "response_incomplete" } });
    expect(body).not.toContain("partial-output-canary");
  });

  it("supports idempotent shutdown and validates lifecycle limits", async () => {
    await server.close();
    await server.close();

    const baseOptions = serverOptions(token, coordinator);
    for (const options of [
      { ...baseOptions, maxBodyBytes: 0 },
      { ...baseOptions, maxOutputBytes: 0 },
      { ...baseOptions, requestTimeoutMs: 0 },
      { ...baseOptions, headerTimeoutMs: 0 },
      { ...baseOptions, maxConnections: 0 },
    ]) {
      expect(() => new ResponsesServer(options)).toThrow(RangeError);
    }

    const idle = new ResponsesServer(baseOptions);
    expect(() => idle.address).toThrow("not listening");
    await idle.close();
  });

  it("stops accepting and closes an incomplete local connection", async () => {
    const socket = connect(server.address.port, "127.0.0.1");
    await once(socket, "connect");
    const closing = server.close();
    await expect(closing).resolves.toBeUndefined();
    socket.destroy();
  });
});

class FakeTurnCoordinator implements ResponsesTurnCoordinator {
  public autoComplete = true;
  public cancelCount = 0;
  public deltas: {
    readonly channel: "commentary" | "outputText" | "reasoning";
    readonly delta: string;
  }[] = [];
  public readonly requests: BrowserTurnRequest[] = [];
  public startAcknowledgementError: Error | undefined;
  public startError: Error | undefined;
  public terminal: BrowserTurnTerminal = { finishReason: "stop", kind: "completed" };
  readonly #cancelled = createDeferred<undefined>();

  public get cancelled(): Promise<void> {
    return this.#cancelled.promise;
  }

  public startTurn(request: BrowserTurnRequest, sink?: BrowserTurnSink): BrowserTurnHandle {
    if (this.startError !== undefined) {
      throw this.startError;
    }
    this.requests.push(request);
    const terminal = createDeferred<BrowserTurnTerminal>();
    const handle: BrowserTurnHandle = Object.freeze({
      cancel: (): Promise<void> => {
        this.cancelCount += 1;
        this.#cancelled.resolve(undefined);
        terminal.resolve({ kind: "cancelled" });
        return Promise.resolve();
      },
      completion: terminal.promise,
      started:
        this.startAcknowledgementError === undefined
          ? Promise.resolve()
          : Promise.reject(this.startAcknowledgementError),
      turnId: "turn-test",
    });
    if (this.autoComplete) {
      queueMicrotask(() => {
        void this.#emit(sink, terminal);
      });
    }
    return handle;
  }

  async #emit(
    sink: BrowserTurnSink | undefined,
    terminal: Deferred<BrowserTurnTerminal>,
  ): Promise<void> {
    for (const delta of this.deltas) {
      await sink?.onDelta(delta);
    }
    terminal.resolve(this.terminal);
  }
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

function createDeferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: Value): void {
      resolvePromise?.(value);
    },
  };
}

function createServer(
  capabilityToken: CapabilityToken,
  turnCoordinator: ResponsesTurnCoordinator,
  overrides: Partial<Parameters<typeof serverOptions>[2]> = {},
): ResponsesServer {
  return new ResponsesServer(serverOptions(capabilityToken, turnCoordinator, overrides));
}

function serverOptions(
  capabilityToken: CapabilityToken,
  turnCoordinator: ResponsesTurnCoordinator,
  overrides: {
    readonly agentHandler?: ConstructorParameters<typeof ResponsesServer>[0]["agentHandler"];
    readonly maxOutputBytes?: number;
    readonly profile?: "agent-v2" | "text-v1";
  } = {},
): ConstructorParameters<typeof ResponsesServer>[0] {
  return {
    ...(overrides.agentHandler === undefined ? {} : { agentHandler: overrides.agentHandler }),
    coordinator: turnCoordinator,
    headerTimeoutMs: 1_000,
    maxBodyBytes: 4_096,
    maxConnections: 16,
    maxOutputBytes: overrides.maxOutputBytes ?? 1_024,
    requestTimeoutMs: 2_000,
    resolveModelRoute: (model) =>
      model === PROVIDER_MODEL
        ? {
            catalogRevision: "catalog-a",
            defaultReasoningEffort: "medium",
            modelId: "web-model",
            profile: overrides.profile ?? "text-v1",
            sessionGeneration: 1,
            sessionId: "session-a",
          }
        : undefined,
    token: capabilityToken,
  };
}

function post(
  serverInstance: ResponsesServer,
  capabilityToken: CapabilityToken,
  body: unknown,
): Promise<Response> {
  return fetch(`${serverInstance.address.baseUrl}/responses`, {
    body: JSON.stringify(body),
    headers: authorizedHeaders(capabilityToken),
    method: "POST",
  });
}

function authorizedHeaders(capabilityToken: CapabilityToken): Readonly<Record<string, string>> {
  return {
    authorization: `Bearer ${capabilityToken}`,
    "content-type": "application/json",
  };
}

function parseSse(
  body: string,
): { readonly data: Record<string, unknown>; readonly event: string }[] {
  return body
    .trim()
    .split("\n\n")
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines[0]?.slice("event: ".length);
      const data = lines[1]?.slice("data: ".length);
      if (event === undefined || data === undefined) {
        throw new TypeError("Invalid SSE frame");
      }
      return { data: JSON.parse(data) as Record<string, unknown>, event };
    });
}

function rawRequest(
  port: number,
  headers: Readonly<Record<string, string>>,
): Promise<{ readonly body: string; readonly status: number | undefined }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers,
        host: "127.0.0.1",
        method: "POST",
        path: "/v1/responses",
        port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolve({ body: Buffer.concat(chunks).toString("utf8"), status: response.statusCode });
        });
      },
    );
    request.once("error", reject);
    request.end("{}");
  });
}
