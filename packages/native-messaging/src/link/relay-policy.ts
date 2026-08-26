import type { NativeMessagingFrameType } from "@gpt-session-bridge/protocol";

export const BRIDGE_TO_EXTENSION_APPLICATION_TYPES = Object.freeze([
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

export const EXTENSION_TO_BRIDGE_APPLICATION_TYPES = Object.freeze([
  "session/connected",
  "session/disconnected",
  "agent/status/result",
  "agent/status/changed",
  "agent/activity/result",
  "capabilities/result",
  "capabilities/changed",
  "turn/started",
  "turn/delta",
  "turn/completed",
  "turn/cancelled",
  "turn/failed",
  "error",
] as const satisfies readonly NativeMessagingFrameType[]);
