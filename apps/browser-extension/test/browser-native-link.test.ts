import { describe, expect, it } from "vitest";
import {
  AGENT_WORKFLOW_PROTOCOL_VERSION,
  NATIVE_MESSAGING_PROTOCOL_VERSION,
} from "@gpt-session-bridge/protocol";

import {
  BrowserNativeLink,
  BrowserNativeLinkError,
  parseNativeMessagingFrame,
} from "../src/protocol/browser-native-link.js";

describe("browser-safe Native Messaging link", () => {
  it("binds the native-host acknowledgement to the fresh handshake request", () => {
    const link = new BrowserNativeLink();
    const hello = link.start("request-fresh", "0.1.0");

    expect(hello).toMatchObject({ sequence: 0, type: "hello" });
    expect(
      link.receive({
        payload: { implementationVersion: "0.1.0", peer: "nativeHost" },
        protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
        requestId: "request-fresh",
        sequence: 0,
        type: "hello/acknowledged",
      }),
    ).toEqual({});
    expect(link.state).toBe("ready");
  });

  it("rejects unknown fields and closes the link", () => {
    const link = new BrowserNativeLink();
    link.start("request-fresh", "0.1.0");

    expect(() =>
      link.receive({
        extra: true,
        payload: { implementationVersion: "0.1.0", peer: "nativeHost" },
        protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
        requestId: "request-fresh",
        sequence: 0,
        type: "hello/acknowledged",
      }),
    ).toThrow(BrowserNativeLinkError);
    expect(link.state).toBe("closed");
  });

  it("enforces bounded turn input without a dynamic-code validator", () => {
    expect(
      parseNativeMessagingFrame({
        payload: {
          catalogRevision: "catalog-a",
          input: [{ text: "x".repeat(65_537), type: "text" }],
          modelId: "gptsessionbridge/web/model",
          reasoningEffort: "medium",
          sessionId: "session-a",
          temporary: false,
          turnId: "turn-a",
        },
        protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
        requestId: "request-turn",
        sequence: 1,
        type: "turn/start",
      }),
    ).toBeUndefined();
  });

  it.each(validProtocolFrames())("parses the strict %s frame contract", (_type, frame) => {
    expect(parseNativeMessagingFrame(frame)).toEqual(frame);
  });

  it("handles heartbeat backpressure and re-envelopes extension application frames", () => {
    const link = readyLink();

    expect(link.receive(frame("heartbeat", {}, { requestId: "heartbeat-1", sequence: 1 }))).toEqual(
      {
        response: frame(
          "ack",
          { acknowledgedSequence: 1 },
          { requestId: "heartbeat-1", sequence: 1 },
        ),
      },
    );
    expect(
      link.sendApplication(
        frame(
          "session/connected",
          { sessionId: "session-a" },
          { requestId: "session-connect", sequence: 0 },
        ),
      ),
    ).toEqual(
      frame(
        "session/connected",
        { sessionId: "session-a" },
        { requestId: "session-connect", sequence: 2 },
      ),
    );
  });

  it.each([
    ["null frame", null],
    ["array frame", []],
    ["unknown type", frame("unknown", {})],
    ["unsafe request id", frame("heartbeat", {}, { requestId: "bad request" })],
    ["unsafe sequence", frame("heartbeat", {}, { sequence: -1 })],
    ["unsupported version", { ...frame("heartbeat", {}), protocolVersion: 1 }],
    ["extra payload field", frame("heartbeat", { extra: true })],
    [
      "inconsistent agent expiry",
      frame("agent/activity/note", {
        expected: { ...activeAgentStatus(), expiresAtMs: 901_001 },
        sessionId: "session-a",
      }),
    ],
    [
      "private agent status field",
      frame("agent/status/result", {
        agentProtocolVersion: AGENT_WORKFLOW_PROTOCOL_VERSION,
        sessionId: "session-a",
        status: { ...activeAgentStatus(), reason: "user_activated" },
      }),
    ],
    [
      "agent turn without an exact lease",
      frame("agent/turn/start", {
        agentProtocolVersion: AGENT_WORKFLOW_PROTOCOL_VERSION,
        catalogRevision: "catalog-a",
        expected: { ...activeAgentStatus(), expiresAtMs: 901_001 },
        input: [{ text: "prompt", type: "text" }],
        modelId: "gptsessionbridge/web/model",
        reasoningEffort: "medium",
        sessionId: "session-a",
        temporary: false,
        turnId: "turn-a",
      }),
    ],
    [
      "inconsistent capabilities",
      frame("capabilities/result", {
        capabilities: capabilities({ modelDiscovery: false, models: [model()] }),
        sessionId: "session-a",
      }),
    ],
    [
      "duplicate model id",
      frame("capabilities/result", {
        capabilities: capabilities({ models: [model(), model()] }),
        sessionId: "session-a",
      }),
    ],
    [
      "unsupported default effort",
      frame("capabilities/result", {
        capabilities: capabilities({
          models: [model({ defaultReasoningEffort: "high" })],
        }),
        sessionId: "session-a",
      }),
    ],
  ] as const)("rejects %s", (_description, candidate) => {
    expect(parseNativeMessagingFrame(candidate)).toBeUndefined();
  });
});

