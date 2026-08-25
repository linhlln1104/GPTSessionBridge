import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEVELOPMENT_EXTENSION_ID as SHARED_EXTENSION_ID,
  DEVELOPMENT_EXTENSION_ORIGIN as SHARED_EXTENSION_ORIGIN,
  NATIVE_MESSAGING_HOST_NAME as SHARED_HOST_NAME,
} from "../../../packages/native-messaging/src/link/identity.js";
import { runWindowsSetupCli } from "../src/cli.js";
import {
  DEVELOPMENT_EXTENSION_ID,
  DEVELOPMENT_EXTENSION_ORIGIN,
  DEVELOPMENT_NATIVE_HOST_NAME,
  WindowsSetupError,
} from "../src/index.js";
import {
  MemoryRegistry,
  createPackage,
  createSetupDependencies,
  createTemporaryDirectory,
  removeTemporaryDirectory,
} from "./fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

describe("development setup identity and CLI", () => {
  it("stays aligned with the shared development Native Messaging identity", () => {
    expect(DEVELOPMENT_EXTENSION_ID).toBe(SHARED_EXTENSION_ID);
    expect(DEVELOPMENT_EXTENSION_ORIGIN).toBe(SHARED_EXTENSION_ORIGIN);
    expect(DEVELOPMENT_NATIVE_HOST_NAME).toBe(SHARED_HOST_NAME);
  });

  it("supports the default package install, status, and uninstall commands", async () => {
    const root = await trackedTemporaryDirectory();
    const source = await createPackage(root);
    const localAppData = join(root, "local-app-data");
    await mkdir(localAppData);
    const registry = new MemoryRegistry();
    const output: string[] = [];
    const options = {
      defaultPackageRoot: source,
      dependencies: createSetupDependencies(localAppData, registry),
      stdout: {
        write: (text: string) => {
          output.push(text);
          return true;
        },
      },
    };

    await runWindowsSetupCli(["install"], options);
    await runWindowsSetupCli(["status"], options);
    await runWindowsSetupCli(["uninstall"], options);

    expect(
      output.map((line) => JSON.parse(line) as { state?: string; unregistered?: boolean }),
    ).toEqual([
      expect.objectContaining({ state: "installed" }),
      expect.objectContaining({ state: "installed" }),
      expect.objectContaining({ unregistered: true }),
    ]);
  });

  it("rejects ambiguous command lines", async () => {
    await expect(runWindowsSetupCli(["install", "unexpected"])).rejects.toBeInstanceOf(
      WindowsSetupError,
    );
  });
});

async function trackedTemporaryDirectory(): Promise<string> {
  const directory = await createTemporaryDirectory("gptsb-cli-");
  temporaryDirectories.push(directory);
  return directory;
}
