import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { DEVELOPMENT_EXTENSION_ORIGIN } from "../packages/native-messaging/dist/link/index.js";
import { verifyWindowsDevelopmentPackage } from "../apps/windows-setup/dist/index.js";

const FRAME_TIMEOUT_MS = 15_000;
const LARGE_APP_SERVER_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_APP_SERVER_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 4_096;
const PROTOCOL_VERSION = 2;
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const EXTENSION_APP_SERVER_ARGS = Object.freeze([
  "-c",
  "features.code_mode_host=true",
  "app-server",
  "--analytics-default-enabled",
]);
const arguments_ = process.argv.slice(2);
const allowUnsupportedPlatform = arguments_.length === 1 && arguments_[0] === "--if-supported";

if (arguments_.length > (allowUnsupportedPlatform ? 1 : 0)) {
  throw new Error("Unknown Windows package verification option.");
}

if (process.platform !== "win32" || process.arch !== "x64") {
  if (allowUnsupportedPlatform) {
    process.stdout.write("Windows x64 package verification skipped on this platform.\n");
    process.exit(0);
  }
  throw new Error("Windows package verification requires a Windows x64 Node.js process.");
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(repositoryRoot, "artifacts/windows-x64");
const verified = await verifyWindowsDevelopmentPackage(packageRoot);
const facadeExecutable = resolve(packageRoot, verified.manifest.facadeExecutable);
const hostExecutable = resolve(packageRoot, verified.manifest.hostExecutable);
const helperExecutable = resolve(packageRoot, "native-host/gptsessionbridge-windows-ipc.exe");
if (resolve(dirname(facadeExecutable), "gptsessionbridge-windows-ipc.exe") !== helperExecutable) {
  throw new Error("The packaged facade helper is not adjacent to the facade executable.");
}

for (const executablePath of [facadeExecutable, hostExecutable, helperExecutable]) {
  const executableBytes = await readFile(executablePath);
  for (const forbidden of [
    Buffer.from(repositoryRoot, "utf8"),
    Buffer.from(repositoryRoot.replaceAll("\\", "/"), "utf8"),
    Buffer.from(repositoryRoot, "utf16le"),
  ]) {
    if (executableBytes.indexOf(forbidden) >= 0) {
      throw new Error("A packaged executable contains a local repository path.");
    }
  }
}

async function smokePackagedFacade(facadePath) {
  const isolatedWorkingDirectory = await mkdtemp(join(tmpdir(), "gptsb-facade-smoke-"));
  let facade;
  try {
    await createFakeCodexExecutable(isolatedWorkingDirectory);
    facade = spawn(facadePath, EXTENSION_APP_SERVER_ARGS, {
      ...childOptions(isolatedWorkingDirectory),
      env: createFacadeSmokeEnvironment(isolatedWorkingDirectory),
    });
    const messages = new JsonLineReader(facade.stdout);
    const diagnostics = collectBounded(facade.stderr);

    writeJsonLine(facade.stdin, {
      id: "1",
      method: "initialize",
      params: {
        capabilities: {
          experimentalApi: true,
          mcpServerOpenaiFormElicitation: true,
          requestAttestation: false,
        },
        clientInfo: {
          name: "VS Code",
          title: "Codex Extension",
          version: "26.820.60940",
        },
      },
    });
    assertAppServerResponse(await messages.read(), "1");
    writeJsonLine(facade.stdin, { method: "initialized" });
    writeJsonLine(facade.stdin, {
      id: "2",
      method: "model/list",
      params: { includeHidden: false, limit: 1_000 },
    });
    const catalog = assertAppServerResponse(await messages.read(), "2");
    if (
      !Array.isArray(catalog.data) ||
      catalog.data.length !== 1 ||
      catalog.data[0]?.id !== "native-package-model" ||
      catalog.nextCursor !== null
    ) {
      throw new Error("The packaged facade returned an unexpected model catalog.");
    }

    writeJsonLine(facade.stdin, {
      id: "3",
      method: "thread/resume",
      params: { path: "", threadId: "native-package-thread" },
    });
    const resumed = assertAppServerResponse(await messages.read(), "3");
    if (
      resumed.thread?.id !== "native-package-thread" ||
      resumed.receivedPath !== "" ||
      resumed.largeResumePayload?.length !== LARGE_APP_SERVER_PAYLOAD_BYTES
    ) {
      throw new Error("The packaged facade did not preserve a native resume request.");
    }

    facade.stdin.end();
    const exit = await waitForExit(facade);
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error("The packaged facade did not exit cleanly.");
    }
    const diagnosticResult = await diagnostics;
    if (diagnosticResult.exceeded || diagnosticResult.bytes.byteLength !== 0) {
      throw new Error("The packaged facade emitted unexpected diagnostics.");
    }
  } finally {
    await stopChild(facade);
    await rm(isolatedWorkingDirectory, { force: true, recursive: true });
  }
}