function readyLink(): BrowserNativeLink {
  const link = new BrowserNativeLink();
  link.start("request-fresh", "0.1.0");
  link.receive(
    frame(
      "hello/acknowledged",
      { implementationVersion: "0.1.0", peer: "nativeHost" },
      { requestId: "request-fresh" },
    ),
  );
  return link;
}

function validProtocolFrames(): readonly (readonly [string, Readonly<Record<string, unknown>>])[] {
  const session = { sessionId: "session-a" };
  const turn = { ...session, turnId: "turn-a" };
  const error = { code: "session.closed", message: "Session closed.", retryable: true };
  return [
    [
      "hello",
      frame("hello", {
        implementationVersion: "0.1.0",
        peer: "extension",
        supportedProtocolVersions: [NATIVE_MESSAGING_PROTOCOL_VERSION],
      }),
    ],
    [
      "hello/acknowledged",
      frame("hello/acknowledged", {
        implementationVersion: "0.1.0",
        peer: "nativeHost",
      }),
    ],
    ["heartbeat", frame("heartbeat", {})],
    ["ack", frame("ack", { acknowledgedSequence: 0 })],
    ["session/connect", frame("session/connect", session)],
    ["session/connected", frame("session/connected", session)],
    ["session/disconnect", frame("session/disconnect", { ...session, reason: "user" })],
    [
      "session/disconnected",
      frame("session/disconnected", { ...session, reason: "pageUnavailable" }),
    ],
    ["capabilities/read", frame("capabilities/read", session)],
    ["agent/status/read", frame("agent/status/read", session)],
    [
      "agent/status/result",
      frame("agent/status/result", {
        agentProtocolVersion: AGENT_WORKFLOW_PROTOCOL_VERSION,
        ...session,
        status: activeAgentStatus(),
      }),
    ],
    [
      "agent/status/changed",
      frame("agent/status/changed", {
        agentProtocolVersion: AGENT_WORKFLOW_PROTOCOL_VERSION,
        ...session,
        status: { revision: 2, state: "inactive" },
      }),
    ],
    [
      "agent/activity/note",
      frame("agent/activity/note", { expected: activeAgentStatus(), ...session }),
    ],
    [
      "agent/activity/result",
      frame("agent/activity/result", {
        agentProtocolVersion: AGENT_WORKFLOW_PROTOCOL_VERSION,
        ...session,
        status: { ...activeAgentStatus(), revision: 2 },
      }),
    ],
    [
      "agent/turn/start",
      frame("agent/turn/start", {
        agentProtocolVersion: AGENT_WORKFLOW_PROTOCOL_VERSION,
        catalogRevision: "catalog-a",
        expected: activeAgentStatus(),
        input: [{ text: "GSB/2 BEGIN\n{}\nGSB/2 END", type: "text" }],
        modelId: "gptsessionbridge/web/model",
        reasoningEffort: "medium",
        ...session,
        temporary: false,
        turnId: "turn-a",
      }),
    ],
    [
      "capabilities/result",
      frame("capabilities/result", {
        capabilities: capabilities({ models: [model()] }),
        ...session,
      }),
    ],
    [
      "capabilities/changed",
      frame("capabilities/changed", { capabilities: capabilities(), ...session }),
    ],
    [
      "turn/start",
      frame("turn/start", {
        catalogRevision: "catalog-a",
        input: [{ text: "hello", type: "text" }],
        modelId: "gptsessionbridge/web/model",
        reasoningEffort: "medium",
        ...turn,
        temporary: false,
      }),
    ],
    ["turn/started", frame("turn/started", turn)],
    ["turn/delta", frame("turn/delta", { channel: "outputText", delta: "hello", ...turn })],
    ["turn/completed", frame("turn/completed", { finishReason: "stop", ...turn })],
    ["turn/cancel", frame("turn/cancel", turn)],
    ["turn/cancelled", frame("turn/cancelled", turn)],
    ["turn/failed", frame("turn/failed", { error, ...turn })],
    ["error", frame("error", { error })],
  ];
}

function frame(
  type: string,
  payload: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    payload,
    protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
    requestId: "request-a",
    sequence: 0,
    type,
    ...overrides,
  };
}

function activeAgentStatus(): Readonly<Record<string, unknown>> {
  return {
    binding: { documentId: "document-a", generation: 1, tabId: 7 },
    conversationOwnershipId: "ownership-a",
    expiresAtMs: 901_000,
    issuedAtMs: 1_000,
    lastActivityAtMs: 1_000,
    leaseId: "lease-a",
    revision: 1,
    state: "active",
  };
}

function capabilities(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    cancellation: true,
    catalogRevision: "catalog-a",
    imageInput: false,
    modelDiscovery: true,
    models: [],
    streaming: true,
    temporaryChat: true,
    toolCalls: false,
    ...overrides,
  };
}

function model(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    defaultReasoningEffort: "medium",
    displayName: "Web Model",
    id: "gptsessionbridge/web/model",
    inputModalities: ["text"],
    supportedReasoningEfforts: [{ description: "Balanced reasoning", reasoningEffort: "medium" }],
    ...overrides,
  };
}
