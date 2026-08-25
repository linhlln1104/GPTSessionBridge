import { describe, expect, it } from "vitest";

import { createLocalhostPolicy, evaluateLocalRequest } from "../src/security/localhost-policy.js";

describe("localhost request policy", () => {
  it("accepts only the exact IPv4 loopback authority", () => {
    const policy = createLocalhostPolicy(31_337);

    expect(
      evaluateLocalRequest(policy, {
        host: "127.0.0.1:31337",
        origin: "http://127.0.0.1:31337",
      }),
    ).toEqual({ allowed: true });
    expect(evaluateLocalRequest(policy, { host: "localhost:31337", origin: undefined })).toEqual({
      allowed: false,
      reason: "invalid-host",
    });
    expect(
      evaluateLocalRequest(policy, { host: "127.0.0.1:31337.evil.invalid", origin: undefined }),
    ).toEqual({ allowed: false, reason: "invalid-host" });
    expect(evaluateLocalRequest(policy, { host: "[::1]:31337", origin: undefined })).toEqual({
      allowed: false,
      reason: "invalid-host",
    });
  });

  it("allows a missing origin for non-browser clients but validates one when present", () => {
    const policy = createLocalhostPolicy(31_337, "allow-missing");

    expect(evaluateLocalRequest(policy, { host: "127.0.0.1:31337", origin: undefined })).toEqual({
      allowed: true,
    });
    expect(
      evaluateLocalRequest(policy, {
        host: "127.0.0.1:31337",
        origin: "https://attacker.invalid",
      }),
    ).toEqual({ allowed: false, reason: "invalid-origin" });
  });

  it("can require an exact loopback origin", () => {
    const policy = createLocalhostPolicy(31_337, "required");

    expect(evaluateLocalRequest(policy, { host: "127.0.0.1:31337", origin: undefined })).toEqual({
      allowed: false,
      reason: "missing-origin",
    });
  });
});
