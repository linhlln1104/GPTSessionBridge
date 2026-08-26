import {
  TOOL_ACTIVATION_DISCLOSURE_VERSION,
  TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS,
  parseToolActivationSnapshot,
  type ActiveToolActivationSnapshot,
  type ToolActivationChangedEvent,
  type ToolActivationDocumentBinding,
  type ToolActivationReason,
  type ToolActivationSnapshot,
} from "../protocol/tool-activation.js";

export type ToolActivationListener = (event: ToolActivationChangedEvent) => void;

export interface ToolActivationLeaseOptions {
  readonly createConversationOwnershipId: () => string;
  readonly createLeaseId: () => string;
  readonly now: () => number;
  readonly scheduleTimer: (callback: () => void, delayMs: number) => () => void;
}

export class ToolActivationLease {
  readonly #createConversationOwnershipId: () => string;
  readonly #createLeaseId: () => string;
  readonly #listeners = new Set<ToolActivationListener>();
  readonly #now: () => number;
  readonly #scheduleTimer: (callback: () => void, delayMs: number) => () => void;
  #cancelScheduledExpiry: (() => void) | undefined;
  #lastObservedNow = 0;
  #snapshot: ToolActivationSnapshot;

  public constructor(options: ToolActivationLeaseOptions) {
    this.#createConversationOwnershipId = options.createConversationOwnershipId;
    this.#createLeaseId = options.createLeaseId;
    this.#now = options.now;
    this.#scheduleTimer = options.scheduleTimer;
    this.#snapshot = createInactiveSnapshot("extension_restart", 0);
  }

  public get snapshot(): ToolActivationSnapshot {
    this.#expireIfDue();
    return this.#snapshot;
  }

  public activate(
    binding: ToolActivationDocumentBinding,
    acceptedDisclosureVersion: string,
  ): boolean {
    this.#expireIfDue();
    if (
      this.#snapshot.state === "active" ||
      acceptedDisclosureVersion !== TOOL_ACTIVATION_DISCLOSURE_VERSION
    ) {
      return false;
    }

    const now = this.#readNow();
    const next = parseToolActivationSnapshot({
      binding,
      conversationOwnershipId: this.#createConversationOwnershipId(),
      disclosureVersion: TOOL_ACTIVATION_DISCLOSURE_VERSION,
      expiresAtMs: now + TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS,
      inactivityTimeoutMs: TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS,
      issuedAtMs: now,
      lastActivityAtMs: now,
      leaseId: this.#createLeaseId(),
      reason: "user_activated",
      revision: this.#snapshot.revision + 1,
      state: "active",
    });
    if (next === undefined) {
      return false;
    }
    this.#replace(next);
    return true;
  }

  public deactivate(): boolean {
    this.#expireIfDue();
    if (this.#snapshot.state !== "active") {
      return false;
    }
    this.#replace(createInactiveSnapshot("deactivated", this.#snapshot.revision + 1));
    return true;
  }

  public invalidate(reason: "disconnected" | "document_replaced"): boolean {
    this.#expireIfDue();
    if (this.#snapshot.state !== "active") {
      return false;
    }
    this.#replace(createInactiveSnapshot(reason, this.#snapshot.revision + 1));
    return true;
  }

  /**
   * Renews inactivity only for admitted v2 workflow activity against the exact
   * lease and document binding. UI, status, and passive transport requests must
   * never call this method.
   */
  public noteAgentActivity(expected: ActiveToolActivationSnapshot): boolean {
    this.#expireIfDue();
    const current = this.#snapshot;
    if (current.state !== "active" || !sameActiveSnapshot(current, expected)) {
      return false;
    }

    const now = Math.max(this.#readNow(), current.lastActivityAtMs);
    const next = parseToolActivationSnapshot({
      ...current,
      expiresAtMs: now + TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS,
      lastActivityAtMs: now,
      revision: current.revision + 1,
    });
    if (next === undefined) {
      return false;
    }
    this.#replace(next);
    return true;
  }

  public subscribe(listener: ToolActivationListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #expireIfDue(): boolean {
    const current = this.#snapshot;
    if (current.state === "active" && this.#readNow() >= current.expiresAtMs) {
      this.#replace(createInactiveSnapshot("expired", current.revision + 1));
      return true;
    }
    return false;
  }

  #readNow(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("The tool activation clock returned an invalid timestamp.");
    }
    this.#lastObservedNow = Math.max(this.#lastObservedNow, value);
    return this.#lastObservedNow;
  }

  #replace(snapshot: ToolActivationSnapshot): void {
    if (this.#cancelScheduledExpiry !== undefined) {
      this.#cancelScheduledExpiry();
      this.#cancelScheduledExpiry = undefined;
    }
    this.#snapshot = snapshot;
    this.#scheduleCurrentExpiry();
    const event = Object.freeze({ snapshot, type: "tool-activation/changed" } as const);
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // One local observer cannot prevent lease expiry or other observers.
      }
    }
  }

  #scheduleCurrentExpiry(): void {
    const current = this.#snapshot;
    if (current.state !== "active" || this.#cancelScheduledExpiry !== undefined) {
      return;
    }
    const delayMs = Math.max(0, current.expiresAtMs - this.#readNow());
    this.#cancelScheduledExpiry = this.#scheduleTimer(() => {
      this.#cancelScheduledExpiry = undefined;
      if (!this.#expireIfDue()) {
        this.#scheduleCurrentExpiry();
      }
    }, delayMs);
  }
}

function createInactiveSnapshot(
  reason: Exclude<ToolActivationReason, "user_activated">,
  revision: number,
): ToolActivationSnapshot {
  const snapshot = parseToolActivationSnapshot({
    binding: null,
    conversationOwnershipId: null,
    disclosureVersion: TOOL_ACTIVATION_DISCLOSURE_VERSION,
    expiresAtMs: null,
    inactivityTimeoutMs: TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS,
    issuedAtMs: null,
    lastActivityAtMs: null,
    leaseId: null,
    reason,
    revision,
    state: "inactive",
  });
  if (snapshot === undefined) {
    throw new Error("The tool activation state is invalid.");
  }
  return snapshot;
}

function sameActiveSnapshot(
  left: ActiveToolActivationSnapshot,
  right: ActiveToolActivationSnapshot,
): boolean {
  return (
    left.binding.documentId === right.binding.documentId &&
    left.binding.generation === right.binding.generation &&
    left.binding.tabId === right.binding.tabId &&
    left.conversationOwnershipId === right.conversationOwnershipId &&
    left.expiresAtMs === right.expiresAtMs &&
    left.inactivityTimeoutMs === right.inactivityTimeoutMs &&
    left.issuedAtMs === right.issuedAtMs &&
    left.lastActivityAtMs === right.lastActivityAtMs &&
    left.leaseId === right.leaseId &&
    left.revision === right.revision
  );
}
