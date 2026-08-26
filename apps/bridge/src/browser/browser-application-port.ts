import type {
  NativeMessagingFrameOf,
  NativeMessagingFrameType,
} from "@gpt-session-bridge/protocol";

export const BROWSER_COMMAND_TYPES = Object.freeze([
  "session/connect",
  "session/disconnect",
  "agent/status/read",
  "agent/activity/note",
  "agent/turn/start",
  "capabilities/read",
  "turn/start",
  "turn/cancel",
  "error",
] as const satisfies readonly NativeMessagingFrameType[]);

export type BrowserCommandType = (typeof BROWSER_COMMAND_TYPES)[number];

export interface BrowserApplicationMessage<Type extends BrowserCommandType> {
  readonly payload: NativeMessagingFrameOf<Type>["payload"];
  readonly requestId: string;
  readonly type: Type;
}

/**
 * Authenticated, handshaken application channel. Framing, protocol version,
 * and link-local sequence numbers belong to the transport adapter.
 */
export interface BrowserApplicationPort {
  close(): void;

  send<Type extends BrowserCommandType>(message: BrowserApplicationMessage<Type>): Promise<void>;
}
