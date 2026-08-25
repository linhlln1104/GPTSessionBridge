import { spawn } from "node:child_process";
import { win32 } from "node:path";

import { REGISTRY_KEY_PREFIX } from "./constants.js";
import { WindowsSetupError } from "./errors.js";

const REGISTRY_VALUE_PATTERN = /^\s*.*?\s+REG_SZ\s+(.+)\s*$/gmu;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

export interface NativeMessagingRegistry {
  replaceHostPathIfExpected(
    hostName: string,
    view: WindowsRegistryView,
    expectedPath: string | undefined,
    replacementPath: string,
  ): Promise<boolean>;
  removeHostPathIfExpected(
    hostName: string,
    view: WindowsRegistryView,
    expectedPath: string,
  ): Promise<boolean>;
  readHostPath(hostName: string, view: WindowsRegistryView): Promise<string | undefined>;
}

export type WindowsRegistryView = "32" | "64";

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface CommandRunner {
  run(executable: string, args: readonly string[]): Promise<CommandResult>;
}

export interface WindowsRegistryOptions {
  readonly commandRunner?: CommandRunner;
  readonly windowsDirectory?: string;
}

export interface SpawnCommandRunnerOptions {
  readonly timeoutMs?: number;
  readonly windowsDirectory?: string;
}

/**
 * Per-user Chrome Native Messaging registry access. Conditional methods
 * verify immediately before and after mutation. reg.exe does not provide an
 * atomic compare/exchange primitive; detected same-user races fail closed.
 */
export class WindowsCurrentUserChromeRegistry implements NativeMessagingRegistry {
  readonly #commandRunner: CommandRunner;
  readonly #registryExecutable: string;

  public constructor(options: WindowsRegistryOptions = {}) {
    const windowsDirectory =
      options.windowsDirectory ?? process.env["SystemRoot"] ?? process.env["WINDIR"];
    if (windowsDirectory === undefined || !win32.isAbsolute(windowsDirectory)) {
      throw new WindowsSetupError("registry_failure");
    }
    this.#registryExecutable = win32.join(windowsDirectory, "System32", "reg.exe");
    this.#commandRunner = options.commandRunner ?? new SpawnCommandRunner({ windowsDirectory });
  }

  public async readHostPath(
    hostName: string,
    view: WindowsRegistryView,
  ): Promise<string | undefined> {
    const key = createRegistryKey(hostName);
    const viewArgument = createRegistryViewArgument(view);
    const result = await this.#commandRunner.run(this.#registryExecutable, [
      "query",
      key,
      "/ve",
      viewArgument,
    ]);
    if (result.exitCode === 1) {
      return undefined;
    }
    if (result.exitCode !== 0) {
      throw new WindowsSetupError("registry_failure");
    }
    const matches = [...result.stdout.matchAll(REGISTRY_VALUE_PATTERN)];
    const value = matches[0]?.[1]?.trim();
    if (matches.length !== 1 || value === undefined || value.length === 0) {
      throw new WindowsSetupError("registry_failure");
    }
    return value;
  }

  public async replaceHostPathIfExpected(
    hostName: string,
    view: WindowsRegistryView,
    expectedPath: string | undefined,
    replacementPath: string,
  ): Promise<boolean> {
    if (!win32.isAbsolute(replacementPath) || replacementPath.includes("\0")) {
      throw new WindowsSetupError("registry_failure");
    }
    const current = await this.readHostPath(hostName, view);
    if (!optionalRegistryPathsEqual(current, expectedPath)) {
      return false;
    }
    const key = createRegistryKey(hostName);
    const result = await this.#commandRunner.run(this.#registryExecutable, [
      "add",
      key,
      "/ve",
      "/t",
      "REG_SZ",
      "/d",
      replacementPath,
      "/f",
      `/reg:${view}`,
    ]);
    if (result.exitCode !== 0) {
      throw new WindowsSetupError("registry_failure");
    }
    return optionalRegistryPathsEqual(await this.readHostPath(hostName, view), replacementPath);
  }

  public async removeHostPathIfExpected(
    hostName: string,
    view: WindowsRegistryView,
    expectedPath: string,
  ): Promise<boolean> {
    const current = await this.readHostPath(hostName, view);
    if (!optionalRegistryPathsEqual(current, expectedPath)) {
      return false;
    }
    const result = await this.#commandRunner.run(this.#registryExecutable, [
      "delete",
      createRegistryKey(hostName),
      "/f",
      `/reg:${view}`,
    ]);
    if (result.exitCode !== 0) {
      throw new WindowsSetupError("registry_failure");
    }
    return (await this.readHostPath(hostName, view)) === undefined;
  }
}

