import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NODE_FILE_SYSTEM,
  POSIX_PATHS,
  WINDOWS_PATHS,
  writeWindowsPackageManifest,
  type NativeMessagingRegistry,
  type PathDependencies,
  type WindowsRegistryView,
  type WindowsSetupDependencies,
} from "../src/index.js";

export const TEST_PATHS: PathDependencies =
  process.platform === "win32" ? WINDOWS_PATHS : POSIX_PATHS;

export class MemoryRegistry implements NativeMessagingRegistry {
  public readonly events: string[];
  public failReplace = false;
  public failRemove = false;
  public forceConflict = false;
  public mutateBeforeReplaceFailure = false;
  public readonly staleInitialReads = new Set<WindowsRegistryView>();
  public readonly queuedReads: Record<
    WindowsRegistryView,
    { readonly mutate: boolean; readonly value: string | undefined }[]
  > = {
    "32": [],
    "64": [],
  };
  public readonly values: Record<WindowsRegistryView, string | undefined> = {
    "32": undefined,
    "64": undefined,
  };

  public constructor(
    events: string[] = [],
    initialValues: Partial<Readonly<Record<WindowsRegistryView, string>>> = {},
  ) {
    this.events = events;
    this.values["32"] = initialValues["32"];
    this.values["64"] = initialValues["64"];
  }

  public replaceHostPathIfExpected(
    hostName: string,
    view: WindowsRegistryView,
    expectedPath: string | undefined,
    replacementPath: string,
  ): Promise<boolean> {
    void hostName;
    this.events.push(`registry:set:${view}`);
    if (this.failReplace) {
      if (this.mutateBeforeReplaceFailure) {
        this.values[view] = replacementPath;
      }
      return Promise.reject(new Error("simulated registry failure"));
    }
    if (this.forceConflict || this.values[view] !== expectedPath) {
      return Promise.resolve(false);
    }
    this.values[view] = replacementPath;
    return Promise.resolve(true);
  }

  public removeHostPathIfExpected(
    hostName: string,
    view: WindowsRegistryView,
    expectedPath: string,
  ): Promise<boolean> {
    void hostName;
    this.events.push(`registry:remove:${view}`);
    if (this.failRemove) {
      return Promise.reject(new Error("simulated registry failure"));
    }
    if (this.values[view] !== expectedPath) {
      return Promise.resolve(false);
    }
    this.values[view] = undefined;
    return Promise.resolve(true);
  }

  public readHostPath(hostName: string, view: WindowsRegistryView): Promise<string | undefined> {
    void hostName;
    this.events.push(`registry:read:${view}`);
    const queued = this.queuedReads[view].shift();
    if (queued !== undefined) {
      if (queued.mutate) {
        this.values[view] = queued.value;
      }
      return Promise.resolve(queued.value);
    }
    if (this.staleInitialReads.delete(view)) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(this.values[view]);
  }
}

export async function createTemporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeTemporaryDirectory(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}

export async function createPackage(parent: string, packageVersion = "0.1.0"): Promise<string> {
  const root = join(parent, `source-${packageVersion.replaceAll(".", "-")}`);
  await mkdir(join(root, "native-host"), { recursive: true });
  await mkdir(join(root, "extension", "background"), { recursive: true });
  await mkdir(join(root, "extension", "chunks"), { recursive: true });
  await mkdir(join(root, "extension", "content"), { recursive: true });
  await mkdir(join(root, "extension", "popup"), { recursive: true });
  await writeFile(
    join(root, "native-host", "gptsessionbridge-native-host.exe"),
    `native-host-${packageVersion}`,
  );
  await writeFile(
    join(root, "native-host", "chrome-windows.template.json"),
    `${JSON.stringify(
      {
        name: "com.gptsessionbridge.native_host.dev",
        description: "GPTSessionBridge Native Messaging host (development)",
        path: "__GPTSESSIONBRIDGE_NATIVE_HOST_EXECUTABLE__",
        type: "stdio",
        allowed_origins: ["chrome-extension://bhladcjpjnimikahacopaghedecjmjfn/"],
      },
      undefined,
      2,
    )}\n`,
  );
  await writeFile(
    join(root, "native-host", "gptsessionbridge-windows-ipc.exe"),
    `ipc-helper-${packageVersion}`,
  );
  const extensionManifest = JSON.parse(
    await readFile(new URL("../../browser-extension/manifest.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  extensionManifest["version"] = packageVersion;
  await writeFile(
    join(root, "extension", "manifest.json"),
    `${JSON.stringify(extensionManifest, undefined, 2)}\n`,
  );
  await writeFile(join(root, "extension", "background", "service-worker.js"), "export {};\n");
  await writeFile(join(root, "extension", "chunks", "chrome-api.js"), "export {};\n");
  await writeFile(join(root, "extension", "content", "content-script.js"), "export {};\n");
  await writeFile(join(root, "extension", "popup", "popup.css"), "body {}\n");
  await writeFile(
    join(root, "extension", "popup", "popup.html"),
    '<link rel="stylesheet" href="./popup.css"><script type="module" src="./popup.js"></script>\n',
  );
  await writeFile(join(root, "extension", "popup", "popup.js"), "export {};\n");
  await writeWindowsPackageManifest(
    root,
    {
      hostExecutable: "native-host/gptsessionbridge-native-host.exe",
      packageVersion,
    },
    { path: TEST_PATHS },
  );
  return root;
}

export function createSetupDependencies(
  localAppData: string,
  registry: NativeMessagingRegistry,
  overrides: Partial<WindowsSetupDependencies> = {},
): WindowsSetupDependencies {
  return {
    fileSystem: NODE_FILE_SYSTEM,
    path: TEST_PATHS,
    platform: {
      architecture: "x64",
      createNonce: () => "0123456789abcdef0123456789abcdef",
      localAppData,
      operatingSystem: "win32",
    },
    registry,
    ...overrides,
  };
}
