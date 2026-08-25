#!/usr/bin/env node

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";

import { isReservedWebModelReference } from "@gpt-session-bridge/core";
import {
  DEFAULT_TRANSPORT_SECURITY_POLICY,
  generateCapabilityToken,
} from "@gpt-session-bridge/core/security";

import { BRIDGE_ACTIVE_ENV, BRIDGE_ACTIVE_VALUE, CODEX_EXECUTABLE_ENV } from "./constants.js";
import { AppServerRouter } from "./facade/app-server-router.js";
import { BidirectionalAppServerProxy } from "./facade/bidirectional-proxy.js";
import { createDefaultFacadeState } from "./facade/default-state.js";
import { ResponsesStubServer } from "./http/responses-stub.js";
import {
  createDefaultBrowserIpcRuntime,
  type BrowserIpcRuntime,
} from "./runtime/browser-ipc-runtime.js";
import { CodexChild } from "./runtime/codex-child.js";
import { resolveCodexExecutable } from "./runtime/codex-executable.js";
import { BridgeRuntimeError } from "./runtime/errors.js";

const APP_SERVER_COMMAND = "app-server";
const DEFAULT_MAX_QUEUED_MESSAGES = 256;
const DEFAULT_MAX_STUB_CONNECTIONS = 32;
const FAILURE_EXIT_CODE = 1;
const SIGINT_EXIT_CODE = 130;
const SIGTERM_EXIT_CODE = 143;
const GLOBAL_FLAG_OPTIONS = new Set([
  "--approve-for-me",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--help",
  "--no-alt-screen",
  "--oss",
  "--search",
  "--strict-config",
  "--version",
  "-V",
  "-h",
]);
const GLOBAL_VALUE_OPTIONS = new Set([
  "--add-dir",
  "--ask-for-approval",
  "--cd",
  "--config",
  "--disable",
  "--enable",
  "--local-provider",
  "--model",
  "--profile",
  "--remote",
  "--remote-auth-token-env",
  "--sandbox",
  "-C",
  "-a",
  "-c",
  "-m",
  "-p",
  "-s",
]);
const GLOBAL_VARIADIC_OPTIONS = new Set(["--image", "-i"]);
const TERMINAL_GLOBAL_FLAG_OPTIONS = new Set(["--help", "--version", "-V", "-h"]);
const APP_SERVER_FLAG_OPTIONS = new Set([
  "--analytics-default-enabled",
  "--help",
  "--stdio",
  "--strict-config",
  "-h",
]);
const APP_SERVER_VALUE_OPTIONS = new Set([
  "--code-mode-host",
  "--config",
  "--disable",
  "--enable",
  "--listen",
  "--ws-audience",
  "--ws-auth",
  "--ws-issuer",
  "--ws-max-clock-skew-seconds",
  "--ws-shared-secret-file",
  "--ws-token-file",
  "--ws-token-sha256",
  "-c",
]);
const STDIO_LISTEN_URL = "stdio://";
const LOOPBACK_NO_PROXY_ENTRIES = Object.freeze(["localhost", "127.0.0.1", "::1"]);

export interface RunCliOptions {
  readonly browserIpc?: BrowserIpcRuntime | null;
  readonly bridgeExecutable?: string;
  readonly clientInput?: Readable;
  readonly clientOutput?: Writable;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly registerSignalHandlers?: boolean;
}

export function isAppServerInvocation(args: readonly string[]): boolean {
  const commandIndex = findTopLevelCommandIndex(args);
  if (commandIndex === undefined || args[commandIndex] !== APP_SERVER_COMMAND) {
    return false;
  }
  return isStdioAppServerTail(args.slice(commandIndex + 1));
}

function findTopLevelCommandIndex(args: readonly string[]): number | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined || argument === "--") {
      return undefined;
    }
    if (TERMINAL_GLOBAL_FLAG_OPTIONS.has(argument)) {
      return undefined;
    }
    if (GLOBAL_FLAG_OPTIONS.has(argument)) {
      continue;
    }
    if (GLOBAL_VARIADIC_OPTIONS.has(argument)) {
      return undefined;
    }
    if (GLOBAL_VALUE_OPTIONS.has(argument)) {
      index += 1;
      if (index >= args.length) {
        return undefined;
      }
      continue;
    }
    if (isInlineGlobalValueOption(argument)) {
      continue;
    }
    if (argument.startsWith("-")) {
      return undefined;
    }
    return index;
  }
  return undefined;
}

