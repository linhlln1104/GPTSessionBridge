import {
  DEVELOPMENT_EXTENSION_ORIGIN,
  DEVELOPMENT_INSTALL_COMPONENTS,
  DEVELOPMENT_NATIVE_HOST_NAME,
  NATIVE_HOST_DESCRIPTION,
  PACKAGE_MANIFEST_FILENAME,
} from "./constants.js";
import {
  NODE_FILE_SYSTEM,
  WINDOWS_PATHS,
  createDefaultWindowsPlatform,
  type PathDependencies,
  type WindowsSetupFileSystem,
  type WindowsSetupPlatform,
} from "./dependencies.js";
import { verifyWindowsDevelopmentPackage } from "./development-package.js";
import { WindowsSetupError } from "./errors.js";
import { verifyWindowsPackage, type VerifiedWindowsPackage } from "./package-manifest.js";
import {
  assertPathContained,
  assertRegularFileWithoutLinks,
  pathsEqual,
  resolvePortablePath,
} from "./secure-path.js";
import {
  WindowsCurrentUserChromeRegistry,
  type NativeMessagingRegistry,
  type WindowsRegistryView,
} from "./registry.js";

const PACKAGE_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_REGISTRATION_MANIFEST_BYTES = 8 * 1024;

export interface WindowsSetupDependencies {
  readonly fileSystem?: WindowsSetupFileSystem;
  readonly path?: PathDependencies;
  readonly platform?: WindowsSetupPlatform;
  readonly registry?: NativeMessagingRegistry;
}

export interface InstalledWindowsSetupStatus {
  readonly executablePath: string;
  readonly extensionPath: string;
  readonly facadeExecutablePath: string;
  readonly hostName: typeof DEVELOPMENT_NATIVE_HOST_NAME;
  readonly manifestPath: string;
  readonly packageDigest: string;
  readonly packageVersion: string;
  readonly registryPaths: WindowsRegistryPaths;
  readonly state: "installed";
}

export interface NotInstalledWindowsSetupStatus {
  readonly hostName: typeof DEVELOPMENT_NATIVE_HOST_NAME;
  readonly state: "not-installed";
}

export interface UnmanagedWindowsSetupStatus {
  readonly hostName: typeof DEVELOPMENT_NATIVE_HOST_NAME;
  readonly manifestPath: string;
  readonly reason:
    | "conflicting-registry-views"
    | "incomplete-registration"
    | "invalid-registration"
    | "outside-managed-root"
    | "package-invalid";
  readonly registryPaths: WindowsRegistryPaths;
  readonly state: "unmanaged";
}

export interface WindowsRegistryPaths {
  readonly chrome32: string | null;
  readonly chrome64: string | null;
}

export type WindowsSetupStatus =
  InstalledWindowsSetupStatus | NotInstalledWindowsSetupStatus | UnmanagedWindowsSetupStatus;

export interface WindowsInstallResult extends InstalledWindowsSetupStatus {
  readonly packageCreated: boolean;
  readonly registrationCreated: boolean;
}

export interface WindowsUninstallResult {
  readonly filesRetained: true;
  readonly hostName: typeof DEVELOPMENT_NATIVE_HOST_NAME;
  readonly previousStatus: WindowsSetupStatus;
  readonly unregistered: boolean;
}

export interface ChromeNativeMessagingManifest {
  readonly allowed_origins: readonly [typeof DEVELOPMENT_EXTENSION_ORIGIN];
  readonly description: typeof NATIVE_HOST_DESCRIPTION;
  readonly name: typeof DEVELOPMENT_NATIVE_HOST_NAME;
  readonly path: string;
  readonly type: "stdio";
}

interface ResolvedSetupDependencies {
  readonly fileSystem: WindowsSetupFileSystem;
  readonly layout: InstallLayout;
  readonly path: PathDependencies;
  readonly platform: WindowsSetupPlatform;
  readonly registry: NativeMessagingRegistry;
}

interface InstallLayout {
  readonly managedRoot: string;
  readonly packagesRoot: string;
  readonly registrationsRoot: string;
}

interface ManagedRegistration {
  readonly status: InstalledWindowsSetupStatus;
  readonly verifiedPackage: VerifiedWindowsPackage;
}

