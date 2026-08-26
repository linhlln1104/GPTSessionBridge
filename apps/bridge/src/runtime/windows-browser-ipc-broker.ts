import { randomBytes } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import {
  WindowsIpcHelperError,
  WindowsIpcHelperProcess,
  type WindowsIpcHelperExit,
} from "@gpt-session-bridge/native-messaging/transport";

import {
  BridgeNativeApplicationPort,
  type BrowserSessionCoordinator,
  type BrowserTransportLease,
} from "../browser/index.js";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 3_000;
const DEFAULT_RECONNECT_DELAY_MS = 250;
const CHALLENGE_BYTES = 32;

export type WindowsBrowserIpcBrokerState =
  "closed" | "connected" | "failed" | "idle" | "listening" | "ready";

export interface WindowsIpcServerHelper {
  readonly input: Writable;
  readonly output: Readable;
  close(): void;
  start(): Promise<WindowsIpcHelperExit>;
  waitUntilConnected(): Promise<void>;
  waitUntilListening(): Promise<void>;
}

export interface WindowsBrowserIpcBrokerOptions {
  readonly coordinator: BrowserSessionCoordinator;
  readonly createChallenge?: () => string;
  readonly createHelper?: () => WindowsIpcServerHelper;
  readonly handshakeTimeoutMs?: number;
  readonly helperExecutable: string;
  readonly implementationVersion: string;
  readonly reconnectDelay?: () => Promise<void>;
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly reject: (error: Error) => void;
  readonly resolve: () => void;
  readonly settled: () => boolean;
}

/**
 * Serially owns the deterministic Windows pipe listener. Every accepted helper
 * connection receives a fresh link challenge and a new coordinator lease.
 */
export class WindowsBrowserIpcBroker {
  readonly #coordinator: BrowserSessionCoordinator;
  readonly #createChallenge: () => string;
  readonly #createHelper: () => WindowsIpcServerHelper;
  readonly #handshakeTimeoutMs: number;
  readonly #implementationVersion: string;
  readonly #initialListening = createDeferred();
  readonly #reconnectDelay: () => Promise<void>;
  #closed = false;
  #completion: Promise<void> | undefined;
  #helper: WindowsIpcServerHelper | undefined;
  #lease: BrowserTransportLease | undefined;
  #port: BridgeNativeApplicationPort | undefined;
  #state: WindowsBrowserIpcBrokerState = "idle";

