import { once } from "node:events";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  createWindowsIpcHelperEnvironment,
  WindowsIpcHelperProcess,
  type WindowsIpcHelperError,
  type WindowsIpcHelperSpawnOptions,
  type WindowsIpcHelperSpawner,
} from "../src/transport/windows-ipc-helper.js";

const SYNTHETIC_EXECUTABLE = resolve("synthetic-windows-ipc-helper.exe");

describe("WindowsIpcHelperProcess", () => {
  it("accepts the ordered server lifecycle and exposes dedicated relay streams", async () => {
    const helper = new WindowsIpcHelperProcess({
      executable: SYNTHETIC_EXECUTABLE,
      role: "server",
      spawn: nodeScriptSpawner(
        "process.stderr.write('ipc_listening\\nipc_connected\\n'); process.stdin.pipe(process.stdout);",
      ),
    });

    const completion = helper.start();
    await expect(helper.waitUntilListening()).resolves.toBeUndefined();
    await expect(helper.waitUntilConnected()).resolves.toBeUndefined();
    expect(helper.state).toBe("connected");

    const output = once(helper.output, "data");
    helper.input.write(Buffer.from("relay-bytes"));
    await expect(output).resolves.toEqual([Buffer.from("relay-bytes")]);

    helper.close();
    await expect(completion).resolves.toMatchObject({ code: null });
    expect(helper.state).toBe("closed");
  });

  it("accepts a client connection without a listening status", async () => {
    const helper = new WindowsIpcHelperProcess({
      executable: SYNTHETIC_EXECUTABLE,
      role: "client",
      spawn: nodeScriptSpawner("process.stderr.write('ipc_connected\\n'); process.stdin.resume();"),
    });

    const completion = helper.start();
    await expect(helper.waitUntilListening()).rejects.toMatchObject({
      code: "invalid_configuration",
    });
    await expect(helper.waitUntilConnected()).resolves.toBeUndefined();
    helper.close();
    await completion;
  });

  it.each([
    ["ipc_connected\n", "server"],
    ["ipc_listening\n", "client"],
    ["ipc_listening\nipc_listening\n", "server"],
    ["unknown_status\n", "server"],
    ["ipc_listening", "server"],
  ] as const)("rejects an invalid %s status sequence for %s", async (status, role) => {
    const helper = new WindowsIpcHelperProcess({
      executable: SYNTHETIC_EXECUTABLE,
      role,
      spawn: nodeScriptSpawner(`process.stderr.write(${JSON.stringify(status)});`),
    });

    const completion = helper.start();
    await expect(helper.waitUntilConnected()).rejects.toMatchObject({ code: "invalid_status" });
    await completion;
    expect(helper.state).toBe("closed");
  });

  it("preserves only an allowlisted native failure code", async () => {
    const helper = new WindowsIpcHelperProcess({
      executable: SYNTHETIC_EXECUTABLE,
      role: "client",
      spawn: nodeScriptSpawner(
        "process.stderr.write('gptsessionbridge_windows_ipc:peer_verification_failed\\n');",
      ),
    });

    const completion = helper.start();
    await expect(helper.waitUntilConnected()).rejects.toMatchObject({
      code: "native_failure",
      nativeCode: "peer_verification_failed",
    });
    await completion;
  });

  it("fails closed on invalid construction, duplicate start, and spawn failure", async () => {
    expect(
      () => new WindowsIpcHelperProcess({ executable: "relative.exe", role: "server" }),
    ).toThrow(
      expect.objectContaining<Partial<WindowsIpcHelperError>>({ code: "invalid_configuration" }),
    );

    const helper = new WindowsIpcHelperProcess({
      executable: SYNTHETIC_EXECUTABLE,
      role: "server",
      spawn: () => {
        throw new Error("synthetic spawn failure");
      },
    });
    expect(() => helper.input).toThrow(
      expect.objectContaining<Partial<WindowsIpcHelperError>>({ code: "invalid_configuration" }),
    );
    const completion = helper.start();
    expect(() => helper.start()).toThrow(
      expect.objectContaining<Partial<WindowsIpcHelperError>>({ code: "invalid_configuration" }),
    );
    await expect(helper.waitUntilConnected()).rejects.toMatchObject({ code: "spawn_failed" });
    await expect(completion).resolves.toEqual({ code: null, signal: null });
  });

  it("bounds a helper that never reports its initial lifecycle status", async () => {
    const helper = new WindowsIpcHelperProcess({
      executable: SYNTHETIC_EXECUTABLE,
      role: "server",
      spawn: nodeScriptSpawner("setInterval(() => {}, 1000);"),
      statusTimeoutMs: 10,
    });

    const completion = helper.start();
    await expect(helper.waitUntilListening()).rejects.toMatchObject({
      code: "status_timeout",
    });
    await completion;
    expect(helper.state).toBe("closed");
  });

  it("rejects invalid lifecycle timeout configuration", () => {
    expect(
      () =>
        new WindowsIpcHelperProcess({
          executable: SYNTHETIC_EXECUTABLE,
          role: "server",
          statusTimeoutMs: 0,
        }),
    ).toThrow(
      expect.objectContaining<Partial<WindowsIpcHelperError>>({
        code: "invalid_configuration",
      }),
    );
  });
});

describe("createWindowsIpcHelperEnvironment", () => {
  it("creates an empty environment for the self-contained helper", () => {
    const environment = createWindowsIpcHelperEnvironment();
    expect(environment).toEqual({});
    expect(Object.isFrozen(environment)).toBe(true);
  });
});

function nodeScriptSpawner(script: string): WindowsIpcHelperSpawner {
  return (_executable, _args, options) =>
    spawn(process.execPath, ["-e", script], toNodeSpawnOptions(options));
}

function toNodeSpawnOptions(options: WindowsIpcHelperSpawnOptions) {
  return {
    env: options.env,
    shell: options.shell,
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    windowsHide: options.windowsHide,
  };
}
