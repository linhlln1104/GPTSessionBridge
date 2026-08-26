import {
  NATIVE_MESSAGING_PROTOCOL_VERSION,
  nativeMessagingFrameSchema,
  type NativeMessagingFrame,
} from "@gpt-session-bridge/protocol";
import { describe, expect, it } from "vitest";

import type {
  ChromeApi,
  ChromeInjectionResult,
  ChromeMessageSender,
  ChromePort,
  ChromeTab,
} from "../src/platform/chrome-api.js";
import { BrowserTabSession } from "../src/session/browser-tab-session.js";

describe("BrowserTabSession", () => {
  it("connects only the injected document and relays a dynamic Web catalog", async () => {
    const harness = new ChromeHarness();
    const session = harness.createSession();

    await expect(session.connect()).resolves.toBe(true);
    expect(session.status).toEqual({ reason: "none", state: "connecting" });
    expect(harness.injection).toEqual({
      files: ["content/content-script.js"],
      target: { frameIds: [0], tabId: 7 },
      world: "ISOLATED",
    });
    expect(harness.tabConnection).toEqual({
      options: { documentId: "document-1", name: "gptsessionbridge-page-v1" },
      tabId: 7,
    });
    expect(harness.pagePort.sent).toEqual([
      { protocolVersion: 1, sequence: 0, type: "page/probe" },
    ]);

    harness.pagePort.emitMessage({
      adapter: "chatgpt-dom-v1",
      protocolVersion: 1,
      sequence: 0,
      type: "page/ready",
    });
    expect(harness.nativeApplication).toBe("com.gptsessionbridge.native_host.dev");
    expect(harness.nativeFrame(0)).toMatchObject({
      sequence: 0,
      type: "hello",
      payload: { peer: "extension" },
    });

    harness.nativePort.emitMessage(helloAcknowledgedFrame());
    expect(session.status).toEqual({ reason: "none", state: "connected" });

    harness.nativePort.emitMessage(
      applicationFrame(1, "session/connect", { sessionId: "session-1" }),
    );
    expect(harness.nativeFrame(1)).toMatchObject({
      sequence: 1,
      type: "session/connected",
      payload: { sessionId: "session-1" },
    });

    harness.nativePort.emitMessage(
      applicationFrame(2, "capabilities/read", { sessionId: "session-1" }),
    );
    expect(harness.pagePort.sent[1]).toEqual({
      protocolVersion: 1,
      requestId: "incoming-2",
      sequence: 1,
      type: "page/catalog/read",
    });
    harness.pagePort.emitMessage(pageCatalogResult(1, "incoming-2"));
    expect(harness.nativeFrame(2)).toMatchObject({
      sequence: 2,
      type: "capabilities/result",
      payload: {
        capabilities: {
          cancellation: true,
          imageInput: false,
          modelDiscovery: true,
          models: [webModel()],
          streaming: true,
          temporaryChat: false,
          toolCalls: false,
        },
        sessionId: "session-1",
      },
    });
  });

  it("relays one text-only streaming turn from the selected page", async () => {
    const harness = new ChromeHarness();
    const session = harness.createSession();
    await harness.connectAndHandshake(session);
    harness.nativePort.emitMessage(
      applicationFrame(1, "session/connect", { sessionId: "session-1" }),
    );
    harness.nativePort.emitMessage(
      applicationFrame(2, "capabilities/read", { sessionId: "session-1" }),
    );
    harness.pagePort.emitMessage(pageCatalogResult(1, "incoming-2"));
    harness.nativePort.emitMessage(
      applicationFrame(3, "turn/start", {
        catalogRevision: catalogRevision(),
        input: [{ text: "hello", type: "text" }],
        modelId: webModel().id,
        reasoningEffort: "medium",
        sessionId: "session-1",
        temporary: false,
        turnId: "turn-1",
      }),
    );

    expect(harness.pagePort.sent[2]).toMatchObject({
      protocolVersion: 1,
      requestId: "incoming-3",
      sequence: 2,
      turnId: "turn-1",
      type: "page/turn/start",
    });
    harness.pagePort.emitMessage({
      protocolVersion: 1,
      requestId: "incoming-3",
      sequence: 2,
      turnId: "turn-1",
      type: "page/turn/started",
    });
    harness.pagePort.emitMessage({
      delta: "hello from Web",
      protocolVersion: 1,
      sequence: 3,
      turnId: "turn-1",
      type: "page/turn/delta",
    });
    harness.pagePort.emitMessage({
      protocolVersion: 1,
      sequence: 4,
      turnId: "turn-1",
      type: "page/turn/completed",
    });

    expect(harness.nativeFrame(3)).toMatchObject({
      type: "turn/started",
      payload: { sessionId: "session-1", turnId: "turn-1" },
    });
    expect(harness.nativeFrame(4)).toMatchObject({
      type: "turn/delta",
      payload: {
        channel: "outputText",
        delta: "hello from Web",
        sessionId: "session-1",
        turnId: "turn-1",
      },
    });
    expect(harness.nativeFrame(5)).toMatchObject({
      type: "turn/completed",
      payload: { finishReason: "stop", sessionId: "session-1", turnId: "turn-1" },
    });
  });

  it("relays catalog changes observed from the visible picker", async () => {
    const harness = new ChromeHarness();
    const session = harness.createSession();
    await harness.connectAndHandshake(session);
    harness.nativePort.emitMessage(
      applicationFrame(1, "session/connect", { sessionId: "session-1" }),
    );
    harness.nativePort.emitMessage(
      applicationFrame(2, "capabilities/read", { sessionId: "session-1" }),
    );
    harness.pagePort.emitMessage(pageCatalogResult(1, "incoming-2"));
    harness.pagePort.emitMessage({
      catalogRevision: `web-ui-${"c".repeat(64)}`,
      models: [{ ...webModel(), displayName: "New Web Model" }],
      protocolVersion: 1,
      sequence: 2,
      type: "page/catalog/changed",
    });

    expect(harness.nativeFrame(3)).toMatchObject({
      requestId: "request-2",
      type: "capabilities/changed",
      payload: {
        capabilities: {
          catalogRevision: `web-ui-${"c".repeat(64)}`,
          models: [{ displayName: "New Web Model" }],
        },
        sessionId: "session-1",
      },
    });
  });

  it("ignores a valid catalog observation before a native session is connected", async () => {
    const harness = new ChromeHarness();
    const session = harness.createSession();
    await harness.connectAndHandshake(session);
    harness.pagePort.emitMessage({
      catalogRevision: `web-ui-${"c".repeat(64)}`,
      models: [webModel()],
      protocolVersion: 1,
      sequence: 1,
      type: "page/catalog/changed",
    });

    expect(session.status).toEqual({ reason: "none", state: "connected" });
    expect(harness.nativePort.sent).toHaveLength(1);
    harness.nativePort.emitMessage(
      applicationFrame(1, "session/connect", { sessionId: "session-1" }),
    );
    expect(harness.nativeFrame(1)).toMatchObject({
      type: "session/connected",
      payload: { sessionId: "session-1" },
    });
  });

  it("drains a stale catalog result after reconnect before allowing another read", async () => {
    const harness = new ChromeHarness();
    const session = harness.createSession();
    await harness.connectAndHandshake(session);
    harness.nativePort.emitMessage(
      applicationFrame(1, "session/connect", { sessionId: "session-1" }),
    );
    harness.nativePort.emitMessage(
      applicationFrame(2, "capabilities/read", { sessionId: "session-1" }),
    );
    harness.nativePort.emitMessage(
      applicationFrame(3, "session/disconnect", { sessionId: "session-1" }),
    );
    expect(harness.nativeFrame(2)).toMatchObject({
      type: "session/disconnected",
      payload: { reason: "shutdown", sessionId: "session-1" },
    });
    harness.nativePort.emitMessage(
      applicationFrame(4, "session/connect", { sessionId: "session-2" }),
    );
    harness.nativePort.emitMessage(
      applicationFrame(5, "capabilities/read", { sessionId: "session-2" }),
    );
    expect(harness.nativeFrame(4)).toMatchObject({
      requestId: "incoming-5",
      type: "error",
      payload: { error: { code: "browser.unavailable" } },
    });
    expect(harness.pagePort.sent).toHaveLength(2);

    harness.pagePort.emitMessage(pageCatalogResult(1, "incoming-2"));
    expect(session.status).toEqual({ reason: "none", state: "connected" });
    expect(harness.nativePort.sent).toHaveLength(5);

    harness.nativePort.emitMessage(
      applicationFrame(6, "capabilities/read", { sessionId: "session-2" }),
    );
    expect(harness.pagePort.sent[2]).toMatchObject({
      requestId: "incoming-6",
      sequence: 2,
      type: "page/catalog/read",
    });
  });

  it("drains stale turn events after reconnect without attaching them to a new session", async () => {
    const harness = new ChromeHarness();
    const session = harness.createSession();
    await harness.connectAndHandshake(session);
    harness.nativePort.emitMessage(
      applicationFrame(1, "session/connect", { sessionId: "session-1" }),
    );
    harness.nativePort.emitMessage(applicationFrame(2, "turn/start", turnPayload("turn-old")));
    harness.nativePort.emitMessage(
      applicationFrame(3, "session/disconnect", { sessionId: "session-1" }),
    );
    harness.nativePort.emitMessage(
      applicationFrame(4, "session/connect", { sessionId: "session-2" }),
    );
    harness.nativePort.emitMessage(
      applicationFrame(5, "turn/start", {
        ...turnPayload("turn-new"),
        sessionId: "session-2",
      }),
    );

    expect(harness.nativeFrame(4)).toMatchObject({
      requestId: "incoming-5",
      type: "turn/failed",
      payload: { error: { code: "browser.unavailable" }, turnId: "turn-new" },
    });
    expect(harness.pagePort.sent).toHaveLength(2);

    harness.pagePort.emitMessage({
      protocolVersion: 1,
      requestId: "incoming-2",
      sequence: 1,
      turnId: "turn-old",
      type: "page/turn/started",
    });
    harness.pagePort.emitMessage({
      protocolVersion: 1,
      sequence: 2,
      turnId: "turn-old",
      type: "page/turn/completed",
    });
    expect(session.status).toEqual({ reason: "none", state: "connected" });
    expect(harness.nativePort.sent).toHaveLength(5);

    harness.nativePort.emitMessage(
      applicationFrame(6, "turn/start", {
        ...turnPayload("turn-new"),
        sessionId: "session-2",
      }),
    );
    expect(harness.pagePort.sent[2]).toMatchObject({
      requestId: "incoming-6",
      sequence: 2,
      turnId: "turn-new",
      type: "page/turn/start",
    });
  });

  it("correlates a confirmed page cancellation", async () => {
    const harness = new ChromeHarness();
    const session = harness.createSession();
    await harness.connectAndHandshake(session);
    harness.nativePort.emitMessage(
      applicationFrame(1, "session/connect", { sessionId: "session-1" }),
    );
    harness.nativePort.emitMessage(applicationFrame(2, "turn/start", turnPayload("turn-1")));
    harness.pagePort.emitMessage({
      protocolVersion: 1,
      requestId: "incoming-2",
      sequence: 1,
      turnId: "turn-1",
      type: "page/turn/started",
    });
    harness.nativePort.emitMessage(
      applicationFrame(3, "turn/cancel", { sessionId: "session-1", turnId: "turn-1" }),
    );
    expect(harness.pagePort.sent[2]).toMatchObject({
      requestId: "incoming-3",
      sequence: 2,
      turnId: "turn-1",
      type: "page/turn/cancel",
    });
    harness.pagePort.emitMessage({
      protocolVersion: 1,
      requestId: "incoming-3",
      sequence: 2,
      turnId: "turn-1",
      type: "page/turn/cancelled",
    });

    expect(harness.nativeFrame(3)).toMatchObject({
      requestId: "incoming-3",
      type: "turn/cancelled",
      payload: { sessionId: "session-1", turnId: "turn-1" },
    });
  });

  it("maps bounded page failures without leaking page diagnostics", async () => {
    const harness = new ChromeHarness();
    const session = harness.createSession();
    await harness.connectAndHandshake(session);
    harness.nativePort.emitMessage(
      applicationFrame(1, "session/connect", { sessionId: "session-1" }),
    );
    harness.nativePort.emitMessage(
      applicationFrame(2, "capabilities/read", { sessionId: "session-1" }),
    );
    harness.pagePort.emitMessage({
      code: "adapter_unavailable",
      message: "A verified ChatGPT Web model picker is unavailable.",
      protocolVersion: 1,
      requestId: "incoming-2",
      retryable: true,
      sequence: 1,
      type: "page/command/failed",
    });

    expect(harness.nativeFrame(2)).toMatchObject({
      requestId: "incoming-2",
      type: "error",
      payload: { error: { code: "browser.unavailable", retryable: true } },
    });
  });

  it("rejects temporary Web turns before touching the page", async () => {
    const harness = new ChromeHarness();
    const session = harness.createSession();
    await harness.connectAndHandshake(session);
    harness.nativePort.emitMessage(
      applicationFrame(1, "session/connect", { sessionId: "session-1" }),
    );
    harness.nativePort.emitMessage(
      applicationFrame(2, "turn/start", { ...turnPayload("turn-1"), temporary: true }),
    );

    expect(harness.nativeFrame(2)).toMatchObject({
      type: "turn/failed",
      payload: { error: { code: "capability.unsupported" }, turnId: "turn-1" },
    });
    expect(harness.pagePort.sent).toHaveLength(1);
  });

  it("rejects multiple text items before touching the selected page", async () => {
    const harness = new ChromeHarness();
    const session = harness.createSession();
    await harness.connectAndHandshake(session);
    harness.nativePort.emitMessage(
      applicationFrame(1, "session/connect", { sessionId: "session-1" }),
    );
    const payload = turnPayload("turn-1");
    harness.nativePort.emitMessage(
      applicationFrame(2, "turn/start", {
        ...payload,
        input: [
          { text: "first", type: "text" },
          { text: "second", type: "text" },
        ],
      }),
    );

    expect(harness.nativeFrame(2)).toMatchObject({
      type: "turn/failed",
      payload: { error: { code: "capability.unsupported" }, turnId: "turn-1" },
    });
    expect(harness.pagePort.sent).toHaveLength(1);
  });

  it("does not run model discovery concurrently with an active page turn", async () => {
    const harness = new ChromeHarness();
    const session = harness.createSession();
    await harness.connectAndHandshake(session);
    harness.nativePort.emitMessage(
      applicationFrame(1, "session/connect", { sessionId: "session-1" }),
    );
    harness.nativePort.emitMessage(applicationFrame(2, "turn/start", turnPayload("turn-1")));
    harness.nativePort.emitMessage(
      applicationFrame(3, "capabilities/read", { sessionId: "session-1" }),
    );

    expect(harness.nativeFrame(2)).toMatchObject({
      requestId: "incoming-3",
      type: "error",
      payload: { error: { code: "browser.unavailable" } },
    });
    expect(harness.pagePort.sent).toHaveLength(2);
  });

  it("rejects unsupported pages before injecting a content script", async () => {
    const harness = new ChromeHarness();
    harness.tabs = [{ active: true, id: 7, url: "https://example.com/", windowId: 4 }];
    const session = harness.createSession();

    await expect(session.connect()).resolves.toBe(false);
    expect(session.status).toEqual({ reason: "unsupported_page", state: "error" });
    expect(harness.injection).toBeUndefined();
    expect(harness.nativeApplication).toBeUndefined();
  });

  it("closes both ports on an invalid page message", async () => {
    const harness = new ChromeHarness();
    const session = harness.createSession();
    await session.connect();
    harness.pagePort.emitMessage({ type: "page/ready" });

    expect(session.status).toEqual({ reason: "protocol_error", state: "error" });
    expect(harness.pagePort.disconnected).toBe(true);
    expect(harness.nativeApplication).toBeUndefined();
  });

  it("sends a terminal session event when the user disconnects", async () => {
    const harness = new ChromeHarness();
    const session = harness.createSession();
    await harness.connectAndHandshake(session);
    harness.nativePort.emitMessage(
      applicationFrame(1, "session/connect", { sessionId: "session-1" }),
    );

    session.disconnect();

    expect(harness.nativeFrame(2)).toMatchObject({
      type: "session/disconnected",
      payload: { reason: "user", sessionId: "session-1" },
    });
    expect(harness.nativePort.disconnected).toBe(true);
    expect(harness.pagePort.disconnected).toBe(true);
    expect(session.status).toEqual({ reason: "none", state: "idle" });
  });

  it("fails closed on native sequence violations", async () => {
    const harness = new ChromeHarness();
    const session = harness.createSession();
    await harness.connectAndHandshake(session);
    harness.nativePort.emitMessage(
      applicationFrame(5, "session/connect", { sessionId: "session-1" }),
    );

    expect(session.status).toEqual({ reason: "protocol_error", state: "error" });
    expect(harness.nativePort.disconnected).toBe(true);
    expect(harness.pagePort.disconnected).toBe(true);
  });

  it("terminates when either selected document transport is lost", async () => {
    const pageHarness = new ChromeHarness();
    const pageSession = pageHarness.createSession();
    await pageHarness.connectAndHandshake(pageSession);
    pageHarness.pagePort.onDisconnect.emit();
    expect(pageSession.status).toEqual({ reason: "page_unavailable", state: "error" });
    expect(pageHarness.nativePort.disconnected).toBe(true);

    const nativeHarness = new ChromeHarness();
    const nativeSession = nativeHarness.createSession();
    await nativeHarness.connectAndHandshake(nativeSession);
    nativeHarness.nativePort.onDisconnect.emit();
    expect(nativeSession.status).toEqual({ reason: "native_unavailable", state: "error" });
    expect(nativeHarness.pagePort.disconnected).toBe(true);
  });

  it("does not resurrect a connection cancelled while the active-tab query is pending", async () => {
    const harness = new ChromeHarness();
    const queryGate = createDeferred();
    harness.tabsQueryGate = queryGate.promise;
    const session = harness.createSession();

    const connecting = session.connect();
    session.disconnect();
    queryGate.resolve();

    await expect(connecting).resolves.toBe(false);
    expect(session.status).toEqual({ reason: "none", state: "idle" });
    expect(harness.injection).toBeUndefined();
    expect(harness.nativeApplication).toBeUndefined();
  });

  it("does not bind a document after disconnecting during script injection", async () => {
    const harness = new ChromeHarness();
    const injectionGate = createDeferred();
    harness.injectionGate = injectionGate.promise;
    const session = harness.createSession();

    const connecting = session.connect();
    await waitUntil(() => harness.injection !== undefined);
    session.disconnect();
    injectionGate.resolve();

    await expect(connecting).resolves.toBe(false);
    expect(session.status).toEqual({ reason: "none", state: "idle" });
    expect(harness.tabConnection).toBeUndefined();
    expect(harness.nativeApplication).toBeUndefined();
  });
});

