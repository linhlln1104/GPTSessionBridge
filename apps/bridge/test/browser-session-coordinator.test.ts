import {
  BRIDGE_ERROR_CODES,
  NATIVE_MESSAGING_PROTOCOL_VERSION,
  type BrowserCapabilities,
} from "@gpt-session-bridge/protocol";
import { describe, expect, it } from "vitest";

import {
  BrowserSessionCoordinator,
  type BrowserApplicationMessage,
  type BrowserApplicationPort,
  type BrowserCommandType,
  type BrowserSessionError,
  type BrowserSessionScheduler,
  type BrowserSessionTimer,
  type BrowserTransportLease,
} from "../src/browser/index.js";

interface RecordedMessage {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly requestId: string;
  readonly type: BrowserCommandType;
}

class FakePort implements BrowserApplicationPort {
  public readonly messages: RecordedMessage[] = [];
  public closeCount = 0;
  public failNextSend = false;
  public throwOnClose = false;
  public throwOnSend = false;

  public close(): void {
    this.closeCount += 1;
    if (this.throwOnClose) {
      throw new Error("synthetic close failure");
    }
  }

  public send<Type extends BrowserCommandType>(
    message: BrowserApplicationMessage<Type>,
  ): Promise<void> {
    if (this.throwOnSend) {
      this.throwOnSend = false;
      throw new Error("synthetic send failure");
    }
    if (this.failNextSend) {
      this.failNextSend = false;
      return Promise.reject(new Error("synthetic send failure"));
    }
    this.messages.push(message);
    return Promise.resolve();
  }
}

interface FakeScheduledJob {
  cancelled: boolean;
  readonly callback: () => void;
  readonly delayMs: number;
}

class FakeScheduler implements BrowserSessionScheduler {
  readonly #jobs: FakeScheduledJob[] = [];

  public get activeCount(): number {
    return this.#jobs.filter((job) => !job.cancelled).length;
  }

  public schedule(delayMs: number, callback: () => void): BrowserSessionTimer {
    const job = { callback, cancelled: false, delayMs };
    this.#jobs.push(job);
    return {
      cancel(): void {
        job.cancelled = true;
      },
    };
  }

  public runNext(): number {
    const job = this.#jobs.find((candidate) => !candidate.cancelled);
    if (job === undefined) {
      throw new Error("No scheduled job");
    }
    job.cancelled = true;
    job.callback();
    return job.delayMs;
  }
}

