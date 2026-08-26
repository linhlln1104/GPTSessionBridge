import {
  TOOL_ACTIVATION_DISCLOSURE_VERSION,
  TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS,
  type ToolActivationReason,
  type ToolActivationSnapshot,
  type ToolActivationState,
} from "./tool-activation.js";

export type ExtensionUiState = "connected" | "connecting" | "error" | "idle";
export type ExtensionUiReason =
  | "already_connected"
  | "browser_unavailable"
  | "native_unavailable"
  | "none"
  | "page_unavailable"
  | "protocol_error"
  | "unsupported_page";

export type UiRequestType =
  | "ui/connect"
  | "ui/disconnect"
  | "ui/status/read"
  | "ui/tool-activation/activate"
  | "ui/tool-activation/deactivate";

export type UiRequest =
  | {
      readonly disclosureVersion: typeof TOOL_ACTIVATION_DISCLOSURE_VERSION;
      readonly selectionRevision: number;
      readonly type: "ui/tool-activation/activate";
    }
  | {
      readonly type: Exclude<UiRequestType, "ui/tool-activation/activate">;
    };

export interface UiStatus {
  readonly reason: ExtensionUiReason;
  readonly state: ExtensionUiState;
}

interface UiToolActivationStatusBase {
  readonly disclosureVersion: typeof TOOL_ACTIVATION_DISCLOSURE_VERSION;
  readonly inactivityTimeoutMs: typeof TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS;
  readonly revision: number;
}

export type UiToolActivationStatus =
  | (UiToolActivationStatusBase & {
      readonly expiresAtMs: number;
      readonly reason: "user_activated";
      readonly state: "active";
    })
  | (UiToolActivationStatusBase & {
      readonly expiresAtMs: null;
      readonly reason: Exclude<ToolActivationReason, "user_activated">;
      readonly state: "inactive";
    });

export interface UiResponse {
  readonly activation: UiToolActivationStatus;
  readonly ok: boolean;
  readonly selectionRevision: number;
  readonly status: UiStatus;
}

const SIMPLE_REQUEST_TYPES = new Set<Exclude<UiRequestType, "ui/tool-activation/activate">>([
  "ui/connect",
  "ui/disconnect",
  "ui/status/read",
  "ui/tool-activation/deactivate",
]);
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const type = record["type"];
  if (type === "ui/tool-activation/activate") {
    return isRecordWithExactKeys(record, ["disclosureVersion", "selectionRevision", "type"]) &&
      record["disclosureVersion"] === TOOL_ACTIVATION_DISCLOSURE_VERSION &&
      isNonnegativeSafeInteger(record["selectionRevision"])
      ? {
          disclosureVersion: TOOL_ACTIVATION_DISCLOSURE_VERSION,
          selectionRevision: record["selectionRevision"],
          type,
        }
      : undefined;
  }
  return isRecordWithExactKeys(record, ["type"]) &&
    typeof type === "string" &&
    SIMPLE_REQUEST_TYPES.has(type as Exclude<UiRequestType, "ui/tool-activation/activate">)
    ? { type: type as Exclude<UiRequestType, "ui/tool-activation/activate"> }
    : undefined;
}

export function parseUiResponse(value: unknown): UiResponse | undefined {
  if (!isRecordWithExactKeys(value, ["activation", "ok", "selectionRevision", "status"])) {
    return undefined;
  }
  const status = value["status"];
  const activation = parseUiToolActivationStatus(value["activation"]);
  if (
    typeof value["ok"] !== "boolean" ||
    !isNonnegativeSafeInteger(value["selectionRevision"]) ||
    !isRecordWithExactKeys(status, ["reason", "state"])
  ) {
    return undefined;
  }
  const state = status["state"];
  const reason = status["reason"];
  if (
    typeof state !== "string" ||
    typeof reason !== "string" ||
    !UI_STATES.has(state as ExtensionUiState) ||
    !UI_REASONS.has(reason as ExtensionUiReason) ||
    activation === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    activation,
    ok: value["ok"],
    selectionRevision: value["selectionRevision"],
    status: Object.freeze({
      reason: reason as ExtensionUiReason,
      state: state as ExtensionUiState,
    }),
  });
}

export function toUiToolActivationStatus(snapshot: ToolActivationSnapshot): UiToolActivationStatus {
  return snapshot.state === "active"
    ? Object.freeze({
        disclosureVersion: snapshot.disclosureVersion,
        expiresAtMs: snapshot.expiresAtMs,
        inactivityTimeoutMs: snapshot.inactivityTimeoutMs,
        reason: snapshot.reason,
        revision: snapshot.revision,
        state: snapshot.state,
      })
    : Object.freeze({
        disclosureVersion: snapshot.disclosureVersion,
        expiresAtMs: snapshot.expiresAtMs,
        inactivityTimeoutMs: snapshot.inactivityTimeoutMs,
        reason: snapshot.reason,
        revision: snapshot.revision,
        state: snapshot.state,
      });
}

function parseUiToolActivationStatus(value: unknown): UiToolActivationStatus | undefined {
  if (
    !isRecordWithExactKeys(value, [
      "disclosureVersion",
      "expiresAtMs",
      "inactivityTimeoutMs",
      "reason",
      "revision",
      "state",
    ]) ||
    value["disclosureVersion"] !== TOOL_ACTIVATION_DISCLOSURE_VERSION ||
    value["inactivityTimeoutMs"] !== TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS ||
    !isNonnegativeSafeInteger(value["revision"])
  ) {
    return undefined;
  }
  const state = value["state"];
  const reason = value["reason"];
  const expiresAtMs = value["expiresAtMs"];
  if (
    (state !== "active" && state !== "inactive") ||
    !isActivationReasonForState(reason, state) ||
    (state === "active" ? !isNonnegativeSafeInteger(expiresAtMs) : expiresAtMs !== null)
  ) {
    return undefined;
  }
  return state === "active"
    ? Object.freeze({
        disclosureVersion: TOOL_ACTIVATION_DISCLOSURE_VERSION,
        expiresAtMs: expiresAtMs as number,
        inactivityTimeoutMs: TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS,
        reason: "user_activated",
        revision: value["revision"],
        state,
      })
    : Object.freeze({
        disclosureVersion: TOOL_ACTIVATION_DISCLOSURE_VERSION,
        expiresAtMs: null,
        inactivityTimeoutMs: TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS,
        reason: reason as Exclude<ToolActivationReason, "user_activated">,
        revision: value["revision"],
        state,
      });
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

function isActivationReasonForState(
  reason: unknown,
  state: ToolActivationState,
): reason is ToolActivationReason {
  return state === "active"
    ? reason === "user_activated"
    : reason === "deactivated" ||
        reason === "disconnected" ||
        reason === "document_replaced" ||
        reason === "expired" ||
        reason === "extension_restart";
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
