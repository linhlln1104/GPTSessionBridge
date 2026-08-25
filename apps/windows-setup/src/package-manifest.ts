import { createHash } from "node:crypto";

import {
  NODE_FILE_SYSTEM,
  defaultPackagePathDependencies,
  type PackageIoDependencies,
  type PathDependencies,
  type WindowsSetupFileSystem,
} from "./dependencies.js";
import { PACKAGE_MANIFEST_FILENAME, PACKAGE_MANIFEST_SCHEMA_VERSION } from "./constants.js";
import { WindowsSetupError } from "./errors.js";
import { assertRegularFileWithoutLinks, validatePortablePackagePath } from "./secure-path.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CHROME_VERSION_COMPONENT_PATTERN = /^(?:0|[1-9][0-9]{0,4})$/u;
const MAX_CHROME_VERSION_COMPONENT = 65_535;
const MAX_PACKAGE_FILES = 8192;
const MAX_PACKAGE_ENTRIES = 16_384;
const MAX_PACKAGE_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;

export interface WindowsPackageFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface WindowsPackageManifest {
  readonly files: readonly WindowsPackageFile[];
  readonly hostExecutable: string;
  readonly packageVersion: string;
  readonly schemaVersion: typeof PACKAGE_MANIFEST_SCHEMA_VERSION;
}

export interface WindowsPackageManifestMetadata {
  readonly hostExecutable: string;
  readonly packageVersion: string;
}

export interface VerifiedWindowsPackage {
  readonly canonicalManifest: string;
  readonly manifest: WindowsPackageManifest;
  readonly packageDigest: string;
  readonly packageRoot: string;
}

export async function createWindowsPackageManifest(
  packageRoot: string,
  metadata: WindowsPackageManifestMetadata,
  dependencies: PackageIoDependencies = {},
): Promise<WindowsPackageManifest> {
  const { fileSystem, paths } = resolvePackageDependencies(dependencies);
  const packageVersion = validatePackageVersion(metadata.packageVersion);
  const hostExecutable = validatePortablePackagePath(metadata.hostExecutable);
  if (!hostExecutable.toLocaleLowerCase("en-US").endsWith(".exe")) {
    throw new WindowsSetupError("invalid_package_manifest");
  }

  const filePaths = await listPackageFiles(packageRoot, fileSystem, paths);
  if (!filePaths.includes(hostExecutable)) {
    throw new WindowsSetupError("artifact_missing");
  }
  const files: WindowsPackageFile[] = [];
  let totalBytes = 0;
  for (const path of filePaths) {
    const artifactPath = await assertRegularFileWithoutLinks(packageRoot, path, fileSystem, paths);
    const artifactNode = await fileSystem.inspect(artifactPath);
    if (artifactNode?.kind !== "file" || artifactNode.size > MAX_PACKAGE_BYTES - totalBytes) {
      throw new WindowsSetupError("package_contents_mismatch");
    }
    const hash = await fileSystem.hashFile(artifactPath, MAX_PACKAGE_BYTES - totalBytes);
    totalBytes += hash.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_PACKAGE_BYTES) {
      throw new WindowsSetupError("package_contents_mismatch");
    }
    await assertRegularFileWithoutLinks(packageRoot, path, fileSystem, paths);
    files.push(Object.freeze({ path, sha256: hash.sha256, size: hash.size }));
  }
  return freezeManifest({
    files,
    hostExecutable,
    packageVersion,
    schemaVersion: PACKAGE_MANIFEST_SCHEMA_VERSION,
  });
}

export async function writeWindowsPackageManifest(
  packageRoot: string,
  metadata: WindowsPackageManifestMetadata,
  dependencies: PackageIoDependencies = {},
): Promise<WindowsPackageManifest> {
  const { fileSystem, paths } = resolvePackageDependencies(dependencies);
  const manifest = await createWindowsPackageManifest(packageRoot, metadata, {
    fileSystem,
    path: paths,
  });
  const manifestPath = paths.join(paths.resolve(packageRoot), PACKAGE_MANIFEST_FILENAME);
  try {
    await fileSystem.writeTextExclusive(manifestPath, serializeWindowsPackageManifest(manifest));
  } catch (error) {
    throw new WindowsSetupError("filesystem_conflict", { cause: error });
  }
  return manifest;
}

