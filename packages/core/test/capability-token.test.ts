import { describe, expect, it } from "vitest";

import {
  generateCapabilityToken,
  isCapabilityToken,
  parseCapabilityToken,
  verifyCapabilityToken,
} from "../src/security/capability-token.js";

describe("capability tokens", () => {
  it("generates high-entropy, fixed-format tokens", () => {
    const first = generateCapabilityToken();
    const second = generateCapabilityToken();

    expect(first).toMatch(/^gsb_[A-Za-z0-9_-]{43}$/u);
    expect(second).not.toBe(first);
    expect(isCapabilityToken(first)).toBe(true);
  });

  it("verifies only the exact expected token", () => {
    const expected = generateCapabilityToken();
    const other = generateCapabilityToken();

    expect(verifyCapabilityToken(expected, expected)).toBe(true);
    expect(verifyCapabilityToken(other, expected)).toBe(false);
    expect(verifyCapabilityToken("malformed", expected)).toBe(false);
    expect(verifyCapabilityToken(undefined, expected)).toBe(false);
  });

  it("rejects malformed persisted values without reflecting them", () => {
    const secretCanary = "SECRET_TOKEN_CANARY";

    expect(() => parseCapabilityToken(secretCanary)).toThrow("Invalid capability token");
    try {
      parseCapabilityToken(secretCanary);
    } catch (error: unknown) {
      expect(String(error)).not.toContain(secretCanary);
    }
  });
});
