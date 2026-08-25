import type { Readable, Writable } from "node:stream";

import {
  DEFAULT_NATIVE_MESSAGE_MAX_BUFFERED_BYTES,
  DEFAULT_NATIVE_MESSAGE_MAX_FRAME_BYTES,
  DEFAULT_NATIVE_MESSAGE_MAX_QUEUED_BYTES,
  DEFAULT_NATIVE_MESSAGE_MAX_QUEUED_MESSAGES,
  NativeMessageDecoder,
  NativeMessageTransportError,
  NativeMessageWriter,
  WindowsIpcHelperProcess,
  type WindowsIpcHelperExit,
} from "@gpt-session-bridge/native-messaging/transport";
import type { NativeMessagingFrame } from "@gpt-session-bridge/protocol";

import { NativeHostRelay } from "../protocol/native-host-relay.js";
import { validateExtensionOrigin } from "./extension-origin.js";

export interface WindowsIpcClientHelper {
  readonly input: Writable;
  readonly output: Readable;
  close(): void;
  start(): Promise<WindowsIpcHelperExit>;
  waitUntilConnected(): Promise<void>;
}

export interface NativeHostRuntimeOptions {
  readonly allowedOrigins: readonly string[];
  readonly callerOrigin: unknown;
  readonly createHelper?: () => WindowsIpcClientHelper;
  readonly extensionInput: Readable;
  readonly extensionOutput: Writable;
  readonly helperExecutable: string;
  readonly implementationVersion: string;
}

/**
 * Terminates Chrome and bridge transports independently. The Windows helper is
 * started only after the exact-origin extension link completes its handshake.
 */
export class NativeHostRuntime {
  readonly #allowedOrigins: readonly string[];
  readonly #callerOrigin: unknown;
  readonly #createHelper: () => WindowsIpcClientHelper;
  readonly #extensionDecoder: NativeMessageDecoder;
  readonly #extensionInput: Readable;
  readonly #extensionOutput: Writable;
  readonly #extensionWriter: NativeMessageWriter;
  readonly #relay: NativeHostRelay;
  #bridgeDecoder: NativeMessageDecoder | undefined;
  #bridgeTask: Promise<void> | undefined;
  #bridgeWriter: NativeMessageWriter | undefined;
  #closed = false;
  #failure: Error | undefined;
  #helper: WindowsIpcClientHelper | undefined;
  #helperExit: Promise<WindowsIpcHelperExit> | undefined;
  #started = false;

