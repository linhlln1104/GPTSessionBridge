import {
  AGENT_WORKFLOW_PROTOCOL_VERSION,
  NATIVE_MESSAGING_PROTOCOL_VERSION,
  nativeMessagingFrameSchema,
  type NativeMessagingFrame,
} from "@gpt-session-bridge/protocol";
import { describe, expect, it } from "vitest";

import { NativeLinkError } from "../src/link/errors.js";
import { NativeLinkSession } from "../src/link/link-session.js";
import {
  BRIDGE_TO_EXTENSION_APPLICATION_TYPES,
  EXTENSION_TO_BRIDGE_APPLICATION_TYPES,
} from "../src/link/relay-policy.js";
import { helloAcknowledgedFrame, helloFrame } from "./fixtures.js";

describe("NativeLinkSession", () => {
  it("accepts a responder handshake and re-envelopes application frames", () => {
    const link = createExtensionLink();
    const handshake = link.receive(helloFrame("extension"));

    expect(handshake.response).toMatchObject({
      requestId: "request-hello",
      sequence: 0,
      type: "hello/acknowledged",
      payload: { peer: "nativeHost" },
    });
    expect(link.state).toBe("ready");

    const incoming = sessionConnectedFrame(1);
    expect(link.receive(incoming)).toEqual({ application: incoming });

    const outgoing = link.sendApplication(sessionConnectFrame(99));
    expect(outgoing).toMatchObject({
      requestId: "request-session",
      sequence: 1,
      type: "session/connect",
    });
  });

  it("initiates a bridge handshake and correlates heartbeat acknowledgements", () => {
    const link = createBridgeLink();
    expect(link.start("request-hello")).toMatchObject({
      sequence: 0,
      type: "hello",
      payload: { peer: "nativeHost" },
    });
    expect(link.receive(helloAcknowledgedFrame("bridge"))).toEqual({});

    const heartbeat = link.sendHeartbeat("request-heartbeat");
    expect(heartbeat).toMatchObject({ sequence: 1, type: "heartbeat" });
    expect(
      link.receive(
        nativeMessagingFrameSchema.parse({
          protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
          requestId: "request-heartbeat",
          sequence: 1,
          type: "ack",
          payload: { acknowledgedSequence: 1 },
        }),
      ),
    ).toEqual({});
  });

  it("admits v2 agent status and activity only through the relay policy", () => {
    const link = createExtensionLink();
    link.receive(helloFrame("extension"));
    const status = activeAgentStatus();
    const result = nativeMessagingFrameSchema.parse({
      protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
      requestId: "request-status",
      sequence: 1,
      type: "agent/status/result",
      payload: {
        agentProtocolVersion: AGENT_WORKFLOW_PROTOCOL_VERSION,
        sessionId: "session-example",
        status,
      },
    });

    expect(link.receive(result)).toEqual({ application: result });
    expect(
      link.sendApplication(
        nativeMessagingFrameSchema.parse({
          protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
          requestId: "request-activity",
          sequence: 99,
          type: "agent/activity/note",
          payload: { expected: status, sessionId: "session-example" },
        }),
      ),
    ).toMatchObject({ sequence: 1, type: "agent/activity/note" });
    expect(
      link.sendApplication(
        nativeMessagingFrameSchema.parse({
          protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
          requestId: "request-agent-turn",
          sequence: 100,
          type: "agent/turn/start",
          payload: {
            agentProtocolVersion: AGENT_WORKFLOW_PROTOCOL_VERSION,
            catalogRevision: "catalog-example",
            expected: status,
            input: [{ text: "agent prompt", type: "text" }],
            modelId: "gptsessionbridge/web/model",
            reasoningEffort: "medium",
            sessionId: "session-example",
            temporary: false,
            turnId: "turn-example",
          },
        }),
      ),
    ).toMatchObject({ sequence: 2, type: "agent/turn/start" });
  });

  it("acknowledges a remote heartbeat without creating an ACK loop", () => {
    const link = createExtensionLink();
    link.receive(helloFrame("extension"));

    const result = link.receive(
      nativeMessagingFrameSchema.parse({
        protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
        requestId: "request-heartbeat",
        sequence: 1,
        type: "heartbeat",
        payload: {},
      }),
    );

    expect(result.response).toMatchObject({
      requestId: "request-heartbeat",
      sequence: 1,
      type: "ack",
      payload: { acknowledgedSequence: 1 },
    });
  });

  it("permits only one outstanding local heartbeat", () => {
    const link = createBridgeLink();
    link.start("request-hello");
    link.receive(helloAcknowledgedFrame("bridge"));
    link.sendHeartbeat("request-heartbeat");

    expect(() => link.sendHeartbeat("request-heartbeat-second")).toThrow(
      expect.objectContaining<Partial<NativeLinkError>>({ code: "invalid_state" }),
    );
    expect(link.state).toBe("closed");
  });

  it("closes on peer, sequence, direction, and correlation violations", () => {
    const cases: (() => void)[] = [
      () => {
        createExtensionLink().receive(helloFrame("bridge"));
      },
      () => {
        const link = createExtensionLink();
        link.receive(helloFrame("extension"));
        link.receive(sessionConnectedFrame(2));
      },
      () => {
        const link = createExtensionLink();
        link.receive(helloFrame("extension"));
        link.receive(sessionConnectFrame(1));
      },
      () => {
        const link = createBridgeLink();
        link.start("request-hello");
        link.receive(helloAcknowledgedFrame("bridge", "request-other"));
      },
      () => {
        const link = createBridgeLink();
        link.start("request-hello");
        link.receive(helloAcknowledgedFrame("extension"));
      },
    ];

    for (const operation of cases) {
      expect(operation).toThrow(NativeLinkError);
    }
  });

  it("rejects duplicate handshakes, unsolicited ACKs, and sends before ready", () => {
    const duplicate = createExtensionLink();
    duplicate.receive(helloFrame("extension"));
    expect(() => duplicate.receive({ ...helloFrame("extension"), sequence: 1 })).toThrow(
      expect.objectContaining<Partial<NativeLinkError>>({ code: "invalid_state" }),
    );

    const unsolicitedAck = createExtensionLink();
    unsolicitedAck.receive(helloFrame("extension"));
    expect(() =>
      unsolicitedAck.receive(
        nativeMessagingFrameSchema.parse({
          protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
          requestId: "request-ack",
          sequence: 1,
          type: "ack",
          payload: { acknowledgedSequence: 0 },
        }),
      ),
    ).toThrow(expect.objectContaining<Partial<NativeLinkError>>({ code: "correlation_violation" }));

    expect(() => createExtensionLink().sendApplication(sessionConnectFrame(0))).toThrow(
      expect.objectContaining<Partial<NativeLinkError>>({ code: "invalid_state" }),
    );
  });

  it("rejects invalid frames and invalid link configuration", () => {
    expect(() => createExtensionLink().receive({ type: "hello" })).toThrow(
      expect.objectContaining<Partial<NativeLinkError>>({ code: "invalid_frame" }),
    );
    expect(
      () =>
        new NativeLinkSession({
          implementationVersion: "invalid version",
          incomingApplicationTypes: ["heartbeat"],
          localPeer: "nativeHost",
          mode: "responder",
          outgoingApplicationTypes: [],
          remotePeer: "nativeHost",
        }),
    ).toThrow(RangeError);
  });
});

