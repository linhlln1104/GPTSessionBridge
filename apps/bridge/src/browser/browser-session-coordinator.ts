import { randomBytes } from "node:crypto";

import {
  AGENT_WORKFLOW_PROTOCOL_VERSION,
  BRIDGE_ERROR_CODES,
  NATIVE_MESSAGING_PROTOCOL_VERSION,
  activeAgentStatusSnapshotSchema,
  agentTurnStartFrameSchema,
  agentStatusSnapshotSchema,
  bridgeErrorSchema,
  browserCapabilitiesSchema,
  nativeMessagingFrameSchema,
  requestIdSchema,
  sessionIdSchema,
  turnCancelFrameSchema,
  turnIdSchema,
  turnStartFrameSchema,
  type BridgeError,
  type BrowserCapabilities,
  type ActiveAgentStatusSnapshot,
  type AgentStatusSnapshot,
  type NativeMessagingFrame,
  type NativeMessagingFrameOf,
  type SessionCloseReason,
  type TurnDeltaChannel,
  type TurnFinishReason,
} from "@gpt-session-bridge/protocol";

import type {
  BrowserApplicationMessage,
  BrowserApplicationPort,
  BrowserCommandType,
} from "./browser-application-port.js";
import {
  BrowserSessionError,
  createBrowserSessionError,
  freezeBridgeError,
} from "./browser-session-errors.js";

export type BrowserSessionPhase =
  "closed" | "connecting" | "disconnected" | "disconnecting" | "discoveringCapabilities" | "ready";

export type BrowserTransportPhase = "attached" | "closed" | "detached";
export type BrowserTurnPhase = "cancelling" | "starting" | "streaming";

export interface BrowserSessionCoordinatorState {
  readonly activeTurn?: BrowserTurnPhase;
  readonly session: BrowserSessionPhase;
  readonly transport: BrowserTransportPhase;
}

export interface BrowserCapabilitySnapshot {
  readonly capabilities: BrowserCapabilities;
  readonly generation: number;
  readonly sessionId: string;
}

export interface BrowserAgentActivationAvailability {
  readonly active: boolean;
}

export interface BrowserTurnRequest {
  readonly catalogRevision: string;
  readonly input: NativeMessagingFrameOf<"turn/start">["payload"]["input"];
  readonly modelId: string;
  readonly reasoningEffort: string;
  readonly sessionGeneration: number;
  readonly sessionId: string;
  readonly temporary: boolean;
}

export interface BrowserTurnDelta {
  readonly channel: TurnDeltaChannel;
  readonly delta: string;
}

export interface BrowserTurnSink {
  onDelta(delta: BrowserTurnDelta): Promise<void> | void;
}

export type BrowserTurnTerminal =
  | { readonly finishReason: TurnFinishReason; readonly kind: "completed" }
  | { readonly kind: "cancelled" }
  | { readonly error: BridgeError; readonly kind: "failed" };

export interface BrowserTurnHandle {
  readonly completion: Promise<BrowserTurnTerminal>;
  readonly started: Promise<void>;
  readonly turnId: string;

  cancel(): Promise<void>;
}

export interface BrowserTransportLease {
  readonly generation: number;
}

export interface BrowserSessionTimer {
  cancel(): void;
}

export interface BrowserSessionScheduler {
  schedule(delayMs: number, callback: () => void): BrowserSessionTimer;
}

export type BrowserIdentifierKind = "request" | "session" | "turn";

export interface BrowserSessionCoordinatorOptions {
  readonly cancellationGraceMs?: number;
  readonly commandTimeoutMs?: number;
  readonly createIdentifier?: (kind: BrowserIdentifierKind) => string;
  readonly maxCatalogRevisions?: number;
  readonly maxPendingOperations?: number;
  readonly now?: () => number;
  readonly scheduler?: BrowserSessionScheduler;
  readonly turnTimeoutMs?: number;
}

interface NormalizedOptions {
  readonly cancellationGraceMs: number;
  readonly commandTimeoutMs: number;
  readonly createIdentifier: (kind: BrowserIdentifierKind) => string;
  readonly maxCatalogRevisions: number;
  readonly maxPendingOperations: number;
  readonly now: () => number;
  readonly scheduler: BrowserSessionScheduler;
  readonly turnTimeoutMs: number;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly reject: (reason: BrowserSessionError) => void;
  readonly resolve: (value: Value) => void;
  readonly settled: () => boolean;
}

type PendingOperation =
  | PendingSessionOperation<"agent-activity-note">
  | PendingSessionOperation<"agent-status-read">
  | PendingSessionOperation<"capabilities-read">
  | PendingSessionOperation<"session-connect">
  | PendingSessionOperation<"session-disconnect">
  | PendingTurnOperation<"turn-cancel">
  | PendingTurnOperation<"turn-start">;

type PendingOperationInput<Operation = PendingOperation> = Operation extends PendingOperation
  ? Omit<Operation, "timer">
  : never;

interface PendingSessionOperation<Kind extends string> {
  readonly kind: Kind;
  readonly requestId: string;
  readonly sessionId: string;
  readonly timer: BrowserSessionTimer;
}

interface PendingTurnOperation<Kind extends string> extends PendingSessionOperation<Kind> {
  readonly turnId: string;
}

interface ConnectionAttempt {
  readonly deferred: Deferred<BrowserCapabilitySnapshot>;
  readonly sessionId: string;
}

interface DisconnectAttempt {
  readonly deferred: Deferred<undefined>;
  readonly requestId: string;
  readonly sessionId: string;
}

interface AgentStatusReadAttempt {
  readonly deferred: Deferred<AgentStatusSnapshot>;
  readonly requestId: string;
  readonly sessionId: string;
}

interface AgentActivityAttempt {
  readonly deferred: Deferred<ActiveAgentStatusSnapshot>;
  readonly expected: ActiveAgentStatusSnapshot;
  readonly requestId: string;
  readonly sessionId: string;
}

interface ActiveTurn {
  readonly cancellationSupported: boolean;
  cancelAttempt?: {
    readonly deferred: Deferred<undefined>;
    readonly previousPhase: BrowserTurnPhase;
    readonly reason: "timeout" | "user";
    readonly requestId: string;
  };
  readonly completion: Deferred<BrowserTurnTerminal>;
  readonly sessionId: string;
  readonly sink: BrowserTurnSink;
  readonly startRequestId: string;
  readonly started: Deferred<undefined>;
  startedAcknowledged: boolean;
  phase: BrowserTurnPhase;
  settled: boolean;
  turnTimer?: BrowserSessionTimer;
  readonly turnId: string;
}

const DEFAULT_CANCELLATION_GRACE_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CATALOG_REVISIONS = 32;
const DEFAULT_MAX_PENDING_OPERATIONS = 8;
const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const IDENTIFIER_BYTES = 18;
const IDENTIFIER_GENERATION_ATTEMPTS = 8;
const MAX_RECENT_IDENTIFIERS = 2_048;

