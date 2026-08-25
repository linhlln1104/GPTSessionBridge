import { describe, expect, it } from "vitest";

import { BRIDGE_ERROR_CODES, bridgeErrorCodeSchema, bridgeErrorSchema } from "../src/index.js";

describe("public bridge errors", () => {
  it("exports stable machine-readable codes", () => {
    expect(bridgeErrorCodeSchema.parse(BRIDGE_ERROR_CODES.SESSION_NOT_CONNECTED)).toBe(
      "session.not_connected",
    );
    expect(bridgeErrorCodeSchema.safeParse("session.unknown").success).toBe(false);
  });

  it("allows only safe public error fields", () => {
    const error = {
      code: BRIDGE_ERROR_CODES.TRANSPORT_TIMEOUT,
      message: "The local peer did not respond in time.",
      retryable: true,
    };

    expect(bridgeErrorSchema.parse(error)).toEqual(error);
    expect(bridgeErrorSchema.safeParse({ ...error, stack: "synthetic stack" }).success).toBe(false);
    expect(bridgeErrorSchema.safeParse({ ...error, message: "Line one\nLine two" }).success).toBe(
      false,
    );
  });
});
