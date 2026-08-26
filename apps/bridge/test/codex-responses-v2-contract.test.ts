import { createHash } from "node:crypto";

import { canonicalizeToolWorkflowJson, type JsonValue } from "@gpt-session-bridge/protocol";
import { describe, expect, it } from "vitest";

import {
  CODEX_RESPONSES_V2_CONTRACT_ERROR_CODES,
  projectCodexResponsesV2Continuation,
  projectCodexResponsesV2Initial,
} from "../src/http/codex-responses-v2-contract.js";
import {
  ResponsesServerV2,
  type ResponsesV2CommittedToolCall,
} from "../src/http/responses-server-v2.js";

const CALL_ID = "call_abcdefghijklmnop";
const CALL_REF = "wc_abcdefghijklmnop";
const ITEM_ID = "fc_abcdefghijklmnop";

describe("Codex Responses v2 contract projection", () => {
  it("projects a real-style initial request into the exact admitted subset", () => {
    const actual = actualInitialBody();
    const result = projectCodexResponsesV2Initial(actual);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const projected = JSON.parse(result.value.canonicalBody) as Record<string, unknown>;
    expect(Object.keys(projected).sort()).toEqual([
      "include",
      "input",
      "instructions",
      "model",
      "parallel_tool_calls",
      "reasoning",
      "store",
      "stream",
      "tool_choice",
      "tools",
    ]);
    expect(projected).toMatchObject({
      include: [],
      parallel_tool_calls: false,
      reasoning: { effort: "medium" },
      store: false,
      stream: true,
      tool_choice: "auto",
    });
    expect(projected).not.toHaveProperty("prompt_cache_key");
    expect(projected).not.toHaveProperty("stream_options");
    expect(projected).not.toHaveProperty("text");
    expect(projected["input"]).toEqual([
      {
        content: [{ text: "Developer context", type: "input_text" }],
        role: "developer",
        type: "message",
      },
      {
        content: [{ text: "User request", type: "input_text" }],
        role: "user",
        type: "message",
      },
    ]);
    expect(result.value.profile.tools.map((tool) => tool.name)).toEqual([
      "exec_command",
      "apply_patch",
    ]);
    expect(result.value.profile.tools[0]?.strict).toBe(false);
    expect(result.value.profile.parallelToolCalls).toBe(false);
    expect(result.value.profile.manifestDigest).toBe(
      digest(
        canonicalizeToolWorkflowJson({
          parallelToolCalls: false,
          profileVersion: result.value.profile.profileVersion,
          tools: result.value.profile.tools,
        } as unknown as JsonValue),
      ),
    );
    expect(Object.isFrozen(result.value.profile.tools[0]?.parameters)).toBe(true);

    const boundary = new ResponsesServerV2({ toolProfile: result.value.profile });
    expect(boundary.admitInitialRequest(result.value.canonicalBody)).toMatchObject({ ok: true });
  });

  it("keeps a stable fingerprint for the same effective function profile", () => {
    const first = projectCodexResponsesV2Initial(actualInitialBody());
    const reordered = actualInitialBody();
    reordered.tools = [
      { type: "web_search", search_context_size: "medium" },
      ...reordered.tools.filter((tool) => tool.type === "function"),
      { name: "ignored", type: "namespace" },
    ];
    reordered.unused_runtime_field = { changed: true };
    const second = projectCodexResponsesV2Initial(reordered);

    expect(first.ok && second.ok && second.value.fingerprint).toBe(
      first.ok ? first.value.fingerprint : undefined,
    );
    expect(first.ok && second.ok && second.value.profile.profileVersion).toBe(
      first.ok ? first.value.profile.profileVersion : undefined,
    );
  });

  it("filters a node-heavy opaque namespace before canonical projection", () => {
    const actual = actualInitialBody();
    (actual.tools as unknown[]).unshift({
      name: "opaque_namespace",
      tools: Array.from({ length: 5_000 }, (_, index) => ({ index, type: "opaque" })),
      type: "namespace",
    });

    expect(projectCodexResponsesV2Initial(actual)).toMatchObject({ ok: true });
  });

  it("rejects accessor-bearing request records without invoking them", () => {
    let getterCalls = 0;
    const actual = actualInitialBody() as unknown as Record<string, unknown>;
    Object.defineProperty(actual, "input", {
      enumerable: true,
      get(): unknown {
        getterCalls += 1;
        return [];
      },
    });

    expect(projectCodexResponsesV2Initial(actual)).toMatchObject({ ok: false });
    expect(getterCalls).toBe(0);
  });

  it("uses the selected route effort when the current Codex body only requests a summary", () => {
    const actual = actualInitialBody();
    actual.reasoning = { summary: "auto" };

    const result = projectCodexResponsesV2Initial(actual, {
      defaultReasoningEffort: "high",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(JSON.parse(result.value.canonicalBody)).toMatchObject({
      reasoning: { effort: "high" },
    });
    expect(projectCodexResponsesV2Initial(actual)).toMatchObject({
      error: { code: "codex_request_invalid" },
      ok: false,
    });
  });

  it("normalizes real continuation item differences and remains admissible", () => {
    const initialProjection = projectCodexResponsesV2Initial(actualInitialBody());
    if (!initialProjection.ok) {
      throw new Error("Initial projection failed.");
    }
    const boundary = new ResponsesServerV2({ toolProfile: initialProjection.value.profile });
    const initial = boundary.admitInitialRequest(initialProjection.value.canonicalBody);
    if (!initial.ok) {
      throw new Error("Projected initial request was rejected.");
    }
    const committed = committedCall();
    expect(boundary.createLifecycle(initial.value, committed)).toMatchObject({ ok: true });

    const actual = actualInitialBody();
    actual.input = [
      ...actual.input,
      {
        arguments: committed.argumentsJson,
        call_id: committed.callId,
        id: committed.itemId,
        name: committed.tool,
        type: "function_call",
      },
      {
        call_id: committed.callId,
        id: "fco_realcontractoutput",
        output: "bounded child output",
        type: "function_call_output",
      },
    ];
    const continuationProjection = projectCodexResponsesV2Continuation(
      actual,
      initialProjection.value,
    );

    expect(continuationProjection.ok).toBe(true);
    if (!continuationProjection.ok) {
      return;
    }
    const projected = JSON.parse(continuationProjection.value.canonicalBody) as {
      input: Record<string, unknown>[];
    };
    expect(projected.input.at(-2)).toEqual({
      arguments: committed.argumentsJson,
      call_id: committed.callId,
      id: committed.itemId,
      name: committed.tool,
      status: "completed",
      type: "function_call",
    });
    expect(projected.input.at(-1)).toEqual({
      call_id: committed.callId,
      output: "bounded child output",
      type: "function_call_output",
    });
    expect(
      boundary.admitContinuationRequest(continuationProjection.value.canonicalBody, {
        committedCall: committed,
        initialRequest: initial.value,
      }),
    ).toMatchObject({ ok: true });
  });

  it("accepts cumulative Codex tool history and binds every completed prior round", () => {
    const initial = projectCodexResponsesV2Initial(actualInitialBody());
    if (!initial.ok) {
      throw new Error("Initial projection failed.");
    }
    const first = projectCodexResponsesV2Continuation(actualContinuationBody(), initial.value);
    if (!first.ok) {
      throw new Error("First continuation projection failed.");
    }

    const cumulative = actualContinuationBody();
    cumulative.input.push(
      {
        arguments: '{"cmd":"pwd"}',
        call_id: "call_qrstuvwxyzabcdef",
        id: "fc_qrstuvwxyzabcdef",
        name: "exec_command",
        type: "function_call",
      },
      {
        call_id: "call_qrstuvwxyzabcdef",
        id: "fco_secondcontractoutput",
        output: "second bounded child output",
        type: "function_call_output",
      },
    );

    const second = projectCodexResponsesV2Continuation(cumulative, first.value);
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    const projected = JSON.parse(second.value.canonicalBody) as {
      input: Record<string, unknown>[];
    };
    expect(projected.input).toHaveLength(actualInitialBody().input.length + 2);
    expect(projected.input.at(-2)).toMatchObject({
      call_id: "call_qrstuvwxyzabcdef",
      id: "fc_qrstuvwxyzabcdef",
      status: "completed",
    });
    expect(second.value.historyFingerprint).not.toBe(first.value.historyFingerprint);

    const tampered = structuredClone(cumulative);
    const priorOutput = tampered.input.at(-3);
    if (priorOutput === undefined) {
      throw new Error("Missing prior output fixture.");
    }
    priorOutput.output = "tampered prior output";
    expect(projectCodexResponsesV2Continuation(tampered, first.value)).toMatchObject({
      error: { code: "codex_contract_drift" },
      ok: false,
    });
  });

  it("detects effective function-profile drift before continuation admission", () => {
    const initial = projectCodexResponsesV2Initial(actualInitialBody());
    if (!initial.ok) {
      throw new Error("Initial projection failed.");
    }
    const continuation = actualContinuationBody();
    const exec = continuation.tools.find(
      (tool) => tool.type === "function" && tool.name === "exec_command",
    );
    if (exec === undefined) {
      throw new Error("Missing exec_command fixture.");
    }
    exec.description = "Changed contract description";

    expect(projectCodexResponsesV2Continuation(continuation, initial.value)).toEqual({
      error: {
        code: "codex_contract_drift",
        message: "The Codex Responses continuation contract changed.",
      },
      ok: false,
    });
  });

  it("validates closed function schemas and echoed function arguments", () => {
    const missingExec = actualInitialBody();
    missingExec.tools = missingExec.tools.filter(
      (tool) => tool.type !== "function" || tool.name !== "exec_command",
    );
    expect(projectCodexResponsesV2Initial(missingExec)).toMatchObject({
      ok: false,
      error: { code: "codex_tool_profile_unsupported" },
    });

    const openSchema = actualInitialBody();
    const exec = openSchema.tools.find(
      (tool) => tool.type === "function" && tool.name === "exec_command",
    );
    if (exec === undefined) {
      throw new Error("Missing exec_command fixture.");
    }
    exec.parameters = {
      additionalProperties: true,
      properties: { cmd: { type: "string" } },
      required: ["cmd"],
      type: "object",
    };
    expect(projectCodexResponsesV2Initial(openSchema)).toMatchObject({
      ok: false,
      error: { code: "codex_tool_profile_unsupported" },
    });

    const initial = projectCodexResponsesV2Initial(actualInitialBody());
    if (!initial.ok) {
      throw new Error("Initial projection failed.");
    }
    const badArguments = actualContinuationBody();
    const call = badArguments.input.at(-2);
    if (call === undefined) {
      throw new Error("Missing function call fixture.");
    }
    call.arguments = '{"cmd":42}';
    const rejected = projectCodexResponsesV2Continuation(badArguments, initial.value);
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "codex_tool_arguments_invalid" },
    });
    expect(CODEX_RESPONSES_V2_CONTRACT_ERROR_CODES).toContain(
      rejected.ok ? undefined : rejected.error.code,
    );
  });
});

