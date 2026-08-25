import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BrowserSessionCoordinator } from "../browser/browser-session-coordinator.js";
import { BridgeRuntimeError } from "./errors.js";
import { WindowsBrowserIpcBroker } from "./windows-browser-ipc-broker.js";

const BRIDGE_IMPLEMENTATION_VERSION = "0.1.0";

export interface BrowserIpcRuntime {
  readonly completion: Promise<void>;
  close(): Promise<void>;
  start(): Promise<void>;
}

export function createDefaultBrowserIpcRuntime(
  anchorUrl: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
  fileExists: (path: string) => boolean = existsSync,
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
    );
  } catch (error) {
    if (error instanceof BridgeRuntimeError && error.code === "browser_ipc_unavailable") {
      return undefined;
    }
    throw error;
  }
  return new WindowsBrowserIpcBroker({
    coordinator: new BrowserSessionCoordinator(),
    helperExecutable,
    implementationVersion: BRIDGE_IMPLEMENTATION_VERSION,
  });
}

export function resolveWindowsIpcHelperExecutable(
  anchorUrl: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
  fileExists: (path: string) => boolean = existsSync,
): string {
  if (platform !== "win32" || architecture !== "x64") {
    throw new BridgeRuntimeError("browser_ipc_unavailable");
  }
  const candidate = fileURLToPath(
    new URL(
      "../../../native/windows-ipc/artifacts/win-x64/gptsessionbridge-windows-ipc.exe",
      anchorUrl,
    ),
  );
  if (!fileExists(candidate)) {
    throw new BridgeRuntimeError("browser_ipc_unavailable");
  }
  return candidate;
}
