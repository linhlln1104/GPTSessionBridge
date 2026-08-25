import type { AppServerMessageId } from "@gpt-session-bridge/protocol";

export type AppServerRequestDirection = "client-request" | "server-request";

export function appServerCorrelationKey(
  direction: AppServerRequestDirection,
  id: AppServerMessageId,
): string {
  return JSON.stringify([direction, typeof id, id]);
}
