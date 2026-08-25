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
  WindowsIpcHelperError,
  type WindowsIpcHelperExit,
} from "@gpt-session-bridge/native-messaging/transport";
import {
  NATIVE_MESSAGING_PROTOCOL_VERSION,
  nativeMessagingFrameSchema,
  type NativeMessagingFrame,
} from "@gpt-session-bridge/protocol";
import { describe, expect, it } from "vitest";

import { BrowserSessionCoordinator } from "../src/browser/browser-session-coordinator.js";
import {
  WindowsBrowserIpcBroker,
  type WindowsIpcServerHelper,
} from "../src/runtime/windows-browser-ipc-broker.js";

describe("WindowsBrowserIpcBroker", () => {
  it("owns a listener, authenticates a fresh link, and establishes coordinator state", async () => {
    const helper = new FakeServerHelper();
    const coordinator = new BrowserSessionCoordinator();
    const broker = new WindowsBrowserIpcBroker({
      coordinator,
      createChallenge: () => "request-fresh-pipe",
      createHelper: () => helper,
      helperExecutable: "unused-by-test",
      implementationVersion: "0.1.0-test",
      reconnectDelay: () => Promise.resolve(),
    });

    const listening = broker.start();
    expect(() => broker.start()).toThrow(RangeError);
    helper.signalListening();
    await expect(listening).resolves.toBeUndefined();
    expect(broker.state).toBe("listening");

    const outgoing = new FrameReader(helper.input);
    const host = createHostBridgeLink();
    helper.signalConnected();
    const hello = await outgoing.next();
    expect(hello.requestId).toBe("request-fresh-pipe");
    helper.output.write(encodeFrame(requireResponse(host.receive(hello).response)));

    const connect = await outgoing.next();
    expect(host.receive(connect).application?.type).toBe("session/connect");
    const sessionId = readPayloadString(connect, "sessionId");
    helper.output.write(
      encodeFrame(
        host.sendApplication(
          applicationFrame("session/connected", connect.requestId, { sessionId }),
        ),
      ),
    );

    const capabilitiesRead = await outgoing.next();
    expect(host.receive(capabilitiesRead).application?.type).toBe("capabilities/read");
    helper.output.write(
      encodeFrame(
        host.sendApplication(
          applicationFrame("capabilities/result", capabilitiesRead.requestId, {
            capabilities: unavailableCapabilities(),
            sessionId,
          }),
        ),
      ),
    );

    await waitUntil(() => broker.state === "ready");
    expect(coordinator.snapshot).toMatchObject({
      capabilities: { catalogRevision: "adapter-unavailable-v1", modelDiscovery: false },
      sessionId,
    });

    await broker.close();
    await expect(broker.completion).resolves.toBeUndefined();
    expect(broker.state).toBe("closed");
    expect(helper.closeCount).toBeGreaterThan(0);
  });

  it("recycles the authenticated connection when the browser session ends", async () => {
    const first = new FakeServerHelper();
    const second = new FakeServerHelper();
    const helpers = [first, second];
    let factoryCalls = 0;
    const coordinator = new BrowserSessionCoordinator();
    const broker = new WindowsBrowserIpcBroker({
      coordinator,
      createChallenge: () => `request-pipe-${String(factoryCalls)}`,
      createHelper: () => {
        const helper = helpers[factoryCalls];
        factoryCalls += 1;
        if (helper === undefined) {
          throw new Error("unexpected helper request");
        }
        return helper;
      },
      helperExecutable: "unused-by-test",
      implementationVersion: "0.1.0-test",
      reconnectDelay: () => Promise.resolve(),
    });

    const listening = broker.start();
    first.signalListening();
    await listening;
    const outgoing = new FrameReader(first.input);
    const host = createHostBridgeLink();
    first.signalConnected();
    const hello = await outgoing.next();
    first.output.write(encodeFrame(requireResponse(host.receive(hello).response)));
    const connect = await outgoing.next();
    expect(host.receive(connect).application?.type).toBe("session/connect");
    const sessionId = readPayloadString(connect, "sessionId");
    first.output.write(
      encodeFrame(
        host.sendApplication(
          applicationFrame("session/connected", connect.requestId, { sessionId }),
        ),
      ),
    );
    const capabilitiesRead = await outgoing.next();
    expect(host.receive(capabilitiesRead).application?.type).toBe("capabilities/read");
    first.output.write(
      encodeFrame(
        host.sendApplication(
          applicationFrame("capabilities/result", capabilitiesRead.requestId, {
            capabilities: unavailableCapabilities(),
            sessionId,
          }),
        ),
      ),
    );
    await waitUntil(() => broker.state === "ready");

    first.output.write(
      encodeFrame(
        host.sendApplication(
          applicationFrame("session/disconnected", "event-session-ended", {
            reason: "pageUnavailable",
            sessionId,
          }),
        ),
      ),
    );
    await waitUntil(() => factoryCalls === 2);
    expect(first.closeCount).toBeGreaterThan(0);
    expect(second.started).toBe(true);
    expect(coordinator.state).toEqual({ session: "disconnected", transport: "detached" });
    second.signalListening();

    await broker.close();
    await expect(broker.completion).resolves.toBeUndefined();
  });

  it("respawns an unconnected listener serially after its bounded accept timeout", async () => {
    const first = new FakeServerHelper();
    const second = new FakeServerHelper();
    const helpers = [first, second];
    let factoryCalls = 0;
    const broker = new WindowsBrowserIpcBroker({
      coordinator: new BrowserSessionCoordinator(),
      createHelper: () => {
        const helper = helpers[factoryCalls];
        factoryCalls += 1;
        if (helper === undefined) {
          throw new Error("unexpected helper request");
        }
        return helper;
      },
      helperExecutable: "unused-by-test",
      implementationVersion: "0.1.0-test",
      reconnectDelay: () => Promise.resolve(),
    });

    const listening = broker.start();
    first.signalListening();
    await listening;
    first.failConnected(new WindowsIpcHelperError("native_failure", "connection_timeout"));
    await waitUntil(() => factoryCalls === 2);
    expect(first.closeCount).toBeGreaterThan(0);
    expect(second.started).toBe(true);
    second.signalListening();

    await broker.close();
    await expect(broker.completion).resolves.toBeUndefined();
  });

  it("fails startup when first-instance ownership cannot be established", async () => {
    const helper = new FakeServerHelper();
    const coordinator = new BrowserSessionCoordinator();
    const broker = new WindowsBrowserIpcBroker({
      coordinator,
      createHelper: () => helper,
      helperExecutable: "unused-by-test",
      implementationVersion: "0.1.0-test",
    });

    const listening = broker.start();
    helper.failListening(new WindowsIpcHelperError("native_failure", "pipe_unavailable"));
    await expect(listening).rejects.toMatchObject({ nativeCode: "pipe_unavailable" });
    await expect(broker.completion).rejects.toMatchObject({ nativeCode: "pipe_unavailable" });
    expect(broker.state).toBe("failed");
    expect(coordinator.state).toEqual({ session: "closed", transport: "closed" });
    await broker.close();
  });

  it("cleans up a helper that throws synchronously during start", async () => {
    const helper = new FakeServerHelper();
    helper.startError = new Error("synthetic synchronous start failure");
    const broker = new WindowsBrowserIpcBroker({
      coordinator: new BrowserSessionCoordinator(),
      createHelper: () => helper,
      helperExecutable: "unused-by-test",
      implementationVersion: "0.1.0-test",
    });

    const listening = broker.start();
    await expect(listening).rejects.toThrow("synthetic synchronous start failure");
    await expect(broker.completion).rejects.toThrow("synthetic synchronous start failure");
    expect(helper.closeCount).toBeGreaterThan(0);
    expect(broker.state).toBe("failed");
    await broker.close();
  });

  it("observes a rejected helper lifecycle before the listening status", async () => {
    const helper = new FakeServerHelper();
    const broker = new WindowsBrowserIpcBroker({
      coordinator: new BrowserSessionCoordinator(),
      createHelper: () => helper,
      helperExecutable: "unused-by-test",
      implementationVersion: "0.1.0-test",
    });

    const listening = broker.start();
    helper.failExit(new Error("synthetic helper lifecycle rejection"));
    await expect(listening).rejects.toThrow("synthetic helper lifecycle rejection");
    await expect(broker.completion).rejects.toThrow("synthetic helper lifecycle rejection");
    expect(helper.closeCount).toBeGreaterThan(0);
    expect(broker.state).toBe("failed");
    await broker.close();
  });

  it("observes a helper exit before the listening status", async () => {
    const helper = new FakeServerHelper();
    const broker = new WindowsBrowserIpcBroker({
      coordinator: new BrowserSessionCoordinator(),
      createHelper: () => helper,
      helperExecutable: "unused-by-test",
      implementationVersion: "0.1.0-test",
    });

    const listening = broker.start();
    helper.signalExit();
    await expect(listening).rejects.toThrow("windows_ipc_helper_exited");
    await expect(broker.completion).rejects.toThrow("windows_ipc_helper_exited");
    expect(helper.closeCount).toBeGreaterThan(0);
    expect(broker.state).toBe("failed");
    await broker.close();
  });

  it("validates lifecycle and constructor limits", async () => {
    const coordinator = new BrowserSessionCoordinator();
    expect(
      () =>
        new WindowsBrowserIpcBroker({
          coordinator,
          handshakeTimeoutMs: 0,
          helperExecutable: "unused-by-test",
          implementationVersion: "0.1.0-test",
        }),
    ).toThrow(RangeError);

    const broker = new WindowsBrowserIpcBroker({
      coordinator,
      createHelper: () => new FakeServerHelper(),
      helperExecutable: "unused-by-test",
      implementationVersion: "0.1.0-test",
    });
    expect(() => broker.completion).toThrow(RangeError);
    await broker.close();
    expect(() => broker.start()).toThrow(RangeError);
  });
});

