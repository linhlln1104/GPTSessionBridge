import {
  NATIVE_MESSAGING_PROTOCOL_VERSION,
  nativeMessagingFrameSchema,
} from "@gpt-session-bridge/protocol";
import { describe, expect, it } from "vitest";

import { NativeMessageDecoder } from "../src/transport/native-message-decoder.js";
import { NativeMessageTransportError } from "../src/transport/errors.js";
import { encodeNativeMessage, helloFrame } from "./fixtures.js";

const decoderOptions = { maxBufferedBytes: 4_096, maxFrameBytes: 2_048 } as const;

describe("NativeMessageDecoder", () => {
  it("decodes fragmented headers, fragmented UTF-8 payloads, and coalesced frames", () => {
    const delta = nativeMessagingFrameSchema.parse({
      protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
      requestId: "request-turn",
      sequence: 1,
      type: "turn/delta",
      payload: {
        sessionId: "session-example",
        turnId: "turn-example",
        channel: "outputText",
        delta: "Xin chÃ o ðŸ‘‹",
      },
    });
    const first = encodeNativeMessage(helloFrame("extension"));
    const second = encodeNativeMessage(delta);
    const combined = Buffer.concat([first, second]);
    const emojiStart = combined.indexOf(Buffer.from("ðŸ‘‹", "utf8"));
    const decoder = new NativeMessageDecoder(decoderOptions);

    expect(decoder.push(combined.subarray(0, 2))).toEqual([]);
    expect(decoder.push(combined.subarray(2, emojiStart + 1))).toEqual([helloFrame("extension")]);
    expect(decoder.push(combined.subarray(emojiStart + 1))).toEqual([delta]);
    expect(() => {
      decoder.finish();
    }).not.toThrow();
  });

  it("accepts a frame exactly at the configured byte limit", () => {
    const frame = helloFrame("extension");
    const encoded = encodeNativeMessage(frame);
    const payloadBytes = encoded.byteLength - 4;
    const decoder = new NativeMessageDecoder({
      maxBufferedBytes: encoded.byteLength,
      maxFrameBytes: payloadBytes,
    });

    expect(decoder.push(encoded)).toEqual([frame]);
  });

  it("rejects zero-length and oversized frames, then remains closed", () => {
    const zeroLength = Buffer.alloc(4);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(decoderOptions.maxFrameBytes + 1, 0);

    const zeroDecoder = new NativeMessageDecoder(decoderOptions);
    expectCode(() => zeroDecoder.push(zeroLength), "invalid_frame");
    expectCode(() => zeroDecoder.push(Buffer.alloc(0)), "transport_closed");

    const oversizedDecoder = new NativeMessageDecoder(decoderOptions);
    expectCode(() => oversizedDecoder.push(oversized), "frame_too_large");
  });

  it("rejects malformed JSON, invalid UTF-8, and schema-invalid objects", () => {
    const invalidPayloads = [
      Buffer.from("{", "utf8"),
      Buffer.from([0xff]),
      Buffer.from(JSON.stringify({ type: "unknown" }), "utf8"),
    ];

    for (const payload of invalidPayloads) {
      const header = Buffer.alloc(4);
      header.writeUInt32LE(payload.byteLength, 0);
      const decoder = new NativeMessageDecoder(decoderOptions);
      expectCode(() => decoder.push(Buffer.concat([header, payload])), "invalid_frame");
    }
  });

  it("rejects buffer growth and truncated final frames", () => {
    const overflowing = new NativeMessageDecoder({ maxBufferedBytes: 12, maxFrameBytes: 8 });
    expectCode(() => overflowing.push(Buffer.alloc(13)), "buffer_overflow");

    const truncated = new NativeMessageDecoder(decoderOptions);
    const frame = encodeNativeMessage(helloFrame("extension"));
    expect(truncated.push(frame.subarray(0, -1))).toEqual([]);
    expectCode(() => {
      truncated.finish();
    }, "truncated_frame");
  });

  it("rejects invalid resource limits", () => {
    expect(() => new NativeMessageDecoder({ maxBufferedBytes: 100, maxFrameBytes: 100 })).toThrow(
      RangeError,
    );
    expect(
      () =>
        new NativeMessageDecoder({
          maxBufferedBytes: Number.POSITIVE_INFINITY,
          maxFrameBytes: 100,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new NativeMessageDecoder({
          maxBufferedBytes: 2_097_161,
          maxFrameBytes: 1_048_576,
        }),
    ).toThrow(RangeError);
  });
});

function expectCode(operation: () => unknown, code: NativeMessageTransportError["code"]): void {
  try {
    operation();
    throw new Error("Expected the decoder to reject the frame");
  } catch (error) {
    expect(error).toBeInstanceOf(NativeMessageTransportError);
    expect((error as NativeMessageTransportError).code).toBe(code);
  }
}
