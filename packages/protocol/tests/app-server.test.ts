import { describe, expect, it } from "vitest";

import {
  appServerEnvelopeSchema,
  appServerErrorResponseSchema,
  appServerNotificationSchema,
  appServerRequestSchema,
  appServerSuccessResponseSchema,
} from "../src/index.js";

describe("app-server envelopes", () => {
  it("accepts and preserves an opaque request payload", () => {
    const frame = {
      id: 7,
      method: "thread/example",
      params: {
        thread: { id: "thread-example" },
        options: [true, null, 3],
      },
      extensionMetadata: { revision: "fixture-a" },
    };

    expect(appServerRequestSchema.parse(frame)).toEqual(frame);
    expect(appServerEnvelopeSchema.parse(frame)).toEqual(frame);
  });

  it("accepts a notification without an id", () => {
    const frame = {
      method: "turn/exampleDelta",
      params: { delta: "synthetic output" },
    };

    expect(appServerNotificationSchema.parse(frame)).toEqual(frame);
  });

  it("accepts success responses with string ids", () => {
    const frame = {
      id: "request-example",
      result: { accepted: true },
    };

    expect(appServerSuccessResponseSchema.parse(frame)).toEqual(frame);
  });

  it("accepts structured error responses and preserves unknown error data", () => {
    const frame = {
      id: 9,
      error: {
        code: -32001,
        message: "Synthetic failure",
        data: { retryAfterMs: 50 },
        category: "fixture",
      },
    };

    expect(appServerErrorResponseSchema.parse(frame)).toEqual(frame);
  });

  it("rejects null ids and ambiguous response members", () => {
    expect(appServerEnvelopeSchema.safeParse({ id: null, method: "thread/example" }).success).toBe(
      false,
    );
    expect(appServerEnvelopeSchema.safeParse({ id: 1, result: {}, error: {} }).success).toBe(false);
  });

  it("rejects values that cannot cross a JSON transport", () => {
    expect(
      appServerEnvelopeSchema.safeParse({
        id: 1,
        method: "thread/example",
        params: { invalid: undefined },
      }).success,
    ).toBe(false);
    expect(
      appServerEnvelopeSchema.safeParse({
        id: 1,
        result: Number.POSITIVE_INFINITY,
      }).success,
    ).toBe(false);
  });
});
