export const NATIVE_MESSAGE_TRANSPORT_ERROR_CODES = [
  "buffer_overflow",
  "frame_too_large",
  "invalid_frame",
  "queue_overflow",
  "transport_closed",
  "truncated_frame",
  "write_failed",
] as const;

export type NativeMessageTransportErrorCode = (typeof NATIVE_MESSAGE_TRANSPORT_ERROR_CODES)[number];

export class NativeMessageTransportError extends Error {
  public readonly code: NativeMessageTransportErrorCode;

  public constructor(code: NativeMessageTransportErrorCode) {
    super(code);
    this.name = "NativeMessageTransportError";
    this.code = code;
  }
}