interface MaterializedPath {
  readonly created: boolean;
  readonly path: string;
}

interface RegistrySnapshot {
  readonly chrome32: string | undefined;
  readonly chrome64: string | undefined;
}

interface ManagedRegistrySnapshot {
  readonly chrome32: ManagedRegistration | undefined;
  readonly chrome64: ManagedRegistration | undefined;
}

export async function installWindowsDevelopmentHost(
  packageRoot: string,
  dependencies: WindowsSetupDependencies = {},
): Promise<WindowsInstallResult> {
  const resolved = resolveSetupDependencies(dependencies);
  const existingRegistry = await readRegistrySnapshot(resolved);
  await inspectOwnedRegistrySnapshot(existingRegistry, resolved);

  const sourcePackage = await verifyWindowsDevelopmentPackage(packageRoot, {
    fileSystem: resolved.fileSystem,
    path: resolved.path,
  });
  await ensureInstallLayout(resolved);

  // Promoted content-addressed paths can be adopted by another concurrent
  // installer, so no later failure removes them. materializePackage cleans
  // only its private staging directory before promotion.
  const materializedPackage = await materializePackage(sourcePackage, resolved);
  const executablePath = resolvePortablePath(
    materializedPackage.path,
    sourcePackage.manifest.hostExecutable,
    resolved.path,
  );
  const facadeExecutablePath = resolvePortablePath(
    materializedPackage.path,
    sourcePackage.manifest.facadeExecutable,
    resolved.path,
  );
  const extensionPath = resolved.path.join(materializedPackage.path, "extension");
  const chromeManifest = serializeChromeNativeMessagingManifest(executablePath, resolved.path);
  const registrationPath = resolved.path.join(
    resolved.layout.registrationsRoot,
    `${sourcePackage.packageDigest}.json`,
  );
  const materializedRegistration = await materializeRegistration(
    registrationPath,
    chromeManifest,
    resolved,
  );

  if (!pathsOptionallyEqual(existingRegistry.chrome64, registrationPath, resolved.path)) {
    await replaceRegistryView("64", existingRegistry.chrome64, registrationPath, resolved);
  }
  if (!pathsOptionallyEqual(existingRegistry.chrome32, registrationPath, resolved.path)) {
    await replaceRegistryView("32", existingRegistry.chrome32, registrationPath, resolved);
  }
  const finalRegistry = await readRegistrySnapshot(resolved);
  if (
    !pathsOptionallyEqual(finalRegistry.chrome32, registrationPath, resolved.path) ||
    !pathsOptionallyEqual(finalRegistry.chrome64, registrationPath, resolved.path)
  ) {
    throw new WindowsSetupError("registry_conflict");
  }
  return Object.freeze({
    executablePath,
    extensionPath,
    facadeExecutablePath,
    hostName: DEVELOPMENT_NATIVE_HOST_NAME,
    manifestPath: registrationPath,
    packageCreated: materializedPackage.created,
    packageDigest: sourcePackage.packageDigest,
    packageVersion: sourcePackage.manifest.packageVersion,
    registrationCreated: materializedRegistration.created,
    registryPaths: createPublicRegistryPaths(finalRegistry),
    state: "installed",
  });
}

export async function getWindowsDevelopmentHostStatus(
  dependencies: WindowsSetupDependencies = {},
): Promise<WindowsSetupStatus> {
  const resolved = resolveSetupDependencies(dependencies);
  return createStatusFromSnapshot(await readRegistrySnapshot(resolved), resolved);
}

