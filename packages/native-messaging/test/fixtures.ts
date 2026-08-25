import {
  NATIVE_MESSAGING_PROTOCOL_VERSION,
  nativeMessagingFrameSchema,
  type NativeMessagingFrame,
  type PeerRole,
} from "@gpt-session-bridge/protocol";

export function helloFrame(peer: PeerRole, requestId = "request-hello"): NativeMessagingFrame {
  return nativeMessagingFrameSchema.parse({
    protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
    requestId,
    sequence: 0,
    type: "hello",
    payload: {
      implementationVersion: "0.1.0-fixture",
      peer,
      supportedProtocolVersions: [NATIVE_MESSAGING_PROTOCOL_VERSION],
    },
  });
}

export function helloAcknowledgedFrame(
  peer: PeerRole,
  requestId = "request-hello",
): NativeMessagingFrame {
  return nativeMessagingFrameSchema.parse({
    protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
    requestId,
    sequence: 0,
    type: "hello/acknowledged",
    payload: {
      implementationVersion: "0.1.0-fixture",
      peer,
    },
  });
}

export function encodeNativeMessage(frame: NativeMessagingFrame): Buffer {
  const payload = Buffer.from(JSON.stringify(frame), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}
