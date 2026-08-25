import { once } from "node:events";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BRIDGE_ACTIVE_ENV } from "../src/constants.js";
import {
  createDefaultBrowserIpcRuntime,
  resolveWindowsIpcHelperExecutable,
} from "../src/runtime/browser-ipc-runtime.js";
import { CodexChild } from "../src/runtime/codex-child.js";
import { resolveCodexExecutable } from "../src/runtime/codex-executable.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("resolveCodexExecutable", () => {
  it("resolves an absolute override and PATH candidate", async () => {
    const directory = await createTemporaryDirectory();
    const executableName = process.platform === "win32" ? "codex.exe" : "codex";
    const executable = join(directory, executableName);
    await writeFile(executable, "synthetic executable fixture", "utf8");
    await chmod(executable, 0o755);

    const resolvedExecutable = await realpath(executable);
    await expect(resolveCodexExecutable({ override: executable })).resolves.toBe(
      resolvedExecutable,
    );
    await expect(resolveCodexExecutable({ path: directory })).resolves.toBe(resolvedExecutable);
    await expect(resolveCodexExecutable({ path: `"${directory}"` })).resolves.toBe(
      resolvedExecutable,
    );
  });

  it("rejects relative, missing, and recursive executable paths", async () => {
    await expect(resolveCodexExecutable({ override: "relative-codex" })).rejects.toMatchObject({
      code: "invalid_codex_executable",
    });

    const directory = await createTemporaryDirectory();
    const executableName = process.platform === "win32" ? "codex.exe" : "codex";
    const executable = join(directory, executableName);
    await writeFile(executable, "synthetic executable fixture", "utf8");
    await chmod(executable, 0o755);
    await expect(
      resolveCodexExecutable({ bridgeExecutable: executable, override: executable }),
    ).rejects.toMatchObject({ code: "invalid_codex_executable" });
    await expect(resolveCodexExecutable({ path: directory + "-missing" })).rejects.toMatchObject({
      code: "codex_not_found",
    });
    await expect(resolveCodexExecutable({ path: "." })).rejects.toMatchObject({
      code: "codex_not_found",
    });
  });
});

describe("Windows browser IPC runtime", () => {
  const syntheticCliUrl = pathToFileURL(
    join(process.cwd(), "apps", "bridge", "dist", "cli.js"),
  ).href;

  it("resolves only the canonical self-contained x64 helper", () => {
    let inspectedPath: string | undefined;
    const resolved = resolveWindowsIpcHelperExecutable(
      syntheticCliUrl,
      "win32",
      "x64",
      (candidate) => {
        inspectedPath = candidate;
        return true;
      },
    );

    expect(resolved).toBe(inspectedPath);
    expect(resolved).toBe(
      join(
        process.cwd(),
        "native",
        "windows-ipc",
        "artifacts",
        "win-x64",
        "gptsessionbridge-windows-ipc.exe",
      ),
    );
    expect(() =>
      resolveWindowsIpcHelperExecutable(syntheticCliUrl, "win32", "arm64", () => true),
    ).toThrow(expect.objectContaining({ code: "browser_ipc_unavailable" }));
    expect(() =>
      resolveWindowsIpcHelperExecutable(syntheticCliUrl, "win32", "x64", () => false),
    ).toThrow(expect.objectContaining({ code: "browser_ipc_unavailable" }));
  });

  it("enables the broker only on the supported Windows platform", async () => {
    expect(createDefaultBrowserIpcRuntime(syntheticCliUrl, "linux", "x64", () => true)).toBe(
      undefined,
    );
    const runtime = createDefaultBrowserIpcRuntime(syntheticCliUrl, "win32", "x64", () => true);
    expect(runtime).toBeDefined();
    await runtime?.close();
    expect(createDefaultBrowserIpcRuntime(syntheticCliUrl, "win32", "arm64", () => true)).toBe(
      undefined,
    );
    expect(createDefaultBrowserIpcRuntime(syntheticCliUrl, "win32", "x64", () => false)).toBe(
      undefined,
    );
  });
});

describe("CodexChild", () => {
  it("treats an explicit child environment as authoritative", async () => {
    vi.stubEnv("GPTSESSIONBRIDGE_AMBIENT_CANARY", "must-not-cross-boundary");
    const child = new CodexChild({
      args: [
        "-e",
        [
          "process.stdout.write(JSON.stringify({",
          `active: process.env.${BRIDGE_ACTIVE_ENV},`,
          "allowed: process.env.GPTSESSIONBRIDGE_TEST_ALLOWED,",
          "ambientCanary: process.env.GPTSESSIONBRIDGE_AMBIENT_CANARY !== undefined",
          "}));",
          "process.stdin.resume();",
          "process.stdin.on('end', () => process.exit(0));",
        ].join(""),
      ],
      env: { GPTSESSIONBRIDGE_TEST_ALLOWED: "yes" },
      executable: process.execPath,
      shutdownGraceMs: 1_000,
    });

    const processHandle = child.start();
    const [stdout] = (await once(processHandle.stdout, "data")) as [Buffer];
    const output: unknown = JSON.parse(stdout.toString("utf8"));
    expect(output).toEqual({
      active: "1",
      allowed: "yes",
      ambientCanary: false,
    });
    await expect(child.shutdown()).resolves.toMatchObject({ code: 0 });
  });

  it("moves through initialization, ready, draining, and exited states", async () => {
    const child = new CodexChild({
      args: [
        "-e",
        `process.stdout.write(process.env.${BRIDGE_ACTIVE_ENV} ?? ""); process.stderr.write("x"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`,
      ],
      executable: process.execPath,
      shutdownGraceMs: 1_000,
    });

    const processHandle = child.start();
    expect(child.state).toBe("initializing");
    const [stdout] = (await once(processHandle.stdout, "data")) as [Buffer];
    expect(stdout.toString("utf8")).toBe("1");
    child.markReady();
    expect(child.state).toBe("ready");

    const exit = await child.shutdown();
    expect(exit.code).toBe(0);
    expect(exit.stderrBytes).toBe(1);
    expect(child.state).toBe("exited");
    await expect(child.shutdown()).resolves.toEqual(exit);
  });

  it("terminates a child that does not drain within the grace period", async () => {
    const child = new CodexChild({
      args: ["-e", "setInterval(() => {}, 1000)"],
      executable: process.execPath,
      shutdownGraceMs: 500,
    });
    child.start();
    child.markReady();

    const exit = await child.shutdown();
    expect(exit.signal ?? exit.code).not.toBeNull();
    expect(child.state).toBe("exited");
  });

  it("rejects invalid lifecycle transitions", () => {
    const child = new CodexChild({
      args: [],
      executable: process.execPath,
      shutdownGraceMs: 100,
    });

    expect(() => child.process).toThrow(expect.objectContaining({ code: "invalid_state" }));
    expect(() => {
      child.markReady();
    }).toThrow(expect.objectContaining({ code: "invalid_state" }));
    expect(() => child.waitForExit()).toThrow(expect.objectContaining({ code: "invalid_state" }));
    expect(
      () =>
        new CodexChild({
          args: [],
          executable: process.execPath,
          shutdownGraceMs: 0,
        }),
    ).toThrow(RangeError);
  });

  it("reports a content-free startup error for a missing executable", async () => {
    const directory = await createTemporaryDirectory();
    const child = new CodexChild({
      args: [],
      executable: join(directory, "missing-codex-executable"),
      shutdownGraceMs: 100,
    });

    child.start();
    await expect(child.waitForExit()).rejects.toMatchObject({ code: "startup_failed" });
    expect(child.state).toBe("exited");
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gptsb-runtime-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
