import type { ActiveAgentStatusSnapshot, AgentStatusSnapshot } from "@gpt-session-bridge/protocol";

export const TOOL_ACTIVATION_DISCLOSURE_VERSION = "visible-chat-data-v1" as const;
export const TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1_000;

export type ToolActivationState = "active" | "inactive";
export type ToolActivationReason =
  | "deactivated"
  | "disconnected"
  | "document_replaced"
  | "expired"
  | "extension_restart"
  | "user_activated";

export interface ToolActivationDocumentBinding {
  readonly documentId: string;
  readonly generation: number;
  readonly tabId: number;
}

interface ToolActivationSnapshotBase {
  readonly disclosureVersion: typeof TOOL_ACTIVATION_DISCLOSURE_VERSION;
  readonly inactivityTimeoutMs: typeof TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS;
  readonly revision: number;
}

export interface ActiveToolActivationSnapshot extends ToolActivationSnapshotBase {
  readonly binding: ToolActivationDocumentBinding;
  readonly conversationOwnershipId: string;
  readonly expiresAtMs: number;
  readonly issuedAtMs: number;
  readonly lastActivityAtMs: number;
  readonly leaseId: string;
  readonly reason: "user_activated";
  readonly state: "active";
}

export interface InactiveToolActivationSnapshot extends ToolActivationSnapshotBase {
  readonly binding: null;
  readonly conversationOwnershipId: null;
  readonly expiresAtMs: null;
  readonly issuedAtMs: null;
  readonly lastActivityAtMs: null;
  readonly leaseId: null;
  readonly reason: Exclude<ToolActivationReason, "user_activated">;
  readonly state: "inactive";
}

export type ToolActivationSnapshot = ActiveToolActivationSnapshot | InactiveToolActivationSnapshot;

export interface ToolActivationChangedEvent {
  readonly snapshot: ToolActivationSnapshot;
  readonly type: "tool-activation/changed";
}

const ACTIVE_REASON: ToolActivationReason = "user_activated";
const INACTIVE_REASONS = new Set<ToolActivationReason>([
  "deactivated",
  "disconnected",
  "document_replaced",
  "expired",
  "extension_restart",
]);
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const LEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SNAPSHOT_KEYS = Object.freeze([
  "binding",
  "conversationOwnershipId",
  "disclosureVersion",
  "expiresAtMs",
  "inactivityTimeoutMs",
  "issuedAtMs",
  "lastActivityAtMs",
  "leaseId",
  "reason",
  "revision",
  "state",
] as const);

export function parseToolActivationSnapshot(value: unknown): ToolActivationSnapshot | undefined {
  if (!isRecordWithExactKeys(value, SNAPSHOT_KEYS)) {
    return undefined;
  }
  const state = value["state"];
  const reason = value["reason"];
  if (
    (state !== "active" && state !== "inactive") ||
    !isToolActivationReason(reason) ||
    value["disclosureVersion"] !== TOOL_ACTIVATION_DISCLOSURE_VERSION ||
    value["inactivityTimeoutMs"] !== TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS ||
    !isNonnegativeSafeInteger(value["revision"])
  ) {
    return undefined;
  }

  if (state === "inactive") {
    if (
      !INACTIVE_REASONS.has(reason) ||
      value["binding"] !== null ||
      value["conversationOwnershipId"] !== null ||
      value["expiresAtMs"] !== null ||
      value["issuedAtMs"] !== null ||
      value["lastActivityAtMs"] !== null ||
      value["leaseId"] !== null
    ) {
      return undefined;
    }
    return Object.freeze({
      binding: null,
      conversationOwnershipId: null,
      disclosureVersion: TOOL_ACTIVATION_DISCLOSURE_VERSION,
      expiresAtMs: null,
      inactivityTimeoutMs: TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS,
      issuedAtMs: null,
      lastActivityAtMs: null,
      leaseId: null,
      reason: reason as Exclude<ToolActivationReason, "user_activated">,
      revision: value["revision"],
      state,
    });
  }

  const binding = parseBinding(value["binding"]);
  const conversationOwnershipId = value["conversationOwnershipId"];
  const issuedAtMs = value["issuedAtMs"];
  const lastActivityAtMs = value["lastActivityAtMs"];
  const expiresAtMs = value["expiresAtMs"];
  const leaseId = value["leaseId"];
  if (
    reason !== ACTIVE_REASON ||
    binding === undefined ||
    typeof conversationOwnershipId !== "string" ||
    !LEASE_ID_PATTERN.test(conversationOwnershipId) ||
    !isNonnegativeSafeInteger(issuedAtMs) ||
    !isNonnegativeSafeInteger(lastActivityAtMs) ||
    !isNonnegativeSafeInteger(expiresAtMs) ||
    issuedAtMs > lastActivityAtMs ||
    lastActivityAtMs > Number.MAX_SAFE_INTEGER - TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS ||
    expiresAtMs !== lastActivityAtMs + TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS ||
    typeof leaseId !== "string" ||
    !LEASE_ID_PATTERN.test(leaseId)
  ) {
    return undefined;
  }
  return Object.freeze({
    binding,
    conversationOwnershipId,
    disclosureVersion: TOOL_ACTIVATION_DISCLOSURE_VERSION,
    expiresAtMs,
    inactivityTimeoutMs: TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS,
    issuedAtMs,
    lastActivityAtMs,
    leaseId,
    reason: "user_activated",
    revision: value["revision"],
    state,
  });
}

