import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

import { BridgeRuntimeError } from "./errors.js";

export interface ResolveCodexExecutableOptions {
  readonly bridgeExecutable?: string;
  readonly override?: string;
  readonly path?: string;
  readonly platform?: NodeJS.Platform;
}

export async function resolveCodexExecutable(
  options: ResolveCodexExecutableOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const override = options.override;

  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw new BridgeRuntimeError("invalid_codex_executable");
    }
    return validateCandidate(override, options.bridgeExecutable, platform);
  }

  const executableName = platform === "win32" ? "codex.exe" : "codex";
  const pathValue = options.path ?? process.env["PATH"] ?? "";
  for (const rawEntry of pathValue.split(delimiter)) {
    const entry = normalizePathEntry(rawEntry);
    if (entry === undefined || !isAbsolute(entry)) {
      continue;
    }

    try {
      return await validateCandidate(
        join(entry, executableName),
        options.bridgeExecutable,
        platform,
      );
    } catch (error) {
      if (!(error instanceof BridgeRuntimeError) || error.code !== "invalid_codex_executable") {
        throw error;
      }
    }
  }

  throw new BridgeRuntimeError("codex_not_found");
}

function normalizePathEntry(entry: string): string | undefined {
  if (entry.length === 0) {
    return undefined;
  }
  const quoted = entry.startsWith('"') || entry.endsWith('"');
  if (!quoted) {
    return entry;
  }
  return entry.startsWith('"') && entry.endsWith('"') && entry.length > 2
    ? entry.slice(1, -1)
    : undefined;
}

async function validateCandidate(
  candidate: string,
  bridgeExecutable: string | undefined,
  platform: NodeJS.Platform,
): Promise<string> {
  try {
    const candidateStats = await stat(candidate);
    if (!candidateStats.isFile()) {
      throw new BridgeRuntimeError("invalid_codex_executable");
    }
    await access(candidate, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);

    const resolvedCandidate = await realpath(candidate);
    if (bridgeExecutable !== undefined) {
      const resolvedBridge = await realpath(bridgeExecutable);
      const samePath =
        platform === "win32"
          ? resolvedCandidate.toLowerCase() === resolvedBridge.toLowerCase()
          : resolvedCandidate === resolvedBridge;
      if (samePath) {
        throw new BridgeRuntimeError("invalid_codex_executable");
      }
    }

    return resolvedCandidate;
  } catch (error) {
    if (error instanceof BridgeRuntimeError) {
      throw error;
    }
    throw new BridgeRuntimeError("invalid_codex_executable");
  }
}