export async function uninstallWindowsDevelopmentHost(
  dependencies: WindowsSetupDependencies = {},
): Promise<WindowsUninstallResult> {
  const resolved = resolveSetupDependencies(dependencies);
  const existingRegistry = await readRegistrySnapshot(resolved);
  if (existingRegistry.chrome32 === undefined && existingRegistry.chrome64 === undefined) {
    return Object.freeze({
      filesRetained: true,
      hostName: DEVELOPMENT_NATIVE_HOST_NAME,
      previousStatus: Object.freeze({
        hostName: DEVELOPMENT_NATIVE_HOST_NAME,
        state: "not-installed",
      }),
      unregistered: false,
    });
  }
  const managedRegistry = await inspectOwnedRegistrySnapshot(existingRegistry, resolved);
  const previousStatus = createStatusFromManagedSnapshot(
    existingRegistry,
    managedRegistry,
    resolved,
  );

  if (existingRegistry.chrome64 !== undefined) {
    const removed64 = await resolved.registry.removeHostPathIfExpected(
      DEVELOPMENT_NATIVE_HOST_NAME,
      "64",
      existingRegistry.chrome64,
    );
    if (
      !removed64 &&
      (await resolved.registry.readHostPath(DEVELOPMENT_NATIVE_HOST_NAME, "64")) !== undefined
    ) {
      throw new WindowsSetupError("registry_conflict");
    }
  }
  if (existingRegistry.chrome32 !== undefined) {
    if ((await resolved.registry.readHostPath(DEVELOPMENT_NATIVE_HOST_NAME, "64")) !== undefined) {
      throw new WindowsSetupError("registry_conflict");
    }
    const current32 = await resolved.registry.readHostPath(DEVELOPMENT_NATIVE_HOST_NAME, "32");
    if (
      current32 !== undefined &&
      !pathsOptionallyEqual(current32, existingRegistry.chrome32, resolved.path)
    ) {
      throw new WindowsSetupError("registry_conflict");
    }
    if (current32 !== undefined) {
      const removed32 = await resolved.registry.removeHostPathIfExpected(
        DEVELOPMENT_NATIVE_HOST_NAME,
        "32",
        existingRegistry.chrome32,
      );
      if (
        !removed32 &&
        (await resolved.registry.readHostPath(DEVELOPMENT_NATIVE_HOST_NAME, "32")) !== undefined
      ) {
        throw new WindowsSetupError("registry_conflict");
      }
    }
  }
  const finalRegistry = await readRegistrySnapshot(resolved);
  if (finalRegistry.chrome32 !== undefined || finalRegistry.chrome64 !== undefined) {
    throw new WindowsSetupError("registry_conflict");
  }
  return Object.freeze({
    filesRetained: true,
    hostName: DEVELOPMENT_NATIVE_HOST_NAME,
    previousStatus,
    unregistered: true,
  });
}

async function inspectManagedRegistrationSafely(
  manifestPath: string,
  resolved: ResolvedSetupDependencies,
): Promise<ManagedRegistration | undefined> {
  try {
    return await inspectManagedRegistration(manifestPath, resolved);
  } catch (error) {
    throw new WindowsSetupError("registry_conflict", { cause: error });
  }
}

async function readRegistrySnapshot(
  resolved: ResolvedSetupDependencies,
): Promise<RegistrySnapshot> {
  const [chrome32, chrome64] = await Promise.all([
    resolved.registry.readHostPath(DEVELOPMENT_NATIVE_HOST_NAME, "32"),
    resolved.registry.readHostPath(DEVELOPMENT_NATIVE_HOST_NAME, "64"),
  ]);
  return Object.freeze({ chrome32, chrome64 });
}

async function inspectOwnedRegistrySnapshot(
  snapshot: RegistrySnapshot,
  resolved: ResolvedSetupDependencies,
): Promise<ManagedRegistrySnapshot> {
  if (
    snapshot.chrome32 !== undefined &&
    snapshot.chrome64 !== undefined &&
    pathsEqual(snapshot.chrome32, snapshot.chrome64, resolved.path)
  ) {
    const shared = await inspectManagedRegistrationSafely(snapshot.chrome32, resolved);
    if (shared === undefined) {
      throw new WindowsSetupError("registry_conflict");
    }
    return Object.freeze({ chrome32: shared, chrome64: shared });
  }
  const chrome32 =
    snapshot.chrome32 === undefined
      ? undefined
      : await inspectManagedRegistrationSafely(snapshot.chrome32, resolved);
  const chrome64 =
    snapshot.chrome64 === undefined
      ? undefined
      : await inspectManagedRegistrationSafely(snapshot.chrome64, resolved);
  if (
    (snapshot.chrome32 !== undefined && chrome32 === undefined) ||
    (snapshot.chrome64 !== undefined && chrome64 === undefined)
  ) {
    throw new WindowsSetupError("registry_conflict");
  }
  return Object.freeze({ chrome32, chrome64 });
}

