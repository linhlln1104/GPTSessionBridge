export const APP_SERVER_TRANSPORT_ERROR_CODES = [
  "buffer_overflow",
  "frame_too_large",
  "invalid_frame",
  "queue_overflow",
  "transport_closed",
  "write_failed",
] as const;

export type AppServerTransportErrorCode = (typeof APP_SERVER_TRANSPORT_ERROR_CODES)[number];

export class AppServerTransportError extends Error {
  public readonly code: AppServerTransportErrorCode;

  public constructor(code: AppServerTransportErrorCode) {
    super(code);
    this.name = "AppServerTransportError";
    this.code = code;
  }
}
