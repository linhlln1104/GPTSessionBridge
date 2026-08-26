import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  NODE_FILE_SYSTEM,
  verifyWindowsDevelopmentPackage,
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

describe("Windows development package contract", () => {
  it("verifies the canonical Native Messaging and MV3 package using bounded reads", async () => {
    const parent = await trackedTemporaryDirectory();
    const packageRoot = await createPackage(parent);
    const readLimits: number[] = [];

    const verified = await verifyWindowsDevelopmentPackage(packageRoot, {
      fileSystem: {
        ...NODE_FILE_SYSTEM,
        async readTextBounded(path, maximumBytes) {
          readLimits.push(maximumBytes);
          return NODE_FILE_SYSTEM.readTextBounded(path, maximumBytes);
        },
      },
      path: TEST_PATHS,
    });

    expect(verified.manifest.packageVersion).toBe("0.1.0");
    expect(readLimits).toContain(4 * 1024);
    expect(readLimits).toContain(32 * 1024);
  });

  it.each([
    [
      "optional host access",
      (manifest: Record<string, unknown>) => {
        manifest["optional_host_permissions"] = ["https://*/*"];
      },
    ],
    [
      "external callers",
      (manifest: Record<string, unknown>) => {
        manifest["externally_connectable"] = { matches: ["https://example.com/*"] };
      },
    ],
    [
      "a weaker content security policy",
      (manifest: Record<string, unknown>) => {
        manifest["content_security_policy"] = {
          extension_pages: "default-src 'self'; connect-src https:; object-src 'none'",
        };
      },
    ],
    [
      "a different service worker",
      (manifest: Record<string, unknown>) => {
        manifest["background"] = { service_worker: "background/other.js", type: "module" };
      },
    ],
    [
      "an additional permission",
      (manifest: Record<string, unknown>) => {
        manifest["permissions"] = ["activeTab", "scripting", "nativeMessaging", "storage"];
      },
    ],
    [
      "a content script",
      (manifest: Record<string, unknown>) => {
        manifest["content_scripts"] = [
          { js: ["content/content-script.js"], matches: ["https://chatgpt.com/*"] },
        ];
      },
    ],
    [
      "a different public key",
      (manifest: Record<string, unknown>) => {
        manifest["key"] = "AQID";
      },
    ],
    [
      "a version inconsistent with the package",
      (manifest: Record<string, unknown>) => {
        manifest["version"] = "0.2.0";
      },
    ],
  ])("rejects an extension manifest containing %s", async (_label, mutateManifest) => {
    const parent = await trackedTemporaryDirectory();
    const packageRoot = await createPackage(parent);
    await rewriteExtensionManifest(packageRoot, mutateManifest);

    await expect(
      verifyWindowsDevelopmentPackage(packageRoot, { path: TEST_PATHS }),
    ).rejects.toMatchObject({ code: "invalid_package_manifest" });
  });

  it.each([
    "extension/background/service-worker.js",
    "extension/chunks/chrome-api.js",
    "extension/content/content-script.js",
    "extension/popup/popup.css",
    "extension/popup/popup.html",
    "extension/popup/popup.js",
    "native-host/gptsessionbridge-facade.exe",
    "native-host/gptsessionbridge-windows-ipc.exe",
  ])("rejects a self-consistent package missing required runtime artifact %s", async (path) => {
    const parent = await trackedTemporaryDirectory();
    const packageRoot = await createPackage(parent);
    await rm(join(packageRoot, ...path.split("/")));
    if (path === "extension/background/service-worker.js") {
      await rm(join(packageRoot, "extension", "background"), { recursive: true });
    }
    if (path === "extension/content/content-script.js") {
      await rm(join(packageRoot, "extension", "content"), { recursive: true });
    }
    if (path === "extension/chunks/chrome-api.js") {
      await rm(join(packageRoot, "extension", "chunks"), { recursive: true });
    }
    await rewritePackageManifest(
      packageRoot,
      "0.1.0",
      path === "native-host/gptsessionbridge-facade.exe"
        ? "native-host/gptsessionbridge-native-host.exe"
        : "native-host/gptsessionbridge-facade.exe",
    );

    await expect(
      verifyWindowsDevelopmentPackage(packageRoot, { path: TEST_PATHS }),
    ).rejects.toMatchObject({ code: "invalid_package_manifest" });
  });
});

async function rewriteExtensionManifest(
  packageRoot: string,
  mutateManifest: (manifest: Record<string, unknown>) => void,
): Promise<void> {
  const manifestPath = join(packageRoot, "extension", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const packageVersion = manifest["version"];
  if (typeof packageVersion !== "string") {
    throw new Error("Synthetic extension manifest has no version.");
  }
  mutateManifest(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
  await rewritePackageManifest(packageRoot, packageVersion);
}

async function rewritePackageManifest(
  packageRoot: string,
  packageVersion: string,
  facadeExecutable = "native-host/gptsessionbridge-facade.exe",
): Promise<void> {
  await rm(join(packageRoot, "package-manifest.json"));
  await writeWindowsPackageManifest(
    packageRoot,
    {
      facadeExecutable,
      hostExecutable: "native-host/gptsessionbridge-native-host.exe",
      packageVersion,
    },
    { path: TEST_PATHS },
  );
}

async function trackedTemporaryDirectory(): Promise<string> {
  const directory = await createTemporaryDirectory("gptsb-dev-package-");
  temporaryDirectories.push(directory);
  return directory;
}
