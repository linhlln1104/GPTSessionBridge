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
  type WindowsIpcHelperExit,
} from "@gpt-session-bridge/native-messaging/transport";
import {
  NATIVE_MESSAGING_PROTOCOL_VERSION,
  nativeMessagingFrameSchema,
  type NativeMessagingFrame,
} from "@gpt-session-bridge/protocol";
import { describe, expect, it } from "vitest";

import {
  NativeHostRuntime,
  type WindowsIpcClientHelper,
} from "../src/runtime/native-host-runtime.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

describe("NativeHostRuntime", () => {
  it("opens Windows IPC only after the exact-origin extension handshake", async () => {
    const extensionInput = new PassThrough();
    const extensionOutput = new PassThrough();
    const helper = new FakeClientHelper();
    const runtime = createRuntime(extensionInput, extensionOutput, helper);
    const extensionFrames = new FrameReader(extensionOutput);
    const bridgeFrames = new FrameReader(helper.input);
    const extension = createExtensionLink();
    const bridge = createBridgeLink();

    const running = runtime.run();
    await Promise.resolve();
    expect(helper.started).toBe(false);
    extensionInput.write(encodeFrame(extension.start("request-extension-hello")));
    await waitUntil(() => helper.started);
    helper.signalConnected();

    const extensionAcknowledgement = await extensionFrames.next();
    expect(extension.receive(extensionAcknowledgement)).toEqual({});

    helper.output.write(encodeFrame(bridge.start("request-bridge-hello")));
    const bridgeAcknowledgement = await bridgeFrames.next();
    expect(bridge.receive(bridgeAcknowledgement)).toEqual({});

    const command = bridge.sendApplication(
      applicationFrame("session/connect", "request-connect", {
        sessionId: "session-example",
      }),
    );
    helper.output.write(encodeFrame(command));
    const extensionCommand = await extensionFrames.next();
    expect(extension.receive(extensionCommand).application).toMatchObject({
      requestId: "request-connect",
      type: "session/connect",
    });

    const response = extension.sendApplication(
      applicationFrame("session/connected", "request-connect", {
        sessionId: "session-example",
      }),
    );
    extensionInput.write(encodeFrame(response));
    const bridgeResponse = await bridgeFrames.next();
    expect(bridge.receive(bridgeResponse).application).toMatchObject({
      requestId: "request-connect",
      type: "session/connected",
    });

    extensionInput.end();
    await expect(running).resolves.toBeUndefined();
    expect(helper.closeCount).toBeGreaterThan(0);
  });

  it("rejects an unlisted caller before starting IPC", async () => {
    const extensionInput = new PassThrough();
    const extensionOutput = new PassThrough();
    const helper = new FakeClientHelper();
    const runtime = new NativeHostRuntime({
      allowedOrigins: [EXTENSION_ORIGIN],
      callerOrigin: `chrome-extension://${"a".repeat(32)}/`,
      createHelper: () => helper,
      extensionInput,
      extensionOutput,
      helperExecutable: "unused-by-test",
      implementationVersion: "0.1.0-test",
    });

    await expect(runtime.run()).rejects.toMatchObject({ code: "invalid_origin" });
    expect(helper.started).toBe(false);
    await expect(runtime.run()).rejects.toThrow(RangeError);
  });

  it("fails closed when the bridge sends a handshake before the extension is ready", async () => {
    const extensionInput = new PassThrough();
    const extensionOutput = new PassThrough();
    const helper = new FakeClientHelper();
    const runtime = createRuntime(extensionInput, extensionOutput, helper);

    const running = runtime.run();
    extensionInput.write(encodeFrame(createExtensionLink().start("request-extension-hello")));
    await waitUntil(() => helper.started);
    helper.signalConnected();
    helper.output.write(encodeFrame(createBridgeLink().start("request-bridge-hello")));

    extensionInput.write(
      encodeFrame(
        applicationFrame("session/connected", "request-too-early", {
          sessionId: "session-example",
        }),
      ),
    );
    await expect(running).rejects.toBeInstanceOf(Error);
    expect(helper.closeCount).toBeGreaterThan(0);
  });

  it("closes the Chrome boundary when the authenticated IPC client cannot connect", async () => {
    const extensionInput = new PassThrough();
    const extensionOutput = new PassThrough();
    const helper = new FakeClientHelper();
    const runtime = createRuntime(extensionInput, extensionOutput, helper);

    const running = runtime.run();
    extensionInput.write(encodeFrame(createExtensionLink().start("request-extension-hello")));
    await waitUntil(() => helper.started);
    helper.failConnected(new Error("synthetic connection failure"));

    await expect(running).rejects.toThrow("synthetic connection failure");
    expect(helper.closeCount).toBeGreaterThan(0);
  });

  it("cleans up when starting the authenticated IPC helper throws synchronously", async () => {
    const extensionInput = new PassThrough();
    const extensionOutput = new PassThrough();
    const helper = new FakeClientHelper();
    helper.startError = new Error("synthetic synchronous start failure");
    const runtime = createRuntime(extensionInput, extensionOutput, helper);

    const running = runtime.run();
    extensionInput.write(encodeFrame(createExtensionLink().start("request-extension-hello")));

    await expect(running).rejects.toThrow("synthetic synchronous start failure");
    expect(helper.closeCount).toBe(1);
    expect(helper.inputAccessCount).toBe(0);
    expect(helper.outputAccessCount).toBe(0);
  });

  it("does not hang or open bridge streams when the helper exits before connecting", async () => {
    const extensionInput = new PassThrough();
    const extensionOutput = new PassThrough();
    const helper = new FakeClientHelper();
    const runtime = createRuntime(extensionInput, extensionOutput, helper);

    const running = runtime.run();
    extensionInput.write(encodeFrame(createExtensionLink().start("request-extension-hello")));
    await waitUntil(() => helper.started);
    helper.signalExit();

    await expect(running).rejects.toMatchObject({ code: "transport_closed" });
    expect(helper.inputAccessCount).toBe(0);
    expect(helper.outputAccessCount).toBe(0);
    expect(helper.closeCount).toBeGreaterThan(0);
  });

  it("observes a rejected helper exit before connecting without an unhandled wait", async () => {
    const extensionInput = new PassThrough();
    const extensionOutput = new PassThrough();
    const helper = new FakeClientHelper();
    const runtime = createRuntime(extensionInput, extensionOutput, helper);

    const running = runtime.run();
    extensionInput.write(encodeFrame(createExtensionLink().start("request-extension-hello")));
    await waitUntil(() => helper.started);
    helper.failExit(new Error("synthetic early helper rejection"));

    await expect(running).rejects.toThrow("synthetic early helper rejection");
    expect(helper.inputAccessCount).toBe(0);
    expect(helper.outputAccessCount).toBe(0);
    expect(helper.closeCount).toBeGreaterThan(0);
  });

  it("rejects a truncated Chrome Native Messaging frame without opening IPC", async () => {
    const extensionInput = new PassThrough();
    const extensionOutput = new PassThrough();
    const helper = new FakeClientHelper();
    const runtime = createRuntime(extensionInput, extensionOutput, helper);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(5, 0);

    const running = runtime.run();
    extensionInput.end(Buffer.concat([header, Buffer.from("x")]));

    await expect(running).rejects.toMatchObject({ code: "truncated_frame" });
    expect(helper.started).toBe(false);
    runtime.close();
  });

  it("terminates the extension when the verified helper exits", async () => {
    const extensionInput = new PassThrough();
    const extensionOutput = new PassThrough();
    const helper = new FakeClientHelper();
    const runtime = createRuntime(extensionInput, extensionOutput, helper);

    const running = runtime.run();
    extensionInput.write(encodeFrame(createExtensionLink().start("request-extension-hello")));
    await waitUntil(() => helper.started);
    helper.signalConnected();
    await waitUntil(() => extensionOutput.readableLength > 0);
    helper.signalExit();

    await expect(running).rejects.toMatchObject({ code: "transport_closed" });
  });
});

