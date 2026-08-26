import { describe, expect, it } from "vitest";
import type { WebModelDescriptor } from "@gpt-session-bridge/protocol";

import {
  createPageProbeMessage,
  PageClientLink,
  PageClientLinkError,
  PageServerLink,
  parsePageCommand,
  parsePageEvent,
  parsePageReadyMessage,
} from "../src/protocol/page-messages.js";
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
    expect(selectActiveChatGptTab(tabs)).toEqual({
      tabId: 7,
      url: "https://chatgpt.com/c/example",
      windowId: 4,
    });
    expect(selectInjectedDocument(tabs, [{ documentId: "document-1", frameId: 0 }])).toEqual({
      documentId: "document-1",
      tabId: 7,
      url: "https://chatgpt.com/c/example",
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
    expect(
      parseUiRequest({
        disclosureVersion: "visible-chat-data-v1",
        selectionRevision: 4,
        type: "ui/tool-activation/activate",
      }),
    ).toEqual({
      disclosureVersion: "visible-chat-data-v1",
      selectionRevision: 4,
      type: "ui/tool-activation/activate",
    });
    expect(parseUiRequest({ type: "ui/tool-activation/deactivate" })).toEqual({
      type: "ui/tool-activation/deactivate",
    });
    expect(parseUiRequest({ type: "ui/tool-activation/activate" })).toBeUndefined();
    expect(parseUiRequest({ extra: true, type: "ui/connect" })).toBeUndefined();
    expect(parseUiRequest({ type: "ui/unknown" })).toBeUndefined();

    expect(
      parseUiResponse({
        activation: inactiveUiActivation(),
        ok: true,
        selectionRevision: 4,
        status: { reason: "none", state: "connected" },
      }),
    ).toEqual({
      activation: inactiveUiActivation(),
      ok: true,
      selectionRevision: 4,
      status: { reason: "none", state: "connected" },
    });
    expect(
      parseUiResponse({
        activation: inactiveUiActivation(),
        ok: true,
        selectionRevision: 4,
        status: { reason: "none", state: "selected" },
      }),
    ).toBeUndefined();
    expect(
      parseUiResponse({
        activation: { ...inactiveUiActivation(), documentId: "private" },
        ok: true,
        selectionRevision: 4,
        status: { reason: "none", state: "connected" },
      }),
    ).toBeUndefined();
    expect(
      parseUiResponse({
        activation: inactiveUiActivation(),
        ok: true,
        selectionRevision: 4,
        status: { reason: "none" },
      }),
    ).toBeUndefined();
  });

  it("uses a strict fail-closed page probe", () => {
    expect(createPageProbeMessage()).toEqual({
      protocolVersion: 1,
      sequence: 0,
      type: "page/probe",
    });
    expect(
      parsePageReadyMessage({
        adapter: "chatgpt-dom-v1",
        protocolVersion: 1,
        sequence: 0,
        type: "page/ready",
      }),
    ).toEqual({
      adapter: "chatgpt-dom-v1",
      protocolVersion: 1,
      sequence: 0,
      type: "page/ready",
    });
    expect(
      parsePageEvent({ protocolVersion: 1, sequence: 1, type: "page/document/changed" }),
    ).toEqual({ protocolVersion: 1, sequence: 1, type: "page/document/changed" });
    expect(
      parsePageEvent({
        pathname: "/c/private",
        protocolVersion: 1,
        sequence: 1,
        type: "page/document/changed",
      }),
    ).toBeUndefined();
    expect(
      parsePageReadyMessage({
        adapter: "unavailable",
        protocolVersion: 1,
        sequence: 0,
        type: "page/ready",
      }),
    ).toBeUndefined();
    expect(
      parsePageReadyMessage({
        adapter: "chatgpt-dom-v1",
        extra: true,
        protocolVersion: 1,
        sequence: 0,
        type: "page/ready",
      }),
    ).toBeUndefined();
  });

  it("enforces exact, bounded, monotonic page commands and events", () => {
    const client = new PageClientLink();
    const server = new PageServerLink();
    const probe = client.start();
    expect(server.receive(probe)).toEqual(probe);
    const ready = server.ready();
    expect(client.receive(ready)).toEqual(ready);

    const read = client.send({ requestId: "request-1", type: "page/catalog/read" });
    expect(server.receive(read)).toEqual(read);
    const changed = server.send({
      catalogRevision: `web-ui-${"a".repeat(64)}`,
      models: [pageModel()],
      type: "page/catalog/changed",
    });
    expect(client.receive(changed)).toEqual(changed);

    expect(parsePageCommand({ ...read, extra: true })).toBeUndefined();
    expect(parsePageEvent({ ...changed, models: [] })).toBeUndefined();
    expect(() => server.receive(read)).toThrow(PageClientLinkError);
  });
});

function pageModel(): WebModelDescriptor {
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
