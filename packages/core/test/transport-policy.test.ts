import { describe, expect, it } from "vitest";

import {
  DEFAULT_TRANSPORT_SECURITY_POLICY,
  parseTransportSecurityPolicy,
  transportSecurityPolicySchema,
} from "../src/security/transport-policy.js";

describe("transport security policy", () => {
  it("provides a deeply frozen conservative default", () => {
    expect(DEFAULT_TRANSPORT_SECURITY_POLICY.size.maxFrameBytes).toBe(1_048_576);
    expect(Object.isFrozen(DEFAULT_TRANSPORT_SECURITY_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TRANSPORT_SECURITY_POLICY.replay)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TRANSPORT_SECURITY_POLICY.size)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TRANSPORT_SECURITY_POLICY.timeout)).toBe(true);
  });

  it("parses an exact, bounded policy", () => {
    const parsed = parseTransportSecurityPolicy({
      replay: { maxTrackedNonces: 100, nonceBytes: 32, windowMs: 30_000 },
      size: { maxBufferedBytes: 4_096, maxFrameBytes: 2_048 },
      timeout: {
        handshakeMs: 500,
        idleMs: 1_000,
        requestMs: 5_000,
        shutdownGraceMs: 500,
      },
    });

    expect(parsed.replay.nonceBytes).toBe(32);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("rejects oversized frames and unknown policy fields", () => {
    expect(
      transportSecurityPolicySchema.safeParse({
        replay: { maxTrackedNonces: 100, nonceBytes: 32, windowMs: 30_000 },
        size: { maxBufferedBytes: 1_024, maxFrameBytes: 2_048 },
        timeout: {
          handshakeMs: 500,
          idleMs: 1_000,
          requestMs: 5_000,
          shutdownGraceMs: 500,
        },
      }),
    ).toEqual({ success: false });

    expect(
      transportSecurityPolicySchema.safeParse({
        extra: "TOKEN_CANARY",
        replay: { maxTrackedNonces: 100, nonceBytes: 32, windowMs: 30_000 },
        size: { maxBufferedBytes: 4_096, maxFrameBytes: 2_048 },
        timeout: {
          handshakeMs: 500,
          idleMs: 1_000,
          requestMs: 5_000,
          shutdownGraceMs: 500,
        },
      }),
    ).toEqual({ success: false });
  });
});
