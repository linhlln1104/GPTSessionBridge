import { createHash } from "node:crypto";

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
  type AgentCertifiedTool,
} from "../src/browser/agent-session-coordinator.js";
import type {
  BrowserTurnHandle,
  BrowserTurnRequest,
  BrowserTurnSink,
  BrowserTurnTerminal,
} from "../src/browser/browser-session-coordinator.js";
import { ResponsesV2AgentSessionAdapter } from "../src/http/responses-v2-agent-session-adapter.js";
import {
  ResponsesServerV2,
  type ResponsesV2AgentSessionPort,
  type ResponsesV2CertifiedToolProfile,
  type ResponsesV2CommittedToolCall,
  type ResponsesV2ContinuationRequest,
  type ResponsesV2FunctionTool,
} from "../src/http/responses-server-v2.js";

const NOW = 2_000_000;

describe("ResponsesV2AgentSessionAdapter", () => {
  it("maps one exact serial tool loop and consumes its continuation once", async () => {
    const tools = responseTools();
    const profileVersion = "codex-0.150.0-alpha.8-fixture-1";
    const profile = certifiedProfile(profileVersion, tools);
    const server = new ResponsesServerV2({
      identitySource: {
        createMessageId: () => "msg_abcdefghijklmnop",
        createResponseId: () => "resp_abcdefghijklmnop",
        nowEpochSeconds: () => 1_800_000_000,
      },
      toolProfile: profile,
    });
    const admitted = server.admitInitialRequest(JSON.stringify(initialBody(tools)));
    if (!admitted.ok) {
      throw new Error("Synthetic initial request was rejected.");
    }

    const boundary = new FakeAgentBoundary();
    let randomValue = 1;
    const coordinator = new AgentSessionCoordinator(boundary, {
      createRandomBytes: (size) => {
        const bytes = new Uint8Array(size);
        bytes.fill(randomValue);
        randomValue += 1;
        return bytes;
      },
      now: () => NOW,
    });
    const adapter = new ResponsesV2AgentSessionAdapter({
      context: {
        browser: boundary.requireBinding(),
        requestBindingId: "request-binding-fixture",
        threadId: "thread-fixture",
        tools: agentTools(),
        turnId: "turn-fixture",
      },
      coordinator,
    });
    expectTypeOf(adapter).toExtend<ResponsesV2AgentSessionPort>();

    const first = adapter.startWorkflow(admitted.value);
    const firstBinding = readRoundBinding(boundary.requireTurn(0).request);
    await boundary.complete(
      0,
      assistantEnvelope({
        ...firstBinding,
        arguments: { cmd: "git status --short" },
        kind: "tool_call",
        tool: "exec_command",
      }),
    );
    const committed = await first;
    expect(Object.keys(committed).sort()).toEqual([
      "arguments",
      "argumentsJson",
      "callId",
      "callRef",
      "itemId",
      "kind",
      "tool",
    ]);
    if (committed.kind !== "tool_call") {
      throw new Error("Expected a committed function call.");
    }
    expect(boundary.requireTurn(0).request.input[0]?.text).toContain(
      '"content":["User ","request"]',
    );
    expect(server.createLifecycle(admitted.value, committed)).toMatchObject({ ok: true });

    const continuation = server.admitContinuationRequest(
      JSON.stringify(continuationBody(tools, committed, "synthetic tool output")),
      { committedCall: committed, initialRequest: admitted.value },
    );
    if (!continuation.ok) {
      throw new Error("Synthetic continuation was rejected.");
    }
    const final = adapter.continueWorkflow(continuation.value);

    const finalBinding = readRoundBinding(boundary.requireTurn(1).request);
    await boundary.complete(
      1,
      assistantEnvelope({ ...finalBinding, kind: "final", text: "Completed safely." }),
    );
    const finalOutcome = await final;
    expect(finalOutcome).toEqual({ kind: "final", text: "Completed safely." });
    expect(server.createLifecycle(continuation.value, finalOutcome)).toMatchObject({
      ok: true,
      value: { response: { output: [{ content: [{ text: "Completed safely." }] }] } },
    });
    await expect(adapter.continueWorkflow(continuation.value)).rejects.toMatchObject({
      code: "child_continuation_mismatch",
    });
    expect(boundary.turns).toHaveLength(2);
    expect(boundary.renewals).toBe(2);
  });

  it("makes a mismatched continuation terminal and permanently consumes the pending call", async () => {
    const tools = responseTools();
    const server = new ResponsesServerV2({
      toolProfile: certifiedProfile("fixture-v1", tools),
    });
    const admitted = server.admitInitialRequest(JSON.stringify(initialBody(tools)));
    if (!admitted.ok) {
      throw new Error("Synthetic initial request was rejected.");
    }

    const boundary = new FakeAgentBoundary();
    const coordinator = new AgentSessionCoordinator(boundary, { now: () => NOW });
    const adapter = new ResponsesV2AgentSessionAdapter({
      context: {
        browser: boundary.requireBinding(),
        requestBindingId: "request-binding-fixture",
        threadId: "thread-fixture",
        tools: agentTools(),
        turnId: "turn-fixture",
      },
      coordinator,
    });
    const initialOutcome = adapter.startWorkflow(admitted.value);
    const binding = readRoundBinding(boundary.requireTurn(0).request);
    await boundary.complete(
      0,
      assistantEnvelope({
        ...binding,
        arguments: { cmd: "git status --short" },
        kind: "tool_call",
        tool: "exec_command",
      }),
    );
    const committed = await initialOutcome;
    if (committed.kind !== "tool_call") {
      throw new Error("Expected a committed function call.");
    }
    expect(server.createLifecycle(admitted.value, committed)).toMatchObject({ ok: true });
    const continuation = server.admitContinuationRequest(
      JSON.stringify(continuationBody(tools, committed, "synthetic tool output")),
      { committedCall: committed, initialRequest: admitted.value },
    );
    if (!continuation.ok) {
      throw new Error("Synthetic continuation was rejected.");
    }
    const mismatched = {
      ...continuation.value,
      requestPrefixDigest: `sha256-${"A".repeat(43)}`,
    } as ResponsesV2ContinuationRequest;

    await expect(adapter.continueWorkflow(mismatched)).rejects.toMatchObject({
      code: "child_continuation_mismatch",
    });
    await expect(adapter.continueWorkflow(continuation.value)).rejects.toMatchObject({
      code: "child_continuation_mismatch",
    });
    expect(coordinator.state).toMatchObject({
      pendingCall: false,
      phase: "cancelled_terminal",
      workflowActive: false,
    });
    expect(boundary.turns).toHaveLength(1);
  });

  it("rejects a profile mismatch before renewing activity or starting the DOM turn", async () => {
    const tools = responseTools();
    const profileVersion = "fixture-v1";
    const server = new ResponsesServerV2({ toolProfile: certifiedProfile(profileVersion, tools) });
    const admitted = server.admitInitialRequest(JSON.stringify(initialBody(tools)));
    if (!admitted.ok) {
      throw new Error("Synthetic initial request was rejected.");
    }
    const boundary = new FakeAgentBoundary();
    const coordinator = new AgentSessionCoordinator(boundary, { now: () => NOW });
    const mismatchedTool = agentTools()[0];
    if (mismatchedTool === undefined) {
      throw new Error("Missing synthetic tool.");
    }
    const adapter = new ResponsesV2AgentSessionAdapter({
      context: {
        browser: boundary.requireBinding(),
        requestBindingId: "request-binding-fixture",
        threadId: "thread-fixture",
        tools: [{ ...mismatchedTool, description: "A different certified manifest." }],
        turnId: "turn-fixture",
      },
      coordinator,
    });

    await expect(adapter.startWorkflow(admitted.value)).rejects.toMatchObject({
      code: "protocol_manifest_mismatch",
    });
    expect(boundary.renewals).toBe(0);
    expect(boundary.turns).toHaveLength(0);
  });
});

