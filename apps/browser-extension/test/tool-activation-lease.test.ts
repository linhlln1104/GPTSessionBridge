import { describe, expect, it } from "vitest";

import { ToolActivationLease } from "../src/activation/tool-activation-lease.js";
import {
  TOOL_ACTIVATION_DISCLOSURE_VERSION,
  TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS,
  matchesActiveAgentStatusSnapshot,
  parseToolActivationChangedEvent,
  parseToolActivationSnapshot,
  toAgentStatusSnapshot,
} from "../src/protocol/tool-activation.js";

const BINDING = Object.freeze({ documentId: "document-1", generation: 4, tabId: 7 });

describe("ToolActivationLease", () => {
  it("starts inactive after every extension runtime restart", () => {
    const { lease } = createLease();

    expect(lease.snapshot).toEqual({
      binding: null,
      conversationOwnershipId: null,
      disclosureVersion: TOOL_ACTIVATION_DISCLOSURE_VERSION,
      expiresAtMs: null,
      inactivityTimeoutMs: TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS,
      issuedAtMs: null,
      lastActivityAtMs: null,
      leaseId: null,
      reason: "extension_restart",
      revision: 0,
      state: "inactive",
    });
    expect(Object.isFrozen(lease.snapshot)).toBe(true);
  });

  it("requires the current disclosure and binds a fresh lease to one document generation", () => {
    const { lease } = createLease();
    const events: unknown[] = [];
    lease.subscribe((event) => {
      events.push(event);
    });

    expect(lease.activate(BINDING, "outdated-disclosure")).toBe(false);
    expect(lease.activate(BINDING, TOOL_ACTIVATION_DISCLOSURE_VERSION)).toBe(true);
    expect(lease.activate(BINDING, TOOL_ACTIVATION_DISCLOSURE_VERSION)).toBe(false);
    expect(lease.snapshot).toEqual({
      binding: BINDING,
      conversationOwnershipId: "ownership-1",
      disclosureVersion: TOOL_ACTIVATION_DISCLOSURE_VERSION,
      expiresAtMs: 901_000,
      inactivityTimeoutMs: TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS,
      issuedAtMs: 1_000,
      lastActivityAtMs: 1_000,
      leaseId: "lease-1",
      reason: "user_activated",
      revision: 1,
      state: "active",
    });
    expect(Object.isFrozen(lease.snapshot)).toBe(true);
    expect(Object.isFrozen(lease.snapshot.binding)).toBe(true);
    expect(events).toHaveLength(1);
    expect(parseToolActivationChangedEvent(events[0])).toEqual(events[0]);
  });

  it("expires after 15 minutes because snapshot and status reads never renew it", () => {
    const { clock, lease } = createLease();
    expect(lease.activate(BINDING, TOOL_ACTIVATION_DISCLOSURE_VERSION)).toBe(true);

    clock.advance(TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS - 1);
    expect(lease.snapshot.state).toBe("active");
    expect(lease.snapshot.expiresAtMs).toBe(901_000);

    clock.advance(1);
    expect(lease.snapshot).toMatchObject({ reason: "expired", revision: 2, state: "inactive" });
  });

  it("renews only from an admitted activity with the exact lease and document binding", () => {
    const { clock, lease } = createLease();
    expect(lease.activate(BINDING, TOOL_ACTIVATION_DISCLOSURE_VERSION)).toBe(true);
    clock.advance(300_000);
    const expected = lease.snapshot;
    expect(expected.state).toBe("active");
    if (expected.state !== "active") {
      throw new Error("Expected an active lease.");
    }

    expect(lease.noteAgentActivity({ ...expected, leaseId: "another-lease" })).toBe(false);
    expect(
      lease.noteAgentActivity({
        ...expected,
        binding: { ...BINDING, generation: BINDING.generation + 1 },
      }),
    ).toBe(false);
    expect(lease.snapshot.expiresAtMs).toBe(901_000);

    expect(lease.noteAgentActivity(expected)).toBe(true);
    expect(lease.noteAgentActivity(expected)).toBe(false);
    expect(lease.snapshot).toMatchObject({
      expiresAtMs: 1_201_000,
      lastActivityAtMs: 301_000,
      revision: 2,
      state: "active",
    });

    clock.advance(TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS);
    expect(lease.snapshot).toMatchObject({ reason: "expired", state: "inactive" });
  });

  it.each(["disconnected", "document_replaced"] as const)(
    "invalidates the active lease when the selected document is %s",
    (reason) => {
      const { lease } = createLease();
      expect(lease.activate(BINDING, TOOL_ACTIVATION_DISCLOSURE_VERSION)).toBe(true);

      expect(lease.invalidate(reason)).toBe(true);
      expect(lease.snapshot).toMatchObject({ reason, revision: 2, state: "inactive" });
      expect(lease.invalidate(reason)).toBe(false);
    },
  );

  it("supports explicit deactivation and observer unsubscription", () => {
    const { lease } = createLease();
    const reasons: string[] = [];
    const unsubscribe = lease.subscribe((event) => {
      reasons.push(event.snapshot.reason);
    });
    expect(lease.activate(BINDING, TOOL_ACTIVATION_DISCLOSURE_VERSION)).toBe(true);
    unsubscribe();
    expect(lease.deactivate()).toBe(true);
    expect(lease.deactivate()).toBe(false);

    expect(reasons).toEqual(["user_activated"]);
    expect(lease.snapshot).toMatchObject({ reason: "deactivated", state: "inactive" });
  });
});