class FakeClientHelper implements WindowsIpcClientHelper {
  readonly #input = new PassThrough();
  readonly #output = new PassThrough();
  public closeCount = 0;
  public inputAccessCount = 0;
  public outputAccessCount = 0;
  public startError: Error | undefined;
  public started = false;
  readonly #connected = createTestDeferred<undefined>();
  readonly #exit = createTestDeferred<WindowsIpcHelperExit>();

  public get input(): PassThrough {
    this.inputAccessCount += 1;
    return this.#input;
  }

  public get output(): PassThrough {
    this.outputAccessCount += 1;
    return this.#output;
  }

  public close(): void {
    this.closeCount += 1;
    this.#connected.reject(new Error("synthetic helper closed"));
    this.#exit.resolve({ code: null, signal: null });
    this.#input.destroy();
    this.#output.destroy();
  }

  public start(): Promise<WindowsIpcHelperExit> {
    this.started = true;
    if (this.startError !== undefined) {
      throw this.startError;
    }
    return this.#exit.promise;
  }

  public waitUntilConnected(): Promise<void> {
    return this.#connected.promise;
  }

  public signalConnected(): void {
    this.#connected.resolve(undefined);
  }

  public failConnected(error: Error): void {
    this.#connected.reject(error);
  }

  public signalExit(): void {
    this.#exit.resolve({ code: 70, signal: null });
  }

