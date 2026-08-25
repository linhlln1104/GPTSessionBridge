import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import { DEVELOPMENT_EXTENSION_ORIGIN } from "@gpt-session-bridge/native-messaging/link";
import { describe, expect, it } from "vitest";

import {
  parseChromeInvocation,
  resolveWindowsIpcHelperExecutable,
  runNativeHost,
  type NativeHostCliError,
} from "../src/cli.js";

describe("native host CLI", () => {
  it("accepts only Chrome's exact origin and optional Windows parent argument shape", () => {
    expect(parseChromeInvocation([DEVELOPMENT_EXTENSION_ORIGIN])).toBe(
      DEVELOPMENT_EXTENSION_ORIGIN,
    );
    expect(parseChromeInvocation([DEVELOPMENT_EXTENSION_ORIGIN, "--parent-window=0"])).toBe(
      DEVELOPMENT_EXTENSION_ORIGIN,
    );

    for (const args of [
      [],
      [DEVELOPMENT_EXTENSION_ORIGIN, "--parent-window=-1"],
      [DEVELOPMENT_EXTENSION_ORIGIN, "--parent-window=1", "extra"],
      [DEVELOPMENT_EXTENSION_ORIGIN, "--unknown=1"],
    ]) {
      expect(() => parseChromeInvocation(args)).toThrow(
        expect.objectContaining<Partial<NativeHostCliError>>({ code: "invalid_invocation" }),
      );
    }
  });

  it("resolves only the packaged Windows x64 helper", () => {
    let candidate = "";
    const resolved = resolveWindowsIpcHelperExecutable(
      pathToFileURL("C:/synthetic/apps/native-host/dist/cli.js").href,
      "win32",
      "x64",
      (path) => {
        candidate = path;
        return true;
      },
    );
    expect(resolved).toBe(candidate);
    expect(
      resolved
        .replaceAll("\\", "/")
        .endsWith("/native/windows-ipc/artifacts/win-x64/gptsessionbridge-windows-ipc.exe"),
    ).toBe(true);

    expect(() =>
      resolveWindowsIpcHelperExecutable(import.meta.url, "linux", "x64", () => true),
    ).toThrow(
      expect.objectContaining<Partial<NativeHostCliError>>({ code: "unsupported_platform" }),
    );
    expect(() =>
      resolveWindowsIpcHelperExecutable(import.meta.url, "win32", "arm64", () => true),
    ).toThrow(
      expect.objectContaining<Partial<NativeHostCliError>>({ code: "unsupported_platform" }),
    );
    expect(() =>
      resolveWindowsIpcHelperExecutable(import.meta.url, "win32", "x64", () => false),
    ).toThrow(expect.objectContaining<Partial<NativeHostCliError>>({ code: "helper_unavailable" }));
  });

  it("validates the caller before reading an otherwise empty Chrome channel", async () => {
    const validInput = new PassThrough();
    validInput.end();
    await expect(
      runNativeHost([DEVELOPMENT_EXTENSION_ORIGIN], {
        createHelper: () => {
          throw new Error("The empty Chrome channel must not open IPC");
        },
        extensionInput: validInput,
        extensionOutput: new PassThrough(),
        helperExecutable: "unused-by-test",
      }),
    ).resolves.toBeUndefined();

    const invalidInput = new PassThrough();
    invalidInput.end();
    await expect(
      runNativeHost([`chrome-extension://${"a".repeat(32)}/`], {
        extensionInput: invalidInput,
        extensionOutput: new PassThrough(),
        helperExecutable: "unused-by-test",
      }),
    ).rejects.toMatchObject({ code: "invalid_origin" });
  });
});
