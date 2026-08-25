import {
  bridgeErrorSchema,
  type BridgeError,
  type BridgeErrorCode,
} from "@gpt-session-bridge/protocol";

export class BrowserSessionError extends Error {
  public readonly bridgeError: BridgeError;
  public readonly code: BridgeErrorCode;
  public readonly retryable: boolean;

  public constructor(bridgeError: BridgeError) {
    super(bridgeError.message);
    this.name = "BrowserSessionError";
    this.bridgeError = freezeBridgeError(bridgeError);
    this.code = this.bridgeError.code;
    this.retryable = this.bridgeError.retryable;
  }
}

export function createBrowserSessionError(
  code: BridgeErrorCode,
  message: string,
  retryable: boolean,
): BrowserSessionError {
  return new BrowserSessionError(
    bridgeErrorSchema.parse({
      code,
      message,
      retryable,
    }),
  );
}

export function freezeBridgeError(error: BridgeError): BridgeError {
  return Object.freeze(bridgeErrorSchema.parse(error));
}
