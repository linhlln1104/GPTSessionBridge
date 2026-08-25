import { Writable } from "node:stream";

import type { NativeMessagingFrame } from "@gpt-session-bridge/protocol";
import { describe, expect, it } from "vitest";

import { NativeMessageDecoder } from "../src/transport/native-message-decoder.js";
import { NativeMessageTransportError } from "../src/transport/errors.js";
import { NativeMessageWriter } from "../src/transport/native-message-writer.js";
import { helloFrame } from "./fixtures.js";

const writerOptions = {
  maxFrameBytes: 2_048,
  maxQueuedBytes: 4_096,
  maxQueuedMessages: 4,
} as const;

describe("NativeMessageWriter", () => {
  it("writes only framed protocol bytes that round-trip through the decoder", async () => {
    const chunks: Buffer[] = [];
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    const writer = new NativeMessageWriter(output, writerOptions);
    const frame = helloFrame("extension");

    await writer.write(frame);

    const decoder = new NativeMessageDecoder({ maxBufferedBytes: 4_096, maxFrameBytes: 2_048 });
    expect(decoder.push(Buffer.concat(chunks))).toEqual([frame]);
  });

  it("rejects invalid and oversized frames before writing", async () => {
    const invalidOutput = new Writable({
      write: (_chunk, _encoding, callback) => {
        callback();
      },
    });
    const invalidWriter = new NativeMessageWriter(invalidOutput, {
      maxFrameBytes: 64,
      maxQueuedBytes: 256,
      maxQueuedMessages: 2,
    });
    const invalid = { ...helloFrame("extension"), extra: true } as unknown as NativeMessagingFrame;

    await expect(invalidWriter.write(invalid)).rejects.toMatchObject({ code: "invalid_frame" });
    await expect(invalidWriter.write(helloFrame("extension"))).rejects.toMatchObject({
      code: "invalid_frame",
    });

    const oversizedOutput = new Writable({
      write: (_chunk, _encoding, callback) => {
        callback();
      },
    });
    const oversizedWriter = new NativeMessageWriter(oversizedOutput, {
      maxFrameBytes: 64,
      maxQueuedBytes: 256,
      maxQueuedMessages: 2,
    });
    await expect(oversizedWriter.write(helloFrame("extension"))).rejects.toMatchObject({
      code: "frame_too_large",
    });
    await expect(oversizedWriter.write(helloFrame("extension"))).rejects.toMatchObject({
      code: "frame_too_large",
    });
  });

  it("bounds queued messages while a write is blocked", async () => {
    let pendingCallback: ((error?: Error | null) => void) | undefined;
    const output = new Writable({
      highWaterMark: 1,
      write: (_chunk, _encoding, callback) => {
        pendingCallback = callback;
      },
    });
    const writer = new NativeMessageWriter(output, {
      ...writerOptions,
      maxQueuedMessages: 1,
    });

    const first = writer.write(helloFrame("extension"));
    await expect(writer.write(helloFrame("extension", "request-second"))).rejects.toMatchObject({
      code: "queue_overflow",
    });
    pendingCallback?.();
    await expect(first).rejects.toMatchObject({ code: "queue_overflow" });
    await expect(writer.write(helloFrame("extension", "request-third"))).rejects.toMatchObject({
      code: "queue_overflow",
    });
  });

  it("fails the active write and all future writes after a stream error", async () => {
    const output = new Writable({
      write: (_chunk, _encoding, callback) => {
        callback(new Error("synthetic write failure"));
      },
    });
    const writer = new NativeMessageWriter(output, writerOptions);

    await expect(writer.write(helloFrame("extension"))).rejects.toMatchObject({
      code: "write_failed",
    });
    await expect(writer.write(helloFrame("extension"))).rejects.toMatchObject({
      code: "write_failed",
    });
  });

  it("rejects invalid limits and writes after close", async () => {
    const output = new Writable({
      write: (_chunk, _encoding, callback) => {
        callback();
      },
    });
    expect(
      () =>
        new NativeMessageWriter(output, {
          maxFrameBytes: 100,
          maxQueuedBytes: 104,
          maxQueuedMessages: 1,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new NativeMessageWriter(output, {
          maxFrameBytes: 1_048_577,
          maxQueuedBytes: 2_097_160,
          maxQueuedMessages: 1,
        }),
    ).toThrow(RangeError);

    const writer = new NativeMessageWriter(output, writerOptions);
    writer.close();
    await expect(writer.write(helloFrame("extension"))).rejects.toBeInstanceOf(
      NativeMessageTransportError,
    );
  });
});
