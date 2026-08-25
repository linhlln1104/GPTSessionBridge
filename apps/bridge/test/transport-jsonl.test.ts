import { PassThrough, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  AppServerJsonLineDecoder,
  AppServerJsonLineWriter,
  AppServerTransportError,
  appServerCorrelationKey,
} from "../src/transport/index.js";

const decoderOptions = {
  maxBufferedBytes: 1_024,
  maxFrameBytes: 512,
} as const;

describe("AppServerJsonLineDecoder", () => {
  it("decodes fragmented UTF-8 frames without corrupting multibyte text", () => {
    const decoder = new AppServerJsonLineDecoder(decoderOptions);
    const frame = Buffer.from(
      `${JSON.stringify({ id: 1, method: "example/request", params: { text: "chào" } })}\n`,
      "utf8",
    );
    const multibyteStart = frame.indexOf(Buffer.from("à", "utf8"));

    expect(decoder.push(frame.subarray(0, multibyteStart + 1))).toEqual([]);
    expect(decoder.push(frame.subarray(multibyteStart + 1))).toEqual([
      { id: 1, method: "example/request", params: { text: "chào" } },
    ]);
  });

  it("handles CRLF, blank lines, and multiple frames in one chunk", () => {
    const decoder = new AppServerJsonLineDecoder(decoderOptions);
    const messages = decoder.push(
      '\r\n{"id":"a","method":"first"}\r\n{"method":"notice","params":{}}\n\n',
    );

    expect(messages).toEqual([
      { id: "a", method: "first" },
      { method: "notice", params: {} },
    ]);
  });

  it("accepts one final frame without a trailing newline", () => {
    const decoder = new AppServerJsonLineDecoder(decoderOptions);
    expect(decoder.push('{"id":7,"result":{"ok":true}}')).toEqual([]);
    expect(decoder.finish()).toEqual([{ id: 7, result: { ok: true } }]);
  });

  it("fails closed with a content-free error for malformed input", () => {
    const decoder = new AppServerJsonLineDecoder(decoderOptions);
    const canary = "private-prompt-canary";

    expect(() => decoder.push(`{"id":1,"result":"${canary}"\n`)).toThrow(
      expect.objectContaining({ code: "invalid_frame", message: "invalid_frame" }),
    );
    expect(() => decoder.push('{"id":2,"result":null}\n')).toThrow(
      expect.objectContaining({ code: "transport_closed" }),
    );
    try {
      decoder.finish();
    } catch (error) {
      expect(String(error)).not.toContain(canary);
    }
  });

  it("rejects invalid UTF-8 and oversized unterminated frames", () => {
    const invalidUtf8 = new AppServerJsonLineDecoder(decoderOptions);
    expect(() => invalidUtf8.push(Buffer.from([0xff, 0x0a]))).toThrow(
      expect.objectContaining({ code: "invalid_frame" }),
    );

    const bounded = new AppServerJsonLineDecoder({
      maxBufferedBytes: 64,
      maxFrameBytes: 32,
    });
    expect(() => bounded.push("x".repeat(33))).toThrow(
      expect.objectContaining({ code: "frame_too_large" }),
    );
  });
});

describe("AppServerJsonLineWriter", () => {
  it("serializes writes in JSONL order", async () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    const writer = new AppServerJsonLineWriter(stream, {
      maxFrameBytes: 512,
      maxQueuedBytes: 1_024,
      maxQueuedMessages: 4,
    });

    await Promise.all([
      writer.write({ id: 1, method: "first" }),
      writer.write({ id: 2, result: { ok: true } }),
    ]);

    expect(Buffer.concat(chunks).toString("utf8")).toBe(
      '{"id":1,"method":"first"}\n{"id":2,"result":{"ok":true}}\n',
    );
    writer.close();
  });

  it("waits for backpressure before advancing the queue", async () => {
    const written: string[] = [];
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        setImmediate(() => {
          written.push(chunk.toString("utf8"));
          callback();
        });
      },
    });
    const writer = new AppServerJsonLineWriter(stream, {
      maxFrameBytes: 512,
      maxQueuedBytes: 1_024,
      maxQueuedMessages: 4,
    });

    await Promise.all([
      writer.write({ id: "one", result: null }),
      writer.write({ id: "two", result: null }),
    ]);

    expect(written).toEqual(['{"id":"one","result":null}\n', '{"id":"two","result":null}\n']);
    writer.close();
  });

  it("bounds queued messages and rejects pending writes once on close", async () => {
    const stream = new Writable({
      write() {
        // The callback is intentionally held to model a blocked downstream peer.
      },
    });
    const writer = new AppServerJsonLineWriter(stream, {
      maxFrameBytes: 128,
      maxQueuedBytes: 256,
      maxQueuedMessages: 1,
    });
    let rejectionCount = 0;
    const pending = writer.write({ id: 1, result: null }).catch((error: unknown) => {
      rejectionCount += 1;
      throw error;
    });

    await expect(writer.write({ id: 2, result: null })).rejects.toMatchObject({
      code: "queue_overflow",
    });
    writer.close();
    writer.close();
    await expect(pending).rejects.toMatchObject({ code: "transport_closed" });
    expect(rejectionCount).toBe(1);
  });

  it("rejects invalid and oversized outbound frames without echoing content", async () => {
    const stream = new PassThrough();
    const writer = new AppServerJsonLineWriter(stream, {
      maxFrameBytes: 16,
      maxQueuedBytes: 64,
      maxQueuedMessages: 2,
    });
    const canary = "outbound-private-canary";

    await expect(writer.write({ id: 1, result: canary })).rejects.toBeInstanceOf(
      AppServerTransportError,
    );
    await expect(
      writer.write({ id: 1, method: "valid", result: null } as never),
    ).rejects.toMatchObject({ code: "invalid_frame" });
    writer.close();
  });

  it("accounts for the JSONL delimiter and safely absorbs later stream errors", async () => {
    const stream = new PassThrough();
    const envelope = { id: 1, result: null } as const;
    const payloadBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");

    expect(
      () =>
        new AppServerJsonLineWriter(stream, {
          maxFrameBytes: payloadBytes,
          maxQueuedBytes: payloadBytes,
          maxQueuedMessages: 1,
        }),
    ).toThrow(RangeError);

    const writer = new AppServerJsonLineWriter(stream, {
      maxFrameBytes: payloadBytes,
      maxQueuedBytes: payloadBytes + 1,
      maxQueuedMessages: 1,
    });
    await writer.write(envelope);
    writer.close();
    expect(() => stream.emit("error", new Error("synthetic stream failure"))).not.toThrow();
  });
});

describe("appServerCorrelationKey", () => {
  it("separates peer direction and ID type", () => {
    expect(appServerCorrelationKey("client-request", 1)).not.toBe(
      appServerCorrelationKey("server-request", 1),
    );
    expect(appServerCorrelationKey("client-request", 1)).not.toBe(
      appServerCorrelationKey("client-request", "1"),
    );
  });
});
