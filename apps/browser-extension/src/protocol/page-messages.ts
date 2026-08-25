import { PAGE_PROTOCOL_VERSION } from "../constants.js";

export interface PageProbeMessage {
  readonly protocolVersion: typeof PAGE_PROTOCOL_VERSION;
  readonly type: "page/probe";
}

export interface PageReadyMessage {
  readonly adapter: "unavailable";
  readonly protocolVersion: typeof PAGE_PROTOCOL_VERSION;
  readonly type: "page/ready";
}

export function createPageProbeMessage(): PageProbeMessage {
  return Object.freeze({ protocolVersion: PAGE_PROTOCOL_VERSION, type: "page/probe" });
}

export function parsePageReadyMessage(value: unknown): PageReadyMessage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 3 ||
    !keys.includes("adapter") ||
    !keys.includes("protocolVersion") ||
    !keys.includes("type") ||
    record["adapter"] !== "unavailable" ||
    record["protocolVersion"] !== PAGE_PROTOCOL_VERSION ||
    record["type"] !== "page/ready"
  ) {
    return undefined;
  }
  return {
    adapter: "unavailable",
    protocolVersion: PAGE_PROTOCOL_VERSION,
    type: "page/ready",
  };
}