function isInlineGlobalValueOption(argument: string): boolean {
  for (const option of GLOBAL_VALUE_OPTIONS) {
    if (option.startsWith("--") && argument.startsWith(`${option}=`)) {
      return true;
    }
  }
  return (
    readAttachedShortValue(argument, "-c") !== undefined ||
    readAttachedShortValue(argument, "-m") !== undefined
  );
}

function isStdioAppServerTail(args: readonly string[]): boolean {
  let listenUrl = STDIO_LISTEN_URL;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined || argument === "--") {
      return false;
    }
    if (APP_SERVER_FLAG_OPTIONS.has(argument)) {
      if (argument === "--help" || argument === "-h") {
        return false;
      }
      if (argument === "--stdio") {
        listenUrl = STDIO_LISTEN_URL;
      }
      continue;
    }
    if (APP_SERVER_VALUE_OPTIONS.has(argument)) {
      index += 1;
      const value = args[index];
      if (value === undefined) {
        return false;
      }
      if (argument === "--listen") {
        listenUrl = value;
      }
      continue;
    }
    const inline = readInlineAppServerOption(argument);
    if (inline === undefined) {
      return false;
    }
    if (inline.option === "--listen") {
      listenUrl = inline.value;
    }
  }
  return listenUrl === STDIO_LISTEN_URL;
}

function readInlineAppServerOption(
  argument: string,
): { readonly option: string; readonly value: string } | undefined {
  for (const option of APP_SERVER_VALUE_OPTIONS) {
    if (option.startsWith("--") && argument.startsWith(`${option}=`)) {
      return { option, value: argument.slice(option.length + 1) };
    }
  }
  const config = readAttachedShortValue(argument, "-c");
  if (config !== undefined) {
    return { option: "-c", value: config };
  }
  return undefined;
}

export async function runCli(
  args: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  if (hasEnvironmentValue(env, BRIDGE_ACTIVE_ENV, BRIDGE_ACTIVE_VALUE)) {
    throw new BridgeRuntimeError("already_active");
  }

  const override = readEnvironmentValue(env, CODEX_EXECUTABLE_ENV);
  const path = readEnvironmentValue(env, "PATH");
  const executable = await resolveCodexExecutable({
    ...(options.bridgeExecutable === undefined
      ? {}
      : { bridgeExecutable: options.bridgeExecutable }),
    ...(override === undefined ? {} : { override }),
    ...(path === undefined ? {} : { path }),
  });

  if (!isAppServerInvocation(args)) {
    return runPassthrough(executable, args, env);
  }

  const browserIpc =
    options.browserIpc === undefined
      ? createDefaultBrowserIpcRuntime(import.meta.url)
      : (options.browserIpc ?? undefined);

  return runAppServerFacade({
    args,
    clientInput: options.clientInput ?? process.stdin,
    clientOutput: options.clientOutput ?? process.stdout,
    env,
    executable,
    registerSignalHandlers: options.registerSignalHandlers ?? true,
    ...(browserIpc === undefined ? {} : { browserIpc }),
  });
}

export interface RunAppServerFacadeOptions {
  readonly args: readonly string[];
  readonly browserIpc?: BrowserIpcRuntime;
  readonly clientInput: Readable;
  readonly clientOutput: Writable;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly executable: string;
  readonly registerSignalHandlers: boolean;
}