async function createFakeCodexExecutable(directory) {
  const sourceFilename = "fake-codex.cjs";
  const blobFilename = "fake-codex.blob";
  const configFilename = "fake-codex-sea-config.json";
  const executablePath = resolve(directory, "codex.exe");
  const source = [
    '"use strict";',
    'const { createInterface } = require("node:readline");',
    `const largeResumePayload = "x".repeat(${LARGE_APP_SERVER_PAYLOAD_BYTES});`,
    `const expectedArgs = ${JSON.stringify(EXTENSION_APP_SERVER_ARGS)};`,
    "const actualArgs = process.argv.slice(2);",
    "const launchMatches = JSON.stringify(actualArgs) === JSON.stringify(expectedArgs);",
    "const originatorMatches = process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE === 'codex_vscode';",
    "const runtimeLogMatches = process.env.RUST_LOG === 'warn';",
    "if (!launchMatches || !originatorMatches || !runtimeLogMatches) {",
    "  process.exitCode = 9;",
    "} else {",
    "  const lines = createInterface({ input: process.stdin, terminal: false });",
    "  lines.on('line', (line) => {",
    "    let request;",
    "    try { request = JSON.parse(line); } catch { return; }",
    "    if (request === null || typeof request !== 'object' || !('id' in request)) return;",
    "    const result = request.method === 'initialize'",
    "      ? { userAgent: 'packaged-facade-smoke' }",
    "      : request.method === 'model/list'",
    "        ? { data: [{ id: 'native-package-model', isDefault: true, model: 'native-package-model' }], nextCursor: null }",
    "        : request.method === 'thread/resume'",
    "          ? { largeResumePayload, model: 'native-package-model', modelProvider: 'native-package-provider', reasoningEffort: 'medium', receivedPath: request.params?.path, thread: { id: request.params?.threadId, modelProvider: 'native-package-provider' } }",
    "          : {};",
    "    process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');",
    "  });",
    "}",
    "",
  ].join("\n");
  await writeFile(resolve(directory, sourceFilename), source, { encoding: "utf8", flag: "wx" });
  await writeFile(
    resolve(directory, configFilename),
    `${JSON.stringify(
      {
        disableExperimentalSEAWarning: true,
        main: sourceFilename,
        output: blobFilename,
        useCodeCache: false,
      },
      undefined,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  runChecked(process.execPath, ["--experimental-sea-config", configFilename], directory);
  await copyFile(process.execPath, executablePath);
  const postjectCli = fileURLToPath(new URL("cli.js", import.meta.resolve("postject")));
  runChecked(
    process.execPath,
    [
      postjectCli,
      executablePath,
      "NODE_SEA_BLOB",
      resolve(directory, blobFilename),
      "--sentinel-fuse",
      SEA_FUSE,
    ],
    directory,
  );
  return executablePath;
}

function createFacadeSmokeEnvironment(fakeCodexDirectory) {
  const environment = {
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_vscode",
    PATH: fakeCodexDirectory,
    RUST_LOG: "warn",
  };
  for (const name of ["SystemRoot", "WINDIR"]) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

function assertAppServerResponse(message, expectedId) {
  if (
    message === null ||
    typeof message !== "object" ||
    message.id !== expectedId ||
    message.result === null ||
    typeof message.result !== "object" ||
    Array.isArray(message.result)
  ) {
    throw new Error("The packaged facade returned an unexpected app-server response.");
  }
  return message.result;
}

async function smokePackagedRelay(hostPath, helperPath) {
  const isolatedWorkingDirectory = await mkdtemp(join(tmpdir(), "gptsb-package-smoke-"));
  const server = spawn(helperPath, ["server"], childOptions(isolatedWorkingDirectory));
  const serverStatus = new LineReader(server.stderr);
  const serverFrames = new FrameReader(server.stdout);
  let host;

  try {
    await serverStatus.readExpected("ipc_listening");
    host = spawn(
      hostPath,
      [DEVELOPMENT_EXTENSION_ORIGIN, "--parent-window=0"],
      childOptions(isolatedWorkingDirectory),
    );
    const hostFrames = new FrameReader(host.stdout);
    const hostDiagnostics = collectBounded(host.stderr);

    writeFrame(host.stdin, hello("extension", "extension-hello"));
    assertFrame(await hostFrames.read(), {
      peer: "nativeHost",
      requestId: "extension-hello",
      sequence: 0,
      type: "hello/acknowledged",
    });

    await serverStatus.readExpected("ipc_connected");
    writeFrame(server.stdin, hello("bridge", "bridge-hello"));
    assertFrame(await serverFrames.read(), {
      peer: "nativeHost",
      requestId: "bridge-hello",
      sequence: 0,
      type: "hello/acknowledged",
    });

    writeFrame(server.stdin, {
      payload: { sessionId: "package-smoke-session" },
      protocolVersion: PROTOCOL_VERSION,
      requestId: "package-smoke-connect",
      sequence: 1,
      type: "session/connect",
    });
    assertFrame(await hostFrames.read(), {
      requestId: "package-smoke-connect",
      sequence: 1,
      sessionId: "package-smoke-session",
      type: "session/connect",
    });

    writeFrame(host.stdin, {
      payload: { sessionId: "package-smoke-session" },
      protocolVersion: PROTOCOL_VERSION,
      requestId: "package-smoke-connect",
      sequence: 1,
      type: "session/connected",
    });
    assertFrame(await serverFrames.read(), {
      requestId: "package-smoke-connect",
      sequence: 1,
      sessionId: "package-smoke-session",
      type: "session/connected",
    });

    host.stdin.end();
    const hostExit = await waitForExit(host);
    if (hostExit.code !== 0 || hostExit.signal !== null) {
      throw new Error("The packaged Native Host did not exit cleanly.");
    }
    const diagnostics = await hostDiagnostics;
    if (diagnostics.exceeded || diagnostics.bytes.byteLength !== 0) {
      throw new Error("The packaged Native Host emitted unexpected diagnostics.");
    }
  } finally {
    server.stdin.end();
    await Promise.all([stopChild(host), stopChild(server)]);
    await rm(isolatedWorkingDirectory, { force: true, recursive: true });
  }
}

function hello(peer, requestId) {
  return {
    payload: {
      implementationVersion: "package-smoke-v1",
      peer,
      supportedProtocolVersions: [PROTOCOL_VERSION],
    },
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    sequence: 0,
    type: "hello",
  };
}

function assertFrame(frame, expected) {
  if (
    frame.protocolVersion !== PROTOCOL_VERSION ||
    frame.requestId !== expected.requestId ||
    frame.sequence !== expected.sequence ||
    frame.type !== expected.type ||
    (expected.peer !== undefined && frame.payload?.peer !== expected.peer) ||
    (expected.sessionId !== undefined && frame.payload?.sessionId !== expected.sessionId)
  ) {
    throw new Error("The packaged relay returned an unexpected frame.");
  }
}

function childOptions(cwd) {
  return {
    cwd,
    env: {},
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
}

function writeJsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function runChecked(executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("A Windows package smoke fixture could not be created.");
  }
}

function writeFrame(stream, value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.byteLength, 0);
  stream.write(Buffer.concat([header, payload]));
}

function waitForExit(child) {
  return withTimeout(
    new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    }),
  );
}

function collectBounded(stream) {
  return new Promise((resolveBytes, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;
    stream.on("data", (chunk) => {
      if (exceeded) {
        return;
      }
      size += chunk.byteLength;
      if (size > MAX_DIAGNOSTIC_BYTES) {
        exceeded = true;
        chunks.length = 0;
        size = 0;
        return;
      }
      chunks.push(chunk);
    });
    stream.once("error", reject);
    stream.once("end", () => resolveBytes({ bytes: Buffer.concat(chunks, size), exceeded }));
  });
}

async function stopChild(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const closed = new Promise((resolveClose, reject) => {
    child.once("error", reject);
    child.once("close", resolveClose);
  });
  child.kill();
  await withTimeout(closed);
}

class JsonLineReader {
  #buffer = "";
  #ended = false;
  #lines = [];
  #receivedBytes = 0;
  #waiters = [];

  constructor(stream) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      this.#receivedBytes += Buffer.byteLength(chunk, "utf8");
      if (this.#receivedBytes > MAX_APP_SERVER_OUTPUT_BYTES) {
        this.#rejectAll(new Error("The packaged facade exceeded its output limit."));
        return;
      }
      this.#buffer += chunk;
      let newline = this.#buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.#buffer.slice(0, newline).replace(/\r$/u, "");
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.length > 0) {
          this.#lines.push(line);
        }
        newline = this.#buffer.indexOf("\n");
      }
      this.#drain();
    });
    stream.once("end", () => {
      this.#ended = true;
      this.#drain();
    });
    stream.once("error", (error) => this.#rejectAll(error));
  }

  read() {
    return withTimeout(
      new Promise((resolveLine, reject) => {
        this.#waiters.push({ reject, resolve: resolveLine });
        this.#drain();
      }),
    );
  }

  #drain() {
    while (this.#lines.length > 0 && this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      const line = this.#lines.shift();
      try {
        waiter.resolve(JSON.parse(line));
      } catch {
        waiter.reject(new Error("The packaged facade emitted invalid JSON."));
      }
    }
    if (this.#ended && this.#waiters.length > 0) {
      this.#rejectAll(new Error("The packaged facade closed before responding."));
    }
  }

  #rejectAll(error) {
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }
}

class FrameReader {
  #buffer = Buffer.alloc(0);
  #ended = false;
  #waiters = [];

  constructor(stream) {
    stream.on("data", (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#drain();
    });
    stream.once("end", () => {
      this.#ended = true;
      this.#drain();
    });
    stream.once("error", (error) => this.#rejectAll(error));
  }

  read() {
    return withTimeout(
      new Promise((resolveFrame, reject) => {
        this.#waiters.push({ reject, resolve: resolveFrame });
        this.#drain();
      }),
    );
  }

  #drain() {
    while (this.#waiters.length > 0 && this.#buffer.byteLength >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length === 0 || length > 1024 * 1024) {
        this.#rejectAll(new Error("A child process emitted an invalid frame length."));
        return;
      }
      if (this.#buffer.byteLength < length + 4) {
        return;
      }
      const payload = this.#buffer.subarray(4, length + 4);
      this.#buffer = Buffer.from(this.#buffer.subarray(length + 4));
      const waiter = this.#waiters.shift();
      try {
        waiter.resolve(JSON.parse(payload.toString("utf8")));
      } catch {
        waiter.reject(new Error("A child process emitted invalid JSON."));
      }
    }
    if (this.#ended && this.#waiters.length > 0) {
      this.#rejectAll(new Error("A child process closed before emitting a frame."));
    }
  }

  #rejectAll(error) {
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }
}

class LineReader {
  #buffer = "";
  #lines = [];
  #waiters = [];

  constructor(stream) {
    stream.setEncoding("ascii");
    stream.on("data", (chunk) => {
      this.#buffer += chunk;
      if (this.#buffer.length > MAX_DIAGNOSTIC_BYTES) {
        this.#rejectAll(new Error("A child process exceeded its status limit."));
        return;
      }
      let newline = this.#buffer.indexOf("\n");
      while (newline >= 0) {
        this.#lines.push(this.#buffer.slice(0, newline).replace(/\r$/u, ""));
        this.#buffer = this.#buffer.slice(newline + 1);
        newline = this.#buffer.indexOf("\n");
      }
      this.#drain();
    });
    stream.once("error", (error) => this.#rejectAll(error));
  }

  async readExpected(expected) {
    const actual = await withTimeout(
      new Promise((resolveLine, reject) => {
        this.#waiters.push({ reject, resolve: resolveLine });
        this.#drain();
      }),
    );
    if (actual !== expected) {
      throw new Error("A child process emitted an unexpected status code.");
    }
  }

  #drain() {
    while (this.#lines.length > 0 && this.#waiters.length > 0) {
      this.#waiters.shift().resolve(this.#lines.shift());
    }
  }

  #rejectAll(error) {
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }
}

function withTimeout(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("A Windows package smoke test timed out.")),
        FRAME_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

await smokePackagedFacade(facadeExecutable);
await smokePackagedRelay(hostExecutable, helperExecutable);
process.stdout.write(`Verified Windows x64 package ${verified.packageDigest.slice(0, 12)}.\n`);