  public failExit(error: Error): void {
    this.#exit.reject(error);
  }
}

interface TestDeferred<Value> {
  readonly promise: Promise<Value>;
  readonly reject: (error: Error) => void;
  readonly resolve: (value: Value) => void;
}

function createTestDeferred<Value>(): TestDeferred<Value> {
  let rejectPromise: ((error: Error) => void) | undefined;
  let resolvePromise: ((value: Value) => void) | undefined;
  let settled = false;
  const promise = new Promise<Value>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    reject(error): void {
      if (!settled) {
        settled = true;
        rejectPromise?.(error);
      }
    },
    resolve(value): void {
      if (!settled) {
        settled = true;
        resolvePromise?.(value);
      }
    },
  };
}

class FrameReader {
  readonly #decoder = new NativeMessageDecoder({
    maxBufferedBytes: DEFAULT_NATIVE_MESSAGE_MAX_BUFFERED_BYTES,
    maxFrameBytes: DEFAULT_NATIVE_MESSAGE_MAX_FRAME_BYTES,
  });
  readonly #frames: NativeMessagingFrame[] = [];
  readonly #waiters: ((frame: NativeMessagingFrame) => void)[] = [];

  public constructor(stream: PassThrough) {
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
}

function createRuntime(
  extensionInput: PassThrough,
  extensionOutput: PassThrough,
  helper: FakeClientHelper,
): NativeHostRuntime {
  return new NativeHostRuntime({
    allowedOrigins: [EXTENSION_ORIGIN],
    callerOrigin: EXTENSION_ORIGIN,
    createHelper: () => helper,
    extensionInput,
    extensionOutput,
    helperExecutable: "unused-by-test",
    implementationVersion: "0.1.0-test",
  });
}

function createExtensionLink(): NativeLinkSession {
  return new NativeLinkSession({
    implementationVersion: "0.1.0-test",
    incomingApplicationTypes: BRIDGE_TO_EXTENSION_APPLICATION_TYPES,
    localPeer: "extension",
    mode: "initiator",
    outgoingApplicationTypes: EXTENSION_TO_BRIDGE_APPLICATION_TYPES,
    remotePeer: "nativeHost",
  });
}

function createBridgeLink(): NativeLinkSession {
  return new NativeLinkSession({
    implementationVersion: "0.1.0-test",
    incomingApplicationTypes: EXTENSION_TO_BRIDGE_APPLICATION_TYPES,
    localPeer: "bridge",
    mode: "initiator",
    outgoingApplicationTypes: BRIDGE_TO_EXTENSION_APPLICATION_TYPES,
    remotePeer: "nativeHost",
  });
}

function applicationFrame(
  type: NativeMessagingFrame["type"],
  requestId: string,
  payload: unknown,
): NativeMessagingFrame {
  return nativeMessagingFrameSchema.parse({
    payload,
    protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
    requestId,
    sequence: 0,
    type,
  });
}

function encodeFrame(frame: NativeMessagingFrame): Buffer {
  const payload = Buffer.from(JSON.stringify(frame), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error("Synthetic state did not settle");
}
