import { createHash } from "node:crypto";

import {
  DEVELOPMENT_EXTENSION_ID,
  DEVELOPMENT_EXTENSION_MANIFEST_PATH,
  DEVELOPMENT_EXTENSION_ORIGIN,
  DEVELOPMENT_HELPER_EXECUTABLE_PATH,
  DEVELOPMENT_HOST_EXECUTABLE_PATH,
  DEVELOPMENT_HOST_TEMPLATE_PATH,
  DEVELOPMENT_NATIVE_HOST_NAME,
  NATIVE_HOST_DESCRIPTION,
  NATIVE_HOST_EXECUTABLE_PLACEHOLDER,
} from "./constants.js";
import {
  NODE_FILE_SYSTEM,
  defaultPackagePathDependencies,
  type PackageIoDependencies,
  type PathDependencies,
  type WindowsSetupFileSystem,
} from "./dependencies.js";
import { WindowsSetupError } from "./errors.js";
import { verifyWindowsPackage, type VerifiedWindowsPackage } from "./package-manifest.js";
import { assertRegularFileWithoutLinks, resolvePortablePath } from "./secure-path.js";

const MAX_NATIVE_HOST_TEMPLATE_BYTES = 4 * 1024;
const MAX_EXTENSION_MANIFEST_BYTES = 32 * 1024;

const DEVELOPMENT_EXTENSION_RUNTIME_PATHS = [
  "extension/background/service-worker.js",
  "extension/chunks/chrome-api.js",
  "extension/content/content-script.js",
  "extension/popup/popup.css",
  "extension/popup/popup.html",
  "extension/popup/popup.js",
] as const;

const DEVELOPMENT_EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2oUQsfjjM9WFuyYpDNKOT9GPF7bxIAPXu8wKJ9zsAPitCOSEsOsrDSultuRbpOjjadQetmhJl/fCC1OadvetgDvbBiVhSv45ttLEeM1jRhN4zyp5Hm0uuHkK3qHE0L/F315IKF70vWpO5LQCmoMwfgilztbnWbvmWViSd+GbUfWAGNv/4BdnXEimfebdAotI1W5p5aBy/0tQVG4fa/DgLAwfUYvNCimtG+0JrCjAsl/FuoVHM3t52qZlJEU1yJeXYF7Wo4sDhpWFOjXjT6v1QjWcpdDUyOBxS+9ENEjLDn0qhFOvVM8ntenhYsr/kPoI61EW13+5X2QoN+jRz0hEnwIDAQAB";

interface ResolvedDevelopmentPackageDependencies {
  readonly fileSystem: WindowsSetupFileSystem;
  readonly path: PathDependencies;
}

/**
 * Verifies both the content-addressed package envelope and the fixed
 * development Native Messaging/MV3 policy consumed by the installer.
 */
export async function verifyWindowsDevelopmentPackage(
  packageRoot: string,
  dependencies: PackageIoDependencies = {},
): Promise<VerifiedWindowsPackage> {
  const resolved = resolveDependencies(dependencies);
  const verifiedPackage = await verifyWindowsPackage(packageRoot, {
    fileSystem: resolved.fileSystem,
    path: resolved.path,
  });
  await validateDevelopmentPackageContract(verifiedPackage, resolved);
  return verifiedPackage;
}