export async function runAppServerFacade(options: RunAppServerFacadeOptions): Promise<number> {
  assertNoReservedAppServerArguments(options.args);
  const policy = DEFAULT_TRANSPORT_SECURITY_POLICY;
  const token = generateCapabilityToken();
  const stub = new ResponsesStubServer({
    headerTimeoutMs: policy.timeout.handshakeMs,
    maxBodyBytes: policy.size.maxFrameBytes,
    maxConnections: DEFAULT_MAX_STUB_CONNECTIONS,
    requestTimeoutMs: policy.timeout.requestMs,
    token,
  });
  const child = new CodexChild({
    args: options.args,
    env: createCodexEnvironment(options.env),
    executable: options.executable,
    shutdownGraceMs: policy.timeout.shutdownGraceMs,
  });

  let childStarted = false;
  let browserIpcStarted = false;
  let browserIpcMonitor: Promise<void> | undefined;
  let proxy: BidirectionalAppServerProxy | undefined;
  let requestedSignal: NodeJS.Signals | undefined;
  const stopForSignal = (signal: NodeJS.Signals): void => {
    requestedSignal = signal;
    proxy?.stop();
  };
  const onSigint = (): void => {
    stopForSignal("SIGINT");
  };
  const onSigterm = (): void => {
    stopForSignal("SIGTERM");
  };

  try {
    if (options.browserIpc !== undefined) {
      const browserIpc = options.browserIpc;
      try {
        await browserIpc.start();
        browserIpcStarted = true;
        browserIpcMonitor = browserIpc.completion.then(
          () => browserIpc.close(),
          () => browserIpc.close(),
        );
        void browserIpcMonitor.catch(() => undefined);
      } catch {
        await browserIpc.close().catch(() => undefined);
      }
    }
    const address = await stub.start();
    const childProcess = child.start();
    childStarted = true;
    const childExit = child.waitForExit();
    const state = createDefaultFacadeState(address.baseUrl, token);
    const router = new AppServerRouter({
      ...state,
      onInitializeComplete: () => {
        if (child.state === "initializing") {
          child.markReady();
        }
      },
    });
    proxy = new BidirectionalAppServerProxy({
      clientInput: options.clientInput,
      clientOutput: options.clientOutput,
      maxBufferedBytes: policy.size.maxBufferedBytes,
      maxFrameBytes: policy.size.maxFrameBytes,
      maxQueuedMessages: DEFAULT_MAX_QUEUED_MESSAGES,
      router,
      serverInput: childProcess.stdin,
      serverOutput: childProcess.stdout,
    });

    if (options.registerSignalHandlers) {
      process.once("SIGINT", onSigint);
      process.once("SIGTERM", onSigterm);
    }

    const completion = await Promise.race([
      proxy.run().then(() => ({ kind: "proxy" as const })),
      childExit.then((exit) => ({ exit, kind: "child" as const })),
    ]);
    const exit = completion.kind === "child" ? completion.exit : await child.shutdown();
    if (completion.kind === "child") {
      proxy.stop();
    }
    if (requestedSignal === "SIGINT") {
      return SIGINT_EXIT_CODE;
    }
    if (requestedSignal === "SIGTERM") {
      return SIGTERM_EXIT_CODE;
    }
    return exit.code ?? FAILURE_EXIT_CODE;
  } finally {
    if (options.registerSignalHandlers) {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
    proxy?.stop();
    if (childStarted && child.state !== "exited") {
      await child.shutdown().catch(() => undefined);
    }
    if (browserIpcStarted) {
      await options.browserIpc?.close().catch(() => undefined);
      await browserIpcMonitor?.catch(() => undefined);
    }
    await stub.close();
  }
}

function runPassthrough(
  executable: string,
  args: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      env: {
        ...createCodexEnvironment(env),
        [BRIDGE_ACTIVE_ENV]: BRIDGE_ACTIVE_VALUE,
      },
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", () => {
      reject(new BridgeRuntimeError("startup_failed"));
    });
    child.once("exit", (code) => {
      resolve(code ?? FAILURE_EXIT_CODE);
    });
  });
}

function createCodexEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): Readonly<NodeJS.ProcessEnv> {
  const sanitized: NodeJS.ProcessEnv = {};
  const noProxyValues: (string | undefined)[] = [];
  for (const [key, value] of Object.entries(environment)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey === "NO_PROXY") {
      noProxyValues.push(value);
      continue;
    }
    if (!normalizedKey.startsWith("GPTSESSIONBRIDGE_")) {
      sanitized[key] = value;
    }
  }
  const noProxy = mergeNoProxyEntries(...noProxyValues);
  sanitized["NO_PROXY"] = noProxy;
  if (process.platform !== "win32") {
    sanitized["no_proxy"] = noProxy;
  }
  return sanitized;
}