describe("tool activation snapshot contract", () => {
  it("rejects unknown keys, mismatched expiry, unsafe time arithmetic, and private UI variants", () => {
    const valid = activeSnapshot();
    expect(parseToolActivationSnapshot(valid)).toEqual(valid);
    expect(parseToolActivationSnapshot({ ...valid, extra: true })).toBeUndefined();
    expect(
      parseToolActivationSnapshot({ ...valid, expiresAtMs: valid.expiresAtMs + 1 }),
    ).toBeUndefined();
    expect(
      parseToolActivationSnapshot({
        ...valid,
        expiresAtMs: Number.MAX_SAFE_INTEGER,
        lastActivityAtMs: Number.MAX_SAFE_INTEGER - 1,
      }),
    ).toBeUndefined();
  });

  it("rejects malformed change events", () => {
    expect(
      parseToolActivationChangedEvent({
        snapshot: activeSnapshot(),
        type: "tool-activation/changed",
      }),
    ).toBeDefined();
    expect(
      parseToolActivationChangedEvent({
        extra: true,
        snapshot: activeSnapshot(),
        type: "tool-activation/changed",
      }),
    ).toBeUndefined();
  });

  it("projects only the immutable wire binding and compares every renewal field", () => {
    const parsed = parseToolActivationSnapshot(activeSnapshot());
    expect(parsed?.state).toBe("active");
    if (parsed?.state !== "active") {
      throw new Error("Expected an active lease.");
    }
    const wire = toAgentStatusSnapshot(parsed);
    expect(wire).toEqual({
      binding: BINDING,
      conversationOwnershipId: "ownership-1",
      expiresAtMs: 901_000,
      issuedAtMs: 1_000,
      lastActivityAtMs: 1_000,
      leaseId: "lease-1",
      revision: 1,
      state: "active",
    });
    expect(wire.state).toBe("active");
    if (wire.state !== "active") {
      throw new Error("Expected active wire status.");
    }
    expect(matchesActiveAgentStatusSnapshot(parsed, wire)).toBe(true);
    expect(matchesActiveAgentStatusSnapshot(parsed, { ...wire, revision: wire.revision + 1 })).toBe(
      false,
    );
  });
});

function activeSnapshot(): Readonly<Record<string, unknown>> & {
  readonly expiresAtMs: number;
} {
  return {
    binding: BINDING,
    conversationOwnershipId: "ownership-1",
    disclosureVersion: TOOL_ACTIVATION_DISCLOSURE_VERSION,
    expiresAtMs: 901_000,
    inactivityTimeoutMs: TOOL_ACTIVATION_INACTIVITY_TIMEOUT_MS,
    issuedAtMs: 1_000,
    lastActivityAtMs: 1_000,
    leaseId: "lease-1",
    reason: "user_activated",
    revision: 1,
    state: "active",
  };
}

function createLease(): { readonly clock: FakeClock; readonly lease: ToolActivationLease } {
  const clock = new FakeClock(1_000);
  const lease = new ToolActivationLease({
    createConversationOwnershipId: () => "ownership-1",
    createLeaseId: () => "lease-1",
    now: () => clock.now,
    scheduleTimer: (callback, delayMs) => clock.schedule(callback, delayMs),
  });
  return { clock, lease };
}

class FakeClock {
  public now: number;
  readonly #timers = new Map<number, { readonly callback: () => void; readonly dueAt: number }>();
  #nextTimerId = 1;

  public constructor(now: number) {
    this.now = now;
  }

  public advance(durationMs: number): void {
    this.now += durationMs;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.dueAt <= this.now)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (due === undefined) {
        return;
      }
      this.#timers.delete(due[0]);
      due[1].callback();
    }
  }

  public schedule(callback: () => void, delayMs: number): () => void {
    const id = this.#nextTimerId;
    this.#nextTimerId += 1;
    this.#timers.set(id, { callback, dueAt: this.now + delayMs });
    return () => {
      this.#timers.delete(id);
    };
  }
}