async function createStatusFromSnapshot(
  snapshot: RegistrySnapshot,
  resolved: ResolvedSetupDependencies,
): Promise<WindowsSetupStatus> {
  if (snapshot.chrome32 === undefined && snapshot.chrome64 === undefined) {
    return Object.freeze({
      hostName: DEVELOPMENT_NATIVE_HOST_NAME,
      state: "not-installed",
    });
  }
  const manifestPath = snapshot.chrome32 ?? snapshot.chrome64;
  if (manifestPath === undefined) {
    throw new WindowsSetupError("registry_failure");
  }
  const registryPaths = createPublicRegistryPaths(snapshot);
  if (
    (snapshot.chrome32 !== undefined && !isDirectRegistrationPath(snapshot.chrome32, resolved)) ||
    (snapshot.chrome64 !== undefined && !isDirectRegistrationPath(snapshot.chrome64, resolved))
  ) {
    return createUnmanagedStatus(manifestPath, "outside-managed-root", registryPaths);
  }

  let managed: ManagedRegistrySnapshot;
  try {
    managed = await inspectOwnedRegistrySnapshot(snapshot, resolved);
  } catch {
    return createUnmanagedStatus(manifestPath, "package-invalid", registryPaths);
  }
  return createStatusFromManagedSnapshot(snapshot, managed, resolved);
}

function createStatusFromManagedSnapshot(
  snapshot: RegistrySnapshot,
  managed: ManagedRegistrySnapshot,
  resolved: ResolvedSetupDependencies,
): WindowsSetupStatus {
  const manifestPath = snapshot.chrome32 ?? snapshot.chrome64;
  if (manifestPath === undefined) {
    return Object.freeze({
      hostName: DEVELOPMENT_NATIVE_HOST_NAME,
      state: "not-installed",
    });
  }
  const registryPaths = createPublicRegistryPaths(snapshot);
  if (managed.chrome32 === undefined || managed.chrome64 === undefined) {
    return createUnmanagedStatus(manifestPath, "incomplete-registration", registryPaths);
  }
  if (
    !pathsEqual(
      managed.chrome32.status.manifestPath,
      managed.chrome64.status.manifestPath,
      resolved.path,
    )
  ) {
    return createUnmanagedStatus(manifestPath, "conflicting-registry-views", registryPaths);
  }
  return Object.freeze({ ...managed.chrome32.status, registryPaths });
}

function createUnmanagedStatus(
  manifestPath: string,
  reason: UnmanagedWindowsSetupStatus["reason"],
  registryPaths: WindowsRegistryPaths,
): UnmanagedWindowsSetupStatus {
  return Object.freeze({
    hostName: DEVELOPMENT_NATIVE_HOST_NAME,
    manifestPath,
    reason,
    registryPaths,
    state: "unmanaged",
  });
}

function createPublicRegistryPaths(snapshot: RegistrySnapshot): WindowsRegistryPaths {
  return Object.freeze({
    chrome32: snapshot.chrome32 ?? null,
    chrome64: snapshot.chrome64 ?? null,
  });
}

async function replaceRegistryView(
  view: WindowsRegistryView,
  existingPath: string | undefined,
  registrationPath: string,
  resolved: ResolvedSetupDependencies,
): Promise<void> {
  if (pathsOptionallyEqual(existingPath, registrationPath, resolved.path)) {
    return;
  }
  const replaced = await resolved.registry.replaceHostPathIfExpected(
    DEVELOPMENT_NATIVE_HOST_NAME,
    view,
    existingPath,
    registrationPath,
  );
  if (
    !replaced &&
    !pathsOptionallyEqual(
      await resolved.registry.readHostPath(DEVELOPMENT_NATIVE_HOST_NAME, view),
      registrationPath,
      resolved.path,
    )
  ) {
    throw new WindowsSetupError("registry_conflict");
  }
}