const DEFAULT_SCHEDULER: BrowserSessionScheduler = Object.freeze({
  schedule(delayMs: number, callback: () => void): BrowserSessionTimer {
    const timeout = setTimeout(callback, delayMs);
    timeout.unref();
    return Object.freeze({
      cancel(): void {
        clearTimeout(timeout);
      },
    });
  },
});

const EMPTY_SINK: BrowserTurnSink = Object.freeze({
  onDelta(): undefined {
    return undefined;
  },
});

/**
 * Owns browser-session application state after an authenticated transport has
 * completed its link handshake. It never queues a prompt for a missing peer.
 */
export class BrowserSessionCoordinator {
  readonly #options: NormalizedOptions;
  readonly #pending = new Map<string, PendingOperation>();
  readonly #receivingLeases = new WeakSet<object>();
  readonly #recentIdentifiers = new Set<string>();
  readonly #revisionFingerprints = new Map<string, string>();
  #activeTurn: ActiveTurn | undefined;
  #agentActivityAttempt: AgentActivityAttempt | undefined;
  #agentStatus: AgentStatusSnapshot | undefined;
  #agentStatusReadAttempt: AgentStatusReadAttempt | undefined;
  #closed = false;
  #connectionAttempt: ConnectionAttempt | undefined;
  #disconnectAttempt: DisconnectAttempt | undefined;
  #lease: BrowserTransportLease | undefined;
  #nextLeaseGeneration = 1;
  #nextSnapshotGeneration = 1;
  #port: BrowserApplicationPort | undefined;
  #sessionId: string | undefined;
  #sessionPhase: BrowserSessionPhase = "disconnected";
  #snapshot: BrowserCapabilitySnapshot | undefined;

