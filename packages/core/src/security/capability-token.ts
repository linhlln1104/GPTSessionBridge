import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "gsb_";
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^gsb_[A-Za-z0-9_-]{43}$/u;
const DUMMY_TOKEN = `${TOKEN_PREFIX}${"A".repeat(43)}`;

declare const capabilityTokenBrand: unique symbol;

export type CapabilityToken = string & {
  readonly [capabilityTokenBrand]: true;
};

export function generateCapabilityToken(): CapabilityToken {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}` as CapabilityToken;
}

export function parseCapabilityToken(value: unknown): CapabilityToken {
  if (!isCapabilityToken(value)) {
    throw new TypeError("Invalid capability token");
  }

  return value;
}

export function isCapabilityToken(value: unknown): value is CapabilityToken {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function verifyCapabilityToken(
  presentedToken: unknown,
  expectedToken: CapabilityToken,
): boolean {
  const presentedIsValid = isCapabilityToken(presentedToken);
  const expectedIsValid = isCapabilityToken(expectedToken);
  const presentedValue = presentedIsValid ? presentedToken : DUMMY_TOKEN;
  const expectedValue = expectedIsValid ? expectedToken : DUMMY_TOKEN;

  const presentedDigest = createHash("sha256").update(presentedValue, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expectedValue, "utf8").digest();
  const matches = timingSafeEqual(presentedDigest, expectedDigest);

  return presentedIsValid && expectedIsValid && matches;
}
