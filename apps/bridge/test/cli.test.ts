import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { appServerEnvelopeSchema, type AppServerEnvelope } from "@gpt-session-bridge/protocol";
import { describe, expect, it } from "vitest";

import { isAppServerInvocation, runAppServerFacade, runCli } from "../src/cli.js";
import { BRIDGE_ACTIVE_ENV, BRIDGE_ACTIVE_VALUE, CODEX_EXECUTABLE_ENV } from "../src/constants.js";
import type { BrowserIpcRuntime } from "../src/runtime/browser-ipc-runtime.js";

const FAKE_APP_SERVER = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url),
);
const TOML_LINE_CONTINUATION = String.fromCodePoint(0x5c, 0x0a);

describe("CLI command routing", () => {
  it("recognizes only the top-level app-server subcommand", () => {
    expect(isAppServerInvocation(["-c", "features.example=true", "app-server"])).toBe(true);
    expect(isAppServerInvocation(["-cfeatures.example=true", "app-server"])).toBe(true);
    expect(isAppServerInvocation(["-mnative-model", "app-server"])).toBe(true);
    expect(isAppServerInvocation(["--config=features.example=true", "app-server"])).toBe(true);
    expect(isAppServerInvocation(["exec", "--", "app-server"])).toBe(false);
    expect(isAppServerInvocation(["--remote", "app-server", "exec"])).toBe(false);
    expect(isAppServerInvocation(["--", "app-server"])).toBe(false);
    expect(isAppServerInvocation(["-i", "app-server"])).toBe(false);
    expect(isAppServerInvocation(["app-server", "--listen", "stdio://"])).toBe(true);
    expect(isAppServerInvocation(["app-server", "-cfeatures.example=true"])).toBe(true);
    expect(isAppServerInvocation(["app-server", "--listen=ws://127.0.0.1:45000"])).toBe(false);
    expect(isAppServerInvocation(["app-server", "generate-json-schema"])).toBe(false);
    expect(isAppServerInvocation(["app-server", "daemon", "start"])).toBe(false);
    expect(isAppServerInvocation(["app-server", "--help"])).toBe(false);
    expect(isAppServerInvocation(["--help", "app-server"])).toBe(false);
    expect(isAppServerInvocation(["-h", "app-server"])).toBe(false);
    expect(isAppServerInvocation(["--version", "app-server"])).toBe(false);
    expect(isAppServerInvocation(["-V", "app-server"])).toBe(false);
  });

  it.each([
    [[], false],
    [["--strict-config", "app-server"], true],
    [["--config"], false],
    [["--unknown", "app-server"], false],
    [["exec"], false],
    [["--add-dir", "synthetic-dir", "app-server"], true],
    [["app-server", "--strict-config"], true],
    [["app-server", "--"], false],
    [["app-server", "--listen"], false],
    [["app-server", "--config", "features.example=true"], true],
    [["app-server", "--config=features.example=true"], true],
    [["app-server", "--unknown"], false],
    [["app-server", "--stdio", "--listen", "off"], false],
    [["app-server", "--listen", "off", "--stdio"], true],
    [["app-server", "-h"], false],
  ] as const)("classifies %j as %s", (args, expected) => {
    expect(isAppServerInvocation(args)).toBe(expected);
  });

  it("fails closed when a bridge child recursively invokes the wrapper", async () => {
    await expect(
      runCli([], {
        env: { [BRIDGE_ACTIVE_ENV]: BRIDGE_ACTIVE_VALUE },
        registerSignalHandlers: false,
      }),
    ).rejects.toMatchObject({ code: "already_active" });
    await expect(
      runCli([], {
        env: { gptsessionbridge_active: BRIDGE_ACTIVE_VALUE },
        registerSignalHandlers: false,
      }),
    ).rejects.toMatchObject({ code: "already_active" });
  });

  it("passes non-app-server commands through with bridge controls sanitized", async () => {
    const code = [
      `const active = process.env.${BRIDGE_ACTIVE_ENV} === ${JSON.stringify(BRIDGE_ACTIVE_VALUE)};`,
      `const overrideRemoved = process.env.${CODEX_EXECUTABLE_ENV} === undefined;`,
      "process.exit(active && overrideRemoved ? 0 : 9);",
    ].join(" ");
    await expect(
      runCli(["-e", code], {
        env: minimalChildEnvironment(),
        registerSignalHandlers: false,
      }),
    ).resolves.toBe(0);
  });

  it.each([
    [["--model", "gptsessionbridge/web/example-model", "app-server"]],
    [["--model=gptsessionbridge/web/example-model", "app-server"]],
    [["-mgptsessionbridge/web/example-model", "app-server"]],
    [["-c", 'model_provider="gptsessionbridge_web"', "app-server"]],
    [["--config=model='gptsessionbridge/web/example-model'", "app-server"]],
    [["app-server", '-cmodel_provider="gptsessionbridge\\u005fweb"']],
    [["-c", `model_provider="""gptsessionbridge_${TOML_LINE_CONTINUATION}  web"""`, "app-server"]],
    [
      [
        "app-server",
        "-c",
        `model="""gptsessionbridge/${TOML_LINE_CONTINUATION}  web/example-model"""`,
      ],
    ],
    [["app-server", "--config", "model_providers.gptsessionbridge_web.base_url='x'"]],
  ] as const)("rejects reserved app-server overrides in %j", async (args) => {
    await expect(
      runAppServerFacade({
        args,
        clientInput: new PassThrough(),
        clientOutput: new PassThrough(),
        env: minimalChildEnvironment(),
        executable: process.execPath,
        registerSignalHandlers: false,
      }),
    ).rejects.toMatchObject({ code: "reserved_override" });
  });
});

