import { randomBytes } from "node:crypto";

import {
  BRIDGE_ERROR_CODES,
  NATIVE_MESSAGING_PROTOCOL_VERSION,
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

export interface BrowserTurnRequest {
  readonly catalogRevision: string;
  readonly input: NativeMessagingFrameOf<"turn/start">["payload"]["input"];
  readonly modelId: string;
  readonly reasoningEffort: string;
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
  readonly scheduler?: BrowserSessionScheduler;
  readonly turnTimeoutMs?: number;
}

interface NormalizedOptions {
  readonly cancellationGraceMs: number;
  readonly commandTimeoutMs: number;
  readonly createIdentifier: (kind: BrowserIdentifierKind) => string;
  readonly maxCatalogRevisions: number;
  readonly maxPendingOperations: number;
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

interface ActiveTurn {
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
      scheduler: options.scheduler ?? DEFAULT_SCHEDULER,
      turnTimeoutMs: readPositiveInteger(options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS),
    });
    if (
      typeof this.#options.createIdentifier !== "function" ||
      !isScheduler(this.#options.scheduler)
    ) {
      throw new RangeError("Invalid browser session coordinator options");
    }
  }

  public get snapshot(): BrowserCapabilitySnapshot | undefined {
    return this.#snapshot;
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

  public startTurn(
    request: BrowserTurnRequest,
    sink: BrowserTurnSink = EMPTY_SINK,
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
    if (!isTurnSink(sink)) {
      throw createBrowserSessionError(
        BRIDGE_ERROR_CODES.INTERNAL_ERROR,
        "The browser turn consumer is invalid.",
        false,
      );
    }

    this.#assertTurnCapabilities(snapshot.capabilities, request);
    const requestId = this.#createIdentifier("request");
    const turnId = this.#createIdentifier("turn");
    const parsed = turnStartFrameSchema.safeParse({
      payload: {
        catalogRevision: request.catalogRevision,
        input: request.input,
        modelId: request.modelId,
        reasoningEffort: request.reasoningEffort,
        sessionId: snapshot.sessionId,
        temporary: request.temporary,
        turnId,
      },
      protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
      requestId,
      sequence: 0,
      type: "turn/start",
    });
    if (!parsed.success) {
      throw createBrowserSessionError(
        BRIDGE_ERROR_CODES.PROTOCOL_INVALID_MESSAGE,
        "The browser turn request is invalid.",
        false,
      );
    }

    const active: ActiveTurn = {
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
      this.#send({
        payload: freezeTurnStartPayload(parsed.data.payload),
        requestId,
        type: "turn/start",
      });
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
      if (this.#snapshot?.capabilities.cancellation !== true) {
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
    if (this.#snapshot?.capabilities.cancellation !== true || active.cancelAttempt !== undefined) {
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
    this.#sessionId = undefined;
    this.#snapshot = undefined;
    this.#sessionPhase = this.#closed ? "closed" : "disconnected";
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

function freezeTerminal(terminal: BrowserTurnTerminal): BrowserTurnTerminal {
  if (terminal.kind !== "failed") {
    return Object.freeze({ ...terminal });
  }
  return Object.freeze({ error: freezeBridgeError(terminal.error), kind: "failed" });
}