class FakeMessageEvent {
  readonly #listeners: ((message: unknown) => void)[] = [];

  public addListener(listener: (message: unknown) => void): void {
    this.#listeners.push(listener);
  }

  public emit(message: unknown): void {
    for (const listener of this.#listeners) {
      listener(message);
    }
  }
}

class FakeDisconnectEvent {
  readonly #listeners: (() => void)[] = [];

  public addListener(listener: () => void): void {
    this.#listeners.push(listener);
  }

  public emit(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

class FakeRuntimeMessageEvent {
  public listener:
    | ((
        message: unknown,
        sender: ChromeMessageSender,
        sendResponse: (response: unknown) => void,
      ) => boolean | undefined)
    | undefined;

  public addListener(
    listener: (
      message: unknown,
      sender: ChromeMessageSender,
      sendResponse: (response: unknown) => void,
    ) => boolean | undefined,
  ): void {
    this.listener = listener;
  }
}

class FakePort implements ChromePort {
  public readonly name: string;
  public readonly onDisconnect = new FakeDisconnectEvent();
  public readonly onMessage = new FakeMessageEvent();
  public disconnected = false;
  public readonly sent: unknown[] = [];

  public constructor(name: string) {
    this.name = name;
  }

  public disconnect(): void {
    this.disconnected = true;
  }

  public emitMessage(message: unknown): void {
    this.onMessage.emit(message);
  }

  public postMessage(message: unknown): void {
    this.sent.push(message);
  }
}

class ChromeHarness {
  public injectionGate: Promise<void> = Promise.resolve();
  public injection:
    | {
        readonly files: readonly string[];
        readonly target: { readonly frameIds: readonly number[]; readonly tabId: number };
        readonly world: "ISOLATED";
      }
    | undefined;
  public injectionResults: readonly ChromeInjectionResult[] = [
    { documentId: "document-1", frameId: 0 },
  ];
  public nativeApplication: string | undefined;
  public readonly nativePort = new FakePort("native");
  public readonly pagePort = new FakePort("gptsessionbridge-page-v1");
  public tabConnection:
    | {
        readonly options: { readonly documentId: string; readonly name: string };
        readonly tabId: number;
      }
    | undefined;
  public tabs: readonly ChromeTab[] = [
    { active: true, id: 7, url: "https://chatgpt.com/c/example", windowId: 4 },
  ];
  public tabsQueryGate: Promise<void> = Promise.resolve();
  readonly #requestIds = ["request-1", "request-2", "request-3"];
  #requestIndex = 0;

  public readonly chrome: ChromeApi = {
    runtime: {
      connectNative: (application) => {
        this.nativeApplication = application;
        return this.nativePort;
      },
      getURL: (path) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}`,
      id: "abcdefghijklmnopabcdefghijklmnop",
      onMessage: new FakeRuntimeMessageEvent(),
      sendMessage: () => Promise.reject(new Error("not implemented")),
    },
    scripting: {
      executeScript: async (injection) => {
        this.injection = injection;
        await this.injectionGate;
        return this.injectionResults;
      },
    },
    tabs: {
      connect: (tabId, options) => {
        this.tabConnection = { options, tabId };
        return this.pagePort;
      },
      query: async () => {
        await this.tabsQueryGate;
        return this.tabs;
      },
    },
  };

  public async connectAndHandshake(session: BrowserTabSession): Promise<void> {
    await session.connect();
    this.pagePort.emitMessage({
      adapter: "chatgpt-dom-v1",
      protocolVersion: 1,
      sequence: 0,
      type: "page/ready",
    });
    this.nativePort.emitMessage(helloAcknowledgedFrame());
  }

  public createSession(): BrowserTabSession {
    return new BrowserTabSession({
      chrome: this.chrome,
      createRequestId: () => {
        const requestId = this.#requestIds[this.#requestIndex];
        this.#requestIndex += 1;
        if (requestId === undefined) {
          throw new Error("The test request id pool is exhausted.");
        }
        return requestId;
      },
    });
  }

  public nativeFrame(index: number): NativeMessagingFrame {
    return nativeMessagingFrameSchema.parse(this.nativePort.sent[index]);
  }
}

function createDeferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(): void {
      resolvePromise?.();
    },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Synthetic browser operation did not start.");
}

function helloAcknowledgedFrame(): NativeMessagingFrame {
  return nativeMessagingFrameSchema.parse({
    payload: { implementationVersion: "0.1.0", peer: "nativeHost" },
    protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
    requestId: "request-1",
    sequence: 0,
    type: "hello/acknowledged",
  });
}

function applicationFrame(
  sequence: number,
  type:
    "capabilities/read" | "session/connect" | "session/disconnect" | "turn/cancel" | "turn/start",
  payload: unknown,
): NativeMessagingFrame {
  return nativeMessagingFrameSchema.parse({
    payload,
    protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
    requestId: `incoming-${String(sequence)}`,
    sequence,
    type,
  });
}

function turnPayload(turnId: string): Readonly<Record<string, unknown>> {
  return {
    catalogRevision: catalogRevision(),
    input: [{ text: "hello", type: "text" }],
    modelId: webModel().id,
    reasoningEffort: "medium",
    sessionId: "session-1",
    temporary: false,
    turnId,
  };
}

function catalogRevision(): string {
  return `web-ui-${"a".repeat(64)}`;
}

function webModel(): {
  readonly defaultReasoningEffort: "medium";
  readonly displayName: "Web Model";
  readonly id: string;
  readonly inputModalities: readonly ["text"];
  readonly supportedReasoningEfforts: readonly [
    {
      readonly description: "Compatibility label only; it does not control ChatGPT Web reasoning, which remains UI-defined.";
      readonly reasoningEffort: "medium";
    },
  ];
} {
  return {
    defaultReasoningEffort: "medium",
    displayName: "Web Model",
    id: `ui-web-model-${"b".repeat(24)}`,
    inputModalities: ["text"],
    supportedReasoningEfforts: [
      {
        description:
          "Compatibility label only; it does not control ChatGPT Web reasoning, which remains UI-defined.",
        reasoningEffort: "medium",
      },
    ],
  };
}

function pageCatalogResult(sequence: number, requestId: string): Readonly<Record<string, unknown>> {
  return {
    catalogRevision: catalogRevision(),
    models: [webModel()],
    protocolVersion: 1,
    requestId,
    sequence,
    type: "page/catalog/result",
  };
}