describe("BrowserSessionCoordinator", () => {
  it("enforces transport ownership and lifecycle", () => {
    const coordinator = createCoordinator();
    expect(() => coordinator.connect()).toThrow(
      expect.objectContaining<Partial<BrowserSessionError>>({
        code: BRIDGE_ERROR_CODES.TRANSPORT_UNAVAILABLE,
      }),
    );

    const first = new FakePort();
    const second = new FakePort();
    const firstLease = coordinator.attach(first);
    expect(coordinator.state).toEqual({ session: "disconnected", transport: "attached" });
    expect(() => coordinator.attach(second)).toThrow(
      expect.objectContaining<Partial<BrowserSessionError>>({
        code: BRIDGE_ERROR_CODES.TRANSPORT_UNAVAILABLE,
      }),
    );
    expect(coordinator.detach({ generation: firstLease.generation })).toBe(false);
    expect(coordinator.detach(firstLease)).toBe(true);
    expect(coordinator.state.transport).toBe("detached");

    const secondLease = coordinator.attach(second);
    expect(coordinator.detach(firstLease)).toBe(false);
    second.throwOnClose = true;
    coordinator.close();
    coordinator.close();
    expect(second.closeCount).toBe(1);
    expect(coordinator.state).toEqual({ session: "closed", transport: "closed" });
    expect(coordinator.detach(secondLease)).toBe(false);
    expect(() => coordinator.attach(new FakePort())).toThrow(
      expect.objectContaining<Partial<BrowserSessionError>>({
        code: BRIDGE_ERROR_CODES.SESSION_CLOSED,
      }),
    );
  });

  it("validates constructor options and identifier generation", () => {
    for (const options of [
      { cancellationGraceMs: 0 },
      { commandTimeoutMs: 0 },
      { maxCatalogRevisions: 0 },
      { maxPendingOperations: 0 },
      { turnTimeoutMs: 0 },
    ]) {
      expect(() => new BrowserSessionCoordinator(options)).toThrow(RangeError);
    }
    expect(
      () =>
        new BrowserSessionCoordinator({
          scheduler: {} as BrowserSessionScheduler,
        }),
    ).toThrow(RangeError);

    const coordinator = new BrowserSessionCoordinator({
      createIdentifier: () => "invalid identifier",
    });
    coordinator.attach(new FakePort());
    expect(() => coordinator.connect()).toThrow(
      expect.objectContaining<Partial<BrowserSessionError>>({
        code: BRIDGE_ERROR_CODES.INTERNAL_ERROR,
      }),
    );
  });

  it("connects only after capability discovery and freezes the snapshot", async () => {
    const { coordinator, lease, port } = attachedCoordinator();
    const connecting = coordinator.connect();
    expect(coordinator.state.session).toBe("connecting");
    expect(() => coordinator.connect()).toThrow(
      expect.objectContaining<Partial<BrowserSessionError>>({
        code: BRIDGE_ERROR_CODES.SESSION_ALREADY_CONNECTED,
      }),
    );

    const connect = sent(port, "session/connect");
    const sessionId = readString(connect.payload, "sessionId");
    await coordinator.receive(lease, frame("session/connected", connect.requestId, { sessionId }));
    expect(coordinator.state.session).toBe("discoveringCapabilities");
    const read = sent(port, "capabilities/read");
    await coordinator.receive(
      lease,
      frame("capabilities/result", read.requestId, {
        capabilities: capabilities(),
        sessionId,
      }),
    );

    const snapshot = await connecting;
    expect(snapshot).toBe(coordinator.snapshot);
    expect(snapshot.generation).toBe(1);
    expect(snapshot.sessionId).toBe(sessionId);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities.models)).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities.models[0])).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities.models[0]?.supportedReasoningEfforts)).toBe(true);
    expect(coordinator.state).toEqual({ session: "ready", transport: "attached" });
  });

  it("updates capability generations and treats identical updates as idempotent", async () => {
    const ready = await readyCoordinator();
    const initial = ready.coordinator.snapshot;
    expect(initial).toBeDefined();

    await ready.coordinator.receive(
      ready.lease,
      frame("capabilities/changed", "event-capabilities-same", {
        capabilities: capabilities(),
        sessionId: ready.sessionId,
      }),
    );
    expect(ready.coordinator.snapshot).toBe(initial);

    await ready.coordinator.receive(
      ready.lease,
      frame("capabilities/changed", "event-capabilities-new", {
        capabilities: capabilities({ catalogRevision: "catalog-b" }),
        sessionId: ready.sessionId,
      }),
    );
    expect(ready.coordinator.snapshot?.generation).toBe(2);
    expect(ready.coordinator.snapshot?.capabilities.catalogRevision).toBe("catalog-b");
  });

  it("fails closed when a catalog revision is redefined or capacity is exhausted", async () => {
    const redefined = await readyCoordinator();
    await expect(
      redefined.coordinator.receive(
        redefined.lease,
        frame("capabilities/changed", "event-capabilities-redefined", {
          capabilities: capabilities({ streaming: false }),
          sessionId: redefined.sessionId,
        }),
      ),
    ).rejects.toMatchObject({ code: BRIDGE_ERROR_CODES.BROWSER_STATE_CHANGED });
    expect(redefined.port.closeCount).toBe(1);
    expect(redefined.coordinator.snapshot).toBeUndefined();

    const bounded = await readyCoordinator({ maxCatalogRevisions: 1 });
    await expect(
      bounded.coordinator.receive(
        bounded.lease,
        frame("capabilities/changed", "event-capabilities-overflow", {
          capabilities: capabilities({ catalogRevision: "catalog-b" }),
          sessionId: bounded.sessionId,
        }),
      ),
    ).rejects.toMatchObject({ code: BRIDGE_ERROR_CODES.BROWSER_STATE_CHANGED });
    expect(bounded.port.closeCount).toBe(1);
  });

  it("validates turn selections without sending an unsupported prompt", async () => {
    const ready = await readyCoordinator({
      capabilities: capabilities({ temporaryChat: false }),
    });
    const initialMessages = ready.port.messages.length;

    const cases = [
      {
        code: BRIDGE_ERROR_CODES.BROWSER_STATE_CHANGED,
        request: turnRequest({ catalogRevision: "catalog-stale" }),
      },
      {
        code: BRIDGE_ERROR_CODES.MODEL_UNAVAILABLE,
        request: turnRequest({ modelId: "gptsessionbridge/web/missing" }),
      },
      {
        code: BRIDGE_ERROR_CODES.CAPABILITY_UNSUPPORTED,
        request: turnRequest({ reasoningEffort: "high" }),
      },
      {
        code: BRIDGE_ERROR_CODES.CAPABILITY_UNSUPPORTED,
        request: turnRequest({ temporary: true }),
      },
      {
        code: BRIDGE_ERROR_CODES.PROTOCOL_INVALID_MESSAGE,
        request: turnRequest({ input: [] }),
      },
    ];
    for (const testCase of cases) {
      expect(() => ready.coordinator.startTurn(testCase.request)).toThrow(
        expect.objectContaining<Partial<BrowserSessionError>>({ code: testCase.code }),
      );
    }
    expect(ready.port.messages).toHaveLength(initialMessages);
  });

  it("streams an acknowledged turn in order and emits one completion", async () => {
    const ready = await readyCoordinator();
    const deltas: string[] = [];
    const handle = ready.coordinator.startTurn(turnRequest(), {
      onDelta(delta): void {
        deltas.push(`${delta.channel}:${delta.delta}`);
      },
    });
    expect(() => ready.coordinator.startTurn(turnRequest())).toThrow(
      expect.objectContaining<Partial<BrowserSessionError>>({
        code: BRIDGE_ERROR_CODES.TURN_ALREADY_ACTIVE,
      }),
    );
    const start = sent(ready.port, "turn/start");
    expect(start.payload).toMatchObject({
      catalogRevision: "catalog-a",
      modelId: "gptsessionbridge/web/example-model",
      reasoningEffort: "medium",
      sessionId: ready.sessionId,
      turnId: handle.turnId,
    });

    await ready.coordinator.receive(
      ready.lease,
      frame("turn/started", start.requestId, {
        sessionId: ready.sessionId,
        turnId: handle.turnId,
      }),
    );
    await expect(handle.started).resolves.toBeUndefined();
    await ready.coordinator.receive(
      ready.lease,
      frame("turn/delta", "event-delta-a", {
        channel: "reasoning",
        delta: "Plan",
        sessionId: ready.sessionId,
        turnId: handle.turnId,
      }),
    );
    await ready.coordinator.receive(
      ready.lease,
      frame("turn/delta", "event-delta-b", {
        channel: "outputText",
        delta: "Done",
        sessionId: ready.sessionId,
        turnId: handle.turnId,
      }),
    );
    await ready.coordinator.receive(
      ready.lease,
      frame("turn/completed", "event-terminal", {
        finishReason: "stop",
        sessionId: ready.sessionId,
        turnId: handle.turnId,
      }),
    );

    await expect(handle.completion).resolves.toEqual({ finishReason: "stop", kind: "completed" });
    expect(deltas).toEqual(["reasoning:Plan", "outputText:Done"]);
    expect(ready.coordinator.state.activeTurn).toBeUndefined();

    await expect(
      ready.coordinator.receive(
        ready.lease,
        frame("turn/cancelled", "event-terminal-duplicate", {
          sessionId: ready.sessionId,
          turnId: handle.turnId,
        }),
      ),
    ).rejects.toMatchObject({ code: BRIDGE_ERROR_CODES.PROTOCOL_INVALID_MESSAGE });
    await expect(handle.completion).resolves.toEqual({ finishReason: "stop", kind: "completed" });
  });

  it("rejects deltas before acknowledgement and wrong turn correlation", async () => {
    const early = await readyCoordinator();
    const earlyHandle = early.coordinator.startTurn(turnRequest());
    await expect(
      early.coordinator.receive(
        early.lease,
        frame("turn/delta", "event-early", {
          channel: "outputText",
          delta: "Unexpected",
          sessionId: early.sessionId,
          turnId: earlyHandle.turnId,
        }),
      ),
    ).rejects.toMatchObject({ code: BRIDGE_ERROR_CODES.PROTOCOL_INVALID_MESSAGE });
    await expect(earlyHandle.completion).resolves.toMatchObject({
      error: { code: BRIDGE_ERROR_CODES.PROTOCOL_INVALID_MESSAGE },
      kind: "failed",
    });

    const mismatched = await readyCoordinator();
    const mismatchedHandle = mismatched.coordinator.startTurn(turnRequest());
    const start = sent(mismatched.port, "turn/start");
    await expect(
      mismatched.coordinator.receive(
        mismatched.lease,
        frame("turn/started", start.requestId, {
          sessionId: mismatched.sessionId,
          turnId: "turn-other",
        }),
      ),
    ).rejects.toMatchObject({ code: BRIDGE_ERROR_CODES.PROTOCOL_INVALID_MESSAGE });
    await expect(mismatchedHandle.completion).resolves.toMatchObject({ kind: "failed" });
  });

  it("deduplicates cancellation and lets the first terminal frame win", async () => {
    const ready = await readyCoordinator();
    const handle = ready.coordinator.startTurn(turnRequest());
    await acknowledgeTurn(ready, handle.turnId);

    const firstCancel = handle.cancel();
    const secondCancel = handle.cancel();
    expect(firstCancel).toBe(secondCancel);
    expect(messagesOfType(ready.port, "turn/cancel")).toHaveLength(1);
    expect(ready.coordinator.state.activeTurn).toBe("cancelling");

    await ready.coordinator.receive(
      ready.lease,
      frame("turn/completed", "event-complete-during-cancel", {
        finishReason: "length",
        sessionId: ready.sessionId,
        turnId: handle.turnId,
      }),
    );
    await expect(firstCancel).resolves.toBeUndefined();
    await expect(handle.completion).resolves.toEqual({ finishReason: "length", kind: "completed" });
  });

  it("supports cancellation before start acknowledgement", async () => {
    const ready = await readyCoordinator();
    const handle = ready.coordinator.startTurn(turnRequest());
    const cancelling = handle.cancel();
    await ready.coordinator.receive(
      ready.lease,
      frame("turn/cancelled", "event-cancelled", {
        sessionId: ready.sessionId,
        turnId: handle.turnId,
      }),
    );

    await expect(cancelling).resolves.toBeUndefined();
    await expect(handle.started).rejects.toMatchObject({ code: BRIDGE_ERROR_CODES.TURN_CANCELLED });
    await expect(handle.completion).resolves.toEqual({ kind: "cancelled" });
  });

  it("rolls cancellation state back when correlation capacity is occupied", async () => {
    const ready = await readyCoordinator({ maxPendingOperations: 1 });
    const handle = ready.coordinator.startTurn(turnRequest());

    await expect(handle.cancel()).rejects.toMatchObject({
      code: BRIDGE_ERROR_CODES.TRANSPORT_UNAVAILABLE,
    });
    expect(ready.coordinator.state.activeTurn).toBe("starting");
    expect(messagesOfType(ready.port, "turn/cancel")).toHaveLength(0);

    await acknowledgeTurn(ready, handle.turnId);
    await ready.coordinator.receive(
      ready.lease,
      frame("turn/completed", "event-complete-after-capacity", {
        finishReason: "stop",
        sessionId: ready.sessionId,
        turnId: handle.turnId,
      }),
    );
    await expect(handle.completion).resolves.toMatchObject({ kind: "completed" });
  });

  it("keeps a turn active after a rejected user cancellation", async () => {
    const ready = await readyCoordinator();
    const handle = ready.coordinator.startTurn(turnRequest());
    await acknowledgeTurn(ready, handle.turnId);
    const cancelling = handle.cancel();
    const cancel = sent(ready.port, "turn/cancel");
    await ready.coordinator.receive(
      ready.lease,
      frame("error", cancel.requestId, {
        error: safeError(BRIDGE_ERROR_CODES.CAPABILITY_UNSUPPORTED),
      }),
    );
    await expect(cancelling).rejects.toMatchObject({
      code: BRIDGE_ERROR_CODES.CAPABILITY_UNSUPPORTED,
    });
    expect(ready.coordinator.state.activeTurn).toBe("streaming");

    await ready.coordinator.receive(
      ready.lease,
      frame("turn/failed", "event-failed", {
        error: safeError(BRIDGE_ERROR_CODES.BROWSER_STATE_CHANGED),
        sessionId: ready.sessionId,
        turnId: handle.turnId,
      }),
    );
    await expect(handle.completion).resolves.toMatchObject({
      error: { code: BRIDGE_ERROR_CODES.BROWSER_STATE_CHANGED },
      kind: "failed",
    });
  });

  it("rejects cancellation when the capability is unavailable", async () => {
    const ready = await readyCoordinator({
      capabilities: capabilities({ cancellation: false }),
    });
    const handle = ready.coordinator.startTurn(turnRequest());
    await acknowledgeTurn(ready, handle.turnId);
    await expect(handle.cancel()).rejects.toMatchObject({
      code: BRIDGE_ERROR_CODES.CAPABILITY_UNSUPPORTED,
    });
    expect(messagesOfType(ready.port, "turn/cancel")).toHaveLength(0);

    await ready.coordinator.receive(
      ready.lease,
      frame("turn/completed", "event-complete", {
        finishReason: "stop",
        sessionId: ready.sessionId,
        turnId: handle.turnId,
      }),
    );
    await expect(handle.completion).resolves.toMatchObject({ kind: "completed" });
  });

  it("settles active work when the browser session disconnects", async () => {
    const ready = await readyCoordinator();
    const handle = ready.coordinator.startTurn(turnRequest());
    await acknowledgeTurn(ready, handle.turnId);
    const disconnecting = ready.coordinator.disconnect("user");
    expect(ready.coordinator.disconnect("shutdown")).toBe(disconnecting);
    expect(ready.coordinator.state.session).toBe("disconnecting");

    await ready.coordinator.receive(
      ready.lease,
      frame("session/disconnected", "event-disconnected", {
        reason: "user",
        sessionId: ready.sessionId,
      }),
    );
    await expect(disconnecting).resolves.toBeUndefined();
    await expect(handle.completion).resolves.toMatchObject({
      error: { code: BRIDGE_ERROR_CODES.SESSION_CLOSED },
      kind: "failed",
    });
    expect(ready.coordinator.state).toEqual({ session: "disconnected", transport: "attached" });
    await expect(ready.coordinator.disconnect()).resolves.toBeUndefined();
  });

  it("propagates command and turn timeouts without leaving active work", async () => {
    const connectScheduler = new FakeScheduler();
    const connecting = attachedCoordinator({ scheduler: connectScheduler });
    const connection = connecting.coordinator.connect();
    expect(connectScheduler.runNext()).toBe(10_000);
    await expect(connection).rejects.toMatchObject({ code: BRIDGE_ERROR_CODES.TRANSPORT_TIMEOUT });
    expect(connecting.port.closeCount).toBe(1);

    const turnScheduler = new FakeScheduler();
    const ready = await readyCoordinator({ scheduler: turnScheduler, turnTimeoutMs: 500 });
    const handle = ready.coordinator.startTurn(turnRequest());
    await acknowledgeTurn(ready, handle.turnId);
    expect(turnScheduler.runNext()).toBe(500);
    expect(messagesOfType(ready.port, "turn/cancel")).toHaveLength(1);
    expect(turnScheduler.runNext()).toBe(5_000);
    await expect(handle.completion).resolves.toMatchObject({
      error: { code: BRIDGE_ERROR_CODES.TRANSPORT_TIMEOUT },
      kind: "failed",
    });
    expect(ready.port.closeCount).toBe(1);
  });

  it("fails a turn safely when its consumer throws", async () => {
    const ready = await readyCoordinator();
    const handle = ready.coordinator.startTurn(turnRequest(), {
      onDelta(): never {
        throw new Error("synthetic consumer failure");
      },
    });
    await acknowledgeTurn(ready, handle.turnId);
    await expect(
      ready.coordinator.receive(
        ready.lease,
        frame("turn/delta", "event-delta", {
          channel: "outputText",
          delta: "Synthetic output",
          sessionId: ready.sessionId,
          turnId: handle.turnId,
        }),
      ),
    ).rejects.toMatchObject({ code: BRIDGE_ERROR_CODES.INTERNAL_ERROR });
    await expect(handle.completion).resolves.toMatchObject({
      error: { code: BRIDGE_ERROR_CODES.INTERNAL_ERROR },
      kind: "failed",
    });
    expect(ready.port.closeCount).toBe(1);
  });

  it("does not let a stale asynchronous sink failure close a replacement lease", async () => {
    const ready = await readyCoordinator();
    let rejectSink: ((reason?: unknown) => void) | undefined;
    const blockedSink = new Promise<void>((_resolve, reject) => {
      rejectSink = reject;
    });
    const handle = ready.coordinator.startTurn(turnRequest(), {
      async onDelta(): Promise<void> {
        await blockedSink;
      },
    });
    await acknowledgeTurn(ready, handle.turnId);

    const receiving = ready.coordinator.receive(
      ready.lease,
      frame("turn/delta", "event-stale-sink", {
        channel: "outputText",
        delta: "Blocked",
        sessionId: ready.sessionId,
        turnId: handle.turnId,
      }),
    );
    await Promise.resolve();
    expect(ready.coordinator.detach(ready.lease)).toBe(true);
    const replacement = new FakePort();
    const replacementLease = ready.coordinator.attach(replacement);

    rejectSink?.(new Error("synthetic stale consumer failure"));
    await expect(receiving).rejects.toMatchObject({ code: BRIDGE_ERROR_CODES.INTERNAL_ERROR });
    await expect(handle.completion).resolves.toMatchObject({ kind: "failed" });
    expect(replacement.closeCount).toBe(0);
    expect(ready.coordinator.state).toEqual({ session: "disconnected", transport: "attached" });
    expect(ready.coordinator.detach(replacementLease)).toBe(true);
  });

  it("rejects concurrent frame delivery and preserves sink backpressure", async () => {
    const ready = await readyCoordinator();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = ready.coordinator.startTurn(turnRequest(), {
      async onDelta(): Promise<void> {
        await blocked;
      },
    });
    await acknowledgeTurn(ready, handle.turnId);

    const first = ready.coordinator.receive(
      ready.lease,
      frame("turn/delta", "event-blocked", {
        channel: "outputText",
        delta: "Blocked",
        sessionId: ready.sessionId,
        turnId: handle.turnId,
      }),
    );
    await Promise.resolve();
    await expect(
      ready.coordinator.receive(
        ready.lease,
        frame("turn/completed", "event-concurrent", {
          finishReason: "stop",
          sessionId: ready.sessionId,
          turnId: handle.turnId,
        }),
      ),
    ).rejects.toMatchObject({ code: BRIDGE_ERROR_CODES.PROTOCOL_INVALID_MESSAGE });
    release?.();
    await expect(first).resolves.toBe(false);
    await expect(handle.completion).resolves.toMatchObject({ kind: "failed" });
  });

  it("fails closed on wrong request, session, direction, and unknown errors", async () => {
    const wrongRequest = attachedCoordinator();
    const connection = wrongRequest.coordinator.connect();
    const connect = sent(wrongRequest.port, "session/connect");
    await expect(
      wrongRequest.coordinator.receive(
        wrongRequest.lease,
        frame("session/connected", "request-unknown", {
          sessionId: readString(connect.payload, "sessionId"),
        }),
      ),
    ).rejects.toMatchObject({ code: BRIDGE_ERROR_CODES.PROTOCOL_INVALID_MESSAGE });
    await expect(connection).rejects.toMatchObject({
      code: BRIDGE_ERROR_CODES.PROTOCOL_INVALID_MESSAGE,
    });

    const wrongDirection = attachedCoordinator();
    await expect(
      wrongDirection.coordinator.receive(
        wrongDirection.lease,
        frame("session/connect", "request-wrong-direction", { sessionId: "session-other" }),
      ),
    ).rejects.toMatchObject({ code: BRIDGE_ERROR_CODES.PROTOCOL_INVALID_MESSAGE });

    const unknownError = await readyCoordinator();
    await expect(
      unknownError.coordinator.receive(
        unknownError.lease,
        frame("error", "request-unknown", {
          error: safeError(BRIDGE_ERROR_CODES.INTERNAL_ERROR),
        }),
      ),
    ).rejects.toMatchObject({ code: BRIDGE_ERROR_CODES.PROTOCOL_INVALID_MESSAGE });
  });

  it("handles synchronous and asynchronous transport send failures", async () => {
    const synchronous = attachedCoordinator();
    synchronous.port.throwOnSend = true;
    const syncConnection = synchronous.coordinator.connect();
    await expect(syncConnection).rejects.toMatchObject({
      code: BRIDGE_ERROR_CODES.TRANSPORT_UNAVAILABLE,
    });
    expect(synchronous.port.closeCount).toBe(1);

    const asynchronous = attachedCoordinator();
    asynchronous.port.failNextSend = true;
    const asyncConnection = asynchronous.coordinator.connect();
    await expect(asyncConnection).rejects.toMatchObject({
      code: BRIDGE_ERROR_CODES.TRANSPORT_UNAVAILABLE,
    });
    expect(asynchronous.port.closeCount).toBe(1);
  });
});

