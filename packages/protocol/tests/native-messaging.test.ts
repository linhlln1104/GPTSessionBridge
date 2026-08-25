import { describe, expect, expectTypeOf, it } from "vitest";

import {
  BRIDGE_ERROR_CODES,
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
        supportedProtocolVersions: [1],
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
              id: "web/example-model",
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
          modelId: "web/example-model",
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

    expect(nativeMessagingFrameSchema.safeParse({ ...valid, protocolVersion: 2 }).success).toBe(
      false,
    );
    expect(nativeMessagingFrameSchema.safeParse({ ...valid, sequence: -1 }).success).toBe(false);
    expect(nativeMessagingFrameSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(
      nativeMessagingFrameSchema.safeParse({
        ...valid,
        payload: { sessionId: "session-example", tabId: 123 },
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
        modelId: "web/example-model",
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
              id: "web/example-model",
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
        id: "web/example-model",
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
        id: "web/example-model",
        displayName: "Spoofed \u202E model",
        inputModalities: ["text"],
        supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Light reasoning" }],
        defaultReasoningEffort: "low",
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
