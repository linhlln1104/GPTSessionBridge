import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { writeWindowsPackageManifest } from "../apps/windows-setup/dist/index.js";
import { BRIDGE_IMPLEMENTATION_VERSION } from "../packages/native-messaging/dist/link/index.js";

const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const FACADE_EXECUTABLE = "gptsessionbridge-facade.exe";
const HOST_EXECUTABLE = "gptsessionbridge-native-host.exe";
const HELPER_EXECUTABLE = "gptsessionbridge-windows-ipc.exe";
const arguments_ = process.argv.slice(2);
const allowUnsupportedPlatform = arguments_.length === 1 && arguments_[0] === "--if-supported";

if (arguments_.length > (allowUnsupportedPlatform ? 1 : 0)) {
  throw new Error("Unknown Windows packaging option.");
}

if (process.platform !== "win32" || process.arch !== "x64") {
  if (allowUnsupportedPlatform) {
    process.stdout.write("Windows x64 packaging skipped on this platform.\n");
    process.exit(0);
  }
  throw new Error("Windows packaging requires a Windows x64 Node.js process.");
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedNodeVersion = (
  await readFile(resolve(repositoryRoot, ".node-version"), "utf8")
).trim();
if (process.version !== `v${expectedNodeVersion}`) {
  throw new Error(`Windows packaging requires Node.js ${expectedNodeVersion}.`);
}
const artifactsRoot = resolve(repositoryRoot, "artifacts");
const finalPackageRoot = resolve(artifactsRoot, "windows-x64");

if (dirname(finalPackageRoot) !== artifactsRoot) {
  throw new Error("Refusing to write an unexpected Windows package directory.");
}

await mkdir(artifactsRoot, { recursive: true });
const stagingRoot = await mkdtemp(join(artifactsRoot, ".windows-x64-"));

try {
  const buildRoot = resolve(stagingRoot, ".build");
  const nativeHostRoot = resolve(stagingRoot, "native-host");
  const extensionRoot = resolve(stagingRoot, "extension");
  await Promise.all([
    mkdir(buildRoot, { recursive: true }),
    mkdir(nativeHostRoot, { recursive: true }),
  ]);

  const versionedPackages = await Promise.all(
    [
      "package.json",
      "apps/bridge/package.json",
      "apps/browser-extension/package.json",
      "apps/native-host/package.json",
      "apps/windows-setup/package.json",
      "packages/core/package.json",
      "packages/native-messaging/package.json",
      "packages/protocol/package.json",
    ].map((path) => readJson(resolve(repositoryRoot, path))),
  );
  const packageVersion = versionedPackages[0]?.version;
  if (
    typeof packageVersion !== "string" ||
    packageVersion !== BRIDGE_IMPLEMENTATION_VERSION ||
    versionedPackages.some((metadata) => metadata.version !== packageVersion)
  ) {
    throw new Error("GPTSessionBridge package and runtime versions must match.");
  }
  const dotnetBuildProperties = await readFile(
    resolve(repositoryRoot, "native/windows-ipc/Directory.Build.props"),
    "utf8",
  );
  if (!dotnetBuildProperties.includes(`<Version>${packageVersion}</Version>`)) {
    throw new Error("The Windows IPC helper version must match the package version.");
  }

  const hostExecutablePath = resolve(nativeHostRoot, HOST_EXECUTABLE);
  const facadeExecutablePath = resolve(nativeHostRoot, FACADE_EXECUTABLE);
  await packageSeaExecutable({
    buildName: "native-host",
    buildRoot,
    entryPoint: resolve(repositoryRoot, "apps/native-host/src/sea-entry.ts"),
    executablePath: hostExecutablePath,
  });
  await packageSeaExecutable({
    buildName: "facade",
    buildRoot,
    entryPoint: resolve(repositoryRoot, "apps/bridge/src/sea-entry.ts"),
    executablePath: facadeExecutablePath,
  });

  await Promise.all([
    copyFile(resolve(repositoryRoot, "LICENSE"), resolve(stagingRoot, "LICENSE")),
    copyFile(
      resolve(
        repositoryRoot,
        "native/windows-ipc/artifacts/win-x64/gptsessionbridge-windows-ipc.exe",
      ),
      resolve(nativeHostRoot, HELPER_EXECUTABLE),
    ),
    copyFile(
      resolve(repositoryRoot, "apps/native-host/manifest/chrome-windows.template.json"),
      resolve(nativeHostRoot, "chrome-windows.template.json"),
    ),
    cp(resolve(repositoryRoot, "apps/browser-extension/dist"), extensionRoot, {
      errorOnExist: true,
      force: false,
      recursive: true,
      verbatimSymlinks: true,
    }),
  ]);

  await rm(buildRoot, { force: true, recursive: true });
  await writeWindowsPackageManifest(stagingRoot, {
    facadeExecutable: `native-host/${FACADE_EXECUTABLE}`,
    hostExecutable: `native-host/${HOST_EXECUTABLE}`,
    packageVersion,
  });

  await rm(finalPackageRoot, { force: true, recursive: true });
  await rename(stagingRoot, finalPackageRoot);
  process.stdout.write("Created the Windows x64 development package.\n");
} catch (error) {
  await rm(stagingRoot, { force: true, recursive: true });
  throw error;
}

async function packageSeaExecutable({ buildName, buildRoot, entryPoint, executablePath }) {
  const bundleFilename = `${buildName}.cjs`;
  const blobFilename = `${buildName}.blob`;
  const configFilename = `${buildName}-sea-config.json`;
  const bundlePath = resolve(buildRoot, bundleFilename);
  const blobPath = resolve(buildRoot, blobFilename);
  await build({
    bundle: true,
    define: { "import.meta.url": "undefined" },
    entryPoints: [entryPoint],
    format: "cjs",
    legalComments: "none",
    logLevel: "warning",
    minify: false,
    outfile: bundlePath,
    platform: "node",
    sourcemap: false,
    target: "node24",
  });
  await writeFile(
    resolve(buildRoot, configFilename),
    `${JSON.stringify(
      {
        disableExperimentalSEAWarning: true,
        main: bundleFilename,
        output: blobFilename,
        useCodeCache: false,
      },
      undefined,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  run(process.execPath, ["--experimental-sea-config", configFilename], buildRoot);
  await copyFile(process.execPath, executablePath);
  const postjectCli = fileURLToPath(new URL("cli.js", import.meta.resolve("postject")));
  run(process.execPath, [
    postjectCli,
    executablePath,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    SEA_FUSE,
  ]);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function run(executable, args, cwd = repositoryRoot) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw new Error("A Windows packaging tool could not start.", { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error("A Windows packaging tool failed.");
  }
}
