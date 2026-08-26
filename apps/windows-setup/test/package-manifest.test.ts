import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  NODE_FILE_SYSTEM,
  PACKAGE_MANIFEST_SCHEMA_VERSION,
  WindowsSetupError,
  parseWindowsPackageManifest,
  serializeWindowsPackageManifest,
  verifyWindowsPackage,
  writeWindowsPackageManifest,
} from "../src/index.js";
import {
  TEST_PATHS,
  createPackage,
  createTemporaryDirectory,
  removeTemporaryDirectory,
} from "./fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

describe("Windows package manifest", () => {
  it("creates, writes, and verifies a canonical content-hashed package", async () => {
    const parent = await trackedTemporaryDirectory();
    const root = await createPackage(parent, "1.2.3.4");

    const verified = await verifyWindowsPackage(root, { path: TEST_PATHS });

    expect(verified.manifest.packageVersion).toBe("1.2.3.4");
    expect(verified.manifest.facadeExecutable).toBe("native-host/gptsessionbridge-facade.exe");
    expect(verified.manifest.hostExecutable).toBe("native-host/gptsessionbridge-native-host.exe");
    expect(verified.manifest.files.map((file) => file.path)).toEqual([
      "extension/background/service-worker.js",
      "extension/chunks/chrome-api.js",
      "extension/content/content-script.js",
      "extension/manifest.json",
      "extension/popup/popup.css",
      "extension/popup/popup.html",
      "extension/popup/popup.js",
      "native-host/chrome-windows.template.json",
      "native-host/gptsessionbridge-facade.exe",
      "native-host/gptsessionbridge-native-host.exe",
      "native-host/gptsessionbridge-windows-ipc.exe",
    ]);
    expect(verified.packageDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readFile(join(root, "package-manifest.json"), "utf8")).toBe(
      serializeWindowsPackageManifest(verified.manifest),
    );
  });

  it("rejects traversal, extra keys, unsorted files, and invalid host metadata", () => {
    const validFile = {
      path: "native-host/host.exe",
      sha256: "0".repeat(64),
      size: 1,
    };
    const base = {
      facadeExecutable: validFile.path,
      files: [validFile],
      hostExecutable: validFile.path,
      packageVersion: "1.0.0",
      schemaVersion: PACKAGE_MANIFEST_SCHEMA_VERSION,
    };

    expect(() => parseWindowsPackageManifest(JSON.stringify({ ...base, extra: true }))).toThrow(
      WindowsSetupError,
    );
    expect(() =>
      parseWindowsPackageManifest(JSON.stringify({ ...base, schemaVersion: 1 })),
    ).toThrow(expect.objectContaining({ code: "invalid_package_manifest" }));
    expect(() =>
      parseWindowsPackageManifest(
        JSON.stringify({ ...base, hostExecutable: "../native-host/host.exe" }),
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_package_path" }));
    expect(() =>
      parseWindowsPackageManifest(
        JSON.stringify({
          ...base,
          files: [
            { ...validFile, path: "z.exe" },
            { ...validFile, path: "a.exe" },
          ],
          hostExecutable: "a.exe",
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_package_manifest" }));
    expect(() =>
      parseWindowsPackageManifest(
        JSON.stringify({
          ...base,
          files: [
            { ...validFile, path: "native-host/host.exe", size: 300 * 1024 * 1024 },
            { ...validFile, path: "native-host/runtime.bin", size: 300 * 1024 * 1024 },
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_package_manifest" }));
    expect(() =>
      parseWindowsPackageManifest(JSON.stringify({ ...base, packageVersion: "latest" })),
    ).toThrow(expect.objectContaining({ code: "invalid_package_manifest" }));
    for (const packageVersion of [
      "0",
      "0.0.0.0",
      "01.2.3",
      "1.2.3.4.5",
      "1.2.3-beta.1",
      "1.2.65536",
    ]) {
      expect(() =>
        parseWindowsPackageManifest(JSON.stringify({ ...base, packageVersion })),
      ).toThrow(expect.objectContaining({ code: "invalid_package_manifest" }));
    }
    expect(() => parseWindowsPackageManifest("{")).toThrow(
      expect.objectContaining({ code: "invalid_package_manifest" }),
    );
    expect(() => parseWindowsPackageManifest(JSON.stringify({ ...base, files: [] }))).toThrow(
      expect.objectContaining({ code: "invalid_package_manifest" }),
    );
    expect(() =>
      parseWindowsPackageManifest(
        JSON.stringify({ ...base, files: [{ ...validFile, sha256: "A".repeat(64) }] }),
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_package_manifest" }));
    expect(() =>
      parseWindowsPackageManifest(
        JSON.stringify({
          ...base,
          files: [{ ...validFile, size: 512 * 1024 * 1024 + 1 }],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_package_manifest" }));
  });

  it("detects extra artifacts and content changes without trusting the manifest", async () => {
    const parent = await trackedTemporaryDirectory();
    const root = await createPackage(parent);
    await writeFile(join(root, "unexpected.dll"), "unhashed");

    await expect(verifyWindowsPackage(root, { path: TEST_PATHS })).rejects.toMatchObject({
      code: "package_contents_mismatch",
    });

    const secondRoot = await createPackage(parent, "0.2.0");
    const artifactPath = join(secondRoot, "extension", "manifest.json");
    const changedBytes = Buffer.from(await readFile(artifactPath));
    changedBytes[0] = changedBytes[0] === 0x7b ? 0x5b : 0x7b;
    await writeFile(artifactPath, changedBytes);
    await expect(verifyWindowsPackage(secondRoot, { path: TEST_PATHS })).rejects.toMatchObject({
      code: "artifact_hash_mismatch",
    });
  });

  it("rejects an oversized package manifest before reading its contents", async () => {
    const parent = await trackedTemporaryDirectory();
    const root = await createPackage(parent);
    const manifestPath = join(root, "package-manifest.json");
    let boundedManifestRead = false;

    await expect(
      verifyWindowsPackage(root, {
        fileSystem: {
          ...NODE_FILE_SYSTEM,
          async inspect(path) {
            if (path === manifestPath) {
              return { kind: "file", size: Number.MAX_SAFE_INTEGER };
            }
            return NODE_FILE_SYSTEM.inspect(path);
          },
          async readTextBounded(path, maximumBytes) {
            if (path === manifestPath) {
              boundedManifestRead = true;
            }
            return NODE_FILE_SYSTEM.readTextBounded(path, maximumBytes);
          },
        },
        path: TEST_PATHS,
      }),
    ).rejects.toMatchObject({ code: "invalid_package_manifest" });
    expect(boundedManifestRead).toBe(false);
  });

  it("rejects non-canonical manifest bytes and case-insensitive path collisions", async () => {
    const parent = await trackedTemporaryDirectory();
    const root = await createPackage(parent);
    const manifestPath = join(root, "package-manifest.json");
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    await writeFile(manifestPath, JSON.stringify(parsed));

    await expect(verifyWindowsPackage(root, { path: TEST_PATHS })).rejects.toMatchObject({
      code: "invalid_package_manifest",
    });

    expect(() =>
      parseWindowsPackageManifest(
        JSON.stringify({
          files: [
            { path: "Host/app.exe", sha256: "0".repeat(64), size: 1 },
            { path: "host/app.exe", sha256: "1".repeat(64), size: 1 },
          ],
          facadeExecutable: "Host/app.exe",
          hostExecutable: "Host/app.exe",
          packageVersion: "1.0.0",
          schemaVersion: PACKAGE_MANIFEST_SCHEMA_VERSION,
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_package_manifest" }));
  });

  it("rejects linked package content", async () => {
    const parent = await trackedTemporaryDirectory();
    const root = join(parent, "linked-package");
    const outside = join(parent, "outside");
    await mkdir(join(root, "native-host"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(root, "native-host", "host.exe"), "host");
    await writeFile(join(outside, "payload.js"), "payload");
    const link = join(root, "extension");
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");

    await expect(
      writeWindowsPackageManifest(
        root,
        {
          facadeExecutable: "native-host/host.exe",
          hostExecutable: "native-host/host.exe",
          packageVersion: "1.0.0",
        },
        { path: TEST_PATHS },
      ),
    ).rejects.toMatchObject({ code: "invalid_package_path" });
  });

  it("refuses to overwrite an existing package manifest", async () => {
    const parent = await trackedTemporaryDirectory();
    const root = await createPackage(parent);

    await expect(
      writeWindowsPackageManifest(
        root,
        {
          facadeExecutable: "native-host/gptsessionbridge-facade.exe",
          hostExecutable: "native-host/gptsessionbridge-native-host.exe",
          packageVersion: "0.1.0",
        },
        { path: TEST_PATHS },
      ),
    ).rejects.toMatchObject({ code: "filesystem_conflict" });
  });
});

async function trackedTemporaryDirectory(): Promise<string> {
  const directory = await createTemporaryDirectory("gptsb-manifest-");
  temporaryDirectories.push(directory);
  return directory;
}
