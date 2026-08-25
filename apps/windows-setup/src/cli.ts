#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { WindowsSetupError } from "./errors.js";
import {
  getWindowsDevelopmentHostStatus,
  installWindowsDevelopmentHost,
  uninstallWindowsDevelopmentHost,
  type WindowsSetupDependencies,
} from "./setup-service.js";

const FAILURE_EXIT_CODE = 1;

export interface WindowsSetupCliOptions {
  readonly defaultPackageRoot?: string;
  readonly dependencies?: WindowsSetupDependencies;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
}

export async function runWindowsSetupCli(
  args: readonly string[],
  options: WindowsSetupCliOptions = {},
): Promise<void> {
  const dependencies = options.dependencies ?? {};
  const stdout = options.stdout ?? process.stdout;
  const command = parseCliCommand(
    args,
    options.defaultPackageRoot ?? resolve(process.cwd(), "artifacts", "windows-x64"),
  );
  const result =
    command.name === "install"
      ? await installWindowsDevelopmentHost(command.packageRoot, dependencies)
      : command.name === "status"
        ? await getWindowsDevelopmentHostStatus(dependencies)
        : await uninstallWindowsDevelopmentHost(dependencies);
  stdout.write(`${JSON.stringify(result)}\n`);
}

export async function runWindowsSetupProcess(
  args: readonly string[] = process.argv.slice(2),
  options: WindowsSetupCliOptions = {},
): Promise<void> {
  try {
    await runWindowsSetupCli(args, options);
  } catch (error) {
    const code = error instanceof WindowsSetupError ? error.code : "setup_failure";
    (options.stderr ?? process.stderr).write(`GPTSessionBridge setup failed (${code}).\n`);
    process.exitCode = FAILURE_EXIT_CODE;
  }
}

type CliCommand =
  | { readonly name: "install"; readonly packageRoot: string }
  | { readonly name: "status" | "uninstall" };

function parseCliCommand(args: readonly string[], defaultPackageRoot: string): CliCommand {
  if (args.length === 1 && (args[0] === "status" || args[0] === "uninstall")) {
    return Object.freeze({ name: args[0] });
  }
  if (args.length === 1 && args[0] === "install") {
    return Object.freeze({ name: "install", packageRoot: defaultPackageRoot });
  }
  if (
    args.length === 3 &&
    args[0] === "install" &&
    args[1] === "--package" &&
    args[2] !== undefined &&
    args[2].length > 0
  ) {
    return Object.freeze({ name: "install", packageRoot: args[2] });
  }
  throw new WindowsSetupError("invalid_invocation");
}

function isDirectExecution(entry: string | undefined): boolean {
  return entry !== undefined && pathToFileURL(entry).href === import.meta.url;
}

if (isDirectExecution(process.argv[1])) {
  void runWindowsSetupProcess();
}
