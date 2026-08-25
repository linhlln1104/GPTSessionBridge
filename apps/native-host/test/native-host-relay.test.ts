import {
  NATIVE_MESSAGING_PROTOCOL_VERSION,
  nativeMessagingFrameSchema,
} from "@gpt-session-bridge/protocol";
import { describe, expect, it } from "vitest";

import { NativeLinkError } from "../src/protocol/errors.js";
import { NativeHostRelay } from "../src/protocol/native-host-relay.js";
import { helloAcknowledgedFrame, helloFrame } from "./fixtures.js";

describe("NativeHostRelay", () => {
  it("terminates both handshakes and re-sequences application frames per link", () => {
    const relay = readyRelay();
    const command = nativeMessagingFrameSchema.parse({
      protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
      requestId: "request-session",
      sequence: 1,
      type: "session/connect",
      payload: { sessionId: "session-example" },
    });
    const response = nativeMessagingFrameSchema.parse({
      protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
      requestId: "request-session",
      sequence: 1,
      type: "session/connected",
      payload: { sessionId: "session-example" },
    });

    expect(relay.receiveFromBridge(command).toExtension).toMatchObject({
      requestId: "request-session",
      sequence: 1,
      type: "session/connect",
    });
    expect(relay.receiveFromExtension(response).toBridge).toMatchObject({
      requestId: "request-session",
      sequence: 1,
      type: "session/connected",
    });
    expect(relay.state).toEqual({ bridge: "ready", extension: "ready" });
  });

  it("responds locally to extension transport frames", () => {
    const relay = new NativeHostRelay({ implementationVersion: "0.1.0-test" });
    const result = relay.receiveFromExtension(helloFrame("extension"));

    expect(result.toExtension).toMatchObject({ sequence: 0, type: "hello/acknowledged" });
    expect(result.toBridge).toBeUndefined();
  });

  it("fails closed when an application destination is unavailable", () => {
    const relay = new NativeHostRelay({ implementationVersion: "0.1.0-test" });
    relay.startBridgeHandshake("request-hello");
    relay.receiveFromBridge(helloAcknowledgedFrame("bridge"));
    const command = nativeMessagingFrameSchema.parse({
      protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
      requestId: "request-session",
      sequence: 1,
      type: "session/connect",
      payload: { sessionId: "session-example" },
    });

    expect(() => relay.receiveFromBridge(command)).toThrow(
      expect.objectContaining<Partial<NativeLinkError>>({ code: "destination_unavailable" }),
    );
    expect(relay.state).toEqual({ bridge: "closed", extension: "closed" });
  });

  it("closes both links after any protocol violation", () => {
    const relay = readyRelay();

    expect(() => relay.receiveFromExtension({ type: "unknown" })).toThrow(NativeLinkError);
    expect(relay.state).toEqual({ bridge: "closed", extension: "closed" });
  });
});

function readyRelay(): NativeHostRelay {
  const relay = new NativeHostRelay({ implementationVersion: "0.1.0-test" });
  expect(relay.startBridgeHandshake("request-hello")).toMatchObject({
    sequence: 0,
    type: "hello",
  });
  expect(relay.receiveFromBridge(helloAcknowledgedFrame("bridge"))).toEqual({});
  expect(relay.receiveFromExtension(helloFrame("extension")).toExtension).toMatchObject({
    sequence: 0,
    type: "hello/acknowledged",
  });
  return relay;
}
