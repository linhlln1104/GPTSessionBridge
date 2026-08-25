import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";

const MAX_STATUS_BUFFER_BYTES = 1_024;
const MAX_STATUS_WAITERS = 4;
const DEFAULT_STATUS_TIMEOUT_MS = 15_000;

export const WINDOWS_IPC_NATIVE_ERROR_CODES = [
  "connection_timeout",
  "internal_error",
  "invalid_frame_length",
  "invalid_role",
  "peer_identity_failed",
  "peer_verification_failed",
  "pipe_connect_failed",
  "pipe_create_failed",
  "pipe_security_failed",
  "pipe_unavailable",
  "relay_failed",
  "truncated_frame",
] as const;

export type WindowsIpcNativeErrorCode = (typeof WINDOWS_IPC_NATIVE_ERROR_CODES)[number];
export type WindowsIpcHelperRole = "client" | "server";
export type WindowsIpcHelperState = "idle" | "starting" | "listening" | "connected" | "closed";

export type WindowsIpcHelperErrorCode =
  | "helper_exited"
  | "invalid_configuration"
  | "invalid_status"
  | "native_failure"
  | "spawn_failed"
  | "status_timeout"
  | "transport_closed";

export class WindowsIpcHelperError extends Error {
  public readonly code: WindowsIpcHelperErrorCode;
  public readonly nativeCode: WindowsIpcNativeErrorCode | undefined;

  public constructor(code: WindowsIpcHelperErrorCode, nativeCode?: WindowsIpcNativeErrorCode) {
    super(code);
    this.name = "WindowsIpcHelperError";
    this.code = code;
    this.nativeCode = nativeCode;
  }
}

export interface WindowsIpcHelperSpawnOptions {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly shell: false;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
  readonly windowsHide: true;
}

