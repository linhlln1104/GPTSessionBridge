import { describe, expect, expectTypeOf, it } from "vitest";

import {
  BRIDGE_ERROR_CODES,
  AGENT_WORKFLOW_PROTOCOL_VERSION,
  MAX_TURN_DELTA_CHARACTERS,
  MAX_TURN_INPUT_TEXT_CHARACTERS,
  NATIVE_MESSAGING_PROTOCOL_VERSION,
  nativeMessagingFrameSchema,
  webModelDescriptorSchema,
  type NativeMessagingFrameOf,
} from "../src/index.js";

const baseFrame = {
  protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
  requestId: "request-example",
  sequence: 0,
} as const;

describe("native-messaging frames", () => {
  it("parses a hello handshake", () => {
    const frame = {
      ...baseFrame,
      type: "hello",
      payload: {
        peer: "extension",
        implementationVersion: "0.1.0-fixture",
        supportedProtocolVersions: [NATIVE_MESSAGING_PROTOCOL_VERSION],
      },
    };

    expect(nativeMessagingFrameSchema.parse(frame)).toEqual(frame);
  });

  it("parses heartbeat and acknowledgement frames", () => {
    const heartbeat = {
      ...baseFrame,
      type: "heartbeat",
      payload: {},
    };
    const acknowledgement = {
      ...baseFrame,
      sequence: 1,
      type: "ack",
      payload: { acknowledgedSequence: 0 },
    };

    expect(nativeMessagingFrameSchema.parse(heartbeat)).toEqual(heartbeat);
    expect(nativeMessagingFrameSchema.parse(acknowledgement)).toEqual(acknowledgement);
  });

  it("parses discovered capabilities with synthetic models", () => {
    const frame = {
      ...baseFrame,
      type: "capabilities/result",
      payload: {
        sessionId: "session-example",
        capabilities: {
          catalogRevision: "catalog-example-a",
          modelDiscovery: true,
          streaming: true,
          cancellation: true,
          temporaryChat: true,
          imageInput: false,
          toolCalls: false,
          models: [
            {
              id: "gptsessionbridge/web/example-model",
              displayName: "Example Web Model",
              inputModalities: ["text"],
              supportedReasoningEfforts: [
                { reasoningEffort: "low", description: "Light reasoning" },
                { reasoningEffort: "medium", description: "Balanced reasoning" },
                { reasoningEffort: "high", description: "Deep reasoning" },
              ],
              defaultReasoningEffort: "medium",
            },
          ],
        },
      },
    };

    expect(nativeMessagingFrameSchema.parse(frame)).toEqual(frame);
  });

  it("parses the complete streaming turn lifecycle", () => {
    const frames = [
      {
        ...baseFrame,
        type: "turn/start",
        payload: {
          sessionId: "session-example",
          turnId: "turn-example",
          catalogRevision: "catalog-example-a",
          modelId: "gptsessionbridge/web/example-model",
          reasoningEffort: "medium",
          input: [{ type: "text", text: "Return a synthetic greeting." }],
          temporary: true,
        },
      },
      {
        ...baseFrame,
        sequence: 1,
        type: "turn/started",
        payload: { sessionId: "session-example", turnId: "turn-example" },
      },
      {
        ...baseFrame,
        sequence: 2,
        type: "turn/delta",
        payload: {
          sessionId: "session-example",
          turnId: "turn-example",
          channel: "outputText",
          delta: "Hello from a fixture.",
        },
      },
      {
        ...baseFrame,
        sequence: 3,
        type: "turn/completed",
        payload: {
          sessionId: "session-example",
          turnId: "turn-example",
          finishReason: "stop",
        },
      },
    ];

    for (const frame of frames) {
      expect(nativeMessagingFrameSchema.safeParse(frame).success).toBe(true);
    }
  });

  it("parses a safe turn failure", () => {
    const frame = {
      ...baseFrame,
      type: "turn/failed",
      payload: {
        sessionId: "session-example",
        turnId: "turn-example",
        error: {
          code: BRIDGE_ERROR_CODES.BROWSER_STATE_CHANGED,
          message: "The page changed before the operation completed.",
          retryable: true,
        },
      },
    };

    expect(nativeMessagingFrameSchema.parse(frame)).toEqual(frame);
  });

  it("rejects unsupported versions, invalid sequences, and unknown fields", () => {
    const valid = {
      ...baseFrame,
      type: "session/connect",
      payload: { sessionId: "session-example" },
    };

    expect(nativeMessagingFrameSchema.safeParse({ ...valid, protocolVersion: 1 }).success).toBe(
      false,
    );
    expect(nativeMessagingFrameSchema.safeParse({ ...valid, sequence: -1 }).success).toBe(false);
    expect(
      nativeMessagingFrameSchema.safeParse({ ...valid, sequence: Number.MAX_SAFE_INTEGER + 1 })
        .success,
    ).toBe(false);
    expect(nativeMessagingFrameSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(
      nativeMessagingFrameSchema.safeParse({
        ...valid,
        payload: { sessionId: "session-example", tabId: 123 },
      }).success,
    ).toBe(false);
  });

  it("requires a truthful, unique handshake version advertisement", () => {
    const hello = {
      ...baseFrame,
      type: "hello",
      payload: {
        peer: "extension",
        implementationVersion: "0.1.0-fixture",
        supportedProtocolVersions: [NATIVE_MESSAGING_PROTOCOL_VERSION],
      },
    };

    expect(nativeMessagingFrameSchema.safeParse(hello).success).toBe(true);
    expect(
      nativeMessagingFrameSchema.safeParse({
        ...hello,
        payload: { ...hello.payload, supportedProtocolVersions: [1] },
      }).success,
    ).toBe(false);
    expect(
      nativeMessagingFrameSchema.safeParse({
        ...hello,
        payload: { ...hello.payload, supportedProtocolVersions: [2, 2] },
      }).success,
    ).toBe(false);
    expect(
      nativeMessagingFrameSchema.safeParse({
        ...hello,
        payload: {
          ...hello.payload,
          supportedProtocolVersions: [Number.MAX_SAFE_INTEGER + 1],
        },
      }).success,
    ).toBe(false);
  });

  it("parses strict agent status and activity frames", () => {
    const active = {
      binding: { documentId: "document-a", generation: 1, tabId: 7 },
      conversationOwnershipId: "ownership-a",
      expiresAtMs: 901_000,
      issuedAtMs: 1_000,
      lastActivityAtMs: 1_000,
      leaseId: "lease-a",
      revision: 1,
      state: "active",
    } as const;
    const frames = [
      { ...baseFrame, type: "agent/status/read", payload: { sessionId: "session-example" } },
      {
        ...baseFrame,
        type: "agent/status/result",
        payload: {
          agentProtocolVersion: AGENT_WORKFLOW_PROTOCOL_VERSION,
          sessionId: "session-example",
          status: active,
        },
      },
      {
        ...baseFrame,
        type: "agent/status/changed",
        payload: {
          agentProtocolVersion: AGENT_WORKFLOW_PROTOCOL_VERSION,
          sessionId: "session-example",
          status: { revision: 2, state: "inactive" },
        },
      },
      {
        ...baseFrame,
        type: "agent/activity/note",
        payload: { expected: active, sessionId: "session-example" },
      },
      {
        ...baseFrame,
        type: "agent/activity/result",
        payload: {
          agentProtocolVersion: AGENT_WORKFLOW_PROTOCOL_VERSION,
          sessionId: "session-example",
          status: { ...active, revision: 2 },
        },
      },
      {
        ...baseFrame,
        type: "agent/turn/start",
        payload: {
          agentProtocolVersion: AGENT_WORKFLOW_PROTOCOL_VERSION,
          catalogRevision: "catalog-example-a",
          expected: active,
          input: [{ text: "GSB/2 BEGIN\n{}\nGSB/2 END", type: "text" }],
          modelId: "gptsessionbridge/web/example-model",
          reasoningEffort: "medium",
          sessionId: "session-example",
          temporary: false,
          turnId: "turn-example",
        },
      },
    ] as const;

    for (const frame of frames) {
      expect(nativeMessagingFrameSchema.safeParse(frame).success).toBe(true);
    }
    expect(
      nativeMessagingFrameSchema.safeParse({
        ...frames[3],
        payload: { ...frames[3].payload, expected: { ...active, expiresAtMs: 901_001 } },
      }).success,
    ).toBe(false);
    expect(
      nativeMessagingFrameSchema.safeParse({
        ...frames[5],
        payload: { ...frames[5].payload, temporary: true },
      }).success,
    ).toBe(false);
    expect(
      nativeMessagingFrameSchema.safeParse({
        ...frames[1],
        payload: { ...frames[1].payload, internalReason: "user_activated" },
      }).success,
    ).toBe(false);
  });

  it("enforces conservative turn text limits", () => {
    const oversizedInput = {
      ...baseFrame,
      type: "turn/start",
      payload: {
        sessionId: "session-example",
        turnId: "turn-example",
        catalogRevision: "catalog-example-a",
        modelId: "gptsessionbridge/web/example-model",
        reasoningEffort: "medium",
        input: [{ type: "text", text: "x".repeat(MAX_TURN_INPUT_TEXT_CHARACTERS + 1) }],
        temporary: true,
      },
    };
    const oversizedDelta = {
      ...baseFrame,
      type: "turn/delta",
      payload: {
        sessionId: "session-example",
        turnId: "turn-example",
        channel: "commentary",
        delta: "x".repeat(MAX_TURN_DELTA_CHARACTERS + 1),
      },
    };

    expect(nativeMessagingFrameSchema.safeParse(oversizedInput).success).toBe(false);
    expect(nativeMessagingFrameSchema.safeParse(oversizedDelta).success).toBe(false);
  });

  it("requires a known delta channel", () => {
    expect(
      nativeMessagingFrameSchema.safeParse({
        ...baseFrame,
        type: "turn/delta",
        payload: {
          sessionId: "session-example",
          turnId: "turn-example",
          channel: "unknown",
          delta: "Synthetic delta",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects inconsistent model reasoning metadata", () => {
    const frame = {
      ...baseFrame,
      type: "capabilities/result",
      payload: {
        sessionId: "session-example",
        capabilities: {
          catalogRevision: "catalog-example-a",
          modelDiscovery: true,
          streaming: true,
          cancellation: true,
          temporaryChat: true,
          imageInput: false,
          toolCalls: false,
          models: [
            {
              id: "gptsessionbridge/web/example-model",
              displayName: "Example Web Model",
              inputModalities: ["text"],
              supportedReasoningEfforts: [
                { reasoningEffort: "low", description: "Light reasoning" },
                { reasoningEffort: "medium", description: "Balanced reasoning" },
              ],
              defaultReasoningEffort: "high",
            },
          ],
        },
      },
    };

    expect(nativeMessagingFrameSchema.safeParse(frame).success).toBe(false);
    expect(
      webModelDescriptorSchema.safeParse({
        id: "gptsessionbridge/web/example-model",
        displayName: "Example Web Model",
        inputModalities: ["text"],
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Light reasoning" },
          { reasoningEffort: "low", description: "Duplicate reasoning" },
        ],
        defaultReasoningEffort: "low",
      }).success,
    ).toBe(false);
    expect(
      webModelDescriptorSchema.safeParse({
        id: "gptsessionbridge/web/example-model",
        displayName: "Spoofed \u202E model",
        inputModalities: ["text"],
        supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Light reasoning" }],
        defaultReasoningEffort: "low",
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate models and undiscoverable model catalogs", () => {
    const model = {
      id: "gptsessionbridge/web/example-model",
      displayName: "Example Web Model",
      inputModalities: ["text"] as const,
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced reasoning" }],
      defaultReasoningEffort: "medium",
    };
    const capabilities = {
      catalogRevision: "catalog-example-a",
      modelDiscovery: true,
      streaming: true,
      cancellation: true,
      temporaryChat: true,
      imageInput: false,
      toolCalls: false,
      models: [model],
    };

    expect(
      nativeMessagingFrameSchema.safeParse({
        ...baseFrame,
        type: "capabilities/result",
        payload: {
          sessionId: "session-example",
          capabilities: { ...capabilities, models: [model, model] },
        },
      }).success,
    ).toBe(false);
    expect(
      nativeMessagingFrameSchema.safeParse({
        ...baseFrame,
        type: "capabilities/result",
        payload: {
          sessionId: "session-example",
          capabilities: { ...capabilities, modelDiscovery: false },
        },
      }).success,
    ).toBe(false);
  });

  it("narrows a frame by its public event type", () => {
    expectTypeOf<NativeMessagingFrameOf<"turn/delta">["payload"]>().toEqualTypeOf<{
      sessionId: string;
      turnId: string;
      channel: "outputText" | "reasoning" | "commentary";
      delta: string;
    }>();
  });
});