export function parseWindowsPackageManifest(text: string): WindowsPackageManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new WindowsSetupError("invalid_package_manifest", { cause: error });
  }
  if (!isPlainRecord(parsed) || !hasExactKeys(parsed, MANIFEST_KEYS)) {
    throw new WindowsSetupError("invalid_package_manifest");
  }
  if (
    parsed["schemaVersion"] !== PACKAGE_MANIFEST_SCHEMA_VERSION ||
    !Array.isArray(parsed["files"]) ||
    parsed["files"].length === 0 ||
    parsed["files"].length > MAX_PACKAGE_FILES
  ) {
    throw new WindowsSetupError("invalid_package_manifest");
  }
  const packageVersion = validatePackageVersion(parsed["packageVersion"]);
  const hostExecutable = validatePortablePackagePath(parsed["hostExecutable"]);
  if (!hostExecutable.toLocaleLowerCase("en-US").endsWith(".exe")) {
    throw new WindowsSetupError("invalid_package_manifest");
  }

  const files = parsed["files"].map(parsePackageFile);
  assertTotalPackageSize(files);
  assertCanonicalFileOrder(files);
  if (!files.some((file) => file.path === hostExecutable)) {
    throw new WindowsSetupError("invalid_package_manifest");
  }
  return freezeManifest({
    files,
    hostExecutable,
    packageVersion,
    schemaVersion: PACKAGE_MANIFEST_SCHEMA_VERSION,
  });
}

export function serializeWindowsPackageManifest(manifest: WindowsPackageManifest): string {
  const validated = parseManifestValue(manifest);
  return `${JSON.stringify(validated, undefined, 2)}\n`;
}

export async function verifyWindowsPackage(
  packageRoot: string,
  dependencies: PackageIoDependencies = {},
): Promise<VerifiedWindowsPackage> {
  const { fileSystem, paths } = resolvePackageDependencies(dependencies);
  const resolvedRoot = paths.resolve(packageRoot);
  const rootNode = await fileSystem.inspect(resolvedRoot);
  if (rootNode?.kind !== "directory") {
    throw new WindowsSetupError("artifact_missing");
  }
  const manifestPath = await assertRegularFileWithoutLinks(
    resolvedRoot,
    PACKAGE_MANIFEST_FILENAME,
    fileSystem,
    paths,
  );
  const manifestNodeBeforeRead = await fileSystem.inspect(manifestPath);
  if (
    manifestNodeBeforeRead?.kind !== "file" ||
    manifestNodeBeforeRead.size > MAX_PACKAGE_MANIFEST_BYTES
  ) {
    throw new WindowsSetupError("invalid_package_manifest");
  }
  const rawManifest = await fileSystem.readTextBounded(manifestPath, MAX_PACKAGE_MANIFEST_BYTES);
  const manifest = parseWindowsPackageManifest(rawManifest);
  const canonicalManifest = serializeWindowsPackageManifest(manifest);
  if (rawManifest !== canonicalManifest) {
    throw new WindowsSetupError("invalid_package_manifest");
  }

  const actualFiles = await listPackageFiles(resolvedRoot, fileSystem, paths);
  const expectedFiles = manifest.files.map((file) => file.path);
  if (!arraysEqual(actualFiles, expectedFiles)) {
    throw new WindowsSetupError("package_contents_mismatch");
  }
  for (const file of manifest.files) {
    const artifactPath = await assertRegularFileWithoutLinks(
      resolvedRoot,
      file.path,
      fileSystem,
      paths,
    );
    const artifactNode = await fileSystem.inspect(artifactPath);
    if (artifactNode?.kind !== "file" || artifactNode.size !== file.size) {
      throw new WindowsSetupError("artifact_size_mismatch");
    }
    const actual = await fileSystem.hashFile(artifactPath, file.size);
    if (actual.size !== file.size) {
      throw new WindowsSetupError("artifact_size_mismatch");
    }
    if (actual.sha256 !== file.sha256) {
      throw new WindowsSetupError("artifact_hash_mismatch");
    }
    await assertRegularFileWithoutLinks(resolvedRoot, file.path, fileSystem, paths);
  }
  return Object.freeze({
    canonicalManifest,
    manifest,
    packageDigest: createHash("sha256").update(canonicalManifest, "utf8").digest("hex"),
    packageRoot: resolvedRoot,
  });
}

const MANIFEST_KEYS = Object.freeze(["files", "hostExecutable", "packageVersion", "schemaVersion"]);
const FILE_KEYS = Object.freeze(["path", "sha256", "size"]);

function parseManifestValue(value: WindowsPackageManifest): WindowsPackageManifest {
  return parseWindowsPackageManifest(JSON.stringify(value));
}

function parsePackageFile(value: unknown): WindowsPackageFile {
  if (!isPlainRecord(value) || !hasExactKeys(value, FILE_KEYS)) {
    throw new WindowsSetupError("invalid_package_manifest");
  }
  const path = validatePortablePackagePath(value["path"]);
  if (
    typeof value["sha256"] !== "string" ||
    !SHA256_PATTERN.test(value["sha256"]) ||
    typeof value["size"] !== "number" ||
    !Number.isSafeInteger(value["size"]) ||
    value["size"] < 0 ||
    value["size"] > MAX_PACKAGE_BYTES
  ) {
    throw new WindowsSetupError("invalid_package_manifest");
  }
  return Object.freeze({ path, sha256: value["sha256"], size: value["size"] });
}