  public constructor(options: BrowserSessionCoordinatorOptions = {}) {
    this.#options = Object.freeze({
      cancellationGraceMs: readPositiveInteger(
        options.cancellationGraceMs,
        DEFAULT_CANCELLATION_GRACE_MS,
      ),
      commandTimeoutMs: readPositiveInteger(options.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS),
      createIdentifier: options.createIdentifier ?? createRandomIdentifier,
      maxCatalogRevisions: readPositiveInteger(
        options.maxCatalogRevisions,
        DEFAULT_MAX_CATALOG_REVISIONS,
      ),
      maxPendingOperations: readPositiveInteger(
        options.maxPendingOperations,
        DEFAULT_MAX_PENDING_OPERATIONS,
      ),
      now: options.now ?? Date.now,
      scheduler: options.scheduler ?? DEFAULT_SCHEDULER,
      turnTimeoutMs: readPositiveInteger(options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS),
    });
    if (
      typeof this.#options.createIdentifier !== "function" ||
      typeof this.#options.now !== "function" ||
      !isScheduler(this.#options.scheduler)
    ) {
      throw new RangeError("Invalid browser session coordinator options");
    }
  }

  public get snapshot(): BrowserCapabilitySnapshot | undefined {
    return this.#snapshot;
  }

  public get agentActivation(): BrowserAgentActivationAvailability {
    return Object.freeze({ active: this.activeAgentStatus !== undefined });
  }

  public get agentStatus(): AgentStatusSnapshot | undefined {
    return this.#agentStatus;
  }

  public get activeAgentStatus(): ActiveAgentStatusSnapshot | undefined {
    const status = this.#agentStatus;
    return status?.state === "active" && this.#readNow() < status.expiresAtMs ? status : undefined;
  }

  public get state(): BrowserSessionCoordinatorState {
    const transport: BrowserTransportPhase = this.#closed
      ? "closed"
      : this.#port === undefined
        ? "detached"
        : "attached";
    return Object.freeze({
      ...(this.#activeTurn === undefined ? {} : { activeTurn: this.#activeTurn.phase }),
      session: this.#sessionPhase,
      transport,
    });
  }

  public attach(port: BrowserApplicationPort): BrowserTransportLease {
    if (this.#closed) {
      throw createBrowserSessionError(
        BRIDGE_ERROR_CODES.SESSION_CLOSED,
        "The browser session coordinator is closed.",
        false,
      );
    }
    if (this.#port !== undefined || !isApplicationPort(port)) {
      throw createBrowserSessionError(
        BRIDGE_ERROR_CODES.TRANSPORT_UNAVAILABLE,
        "A browser transport is already attached or invalid.",
        false,
      );
    }

    const lease = Object.freeze({ generation: this.#nextLeaseGeneration });
    this.#nextLeaseGeneration += 1;
    this.#lease = lease;
    this.#port = port;
    return lease;
  }

  public detach(lease: BrowserTransportLease): boolean {
    if (lease !== this.#lease) {
      return false;
    }
    this.#teardownTransport(
      createBrowserSessionError(
        BRIDGE_ERROR_CODES.TRANSPORT_UNAVAILABLE,
        "The authenticated browser transport was disconnected.",
        true,
      ),
      false,
    );
    return true;
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#teardownTransport(
      createBrowserSessionError(
        BRIDGE_ERROR_CODES.SESSION_CLOSED,
        "The browser session coordinator was closed.",
        false,
      ),
      true,
    );
    this.#sessionPhase = "closed";
  }

  public connect(): Promise<BrowserCapabilitySnapshot> {
    this.#assertAttached();
    if (this.#sessionPhase !== "disconnected") {
      throw createBrowserSessionError(
        BRIDGE_ERROR_CODES.SESSION_ALREADY_CONNECTED,
        "A browser session is already active or being established.",
        false,
      );
    }

    const sessionId = this.#createIdentifier("session");
    const requestId = this.#createIdentifier("request");
    const deferred = createDeferred<BrowserCapabilitySnapshot>();
    this.#connectionAttempt = { deferred, sessionId };
    this.#sessionId = sessionId;
    this.#sessionPhase = "connecting";

    try {
      this.#reservePending(
        {
          kind: "session-connect",
          requestId,
          sessionId,
        },
        this.#options.commandTimeoutMs,
      );
      this.#send({
        payload: { sessionId },
        requestId,
        type: "session/connect",
      });
    } catch (error) {
      const normalized = normalizeLocalError(error);
      this.#resetSession(normalized, false);
      throw normalized;
    }

    return deferred.promise;
  }

  public disconnect(reason: SessionCloseReason = "user"): Promise<void> {
    if (this.#sessionPhase === "disconnected") {
      return Promise.resolve();
    }
    this.#assertAttached();
    if (this.#sessionPhase === "closed" || this.#sessionId === undefined) {
      return rejectedPromise(
        createBrowserSessionError(
          BRIDGE_ERROR_CODES.SESSION_CLOSED,
          "The browser session is closed.",
          false,
        ),
      );
    }
    if (this.#disconnectAttempt !== undefined) {
      return this.#disconnectAttempt.deferred.promise;
    }

    const requestId = this.#createIdentifier("request");
    const deferred = createDeferred<undefined>();
    const sessionId = this.#sessionId;
    this.#disconnectAttempt = { deferred, requestId, sessionId };
    this.#sessionPhase = "disconnecting";
    if (this.#connectionAttempt !== undefined) {
      this.#connectionAttempt.deferred.reject(
        createBrowserSessionError(
          BRIDGE_ERROR_CODES.SESSION_CLOSED,
          "The browser session connection was cancelled.",
          false,
        ),
      );
      this.#connectionAttempt = undefined;
    }

    try {
      this.#reservePending(
        {
          kind: "session-disconnect",
          requestId,
          sessionId,
        },
        this.#options.commandTimeoutMs,
      );
      this.#send({
        payload: { reason, sessionId },
        requestId,
        type: "session/disconnect",
      });
    } catch (error) {
      const normalized = normalizeLocalError(error);
      this.#teardownTransport(normalized, true);
    }

    return deferred.promise;
  }

  public refreshAgentStatus(): Promise<AgentStatusSnapshot> {
    this.#assertAttached();
    if (this.#sessionPhase !== "ready" || this.#sessionId === undefined) {
      return rejectedPromise(
        createBrowserSessionError(
          BRIDGE_ERROR_CODES.SESSION_NOT_CONNECTED,
          "No ready browser session is connected.",
          true,
        ),
      );
    }
    if (this.#agentStatusReadAttempt !== undefined) {
      return this.#agentStatusReadAttempt.deferred.promise;
    }

    const requestId = this.#createIdentifier("request");
    const deferred = createDeferred<AgentStatusSnapshot>();
    const sessionId = this.#sessionId;
    this.#agentStatusReadAttempt = { deferred, requestId, sessionId };
    try {
      this.#reservePending(
        { kind: "agent-status-read", requestId, sessionId },
        this.#options.commandTimeoutMs,
      );
      this.#send({ payload: { sessionId }, requestId, type: "agent/status/read" });
    } catch (error) {
      const normalized = normalizeLocalError(error);
      this.#removePending(requestId);
      this.#agentStatusReadAttempt = undefined;
      deferred.reject(normalized);
    }
    return deferred.promise;
  }

  public noteAgentActivity(
    expected: ActiveAgentStatusSnapshot,
  ): Promise<ActiveAgentStatusSnapshot> {
    this.#assertAttached();
    const current = this.activeAgentStatus;
    let normalizedExpected: ActiveAgentStatusSnapshot;
    try {
      normalizedExpected = freezeActiveAgentStatus(activeAgentStatusSnapshotSchema.parse(expected));
    } catch {
      return rejectedPromise(browserStateChanged("The Web Agent activation lease is invalid."));
    }
    if (current === undefined || !sameActiveAgentStatus(current, normalizedExpected)) {
      return rejectedPromise(browserStateChanged("The Web Agent activation lease is stale."));
    }
    if (this.#sessionPhase !== "ready" || this.#sessionId === undefined) {
      return rejectedPromise(
        createBrowserSessionError(
          BRIDGE_ERROR_CODES.SESSION_NOT_CONNECTED,
          "No ready browser session is connected.",
          true,
        ),
      );
    }
    if (this.#agentActivityAttempt !== undefined) {
      return sameActiveAgentStatus(this.#agentActivityAttempt.expected, normalizedExpected)
        ? this.#agentActivityAttempt.deferred.promise
        : rejectedPromise(browserStateChanged("Another Web Agent lease renewal is active."));
    }

    const requestId = this.#createIdentifier("request");
    const deferred = createDeferred<ActiveAgentStatusSnapshot>();
    const sessionId = this.#sessionId;
    this.#agentActivityAttempt = {
      deferred,
      expected: normalizedExpected,
      requestId,
      sessionId,
    };
    try {
      this.#reservePending(
        { kind: "agent-activity-note", requestId, sessionId },
        this.#options.commandTimeoutMs,
      );
      this.#send({
        payload: { expected: normalizedExpected, sessionId },
        requestId,
        type: "agent/activity/note",
      });
    } catch (error) {
      const normalized = normalizeLocalError(error);
      this.#removePending(requestId);
      this.#agentActivityAttempt = undefined;
      deferred.reject(normalized);
    }
    return deferred.promise;
  }

  public startTurn(
    request: BrowserTurnRequest,
    sink: BrowserTurnSink = EMPTY_SINK,
  ): BrowserTurnHandle {
    return this.#startTurn(request, sink);
  }

  public startAgentTurn(
    expected: ActiveAgentStatusSnapshot,
    request: BrowserTurnRequest,
    sink: BrowserTurnSink = EMPTY_SINK,
  ): BrowserTurnHandle {
    let normalizedExpected: ActiveAgentStatusSnapshot;
    try {
      normalizedExpected = freezeActiveAgentStatus(activeAgentStatusSnapshotSchema.parse(expected));
    } catch {
      throw browserStateChanged("The Web Agent activation lease is invalid.");
    }
    return this.#startTurn(request, sink, normalizedExpected);
  }

  #startTurn(
    request: BrowserTurnRequest,
    sink: BrowserTurnSink,
    expectedAgentStatus?: ActiveAgentStatusSnapshot,
  ): BrowserTurnHandle {
    this.#assertAttached();
    const snapshot = this.#snapshot;
    if (this.#sessionPhase !== "ready" || snapshot === undefined) {
      throw createBrowserSessionError(
        BRIDGE_ERROR_CODES.SESSION_NOT_CONNECTED,
        "No ready browser session is connected.",
        true,
      );
    }
    if (this.#activeTurn !== undefined) {
      throw createBrowserSessionError(
        BRIDGE_ERROR_CODES.TURN_ALREADY_ACTIVE,
        "A browser turn is already active.",
        true,
      );
    }
    if (expectedAgentStatus !== undefined) {
      const current = this.activeAgentStatus;
      if (current === undefined || !sameActiveAgentStatus(current, expectedAgentStatus)) {
        throw browserStateChanged("The Web Agent activation lease is stale.");
      }
      if (request.temporary) {
        throw createBrowserSessionError(
          BRIDGE_ERROR_CODES.CAPABILITY_UNSUPPORTED,
          "Temporary Web Agent turns are unsupported.",
          false,
        );
      }
    }
    if (!isTurnSink(sink)) {
      throw createBrowserSessionError(
        BRIDGE_ERROR_CODES.INTERNAL_ERROR,
        "The browser turn consumer is invalid.",
        false,
      );
    }

    if (
      request.sessionId !== snapshot.sessionId ||
      request.sessionGeneration !== snapshot.generation
    ) {
      throw createBrowserSessionError(
        BRIDGE_ERROR_CODES.BROWSER_STATE_CHANGED,
        "The selected browser session is stale.",
        true,
      );
    }
    this.#assertTurnCapabilities(snapshot.capabilities, request);
    const requestId = this.#createIdentifier("request");
    const turnId = this.#createIdentifier("turn");
    const frameBase = {
      protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
      requestId,
      sequence: 0,
    } as const;
    const parsed =
      expectedAgentStatus === undefined
        ? turnStartFrameSchema.safeParse({
            ...frameBase,
            payload: {
              catalogRevision: request.catalogRevision,
              input: request.input,
              modelId: request.modelId,
              reasoningEffort: request.reasoningEffort,
              sessionId: snapshot.sessionId,
              temporary: request.temporary,
              turnId,
            },
            type: "turn/start",
          })
        : agentTurnStartFrameSchema.safeParse({
            ...frameBase,
            payload: {
              agentProtocolVersion: AGENT_WORKFLOW_PROTOCOL_VERSION,
              catalogRevision: request.catalogRevision,
              expected: expectedAgentStatus,
              input: request.input,
              modelId: request.modelId,
              reasoningEffort: request.reasoningEffort,
              sessionId: snapshot.sessionId,
              temporary: false,
              turnId,
            },
            type: "agent/turn/start",
          });
    if (!parsed.success) {
      throw createBrowserSessionError(
        BRIDGE_ERROR_CODES.PROTOCOL_INVALID_MESSAGE,
        "The browser turn request is invalid.",
        false,
      );
    }

    const active: ActiveTurn = {
      cancellationSupported: snapshot.capabilities.cancellation,
      completion: createDeferred<BrowserTurnTerminal>(),
      phase: "starting",
      sessionId: snapshot.sessionId,
      settled: false,
      sink,
      started: createDeferred<undefined>(),
      startedAcknowledged: false,
      startRequestId: requestId,
      turnId,
    };
    this.#activeTurn = active;

    try {
      this.#reservePending(
        {
          kind: "turn-start",
          requestId,
          sessionId: active.sessionId,
          turnId,
        },
        this.#options.commandTimeoutMs,
      );
      if (parsed.data.type === "agent/turn/start") {
        this.#send({
          payload: freezeAgentTurnStartPayload(parsed.data.payload),
          requestId,
          type: "agent/turn/start",
        });
      } else {
        this.#send({
          payload: freezeTurnStartPayload(parsed.data.payload),
          requestId,
          type: "turn/start",
        });
      }
    } catch (error) {
      const normalized = normalizeLocalError(error);
      this.#settleActiveTurn(active, { error: normalized.bridgeError, kind: "failed" }, normalized);
      throw normalized;
    }

    return Object.freeze({
      cancel: () => this.#cancelTurn(turnId),
      completion: active.completion.promise,
      started: active.started.promise,
      turnId,
    });
  }

  public async receive(lease: BrowserTransportLease, value: unknown): Promise<boolean> {
    if (lease !== this.#lease || this.#port === undefined) {
      return false;
    }
    const leaseObject = lease as object;
    if (this.#receivingLeases.has(leaseObject)) {
      const error = protocolViolation("Concurrent browser frame delivery is not allowed.");
      this.#teardownTransport(error, true);
      throw error;
    }
    this.#receivingLeases.add(leaseObject);

    try {
      const parsed = nativeMessagingFrameSchema.safeParse(value);
      if (!parsed.success) {
        throw protocolViolation("The browser sent an invalid protocol frame.");
      }
      await this.#dispatch(lease, parsed.data);
      return lease === this.#lease;
    } catch (error) {
      const normalized = normalizeLocalError(error);
      if (lease === this.#lease) {
        this.#teardownTransport(normalized, true);
      }
      throw normalized;
    } finally {
      this.#receivingLeases.delete(leaseObject);
    }
  }

  async #dispatch(lease: BrowserTransportLease, frame: NativeMessagingFrame): Promise<void> {
    switch (frame.type) {
      case "session/connected":
        this.#handleSessionConnected(frame);
        return;
      case "session/disconnected":
        this.#handleSessionDisconnected(frame);
        return;
      case "capabilities/result":
        this.#handleCapabilitiesResult(frame);
        return;
      case "capabilities/changed":
        this.#handleCapabilitiesChanged(frame);
        return;
      case "agent/status/result":
        this.#handleAgentStatusResult(frame);
        return;
      case "agent/status/changed":
        this.#handleAgentStatusChanged(frame);
        return;
      case "agent/activity/result":
        this.#handleAgentActivityResult(frame);
        return;
      case "turn/started":
        this.#handleTurnStarted(frame);
        return;
      case "turn/delta":
        await this.#handleTurnDelta(lease, frame);
        return;
      case "turn/completed":
        this.#handleTurnCompleted(frame);
        return;
      case "turn/cancelled":
        this.#handleTurnCancelled(frame);
        return;
      case "turn/failed":
        this.#handleTurnFailed(frame);
        return;
      case "error":
        this.#handleRemoteError(frame);
        return;
      case "ack":
      case "agent/activity/note":
      case "agent/status/read":
      case "agent/turn/start":
      case "capabilities/read":
      case "heartbeat":
      case "hello":
      case "hello/acknowledged":
      case "session/connect":
      case "session/disconnect":
      case "turn/cancel":
      case "turn/start":
        throw protocolViolation("The browser sent a frame in the wrong direction.");
    }
  }

  #handleSessionConnected(frame: NativeMessagingFrameOf<"session/connected">): void {
    const pending = this.#expectPending(frame.requestId, "session-connect");
    this.#assertSessionIdentity(pending.sessionId, frame.payload.sessionId);
    if (this.#sessionPhase !== "connecting" && this.#sessionPhase !== "disconnecting") {
      throw protocolViolation("The browser connected in an invalid session state.");
    }
    this.#removePending(frame.requestId);
    if (this.#sessionPhase === "disconnecting") {
      return;
    }

    const requestId = this.#createIdentifier("request");
    this.#sessionPhase = "discoveringCapabilities";
    this.#reservePending(
      {
        kind: "capabilities-read",
        requestId,
        sessionId: frame.payload.sessionId,
      },
      this.#options.commandTimeoutMs,
    );
    this.#send({
      payload: { sessionId: frame.payload.sessionId },
      requestId,
      type: "capabilities/read",
    });
  }

  #handleSessionDisconnected(frame: NativeMessagingFrameOf<"session/disconnected">): void {
    if (this.#sessionId === undefined || this.#sessionPhase === "disconnected") {
      throw protocolViolation("The browser disconnected an unknown session.");
    }
    this.#assertSessionIdentity(this.#sessionId, frame.payload.sessionId);
    const retryable =
      frame.payload.reason === "pageUnavailable" ||
      frame.payload.reason === "replaced" ||
      frame.payload.reason === "transportLost";
    this.#resetSession(
      createBrowserSessionError(
        BRIDGE_ERROR_CODES.SESSION_CLOSED,
        "The connected browser session ended.",
        retryable,
      ),
      true,
    );
  }

  #handleCapabilitiesResult(frame: NativeMessagingFrameOf<"capabilities/result">): void {
    const pending = this.#expectPending(frame.requestId, "capabilities-read");
    this.#assertSessionIdentity(pending.sessionId, frame.payload.sessionId);
    if (
      this.#sessionPhase !== "discoveringCapabilities" &&
      this.#sessionPhase !== "disconnecting"
    ) {
      throw protocolViolation("Browser capabilities arrived in an invalid session state.");
    }
    this.#removePending(frame.requestId);
    if (this.#sessionPhase === "disconnecting") {
      return;
    }

    const snapshot = this.#installCapabilities(frame.payload.capabilities);
    this.#sessionPhase = "ready";
    const attempt = this.#connectionAttempt;
    if (attempt?.sessionId !== snapshot.sessionId) {
      throw protocolViolation("The browser capability result has no connection request.");
    }
    this.#connectionAttempt = undefined;
    attempt.deferred.resolve(snapshot);
    try {
      void this.refreshAgentStatus().catch(() => undefined);
    } catch {
      // Agent status remains fail-closed while normal text turns stay available.
    }
  }

  #handleCapabilitiesChanged(frame: NativeMessagingFrameOf<"capabilities/changed">): void {
    if (this.#sessionId === undefined) {
      throw protocolViolation("Browser capabilities changed for an unknown session.");
    }
    this.#assertSessionIdentity(this.#sessionId, frame.payload.sessionId);
    if (this.#sessionPhase === "disconnecting") {
      return;
    }
    if (this.#sessionPhase !== "ready") {
      throw protocolViolation("Browser capabilities changed before discovery completed.");
    }
    this.#installCapabilities(frame.payload.capabilities);
  }

  #handleAgentStatusResult(frame: NativeMessagingFrameOf<"agent/status/result">): void {
    const pending = this.#expectPending(frame.requestId, "agent-status-read");
    this.#assertSessionIdentity(pending.sessionId, frame.payload.sessionId);
    const attempt = this.#agentStatusReadAttempt;
    if (attempt?.requestId !== frame.requestId || attempt.sessionId !== frame.payload.sessionId) {
      throw protocolViolation("The Web Agent status response is not correlated.");
    }
    this.#removePending(frame.requestId);
    this.#agentStatusReadAttempt = undefined;
    const status = this.#installAgentStatus(frame.payload.status);
    attempt.deferred.resolve(status);
  }

  #handleAgentStatusChanged(frame: NativeMessagingFrameOf<"agent/status/changed">): void {
    if (this.#sessionId === undefined || this.#sessionPhase === "disconnected") {
      throw protocolViolation("Web Agent status changed for an unknown session.");
    }
    this.#assertSessionIdentity(this.#sessionId, frame.payload.sessionId);
    if (this.#sessionPhase !== "disconnecting") {
      this.#installAgentStatus(frame.payload.status);
    }
  }

  #handleAgentActivityResult(frame: NativeMessagingFrameOf<"agent/activity/result">): void {
    const pending = this.#expectPending(frame.requestId, "agent-activity-note");
    this.#assertSessionIdentity(pending.sessionId, frame.payload.sessionId);
    const attempt = this.#agentActivityAttempt;
    if (attempt?.requestId !== frame.requestId || attempt.sessionId !== frame.payload.sessionId) {
      throw protocolViolation("The Web Agent activity response is not correlated.");
    }
    const renewed = freezeActiveAgentStatus(frame.payload.status);
    if (!isValidAgentRenewal(attempt.expected, renewed)) {
      throw protocolViolation("The Web Agent activity response changed its lease binding.");
    }
    this.#removePending(frame.requestId);
    this.#agentActivityAttempt = undefined;
    const status = this.#installAgentStatus(renewed);
    if (status.state !== "active") {
      throw protocolViolation("The Web Agent activity response is inactive.");
    }
    attempt.deferred.resolve(status);
  }

  #handleTurnStarted(frame: NativeMessagingFrameOf<"turn/started">): void {
    const active = this.#assertActiveTurn(frame.payload.sessionId, frame.payload.turnId);
    const pending = this.#expectPending(frame.requestId, "turn-start");
    this.#assertTurnIdentity(pending, active);
    if (active.phase !== "starting" && active.phase !== "cancelling") {
      throw protocolViolation("The browser acknowledged a turn more than once.");
    }
    this.#removePending(frame.requestId);
    active.startedAcknowledged = true;
    active.started.resolve(undefined);
    if (active.phase !== "cancelling") {
      active.phase = "streaming";
    }
    active.turnTimer = this.#options.scheduler.schedule(this.#options.turnTimeoutMs, () => {
      this.#handleTurnTimeout(active);
    });
  }

  async #handleTurnDelta(
    lease: BrowserTransportLease,
    frame: NativeMessagingFrameOf<"turn/delta">,
  ): Promise<void> {
    const active = this.#assertActiveTurn(frame.payload.sessionId, frame.payload.turnId);
    if (!active.startedAcknowledged) {
      throw protocolViolation("The browser streamed output before acknowledging the turn.");
    }
    const delta = Object.freeze({
      channel: frame.payload.channel,
      delta: frame.payload.delta,
    });
    try {
      await active.sink.onDelta(delta);
    } catch {
      const error = createBrowserSessionError(
        BRIDGE_ERROR_CODES.INTERNAL_ERROR,
        "The local browser turn consumer failed.",
        false,
      );
      if (lease === this.#lease && this.#activeTurn === active && !active.settled) {
        this.#teardownTransport(error, true);
      }
      throw error;
    }
  }

  #handleTurnCompleted(frame: NativeMessagingFrameOf<"turn/completed">): void {
    const active = this.#assertActiveTurn(frame.payload.sessionId, frame.payload.turnId);
    if (!active.startedAcknowledged) {
      throw protocolViolation("The browser completed a turn before acknowledging it.");
    }
    this.#settleActiveTurn(active, {
      finishReason: frame.payload.finishReason,
      kind: "completed",
    });
  }

  #handleTurnCancelled(frame: NativeMessagingFrameOf<"turn/cancelled">): void {
    const active = this.#assertActiveTurn(frame.payload.sessionId, frame.payload.turnId);
    this.#settleActiveTurn(active, { kind: "cancelled" });
  }

  #handleTurnFailed(frame: NativeMessagingFrameOf<"turn/failed">): void {
    const active = this.#assertActiveTurn(frame.payload.sessionId, frame.payload.turnId);
    this.#settleActiveTurn(active, {
      error: freezeBridgeError(frame.payload.error),
      kind: "failed",
    });
  }

  #handleRemoteError(frame: NativeMessagingFrameOf<"error">): void {
    const pending = this.#pending.get(frame.requestId);
    if (pending === undefined) {
      throw protocolViolation("The browser error has no pending request.");
    }
    this.#removePending(frame.requestId);
    const remoteError = new BrowserSessionError(frame.payload.error);

    switch (pending.kind) {
      case "agent-status-read": {
        const attempt = this.#agentStatusReadAttempt;
        if (attempt?.requestId !== frame.requestId) {
          throw protocolViolation("The Web Agent status error is not correlated.");
        }
        this.#agentStatusReadAttempt = undefined;
        this.#agentStatus = undefined;
        attempt.deferred.reject(remoteError);
        return;
      }
      case "agent-activity-note": {
        const attempt = this.#agentActivityAttempt;
        if (attempt?.requestId !== frame.requestId) {
          throw protocolViolation("The Web Agent activity error is not correlated.");
        }
        this.#agentActivityAttempt = undefined;
        this.#agentStatus = undefined;
        attempt.deferred.reject(remoteError);
        return;
      }
      case "turn-start": {
        const active = this.#assertActiveTurn(pending.sessionId, pending.turnId);
        this.#settleActiveTurn(
          active,
          { error: remoteError.bridgeError, kind: "failed" },
          remoteError,
        );
        return;
      }
      case "turn-cancel": {
        const active = this.#assertActiveTurn(pending.sessionId, pending.turnId);
        const attempt = active.cancelAttempt;
        if (attempt?.requestId !== frame.requestId) {
          throw protocolViolation("The browser cancellation error is not correlated.");
        }
        delete active.cancelAttempt;
        if (attempt.reason === "timeout") {
          this.#teardownTransport(
            createBrowserSessionError(
              BRIDGE_ERROR_CODES.TRANSPORT_TIMEOUT,
              "The browser turn exceeded its allowed lifetime.",
              true,
            ),
            true,
          );
          return;
        }
        active.phase = attempt.previousPhase;
        attempt.deferred.reject(remoteError);
        return;
      }
      case "capabilities-read":
      case "session-connect":
      case "session-disconnect":
        this.#teardownTransport(remoteError, true);
        return;
    }
  }

  #installCapabilities(value: BrowserCapabilities): BrowserCapabilitySnapshot {
    if (this.#sessionId === undefined) {
      throw protocolViolation("Browser capabilities have no active session.");
    }
    const capabilities = freezeCapabilities(browserCapabilitiesSchema.parse(value));
    const fingerprint = JSON.stringify(capabilities);
    const knownFingerprint = this.#revisionFingerprints.get(capabilities.catalogRevision);
    if (knownFingerprint !== undefined && knownFingerprint !== fingerprint) {
      throw createBrowserSessionError(
        BRIDGE_ERROR_CODES.BROWSER_STATE_CHANGED,
        "The browser redefined an existing model catalog revision.",
        false,
      );
    }
    if (knownFingerprint === undefined) {
      if (this.#revisionFingerprints.size >= this.#options.maxCatalogRevisions) {
        throw createBrowserSessionError(
          BRIDGE_ERROR_CODES.BROWSER_STATE_CHANGED,
          "The browser model catalog changed too many times in one session.",
          true,
        );
      }
      this.#revisionFingerprints.set(capabilities.catalogRevision, fingerprint);
    }
    if (
      this.#snapshot !== undefined &&
      this.#snapshot.capabilities.catalogRevision === capabilities.catalogRevision &&
      knownFingerprint === fingerprint
    ) {
      return this.#snapshot;
    }

    const snapshot = Object.freeze({
      capabilities,
      generation: this.#nextSnapshotGeneration,
      sessionId: this.#sessionId,
    });
    this.#nextSnapshotGeneration += 1;
    this.#snapshot = snapshot;
    return snapshot;
  }

  #installAgentStatus(value: AgentStatusSnapshot): AgentStatusSnapshot {
    const next = freezeAgentStatus(agentStatusSnapshotSchema.parse(value));
    const current = this.#agentStatus;
    if (current !== undefined) {
      if (next.revision < current.revision) {
        throw protocolViolation("The browser sent an older Web Agent status revision.");
      }
      if (next.revision === current.revision) {
        if (!sameAgentStatus(current, next)) {
          throw protocolViolation("The browser redefined a Web Agent status revision.");
        }
        return current;
      }
    }
    this.#agentStatus = next;
    return next;
  }

  #assertTurnCapabilities(capabilities: BrowserCapabilities, request: BrowserTurnRequest): void {
    if (request.catalogRevision !== capabilities.catalogRevision) {
      throw createBrowserSessionError(
        BRIDGE_ERROR_CODES.BROWSER_STATE_CHANGED,
        "The selected browser model catalog is stale.",
        true,
      );
    }
    const model = capabilities.models.find((candidate) => candidate.id === request.modelId);
    if (model === undefined) {
      throw createBrowserSessionError(
        BRIDGE_ERROR_CODES.MODEL_UNAVAILABLE,
        "The selected browser model is unavailable.",
        true,
      );
    }
    if (
      !model.supportedReasoningEfforts.some(
        (option) => option.reasoningEffort === request.reasoningEffort,
      )
    ) {
      throw createBrowserSessionError(
        BRIDGE_ERROR_CODES.CAPABILITY_UNSUPPORTED,
        "The selected browser reasoning effort is unsupported.",
        false,
      );
    }
    if (request.temporary && !capabilities.temporaryChat) {
      throw createBrowserSessionError(
        BRIDGE_ERROR_CODES.CAPABILITY_UNSUPPORTED,
        "Temporary browser turns are unsupported by this session.",
        false,
      );
    }
  }

  #cancelTurn(turnId: string): Promise<void> {
    try {
      const active = this.#activeTurn;
      if (active?.turnId !== turnId || active.settled) {
        throw createBrowserSessionError(
          BRIDGE_ERROR_CODES.TURN_NOT_FOUND,
          "The browser turn is no longer active.",
          false,
        );
      }
      if (active.cancelAttempt !== undefined) {
        return active.cancelAttempt.deferred.promise;
      }
      if (!active.cancellationSupported) {
        throw createBrowserSessionError(
          BRIDGE_ERROR_CODES.CAPABILITY_UNSUPPORTED,
          "The connected browser session does not support cancellation.",
          false,
        );
      }
      return this.#beginCancel(active, "user");
    } catch (error) {
      return rejectedPromise(normalizeLocalError(error));
    }
  }

  #beginCancel(active: ActiveTurn, reason: "timeout" | "user"): Promise<void> {
    if (active.cancelAttempt !== undefined) {
      return active.cancelAttempt.deferred.promise;
    }
    const requestId = this.#createIdentifier("request");
    const parsed = turnCancelFrameSchema.parse({
      payload: { sessionId: active.sessionId, turnId: active.turnId },
      protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
      requestId,
      sequence: 0,
      type: "turn/cancel",
    });
    const deferred = createDeferred<undefined>();
    const previousPhase = active.phase;
    active.cancelAttempt = { deferred, previousPhase, reason, requestId };
    active.phase = "cancelling";
    try {
      this.#reservePending(
        {
          kind: "turn-cancel",
          requestId,
          sessionId: active.sessionId,
          turnId: active.turnId,
        },
        this.#options.cancellationGraceMs,
      );
      this.#send({
        payload: parsed.payload,
        requestId,
        type: "turn/cancel",
      });
    } catch (error) {
      const normalized = normalizeLocalError(error);
      if (this.#activeTurn === active && active.cancelAttempt.requestId === requestId) {
        delete active.cancelAttempt;
        active.phase = previousPhase;
        deferred.reject(normalized);
      }
      throw normalized;
    }
    return deferred.promise;
  }

  #handleTurnTimeout(active: ActiveTurn): void {
    if (this.#activeTurn !== active || active.settled) {
      return;
    }
    delete active.turnTimer;
    if (!active.cancellationSupported || active.cancelAttempt !== undefined) {
      this.#teardownTransport(
        createBrowserSessionError(
          BRIDGE_ERROR_CODES.TRANSPORT_TIMEOUT,
          "The browser turn exceeded its allowed lifetime.",
          true,
        ),
        true,
      );
      return;
    }
    try {
      void this.#beginCancel(active, "timeout").catch(() => undefined);
    } catch (error) {
      this.#teardownTransport(normalizeLocalError(error), true);
    }
  }

  #assertActiveTurn(sessionId: string, turnId: string): ActiveTurn {
    const active = this.#activeTurn;
    if (
      active === undefined ||
      active.settled ||
      active.sessionId !== sessionId ||
      active.turnId !== turnId
    ) {
      throw protocolViolation("The browser frame refers to an unknown turn.");
    }
    return active;
  }

  #settleActiveTurn(
    active: ActiveTurn,
    terminal: BrowserTurnTerminal,
    localError?: BrowserSessionError,
  ): boolean {
    if (this.#activeTurn !== active || active.settled) {
      return false;
    }
    active.settled = true;
    this.#activeTurn = undefined;
    active.turnTimer?.cancel();
    delete active.turnTimer;
    this.#removePending(active.startRequestId);
    if (active.cancelAttempt !== undefined) {
      this.#removePending(active.cancelAttempt.requestId);
      if (localError === undefined) {
        active.cancelAttempt.deferred.resolve(undefined);
      } else {
        active.cancelAttempt.deferred.reject(localError);
      }
      delete active.cancelAttempt;
    }
    if (!active.started.settled()) {
      const startError =
        localError ??
        new BrowserSessionError(
          terminal.kind === "failed"
            ? terminal.error
            : bridgeErrorSchema.parse({
                code: BRIDGE_ERROR_CODES.TURN_CANCELLED,
                message: "The browser turn ended before it was acknowledged.",
                retryable: false,
              }),
        );
      active.started.reject(startError);
    }
    active.completion.resolve(freezeTerminal(terminal));
    return true;
  }

  #assertAttached(): void {
    if (this.#closed) {
      throw createBrowserSessionError(
        BRIDGE_ERROR_CODES.SESSION_CLOSED,
        "The browser session coordinator is closed.",
        false,
      );
    }
    if (this.#port === undefined || this.#lease === undefined) {
      throw createBrowserSessionError(
        BRIDGE_ERROR_CODES.TRANSPORT_UNAVAILABLE,
        "No authenticated browser transport is attached.",
        true,
      );
    }
  }

  #assertSessionIdentity(expected: string, actual: string): void {
    if (expected !== actual || this.#sessionId !== actual) {
      throw protocolViolation("The browser frame refers to an unknown session.");
    }
  }

  #assertTurnIdentity(pending: PendingTurnOperation<string>, active: ActiveTurn): void {
    if (pending.sessionId !== active.sessionId || pending.turnId !== active.turnId) {
      throw protocolViolation("The browser turn acknowledgement is not correlated.");
    }
  }

  #expectPending<Kind extends PendingOperation["kind"]>(
    requestId: string,
    kind: Kind,
  ): Extract<PendingOperation, { kind: Kind }> {
    const pending = this.#pending.get(requestId);
    if (pending?.kind !== kind) {
      throw protocolViolation("The browser response has no matching request.");
    }
    return pending as Extract<PendingOperation, { kind: Kind }>;
  }

  #reservePending(operation: PendingOperationInput, timeoutMs: number): void {
    if (
      this.#pending.has(operation.requestId) ||
      this.#pending.size >= this.#options.maxPendingOperations
    ) {
      throw createBrowserSessionError(
        BRIDGE_ERROR_CODES.TRANSPORT_UNAVAILABLE,
        "The browser command correlation capacity is unavailable.",
        true,
      );
    }
    const timer = this.#options.scheduler.schedule(timeoutMs, () => {
      if (!this.#pending.has(operation.requestId)) {
        return;
      }
      this.#teardownTransport(
        createBrowserSessionError(
          BRIDGE_ERROR_CODES.TRANSPORT_TIMEOUT,
          "The browser did not acknowledge a command in time.",
          true,
        ),
        true,
      );
    });
    this.#pending.set(operation.requestId, { ...operation, timer });
  }

  #removePending(requestId: string): PendingOperation | undefined {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) {
      return undefined;
    }
    this.#pending.delete(requestId);
    pending.timer.cancel();
    return pending;
  }

  #send<Type extends BrowserCommandType>(message: BrowserApplicationMessage<Type>): void {
    const port = this.#port;
    const lease = this.#lease;
    if (port === undefined || lease === undefined) {
      throw createBrowserSessionError(
        BRIDGE_ERROR_CODES.TRANSPORT_UNAVAILABLE,
        "No authenticated browser transport is attached.",
        true,
      );
    }
    let sending: Promise<void>;
    try {
      sending = port.send(message);
    } catch {
      this.#teardownTransport(
        createBrowserSessionError(
          BRIDGE_ERROR_CODES.TRANSPORT_UNAVAILABLE,
          "The browser transport rejected a command.",
          true,
        ),
        true,
      );
      return;
    }
    void sending.catch(() => {
      if (lease === this.#lease) {
        this.#teardownTransport(
          createBrowserSessionError(
            BRIDGE_ERROR_CODES.TRANSPORT_UNAVAILABLE,
            "The browser transport rejected a command.",
            true,
          ),
          true,
        );
      }
    });
  }

  #teardownTransport(error: BrowserSessionError, closePort: boolean): void {
    const port = this.#port;
    this.#port = undefined;
    this.#lease = undefined;
    this.#resetSession(error, false);
    if (closePort && port !== undefined) {
      try {
        port.close();
      } catch {
        // The coordinator is already detached and content-free diagnostics own reporting.
      }
    }
  }

  #resetSession(error: BrowserSessionError, disconnected: boolean): void {
    for (const pending of this.#pending.values()) {
      pending.timer.cancel();
    }
    this.#pending.clear();

    this.#connectionAttempt?.deferred.reject(error);
    this.#connectionAttempt = undefined;
    this.#agentStatusReadAttempt?.deferred.reject(error);
    this.#agentStatusReadAttempt = undefined;
    this.#agentActivityAttempt?.deferred.reject(error);
    this.#agentActivityAttempt = undefined;
    if (this.#disconnectAttempt !== undefined) {
      if (disconnected) {
        this.#disconnectAttempt.deferred.resolve(undefined);
      } else {
        this.#disconnectAttempt.deferred.reject(error);
      }
      this.#disconnectAttempt = undefined;
    }
    if (this.#activeTurn !== undefined) {
      this.#settleActiveTurn(this.#activeTurn, { error: error.bridgeError, kind: "failed" }, error);
    }

    this.#revisionFingerprints.clear();
    this.#agentStatus = undefined;
    this.#sessionId = undefined;
    this.#snapshot = undefined;
    this.#sessionPhase = this.#closed ? "closed" : "disconnected";
  }

  #readNow(): number {
    let value: unknown;
    try {
      value = this.#options.now();
    } catch {
      value = undefined;
    }
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw createBrowserSessionError(
        BRIDGE_ERROR_CODES.INTERNAL_ERROR,
        "The browser session clock is invalid.",
        false,
      );
    }
    return value as number;
  }

  #createIdentifier(kind: BrowserIdentifierKind): string {
    const schema =
      kind === "request" ? requestIdSchema : kind === "session" ? sessionIdSchema : turnIdSchema;
    for (let attempt = 0; attempt < IDENTIFIER_GENERATION_ATTEMPTS; attempt += 1) {
      let candidate: unknown;
      try {
        candidate = this.#options.createIdentifier(kind);
      } catch {
        continue;
      }
      const parsed = schema.safeParse(candidate);
      if (!parsed.success || this.#recentIdentifiers.has(parsed.data)) {
        continue;
      }
      this.#rememberIdentifier(parsed.data);
      return parsed.data;
    }
    throw createBrowserSessionError(
      BRIDGE_ERROR_CODES.INTERNAL_ERROR,
      "The browser correlation identifier generator failed.",
      false,
    );
  }

  #rememberIdentifier(identifier: string): void {
    if (this.#recentIdentifiers.size >= MAX_RECENT_IDENTIFIERS) {
      const oldest = this.#recentIdentifiers.values().next();
      if (!oldest.done) {
        this.#recentIdentifiers.delete(oldest.value);
      }
    }
    this.#recentIdentifiers.add(identifier);
  }
}

