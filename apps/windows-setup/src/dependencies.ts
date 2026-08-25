import { lstat, mkdir, open, opendir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { createHash, randomBytes } from "node:crypto";

import { WindowsSetupError } from "./errors.js";

const HASH_BUFFER_BYTES = 64 * 1024;
const MAX_BOUNDED_TEXT_BYTES = 64 * 1024 * 1024;

export type FileSystemNodeKind = "directory" | "file" | "other" | "symbolic-link";

export interface FileSystemNode {
  readonly kind: FileSystemNodeKind;
  readonly size: number;
}

export interface FileSystemDirectoryEntry {
  readonly kind: FileSystemNodeKind;
  readonly name: string;
}

export interface FileHash {
  readonly sha256: string;
  readonly size: number;
}

export interface WindowsSetupFileSystem {
  copyFileExclusive(source: string, destination: string, expectedSize: number): Promise<void>;
  hashFile(path: string, maximumBytes: number): Promise<FileHash>;
  inspect(path: string): Promise<FileSystemNode | undefined>;
  listDirectory(path: string, maximumEntries: number): Promise<readonly FileSystemDirectoryEntry[]>;
  makeDirectory(path: string, recursive: boolean): Promise<void>;
  move(source: string, destination: string): Promise<void>;
  readTextBounded(path: string, maximumBytes: number): Promise<string>;
  realPath(path: string): Promise<string>;
  removeTree(path: string): Promise<void>;
  writeTextExclusive(path: string, contents: string): Promise<void>;
}

export interface PathDependencies {
  readonly style: "posix" | "windows";
  basename(path: string): string;
  dirname(path: string): string;
  isAbsolute(path: string): boolean;
  join(...parts: readonly string[]): string;
  relative(from: string, to: string): string;
  resolve(...parts: readonly string[]): string;
}

export interface WindowsSetupPlatform {
  readonly architecture: NodeJS.Architecture;
  readonly localAppData: string;
  readonly operatingSystem: NodeJS.Platform;
  createNonce(): string;
}

export interface PackageIoDependencies {
  readonly fileSystem?: WindowsSetupFileSystem;
  readonly path?: PathDependencies;
}

export const NODE_FILE_SYSTEM: WindowsSetupFileSystem = Object.freeze({
  async copyFileExclusive(
    source: string,
    destination: string,
    expectedSize: number,
  ): Promise<void> {
    assertIoByteLimit(expectedSize);
    const sourceHandle = await open(source, "r");
    try {
      const before = await sourceHandle.stat();
      if (!before.isFile() || before.size !== expectedSize) {
        throw new WindowsSetupError("artifact_changed");
      }
      const destinationHandle = await open(destination, "wx");
      try {
        const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
        let position = 0;
        while (position < before.size) {
          const length = Math.min(buffer.byteLength, before.size - position);
          const read = await sourceHandle.read(buffer, 0, length, position);
          if (read.bytesRead === 0) {
            throw new WindowsSetupError("artifact_changed");
          }
          let written = 0;
          while (written < read.bytesRead) {
            const result = await destinationHandle.write(
              buffer,
              written,
              read.bytesRead - written,
              position + written,
            );
            if (result.bytesWritten === 0) {
              throw new WindowsSetupError("filesystem_conflict");
            }
            written += result.bytesWritten;
          }
          position += read.bytesRead;
        }
        const [after, destinationStat] = await Promise.all([
          sourceHandle.stat(),
          destinationHandle.stat(),
        ]);
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          position !== after.size ||
          destinationStat.size !== expectedSize
        ) {
          throw new WindowsSetupError("artifact_changed");
        }
      } finally {
        await destinationHandle.close();
      }
    } finally {
      await sourceHandle.close();
    }
  },
  async hashFile(path: string, maximumBytes: number): Promise<FileHash> {
    assertIoByteLimit(maximumBytes);
    const handle = await open(path, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile()) {
        throw new WindowsSetupError("artifact_missing");
      }
      if (before.size > maximumBytes) {
        throw new WindowsSetupError("artifact_size_mismatch");
      }
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
      let position = 0;
      while (position < before.size) {
        const length = Math.min(buffer.byteLength, before.size - position);
        const result = await handle.read(buffer, 0, length, position);
        if (result.bytesRead === 0) {
          throw new WindowsSetupError("artifact_changed");
        }
        digest.update(buffer.subarray(0, result.bytesRead));
        position += result.bytesRead;
      }
      const after = await handle.stat();
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        position !== after.size
      ) {
        throw new WindowsSetupError("artifact_changed");
      }
      return Object.freeze({ sha256: digest.digest("hex"), size: after.size });
    } finally {
      await handle.close();
    }
  },
  async inspect(path: string): Promise<FileSystemNode | undefined> {
    try {
      const result = await lstat(path);
      const kind: FileSystemNodeKind = result.isSymbolicLink()
        ? "symbolic-link"
        : result.isDirectory()
          ? "directory"
          : result.isFile()
            ? "file"
            : "other";
      return Object.freeze({ kind, size: result.size });
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }
  },
  async listDirectory(
    path: string,
    maximumEntries: number,
  ): Promise<readonly FileSystemDirectoryEntry[]> {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0) {
      throw new WindowsSetupError("package_contents_mismatch");
    }
    const directory = await opendir(path);
    const entries: FileSystemDirectoryEntry[] = [];
    for await (const entry of directory) {
      if (entries.length >= maximumEntries) {
        throw new WindowsSetupError("package_contents_mismatch");
      }
      entries.push(
        Object.freeze({
          kind: entry.isSymbolicLink()
            ? "symbolic-link"
            : entry.isDirectory()
              ? "directory"
              : entry.isFile()
                ? "file"
                : "other",
          name: entry.name,
        }),
      );
    }
    return entries;
  },
  async makeDirectory(path: string, recursive: boolean): Promise<void> {
    await mkdir(path, { recursive });
  },
  async move(source: string, destination: string): Promise<void> {
    await rename(source, destination);
  },
  async readTextBounded(path: string, maximumBytes: number): Promise<string> {
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 0 ||
      maximumBytes > MAX_BOUNDED_TEXT_BYTES
    ) {
      throw new WindowsSetupError("artifact_size_mismatch");
    }
    const handle = await open(path, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > maximumBytes) {
        throw new WindowsSetupError("artifact_size_mismatch");
      }
      const chunks: Buffer[] = [];
      const buffer = Buffer.allocUnsafe(Math.min(HASH_BUFFER_BYTES, maximumBytes + 1));
      let position = 0;
      while (position <= maximumBytes) {
        const length = Math.min(buffer.byteLength, maximumBytes + 1 - position);
        if (length === 0) {
          break;
        }
        const result = await handle.read(buffer, 0, length, position);
        if (result.bytesRead === 0) {
          break;
        }
        chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
        position += result.bytesRead;
      }
      if (position > maximumBytes) {
        throw new WindowsSetupError("artifact_size_mismatch");
      }
      const after = await handle.stat();
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        position !== after.size
      ) {
        throw new WindowsSetupError("artifact_changed");
      }
      return Buffer.concat(chunks, position).toString("utf8");
    } finally {
      await handle.close();
    }
  },
  async realPath(path: string): Promise<string> {
    return realpath(path);
  },
  async removeTree(path: string): Promise<void> {
    await rm(path, { force: true, recursive: true });
  },
  async writeTextExclusive(path: string, contents: string): Promise<void> {
    await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
  },
});

export const POSIX_PATHS = createPathDependencies("posix");
export const WINDOWS_PATHS = createPathDependencies("windows");

export function createPathDependencies(style: PathDependencies["style"]): PathDependencies {
  const implementation = style === "windows" ? win32 : posix;
  return Object.freeze({
    style,
    basename: (path: string) => implementation.basename(path),
    dirname: (path: string) => implementation.dirname(path),
    isAbsolute: (path: string) => implementation.isAbsolute(path),
    join: (...parts: readonly string[]) => implementation.join(...parts),
    relative: (from: string, to: string) => implementation.relative(from, to),
    resolve: (...parts: readonly string[]) => implementation.resolve(...parts),
  });
}

export function createDefaultWindowsPlatform(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  operatingSystem: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
): WindowsSetupPlatform {
  return Object.freeze({
    architecture,
    createNonce: () => randomBytes(16).toString("hex"),
    localAppData: environment["LOCALAPPDATA"] ?? "",
    operatingSystem,
  });
}

export function defaultPackagePathDependencies(): PathDependencies {
  return process.platform === "win32" ? WINDOWS_PATHS : POSIX_PATHS;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

function assertIoByteLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WindowsSetupError("artifact_size_mismatch");
  }
}
