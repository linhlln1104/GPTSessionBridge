import { describe, expect, it } from "vitest";

import { isSensitiveKey, redactErrorMetadata } from "../src/security/redaction.js";

describe("defensive metadata redaction", () => {
  it.each([
    "Authorization",
    "set-cookie",
    "accessToken",
    "refresh_token",
    "prompt",
    "response",
    "cwd",
    "filePath",
    "email",
  ])("detects the sensitive key %s", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it("retains only bounded, explicitly allowed metadata", () => {
    const result = redactErrorMetadata({
      attempt: 2,
      bytes: 1_024,
      causeCode: "ECONNRESET",
      code: "ETIMEDOUT",
      durationMs: 25,
      message: "MESSAGE_CANARY",
      retryable: true,
      status: 504,
    });

    expect(result).toEqual({
      attempt: 2,
      bytes: 1_024,
      causeCode: "ECONNRESET",
      code: "ETIMEDOUT",
      discardedFields: 1,
      durationMs: 25,
      retryable: true,
      status: 504,
    });
    expect(JSON.stringify(result)).not.toContain("MESSAGE_CANARY");
  });

  it("replaces non-record values with an aggregate discard count", () => {
    expect(redactErrorMetadata("TOKEN_CANARY")).toEqual({ discardedFields: 1 });
  });
});
