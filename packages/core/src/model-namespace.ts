export const WEB_MODEL_PUBLIC_PREFIX = "gptsessionbridge/web/" as const;
const CANONICAL_WEB_MODEL_PATTERN =
  /^gptsessionbridge\/web\/[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;

export function isCanonicalWebModelReference(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_WEB_MODEL_PATTERN.test(value);
}

export function isReservedWebModelReference(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return (
    value.trimStart().slice(0, WEB_MODEL_PUBLIC_PREFIX.length).toLowerCase() ===
    WEB_MODEL_PUBLIC_PREFIX
  );
}
