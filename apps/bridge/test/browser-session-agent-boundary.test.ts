import type { ActiveAgentStatusSnapshot } from "@gpt-session-bridge/protocol";
import { describe, expect, it, vi } from "vitest";

import type { AgentSessionCoordinatorError } from "../src/browser/agent-session-coordinator.js";
import { BrowserSessionAgentBoundary } from "../src/browser/browser-session-agent-boundary.js";
import type { ResolvedBrowserModelRoute } from "../src/browser/browser-model-catalog.js";
import type {
  BrowserCapabilitySnapshot,
  BrowserTurnHandle,
} from "../src/browser/browser-session-coordinator.js";

describe("BrowserSessionAgentBoundary", () => {
  it("projects the exact authenticated session, model, document, and activation lease", () => {
    const fixture = createFixture();
    const binding = fixture.boundary.readBinding();

    expect(binding).toEqual({
      catalogRevision: "catalog-agent",
      conversationOwnershipId: "ownership-agent",
      documentGeneration: 3,
      documentId: "document-agent",
      expiresAtMs: 901_000,
      issuedAtMs: 1_000,
      lastActivityAtMs: 1_000,
      leaseId: "lease-agent",
      modelId: "web-agent-model",
      providerRoute: "gptsessionbridge/web/route-v1-provider",
      sessionGeneration: 4,
      sessionId: "session-agent",
      tabId: 7,
    });
    expect(Object.isFrozen(binding)).toBe(true);
  });

  it("accepts an exact renewal and rejects browser drift before submission", async () => {
    const fixture = createFixture();
    const binding = fixture.boundary.readBinding();
    if (binding === undefined) {
      throw new Error("Missing binding fixture.");
    }
    const renewed = activation({ expiresAtMs: 902_000, lastActivityAtMs: 2_000, revision: 2 });
    fixture.coordinator.noteAgentActivity.mockImplementation(() => {
      fixture.coordinator.activeAgentStatus = renewed;
      return Promise.resolve(renewed);
    });

    await expect(fixture.boundary.noteAgentActivity(binding)).resolves.toMatchObject({
      expiresAtMs: 902_000,
      lastActivityAtMs: 2_000,
    });

    fixture.coordinator.snapshot = snapshot({ generation: 5 });
    expect(() => fixture.boundary.startBoundTurn(binding, turnRequest(), {} as never)).toThrow(
      expect.objectContaining<Partial<AgentSessionCoordinatorError>>({
        code: "browser_state_changed",
      }),
    );
    expect(fixture.coordinator.startAgentTurn).not.toHaveBeenCalled();
  });

  it("stays unavailable without an active lease or exact selected model", () => {
    const fixture = createFixture();
    fixture.coordinator.activeAgentStatus = undefined;
    expect(fixture.boundary.readBinding()).toBeUndefined();

    fixture.coordinator.activeAgentStatus = activation();
    fixture.coordinator.snapshot = snapshot({ models: [] });
    expect(fixture.boundary.readBinding()).toBeUndefined();
  });
});

function createFixture(): {
  readonly boundary: BrowserSessionAgentBoundary;
  readonly coordinator: {
    activeAgentStatus: ActiveAgentStatusSnapshot | undefined;
    noteAgentActivity: ReturnType<typeof createNoteAgentActivityMock>;
    snapshot: BrowserCapabilitySnapshot | undefined;
    startAgentTurn: ReturnType<typeof vi.fn>;
  };
} {
  const coordinator = {
    activeAgentStatus: activation() as ActiveAgentStatusSnapshot | undefined,
    noteAgentActivity: createNoteAgentActivityMock(),
    snapshot: snapshot() as BrowserCapabilitySnapshot | undefined,
    startAgentTurn: vi.fn(() => turnHandle()),
  };
  return {
    boundary: new BrowserSessionAgentBoundary({
      coordinator,
      providerRoute: "gptsessionbridge/web/route-v1-provider",
      route: route(),
    }),
    coordinator,
  };
}

function createNoteAgentActivityMock() {
  return vi.fn((): Promise<ActiveAgentStatusSnapshot> => Promise.resolve(activation()));
}

function route(): ResolvedBrowserModelRoute {
  return {
    catalogRevision: "catalog-agent",
    defaultReasoningEffort: "medium",
    modelId: "web-agent-model",
    profile: "agent-v2",
    sessionGeneration: 4,
    sessionId: "session-agent",
  };
}

function snapshot(
  overrides: {
    readonly generation?: number;
    readonly models?: BrowserCapabilitySnapshot["capabilities"]["models"];
  } = {},
): BrowserCapabilitySnapshot {
  return {
    capabilities: {
      cancellation: true,
      catalogRevision: "catalog-agent",
      imageInput: false,
      modelDiscovery: true,
      models: overrides.models ?? [
        {
          defaultReasoningEffort: "medium",
          displayName: "Agent model",
          id: "web-agent-model",
          inputModalities: ["text"],
          supportedReasoningEfforts: [{ description: "Medium", reasoningEffort: "medium" }],
        },
      ],
      streaming: true,
      temporaryChat: false,
      toolCalls: false,
    },
    generation: overrides.generation ?? 4,
    sessionId: "session-agent",
  };
}

function activation(overrides: Partial<ActiveAgentStatusSnapshot> = {}): ActiveAgentStatusSnapshot {
  return {
    binding: { documentId: "document-agent", generation: 3, tabId: 7 },
    conversationOwnershipId: "ownership-agent",
    expiresAtMs: 901_000,
    issuedAtMs: 1_000,
    lastActivityAtMs: 1_000,
    leaseId: "lease-agent",
    revision: 1,
    state: "active",
    ...overrides,
  };
}

function turnRequest() {
  return {
    catalogRevision: "catalog-agent",
    input: [{ text: "prompt", type: "text" as const }],
    modelId: "web-agent-model",
    reasoningEffort: "medium",
    sessionGeneration: 4,
    sessionId: "session-agent",
    temporary: false,
  };
}

function turnHandle(): BrowserTurnHandle {
  return {
    cancel: () => Promise.resolve(),
    completion: Promise.resolve({ finishReason: "stop", kind: "completed" }),
    started: Promise.resolve(),
    turnId: "turn-agent",
  };
}