export type WindowsIpcHelperSpawner = (
  executable: string,
  args: readonly string[],
  options: WindowsIpcHelperSpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface WindowsIpcHelperProcessOptions {
  readonly executable: string;
  readonly role: WindowsIpcHelperRole;
  readonly spawn?: WindowsIpcHelperSpawner;
  readonly statusTimeoutMs?: number;
}

export interface WindowsIpcHelperExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface StateWaiter {
  readonly reject: (error: WindowsIpcHelperError) => void;
  readonly resolve: () => void;
  readonly state: "connected" | "listening";
}

export class WindowsIpcHelperProcess {
  readonly #executable: string;
  readonly #role: WindowsIpcHelperRole;
  readonly #spawn: WindowsIpcHelperSpawner;
  readonly #statusTimeoutMs: number;
  readonly #waiters = new Set<StateWaiter>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #exitResolve: ((exit: WindowsIpcHelperExit) => void) | undefined;
  #failure: WindowsIpcHelperError | undefined;
  #state: WindowsIpcHelperState = "idle";
  #statusBuffer = Buffer.alloc(0);
  #statusTimer: NodeJS.Timeout | undefined;

  public constructor(options: WindowsIpcHelperProcessOptions) {
    const role: unknown = options.role;
    const statusTimeoutMs = options.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
    if (
      !isAbsolute(options.executable) ||
      !isWindowsIpcHelperRole(role) ||
      !Number.isSafeInteger(statusTimeoutMs) ||
      statusTimeoutMs < 1 ||
      statusTimeoutMs > 60_000
    ) {
      throw new WindowsIpcHelperError("invalid_configuration");
    }
    this.#executable = options.executable;
    this.#role = options.role;
    this.#spawn = options.spawn ?? defaultSpawner;
    this.#statusTimeoutMs = statusTimeoutMs;
  }

  public get input(): Writable {
    if (this.#child === undefined) {
      throw new WindowsIpcHelperError("invalid_configuration");
    }
    return this.#child.stdin;
  }

  public get output(): Readable {
    if (this.#child === undefined) {
      throw new WindowsIpcHelperError("invalid_configuration");
    }
    return this.#child.stdout;
  }

  public get state(): WindowsIpcHelperState {
    return this.#state;
  }

  public start(): Promise<WindowsIpcHelperExit> {
    if (this.#state !== "idle") {
      throw new WindowsIpcHelperError("invalid_configuration");
    }
    this.#state = "starting";
    const exitPromise = new Promise<WindowsIpcHelperExit>((resolve) => {
      this.#exitResolve = resolve;
    });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.#spawn(this.#executable, [this.#role], {
        env: createWindowsIpcHelperEnvironment(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      this.#fail(new WindowsIpcHelperError("spawn_failed"));
      this.#exitResolve?.({ code: null, signal: null });
      return exitPromise;
    }

    this.#child = child;
    child.stderr.on("data", (chunk: Buffer) => {
      this.#receiveStatusBytes(chunk);
    });
    child.stderr.once("end", () => {
      if (this.#statusBuffer.byteLength > 0) {
        this.#fail(new WindowsIpcHelperError("invalid_status"));
      }
    });
    child.once("error", () => {
      this.#fail(new WindowsIpcHelperError("spawn_failed"));
    });
    child.once("close", (code, signal) => {
      if (this.#state !== "closed") {
        this.#fail(new WindowsIpcHelperError("helper_exited"));
      }
      this.#exitResolve?.({ code, signal });
      this.#exitResolve = undefined;
    });
    this.#statusTimer = setTimeout(() => {
      this.#fail(new WindowsIpcHelperError("status_timeout"));
    }, this.#statusTimeoutMs);
    this.#statusTimer.unref();
    return exitPromise;
  }

  public waitUntilListening(): Promise<void> {
    if (this.#role !== "server") {
      return Promise.reject(new WindowsIpcHelperError("invalid_configuration"));
    }
    return this.#waitFor("listening");
  }

  public waitUntilConnected(): Promise<void> {
    return this.#waitFor("connected");
  }

  public close(): void {
    if (this.#state === "closed") {
      return;
    }
    this.#fail(new WindowsIpcHelperError("transport_closed"));
    this.#child?.stdin.destroy();
    this.#child?.stdout.destroy();
    this.#child?.stderr.destroy();
    this.#child?.kill();
  }

  #waitFor(state: "connected" | "listening"): Promise<void> {
    if (hasReachedState(this.#state, state)) {
      return Promise.resolve();
    }
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    if (this.#state === "idle" || this.#waiters.size >= MAX_STATUS_WAITERS) {
      return Promise.reject(new WindowsIpcHelperError("invalid_configuration"));
    }
    return new Promise<void>((resolve, reject) => {
      this.#waiters.add({ reject, resolve, state });
    });
  }

  #receiveStatusBytes(chunk: Buffer): void {
    if (
      this.#state === "closed" ||
      chunk.byteLength > MAX_STATUS_BUFFER_BYTES - this.#statusBuffer.byteLength
    ) {
      this.#fail(new WindowsIpcHelperError("invalid_status"));
      return;
    }
    this.#statusBuffer = Buffer.concat(
      [this.#statusBuffer, chunk],
      this.#statusBuffer.byteLength + chunk.byteLength,
    );

    let newline = this.#statusBuffer.indexOf(0x0a);
    while (newline >= 0) {
      const rawLine = this.#statusBuffer.subarray(0, newline);
      this.#statusBuffer = Buffer.from(this.#statusBuffer.subarray(newline + 1));
      const line = rawLine.at(-1) === 0x0d ? rawLine.subarray(0, -1) : rawLine;
      this.#receiveStatusLine(line);
      if (this.#failure !== undefined) {
        return;
      }
      newline = this.#statusBuffer.indexOf(0x0a);
    }
  }

  #receiveStatusLine(bytes: Buffer): void {
    if (bytes.byteLength === 0 || bytes.some((byte) => byte < 0x20 || byte > 0x7e)) {
      this.#fail(new WindowsIpcHelperError("invalid_status"));
      return;
    }
    const line = bytes.toString("ascii");
    if (line === "ipc_listening") {
      if (this.#role !== "server" || this.#state !== "starting") {
        this.#fail(new WindowsIpcHelperError("invalid_status"));
        return;
      }
      this.#state = "listening";
      this.#clearStatusTimer();
      this.#settleWaiters();
      return;
    }
    if (line === "ipc_connected") {
      const validState =
        (this.#role === "server" && this.#state === "listening") ||
        (this.#role === "client" && this.#state === "starting");
      if (!validState) {
        this.#fail(new WindowsIpcHelperError("invalid_status"));
        return;
      }
      this.#state = "connected";
      this.#clearStatusTimer();
      this.#settleWaiters();
      return;
    }

    const prefix = "gptsessionbridge_windows_ipc:";
    const nativeCode = line.startsWith(prefix) ? line.slice(prefix.length) : undefined;
    if (isWindowsIpcNativeErrorCode(nativeCode)) {
      this.#fail(new WindowsIpcHelperError("native_failure", nativeCode));
      return;
    }
    this.#fail(new WindowsIpcHelperError("invalid_status"));
  }

  #settleWaiters(): void {
    for (const waiter of this.#waiters) {
      if (hasReachedState(this.#state, waiter.state)) {
        this.#waiters.delete(waiter);
        waiter.resolve();
      }
    }
  }

  #fail(error: WindowsIpcHelperError): void {
    if (this.#failure !== undefined) {
      return;
    }
    this.#failure = error;
    this.#state = "closed";
    this.#clearStatusTimer();
    this.#statusBuffer = Buffer.alloc(0);
    for (const waiter of this.#waiters) {
      waiter.reject(error);
    }
    this.#waiters.clear();
    this.#child?.kill();
  }

  #clearStatusTimer(): void {
    if (this.#statusTimer !== undefined) {
      clearTimeout(this.#statusTimer);
      this.#statusTimer = undefined;
    }
  }
}

export function createWindowsIpcHelperEnvironment(): Readonly<NodeJS.ProcessEnv> {
  return Object.freeze({});
}

function defaultSpawner(
  executable: string,
  args: readonly string[],
  options: WindowsIpcHelperSpawnOptions,
): ChildProcessWithoutNullStreams {
  const spawnOptions: SpawnOptionsWithoutStdio = {
    env: options.env,
    shell: options.shell,
    windowsHide: options.windowsHide,
  };
  return spawn(executable, [...args], { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] });
}

function hasReachedState(
  current: WindowsIpcHelperState,
  expected: "connected" | "listening",
): boolean {
  return current === "connected" || (expected === "listening" && current === "listening");
}

function isWindowsIpcNativeErrorCode(value: unknown): value is WindowsIpcNativeErrorCode {
  return (
    typeof value === "string" &&
    (WINDOWS_IPC_NATIVE_ERROR_CODES as readonly string[]).includes(value)
  );
}

function isWindowsIpcHelperRole(value: unknown): value is WindowsIpcHelperRole {
  return value === "client" || value === "server";
}