class FakeServerHelper implements WindowsIpcServerHelper {
  public readonly input = new PassThrough();
  public readonly output = new PassThrough();
  public closeCount = 0;
  public startError: Error | undefined = undefined;
  public started = false;
  readonly #connected = createTestDeferred<undefined>();
  readonly #exit = createTestDeferred<WindowsIpcHelperExit>();
  readonly #listening = createTestDeferred<undefined>();

  public close(): void {
    this.closeCount += 1;
    this.#connected.reject(new Error("synthetic helper closed"));
    this.#listening.reject(new Error("synthetic helper closed"));
    this.#exit.resolve({ code: null, signal: null });
    this.input.destroy();
    this.output.destroy();
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

  public waitUntilListening(): Promise<void> {
    return this.#listening.promise;
  }

  public signalConnected(): void {
    this.#connected.resolve(undefined);
  }

  public signalListening(): void {
    this.#listening.resolve(undefined);
  }

  public signalExit(): void {
    this.#exit.resolve({ code: 1, signal: null });
  }

  public failConnected(error: Error): void {
    this.#connected.reject(error);
  }

  public failListening(error: Error): void {
    this.#listening.reject(error);
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

function unavailableCapabilities() {
  return {
    cancellation: false,
    catalogRevision: "adapter-unavailable-v1",
    imageInput: false,
    modelDiscovery: false,
    models: [],
    streaming: false,
    temporaryChat: false,
    toolCalls: false,
  } as const;
}

function encodeFrame(frame: NativeMessagingFrame): Buffer {
  const payload = Buffer.from(JSON.stringify(frame), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

function requireResponse(frame: NativeMessagingFrame | undefined): NativeMessagingFrame {
  if (frame === undefined) {
    throw new Error("Missing synthetic response frame");
  }
  return frame;
}

function readPayloadString(frame: NativeMessagingFrame, key: string): string {
  const payload = frame.payload as Readonly<Record<string, unknown>>;
  const value = payload[key];
  if (typeof value !== "string") {
    throw new Error(`Missing synthetic ${key}`);
  }
  return value;
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