export function parseToolActivationChangedEvent(
  value: unknown,
): ToolActivationChangedEvent | undefined {
  if (
    !isRecordWithExactKeys(value, ["snapshot", "type"]) ||
    value["type"] !== "tool-activation/changed"
  ) {
    return undefined;
  }
  const snapshot = parseToolActivationSnapshot(value["snapshot"]);
  return snapshot === undefined
    ? undefined
    : Object.freeze({ snapshot, type: "tool-activation/changed" });
}

/**
 * Projects the extension-only consent record onto the minimal authenticated
 * status contract exposed across Native Messaging. Disclosure copy and local
 * invalidation reasons never cross that boundary.
 */
export function toAgentStatusSnapshot(snapshot: ToolActivationSnapshot): AgentStatusSnapshot {
  if (snapshot.state === "inactive") {
    return Object.freeze({ revision: snapshot.revision, state: "inactive" });
  }
  return Object.freeze({
    binding: Object.freeze({ ...snapshot.binding }),
    conversationOwnershipId: snapshot.conversationOwnershipId,
    expiresAtMs: snapshot.expiresAtMs,
    issuedAtMs: snapshot.issuedAtMs,
    lastActivityAtMs: snapshot.lastActivityAtMs,
    leaseId: snapshot.leaseId,
    revision: snapshot.revision,
    state: "active",
  });
}

/** Exact optimistic-concurrency check for a renewal request. */
export function matchesActiveAgentStatusSnapshot(
  snapshot: ActiveToolActivationSnapshot,
  expected: ActiveAgentStatusSnapshot,
): boolean {
  return (
    snapshot.binding.documentId === expected.binding.documentId &&
    snapshot.binding.generation === expected.binding.generation &&
    snapshot.binding.tabId === expected.binding.tabId &&
    snapshot.conversationOwnershipId === expected.conversationOwnershipId &&
    snapshot.expiresAtMs === expected.expiresAtMs &&
    snapshot.issuedAtMs === expected.issuedAtMs &&
    snapshot.lastActivityAtMs === expected.lastActivityAtMs &&
    snapshot.leaseId === expected.leaseId &&
    snapshot.revision === expected.revision
  );
}

function parseBinding(value: unknown): ToolActivationDocumentBinding | undefined {
  if (!isRecordWithExactKeys(value, ["documentId", "generation", "tabId"])) {
    return undefined;
  }
  const documentId = value["documentId"];
  const generation = value["generation"];
  const tabId = value["tabId"];
  if (
    typeof documentId !== "string" ||
    !DOCUMENT_ID_PATTERN.test(documentId) ||
    !isNonnegativeSafeInteger(generation) ||
    !isNonnegativeSafeInteger(tabId)
  ) {
    return undefined;
  }
  return Object.freeze({ documentId, generation, tabId });
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

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isToolActivationReason(value: unknown): value is ToolActivationReason {
  return (
    value === ACTIVE_REASON ||
    (typeof value === "string" && INACTIVE_REASONS.has(value as ToolActivationReason))
  );
}