function createRandomIdentifier(kind: BrowserIdentifierKind): string {
  return `${kind}-${randomBytes(IDENTIFIER_BYTES).toString("base64url")}`;
}

function createDeferred<Value>(): Deferred<Value> {
  let settled = false;
  let resolvePromise: ((value: Value) => void) | undefined;
  let rejectPromise: ((reason: BrowserSessionError) => void) | undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);

  return Object.freeze({
    promise,
    reject(reason: BrowserSessionError): void {
      if (settled) {
        return;
      }
      settled = true;
      rejectPromise?.(reason);
    },
    resolve(value: Value): void {
      if (settled) {
        return;
      }
      settled = true;
      resolvePromise?.(value);
    },
    settled(): boolean {
      return settled;
    },
  });
}

function rejectedPromise<Value>(error: BrowserSessionError): Promise<Value> {
  const promise = Promise.reject<Value>(error);
  void promise.catch(() => undefined);
  return promise;
}

function protocolViolation(message: string): BrowserSessionError {
  return createBrowserSessionError(BRIDGE_ERROR_CODES.PROTOCOL_INVALID_MESSAGE, message, false);
}

function browserStateChanged(message: string): BrowserSessionError {
  return createBrowserSessionError(BRIDGE_ERROR_CODES.BROWSER_STATE_CHANGED, message, true);
}

