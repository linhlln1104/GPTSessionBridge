import type { Writable } from "node:stream";

import {
  nativeMessagingFrameSchema,
  type NativeMessagingFrame,
} from "@gpt-session-bridge/protocol";

import {
  DEFAULT_NATIVE_MESSAGE_MAX_FRAME_BYTES,
  DEFAULT_NATIVE_MESSAGE_MAX_QUEUED_BYTES,
  DEFAULT_NATIVE_MESSAGE_MAX_QUEUED_MESSAGES,
  NATIVE_MESSAGE_HEADER_BYTES,
} from "../constants.js";
import { NativeMessageTransportError, type NativeMessageTransportErrorCode } from "./errors.js";

export interface NativeMessageWriterOptions {
  readonly maxFrameBytes: number;
  readonly maxQueuedBytes: number;
  readonly maxQueuedMessages: number;
}

interface PendingWrite {
  readonly bytes: number;
  readonly frame: Buffer;
  readonly reject: (error: NativeMessageTransportError) => void;
  readonly resolve: () => void;
  settled: boolean;
}

export class NativeMessageWriter {
  readonly #maxFrameBytes: number;
  readonly #maxQueuedBytes: number;
  readonly #maxQueuedMessages: number;
  readonly #stream: Writable;
  readonly #onClose = (): void => {
    this.#poison("transport_closed");
  };
  readonly #onError = (): void => {
    this.#poison("write_failed");
  };
  #activeReject: ((error: NativeMessageTransportError) => void) | undefined;
  #failed: NativeMessageTransportError | undefined;
  #pumping = false;
  #queue: PendingWrite[] = [];
  #queuedBytes = 0;

  public constructor(stream: Writable, options: NativeMessageWriterOptions) {
    if (
      !Number.isSafeInteger(options.maxFrameBytes) ||
      options.maxFrameBytes < 1 ||
      options.maxFrameBytes > DEFAULT_NATIVE_MESSAGE_MAX_FRAME_BYTES ||
      !Number.isSafeInteger(options.maxQueuedBytes) ||
      options.maxQueuedBytes <= options.maxFrameBytes + NATIVE_MESSAGE_HEADER_BYTES ||
      options.maxQueuedBytes > DEFAULT_NATIVE_MESSAGE_MAX_QUEUED_BYTES ||
      !Number.isSafeInteger(options.maxQueuedMessages) ||
      options.maxQueuedMessages < 1 ||
      options.maxQueuedMessages > DEFAULT_NATIVE_MESSAGE_MAX_QUEUED_MESSAGES
    ) {
      throw new RangeError("Invalid Native Messaging writer limits");
    }
    this.#stream = stream;
    this.#maxFrameBytes = options.maxFrameBytes;
    this.#maxQueuedBytes = options.maxQueuedBytes;
    this.#maxQueuedMessages = options.maxQueuedMessages;
    stream.once("close", this.#onClose);
    stream.on("error", this.#onError);
  }

  public write(frame: NativeMessagingFrame): Promise<void> {
    if (this.#failed !== undefined || this.#stream.destroyed) {
      return Promise.reject(this.#failed ?? new NativeMessageTransportError("transport_closed"));
    }

    let encoded: Buffer;
    try {
      const parsed = nativeMessagingFrameSchema.parse(frame);
      const payload = Buffer.from(JSON.stringify(parsed), "utf8");
      if (payload.byteLength > this.#maxFrameBytes) {
        return Promise.reject(this.#poison("frame_too_large"));
      }
      const header = Buffer.allocUnsafe(NATIVE_MESSAGE_HEADER_BYTES);
      header.writeUInt32LE(payload.byteLength, 0);
      encoded = Buffer.concat([header, payload], header.byteLength + payload.byteLength);
    } catch {
      return Promise.reject(this.#poison("invalid_frame"));
    }

    if (
      this.#queue.length >= this.#maxQueuedMessages ||
      this.#queuedBytes + encoded.byteLength > this.#maxQueuedBytes
    ) {
      return Promise.reject(this.#poison("queue_overflow"));
    }

    const promise = new Promise<void>((resolve, reject) => {
      this.#queue.push({
        bytes: encoded.byteLength,
        frame: encoded,
        reject,
        resolve,
        settled: false,
      });
      this.#queuedBytes += encoded.byteLength;
    });
    void this.#pump();
    return promise;
  }

  public close(): void {
    this.#poison("transport_closed");
  }

  async #pump(): Promise<void> {
    if (this.#pumping || this.#failed !== undefined) {
      return;
    }
    this.#pumping = true;

    try {
      while (this.#queue.length > 0) {
        const pending = this.#queue[0];
        if (pending === undefined) {
          break;
        }
        await this.#writeFrame(pending.frame);
        this.#settleSuccess(pending);
        this.#queue.shift();
      }
    } catch {
      this.#poison("write_failed");
    } finally {
      this.#activeReject = undefined;
      this.#pumping = false;
    }
  }

  #writeFrame(frame: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let callbackComplete = false;
      let drainComplete = false;
      let settled = false;

      const cleanup = (): void => {
        this.#stream.off("drain", onDrain);
        this.#activeReject = undefined;
      };
      const complete = (): void => {
        if (!settled && callbackComplete && drainComplete) {
          settled = true;
          cleanup();
          resolve();
        }
      };
      const fail = (error: NativeMessageTransportError): void => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      };
      const onDrain = (): void => {
        drainComplete = true;
        complete();
      };

      this.#activeReject = fail;
      const accepted = this.#stream.write(frame, (error: Error | null | undefined) => {
        if (error !== undefined && error !== null) {
          fail(new NativeMessageTransportError("write_failed"));
          return;
        }
        callbackComplete = true;
        complete();
      });
      drainComplete = accepted;
      if (!accepted) {
        this.#stream.once("drain", onDrain);
      }
      complete();
    });
  }

  #poison(code: NativeMessageTransportErrorCode): NativeMessageTransportError {
    if (this.#failed !== undefined) {
      return this.#failed;
    }
    const error = new NativeMessageTransportError(code);
    this.#failed = error;
    this.#activeReject?.(error);
    for (const pending of this.#queue) {
      this.#settleFailure(pending, error);
    }
    this.#queue = [];
    this.#stream.off("close", this.#onClose);
    return error;
  }

  #settleSuccess(pending: PendingWrite): void {
    if (pending.settled) {
      return;
    }
    pending.settled = true;
    this.#queuedBytes -= pending.bytes;
    pending.resolve();
  }

  #settleFailure(pending: PendingWrite, error: NativeMessageTransportError): void {
    if (pending.settled) {
      return;
    }
    pending.settled = true;
    this.#queuedBytes -= pending.bytes;
    pending.reject(error);
  }
}