describe("app-server facade runtime", () => {
  it("merges the catalog and keeps the provider capability out of the child environment", async () => {
    const clientInput = new PassThrough();
    const clientOutput = new PassThrough();
    const outputFrames = readFrames(clientOutput, 3);
    const browserIpc = new FakeBrowserIpcRuntime();
    const completion = runAppServerFacade({
      args: [FAKE_APP_SERVER, "app-server"],
      browserIpc,
      clientInput,
      clientOutput,
      env: minimalChildEnvironment(),
      executable: process.execPath,
      registerSignalHandlers: false,
    });

    clientInput.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
    clientInput.write(`${JSON.stringify({ id: 2, method: "model/list", params: {} })}\n`);
    clientInput.write(
      `${JSON.stringify({
        id: 3,
        method: "thread/start",
        params: { model: "gptsessionbridge/web/example-model" },
      })}\n`,
    );

    const frames = await outputFrames;
    const modelResult = readResult(frames[1]);
    const modelData = modelResult["data"] as { id: string }[];
    expect(modelData.map((model) => model.id)).toEqual([
      "native-model",
      "gptsessionbridge/web/example-model",
    ]);
    expect(readResult(frames[2])).toMatchObject({
      capabilityInEnvironment: false,
      loopbackProxyBypassConfigured: true,
      preexistingProxyBypassPreserved: true,
      providerConfigured: true,
      proxyRespectDisabled: true,
      thread: { id: "synthetic-thread" },
      unexpectedBridgeControlEnvironment: false,
    });
    expect(JSON.stringify(frames)).not.toContain("gsb_");

    clientInput.end();
    await expect(completion).resolves.toBe(0);
    expect(browserIpc.startCount).toBe(1);
    expect(browserIpc.closeCount).toBe(1);
  });

  it("returns a child exit code when the app-server process exits first", async () => {
    const clientInput = new PassThrough();
    const clientOutput = new PassThrough();
    await expect(
      runAppServerFacade({
        args: ["-e", "process.exit(7)"],
        clientInput,
        clientOutput,
        env: minimalChildEnvironment(),
        executable: process.execPath,
        registerSignalHandlers: false,
      }),
    ).resolves.toBe(7);
  });

  it("keeps native Codex available and releases browser IPC when broker startup fails", async () => {
    const browserIpc = new FakeBrowserIpcRuntime();
    browserIpc.startError = new Error("synthetic browser IPC startup failure");
    const clientInput = new PassThrough();
    const completion = runAppServerFacade({
      args: [FAKE_APP_SERVER, "app-server"],
      browserIpc,
      clientInput,
      clientOutput: new PassThrough(),
      env: minimalChildEnvironment(),
      executable: process.execPath,
      registerSignalHandlers: false,
    });
    clientInput.end();

    await expect(completion).resolves.toBe(0);
    expect(browserIpc.closeCount).toBe(1);
  });

  it("keeps native Codex available when an active browser IPC broker fails", async () => {
    const browserIpc = new FakeBrowserIpcRuntime();
    const clientInput = new PassThrough();
    const completion = runAppServerFacade({
      args: [FAKE_APP_SERVER, "app-server"],
      browserIpc,
      clientInput,
      clientOutput: new PassThrough(),
      env: minimalChildEnvironment(),
      executable: process.execPath,
      registerSignalHandlers: false,
    });
    await browserIpc.started;
    browserIpc.fail();
    clientInput.end();

    await expect(completion).resolves.toBe(0);
    expect(browserIpc.closeCount).toBe(1);
  });
});