interface FakeTurn {
  readonly completion: Deferred<BrowserTurnTerminal>;
  readonly request: BrowserTurnRequest;
  readonly sink: BrowserTurnSink;
}

class FakeAgentBoundary implements AgentBrowserTurnBoundary {
  public binding: AgentBrowserBinding | undefined = browserBinding();
  public renewals = 0;
  public readonly turns: FakeTurn[] = [];

  public noteAgentActivity(expected: AgentBrowserBinding): AgentBrowserBinding {
    if (!sameBinding(expected, this.binding)) {
      throw new Error("binding drift");
    }
    this.renewals += 1;
    this.binding = Object.freeze({
      ...expected,
      expiresAtMs: NOW + 900_000,
      lastActivityAtMs: NOW,
    });
    return this.binding;
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
    this.turns.push({ completion, request, sink });
    return Object.freeze({
      cancel: () => Promise.resolve(),
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

  public requireBinding(): AgentBrowserBinding {
    if (this.binding === undefined) {
      throw new Error("Missing synthetic binding.");
    }
    return this.binding;
  }

  public requireTurn(index: number): FakeTurn {
    const turn = this.turns[index];
    if (turn === undefined) {
      throw new Error(`Missing synthetic browser turn ${String(index)}.`);
    }
    return turn;
  }
}

function browserBinding(): AgentBrowserBinding {
  return Object.freeze({
    catalogRevision: "catalog-fixture",
    conversationOwnershipId: "ownership-fixture",
    documentGeneration: 1,
    documentId: "document-fixture",
    expiresAtMs: NOW + 60_000,
    issuedAtMs: NOW - 1_000,
    lastActivityAtMs: NOW - 500,
    leaseId: "lease-fixture",
    modelId: "model-web-fixture",
    providerRoute: "provider-fixture",
    sessionGeneration: 1,
    sessionId: "session-fixture",
    tabId: 7,
  });
}

function responseTools(): ResponsesV2FunctionTool[] {
  return [
    {
      description: "Run a bounded synthetic command through the official child.",
      name: "exec_command",
      parameters: {
        additionalProperties: false,
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
        type: "object",
      },
      strict: true,
      type: "function",
    },
  ];
}

function agentTools(): AgentCertifiedTool[] {
  const tool = responseTools()[0];
  if (tool === undefined) {
    throw new Error("Missing synthetic tool.");
  }
  return [
    {
      classifyResult: () => true,
      description: tool.description,
      name: tool.name,
      parameters: tool.parameters,
      validateArguments: (value) =>
        Object.keys(value).length === 1 && typeof value["cmd"] === "string",
    },
  ];
}

function certifiedProfile(
  profileVersion: string,
  tools: ResponsesV2FunctionTool[],
): ResponsesV2CertifiedToolProfile {
  return {
    manifestDigest: digest(
      canonicalizeToolWorkflowJson({
        parallelToolCalls: false,
        profileVersion,
        tools,
      } as unknown as JsonValue),
    ),
    parallelToolCalls: false,
    profileVersion,
    tools,
  };
}

function initialBody(tools: ResponsesV2FunctionTool[]): Record<string, unknown> {
  return {
    client_metadata: { client: "synthetic-contract" },
    include: [],
    input: [
      { content: "Developer context", role: "developer" },
      {
        content: [
          { text: "User ", type: "input_text" },
          { text: "request", type: "input_text" },
        ],
        role: "user",
      },
    ],
    instructions: "Synthetic developer instructions",
    model: "web-agent-synthetic",
    parallel_tool_calls: false,
    prompt_cache_key: "synthetic-cache-key",
    reasoning: { effort: "medium" },
    store: false,
    stream: true,
    tool_choice: "auto",
    tools,
  };
}

function continuationBody(
  tools: ResponsesV2FunctionTool[],
  call: ResponsesV2CommittedToolCall,
  output: string,
): Record<string, unknown> {
  const initial = initialBody(tools);
  const input = initial["input"] as unknown[];
  initial["input"] = [
    ...input,
    {
      arguments: call.argumentsJson,
      call_id: call.callId,
      id: call.itemId,
      name: call.tool,
      status: "completed",
      type: "function_call",
    },
    { call_id: call.callId, output, type: "function_call_output" },
  ];
  return initial;
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
  if (prompt === undefined) {
    throw new Error("Missing synthetic browser prompt.");
  }
  const publicLine = prompt
    .split("\n")
    .find((line) => line.startsWith("PUBLIC_BINDING "))
    ?.slice("PUBLIC_BINDING ".length);
  const encoded = publicLine ?? prompt.split("\n")[1];
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

function digest(value: string): string {
  return `sha256-${createHash("sha256").update(value, "utf8").digest("base64url")}`;
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
    resolve: (value) => {
      resolvePromise?.(value);
    },
  };
}
