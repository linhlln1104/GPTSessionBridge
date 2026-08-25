export const NATIVE_LINK_ERROR_CODES = [
  "correlation_violation",
  "destination_unavailable",
  "direction_violation",
  "invalid_frame",
  "invalid_state",
  "sequence_exhausted",
  "sequence_violation",
  "unexpected_peer",
] as const;

export type NativeLinkErrorCode = (typeof NATIVE_LINK_ERROR_CODES)[number];

export class NativeLinkError extends Error {
  public readonly code: NativeLinkErrorCode;

  public constructor(code: NativeLinkErrorCode) {
    super(code);
    this.name = "NativeLinkError";
    this.code = code;
  }
}