interface ActualTool {
  description?: string;
  name?: string;
  parameters?: Record<string, unknown>;
  search_context_size?: string;
  strict?: boolean;
  type: string;
}

interface ActualInputItem {
  arguments?: string;
  call_id?: string;
  content?: readonly Record<string, unknown>[];
  id?: string;
  name?: string;
  output?: string;
  role?: string;
  type: string;
}

interface ActualBody {
  include: readonly string[];
  input: ActualInputItem[];
  instructions: string;
  model: string;
  parallel_tool_calls: boolean;
  prompt_cache_key: string;
  reasoning: Record<string, unknown>;
  store: boolean;
  stream: boolean;
  stream_options: Record<string, unknown>;
  text: Record<string, unknown>;
  tool_choice: string;
  tools: ActualTool[];
  unused_runtime_field?: Record<string, unknown>;
}

function actualInitialBody(): ActualBody {
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
    model: `gptsessionbridge/web/route-v1-${"A".repeat(43)}`,
    parallel_tool_calls: true,
    prompt_cache_key: "real-contract-cache-key",
    reasoning: { effort: "medium", summary: "auto" },
    store: false,
    stream: true,
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
          properties: {
            cmd: { type: "string" },
            yield_time_ms: { minimum: 1, type: "integer" },
          },
          required: ["cmd"],
          type: "object",
        },
        strict: false,
        type: "function",
      },
      { search_context_size: "medium", type: "web_search" },
      {
        description: "Apply a canonical patch.",
        name: "apply_patch",
        parameters: {
          additionalProperties: false,
          properties: { patch: { type: "string" } },
          type: "object",
        },
        strict: true,
        type: "function",
      },
    ],
  };
}

function actualContinuationBody(): ActualBody {
  const body = actualInitialBody();
  const committed = committedCall();
  body.input.push(
    {
      arguments: committed.argumentsJson,
      call_id: committed.callId,
      id: committed.itemId,
      name: committed.tool,
      type: "function_call",
    },
    {
      call_id: committed.callId,
      id: "fco_realcontractoutput",
      output: "bounded child output",
      type: "function_call_output",
    },
  );
  return body;
}

function committedCall(): ResponsesV2CommittedToolCall {
  return {
    arguments: { cmd: "git status --short" },
    argumentsJson: '{"cmd":"git status --short"}',
    callId: CALL_ID,
    callRef: CALL_REF,
    itemId: ITEM_ID,
    kind: "tool_call",
    tool: "exec_command",
  };
}

function digest(value: string): string {
  return `sha256-${createHash("sha256").update(value, "utf8").digest("base64url")}`;
}