function createExtensionLink(): NativeLinkSession {
  return new NativeLinkSession({
    implementationVersion: "0.1.0-test",
    incomingApplicationTypes: EXTENSION_TO_BRIDGE_APPLICATION_TYPES,
    localPeer: "nativeHost",
    mode: "responder",
    outgoingApplicationTypes: BRIDGE_TO_EXTENSION_APPLICATION_TYPES,
    remotePeer: "extension",
  });
}

function createBridgeLink(): NativeLinkSession {
  return new NativeLinkSession({
    implementationVersion: "0.1.0-test",
    incomingApplicationTypes: BRIDGE_TO_EXTENSION_APPLICATION_TYPES,
    localPeer: "nativeHost",
    mode: "initiator",
    outgoingApplicationTypes: EXTENSION_TO_BRIDGE_APPLICATION_TYPES,
    remotePeer: "bridge",
  });
}

function sessionConnectFrame(sequence: number): NativeMessagingFrame {
  return nativeMessagingFrameSchema.parse({
    protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
    requestId: "request-session",
    sequence,
    type: "session/connect",
    payload: { sessionId: "session-example" },
  });
}

function sessionConnectedFrame(sequence: number): NativeMessagingFrame {
  return nativeMessagingFrameSchema.parse({
    protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
    requestId: "request-session",
    sequence,
    type: "session/connected",
    payload: { sessionId: "session-example" },
  });
}

function activeAgentStatus(): Readonly<Record<string, unknown>> {
  return {
    binding: { documentId: "document-example", generation: 1, tabId: 7 },
    conversationOwnershipId: "ownership-example",
    expiresAtMs: 901_000,
    issuedAtMs: 1_000,
    lastActivityAtMs: 1_000,
    leaseId: "lease-example",
    revision: 1,
    state: "active",
  };
}
