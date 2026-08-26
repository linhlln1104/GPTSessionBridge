import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";

import { BRIDGE_IMPLEMENTATION_VERSION } from "@gpt-session-bridge/native-messaging/link";

import { BrowserSessionCoordinator } from "../browser/browser-session-coordinator.js";
import { BridgeRuntimeError } from "./errors.js";
import { WindowsBrowserIpcBroker } from "./windows-browser-ipc-broker.js";

export interface BrowserIpcRuntime {
  readonly completion: Promise<void>;
  readonly coordinator: BrowserSessionCoordinator;
  close(): Promise<void>;
  start(): Promise<void>;
}

export function createDefaultBrowserIpcRuntime(
  anchorUrl: string | undefined,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
  fileExists: (path: string) => boolean = existsSync,
  packagedExecutable: string = process.execPath,
  packaged: boolean = isSea(),
): BrowserIpcRuntime | undefined {
  if (platform !== "win32") {
    return undefined;
  }
  let helperExecutable: string;
  try {
    helperExecutable = resolveWindowsIpcHelperExecutable(
      anchorUrl,
      platform,
      architecture,
      fileExists,
      packagedExecutable,
      packaged,
    );
  } catch (error) {
    if (error instanceof BridgeRuntimeError && error.code === "browser_ipc_unavailable") {
      return undefined;
    }
    throw error;
  }
  const coordinator = new BrowserSessionCoordinator();
  return new WindowsBrowserIpcBroker({
    coordinator,
    helperExecutable,
    implementationVersion: BRIDGE_IMPLEMENTATION_VERSION,
  });
}

export function resolveWindowsIpcHelperExecutable(
  anchorUrl: string | undefined,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
  fileExists: (path: string) => boolean = existsSync,
  packagedExecutable: string = process.execPath,
  packaged: boolean = isSea(),
): string {
  if (platform !== "win32" || architecture !== "x64") {
    throw new BridgeRuntimeError("browser_ipc_unavailable");
  }
  const candidate = packaged
    ? resolve(dirname(packagedExecutable), "gptsessionbridge-windows-ipc.exe")
    : resolveDevelopmentHelper(anchorUrl);
  if (!fileExists(candidate)) {
    throw new BridgeRuntimeError("browser_ipc_unavailable");
  }
  return candidate;
}

function resolveDevelopmentHelper(anchorUrl: string | undefined): string {
  if (anchorUrl === undefined) {
    throw new BridgeRuntimeError("browser_ipc_unavailable");
  }
  return fileURLToPath(
    new URL(
      "../../../native/windows-ipc/artifacts/win-x64/gptsessionbridge-windows-ipc.exe",
      anchorUrl,
    ),
  );
}