interface AttachedCoordinator {
  readonly coordinator: BrowserSessionCoordinator;
  readonly lease: BrowserTransportLease;
  readonly port: FakePort;
}

interface ReadyCoordinator extends AttachedCoordinator {
  readonly sessionId: string;
}

interface CoordinatorFixtureOptions {
  readonly capabilities?: BrowserCapabilities;
  readonly maxCatalogRevisions?: number;
  readonly maxPendingOperations?: number;
  readonly scheduler?: BrowserSessionScheduler;
  readonly turnTimeoutMs?: number;
}

function attachedCoordinator(options: CoordinatorFixtureOptions = {}): AttachedCoordinator {
  const coordinator = createCoordinator(options);
  const port = new FakePort();
  const lease = coordinator.attach(port);
  return { coordinator, lease, port };
}

async function readyCoordinator(
  options: CoordinatorFixtureOptions = {},
): Promise<ReadyCoordinator> {
  const attached = attachedCoordinator(options);
  const connecting = attached.coordinator.connect();
  const connect = sent(attached.port, "session/connect");
  const sessionId = readString(connect.payload, "sessionId");
  await attached.coordinator.receive(
    attached.lease,
    frame("session/connected", connect.requestId, { sessionId }),
  );
  const read = sent(attached.port, "capabilities/read");
  await attached.coordinator.receive(
    attached.lease,
    frame("capabilities/result", read.requestId, {
      capabilities: options.capabilities ?? capabilities(),
      sessionId,
    }),
  );
  await connecting;
  return { ...attached, sessionId };
}