export class SpawnCommandRunner implements CommandRunner {
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #timeoutMs: number;

  public constructor(options: SpawnCommandRunnerOptions = {}) {
    const resolvedWindowsDirectory =
      options.windowsDirectory ?? process.env["SystemRoot"] ?? process.env["WINDIR"];
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new WindowsSetupError("registry_failure");
    }
    this.#timeoutMs = timeoutMs;
    this.#environment = Object.freeze(
      resolvedWindowsDirectory === undefined
        ? Object.create(null)
        : {
            SystemRoot: resolvedWindowsDirectory,
            WINDIR: resolvedWindowsDirectory,
          },
    ) as Readonly<NodeJS.ProcessEnv>;
  }

  public async run(executable: string, args: readonly string[]): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(executable, args, {
        env: this.#environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const timer = setTimeout(() => {
        finishReject(new WindowsSetupError("registry_failure"));
        child.kill();
      }, this.#timeoutMs);
      timer.unref();
      const finishReject = (error: WindowsSetupError): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.stdout.destroy();
        child.stderr.destroy();
        reject(error);
      };
      const collect = (target: Buffer[], chunk: Buffer): void => {
        if (settled) {
          return;
        }
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          finishReject(new WindowsSetupError("registry_failure"));
          child.kill();
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        collect(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        collect(stderr, chunk);
      });
      child.once("error", (error) => {
        finishReject(new WindowsSetupError("registry_failure", { cause: error }));
      });
      child.once("close", (code) => {
        if (settled) {
          return;
        }
        try {
          const result = Object.freeze({
            exitCode: code ?? -1,
            // Diagnostic text is never parsed or surfaced. Lossy decoding
            // keeps localized error output from obscuring a reliable exit code.
            stderr: Buffer.concat(stderr).toString("utf8"),
            stdout: decodeRegistryCommandOutput(Buffer.concat(stdout)),
          });
          settled = true;
          clearTimeout(timer);
          resolve(result);
        } catch (error) {
          finishReject(new WindowsSetupError("registry_failure", { cause: error }));
        }
      });
    });
  }
}

function decodeRegistryCommandOutput(bytes: Buffer): string {
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString("utf16le");
  }
  if (bytes.byteLength >= 2 && bytes[1] === 0) {
    return bytes.toString("utf16le");
  }
  // reg.exe uses the active console encoding. ASCII and UTF-8 output are
  // accepted; undecodable legacy-code-page output fails closed rather than
  // comparing a corrupted ownership path.
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function createRegistryKey(hostName: string): string {
  if (!/^[a-z0-9_.]{1,128}$/u.test(hostName)) {
    throw new WindowsSetupError("registry_failure");
  }
  return `${REGISTRY_KEY_PREFIX}\\${hostName}`;
}

function createRegistryViewArgument(view: unknown): string {
  if (view !== "32" && view !== "64") {
    throw new WindowsSetupError("registry_failure");
  }
  return `/reg:${view}`;
}

function optionalRegistryPathsEqual(
  first: string | undefined,
  second: string | undefined,
): boolean {
  if (first === undefined || second === undefined) {
    return first === second;
  }
  return (
    win32.resolve(first).toLocaleLowerCase("en-US") ===
    win32.resolve(second).toLocaleLowerCase("en-US")
  );
}
