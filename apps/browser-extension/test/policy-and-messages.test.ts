import { describe, expect, it } from "vitest";

import { createPageProbeMessage, parsePageReadyMessage } from "../src/protocol/page-messages.js";
import { parseUiRequest, parseUiResponse } from "../src/protocol/ui-messages.js";
import {
  isExactChatGptUrl,
  isPopupSender,
  selectActiveChatGptTab,
  selectInjectedDocument,
} from "../src/security/sender-policy.js";

describe("extension boundary policies", () => {
  it("accepts only the exact HTTPS ChatGPT origin", () => {
    expect(isExactChatGptUrl("https://chatgpt.com/")).toBe(true);
    expect(isExactChatGptUrl("https://chatgpt.com/c/example?model=test")).toBe(true);
    expect(isExactChatGptUrl("https://chatgpt.com:443/")).toBe(true);

    expect(isExactChatGptUrl("http://chatgpt.com/")).toBe(false);
    expect(isExactChatGptUrl("https://www.chatgpt.com/")).toBe(false);
    expect(isExactChatGptUrl("https://chatgpt.com.example/")).toBe(false);
    expect(isExactChatGptUrl("https://user@chatgpt.com/")).toBe(false);
    expect(isExactChatGptUrl("not a URL")).toBe(false);
    expect(isExactChatGptUrl(undefined)).toBe(false);
  });

  it("binds popup messages to the extension-owned popup", () => {
    const extensionId = "abcdefghijklmnopabcdefghijklmnop";
    const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
    expect(isPopupSender({ id: extensionId, url: popupUrl }, extensionId, popupUrl)).toBe(true);
    expect(isPopupSender({ id: extensionId, tab: {}, url: popupUrl }, extensionId, popupUrl)).toBe(
      false,
    );
    expect(isPopupSender({ id: "other", url: popupUrl }, extensionId, popupUrl)).toBe(false);
    expect(
      isPopupSender(
        { documentId: "document", id: extensionId, url: popupUrl },
        extensionId,
        popupUrl,
      ),
    ).toBe(true);
  });

  it("selects exactly one active tab and one main-frame document", () => {
    const tabs = [
      { active: true, id: 7, url: "https://chatgpt.com/c/example", windowId: 4 },
    ] as const;
    expect(selectActiveChatGptTab(tabs)).toEqual({ tabId: 7, windowId: 4 });
    expect(selectInjectedDocument(tabs, [{ documentId: "document-1", frameId: 0 }])).toEqual({
      documentId: "document-1",
      tabId: 7,
      windowId: 4,
    });

    expect(selectActiveChatGptTab([])).toBeUndefined();
    expect(selectActiveChatGptTab([...tabs, ...tabs])).toBeUndefined();
    expect(selectActiveChatGptTab([{ ...tabs[0], active: false }])).toBeUndefined();
    expect(selectActiveChatGptTab([{ ...tabs[0], id: -1 }])).toBeUndefined();
    expect(selectActiveChatGptTab([{ ...tabs[0], url: "https://example.com/" }])).toBeUndefined();
    expect(selectInjectedDocument(tabs, [])).toBeUndefined();
    expect(
      selectInjectedDocument(tabs, [
        { documentId: "document-1", frameId: 0 },
        { documentId: "document-2", frameId: 0 },
      ]),
    ).toBeUndefined();
    expect(
      selectInjectedDocument(tabs, [{ documentId: "document id", frameId: 0 }]),
    ).toBeUndefined();
  });
});

describe("internal extension messages", () => {
  it("uses strict popup request and response variants", () => {
    expect(parseUiRequest({ type: "ui/connect" })).toEqual({ type: "ui/connect" });
    expect(parseUiRequest({ extra: true, type: "ui/connect" })).toBeUndefined();
    expect(parseUiRequest({ type: "ui/unknown" })).toBeUndefined();

    expect(parseUiResponse({ ok: true, status: { reason: "none", state: "connected" } })).toEqual({
      ok: true,
      status: { reason: "none", state: "connected" },
    });
    expect(
      parseUiResponse({ ok: true, status: { reason: "none", state: "selected" } }),
    ).toBeUndefined();
    expect(parseUiResponse({ ok: true, status: { reason: "none" } })).toBeUndefined();
  });

  it("uses a strict fail-closed page probe", () => {
    expect(createPageProbeMessage()).toEqual({ protocolVersion: 1, type: "page/probe" });
    expect(
      parsePageReadyMessage({
        adapter: "unavailable",
        protocolVersion: 1,
        type: "page/ready",
      }),
    ).toEqual({ adapter: "unavailable", protocolVersion: 1, type: "page/ready" });
    expect(
      parsePageReadyMessage({
        adapter: "available",
        protocolVersion: 1,
        type: "page/ready",
      }),
    ).toBeUndefined();
    expect(
      parsePageReadyMessage({
        adapter: "unavailable",
        extra: true,
        protocolVersion: 1,
        type: "page/ready",
      }),
    ).toBeUndefined();
  });
});