export function createChromeNativeMessagingManifest(
  executablePath: string,
  paths: PathDependencies = WINDOWS_PATHS,
): ChromeNativeMessagingManifest {
  if (!paths.isAbsolute(executablePath) || executablePath.includes("\0")) {
    throw new WindowsSetupError("invalid_chrome_manifest");
  }
  return Object.freeze({
    allowed_origins: Object.freeze([DEVELOPMENT_EXTENSION_ORIGIN] as const),
    description: NATIVE_HOST_DESCRIPTION,
    name: DEVELOPMENT_NATIVE_HOST_NAME,
    path: paths.resolve(executablePath),
    type: "stdio",
  });
}

export function serializeChromeNativeMessagingManifest(
  executablePath: string,
  paths: PathDependencies = WINDOWS_PATHS,
): string {
  return `${JSON.stringify(createChromeNativeMessagingManifest(executablePath, paths), undefined, 2)}\n`;
}

async function inspectManagedRegistration(
  manifestPath: string,
  resolved: ResolvedSetupDependencies,
): Promise<ManagedRegistration | undefined> {
  if (!isDirectRegistrationPath(manifestPath, resolved)) {
    return undefined;
  }
  await assertExistingInstallLayout(resolved);
  const basename = resolved.path.basename(manifestPath);
  const packageDigest = basename.slice(0, -".json".length);
  const registrationNode = await resolved.fileSystem.inspect(manifestPath);
  if (registrationNode?.kind !== "file") {
    return undefined;
  }
  const realRegistrationRoot = await resolved.fileSystem.realPath(
    resolved.layout.registrationsRoot,
  );
  const realRegistration = await resolved.fileSystem.realPath(manifestPath);
  assertPathContained(realRegistrationRoot, realRegistration, resolved.path, false);

  const packageRoot = resolved.path.join(resolved.layout.packagesRoot, packageDigest);
  const verifiedPackage = await verifyWindowsDevelopmentPackage(packageRoot, {
    fileSystem: resolved.fileSystem,
    path: resolved.path,
  });
  if (verifiedPackage.packageDigest !== packageDigest) {
    return undefined;
  }
  const executablePath = resolvePortablePath(
    packageRoot,
    verifiedPackage.manifest.hostExecutable,
    resolved.path,
  );
  const facadeExecutablePath = resolvePortablePath(
    packageRoot,
    verifiedPackage.manifest.facadeExecutable,
    resolved.path,
  );
  const extensionPath = resolved.path.join(packageRoot, "extension");
  const extensionNode = await resolved.fileSystem.inspect(extensionPath);
  if (extensionNode?.kind !== "directory") {
    return undefined;
  }
  const expectedManifest = serializeChromeNativeMessagingManifest(executablePath, resolved.path);
  if (
    (await resolved.fileSystem.readTextBounded(manifestPath, MAX_REGISTRATION_MANIFEST_BYTES)) !==
    expectedManifest
  ) {
    return undefined;
  }
  return Object.freeze({
    status: Object.freeze({
      executablePath,
      extensionPath,
      facadeExecutablePath,
      hostName: DEVELOPMENT_NATIVE_HOST_NAME,
      manifestPath,
      packageDigest,
      packageVersion: verifiedPackage.manifest.packageVersion,
      registryPaths: createPublicRegistryPaths({
        chrome32: manifestPath,
        chrome64: manifestPath,
      }),
      state: "installed",
    }),
    verifiedPackage,
  });
}

async function assertExistingInstallLayout(resolved: ResolvedSetupDependencies): Promise<void> {
  await assertSecureDirectory(resolved.platform.localAppData, undefined, resolved);
  await assertSecureDirectory(
    resolved.layout.managedRoot,
    resolved.platform.localAppData,
    resolved,
  );
  await assertSecureDirectory(resolved.layout.packagesRoot, resolved.layout.managedRoot, resolved);
  await assertSecureDirectory(
    resolved.layout.registrationsRoot,
    resolved.layout.managedRoot,
    resolved,
  );
}

