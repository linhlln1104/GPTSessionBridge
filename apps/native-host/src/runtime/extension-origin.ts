const EXTENSION_ID_PATTERN = /^[a-p]{32}$/u;
const REQUIRED_ALLOWED_ORIGINS = 1;

export type ExtensionOriginErrorCode = "invalid_allowlist" | "invalid_origin";

export class ExtensionOriginError extends Error {
  public readonly code: ExtensionOriginErrorCode;

  public constructor(code: ExtensionOriginErrorCode) {
    super(code);
    this.name = "ExtensionOriginError";
    this.code = code;
  }
}

export function createChromeExtensionOrigin(extensionId: string): string {
  if (!EXTENSION_ID_PATTERN.test(extensionId)) {
    throw new ExtensionOriginError("invalid_origin");
  }
  return `chrome-extension://${extensionId}/`;
}

export function validateExtensionOrigin(
  callerOrigin: unknown,
  allowedOrigins: readonly string[],
): string {
  if (
    allowedOrigins.length !== REQUIRED_ALLOWED_ORIGINS ||
    new Set(allowedOrigins).size !== allowedOrigins.length ||
    allowedOrigins.some((origin) => !isCanonicalExtensionOrigin(origin))
  ) {
    throw new ExtensionOriginError("invalid_allowlist");
  }
  if (typeof callerOrigin !== "string" || !allowedOrigins.includes(callerOrigin)) {
    throw new ExtensionOriginError("invalid_origin");
  }
  return callerOrigin;
}

function isCanonicalExtensionOrigin(value: string): boolean {
  if (!value.startsWith("chrome-extension://") || !value.endsWith("/")) {
    return false;
  }
  const extensionId = value.slice("chrome-extension://".length, -1);
  return EXTENSION_ID_PATTERN.test(extensionId);
}
