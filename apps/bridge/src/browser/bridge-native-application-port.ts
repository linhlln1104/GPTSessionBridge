import type { Readable, Writable } from "node:stream";

import {
  BRIDGE_TO_EXTENSION_APPLICATION_TYPES,
  EXTENSION_TO_BRIDGE_APPLICATION_TYPES,
  NativeLinkSession,
} from "@gpt-session-bridge/native-messaging/link";
import {
  DEFAULT_NATIVE_MESSAGE_MAX_BUFFERED_BYTES,
  DEFAULT_NATIVE_MESSAGE_MAX_FRAME_BYTES,
  DEFAULT_NATIVE_MESSAGE_MAX_QUEUED_BYTES,
  DEFAULT_NATIVE_MESSAGE_MAX_QUEUED_MESSAGES,
  NativeMessageDecoder,
  NativeMessageTransportError,
  NativeMessageWriter,
} from "@gpt-session-bridge/native-messaging/transport";
import {
  NATIVE_MESSAGING_PROTOCOL_VERSION,
  nativeMessagingFrameSchema,
  type NativeMessagingFrame,
} from "@gpt-session-bridge/protocol";

import type {
  BrowserApplicationMessage,
  BrowserApplicationPort,
  BrowserCommandType,
} from "./browser-application-port.js";

export interface BridgeNativeApplicationPortOptions {
  readonly handshakeTimeoutMs: number;
  readonly implementationVersion: string;
  readonly input: Readable;
  readonly onApplication: (frame: NativeMessagingFrame) => Promise<void>;
  readonly output: Writable;
}

export class BridgeNativeApplicationPort implements BrowserApplicationPort {
  readonly #decoder: NativeMessageDecoder;
  readonly #handshakeTimeoutMs: number;
  readonly #input: Readable;
  readonly #link: NativeLinkSession;
  readonly #onApplication: (frame: NativeMessagingFrame) => Promise<void>;
  readonly #output: Writable;
  readonly #writer: NativeMessageWriter;
  #closed = false;
  #completion: Promise<void> | undefined;
  #handshakeReject: ((error: Error) => void) | undefined;
  #handshakeResolve: (() => void) | undefined;

  public constructor(options: BridgeNativeApplicationPortOptions) {
    if (!Number.isSafeInteger(options.handshakeTimeoutMs) || options.handshakeTimeoutMs < 1) {
      throw new RangeError("Invalid bridge Native Messaging port options");
    }
    this.#decoder = new NativeMessageDecoder({
      maxBufferedBytes: DEFAULT_NATIVE_MESSAGE_MAX_BUFFERED_BYTES,
      maxFrameBytes: DEFAULT_NATIVE_MESSAGE_MAX_FRAME_BYTES,
    });
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs;
    this.#input = options.input;
    this.#link = new NativeLinkSession({
      implementationVersion: options.implementationVersion,
      incomingApplicationTypes: EXTENSION_TO_BRIDGE_APPLICATION_TYPES,
      localPeer: "bridge",
      mode: "initiator",
      outgoingApplicationTypes: BRIDGE_TO_EXTENSION_APPLICATION_TYPES,
      remotePeer: "nativeHost",
    });
    this.#onApplication = options.onApplication;
    this.#output = options.output;
    this.#writer = new NativeMessageWriter(options.output, {
      maxFrameBytes: DEFAULT_NATIVE_MESSAGE_MAX_FRAME_BYTES,
      maxQueuedBytes: DEFAULT_NATIVE_MESSAGE_MAX_QUEUED_BYTES,
      maxQueuedMessages: DEFAULT_NATIVE_MESSAGE_MAX_QUEUED_MESSAGES,
    });
  }

  public get completion(): Promise<void> {
    if (this.#completion === undefined) {
      throw new RangeError("The bridge Native Messaging port has not started");
    }
    return this.#completion;
  }

  public async start(challengeRequestId: string): Promise<void> {
    if (this.#completion !== undefined || this.#closed) {
      throw new RangeError("The bridge Native Messaging port cannot be started");
    }

    const handshake = new Promise<void>((resolve, reject) => {
      this.#handshakeResolve = resolve;
      this.#handshakeReject = reject;
    });
    void handshake.catch(() => undefined);
    this.#completion = this.#readLoop();
    void this.#completion.catch(() => undefined);

    try {
      await this.#writer.write(this.#link.start(challengeRequestId));
      await withTimeout(handshake, this.#handshakeTimeoutMs);
    } catch (error) {
      this.close();
      throw error;
    } finally {
      this.#handshakeResolve = undefined;
      this.#handshakeReject = undefined;
    }
  }

  public send<Type extends BrowserCommandType>(
    message: BrowserApplicationMessage<Type>,
  ): Promise<void> {
    if (this.#closed || this.#link.state !== "ready") {
      return Promise.reject(new NativeMessageTransportError("transport_closed"));
    }
    try {
      const frame = nativeMessagingFrameSchema.parse({
        ...message,
        protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
        sequence: 0,
      });
      return this.#writer.write(this.#link.sendApplication(frame));
    } catch (error) {
      this.close();
      return Promise.reject(normalizeError(error));
    }
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#link.close();
    this.#writer.close();
    this.#handshakeReject?.(new NativeMessageTransportError("transport_closed"));
    this.#input.destroy();
    this.#output.destroy();
  }

  async #readLoop(): Promise<void> {
    try {
      for await (const chunk of this.#input) {
        const bytes = normalizeChunk(chunk);
        for (const frame of this.#decoder.push(bytes)) {
          const previousState = this.#link.state;
          const result = this.#link.receive(frame);
          if (result.response !== undefined) {
            await this.#writer.write(result.response);
          }
          if (previousState === "awaitingAcknowledgement" && this.#link.state === "ready") {
            this.#handshakeResolve?.();
          }
          if (result.application !== undefined) {
            await this.#onApplication(result.application);
          }
        }
      }
      if (!this.#closed) {
        this.#decoder.finish();
        throw new NativeMessageTransportError("transport_closed");
      }
    } catch (error) {
      if (!this.#closed) {
        this.#handshakeReject?.(normalizeError(error));
        this.close();
        throw error;
      }
    }
  }
}

function normalizeChunk(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  throw new NativeMessageTransportError("invalid_frame");
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new NativeMessageTransportError("transport_closed");
}

function withTimeout<Value>(promise: Promise<Value>, timeoutMs: number): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new NativeMessageTransportError("transport_closed"));
    }, timeoutMs);
    timeout.unref();
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(normalizeError(error));
      },
    );
  });
}
