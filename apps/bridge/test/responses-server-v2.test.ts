import { createHash } from "node:crypto";

import { canonicalizeToolWorkflowJson, type JsonValue } from "@gpt-session-bridge/protocol";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  MAX_RESPONSES_V2_REQUEST_BYTES,
  RESPONSES_V2_BOUNDARY_ERROR_CODES,
  ResponsesServerV2,
  type ResponsesV2AgentSessionPort,
  type ResponsesV2CertifiedToolProfile,
  type ResponsesV2CommittedToolCall,
  type ResponsesV2ContinuationRequest,
  type ResponsesV2FunctionTool,
  type ResponsesV2InitialRequest,
  type ResponsesV2ValidatedOutcome,
} from "../src/http/responses-server-v2.js";

const itemId = "fc_abcdefghijklmnop";
const callId = "call_abcdefghijklmnop";
const callRef = "wc_abcdefghijklmnop";

describe("ResponsesServerV2 inactive boundary", () => {
  it("strictly admits the certified initial Codex request subset", () => {
    const server = createServer();
    const request = initialRequest();

    const result = server.admitInitialRequest(JSON.stringify(request));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toMatchObject({
      kind: "initial",
      clientMetadata: { client: "synthetic-codex-contract" },
      instructions: "Synthetic developer instructions",
      manifestDigest: certifiedProfile().manifestDigest,
      model: "web-agent-synthetic",
      profileVersion: "codex-0.150.0-alpha.8-fixture-1",
      promptCacheKey: "synthetic-cache-key",
      reasoningEffort: "medium",
      stream: true,
    });
    expect(result.value.messages).toEqual([
      { content: [{ text: "Developer context", type: "input_text" }], role: "developer" },
      { content: [{ text: "User request", type: "input_text" }], role: "user" },
    ]);
    expect(result.value.canonicalRequestPrefix).toBe(
      canonicalizeToolWorkflowJson(request as unknown as JsonValue),
    );
    expect(result.value.requestPrefixDigest).toBe(digest(result.value.canonicalRequestPrefix));
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.requestPrefix)).toBe(true);
    expect(Object.isFrozen(result.value.tools[0]?.parameters)).toBe(true);
  });

  it("accepts an exact continuation tuple bound to the canonical initial prefix", () => {
    const server = createServer();
    const initial = admittedInitial(server);
    const committedCall = validCommittedCall();
    const continuation = continuationRequest(initial, committedCall, "bounded child output");
    expect(server.createLifecycle(initial, committedCall)).toMatchObject({ ok: true });

    const result = server.admitContinuationRequest(JSON.stringify(continuation), {
      committedCall,
      initialRequest: initial,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "continuation",
        call: {
          arguments: '{"cmd":"git status --short"}',
          call_id: callId,
          id: itemId,
          name: "exec_command",
          status: "completed",
          type: "function_call",
        },
        functionCallOutput: {
          call_id: callId,
          output: "bounded child output",
          type: "function_call_output",
        },
        requestPrefixDigest: initial.requestPrefixDigest,
      },
    });
    expect(result.ok && Object.isFrozen(result.value.inputSuffix)).toBe(true);
  });

  it.each([
    ["unknown top-level field", { ...initialRequest(), secret_canary: true }],
    ["persistence", { ...initialRequest(), store: true }],
    ["non-empty include", { ...initialRequest(), include: ["reasoning.encrypted_content"] }],
    ["unsupported tool choice", { ...initialRequest(), tool_choice: "required" }],
    ["missing reasoning", withoutKey(initialRequest(), "reasoning")],
    ["assistant message", withLastRole(initialRequest(), "assistant")],
    ["media input", withMediaInput(initialRequest())],
    ["built-in tool", { ...initialRequest(), tools: [{ type: "web_search" }] }],
  ])("fails closed for %s", (_name, request) => {
    const server = createServer();
    const result = server.admitInitialRequest(JSON.stringify(request));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(RESPONSES_V2_BOUNDARY_ERROR_CODES).toContain(result.error.code);
      expect(JSON.stringify(result.error)).not.toContain("canary");
      expect(result.error.message).toBe("The Web Agent request is unavailable.");
    }
  });

  it.each([
    [
      "duplicate decoded key",
      JSON.stringify(initialRequest()).replace(
        '"model":"web-agent-synthetic"',
        '"model":"private-canary","\\u006dodel":"web-agent-synthetic"',
      ),
    ],
    [
      "prototype-sensitive key",
      JSON.stringify(initialRequest()).replace(
        '"client_metadata":{',
        '"client_metadata":{"__proto__":{"private-canary":true},',
      ),
    ],
    [
      "unsafe integer",
      JSON.stringify(initialRequest()).replace(
        '"client":"synthetic-codex-contract"',
        '"client":"synthetic-codex-contract","sequence":9007199254740993',
      ),
    ],
    [
      "non-canonical number",
      JSON.stringify(initialRequest()).replace(
        '"client":"synthetic-codex-contract"',
        '"client":"synthetic-codex-contract","sequence":1.0',
      ),
    ],
    ["trailing JSON", `${JSON.stringify(initialRequest())}{"private-canary":true}`],
  ])("rejects adversarial raw JSON: %s", (_name, body) => {
    const result = createServer().admitInitialRequest(body);

    expect(result).toEqual({
      error: { code: "v2_request_invalid", message: "The Web Agent request is unavailable." },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("private-canary");
  });

  it("binds the exact manifest ordering, descriptions, and closed schemas", () => {
    const server = createServer();
    const request = initialRequest();
    const changedDescription = structuredClone(request);
    changedDescription.tools[0] = {
      ...firstTool(changedDescription.tools),
      description: "Changed",
    };
    const reordered = structuredClone(request);
    reordered.tools = [...reordered.tools].reverse();

    for (const changed of [changedDescription, reordered]) {
      expect(server.admitInitialRequest(JSON.stringify(changed))).toEqual({
        error: {
          code: "tool_manifest_changed",
          message: "The Web Agent request is unavailable.",
        },
        ok: false,
      });
    }
  });

  it.each([
    ["model", (request: Record<string, unknown>) => (request["model"] = "changed")],
    [
      "prompt cache key",
      (request: Record<string, unknown>) => (request["prompt_cache_key"] = "changed"),
    ],
    [
      "metadata",
      (request: Record<string, unknown>) => (request["client_metadata"] = { client: "changed" }),
    ],
    [
      "input prefix",
      (request: Record<string, unknown>) => {
        const input = request["input"] as Record<string, unknown>[];
        input[0] = { content: "changed", role: "developer" };
      },
    ],
    [
      "function call id",
      (request: Record<string, unknown>) => {
        const input = request["input"] as Record<string, unknown>[];
        input[input.length - 2] = { ...(input.at(-2) ?? {}), call_id: "call_changed___________" };
      },
    ],
    [
      "function arguments",
      (request: Record<string, unknown>) => {
        const input = request["input"] as Record<string, unknown>[];
        input[input.length - 2] = { ...(input.at(-2) ?? {}), arguments: '{"cmd":"changed"}' };
      },
    ],
    [
      "function output call id",
      (request: Record<string, unknown>) => {
        const input = request["input"] as Record<string, unknown>[];
        input[input.length - 1] = { ...(input.at(-1) ?? {}), call_id: "call_changed___________" };
      },
    ],
    [
      "extra suffix item",
      (request: Record<string, unknown>) => {
        (request["input"] as unknown[]).push({ content: "private-canary", role: "user" });
      },
    ],
  ])("rejects continuation mutation: %s", (_name, mutate) => {
    const server = createServer();
    const initial = admittedInitial(server);
    const committedCall = validCommittedCall();
    const request = continuationRequest(initial, committedCall, "bounded child output");
    mutate(request);
    expect(server.createLifecycle(initial, committedCall)).toMatchObject({ ok: true });

    const result = server.admitContinuationRequest(JSON.stringify(request), {
      committedCall,
      initialRequest: initial,
    });

    expect(result).toEqual({
      error: {
        code: "child_continuation_mismatch",
        message: "The Web Agent continuation is unavailable.",
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("private-canary");
    expect(
      server.admitContinuationRequest(
        JSON.stringify(continuationRequest(initial, committedCall, "bounded child output")),
        { committedCall, initialRequest: initial },
      ),
    ).toMatchObject({ ok: false, error: { code: "child_continuation_mismatch" } });
  });

  it("rejects forged binding records and non-canonical committed calls", () => {
    const server = createServer();
    const initial = admittedInitial(server);
    const forgedInitial = {
      ...initial,
      canonicalRequestPrefix: initial.canonicalRequestPrefix.replace(
        "web-agent-synthetic",
        "private-canary",
      ),
    };
    const nonCanonicalCall = { ...validCommittedCall(), argumentsJson: '{"cmd": "changed"}' };
    expect(server.createLifecycle(initial, validCommittedCall())).toMatchObject({ ok: true });

    expect(
      server.admitContinuationRequest(
        JSON.stringify(continuationRequest(initial, validCommittedCall(), "output")),
        { committedCall: validCommittedCall(), initialRequest: forgedInitial },
      ),
    ).toMatchObject({ ok: false, error: { code: "child_continuation_mismatch" } });
    const secondServer = createServer();
    const secondInitial = admittedInitial(secondServer);
    expect(secondServer.createLifecycle(secondInitial, validCommittedCall())).toMatchObject({
      ok: true,
    });
    expect(
      secondServer.admitContinuationRequest(
        JSON.stringify(continuationRequest(secondInitial, validCommittedCall(), "output")),
        { committedCall: nonCanonicalCall, initialRequest: secondInitial },
      ),
    ).toMatchObject({ ok: false, error: { code: "child_continuation_mismatch" } });
  });

  it("revalidates every derived initial field against the canonical prefix", () => {
    const server = createServer();
    const initial = admittedInitial(server);
    const changedToolPrefix = structuredClone(initial.requestPrefix);
    const changedPrefixTools = changedToolPrefix["tools"];
    if (!Array.isArray(changedPrefixTools) || !isTestRecord(changedPrefixTools[0])) {
      throw new Error("Synthetic request prefix is invalid.");
    }
    changedPrefixTools[0]["description"] = "private-canary";
    const changedCanonicalPrefix = canonicalizeToolWorkflowJson(changedToolPrefix);
    const forgeries: ResponsesV2InitialRequest[] = [
      { ...initial, model: "private-canary" },
      { ...initial, reasoningEffort: "private-canary" },
      { ...initial, stream: false },
      { ...initial, parallelToolCalls: true },
      {
        ...initial,
        messages: [{ content: [{ text: "private-canary", type: "input_text" }], role: "user" }],
      },
      { ...initial, inputPrefix: [{ content: "private-canary", role: "user" }] },
      { ...initial, instructions: "private-canary" },
      { ...initial, promptCacheKey: "private-canary" },
      { ...initial, clientMetadata: { client: "private-canary" } },
      {
        ...initial,
        canonicalRequestPrefix: changedCanonicalPrefix,
        requestPrefix: changedToolPrefix,
        requestPrefixDigest: digest(changedCanonicalPrefix),
      },
    ];

    for (const forged of forgeries) {
      const result = server.createLifecycle(forged, { kind: "final", text: "safe" });
      expect(result).toMatchObject({ ok: false, error: { code: "validated_outcome_invalid" } });
      expect(JSON.stringify(result)).not.toContain("private-canary");
    }
  });

  it("pins the certified parallel-call value independently of request claims", () => {
    const request = initialRequest();
    request.parallel_tool_calls = true;

    expect(createServer().admitInitialRequest(JSON.stringify(request))).toMatchObject({
      ok: false,
      error: { code: "v2_request_invalid" },
    });
  });

  it("maps a validated final only after buffering into standard Responses lifecycle data", () => {
    const server = createServer();
    const initial = admittedInitial(server);

    const result = server.createLifecycle(initial, { kind: "final", text: "Completed safely." });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.response).toMatchObject({
      completed_at: 1_800_000_000,
      created_at: 1_800_000_000,
      id: "resp_abcdefghijklmnop",
      model: "web-agent-synthetic",
      object: "response",
      output: [
        {
          content: [{ annotations: [], text: "Completed safely.", type: "output_text" }],
          id: "msg_abcdefghijklmnop",
          role: "assistant",
          status: "completed",
          type: "message",
        },
      ],
      status: "completed",
      store: false,
      tool_choice: "auto",
    });
    expect(result.value.events.map((event) => event.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(result.value.events.map((event) => event.sequence_number)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(
      result.value.events
        .filter((event) => event.type.includes("output") || event.type.includes("content"))
        .every((event) => event["response_id"] === "resp_abcdefghijklmnop"),
    ).toBe(true);
    expect(Object.isFrozen(result.value.events)).toBe(true);
  });

  it("maps an already-committed call without executing or leaking its public call reference", () => {
    const server = createServer();
    const initial = admittedInitial(server);
    const outcome = validCommittedCall();

    const result = server.createLifecycle(initial, outcome);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.response.output).toEqual([
      {
        arguments: '{"cmd":"git status --short"}',
        call_id: callId,
        id: itemId,
        name: "exec_command",
        status: "completed",
        type: "function_call",
      },
    ]);
    expect(result.value.events.map((event) => event.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(
      result.value.events
        .filter((event) => event.type.includes("output") || event.type.includes("function_call"))
        .every((event) => event["response_id"] === "resp_abcdefghijklmnop"),
    ).toBe(true);
    expect(JSON.stringify(result.value)).not.toContain(callRef);
    expect("executeTool" in server).toBe(false);
    expect("approveTool" in server).toBe(false);
    expect(server.createLifecycle(initial, validCommittedCall())).toMatchObject({
      error: { code: "validated_outcome_invalid" },
      ok: false,
    });
  });

  it.each([
    { ...validCommittedCall(), tool: "unknown_tool" },
    { ...validCommittedCall(), argumentsJson: '{"cmd": "git status --short"}' },
    { ...validCommittedCall(), arguments: { cmd: 42 }, argumentsJson: '{"cmd":42}' },
    { ...validCommittedCall(), callId: "model-chosen-id" },
  ])("rejects an invalid supposedly validated outcome", (outcome) => {
    const result = createServer().createLifecycle(admittedInitial(createServer()), outcome);

    expect(result).toMatchObject({ ok: false, error: { code: "validated_outcome_invalid" } });
    if (!result.ok) {
      expect(result.error.message).not.toContain(outcome.tool);
    }
  });

  it("rejects extra outcome fields for both final and committed-call variants", () => {
    const server = createServer();
    const initial = admittedInitial(server);
    const finalWithExtra = { kind: "final", text: "safe", private_canary: true };
    const callWithExtra = { ...validCommittedCall(), private_canary: true };

    for (const outcome of [finalWithExtra, callWithExtra]) {
      const result = server.createLifecycle(
        initial,
        outcome as unknown as ResponsesV2ValidatedOutcome,
      );
      expect(result).toMatchObject({ ok: false, error: { code: "validated_outcome_invalid" } });
      expect(JSON.stringify(result)).not.toContain("private_canary");
    }
  });

  it("rejects oversized input before admission and an invalid identity source before events", () => {
    const limited = createServer({ maxRequestBytes: 128 });
    expect(limited.admitInitialRequest(JSON.stringify(initialRequest()))).toMatchObject({
      ok: false,
      error: { code: "v2_request_invalid" },
    });

    const badIdentityServer = createServer({
      identitySource: {
        createMessageId: () => "private-message-canary",
        createResponseId: () => "private-response-canary",
        nowEpochSeconds: () => -1,
      },
    });
    expect(
      badIdentityServer.createLifecycle(admittedInitial(badIdentityServer), {
        kind: "final",
        text: "safe",
      }),
    ).toEqual({
      error: {
        code: "validated_outcome_invalid",
        message: "The Web Agent request is unavailable.",
      },
      ok: false,
    });
  });

  it("requires a contract-versioned, exact, closed-schema profile", () => {
    const profile = certifiedProfile();
    const baseTool = firstTool(profile.tools);
    expect(() => createServer({ maxRequestBytes: 0 })).toThrow(RangeError);
    expect(() => createServer({ maxRequestBytes: MAX_RESPONSES_V2_REQUEST_BYTES + 1 })).toThrow(
      RangeError,
    );
    expect(
      () =>
        new ResponsesServerV2({
          toolProfile: {
            ...profile,
            parallelToolCalls: true,
          } as unknown as ResponsesV2CertifiedToolProfile,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new ResponsesServerV2({
          toolProfile: { ...profile, manifestDigest: `sha256-${"A".repeat(43)}` },
        }),
    ).toThrow(RangeError);
    expect(() =>
      profileServerWithTools([
        {
          ...baseTool,
          parameters: { ...baseTool.parameters, additionalProperties: true },
        },
      ]),
    ).toThrow(RangeError);
    expect(() => profileServerWithTools([{ ...baseTool, description: "" }])).toThrow(RangeError);
    expect(() =>
      profileServerWithTools([
        {
          ...baseTool,
          parameters: {
            additionalProperties: false,
            properties: { value: { type: "string" } },
            required: [],
            type: "object",
          },
        },
      ]),
    ).toThrow(RangeError);
    expect(() =>
      profileServerWithTools([
        {
          ...baseTool,
          parameters: {
            $defs: { hidden: { $ref: "https://private-canary.invalid/schema" } },
            additionalProperties: false,
            properties: { value: { type: "string" } },
            required: ["value"],
            type: "object",
          },
        },
      ]),
    ).toThrow(RangeError);
    expect(() =>
      profileServerWithTools([
        {
          ...baseTool,
          parameters: {
            additionalProperties: false,
            properties: { value: { $ref: "https://private-canary.invalid/schema" } },
            required: ["value"],
            type: "object",
          },
        },
      ]),
    ).toThrow(RangeError);
    for (const parameters of [
      {
        additionalProperties: false,
        properties: { value: { maxLength: "invalid", type: "string" } },
        required: ["value"],
        type: "object",
      },
      {
        additionalProperties: false,
        properties: { value: { enum: "invalid", type: "string" } },
        required: ["value"],
        type: "object",
      },
      {
        additionalProperties: false,
        properties: { value: { type: "array", uniqueItems: "invalid" } },
        required: ["value"],
        type: "object",
      },
    ]) {
      expect(() => profileServerWithTools([{ ...baseTool, parameters }])).toThrow(RangeError);
    }
    expect(MAX_RESPONSES_V2_REQUEST_BYTES).toBeGreaterThan(0);
  });

  it("exports coordinator-facing structural types without an execution callback", () => {
    expectTypeOf<ResponsesV2AgentSessionPort["startWorkflow"]>().returns.toEqualTypeOf<
      Promise<ResponsesV2ValidatedOutcome>
    >();
    expectTypeOf<ResponsesV2AgentSessionPort["continueWorkflow"]>()
      .parameter(0)
      .toEqualTypeOf<ResponsesV2ContinuationRequest>();
  });
});

function createServer(
  overrides: Partial<ConstructorParameters<typeof ResponsesServerV2>[0]> = {},
): ResponsesServerV2 {
  return new ResponsesServerV2({
    identitySource: {
      createMessageId: () => "msg_abcdefghijklmnop",
      createResponseId: () => "resp_abcdefghijklmnop",
      nowEpochSeconds: () => 1_800_000_000,
    },
    maxRequestBytes: MAX_RESPONSES_V2_REQUEST_BYTES,
    toolProfile: certifiedProfile(),
    ...overrides,
  });
}

function certifiedProfile(): ResponsesV2CertifiedToolProfile {
  const tools = toolManifest();
  const profileVersion = "codex-0.150.0-alpha.8-fixture-1";
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

function toolManifest(): ResponsesV2FunctionTool[] {
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
    {
      description: "Update the visible plan through the official child.",
      name: "update_plan",
      parameters: {
        additionalProperties: false,
        properties: {
          explanation: { type: "string" },
          plan: {
            items: {
              additionalProperties: false,
              properties: { status: { type: "string" }, step: { type: "string" } },
              required: ["step", "status"],
              type: "object",
            },
            type: "array",
          },
        },
        required: ["explanation", "plan"],
        type: "object",
      },
      strict: true,
      type: "function",
    },
  ];
}

function initialRequest(): {
  client_metadata: { client: string };
  include: never[];
  input: Record<string, unknown>[];
  instructions: string;
  model: string;
  parallel_tool_calls: boolean;
  prompt_cache_key: string;
  reasoning: { effort: string };
  store: boolean;
  stream: boolean;
  tool_choice: string;
  tools: ResponsesV2FunctionTool[];
} {
  return {
    client_metadata: { client: "synthetic-codex-contract" },
    include: [],
    input: [
      { content: "Developer context", role: "developer" },
      { content: [{ text: "User request", type: "input_text" }], role: "user", type: "message" },
    ],
    instructions: "Synthetic developer instructions",
    model: "web-agent-synthetic",
    parallel_tool_calls: false,
    prompt_cache_key: "synthetic-cache-key",
    reasoning: { effort: "medium" },
    store: false,
    stream: true,
    tool_choice: "auto",
    tools: toolManifest(),
  };
}

function validCommittedCall(): ResponsesV2CommittedToolCall {
  return {
    arguments: { cmd: "git status --short" },
    argumentsJson: '{"cmd":"git status --short"}',
    callId,
    callRef,
    itemId,
    kind: "tool_call",
    tool: "exec_command",
  };
}

function admittedInitial(server: ResponsesServerV2): ResponsesV2InitialRequest {
  const result = server.admitInitialRequest(JSON.stringify(initialRequest()));
  if (!result.ok) {
    throw new Error("Synthetic initial fixture was rejected.");
  }
  return result.value;
}

function continuationRequest(
  initial: ResponsesV2InitialRequest,
  committedCall: ResponsesV2CommittedToolCall,
  output: string,
): Record<string, unknown> {
  const request = structuredClone(initial.requestPrefix) as Record<string, unknown>;
  const input = request["input"] as unknown[];
  input.push(
    {
      arguments: committedCall.argumentsJson,
      call_id: committedCall.callId,
      id: committedCall.itemId,
      name: committedCall.tool,
      status: "completed",
      type: "function_call",
    },
    { call_id: committedCall.callId, output, type: "function_call_output" },
  );
  return request;
}

function digest(canonical: string): string {
  return `sha256-${createHash("sha256").update(canonical, "utf8").digest("base64url")}`;
}

function firstTool(tools: readonly ResponsesV2FunctionTool[]): ResponsesV2FunctionTool {
  const tool = tools[0];
  if (tool === undefined) {
    throw new Error("Synthetic tool fixture is empty.");
  }
  return tool;
}

function isTestRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withoutKey<Value extends Record<string, unknown>>(value: Value, key: string): Value {
  return Object.fromEntries(
    Object.entries(structuredClone(value)).filter(([entryKey]) => entryKey !== key),
  ) as Value;
}

function withLastRole(
  value: ReturnType<typeof initialRequest>,
  role: string,
): ReturnType<typeof initialRequest> {
  const result = structuredClone(value);
  result.input[result.input.length - 1] = { content: "private-canary", role };
  return result;
}

function withMediaInput(
  value: ReturnType<typeof initialRequest>,
): ReturnType<typeof initialRequest> {
  const result = structuredClone(value);
  result.input[result.input.length - 1] = {
    content: [{ image_url: "private-canary", type: "input_image" }],
    role: "user",
  };
  return result;
}

function profileServerWithTools(
  tools: ResponsesV2CertifiedToolProfile["tools"],
): ResponsesServerV2 {
  const profileVersion = "synthetic-profile";
  return new ResponsesServerV2({
    toolProfile: {
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
    },
  });
}
