import { describe, expect, it } from "vitest";

import {
  DEVELOPMENT_NATIVE_HOST_NAME,
  SpawnCommandRunner,
  WindowsCurrentUserChromeRegistry,
  WindowsSetupError,
  type CommandResult,
  type CommandRunner,
} from "../src/index.js";

class QueuedRunner implements CommandRunner {
  public readonly calls: { readonly args: readonly string[]; readonly executable: string }[] = [];
  readonly #results: CommandResult[];

  public constructor(results: CommandResult[]) {
    this.#results = results;
  }

  public run(executable: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push({ args, executable });
    const result = this.#results.shift();
    if (result === undefined) {
      return Promise.reject(new Error("unexpected command"));
    }
    return Promise.resolve(result);
  }
}

const MISSING = Object.freeze({ exitCode: 1, stderr: "", stdout: "" });
const SUCCESS = Object.freeze({ exitCode: 0, stderr: "", stdout: "" });

describe("per-user Chrome registry adapter", () => {
  it("queries the fixed HKCU host key in the 64-bit registry view", async () => {
    const manifestPath = String.raw`C:\Users\Example\manifest.json`;
    const runner = new QueuedRunner([
      {
        exitCode: 0,
        stderr: "",
        stdout: `HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\${DEVELOPMENT_NATIVE_HOST_NAME}\r\n    (Default)    REG_SZ    ${manifestPath}\r\n`,
      },
    ]);
    const registry = createRegistry(runner);

    await expect(registry.readHostPath(DEVELOPMENT_NATIVE_HOST_NAME, "64")).resolves.toBe(
      manifestPath,
    );
    expect(runner.calls).toEqual([
      {
        args: [
          "query",
          `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${DEVELOPMENT_NATIVE_HOST_NAME}`,
          "/ve",
          "/reg:64",
        ],
        executable: String.raw`C:\Windows\System32\reg.exe`,
      },
    ]);
  });

  it("adds only when the expected value still matches and uses REG_SZ", async () => {
    const manifestPath = String.raw`C:\Managed\registration.json`;
    const runner = new QueuedRunner([
      MISSING,
      SUCCESS,
      {
        exitCode: 0,
        stderr: "",
        stdout: `    (Default)    REG_SZ    ${manifestPath}\r\n`,
      },
    ]);
    const registry = createRegistry(runner);

    await expect(
      registry.replaceHostPathIfExpected(
        DEVELOPMENT_NATIVE_HOST_NAME,
        "32",
        undefined,
        manifestPath,
      ),
    ).resolves.toBe(true);
    expect(runner.calls[1]?.args).toEqual([
      "add",
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${DEVELOPMENT_NATIVE_HOST_NAME}`,
      "/ve",
      "/t",
      "REG_SZ",
      "/d",
      manifestPath,
      "/f",
      "/reg:32",
    ]);
  });

  it("does not overwrite a changed value and deletes only an expected value", async () => {
    const registered = String.raw`C:\Managed\registration.json`;
    const query = (value: string): CommandResult => ({
      exitCode: 0,
      stderr: "",
      stdout: `    (Default)    REG_SZ    ${value}\r\n`,
    });
    const mismatchRunner = new QueuedRunner([query(String.raw`C:\Foreign\manifest.json`)]);
    await expect(
      createRegistry(mismatchRunner).replaceHostPathIfExpected(
        DEVELOPMENT_NATIVE_HOST_NAME,
        "64",
        registered,
        String.raw`C:\Managed\next.json`,
      ),
    ).resolves.toBe(false);
    expect(mismatchRunner.calls).toHaveLength(1);

    const deleteRunner = new QueuedRunner([query(registered), SUCCESS, MISSING]);
    await expect(
      createRegistry(deleteRunner).removeHostPathIfExpected(
        DEVELOPMENT_NATIVE_HOST_NAME,
        "64",
        registered,
      ),
    ).resolves.toBe(true);
    expect(deleteRunner.calls[1]?.args).toEqual([
      "delete",
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${DEVELOPMENT_NATIVE_HOST_NAME}`,
      "/f",
      "/reg:64",
    ]);
  });

  it("fails closed on malformed output, command failure, or invalid host names", async () => {
    await expect(
      createRegistry(
        new QueuedRunner([{ exitCode: 0, stderr: "", stdout: "malformed" }]),
      ).readHostPath(DEVELOPMENT_NATIVE_HOST_NAME, "32"),
    ).rejects.toBeInstanceOf(WindowsSetupError);
    await expect(
      createRegistry(
        new QueuedRunner([{ exitCode: 2, stderr: "denied", stdout: "" }]),
      ).readHostPath(DEVELOPMENT_NATIVE_HOST_NAME, "64"),
    ).rejects.toMatchObject({ code: "registry_failure" });
    await expect(
      createRegistry(new QueuedRunner([])).readHostPath("invalid\\host", "32"),
    ).rejects.toMatchObject({ code: "registry_failure" });
    await expect(
      createRegistry(new QueuedRunner([])).replaceHostPathIfExpected(
        DEVELOPMENT_NATIVE_HOST_NAME,
        "32",
        undefined,
        "relative.json",
      ),
    ).rejects.toMatchObject({ code: "registry_failure" });
  });

  it("fails closed when post-write or post-delete verification observes a race", async () => {
    const registered = String.raw`C:\Managed\registration.json`;
    const foreign = String.raw`C:\Foreign\registration.json`;
    const query = (value: string): CommandResult => ({
      exitCode: 0,
      stderr: "",
      stdout: `    (Default)    REG_SZ    ${value}\r\n`,
    });
    const writeRunner = new QueuedRunner([MISSING, SUCCESS, query(foreign)]);
    await expect(
      createRegistry(writeRunner).replaceHostPathIfExpected(
        DEVELOPMENT_NATIVE_HOST_NAME,
        "32",
        undefined,
        registered,
      ),
    ).resolves.toBe(false);

    const deleteRunner = new QueuedRunner([query(registered), SUCCESS, query(foreign)]);
    await expect(
      createRegistry(deleteRunner).removeHostPathIfExpected(
        DEVELOPMENT_NATIVE_HOST_NAME,
        "64",
        registered,
      ),
    ).resolves.toBe(false);
  });

  it("requires an absolute Windows directory", () => {
    expect(
      () =>
        new WindowsCurrentUserChromeRegistry({
          commandRunner: new QueuedRunner([]),
          windowsDirectory: "relative",
        }),
    ).toThrow(expect.objectContaining({ code: "registry_failure" }));
  });

  it("bounds command execution and fails closed on undecodable output", async () => {
    const windowsDirectory = process.env["SystemRoot"] ?? String.raw`C:\Windows`;
    const timedRunner = new SpawnCommandRunner({ timeoutMs: 20, windowsDirectory });
    await expect(
      timedRunner.run(process.execPath, ["-e", "setTimeout(() => undefined, 1000)"]),
    ).rejects.toMatchObject({ code: "registry_failure" });

    const decodingRunner = new SpawnCommandRunner({ timeoutMs: 5_000, windowsDirectory });
    await expect(
      decodingRunner.run(process.execPath, ["-e", "process.stdout.write(Buffer.from([0xff]));"]),
    ).rejects.toMatchObject({ code: "registry_failure" });
  });

  it("decodes UTF-8 and UTF-16LE registry output without a console code-page guess", async () => {
    const windowsDirectory = process.env["SystemRoot"] ?? String.raw`C:\Windows`;
    const runner = new SpawnCommandRunner({ timeoutMs: 5_000, windowsDirectory });
    const output = "    (Default)    REG_SZ    C:\\Users\\Tế\\manifest.json\r\n";
    const emitBase64 = "process.stdout.write(Buffer.from(process.argv[1], 'base64'));";
    const encodings = [
      Buffer.from(output, "utf8"),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(output, "utf16le")]),
      Buffer.from(output, "utf16le"),
    ];

    for (const encoded of encodings) {
      await expect(
        runner.run(process.execPath, ["-e", emitBase64, encoded.toString("base64")]),
      ).resolves.toMatchObject({ exitCode: 0, stdout: output });
    }
  });
});

function createRegistry(runner: CommandRunner): WindowsCurrentUserChromeRegistry {
  return new WindowsCurrentUserChromeRegistry({
    commandRunner: runner,
    windowsDirectory: String.raw`C:\Windows`,
  });
}
