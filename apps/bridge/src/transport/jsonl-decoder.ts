import { TextDecoder } from "node:util";

import { appServerEnvelopeSchema, type AppServerEnvelope } from "@gpt-session-bridge/protocol";

import { AppServerTransportError } from "./errors.js";

const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

export interface JsonLineDecoderOptions {
  readonly maxBufferedBytes: number;
  readonly maxFrameBytes: number;
}

export class AppServerJsonLineDecoder {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #maxBufferedBytes: number;
  readonly #maxFrameBytes: number;
  #failed = false;
  #pending: Buffer[] = [];
  #pendingBytes = 0;

  public constructor(options: JsonLineDecoderOptions) {
    if (
      !Number.isSafeInteger(options.maxFrameBytes) ||
      options.maxFrameBytes < 1 ||
      !Number.isSafeInteger(options.maxBufferedBytes) ||
      options.maxBufferedBytes < options.maxFrameBytes
    ) {
      throw new RangeError("Invalid JSONL limits");
    }
    this.#maxBufferedBytes = options.maxBufferedBytes;
    this.#maxFrameBytes = options.maxFrameBytes;
  }

  public push(chunk: Uint8Array | string): readonly AppServerEnvelope[] {
    this.#assertOpen();
    const input = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    const messages: AppServerEnvelope[] = [];
    let segmentStart = 0;

    try {
      for (let index = 0; index < input.byteLength; index += 1) {
        if (input[index] !== LINE_FEED) {
          continue;
        }
        this.#append(input.subarray(segmentStart, index));
        const message = this.#consumeLine();
        if (message !== undefined) {
          messages.push(message);
        }
        segmentStart = index + 1;
      }
      this.#append(input.subarray(segmentStart));
      return messages;
    } catch (error) {
      this.#failed = true;
      this.#pending = [];
      this.#pendingBytes = 0;
      if (error instanceof AppServerTransportError) {
        throw error;
      }
      throw new AppServerTransportError("invalid_frame");
    }
  }

  public finish(): readonly AppServerEnvelope[] {
    this.#assertOpen();
    if (this.#pendingBytes === 0) {
      return [];
    }

    try {
      const message = this.#consumeLine();
      return message === undefined ? [] : [message];
    } catch (error) {
      this.#failed = true;
      this.#pending = [];
      this.#pendingBytes = 0;
      if (error instanceof AppServerTransportError) {
        throw error;
      }
      throw new AppServerTransportError("invalid_frame");
    }
  }

  #append(segment: Buffer): void {
    if (segment.byteLength === 0) {
      return;
    }
    const nextBytes = this.#pendingBytes + segment.byteLength;
    if (nextBytes > this.#maxFrameBytes) {
      throw new AppServerTransportError("frame_too_large");
    }
    if (nextBytes > this.#maxBufferedBytes) {
      throw new AppServerTransportError("buffer_overflow");
    }
    this.#pending.push(segment);
    this.#pendingBytes = nextBytes;
  }

  #consumeLine(): AppServerEnvelope | undefined {
    let line = Buffer.concat(this.#pending, this.#pendingBytes);
    this.#pending = [];
    this.#pendingBytes = 0;

    if (line.at(-1) === CARRIAGE_RETURN) {
      line = line.subarray(0, -1);
    }
    if (line.byteLength === 0) {
      return undefined;
    }

    try {
      const value: unknown = JSON.parse(this.#decoder.decode(line));
      return appServerEnvelopeSchema.parse(value);
    } catch {
      throw new AppServerTransportError("invalid_frame");
    }
  }

  #assertOpen(): void {
    if (this.#failed) {
      throw new AppServerTransportError("transport_closed");
    }
  }
}
