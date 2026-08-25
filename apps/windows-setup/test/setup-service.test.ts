import { access, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEVELOPMENT_EXTENSION_ORIGIN,
  DEVELOPMENT_NATIVE_HOST_NAME,
  NODE_FILE_SYSTEM,
  getWindowsDevelopmentHostStatus,
  installWindowsDevelopmentHost,
  serializeChromeNativeMessagingManifest,
  uninstallWindowsDevelopmentHost,
  verifyWindowsPackage,
  writeWindowsPackageManifest,
  type WindowsRegistryView,
  type WindowsSetupFileSystem,
} from "../src/index.js";
import {
  MemoryRegistry,
  TEST_PATHS,
  createPackage,
  createSetupDependencies,
  createTemporaryDirectory,
  removeTemporaryDirectory,
} from "./fixtures.js";

const temporaryDirectories: string[] = [];

class SharedViewRegistry extends MemoryRegistry {
  public override async replaceHostPathIfExpected(
    hostName: string,
    view: WindowsRegistryView,
    expectedPath: string | undefined,
    replacementPath: string,
  ): Promise<boolean> {
    const replaced = await super.replaceHostPathIfExpected(
      hostName,
      view,
      expectedPath,
      replacementPath,
    );
    if (replaced) {
      this.values[view === "32" ? "64" : "32"] = replacementPath;
    }
    return replaced;
  }

