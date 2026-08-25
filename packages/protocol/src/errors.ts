import { z } from "zod";

import { isSafeSingleLineText } from "./safe-text.js";

/**
 * Public machine-readable error codes. Values are part of the versioned wire
 * contract and must not be repurposed after release.
 */
export const BRIDGE_ERROR_CODES = {
  PROTOCOL_INVALID_MESSAGE: "protocol.invalid_message",
  PROTOCOL_UNSUPPORTED_VERSION: "protocol.unsupported_version",
  PROTOCOL_SEQUENCE_VIOLATION: "protocol.sequence_violation",
  TRANSPORT_UNAVAILABLE: "transport.unavailable",
  TRANSPORT_TIMEOUT: "transport.timeout",
  SESSION_NOT_CONNECTED: "session.not_connected",
  SESSION_ALREADY_CONNECTED: "session.already_connected",
  SESSION_CLOSED: "session.closed",
  CAPABILITY_UNSUPPORTED: "capability.unsupported",
  MODEL_UNAVAILABLE: "model.unavailable",
  TURN_NOT_FOUND: "turn.not_found",
  TURN_ALREADY_ACTIVE: "turn.already_active",
  TURN_CANCELLED: "turn.cancelled",
  BROWSER_UNAVAILABLE: "browser.unavailable",
  BROWSER_STATE_CHANGED: "browser.state_changed",
  INTERNAL_ERROR: "internal.error",
} as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[keyof typeof BRIDGE_ERROR_CODES];

const bridgeErrorCodeValues = Object.values(BRIDGE_ERROR_CODES) as [
  BridgeErrorCode,
  ...BridgeErrorCode[],
];

export const bridgeErrorCodeSchema = z.enum(bridgeErrorCodeValues);

/**
 * Safe wire error. Raw causes, stack traces, page state, and diagnostics are
 * deliberately excluded from this public contract.
 */
export const bridgeErrorSchema = z
  .object({
    code: bridgeErrorCodeSchema,
    message: z.string().min(1).max(512).refine(isSafeSingleLineText),
    retryable: z.boolean(),
  })
  .strict();

export type BridgeError = z.infer<typeof bridgeErrorSchema>;
