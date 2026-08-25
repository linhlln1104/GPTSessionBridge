import { PassThrough } from "node:stream";

import {
  BRIDGE_TO_EXTENSION_APPLICATION_TYPES,
  EXTENSION_TO_BRIDGE_APPLICATION_TYPES,
  NativeLinkSession,
} from "@gpt-session-bridge/native-messaging/link";
import {
  DEFAULT_NATIVE_MESSAGE_MAX_BUFFERED_BYTES,
  DEFAULT_NATIVE_MESSAGE_MAX_FRAME_BYTES,
  NativeMessageDecoder,
} from "@gpt-session-bridge/native-messaging/transport";
import {
  NATIVE_MESSAGING_PROTOCOL_VERSION,
  nativeMessagingFrameSchema,
  type NativeMessagingFrame,
} from "@gpt-session-bridge/protocol";
import { describe, expect, it } from "vitest";

import { BridgeNativeApplicationPort } from "../src/browser/bridge-native-application-port.js";

describe("BridgeNativeApplicationPort", () => {
  it("initiates a fresh bridge link and carries semantic application messages", async () => {
    const fromHelper = new PassThrough();
    const toHelper = new PassThrough();
    const outgoing = new FrameReader(toHelper);
    let receivedResolve: ((frame: NativeMessagingFrame) => void) | undefined;
    const received = new Promise<NativeMessagingFrame>((resolve) => {
      receivedResolve = resolve;
    });
    const port = new BridgeNativeApplicationPort({
      handshakeTimeoutMs: 1_000,
      implementationVersion: "0.1.0-test",
      input: fromHelper,
      onApplication(frame): Promise<void> {
        receivedResolve?.(frame);
        return Promise.resolve();
      },
      output: toHelper,
    });
    const host = createHostBridgeLink();

    const starting = port.start("request-fresh-channel");
    const hello = await outgoing.next();
    expect(hello).toMatchObject({
      requestId: "request-fresh-channel",
      sequence: 0,
      type: "hello",
      payload: { peer: "bridge" },
    });
    const acknowledged = host.receive(hello).response;
    expect(acknowledged).toBeDefined();
    fromHelper.write(encodeFrame(acknowledged));
    await expect(starting).resolves.toBeUndefined();

    const sending = port.send({
      payload: { sessionId: "session-example" },
      requestId: "request-connect",
      type: "session/connect",
    });
    const command = await outgoing.next();
    expect(host.receive(command).application).toMatchObject({
      requestId: "request-connect",
      sequence: 1,
      type: "session/connect",
    });
    await sending;

    const response = host.sendApplication(
      nativeMessagingFrameSchema.parse({
        payload: { sessionId: "session-example" },
        protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
        requestId: "request-connect",
        sequence: 0,
        type: "session/connected",
      }),
    );
    fromHelper.write(encodeFrame(response));
    await expect(received).resolves.toMatchObject({
      requestId: "request-connect",
      type: "session/connected",
    });

    port.close();
    await expect(port.completion).resolves.toBeUndefined();
    outgoing.close();
  });

  it("fails closed on an invalid handshake and sends before readiness", async () => {
    const fromHelper = new PassThrough();
    const toHelper = new PassThrough();
    const outgoing = new FrameReader(toHelper);
    const port = new BridgeNativeApplicationPort({
      handshakeTimeoutMs: 1_000,
      implementationVersion: "0.1.0-test",
      input: fromHelper,
      onApplication: () => Promise.resolve(),
      output: toHelper,
    });

    await expect(
      port.send({
        payload: { sessionId: "session-example" },
        requestId: "request-before-ready",
        type: "session/connect",
      }),
    ).rejects.toMatchObject({ code: "transport_closed" });

    const starting = port.start("request-fresh-channel");
    await outgoing.next();
    fromHelper.write(
      encodeFrame(
        nativeMessagingFrameSchema.parse({
          payload: { implementationVersion: "0.1.0-test", peer: "extension" },
          protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
          requestId: "request-fresh-channel",
          sequence: 0,
          type: "hello/acknowledged",
        }),
      ),
    );
    await expect(starting).rejects.toMatchObject({ code: "unexpected_peer" });
    await expect(port.start("request-second")).rejects.toThrow(RangeError);
    outgoing.close();
  });

  it("validates constructor limits and completion lifecycle", () => {
    const stream = new PassThrough();
    expect(
      () =>
        new BridgeNativeApplicationPort({
          handshakeTimeoutMs: 0,
          implementationVersion: "0.1.0-test",
          input: stream,
          onApplication: () => Promise.resolve(),
          output: stream,
        }),
    ).toThrow(RangeError);

    const port = new BridgeNativeApplicationPort({
      handshakeTimeoutMs: 1,
      implementationVersion: "0.1.0-test",
      input: new PassThrough(),
      onApplication: () => Promise.resolve(),
      output: new PassThrough(),
    });
    expect(() => port.completion).toThrow(RangeError);
    port.close();
  });
});

class FrameReader {
  readonly #decoder = new NativeMessageDecoder({
    maxBufferedBytes: DEFAULT_NATIVE_MESSAGE_MAX_BUFFERED_BYTES,
    maxFrameBytes: DEFAULT_NATIVE_MESSAGE_MAX_FRAME_BYTES,
  });
  readonly #frames: NativeMessagingFrame[] = [];
  readonly #stream: PassThrough;
  readonly #waiters: ((frame: NativeMessagingFrame) => void)[] = [];

  public constructor(stream: PassThrough) {
    this.#stream = stream;
    stream.on("data", (chunk: Buffer) => {
      for (const frame of this.#decoder.push(chunk)) {
        const waiter = this.#waiters.shift();
        if (waiter === undefined) {
          this.#frames.push(frame);
        } else {
          waiter(frame);
        }
      }
    });
  }

  public next(): Promise<NativeMessagingFrame> {
    const frame = this.#frames.shift();
    if (frame !== undefined) {
      return Promise.resolve(frame);
    }
    return new Promise<NativeMessagingFrame>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  public close(): void {
    this.#stream.destroy();
  }
}

function createHostBridgeLink(): NativeLinkSession {
  return new NativeLinkSession({
    implementationVersion: "0.1.0-test",
    incomingApplicationTypes: BRIDGE_TO_EXTENSION_APPLICATION_TYPES,
    localPeer: "nativeHost",
    mode: "responder",
    outgoingApplicationTypes: EXTENSION_TO_BRIDGE_APPLICATION_TYPES,
    remotePeer: "bridge",
  });
}

function encodeFrame(frame: NativeMessagingFrame | undefined): Buffer {
  if (frame === undefined) {
    throw new Error("Missing synthetic frame");
  }
  const payload = Buffer.from(JSON.stringify(frame), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}
