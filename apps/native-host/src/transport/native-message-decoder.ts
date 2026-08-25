import { TextDecoder } from "node:util";

import {
  nativeMessagingFrameSchema,
  type NativeMessagingFrame,
} from "@gpt-session-bridge/protocol";

import {
  DEFAULT_NATIVE_MESSAGE_MAX_BUFFERED_BYTES,
  DEFAULT_NATIVE_MESSAGE_MAX_FRAME_BYTES,
  NATIVE_MESSAGE_HEADER_BYTES,
} from "../constants.js";
import { NativeMessageTransportError } from "./errors.js";

export interface NativeMessageDecoderOptions {
  readonly maxBufferedBytes: number;
  readonly maxFrameBytes: number;
}

export class NativeMessageDecoder {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #maxBufferedBytes: number;
  readonly #maxFrameBytes: number;
  #buffer = Buffer.alloc(0);
  #closed = false;

  public constructor(options: NativeMessageDecoderOptions) {
    if (
      !Number.isSafeInteger(options.maxFrameBytes) ||
      options.maxFrameBytes < 1 ||
      options.maxFrameBytes > DEFAULT_NATIVE_MESSAGE_MAX_FRAME_BYTES ||
      !Number.isSafeInteger(options.maxBufferedBytes) ||
      options.maxBufferedBytes < options.maxFrameBytes + NATIVE_MESSAGE_HEADER_BYTES ||
      options.maxBufferedBytes > DEFAULT_NATIVE_MESSAGE_MAX_BUFFERED_BYTES
    ) {
      throw new RangeError("Invalid Native Messaging decoder limits");
    }
    this.#maxBufferedBytes = options.maxBufferedBytes;
    this.#maxFrameBytes = options.maxFrameBytes;
  }

  public push(chunk: Uint8Array): readonly NativeMessagingFrame[] {
    this.#assertOpen();
    if (chunk.byteLength > this.#maxBufferedBytes - this.#buffer.byteLength) {
      this.#fail();
      throw new NativeMessageTransportError("buffer_overflow");
    }

    const input = Buffer.from(chunk);
    const nextBytes = this.#buffer.byteLength + input.byteLength;
    this.#buffer = Buffer.concat([this.#buffer, input], nextBytes);
    const frames: NativeMessagingFrame[] = [];
    let offset = 0;

    try {
      while (this.#buffer.byteLength - offset >= NATIVE_MESSAGE_HEADER_BYTES) {
        const payloadBytes = this.#buffer.readUInt32LE(offset);
        if (payloadBytes === 0) {
          throw new NativeMessageTransportError("invalid_frame");
        }
        if (payloadBytes > this.#maxFrameBytes) {
          throw new NativeMessageTransportError("frame_too_large");
        }

        const frameBytes = NATIVE_MESSAGE_HEADER_BYTES + payloadBytes;
        if (this.#buffer.byteLength - offset < frameBytes) {
          break;
        }

        const payloadStart = offset + NATIVE_MESSAGE_HEADER_BYTES;
        const payload = this.#buffer.subarray(payloadStart, payloadStart + payloadBytes);
        const value: unknown = JSON.parse(this.#decoder.decode(payload));
        frames.push(nativeMessagingFrameSchema.parse(value));
        offset += frameBytes;
      }

      if (offset > 0) {
        this.#buffer = Buffer.from(this.#buffer.subarray(offset));
      }
      return frames;
    } catch (error) {
      this.#fail();
      if (error instanceof NativeMessageTransportError) {
        throw error;
      }
      throw new NativeMessageTransportError("invalid_frame");
    }
  }

  public finish(): void {
    this.#assertOpen();
    this.#closed = true;
    if (this.#buffer.byteLength > 0) {
      this.#buffer = Buffer.alloc(0);
      throw new NativeMessageTransportError("truncated_frame");
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new NativeMessageTransportError("transport_closed");
    }
  }

  #fail(): void {
    this.#closed = true;
    this.#buffer = Buffer.alloc(0);
  }
}
