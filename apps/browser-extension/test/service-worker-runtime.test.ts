import { describe, expect, it } from "vitest";

import { installServiceWorker } from "../src/background/service-worker-runtime.js";
import type { ChromeApi, ChromeMessageSender } from "../src/platform/chrome-api.js";

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
      ok: true,
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
    expect(response).toEqual({ ok: false, status: { reason: "none", state: "idle" } });
    expect(harness.tabsQueried).toBe(false);
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