  public constructor(options: WindowsBrowserIpcBrokerOptions) {
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(handshakeTimeoutMs) ||
      handshakeTimeoutMs < 1 ||
      typeof options.implementationVersion !== "string" ||
      options.implementationVersion.length === 0
    ) {
      throw new RangeError("Invalid Windows browser IPC broker options");
    }
    this.#coordinator = options.coordinator;
    this.#createChallenge = options.createChallenge ?? createFreshChallenge;
    this.#createHelper =
      options.createHelper ??
      (() =>
        new WindowsIpcHelperProcess({
          executable: options.helperExecutable,
          role: "server",
        }));
    this.#handshakeTimeoutMs = handshakeTimeoutMs;
    this.#implementationVersion = options.implementationVersion;
    this.#reconnectDelay = options.reconnectDelay ?? defaultReconnectDelay;
  }

  public get completion(): Promise<void> {
    if (this.#completion === undefined) {
      throw new RangeError("The Windows browser IPC broker has not started");
    }
    return this.#completion;
  }

  public get coordinator(): BrowserSessionCoordinator {
    return this.#coordinator;
  }

  public get state(): WindowsBrowserIpcBrokerState {
    return this.#state;
  }

  public start(): Promise<void> {
    if (this.#completion !== undefined || this.#closed) {
      throw new RangeError("The Windows browser IPC broker cannot be started");
    }
    this.#completion = this.#run();
    void this.#completion.catch(() => undefined);
    return this.#initialListening.promise;
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      await this.#completion?.catch(() => undefined);
      return;
    }
    this.#closed = true;
    this.#state = "closed";
    this.#port?.close();
    this.#helper?.close();
    this.#coordinator.close();
    if (!this.#initialListening.settled()) {
      this.#initialListening.reject(new Error("windows_ipc_closed"));
    }
    await this.#completion?.catch(() => undefined);
  }

  async #run(): Promise<void> {
    try {
      while (!this.#isClosed()) {
        const helper = this.#createHelper();
        this.#helper = helper;
        let helperExit: Promise<WindowsIpcHelperExit> | undefined;
        let helperStopped: Promise<never> | undefined;
        let connected = false;
        try {
          helperExit = helper.start();
          helperStopped = createHelperStoppedPromise(helperExit);
          void helperStopped.catch(() => undefined);
          await Promise.race([helper.waitUntilListening(), helperStopped]);
          this.#state = "listening";
          this.#initialListening.resolve();
          await Promise.race([helper.waitUntilConnected(), helperStopped]);
          if (this.#isClosed()) {
            break;
          }
          connected = true;
          this.#state = "connected";
          await this.#serveConnection(helper, helperStopped);
        } catch (error) {
          if (this.#isClosed()) {
            break;
          }
          if (!this.#initialListening.settled()) {
            throw normalizeError(error);
          }
          if (!connected && !isAcceptTimeout(error)) {
            throw normalizeError(error);
          }
        } finally {
          this.#releaseConnection();
          helper.close();
          await helperExit?.catch(() => ({ code: null, signal: null }));
          if (this.#helper === helper) {
            this.#helper = undefined;
          }
        }

        if (!this.#isClosed()) {
          await this.#reconnectDelay();
        }
      }
    } catch (error) {
      this.#state = "failed";
      const normalized = normalizeError(error);
      this.#initialListening.reject(normalized);
      this.#coordinator.close();
      throw normalized;
    } finally {
      if (this.#closed) {
        this.#state = "closed";
      }
    }
  }

  async #serveConnection(
    helper: WindowsIpcServerHelper,
    helperStopped: Promise<never>,
  ): Promise<void> {
    const leaseReference: { current?: BrowserTransportLease } = {};
    const port = new BridgeNativeApplicationPort({
      handshakeTimeoutMs: this.#handshakeTimeoutMs,
      implementationVersion: this.#implementationVersion,
      input: helper.output,
      onApplication: async (frame) => {
        if (leaseReference.current === undefined) {
          throw new Error("windows_ipc_lease_unavailable");
        }
        const received = await this.#coordinator.receive(leaseReference.current, frame);
        if (!received) {
          throw new Error("windows_ipc_lease_expired");
        }
        if (this.#coordinator.state.session === "disconnected") {
          throw new Error("windows_ipc_session_ended");
        }
      },
      output: helper.input,
    });
    const lease = this.#coordinator.attach(port);
    leaseReference.current = lease;
    this.#lease = lease;
    this.#port = port;

    await port.start(this.#createChallenge());
    await this.#coordinator.connect();
    this.#state = "ready";
    await Promise.race([port.completion, helperStopped]);
  }

  #releaseConnection(): void {
    const lease = this.#lease;
    this.#lease = undefined;
    if (lease !== undefined) {
      this.#coordinator.detach(lease);
    }
    this.#port?.close();
    this.#port = undefined;
    if (!this.#closed && this.#state !== "failed") {
      this.#state = "idle";
    }
  }

  #isClosed(): boolean {
    return this.#closed;
  }
}

function createFreshChallenge(): string {
  return `ipc-${randomBytes(CHALLENGE_BYTES).toString("base64url")}`;
}

function createDeferred(): Deferred {
  let isSettled = false;
  let rejectPromise: ((error: Error) => void) | undefined;
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  void promise.catch(() => undefined);
  return Object.freeze({
    promise,
    reject(error: Error): void {
      if (!isSettled) {
        isSettled = true;
        rejectPromise?.(error);
      }
    },
    resolve(): void {
      if (!isSettled) {
        isSettled = true;
        resolvePromise?.();
      }
    },
    settled(): boolean {
      return isSettled;
    },
  });
}

function defaultReconnectDelay(): Promise<void> {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, DEFAULT_RECONNECT_DELAY_MS);
    timeout.unref();
  });
}

function isAcceptTimeout(error: unknown): boolean {
  return error instanceof WindowsIpcHelperError && error.nativeCode === "connection_timeout";
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error("windows_ipc_failure");
}

function createHelperStoppedPromise(helperExit: Promise<WindowsIpcHelperExit>): Promise<never> {
  return helperExit.then(
    () => {
      throw new Error("windows_ipc_helper_exited");
    },
    (error: unknown) => {
      throw normalizeError(error);
    },
  );
}
