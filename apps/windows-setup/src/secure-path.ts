import type { PathDependencies, WindowsSetupFileSystem } from "./dependencies.js";
import { WindowsSetupError } from "./errors.js";

const PORTABLE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const WINDOWS_RESERVED_BASENAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;

export function validatePortablePackagePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new WindowsSetupError("invalid_package_path");
  }
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    value.includes("\0")
  ) {
    throw new WindowsSetupError("invalid_package_path");
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        !PORTABLE_SEGMENT_PATTERN.test(segment) ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        WINDOWS_RESERVED_BASENAMES.test(segment),
    )
  ) {
    throw new WindowsSetupError("invalid_package_path");
  }
  return value;
}

export function resolvePortablePath(
  root: string,
  portablePath: string,
  paths: PathDependencies,
): string {
  const validated = validatePortablePackagePath(portablePath);
  const result = paths.resolve(root, ...validated.split("/"));
  assertPathContained(root, result, paths, false);
  return result;
}

export function assertPathContained(
  root: string,
  candidate: string,
  paths: PathDependencies,
  allowRoot: boolean,
): void {
  const canonicalRoot = normalizeForComparison(paths.resolve(root), paths);
  const canonicalCandidate = normalizeForComparison(paths.resolve(candidate), paths);
  const relative = normalizeForComparison(paths.relative(canonicalRoot, canonicalCandidate), paths);
  if (
    (!allowRoot && relative.length === 0) ||
    relative === ".." ||
    relative.startsWith(`..${paths.style === "windows" ? "\\" : "/"}`) ||
    paths.isAbsolute(relative)
  ) {
    throw new WindowsSetupError("invalid_package_path");
  }
}

export function pathsEqual(first: string, second: string, paths: PathDependencies): boolean {
  return (
    normalizeForComparison(paths.resolve(first), paths) ===
    normalizeForComparison(paths.resolve(second), paths)
  );
}

export async function assertRegularFileWithoutLinks(
  root: string,
  portablePath: string,
  fileSystem: WindowsSetupFileSystem,
  paths: PathDependencies,
): Promise<string> {
  const rootPath = paths.resolve(root);
  const rootNode = await fileSystem.inspect(rootPath);
  if (rootNode?.kind !== "directory") {
    throw new WindowsSetupError("artifact_missing");
  }
  let current = rootPath;
  const segments = validatePortablePackagePath(portablePath).split("/");
  for (const [index, segment] of segments.entries()) {
    current = paths.join(current, segment);
    assertPathContained(rootPath, current, paths, false);
    const node = await fileSystem.inspect(current);
    const expectedKind = index === segments.length - 1 ? "file" : "directory";
    if (node?.kind !== expectedKind) {
      throw new WindowsSetupError(node === undefined ? "artifact_missing" : "invalid_package_path");
    }
  }
  const realRoot = await fileSystem.realPath(rootPath);
  const realFile = await fileSystem.realPath(current);
  assertPathContained(realRoot, realFile, paths, false);
  return current;
}

function normalizeForComparison(value: string, paths: PathDependencies): string {
  return paths.style === "windows" ? value.toLocaleLowerCase("en-US") : value;
}