async function ensureInstallLayout(resolved: ResolvedSetupDependencies): Promise<void> {
  await assertSecureDirectory(resolved.platform.localAppData, undefined, resolved);
  await assertExistingInstallAncestors(
    resolved.platform.localAppData,
    resolved.layout.managedRoot,
    resolved,
  );
  await resolved.fileSystem.makeDirectory(resolved.layout.managedRoot, true);
  await assertSecureDirectory(
    resolved.layout.managedRoot,
    resolved.platform.localAppData,
    resolved,
  );
  await resolved.fileSystem.makeDirectory(resolved.layout.packagesRoot, true);
  await resolved.fileSystem.makeDirectory(resolved.layout.registrationsRoot, true);
  await assertSecureDirectory(resolved.layout.packagesRoot, resolved.layout.managedRoot, resolved);
  await assertSecureDirectory(
    resolved.layout.registrationsRoot,
    resolved.layout.managedRoot,
    resolved,
  );
}

async function assertExistingInstallAncestors(
  root: string,
  target: string,
  resolved: ResolvedSetupDependencies,
): Promise<void> {
  const separator = resolved.path.style === "windows" ? "\\" : "/";
  const segments = resolved.path.relative(root, target).split(separator);
  const realRoot = await resolved.fileSystem.realPath(root);
  let current = root;
  for (const segment of segments) {
    current = resolved.path.join(current, segment);
    const node = await resolved.fileSystem.inspect(current);
    if (node === undefined) {
      return;
    }
    if (node.kind !== "directory") {
      throw new WindowsSetupError("invalid_package_path");
    }
    const realCurrent = await resolved.fileSystem.realPath(current);
    assertPathContained(realRoot, realCurrent, resolved.path, false);
  }
}

async function assertSecureDirectory(
  directory: string,
  parent: string | undefined,
  resolved: ResolvedSetupDependencies,
): Promise<void> {
  const node = await resolved.fileSystem.inspect(directory);
  if (node?.kind !== "directory") {
    throw new WindowsSetupError("invalid_install_root");
  }
  if (parent !== undefined) {
    const realParent = await resolved.fileSystem.realPath(parent);
    const realDirectory = await resolved.fileSystem.realPath(directory);
    assertPathContained(realParent, realDirectory, resolved.path, false);
  }
}

async function materializePackage(
  source: VerifiedWindowsPackage,
  resolved: ResolvedSetupDependencies,
): Promise<MaterializedPath> {
  const target = resolved.path.join(resolved.layout.packagesRoot, source.packageDigest);
  const targetNode = await resolved.fileSystem.inspect(target);
  if (targetNode !== undefined) {
    await assertExistingPackage(target, source.packageDigest, resolved);
    return Object.freeze({ created: false, path: target });
  }
  const nonce = resolved.platform.createNonce();
  if (!/^[a-f0-9]{16,128}$/u.test(nonce)) {
    throw new WindowsSetupError("invalid_install_root");
  }
  const staging = resolved.path.join(
    resolved.layout.packagesRoot,
    `.staging-${source.packageDigest}-${nonce}`,
  );
  assertPathContained(resolved.layout.packagesRoot, staging, resolved.path, false);
  await resolved.fileSystem.makeDirectory(staging, false);
  try {
    for (const file of source.manifest.files) {
      const destination = resolvePortablePath(staging, file.path, resolved.path);
      await resolved.fileSystem.makeDirectory(resolved.path.dirname(destination), true);
      const sourcePath = await assertRegularFileWithoutLinks(
        source.packageRoot,
        file.path,
        resolved.fileSystem,
        resolved.path,
      );
      await resolved.fileSystem.copyFileExclusive(sourcePath, destination, file.size);
    }
    await resolved.fileSystem.writeTextExclusive(
      resolved.path.join(staging, PACKAGE_MANIFEST_FILENAME),
      source.canonicalManifest,
    );
    await assertExistingPackage(staging, source.packageDigest, resolved);
    const sourceAfterCopy = await verifyWindowsPackage(source.packageRoot, {
      fileSystem: resolved.fileSystem,
      path: resolved.path,
    });
    if (sourceAfterCopy.packageDigest !== source.packageDigest) {
      throw new WindowsSetupError("artifact_changed");
    }
    try {
      await resolved.fileSystem.move(staging, target);
    } catch (error) {
      if ((await resolved.fileSystem.inspect(target)) === undefined) {
        throw new WindowsSetupError("filesystem_conflict", { cause: error });
      }
      await assertExistingPackage(target, source.packageDigest, resolved);
      await resolved.fileSystem.removeTree(staging);
      return Object.freeze({ created: false, path: target });
    }
    return Object.freeze({ created: true, path: target });
  } catch (error) {
    await resolved.fileSystem.removeTree(staging).catch(() => undefined);
    throw error;
  }
}

