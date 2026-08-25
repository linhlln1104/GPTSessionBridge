export type ExtensionUiState = "connected" | "connecting" | "error" | "idle";
export type ExtensionUiReason =
  | "already_connected"
  | "browser_unavailable"
  | "native_unavailable"
  | "none"
  | "page_unavailable"
  | "protocol_error"
  | "unsupported_page";

export type UiRequestType = "ui/connect" | "ui/disconnect" | "ui/status/read";

export interface UiRequest {
  readonly type: UiRequestType;
}

export interface UiStatus {
  readonly reason: ExtensionUiReason;
  readonly state: ExtensionUiState;
}

export interface UiResponse {
  readonly ok: boolean;
  readonly status: UiStatus;
}

const REQUEST_TYPES = new Set<UiRequestType>(["ui/connect", "ui/disconnect", "ui/status/read"]);
const UI_STATES = new Set<ExtensionUiState>(["connected", "connecting", "error", "idle"]);
const UI_REASONS = new Set<ExtensionUiReason>([
  "already_connected",
  "browser_unavailable",
  "native_unavailable",
  "none",
  "page_unavailable",
  "protocol_error",
  "unsupported_page",
]);

export function parseUiRequest(value: unknown): UiRequest | undefined {
  if (!isRecordWithExactKeys(value, ["type"])) {
    return undefined;
  }
  const type = value["type"];
  return typeof type === "string" && REQUEST_TYPES.has(type as UiRequestType)
    ? { type: type as UiRequestType }
    : undefined;
}

export function parseUiResponse(value: unknown): UiResponse | undefined {
  if (!isRecordWithExactKeys(value, ["ok", "status"])) {
    return undefined;
  }
  const status = value["status"];
  if (typeof value["ok"] !== "boolean" || !isRecordWithExactKeys(status, ["reason", "state"])) {
    return undefined;
  }
  const state = status["state"];
  const reason = status["reason"];
  if (
    typeof state !== "string" ||
    typeof reason !== "string" ||
    !UI_STATES.has(state as ExtensionUiState) ||
    !UI_REASONS.has(reason as ExtensionUiReason)
  ) {
    return undefined;
  }
  return {
    ok: value["ok"],
    status: { reason: reason as ExtensionUiReason, state: state as ExtensionUiState },
  };
}

function isRecordWithExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => keys.includes(key));
}