function createCoordinator(options: CoordinatorFixtureOptions = {}): BrowserSessionCoordinator {
  let sequence = 0;
  return new BrowserSessionCoordinator({
    createIdentifier(kind): string {
      sequence += 1;
      return `${kind}-${String(sequence)}`;
    },
    ...(options.maxCatalogRevisions === undefined
      ? {}
      : { maxCatalogRevisions: options.maxCatalogRevisions }),
    ...(options.maxPendingOperations === undefined
      ? {}
      : { maxPendingOperations: options.maxPendingOperations }),
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
  });
}

async function acknowledgeTurn(ready: ReadyCoordinator, turnId: string): Promise<void> {
  const start = sent(ready.port, "turn/start");
  await ready.coordinator.receive(
    ready.lease,
    frame("turn/started", start.requestId, { sessionId: ready.sessionId, turnId }),
  );
}

function sent<Type extends BrowserCommandType>(
  port: FakePort,
  type: Type,
): BrowserApplicationMessage<Type> {
  const message = port.messages.findLast((candidate) => candidate.type === type);
  if (message === undefined) {
    throw new Error(`Missing synthetic ${type} message`);
  }
  return message as unknown as BrowserApplicationMessage<Type>;
}

function messagesOfType(port: FakePort, type: BrowserCommandType): readonly RecordedMessage[] {
  return port.messages.filter((message) => message.type === type);
}