class FakeBrowserIpcRuntime implements BrowserIpcRuntime {
  public closeCount = 0;
  public startCount = 0;
  public startError: Error | undefined;
  public readonly completion: Promise<void>;
  public readonly started: Promise<void>;
  readonly #rejectCompletion: (error: Error) => void;
  readonly #resolveCompletion: () => void;
  readonly #resolveStarted: () => void;
  #closed = false;

  public constructor() {
    let rejectCompletion: ((error: Error) => void) | undefined;
    let resolveCompletion: (() => void) | undefined;
    let resolveStarted: (() => void) | undefined;
    this.completion = new Promise<void>((resolve, reject) => {
      rejectCompletion = reject;
      resolveCompletion = resolve;
    });
    void this.completion.catch(() => undefined);
    this.started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    this.#rejectCompletion = (error) => {
      rejectCompletion?.(error);
    };
    this.#resolveCompletion = () => {
      resolveCompletion?.();
    };
    this.#resolveStarted = () => {
      resolveStarted?.();
    };
  }

  public close(): Promise<void> {
    if (this.#closed) {
      return Promise.resolve();
    }
    this.#closed = true;
    this.closeCount += 1;
    this.#resolveCompletion();
    return Promise.resolve();
  }

  public fail(): void {
    this.#rejectCompletion(new Error("synthetic browser IPC failure"));
  }

  public start(): Promise<void> {
    this.startCount += 1;
    this.#resolveStarted();
    return this.startError === undefined ? Promise.resolve() : Promise.reject(this.startError);
  }
}

function minimalChildEnvironment(): Readonly<NodeJS.ProcessEnv> {
  const path = process.env["PATH"];
  const systemRoot = process.env["SystemRoot"];
  return {
    ...(path === undefined ? {} : { PATH: path }),
    ...(systemRoot === undefined ? {} : { SystemRoot: systemRoot }),
    GpTsEsSiOnBrIdGe_MiXeD_CoNtRoL: "remove-me",
    No_Proxy: "corp.example",
    [CODEX_EXECUTABLE_ENV]: process.execPath,
  };
}

function readFrames(stream: PassThrough, count: number): Promise<AppServerEnvelope[]> {
  return new Promise((resolve, reject) => {
    const frames: AppServerEnvelope[] = [];
    let buffered = "";
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      while (frames.length < count) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) {
          return;
        }
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const parsed: unknown = JSON.parse(line);
          frames.push(appServerEnvelopeSchema.parse(parsed));
        } catch (error) {
          cleanup();
          reject(error instanceof Error ? error : new Error("Invalid output frame"));
          return;
        }
      }
      cleanup();
      resolve(frames);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("error", onError);
    };
    stream.on("data", onData);
    stream.once("error", onError);
  });
}

function readResult(envelope: AppServerEnvelope | undefined): Record<string, unknown> {
  if (envelope === undefined || !("result" in envelope)) {
    throw new TypeError("Expected success response");
  }
  return envelope.result as Record<string, unknown>;
}