  public constructor(options: NativeHostRuntimeOptions) {
    this.#allowedOrigins = options.allowedOrigins;
    this.#callerOrigin = options.callerOrigin;
    this.#createHelper =
      options.createHelper ??
      (() =>
        new WindowsIpcHelperProcess({
          executable: options.helperExecutable,
          role: "client",
        }));
    this.#extensionDecoder = new NativeMessageDecoder({
      maxBufferedBytes: DEFAULT_NATIVE_MESSAGE_MAX_BUFFERED_BYTES,
      maxFrameBytes: DEFAULT_NATIVE_MESSAGE_MAX_FRAME_BYTES,
    });
    this.#extensionInput = options.extensionInput;
    this.#extensionOutput = options.extensionOutput;
    this.#extensionWriter = new NativeMessageWriter(options.extensionOutput, writerOptions());
    this.#relay = new NativeHostRelay({ implementationVersion: options.implementationVersion });
  }

  public async run(): Promise<void> {
    if (this.#started || this.#closed) {
      throw new RangeError("The Native Messaging host runtime cannot be started");
    }
    this.#started = true;

    try {
      validateExtensionOrigin(this.#callerOrigin, this.#allowedOrigins);
      for await (const chunk of this.#extensionInput) {
        for (const frame of this.#extensionDecoder.push(normalizeChunk(chunk))) {
          await this.#receiveFromExtension(frame);
        }
      }
      if (!this.#isClosed()) {
        this.#extensionDecoder.finish();
      }
    } catch (error) {
      if (!this.#isClosed()) {
        this.#failure = normalizeError(error);
      }
    } finally {
      this.close();
      await this.#bridgeTask?.catch(() => undefined);
      await this.#helperExit?.catch(() => undefined);
    }

    if (this.#failure !== undefined) {
      throw this.#failure;
    }
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#relay.close();
    this.#bridgeWriter?.close();
    this.#extensionWriter.close();
    this.#helper?.close();
    this.#extensionInput.destroy();
    this.#extensionOutput.destroy();
  }

  async #receiveFromExtension(frame: NativeMessagingFrame): Promise<void> {
    const previousState = this.#relay.state.extension;
    const result = this.#relay.receiveFromExtension(frame);
    if (result.toExtension !== undefined) {
      await this.#extensionWriter.write(result.toExtension);
    }
    if (previousState !== "ready" && this.#relay.state.extension === "ready") {
      await this.#openBridge();
    }
    if (result.toBridge !== undefined) {
      const writer = this.#bridgeWriter;
      if (writer === undefined) {
        throw new NativeMessageTransportError("transport_closed");
      }
      await writer.write(result.toBridge);
    }
  }

  async #openBridge(): Promise<void> {
    if (this.#helper !== undefined || this.#isClosed()) {
      throw new NativeMessageTransportError("transport_closed");
    }
    const helper = this.#createHelper();
    this.#helper = helper;
    let helperExit: Promise<WindowsIpcHelperExit>;
    try {
      helperExit = helper.start();
    } catch (error) {
      try {
        helper.close();
      } finally {
        if (this.#helper === helper) {
          this.#helper = undefined;
        }
      }
      throw error;
    }
    this.#helperExit = helperExit;
    let helperTerminated = false;
    const hasHelperTerminated = (): boolean => helperTerminated;
    const helperFailure = helperExit.then<never>(
      () => {
        helperTerminated = true;
        throw new NativeMessageTransportError("transport_closed");
      },
      (error: unknown) => {
        helperTerminated = true;
        throw normalizeError(error);
      },
    );
    void helperFailure.catch((error: unknown) => {
      if (!this.#closed) {
        this.#failure = normalizeError(error);
        this.close();
      }
    });

    await Promise.race([helper.waitUntilConnected(), helperFailure]);
    if (this.#isClosed() || hasHelperTerminated() || this.#helper !== helper) {
      throw new NativeMessageTransportError("transport_closed");
    }

    this.#bridgeDecoder = new NativeMessageDecoder({
      maxBufferedBytes: DEFAULT_NATIVE_MESSAGE_MAX_BUFFERED_BYTES,
      maxFrameBytes: DEFAULT_NATIVE_MESSAGE_MAX_FRAME_BYTES,
    });
    this.#bridgeWriter = new NativeMessageWriter(helper.input, writerOptions());
    const bridgeTask = this.#readBridge(helper.output);
    this.#bridgeTask = bridgeTask;
    void bridgeTask.catch((error: unknown) => {
      if (!this.#closed) {
        this.#failure = normalizeError(error);
        this.close();
      }
    });
  }

  async #readBridge(input: Readable): Promise<void> {
    const decoder = this.#bridgeDecoder;
    if (decoder === undefined) {
      throw new NativeMessageTransportError("transport_closed");
    }
    for await (const chunk of input) {
      for (const frame of decoder.push(normalizeChunk(chunk))) {
        const result = this.#relay.receiveFromBridge(frame);
        if (result.toBridge !== undefined) {
          const writer = this.#bridgeWriter;
          if (writer === undefined) {
            throw new NativeMessageTransportError("transport_closed");
          }
          await writer.write(result.toBridge);
        }
        if (result.toExtension !== undefined) {
          await this.#extensionWriter.write(result.toExtension);
        }
      }
    }
    if (!this.#closed) {
      decoder.finish();
      throw new NativeMessageTransportError("transport_closed");
    }
  }

  #isClosed(): boolean {
    return this.#closed;
  }
}

function writerOptions() {
  return {
    maxFrameBytes: DEFAULT_NATIVE_MESSAGE_MAX_FRAME_BYTES,
    maxQueuedBytes: DEFAULT_NATIVE_MESSAGE_MAX_QUEUED_BYTES,
    maxQueuedMessages: DEFAULT_NATIVE_MESSAGE_MAX_QUEUED_MESSAGES,
  } as const;
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
