export const LOOPBACK_IPV4_ADDRESS = "127.0.0.1" as const;

export interface LocalhostPolicy {
  readonly expectedHost: string;
  readonly expectedOrigin: string;
  readonly originRequirement: "allow-missing" | "required";
  readonly port: number;
}

export interface LocalRequestIdentity {
  readonly host: unknown;
  readonly origin: unknown;
}

export type LocalRequestPolicyDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "invalid-host" | "invalid-origin" | "missing-host" | "missing-origin";
    };

export function createLocalhostPolicy(
  port: number,
  originRequirement?: LocalhostPolicy["originRequirement"],
): LocalhostPolicy;
export function createLocalhostPolicy(
  port: number,
  originRequirement: unknown = "allow-missing",
): LocalhostPolicy {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("Invalid loopback port");
  }
  if (originRequirement !== "allow-missing" && originRequirement !== "required") {
    throw new TypeError("Invalid origin requirement");
  }

  const expectedHost = `${LOOPBACK_IPV4_ADDRESS}:${String(port)}`;
  return Object.freeze({
    expectedHost,
    expectedOrigin: `http://${expectedHost}`,
    originRequirement,
    port,
  });
}

export function evaluateLocalRequest(
  policy: LocalhostPolicy,
  identity: LocalRequestIdentity,
): LocalRequestPolicyDecision {
  if (typeof identity.host !== "string" || identity.host.length === 0) {
    return Object.freeze({ allowed: false, reason: "missing-host" });
  }
  if (identity.host !== policy.expectedHost) {
    return Object.freeze({ allowed: false, reason: "invalid-host" });
  }

  if (identity.origin === undefined || identity.origin === null || identity.origin === "") {
    return policy.originRequirement === "allow-missing"
      ? Object.freeze({ allowed: true })
      : Object.freeze({ allowed: false, reason: "missing-origin" });
  }

  if (typeof identity.origin !== "string" || identity.origin !== policy.expectedOrigin) {
    return Object.freeze({ allowed: false, reason: "invalid-origin" });
  }

  return Object.freeze({ allowed: true });
}
