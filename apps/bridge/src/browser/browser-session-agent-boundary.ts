import type { ActiveAgentStatusSnapshot } from "@gpt-session-bridge/protocol";

import {
  AgentSessionCoordinatorError,
  type AgentBrowserBinding,
  type AgentBrowserTurnBoundary,
} from "./agent-session-coordinator.js";
import type { ResolvedBrowserModelRoute } from "./browser-model-catalog.js";
import type {
  BrowserSessionCoordinator,
  BrowserTurnHandle,
  BrowserTurnRequest,
  BrowserTurnSink,
} from "./browser-session-coordinator.js";

export interface BrowserSessionAgentBoundaryOptions {
  readonly coordinator: Pick<
    BrowserSessionCoordinator,
    "activeAgentStatus" | "noteAgentActivity" | "snapshot" | "startAgentTurn"
  >;
  readonly providerRoute: string;
  readonly route: ResolvedBrowserModelRoute;
}

/**
 * Binds every Web Agent round to one authenticated browser session, selected
 * model, document generation, and extension-issued consent lease.
 */
export class BrowserSessionAgentBoundary implements AgentBrowserTurnBoundary {
  readonly #coordinator: BrowserSessionAgentBoundaryOptions["coordinator"];
  readonly #providerRoute: string;
  readonly #route: ResolvedBrowserModelRoute;

  public constructor(options: BrowserSessionAgentBoundaryOptions) {
    if (
      typeof options.providerRoute !== "string" ||
      options.providerRoute.length === 0 ||
      options.route.profile !== "agent-v2"
    ) {
      throw new TypeError("Invalid browser Web Agent boundary options.");
    }
    this.#coordinator = options.coordinator;
    this.#providerRoute = options.providerRoute;
    this.#route = Object.freeze({ ...options.route });
  }

  public readBinding(): AgentBrowserBinding | undefined {
    const snapshot = this.#coordinator.snapshot;
    const activation = this.#coordinator.activeAgentStatus;
    if (
      snapshot === undefined ||
      activation === undefined ||
      snapshot.sessionId !== this.#route.sessionId ||
      snapshot.generation !== this.#route.sessionGeneration ||
      snapshot.capabilities.catalogRevision !== this.#route.catalogRevision ||
      !snapshot.capabilities.models.some((model) => model.id === this.#route.modelId)
    ) {
      return undefined;
    }
    return createBinding(this.#route, this.#providerRoute, activation);
  }

  public async noteAgentActivity(expected: AgentBrowserBinding): Promise<AgentBrowserBinding> {
    this.#assertCurrent(expected);
    const current = this.#coordinator.activeAgentStatus;
    if (current === undefined) {
      throw new AgentSessionCoordinatorError("tool_protocol_not_activated");
    }
    const renewed = await this.#coordinator.noteAgentActivity(current);
    const binding = createBinding(this.#route, this.#providerRoute, renewed);
    if (!sameStableBinding(expected, binding)) {
      throw new AgentSessionCoordinatorError("browser_state_changed");
    }
    return binding;
  }

  public startBoundTurn(
    expected: AgentBrowserBinding,
    request: BrowserTurnRequest,
    sink: BrowserTurnSink,
  ): BrowserTurnHandle {
    this.#assertCurrent(expected);
    const status = this.#coordinator.activeAgentStatus;
    if (status === undefined) {
      throw new AgentSessionCoordinatorError("tool_protocol_not_activated");
    }
    return this.#coordinator.startAgentTurn(status, request, sink);
  }

  #assertCurrent(expected: AgentBrowserBinding): void {
    const current = this.readBinding();
    if (current === undefined || !sameBinding(expected, current)) {
      throw new AgentSessionCoordinatorError("browser_state_changed");
    }
  }
}

function createBinding(
  route: ResolvedBrowserModelRoute,
  providerRoute: string,
  activation: ActiveAgentStatusSnapshot,
): AgentBrowserBinding {
  return Object.freeze({
    catalogRevision: route.catalogRevision,
    conversationOwnershipId: activation.conversationOwnershipId,
    documentGeneration: activation.binding.generation,
    documentId: activation.binding.documentId,
    expiresAtMs: activation.expiresAtMs,
    issuedAtMs: activation.issuedAtMs,
    lastActivityAtMs: activation.lastActivityAtMs,
    leaseId: activation.leaseId,
    modelId: route.modelId,
    providerRoute,
    sessionGeneration: route.sessionGeneration,
    sessionId: route.sessionId,
    tabId: activation.binding.tabId,
  });
}

function sameBinding(left: AgentBrowserBinding, right: AgentBrowserBinding): boolean {
  return (
    sameStableBinding(left, right) &&
    left.expiresAtMs === right.expiresAtMs &&
    left.lastActivityAtMs === right.lastActivityAtMs
  );
}

function sameStableBinding(left: AgentBrowserBinding, right: AgentBrowserBinding): boolean {
  return (
    left.catalogRevision === right.catalogRevision &&
    left.conversationOwnershipId === right.conversationOwnershipId &&
    left.documentGeneration === right.documentGeneration &&
    left.documentId === right.documentId &&
    left.issuedAtMs === right.issuedAtMs &&
    left.leaseId === right.leaseId &&
    left.modelId === right.modelId &&
    left.providerRoute === right.providerRoute &&
    left.sessionGeneration === right.sessionGeneration &&
    left.sessionId === right.sessionId &&
    left.tabId === right.tabId
  );
}