function assertTotalPackageSize(files: readonly WindowsPackageFile[]): void {
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_PACKAGE_BYTES) {
      throw new WindowsSetupError("invalid_package_manifest");
    }
  }
}

function validatePackageVersion(value: unknown): string {
  if (typeof value !== "string") {
    throw new WindowsSetupError("invalid_package_manifest");
  }
  const components = value.split(".");
  if (
    components.length < 1 ||
    components.length > 4 ||
    components.every((component) => component === "0") ||
    components.some(
      (component) =>
        !CHROME_VERSION_COMPONENT_PATTERN.test(component) ||
        Number(component) > MAX_CHROME_VERSION_COMPONENT,
    )
  ) {
    throw new WindowsSetupError("invalid_package_manifest");
  }
  return value;
}

function assertCanonicalFileOrder(files: readonly WindowsPackageFile[]): void {
  let previous: string | undefined;
  const caseInsensitive = new Set<string>();
  for (const file of files) {
    if (previous !== undefined && comparePortablePaths(previous, file.path) >= 0) {
      throw new WindowsSetupError("invalid_package_manifest");
    }
    const folded = file.path.toLocaleLowerCase("en-US");
    if (caseInsensitive.has(folded)) {
      throw new WindowsSetupError("invalid_package_manifest");
    }
    caseInsensitive.add(folded);
    previous = file.path;
  }
}

async function listPackageFiles(
  packageRoot: string,
  fileSystem: WindowsSetupFileSystem,
  paths: PathDependencies,
): Promise<readonly string[]> {
  const root = paths.resolve(packageRoot);
  const rootNode = await fileSystem.inspect(root);
  if (rootNode?.kind !== "directory") {
    throw new WindowsSetupError("artifact_missing");
  }
  const files: string[] = [];
  let visitedEntries = 0;
  await visitDirectory(root, "");
  files.sort(comparePortablePaths);
  if (files.length === 0 || files.length > MAX_PACKAGE_FILES) {
    throw new WindowsSetupError("invalid_package_manifest");
  }
  const folded = new Set<string>();
  for (const file of files) {
    const key = file.toLocaleLowerCase("en-US");
    if (folded.has(key)) {
      throw new WindowsSetupError("invalid_package_path");
    }
    folded.add(key);
  }
  return Object.freeze(files);

  async function visitDirectory(directory: string, portableParent: string): Promise<void> {
    const remainingEntries = MAX_PACKAGE_ENTRIES - visitedEntries;
    const entries = [...(await fileSystem.listDirectory(directory, remainingEntries))].sort(
      (left, right) => comparePortablePaths(left.name, right.name),
    );
    visitedEntries += entries.length;
    let childCount = 0;
    for (const entry of entries) {
      const portablePath =
        portableParent.length === 0 ? entry.name : `${portableParent}/${entry.name}`;
      validatePortablePackagePath(portablePath);
      if (portableParent.length === 0 && entry.name === PACKAGE_MANIFEST_FILENAME) {
        if (entry.kind !== "file") {
          throw new WindowsSetupError("invalid_package_path");
        }
        continue;
      }
      childCount += 1;
      if (entry.kind === "file") {
        files.push(portablePath);
        if (files.length > MAX_PACKAGE_FILES) {
          throw new WindowsSetupError("invalid_package_manifest");
        }
      } else if (entry.kind === "directory") {
        await visitDirectory(paths.join(directory, entry.name), portablePath);
      } else {
        throw new WindowsSetupError("invalid_package_path");
      }
    }
    if (portableParent.length > 0 && childCount === 0) {
      throw new WindowsSetupError("package_contents_mismatch");
    }
  }
}

function freezeManifest(manifest: WindowsPackageManifest): WindowsPackageManifest {
  return Object.freeze({
    files: Object.freeze([...manifest.files]),
    hostExecutable: manifest.hostExecutable,
    packageVersion: manifest.packageVersion,
    schemaVersion: PACKAGE_MANIFEST_SCHEMA_VERSION,
  });
}

function comparePortablePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(comparePortablePaths);
  const sortedExpected = [...expected].sort(comparePortablePaths);
  return arraysEqual(actual, sortedExpected);
}

function resolvePackageDependencies(dependencies: PackageIoDependencies): {
  readonly fileSystem: WindowsSetupFileSystem;
  readonly paths: PathDependencies;
} {
  return {
    fileSystem: dependencies.fileSystem ?? NODE_FILE_SYSTEM,
    paths: dependencies.path ?? defaultPackagePathDependencies(),
  };
}