async function assertExistingPackage(
  packageRoot: string,
  packageDigest: string,
  resolved: ResolvedSetupDependencies,
): Promise<VerifiedWindowsPackage> {
  const verified = await verifyWindowsPackage(packageRoot, {
    fileSystem: resolved.fileSystem,
    path: resolved.path,
  });
  if (verified.packageDigest !== packageDigest) {
    throw new WindowsSetupError("filesystem_conflict");
  }
  return verified;
}

async function materializeRegistration(
  manifestPath: string,
  expectedContents: string,
  resolved: ResolvedSetupDependencies,
): Promise<MaterializedPath> {
  assertPathContained(resolved.layout.registrationsRoot, manifestPath, resolved.path, false);
  const existing = await resolved.fileSystem.inspect(manifestPath);
  if (existing !== undefined) {
    if (
      existing.kind !== "file" ||
      (await resolved.fileSystem.readTextBounded(manifestPath, MAX_REGISTRATION_MANIFEST_BYTES)) !==
        expectedContents
    ) {
      throw new WindowsSetupError("filesystem_conflict");
    }
    return Object.freeze({ created: false, path: manifestPath });
  }
  try {
    await resolved.fileSystem.writeTextExclusive(manifestPath, expectedContents);
    return Object.freeze({ created: true, path: manifestPath });
  } catch (error) {
    const raced = await resolved.fileSystem.inspect(manifestPath);
    if (
      raced?.kind === "file" &&
      (await resolved.fileSystem.readTextBounded(manifestPath, MAX_REGISTRATION_MANIFEST_BYTES)) ===
        expectedContents
    ) {
      return Object.freeze({ created: false, path: manifestPath });
    }
    throw new WindowsSetupError("filesystem_conflict", { cause: error });
  }
}

function isDirectRegistrationPath(
  manifestPath: string,
  resolved: ResolvedSetupDependencies,
): boolean {
  if (!resolved.path.isAbsolute(manifestPath)) {
    return false;
  }
  const basename = resolved.path.basename(manifestPath);
  if (!basename.endsWith(".json") || !PACKAGE_DIGEST_PATTERN.test(basename.slice(0, -5))) {
    return false;
  }
  const expected = resolved.path.join(resolved.layout.registrationsRoot, basename);
  return pathsEqual(expected, manifestPath, resolved.path);
}

function pathsOptionallyEqual(
  first: string | undefined,
  second: string | undefined,
  paths: PathDependencies,
): boolean {
  return first === undefined || second === undefined
    ? first === second
    : pathsEqual(first, second, paths);
}

function resolveSetupDependencies(
  dependencies: WindowsSetupDependencies,
): ResolvedSetupDependencies {
  const platform = dependencies.platform ?? createDefaultWindowsPlatform();
  const paths = dependencies.path ?? WINDOWS_PATHS;
  if (platform.operatingSystem !== "win32" || platform.architecture !== "x64") {
    throw new WindowsSetupError("unsupported_platform");
  }
  if (platform.localAppData.length === 0 || !paths.isAbsolute(platform.localAppData)) {
    throw new WindowsSetupError("invalid_install_root");
  }
  const managedRoot = paths.resolve(platform.localAppData, ...DEVELOPMENT_INSTALL_COMPONENTS);
  const layout = Object.freeze({
    managedRoot,
    packagesRoot: paths.join(managedRoot, "packages"),
    registrationsRoot: paths.join(managedRoot, "registrations"),
  });
  return Object.freeze({
    fileSystem: dependencies.fileSystem ?? NODE_FILE_SYSTEM,
    layout,
    path: paths,
    platform,
    registry: dependencies.registry ?? new WindowsCurrentUserChromeRegistry(),
  });
}