  public override async removeHostPathIfExpected(
    hostName: string,
    view: WindowsRegistryView,
    expectedPath: string,
  ): Promise<boolean> {
    const removed = await super.removeHostPathIfExpected(hostName, view, expectedPath);
    if (removed) {
      this.values[view === "32" ? "64" : "32"] = undefined;
    }
    return removed;
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

describe("Windows development host setup", () => {
  it("installs verified artifacts, writes an exact manifest, and registers last", async () => {
    const root = await trackedTemporaryDirectory();
    const source = await createPackage(root);
    const localAppData = join(root, "local-app-data");
    await mkdir(localAppData);
    const events: string[] = [];
    const registry = new MemoryRegistry(events);
    const trackingFileSystem: WindowsSetupFileSystem = {
      ...NODE_FILE_SYSTEM,
      async copyFileExclusive(sourcePath, destinationPath, expectedSize): Promise<void> {
        events.push("fs:copy");
        await NODE_FILE_SYSTEM.copyFileExclusive(sourcePath, destinationPath, expectedSize);
      },
      async move(sourcePath, destinationPath): Promise<void> {
        events.push("fs:move");
        await NODE_FILE_SYSTEM.move(sourcePath, destinationPath);
      },
      async writeTextExclusive(path, contents): Promise<void> {
        events.push("fs:write");
        await NODE_FILE_SYSTEM.writeTextExclusive(path, contents);
      },
    };

    const result = await installWindowsDevelopmentHost(
      source,
      createSetupDependencies(localAppData, registry, { fileSystem: trackingFileSystem }),
    );

    expect(result).toMatchObject({
      hostName: DEVELOPMENT_NATIVE_HOST_NAME,
      packageCreated: true,
      packageVersion: "0.1.0",
      registrationCreated: true,
      state: "installed",
    });
    const firstRegistryWrite = events.indexOf("registry:set:64");
    const effectiveRegistryWrite = events.indexOf("registry:set:32");
    expect(firstRegistryWrite).toBeGreaterThan(events.lastIndexOf("fs:write"));
    expect(effectiveRegistryWrite).toBeGreaterThan(firstRegistryWrite);
    expect(registry.values).toEqual({
      "32": result.manifestPath,
      "64": result.manifestPath,
    });
    expect(result.extensionPath).toBe(join(dirname(result.executablePath), "..", "extension"));
    await expect(access(join(result.extensionPath, "manifest.json"))).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(result.manifestPath, "utf8"))).toEqual({
      allowed_origins: [DEVELOPMENT_EXTENSION_ORIGIN],
      description: "GPTSessionBridge Native Messaging host (development)",
      name: DEVELOPMENT_NATIVE_HOST_NAME,
      path: result.executablePath,
      type: "stdio",
    });
  });

  it("supports Windows installations where both HKCU software views share one key", async () => {
    const root = await trackedTemporaryDirectory();
    const source = await createPackage(root);
    const localAppData = join(root, "local-app-data");
    await mkdir(localAppData);
    const registry = new SharedViewRegistry();
    const dependencies = createSetupDependencies(localAppData, registry);

    const installed = await installWindowsDevelopmentHost(source, dependencies);
    expect(registry.values).toEqual({
      "32": installed.manifestPath,
      "64": installed.manifestPath,
    });

    await expect(uninstallWindowsDevelopmentHost(dependencies)).resolves.toMatchObject({
      unregistered: true,
    });
    expect(registry.values).toEqual({ "32": undefined, "64": undefined });
  });

  it("reports status, is idempotent, upgrades owned registration, and retains old packages", async () => {
    const root = await trackedTemporaryDirectory();
    const localAppData = join(root, "local-app-data");
    await mkdir(localAppData);
    const registry = new MemoryRegistry();
    const dependencies = createSetupDependencies(localAppData, registry);
    const source = await createPackage(root);
    const first = await installWindowsDevelopmentHost(source, dependencies);

    const repeated = await installWindowsDevelopmentHost(source, dependencies);
    expect(repeated).toMatchObject({ packageCreated: false, registrationCreated: false });
    await expect(getWindowsDevelopmentHostStatus(dependencies)).resolves.toEqual(
      expect.objectContaining({
        extensionPath: first.extensionPath,
        packageDigest: first.packageDigest,
        state: "installed",
      }),
    );

    const upgraded = await installWindowsDevelopmentHost(
      await createPackage(root, "0.2.0"),
      dependencies,
    );
    expect(upgraded.packageDigest).not.toBe(first.packageDigest);
    expect(registry.values).toEqual({
      "32": upgraded.manifestPath,
      "64": upgraded.manifestPath,
    });
    await expect(access(dirname(first.executablePath))).resolves.toBeUndefined();
  });

  it("never reports installed while a foreign 32-bit entry shadows the owned host", async () => {
    const root = await trackedTemporaryDirectory();
    const localAppData = join(root, "local-app-data");
    await mkdir(localAppData);
    const registry = new MemoryRegistry();
    const dependencies = createSetupDependencies(localAppData, registry);
    const source = await createPackage(root);
    const installed = await installWindowsDevelopmentHost(source, dependencies);
    const foreign = join(root, "foreign-32.json");
    registry.values["32"] = foreign;

    await expect(getWindowsDevelopmentHostStatus(dependencies)).resolves.toMatchObject({
      manifestPath: foreign,
      reason: "outside-managed-root",
      registryPaths: {
        chrome32: foreign,
        chrome64: installed.manifestPath,
      },
      state: "unmanaged",
    });
    await expect(installWindowsDevelopmentHost(source, dependencies)).rejects.toMatchObject({
      code: "registry_conflict",
    });
    expect(registry.values).toEqual({ "32": foreign, "64": installed.manifestPath });
  });

  it("repairs a verified legacy 64-bit-only registration through the effective 32-bit view", async () => {
    const root = await trackedTemporaryDirectory();
    const localAppData = join(root, "local-app-data");
    await mkdir(localAppData);
    const registry = new MemoryRegistry();
    const dependencies = createSetupDependencies(localAppData, registry);
    const source = await createPackage(root);
    const installed = await installWindowsDevelopmentHost(source, dependencies);
    registry.values["32"] = undefined;

    await expect(getWindowsDevelopmentHostStatus(dependencies)).resolves.toMatchObject({
      reason: "incomplete-registration",
      registryPaths: { chrome32: null, chrome64: installed.manifestPath },
      state: "unmanaged",
    });
    const repaired = await installWindowsDevelopmentHost(source, dependencies);
    expect(repaired.registryPaths).toEqual({
      chrome32: installed.manifestPath,
      chrome64: installed.manifestPath,
    });
    await expect(getWindowsDevelopmentHostStatus(dependencies)).resolves.toMatchObject({
      state: "installed",
    });
  });

  it("refuses uninstall when an owned 32-bit entry is hiding a foreign 64-bit entry", async () => {
    const root = await trackedTemporaryDirectory();
    const localAppData = join(root, "local-app-data");
    await mkdir(localAppData);
    const registry = new MemoryRegistry();
    const dependencies = createSetupDependencies(localAppData, registry);
    const installed = await installWindowsDevelopmentHost(await createPackage(root), dependencies);
    const foreign = join(root, "foreign-64.json");
    registry.values["64"] = foreign;

    await expect(uninstallWindowsDevelopmentHost(dependencies)).rejects.toMatchObject({
      code: "registry_conflict",
    });
    expect(registry.values).toEqual({ "32": installed.manifestPath, "64": foreign });
  });

  it("accepts safe same-target convergence from a concurrent or shared-view write", async () => {
    const root = await trackedTemporaryDirectory();
    const localAppData = join(root, "local-app-data");
    await mkdir(localAppData);
    const source = await createPackage(root);
    const verified = await verifyWindowsPackage(source, { path: TEST_PATHS });
    const registrationPath = join(
      localAppData,
      "Programs",
      "GPTSessionBridge",
      "dev",
      "registrations",
      `${verified.packageDigest}.json`,
    );
    const registry = new MemoryRegistry([], {
      "32": registrationPath,
      "64": registrationPath,
    });
    registry.staleInitialReads.add("32");
    registry.staleInitialReads.add("64");

    await expect(
      installWindowsDevelopmentHost(source, createSetupDependencies(localAppData, registry)),
    ).resolves.toMatchObject({ manifestPath: registrationPath, state: "installed" });
    await expect(access(registrationPath)).resolves.toBeUndefined();
    const chromeManifest = JSON.parse(await readFile(registrationPath, "utf8")) as {
      path: string;
    };
    await expect(access(chromeManifest.path)).resolves.toBeUndefined();
    expect(registry.events).not.toContain("registry:remove:64");
    expect(registry.events).not.toContain("registry:remove:32");
  });

  it("fails final verification when a skipped view changes concurrently", async () => {
    const root = await trackedTemporaryDirectory();
    const localAppData = join(root, "local-app-data");
    await mkdir(localAppData);
    const source = await createPackage(root);
    const registry = new MemoryRegistry();
    const dependencies = createSetupDependencies(localAppData, registry);
    const installed = await installWindowsDevelopmentHost(source, dependencies);
    registry.queuedReads["32"].push(
      { mutate: false, value: installed.manifestPath },
      { mutate: true, value: undefined },
    );
    registry.queuedReads["64"].push(
      { mutate: false, value: installed.manifestPath },
      { mutate: false, value: installed.manifestPath },
    );

    await expect(installWindowsDevelopmentHost(source, dependencies)).rejects.toMatchObject({
      code: "registry_conflict",
    });
    expect(registry.values).toEqual({ "32": undefined, "64": installed.manifestPath });
    await expect(access(installed.manifestPath)).resolves.toBeUndefined();
  });

  it("hashes a shared two-view package only once for status and uninstall", async () => {
    const root = await trackedTemporaryDirectory();
    const localAppData = join(root, "local-app-data");
    await mkdir(localAppData);
    const source = await createPackage(root);
    const expectedHashCount = (await verifyWindowsPackage(source, { path: TEST_PATHS })).manifest
      .files.length;
    let hashCount = 0;
    const countingFileSystem: WindowsSetupFileSystem = {
      ...NODE_FILE_SYSTEM,
      hashFile(path, maximumBytes) {
        hashCount += 1;
        return NODE_FILE_SYSTEM.hashFile(path, maximumBytes);
      },
    };
    const registry = new MemoryRegistry();
    const dependencies = createSetupDependencies(localAppData, registry, {
      fileSystem: countingFileSystem,
    });
    await installWindowsDevelopmentHost(source, dependencies);

    hashCount = 0;
    await expect(getWindowsDevelopmentHostStatus(dependencies)).resolves.toMatchObject({
      state: "installed",
    });
    expect(hashCount).toBe(expectedHashCount);

    hashCount = 0;
    await expect(uninstallWindowsDevelopmentHost(dependencies)).resolves.toMatchObject({
      unregistered: true,
    });
    expect(hashCount).toBe(expectedHashCount);
  });

  it("refuses unmanaged registry ownership before writing installation files", async () => {
    const root = await trackedTemporaryDirectory();
    const source = await createPackage(root);
    const localAppData = join(root, "local-app-data");
    await mkdir(localAppData);
    const foreignManifest = join(root, "foreign", "manifest.json");
    const registry = new MemoryRegistry([], { "32": foreignManifest });

    await expect(
      installWindowsDevelopmentHost(source, createSetupDependencies(localAppData, registry)),
    ).rejects.toMatchObject({ code: "registry_conflict" });
    await expect(
      access(join(localAppData, "Programs", "GPTSessionBridge", "dev")),
    ).rejects.toBeDefined();
    expect(registry.values["32"]).toBe(foreignManifest);
  });

  it("retains a promoted verified package when registration materialization fails", async () => {
    const root = await trackedTemporaryDirectory();
    const source = await createPackage(root);
    const packageDigest = (await verifyWindowsPackage(source, { path: TEST_PATHS })).packageDigest;
    const localAppData = join(root, "local-app-data");
    await mkdir(localAppData);
    const registry = new MemoryRegistry();
    const failingFileSystem: WindowsSetupFileSystem = {
      ...NODE_FILE_SYSTEM,
      async writeTextExclusive(path, contents): Promise<void> {
        if (path.endsWith(".json") && path.includes("registrations")) {
          throw new Error("simulated manifest write failure");
        }
        await NODE_FILE_SYSTEM.writeTextExclusive(path, contents);
      },
    };

    await expect(
      installWindowsDevelopmentHost(
        source,
        createSetupDependencies(localAppData, registry, { fileSystem: failingFileSystem }),
      ),
    ).rejects.toMatchObject({ code: "filesystem_conflict" });

    const packagesRoot = join(localAppData, "Programs", "GPTSessionBridge", "dev", "packages");
    expect(await NODE_FILE_SYSTEM.listDirectory(packagesRoot, 2)).toEqual([
      { kind: "directory", name: packageDigest },
    ]);
    await expect(
      verifyWindowsPackage(join(packagesRoot, packageDigest), { path: TEST_PATHS }),
    ).resolves.toMatchObject({ packageDigest });
    expect(registry.values).toEqual({ "32": undefined, "64": undefined });
  });

  it("retains artifacts after any uncertain registry mutation", async () => {
    const root = await trackedTemporaryDirectory();
    const source = await createPackage(root);
    const localAppData = join(root, "local-app-data");
    await mkdir(localAppData);
    const registry = new MemoryRegistry();
    registry.failReplace = true;
    registry.mutateBeforeReplaceFailure = true;

    await expect(
      installWindowsDevelopmentHost(source, createSetupDependencies(localAppData, registry)),
    ).rejects.toThrow("simulated registry failure");
    expect(registry.values["64"]).toBeDefined();
    await expect(access(registry.values["64"] ?? "missing")).resolves.toBeUndefined();
    const chromeManifest = JSON.parse(
      await readFile(registry.values["64"] ?? "missing", "utf8"),
    ) as {
      path: string;
    };
    await expect(access(chromeManifest.path)).resolves.toBeUndefined();
  });

  it("unregisters first, leaves verified package files, and refuses foreign ownership", async () => {
    const root = await trackedTemporaryDirectory();
    const localAppData = join(root, "local-app-data");
    await mkdir(localAppData);
    const registry = new MemoryRegistry();
    const dependencies = createSetupDependencies(localAppData, registry);
    const installed = await installWindowsDevelopmentHost(await createPackage(root), dependencies);
    registry.events.length = 0;

    const removed = await uninstallWindowsDevelopmentHost(dependencies);
    expect(removed).toMatchObject({ filesRetained: true, unregistered: true });
    expect(registry.events).toEqual([
      "registry:read:32",
      "registry:read:64",
      "registry:remove:64",
      "registry:read:64",
      "registry:read:32",
      "registry:remove:32",
      "registry:read:32",
      "registry:read:64",
    ]);
    await expect(access(installed.executablePath)).resolves.toBeUndefined();
    await expect(getWindowsDevelopmentHostStatus(dependencies)).resolves.toMatchObject({
      state: "not-installed",
    });
    await expect(uninstallWindowsDevelopmentHost(dependencies)).resolves.toMatchObject({
      unregistered: false,
    });

    registry.values["32"] = join(root, "foreign.json");
    await expect(getWindowsDevelopmentHostStatus(dependencies)).resolves.toMatchObject({
      reason: "outside-managed-root",
      state: "unmanaged",
    });
    await expect(uninstallWindowsDevelopmentHost(dependencies)).rejects.toMatchObject({
      code: "registry_conflict",
    });
    expect(registry.values["32"]).toBe(join(root, "foreign.json"));
  });

  it("rejects a self-consistent package that violates the development contract", async () => {
    const root = await trackedTemporaryDirectory();
    const source = await createPackage(root);
    await rm(join(source, "native-host", "gptsessionbridge-windows-ipc.exe"));
    await rm(join(source, "package-manifest.json"));
    await writeWindowsPackageManifest(
      source,
      {
        hostExecutable: "native-host/gptsessionbridge-native-host.exe",
        packageVersion: "0.1.0",
      },
      { path: TEST_PATHS },
    );
    const localAppData = join(root, "local-app-data");
    await mkdir(localAppData);

    await expect(
      installWindowsDevelopmentHost(
        source,
        createSetupDependencies(localAppData, new MemoryRegistry()),
      ),
    ).rejects.toMatchObject({ code: "invalid_package_manifest" });

    const wrongTemplate = await createPackage(root, "0.3.0");
    await rm(join(wrongTemplate, "package-manifest.json"));
    await NODE_FILE_SYSTEM.writeTextExclusive(
      join(wrongTemplate, "replacement-template.json"),
      "{}\n",
    );
    await rm(join(wrongTemplate, "native-host", "chrome-windows.template.json"));
    await NODE_FILE_SYSTEM.move(
      join(wrongTemplate, "replacement-template.json"),
      join(wrongTemplate, "native-host", "chrome-windows.template.json"),
    );
    await writeWindowsPackageManifest(
      wrongTemplate,
      {
        hostExecutable: "native-host/gptsessionbridge-native-host.exe",
        packageVersion: "0.3.0",
      },
      { path: TEST_PATHS },
    );
    await expect(
      installWindowsDevelopmentHost(
        wrongTemplate,
        createSetupDependencies(localAppData, new MemoryRegistry()),
      ),
    ).rejects.toMatchObject({ code: "invalid_package_manifest" });
  });

  it("rejects an install root redirected outside LocalAppData by a junction", async () => {
    const root = await trackedTemporaryDirectory();
    const source = await createPackage(root);
    const localAppData = join(root, "local-app-data");
    const outside = join(root, "outside");
    await mkdir(localAppData);
    await mkdir(outside);
    await symlink(
      outside,
      join(localAppData, "Programs"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      installWindowsDevelopmentHost(
        source,
        createSetupDependencies(localAppData, new MemoryRegistry()),
      ),
    ).rejects.toMatchObject({ code: "invalid_package_path" });
  });

  it("creates only the fixed development Chrome manifest", () => {
    const executable = TEST_PATHS.resolve("/managed/native-host.exe");
    const serialized = serializeChromeNativeMessagingManifest(executable, TEST_PATHS);
    expect(JSON.parse(serialized)).toEqual({
      allowed_origins: [DEVELOPMENT_EXTENSION_ORIGIN],
      description: "GPTSessionBridge Native Messaging host (development)",
      name: DEVELOPMENT_NATIVE_HOST_NAME,
      path: executable,
      type: "stdio",
    });
    expect(() => serializeChromeNativeMessagingManifest("relative.exe", TEST_PATHS)).toThrow(
      expect.objectContaining({ code: "invalid_chrome_manifest" }),
    );
  });

  it("rejects unsupported platforms and invalid LocalAppData roots", async () => {
    const registry = new MemoryRegistry();
    await expect(
      getWindowsDevelopmentHostStatus({
        path: TEST_PATHS,
        platform: {
          architecture: "x64",
          createNonce: () => "0123456789abcdef",
          localAppData: TEST_PATHS.resolve("/local"),
          operatingSystem: "linux",
        },
        registry,
      }),
    ).rejects.toMatchObject({ code: "unsupported_platform" });
    await expect(
      getWindowsDevelopmentHostStatus({
        path: TEST_PATHS,
        platform: {
          architecture: "arm64",
          createNonce: () => "0123456789abcdef",
          localAppData: TEST_PATHS.resolve("/local"),
          operatingSystem: "win32",
        },
        registry,
      }),
    ).rejects.toMatchObject({ code: "unsupported_platform" });
    await expect(
      getWindowsDevelopmentHostStatus({
        path: TEST_PATHS,
        platform: {
          architecture: "x64",
          createNonce: () => "0123456789abcdef",
          localAppData: "relative",
          operatingSystem: "win32",
        },
        registry,
      }),
    ).rejects.toMatchObject({ code: "invalid_install_root" });
  });
});

async function trackedTemporaryDirectory(): Promise<string> {
  const directory = await createTemporaryDirectory("gptsb-setup-");
  temporaryDirectories.push(directory);
  return directory;
}