async function validateDevelopmentPackageContract(
  verifiedPackage: VerifiedWindowsPackage,
  resolved: ResolvedDevelopmentPackageDependencies,
): Promise<void> {
  if (verifiedPackage.manifest.hostExecutable !== DEVELOPMENT_HOST_EXECUTABLE_PATH) {
    throw new WindowsSetupError("invalid_package_manifest");
  }
  const requiredFiles = [
    DEVELOPMENT_EXTENSION_MANIFEST_PATH,
    ...DEVELOPMENT_EXTENSION_RUNTIME_PATHS,
    DEVELOPMENT_HELPER_EXECUTABLE_PATH,
    DEVELOPMENT_HOST_EXECUTABLE_PATH,
    DEVELOPMENT_HOST_TEMPLATE_PATH,
  ] as const;
  const packagedPaths = new Set(verifiedPackage.manifest.files.map((file) => file.path));
  if (requiredFiles.some((path) => !packagedPaths.has(path))) {
    throw new WindowsSetupError("invalid_package_manifest");
  }
  for (const path of requiredFiles) {
    await assertRegularFileWithoutLinks(
      verifiedPackage.packageRoot,
      path,
      resolved.fileSystem,
      resolved.path,
    );
  }
  const extensionPath = resolved.path.join(verifiedPackage.packageRoot, "extension");
  if ((await resolved.fileSystem.inspect(extensionPath))?.kind !== "directory") {
    throw new WindowsSetupError("invalid_package_manifest");
  }

  const template = await readBoundedJson(
    resolvePortablePath(verifiedPackage.packageRoot, DEVELOPMENT_HOST_TEMPLATE_PATH, resolved.path),
    MAX_NATIVE_HOST_TEMPLATE_BYTES,
    resolved.fileSystem,
  );
  const expectedTemplate = {
    allowed_origins: [DEVELOPMENT_EXTENSION_ORIGIN],
    description: NATIVE_HOST_DESCRIPTION,
    name: DEVELOPMENT_NATIVE_HOST_NAME,
    path: NATIVE_HOST_EXECUTABLE_PLACEHOLDER,
    type: "stdio",
  };
  if (!jsonValuesEqual(template, expectedTemplate)) {
    throw new WindowsSetupError("invalid_package_manifest");
  }

  const extensionManifest = await readBoundedJson(
    resolvePortablePath(
      verifiedPackage.packageRoot,
      DEVELOPMENT_EXTENSION_MANIFEST_PATH,
      resolved.path,
    ),
    MAX_EXTENSION_MANIFEST_BYTES,
    resolved.fileSystem,
  );
  const expectedExtensionManifest = {
    action: {
      default_popup: "popup/popup.html",
      default_title: "Connect this ChatGPT tab",
    },
    background: {
      service_worker: "background/service-worker.js",
      type: "module",
    },
    content_security_policy: {
      extension_pages:
        "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
    description: "Connect an explicitly selected ChatGPT tab to a local GPTSessionBridge session.",
    incognito: "not_allowed",
    key: DEVELOPMENT_EXTENSION_PUBLIC_KEY,
    manifest_version: 3,
    minimum_chrome_version: "106",
    name: "GPTSessionBridge",
    permissions: ["activeTab", "scripting", "nativeMessaging"],
    version: verifiedPackage.manifest.packageVersion,
  };
  if (
    !jsonValuesEqual(extensionManifest, expectedExtensionManifest) ||
    deriveChromeExtensionId(DEVELOPMENT_EXTENSION_PUBLIC_KEY) !== DEVELOPMENT_EXTENSION_ID
  ) {
    throw new WindowsSetupError("invalid_package_manifest");
  }
}

async function readBoundedJson(
  path: string,
  maximumBytes: number,
  fileSystem: WindowsSetupFileSystem,
): Promise<unknown> {
  try {
    return JSON.parse(await fileSystem.readTextBounded(path, maximumBytes)) as unknown;
  } catch (error) {
    throw new WindowsSetupError("invalid_package_manifest", { cause: error });
  }
}

function jsonValuesEqual(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      Array.isArray(expected) &&
      actual.length === expected.length &&
      actual.every((value, index) => jsonValuesEqual(value, expected[index]))
    );
  }
  if (isPlainRecord(actual) || isPlainRecord(expected)) {
    if (!isPlainRecord(actual) || !isPlainRecord(expected)) {
      return false;
    }
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    return (
      actualKeys.length === expectedKeys.length &&
      actualKeys.every(
        (key, index) => key === expectedKeys[index] && jsonValuesEqual(actual[key], expected[key]),
      )
    );
  }
  return Object.is(actual, expected);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deriveChromeExtensionId(publicKey: string): string | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(publicKey)) {
    return undefined;
  }
  const decoded = Buffer.from(publicKey, "base64");
  if (
    decoded.byteLength === 0 ||
    decoded.toString("base64").replace(/=+$/u, "") !== publicKey.replace(/=+$/u, "")
  ) {
    return undefined;
  }
  const hexadecimal = createHash("sha256").update(decoded).digest("hex").slice(0, 32);
  return hexadecimal.replace(/[0-9a-f]/gu, (character) =>
    String.fromCharCode("a".charCodeAt(0) + Number.parseInt(character, 16)),
  );
}

function resolveDependencies(
  dependencies: PackageIoDependencies,
): ResolvedDevelopmentPackageDependencies {
  return Object.freeze({
    fileSystem: dependencies.fileSystem ?? NODE_FILE_SYSTEM,
    path: dependencies.path ?? defaultPackagePathDependencies(),
  });
}