function normalizeLocalError(error: unknown): BrowserSessionError {
  return error instanceof BrowserSessionError
    ? error
    : createBrowserSessionError(
        BRIDGE_ERROR_CODES.INTERNAL_ERROR,
        "The browser session coordinator failed.",
        false,
      );
}

function readPositiveInteger(value: number | undefined, fallback: number): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new RangeError("Invalid browser session coordinator limit");
  }
  return normalized;
}

function isScheduler(value: unknown): value is BrowserSessionScheduler {
  return isUnknownRecord(value) && typeof value["schedule"] === "function";
}

function isApplicationPort(value: unknown): value is BrowserApplicationPort {
  return (
    isUnknownRecord(value) &&
    typeof value["close"] === "function" &&
    typeof value["send"] === "function"
  );
}

function isTurnSink(value: unknown): value is BrowserTurnSink {
  return isUnknownRecord(value) && typeof value["onDelta"] === "function";
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function freezeAgentStatus(value: AgentStatusSnapshot): AgentStatusSnapshot {
  return value.state === "active"
    ? freezeActiveAgentStatus(value)
    : Object.freeze({ revision: value.revision, state: "inactive" });
}

function freezeActiveAgentStatus(value: ActiveAgentStatusSnapshot): ActiveAgentStatusSnapshot {
  return Object.freeze({
    binding: Object.freeze({ ...value.binding }),
    conversationOwnershipId: value.conversationOwnershipId,
    expiresAtMs: value.expiresAtMs,
    issuedAtMs: value.issuedAtMs,
    lastActivityAtMs: value.lastActivityAtMs,
    leaseId: value.leaseId,
    revision: value.revision,
    state: "active",
  });
}

function sameAgentStatus(left: AgentStatusSnapshot, right: AgentStatusSnapshot): boolean {
  if (left.state !== right.state || left.revision !== right.revision) {
    return false;
  }
  return (
    left.state === "inactive" || sameActiveAgentStatus(left, right as ActiveAgentStatusSnapshot)
  );
}

function sameActiveAgentStatus(
  left: ActiveAgentStatusSnapshot,
  right: ActiveAgentStatusSnapshot,
): boolean {
  return (
    left.binding.documentId === right.binding.documentId &&
    left.binding.generation === right.binding.generation &&
    left.binding.tabId === right.binding.tabId &&
    left.conversationOwnershipId === right.conversationOwnershipId &&
    left.expiresAtMs === right.expiresAtMs &&
    left.issuedAtMs === right.issuedAtMs &&
    left.lastActivityAtMs === right.lastActivityAtMs &&
    left.leaseId === right.leaseId &&
    left.revision === right.revision
  );
}

function isValidAgentRenewal(
  expected: ActiveAgentStatusSnapshot,
  renewed: ActiveAgentStatusSnapshot,
): boolean {
  return (
    expected.binding.documentId === renewed.binding.documentId &&
    expected.binding.generation === renewed.binding.generation &&
    expected.binding.tabId === renewed.binding.tabId &&
    expected.conversationOwnershipId === renewed.conversationOwnershipId &&
    expected.issuedAtMs === renewed.issuedAtMs &&
    expected.leaseId === renewed.leaseId &&
    renewed.lastActivityAtMs >= expected.lastActivityAtMs &&
    renewed.revision > expected.revision
  );
}

function freezeCapabilities(value: BrowserCapabilities): BrowserCapabilities {
  const models = value.models.map((model) =>
    Object.freeze({
      ...model,
      inputModalities: Object.freeze([...model.inputModalities]) as ["text"],
      supportedReasoningEfforts: Object.freeze(
        model.supportedReasoningEfforts.map((option) => Object.freeze({ ...option })),
      ),
    }),
  );
  return Object.freeze({
    ...value,
    models: Object.freeze(models),
  }) as unknown as BrowserCapabilities;
}

function freezeTurnStartPayload(
  payload: NativeMessagingFrameOf<"turn/start">["payload"],
): NativeMessagingFrameOf<"turn/start">["payload"] {
  return Object.freeze({
    ...payload,
    input: Object.freeze(payload.input.map((item) => Object.freeze({ ...item }))),
  }) as NativeMessagingFrameOf<"turn/start">["payload"];
}

function freezeAgentTurnStartPayload(
  payload: NativeMessagingFrameOf<"agent/turn/start">["payload"],
): NativeMessagingFrameOf<"agent/turn/start">["payload"] {
  return Object.freeze({
    ...payload,
    expected: freezeActiveAgentStatus(payload.expected),
    input: Object.freeze(payload.input.map((item) => Object.freeze({ ...item }))),
  }) as NativeMessagingFrameOf<"agent/turn/start">["payload"];
}

function freezeTerminal(terminal: BrowserTurnTerminal): BrowserTurnTerminal {
  if (terminal.kind !== "failed") {
    return Object.freeze({ ...terminal });
  }
  return Object.freeze({ error: freezeBridgeError(terminal.error), kind: "failed" });
}
