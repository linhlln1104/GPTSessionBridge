import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { BRIDGE_ACTIVE_ENV, BRIDGE_ACTIVE_VALUE } from "../constants.js";
import { BridgeRuntimeError } from "./errors.js";

export type CodexChildState =
  "idle" | "spawning" | "initializing" | "ready" | "draining" | "exited";

export interface CodexChildOptions {
  readonly args: readonly string[];
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly executable: string;
  readonly shutdownGraceMs: number;
}

export interface CodexChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrBytes: number;
}

export class CodexChild {
  readonly #options: CodexChildOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #exit: Promise<CodexChildExit> | undefined;
  #shutdown: Promise<CodexChildExit> | undefined;
  #state: CodexChildState = "idle";
  #stderrBytes = 0;

  public constructor(options: CodexChildOptions) {
    if (!Number.isSafeInteger(options.shutdownGraceMs) || options.shutdownGraceMs < 1) {
      throw new RangeError("Invalid shutdown grace period");
    }
    this.#options = options;
  }

  public get state(): CodexChildState {
    return this.#state;
  }

  public get process(): ChildProcessWithoutNullStreams {
    if (this.#child === undefined) {
      throw new BridgeRuntimeError("invalid_state");
    }
    return this.#child;
  }

  public start(): ChildProcessWithoutNullStreams {
    if (this.#state !== "idle") {
      throw new BridgeRuntimeError("invalid_state");
    }

    this.#state = "spawning";
    const child = spawn(this.#options.executable, [...this.#options.args], {
      env: {
        ...(this.#options.env ?? process.env),
        [BRIDGE_ACTIVE_ENV]: BRIDGE_ACTIVE_VALUE,
      },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    this.#state = "initializing";

    child.stderr.on("data", (chunk: Buffer | string) => {
      this.#stderrBytes = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.#stderrBytes + Buffer.byteLength(chunk),
      );
    });
    this.#exit = new Promise<CodexChildExit>((resolve, reject) => {
      child.once("error", () => {
        this.#state = "exited";
        reject(new BridgeRuntimeError("startup_failed"));
      });
      child.once("exit", (code, signal) => {
        this.#state = "exited";
        resolve(Object.freeze({ code, signal, stderrBytes: this.#stderrBytes }));
      });
    });

    return child;
  }

  public markReady(): void {
    if (this.#state !== "initializing") {
      throw new BridgeRuntimeError("invalid_state");
    }
    this.#state = "ready";
  }

  public waitForExit(): Promise<CodexChildExit> {
    if (this.#exit === undefined) {
      throw new BridgeRuntimeError("invalid_state");
    }
    return this.#exit;
  }

  public async shutdown(): Promise<CodexChildExit> {
    if (this.#shutdown !== undefined) {
      return this.#shutdown;
    }
    this.#shutdown = this.#shutdownOnce();
    return this.#shutdown;
  }

  async #shutdownOnce(): Promise<CodexChildExit> {
    const child = this.#child;
    const exit = this.#exit;
    if (child === undefined || exit === undefined) {
      throw new BridgeRuntimeError("invalid_state");
    }
    if (this.#state === "exited") {
      return exit;
    }

    this.#state = "draining";
    child.stdin.end();

    const gracefulOutcome = await waitForExit(exit, this.#options.shutdownGraceMs);
    if (gracefulOutcome !== FORCE_KILL_TIMEOUT) {
      return gracefulOutcome;
    }

    child.kill("SIGKILL");
    const forcedOutcome = await waitForExit(exit, this.#options.shutdownGraceMs);
    if (forcedOutcome === FORCE_KILL_TIMEOUT) {
      throw new BridgeRuntimeError("child_exited");
    }
    return forcedOutcome;
  }
}

const FORCE_KILL_TIMEOUT = Symbol("force-kill-timeout");

function waitForExit(
  exit: Promise<CodexChildExit>,
  timeoutMs: number,
): Promise<CodexChildExit | typeof FORCE_KILL_TIMEOUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(FORCE_KILL_TIMEOUT);
    }, timeoutMs);
    timer.unref();
    void exit.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new BridgeRuntimeError("child_exited"));
      },
    );
  });
}