function readEnvironmentValue(
  environment: Readonly<NodeJS.ProcessEnv>,
  expectedKey: string,
): string | undefined {
  const normalizedExpectedKey = expectedKey.toUpperCase();
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() === normalizedExpectedKey) {
      return value;
    }
  }
  return undefined;
}

function hasEnvironmentValue(
  environment: Readonly<NodeJS.ProcessEnv>,
  expectedKey: string,
  expectedValue: string,
): boolean {
  const normalizedExpectedKey = expectedKey.toUpperCase();
  return Object.entries(environment).some(
    ([key, value]) => key.toUpperCase() === normalizedExpectedKey && value === expectedValue,
  );
}

function mergeNoProxyEntries(...values: readonly (string | undefined)[]): string {
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const value of [...values, LOOPBACK_NO_PROXY_ENTRIES.join(",")]) {
    if (value === undefined) {
      continue;
    }
    for (const rawEntry of value.split(",")) {
      const entry = rawEntry.trim();
      const key = entry.toLowerCase();
      if (entry.length > 0 && !seen.has(key)) {
        seen.add(key);
        entries.push(entry);
      }
    }
  }
  return entries.join(",");
}

function assertNoReservedAppServerArguments(args: readonly string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--model" || argument === "-m") {
      const value = args[index + 1];
      if (value !== undefined && isReservedWebModelReference(value)) {
        throw new BridgeRuntimeError("reserved_override");
      }
      index += 1;
      continue;
    }
    if (argument === "--config" || argument === "-c") {
      const value = args[index + 1];
      if (value !== undefined && isReservedConfigOverride(value)) {
        throw new BridgeRuntimeError("reserved_override");
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--model=")) {
      if (isReservedWebModelReference(argument.slice("--model=".length))) {
        throw new BridgeRuntimeError("reserved_override");
      }
      continue;
    }
    if (argument.startsWith("--config=")) {
      if (isReservedConfigOverride(argument.slice("--config=".length))) {
        throw new BridgeRuntimeError("reserved_override");
      }
      continue;
    }
    const attachedModel = readAttachedShortValue(argument, "-m");
    if (attachedModel !== undefined && isReservedWebModelReference(attachedModel)) {
      throw new BridgeRuntimeError("reserved_override");
    }
    const attachedConfig = readAttachedShortValue(argument, "-c");
    if (attachedConfig !== undefined && isReservedConfigOverride(attachedConfig)) {
      throw new BridgeRuntimeError("reserved_override");
    }
  }
}

function readAttachedShortValue(argument: string, option: "-c" | "-m"): string | undefined {
  if (!argument.startsWith(option) || argument.length <= option.length) {
    return undefined;
  }
  const value = argument.slice(option.length);
  return value.startsWith("=") ? value.slice(1) : value;
}

function isReservedConfigOverride(value: string): boolean {
  const decoded = decodeTomlUnicodeEscapes(value).toLowerCase();
  return decoded.includes("gptsessionbridge/web/") || decoded.includes("gptsessionbridge_web");
}

function decodeTomlUnicodeEscapes(value: string): string {
  const continued = value.replace(/\\[ \t]*\r?\n[ \t\r\n]*/gu, "");
  return continued.replace(
    /\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8}))/gu,
    (escape: string, short: unknown, long: unknown): string => {
      const digits = typeof short === "string" ? short : typeof long === "string" ? long : "";
      const codePoint = Number.parseInt(digits, 16);
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return escape;
      }
    },
  );
}

function isDirectExecution(entry: string | undefined): boolean {
  return entry !== undefined && pathToFileURL(entry).href === import.meta.url;
}

async function main(): Promise<void> {
  try {
    const bridgeExecutable = process.argv[1];
    process.exitCode = await runCli(process.argv.slice(2), {
      ...(bridgeExecutable === undefined ? {} : { bridgeExecutable }),
    });
  } catch (error) {
    const code = error instanceof BridgeRuntimeError ? error.code : "bridge_failure";
    process.stderr.write(`GPTSessionBridge failed (${code}).\n`);
    process.exitCode = FAILURE_EXIT_CODE;
  }
}

if (isDirectExecution(process.argv[1])) {
  void main();
}