function frame(type: string, requestId: string, payload: unknown): unknown {
  return {
    payload,
    protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
    requestId,
    sequence: 0,
    type,
  };
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Missing synthetic ${key}`);
  }
  return value;
}

function capabilities(overrides: Partial<BrowserCapabilities> = {}): BrowserCapabilities {
  return {
    cancellation: true,
    catalogRevision: "catalog-a",
    imageInput: false,
    modelDiscovery: true,
    models: [
      {
        defaultReasoningEffort: "medium",
        displayName: "Example Web Model",
        id: "gptsessionbridge/web/example-model",
        inputModalities: ["text"],
        supportedReasoningEfforts: [
          { description: "Light reasoning", reasoningEffort: "low" },
          { description: "Balanced reasoning", reasoningEffort: "medium" },
        ],
      },
    ],
    streaming: true,
    temporaryChat: true,
    toolCalls: false,
    ...overrides,
  };
}

function turnRequest(
  overrides: Partial<Parameters<BrowserSessionCoordinator["startTurn"]>[0]> = {},
): Parameters<BrowserSessionCoordinator["startTurn"]>[0] {
  return {
    catalogRevision: "catalog-a",
    input: [{ text: "Return a synthetic greeting.", type: "text" }],
    modelId: "gptsessionbridge/web/example-model",
    reasoningEffort: "medium",
    temporary: false,
    ...overrides,
  };
}

function safeError(code: (typeof BRIDGE_ERROR_CODES)[keyof typeof BRIDGE_ERROR_CODES]): {
  readonly code: typeof code;
  readonly message: string;
  readonly retryable: boolean;
} {
  return { code, message: "Synthetic browser error.", retryable: false };
}
