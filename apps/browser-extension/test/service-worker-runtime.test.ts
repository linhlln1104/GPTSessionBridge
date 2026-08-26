import { describe, expect, it } from "vitest";

import { installServiceWorker } from "../src/background/service-worker-runtime.js";
import type { ChromeApi, ChromeMessageSender, ChromePort } from "../src/platform/chrome-api.js";

describe("service-worker popup boundary", () => {
  it("serves status only to the exact extension popup", async () => {
    const harness = createRuntimeHarness();
    installServiceWorker(harness.chrome);
    const listener = harness.requireListener();
    const sender = {
      id: harness.chrome.runtime.id,
      url: harness.chrome.runtime.getURL("popup/popup.html"),
    };

    const response = new Promise<unknown>((resolve) => {
      expect(listener({ type: "ui/status/read" }, sender, resolve)).toBe(true);
    });
    await expect(response).resolves.toEqual({
      activation: inactiveUiActivation(),
      ok: true,
      selectionRevision: 0,
      status: { reason: "none", state: "idle" },
    });

    let wasCalled = false;
    expect(
      listener(
        { type: "ui/status/read" },
        { ...sender, id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
        () => {
          wasCalled = true;
        },
      ),
    ).toBeUndefined();
    expect(wasCalled).toBe(false);
  });

  it("rejects malformed popup commands without starting a connection", () => {
    const harness = createRuntimeHarness();
    installServiceWorker(harness.chrome);
    const listener = harness.requireListener();
    const sender = {
      id: harness.chrome.runtime.id,
      url: harness.chrome.runtime.getURL("popup/popup.html"),
    };
    let response: unknown;

    expect(
      listener({ extra: true, type: "ui/connect" }, sender, (value) => {
        response = value;
      }),
    ).toBeUndefined();
    expect(response).toEqual({
      activation: inactiveUiActivation(),
      ok: false,
      selectionRevision: 0,
      status: { reason: "none", state: "idle" },
    });
    expect(harness.tabsQueried).toBe(false);
  });

  it("activates only the connected document and redacts the bridge-facing binding", async () => {
    const harness = createConnectedRuntimeHarness();
    installServiceWorker(harness.chrome);
    const listener = harness.requireListener();
    const sender = popupSender(harness.chrome);

    await expect(sendPopupRequest(listener, sender, { type: "ui/connect" })).resolves.toMatchObject(
      {
        ok: true,
        status: { state: "connecting" },
      },
    );
    harness.pagePort.emitMessage({
      adapter: "chatgpt-dom-v1",
      protocolVersion: 1,
      sequence: 0,
      type: "page/ready",
    });
    const hello = harness.nativePort.sent[0] as Readonly<Record<string, unknown>>;
    harness.nativePort.emitMessage({
      payload: { implementationVersion: "0.1.0", peer: "nativeHost" },
      protocolVersion: 1,
      requestId: hello["requestId"],
      sequence: 0,
      type: "hello/acknowledged",
    });

    const activated = await sendPopupRequest(listener, sender, {
      disclosureVersion: "visible-chat-data-v1",
      selectionRevision: 1,
      type: "ui/tool-activation/activate",
    });
    expect(activated).toMatchObject({
      activation: { reason: "user_activated", revision: 1, state: "active" },
      ok: true,
      selectionRevision: 1,
      status: { state: "connected" },
    });
    const activation = (activated as Record<string, unknown>)["activation"] as Record<
      string,
      unknown
    >;
    expect(Object.keys(activation).sort()).toEqual([
      "disclosureVersion",
      "expiresAtMs",
      "inactivityTimeoutMs",
      "reason",
      "revision",
      "state",
    ]);
    expect(JSON.stringify(activation)).not.toContain("document-1");
    expect(JSON.stringify(activation)).not.toContain("lease");

    const statusRead = await sendPopupRequest(listener, sender, { type: "ui/status/read" });
    expect((statusRead as Record<string, unknown>)["activation"]).toEqual(activation);

    const disconnected = await sendPopupRequest(listener, sender, { type: "ui/disconnect" });
    expect(disconnected).toMatchObject({
      activation: { reason: "disconnected", revision: 2, state: "inactive" },
      ok: true,
    });
  });

  it("rejects activation when the current active tab is not the connected document", async () => {
    const harness = createConnectedRuntimeHarness();
    installServiceWorker(harness.chrome);
    const listener = harness.requireListener();
    const sender = popupSender(harness.chrome);

    await sendPopupRequest(listener, sender, { type: "ui/connect" });
    harness.pagePort.emitMessage({
      adapter: "chatgpt-dom-v1",
      protocolVersion: 1,
      sequence: 0,
      type: "page/ready",
    });
    const hello = harness.nativePort.sent[0] as Readonly<Record<string, unknown>>;
    harness.nativePort.emitMessage({
      payload: { implementationVersion: "0.1.0", peer: "nativeHost" },
      protocolVersion: 1,
      requestId: hello["requestId"],
      sequence: 0,
      type: "hello/acknowledged",
    });

    harness.setActiveTabs([{ active: true, id: 8, url: "https://chatgpt.com/", windowId: 5 }]);
    await expect(
      sendPopupRequest(listener, sender, {
        disclosureVersion: "visible-chat-data-v1",
        selectionRevision: 1,
        type: "ui/tool-activation/activate",
      }),
    ).resolves.toMatchObject({
      activation: { state: "inactive" },
      ok: false,
      selectionRevision: 1,
    });
  });
});

type RuntimeMessageListener = (
  message: unknown,
  sender: ChromeMessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

function createRuntimeHarness(): {
  readonly chrome: ChromeApi;
  requireListener(): RuntimeMessageListener;
  readonly tabsQueried: boolean;
} {
  let listener: RuntimeMessageListener | undefined;
  let tabsQueried = false;
  const chrome: ChromeApi = {
    runtime: {
      connectNative: () => {
        throw new Error("not implemented");
      },
      getURL: (path) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}`,
      id: "abcdefghijklmnopabcdefghijklmnop",
      onMessage: {
        addListener: (value) => {
          listener = value;
        },
      },
      sendMessage: () => Promise.reject(new Error("not implemented")),
    },
    scripting: {
      executeScript: () => Promise.reject(new Error("not implemented")),
    },
    tabs: {
      connect: () => {
        throw new Error("not implemented");
      },
      query: () => {
        tabsQueried = true;
        return Promise.resolve([]);
      },
    },
  };

  return {
    chrome,
    requireListener: () => {
      if (listener === undefined) {
        throw new Error("The service worker did not register its message listener.");
      }
      return listener;
    },
    get tabsQueried() {
      return tabsQueried;
    },
  };
}

function createConnectedRuntimeHarness(): {
  readonly chrome: ChromeApi;
  readonly nativePort: FakePort;
  readonly pagePort: FakePort;
  requireListener(): RuntimeMessageListener;
  setActiveTabs(
    value: readonly { active: true; id: number; url: string; windowId: number }[],
  ): void;
} {
  let listener: RuntimeMessageListener | undefined;
  const nativePort = new FakePort("native");
  const pagePort = new FakePort("gptsessionbridge-page-v1");
  let activeTabs = [{ active: true as const, id: 7, url: "https://chatgpt.com/", windowId: 4 }];
  const chrome: ChromeApi = {
    runtime: {
      connectNative: () => nativePort,
      getURL: (path) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}`,
      id: "abcdefghijklmnopabcdefghijklmnop",
      onMessage: {
        addListener: (value) => {
          listener = value;
        },
      },
      sendMessage: () => Promise.reject(new Error("not implemented")),
    },
    scripting: {
      executeScript: () => Promise.resolve([{ documentId: "document-1", frameId: 0 }]),
    },
    tabs: {
      connect: () => pagePort,
      query: () => Promise.resolve(activeTabs),
    },
  };
  return {
    chrome,
    nativePort,
    pagePort,
    requireListener: () => {
      if (listener === undefined) {
        throw new Error("The service worker did not register its message listener.");
      }
      return listener;
    },
    setActiveTabs: (value) => {
      activeTabs = [...value];
    },
  };
}

class FakeEvent<Listener> {
  readonly #listeners: Listener[] = [];

  public addListener(listener: Listener): void {
    this.#listeners.push(listener);
  }

  public emit(
    ...parameters: Listener extends (...values: infer Parameters) => unknown ? Parameters : never
  ): void {
    for (const listener of this.#listeners) {
      (listener as (...values: readonly unknown[]) => void)(...parameters);
    }
  }
}

class FakePort implements ChromePort {
  public disconnected = false;
  public readonly name: string;
  public readonly onDisconnect = new FakeEvent<() => void>();
  public readonly onMessage = new FakeEvent<(message: unknown) => void>();
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

function popupSender(chrome: ChromeApi): ChromeMessageSender {
  return {
    id: chrome.runtime.id,
    url: chrome.runtime.getURL("popup/popup.html"),
  };
}

function sendPopupRequest(
  listener: RuntimeMessageListener,
  sender: ChromeMessageSender,
  request: unknown,
): Promise<unknown> {
  return new Promise((resolve) => {
    expect(listener(request, sender, resolve)).toBe(true);
  });
}

function inactiveUiActivation(): Readonly<Record<string, unknown>> {
  return {
    disclosureVersion: "visible-chat-data-v1",
    expiresAtMs: null,
    inactivityTimeoutMs: 900_000,
    reason: "extension_restart",
    revision: 0,
    state: "inactive",
  };
}
