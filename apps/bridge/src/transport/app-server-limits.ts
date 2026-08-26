export interface AppServerTransportLimits {
  readonly maxBufferedBytes: number;
  readonly maxFrameBytes: number;
  readonly maxQueuedMessages: number;
}

export const DEFAULT_APP_SERVER_TRANSPORT_LIMITS: AppServerTransportLimits = Object.freeze({
  maxBufferedBytes: 128 * 1024 * 1024,
  maxFrameBytes: 64 * 1024 * 1024,
  maxQueuedMessages: 256,
});
