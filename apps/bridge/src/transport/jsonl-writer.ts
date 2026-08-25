import type { Writable } from "node:stream";

import { appServerEnvelopeSchema, type AppServerEnvelope } from "@gpt-session-bridge/protocol";

import { AppServerTransportError } from "./errors.js";

export interface JsonLineWriterOptions {
  readonly maxFrameBytes: number;
  readonly maxQueuedBytes: number;
  readonly maxQueuedMessages: number;
}

interface PendingWrite {
  readonly bytes: number;
  readonly frame: Buffer;
  readonly reject: (error: AppServerTransportError) => void;
  readonly resolve: () => void;
  settled: boolean;
}

export class AppServerJsonLineWriter {
  readonly #maxFrameBytes: number;
  readonly #maxQueuedBytes: number;
  readonly #maxQueuedMessages: number;
  readonly #stream: Writable;
  readonly #onClose = (): void => {
    this.#fail("transport_closed");
  };
  readonly #onError = (): void => {
    this.#fail("write_failed");
  };
  #activeReject: ((error: AppServerTransportError) => void) | undefined;
  #failed: AppServerTransportError | undefined;
  #pumping = false;
  #queue: PendingWrite[] = [];
  #queuedBytes = 0;

  public constructor(stream: Writable, options: JsonLineWriterOptions) {
    if (
      !Number.isSafeInteger(options.maxFrameBytes) ||
      options.maxFrameBytes < 1 ||
      !Number.isSafeInteger(options.maxQueuedBytes) ||
      options.maxQueuedBytes <= options.maxFrameBytes ||
      !Number.isSafeInteger(options.maxQueuedMessages) ||
      options.maxQueuedMessages < 1
    ) {
      throw new RangeError("Invalid writer limits");
    }
    this.#stream = stream;
    this.#maxFrameBytes = options.maxFrameBytes;
    this.#maxQueuedBytes = options.maxQueuedBytes;
    this.#maxQueuedMessages = options.maxQueuedMessages;
    stream.once("close", this.#onClose);
    stream.on("error", this.#onError);
  }

  public write(envelope: AppServerEnvelope): Promise<void> {
    if (this.#failed !== undefined || this.#stream.destroyed) {
      return Promise.reject(this.#failed ?? new AppServerTransportError("transport_closed"));
    }

    let frame: Buffer;
    try {
      const parsed = appServerEnvelopeSchema.parse(envelope);
      frame = Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8");
    } catch {
      return Promise.reject(new AppServerTransportError("invalid_frame"));
    }
    if (frame.byteLength - 1 > this.#maxFrameBytes) {
      return Promise.reject(new AppServerTransportError("frame_too_large"));
    }
    if (
      this.#queue.length >= this.#maxQueuedMessages ||
      this.#queuedBytes + frame.byteLength > this.#maxQueuedBytes
    ) {
      return Promise.reject(new AppServerTransportError("queue_overflow"));
    }

    const promise = new Promise<void>((resolve, reject) => {
      this.#queue.push({
        bytes: frame.byteLength,
        frame,
        reject,
        resolve,
        settled: false,
      });
      this.#queuedBytes += frame.byteLength;
    });
    void this.#pump();
    return promise;
  }

  public close(): void {
    this.#fail("transport_closed");
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
      this.#fail("write_failed");
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
      const fail = (error: AppServerTransportError): void => {
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
          fail(new AppServerTransportError("write_failed"));
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

  #fail(code: "transport_closed" | "write_failed"): void {
    if (this.#failed !== undefined) {
      return;
    }
    const error = new AppServerTransportError(code);
    this.#failed = error;
    this.#activeReject?.(error);
    for (const pending of this.#queue) {
      this.#settleFailure(pending, error);
    }
    this.#queue = [];
    this.#stream.off("close", this.#onClose);
  }

  #settleSuccess(pending: PendingWrite): void {
    if (pending.settled) {
      return;
    }
    pending.settled = true;
    this.#queuedBytes -= pending.bytes;
    pending.resolve();
  }

  #settleFailure(pending: PendingWrite, error: AppServerTransportError): void {
    if (pending.settled) {
      return;
    }
    pending.settled = true;
    this.#queuedBytes -= pending.bytes;
    pending.reject(error);
  }
}
