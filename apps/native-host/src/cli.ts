#!/usr/bin/env node

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";

import {
  DEVELOPMENT_EXTENSION_ORIGIN,
  NativeLinkError,
} from "@gpt-session-bridge/native-messaging/link";
import { WindowsIpcHelperError } from "@gpt-session-bridge/native-messaging/transport";

import { ExtensionOriginError } from "./runtime/extension-origin.js";
import { NativeHostRuntime, type WindowsIpcClientHelper } from "./runtime/native-host-runtime.js";

const FAILURE_EXIT_CODE = 1;
const NATIVE_HOST_IMPLEMENTATION_VERSION = "0.1.0";
const WINDOWS_PARENT_ARGUMENT_PATTERN = /^--parent-window=[0-9]{1,20}$/u;

export type NativeHostCliErrorCode =
  "helper_unavailable" | "invalid_invocation" | "unsupported_platform";

export class NativeHostCliError extends Error {
  public readonly code: NativeHostCliErrorCode;

  public constructor(code: NativeHostCliErrorCode) {
    super(code);
    this.name = "NativeHostCliError";
    this.code = code;
  }
}

export interface RunNativeHostOptions {
  readonly createHelper?: () => WindowsIpcClientHelper;
  readonly extensionInput?: Readable;
  readonly extensionOutput?: Writable;
  readonly helperExecutable?: string;
}

export async function runNativeHost(
  args: readonly string[],
  options: RunNativeHostOptions = {},
): Promise<void> {
  const callerOrigin = parseChromeInvocation(args);
  const helperExecutable =
    options.helperExecutable ?? resolveWindowsIpcHelperExecutable(import.meta.url);
  const runtime = new NativeHostRuntime({
    allowedOrigins: [DEVELOPMENT_EXTENSION_ORIGIN],
    callerOrigin,
    ...(options.createHelper === undefined ? {} : { createHelper: options.createHelper }),
    extensionInput: options.extensionInput ?? process.stdin,
    extensionOutput: options.extensionOutput ?? process.stdout,
    helperExecutable,
    implementationVersion: NATIVE_HOST_IMPLEMENTATION_VERSION,
  });
  await runtime.run();
}

export function parseChromeInvocation(args: readonly string[]): string {
  if (
    args.length < 1 ||
    args.length > 2 ||
    args[0] === undefined ||
    (args[1] !== undefined && !WINDOWS_PARENT_ARGUMENT_PATTERN.test(args[1]))
  ) {
    throw new NativeHostCliError("invalid_invocation");
  }
  return args[0];
}

export function resolveWindowsIpcHelperExecutable(
  anchorUrl: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
  fileExists: (path: string) => boolean = existsSync,
): string {
  if (platform !== "win32" || architecture !== "x64") {
    throw new NativeHostCliError("unsupported_platform");
  }
  const candidate = fileURLToPath(
    new URL(
      "../../../native/windows-ipc/artifacts/win-x64/gptsessionbridge-windows-ipc.exe",
      anchorUrl,
    ),
  );
  if (!fileExists(candidate)) {
    throw new NativeHostCliError("helper_unavailable");
  }
  return candidate;
}

function isDirectExecution(entry: string | undefined): boolean {
  return entry !== undefined && pathToFileURL(entry).href === import.meta.url;
}

function readSafeErrorCode(error: unknown): string {
  if (
    error instanceof NativeHostCliError ||
    error instanceof ExtensionOriginError ||
    error instanceof NativeLinkError ||
    error instanceof WindowsIpcHelperError
  ) {
    return error.code;
  }
  return "native_host_failure";
}

async function main(): Promise<void> {
  try {
    await runNativeHost(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`GPTSessionBridge native host failed (${readSafeErrorCode(error)}).\n`);
    process.exitCode = FAILURE_EXIT_CODE;
  }
}

if (isDirectExecution(process.argv[1])) {
  void main();
}
