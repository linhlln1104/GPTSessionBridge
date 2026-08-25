import { POPUP_PATH } from "../constants.js";
import type { ChromeApi, ChromeMessageSender } from "../platform/chrome-api.js";
import { parseUiRequest, type UiResponse } from "../protocol/ui-messages.js";
import { isPopupSender } from "../security/sender-policy.js";
import { BrowserTabSession } from "../session/browser-tab-session.js";

export interface InstalledServiceWorker {
  readonly session: BrowserTabSession;
}

export function installServiceWorker(chrome: ChromeApi): InstalledServiceWorker {
  const session = new BrowserTabSession({
    chrome,
    createRequestId: () => globalThis.crypto.randomUUID(),
  });
  const popupUrl = chrome.runtime.getURL(POPUP_PATH);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isPopupSender(sender, chrome.runtime.id, popupUrl)) {
      return undefined;
    }

    const request = parseUiRequest(message);
    if (request === undefined) {
      sendResponse(createResponse(false, session));
      return undefined;
    }

    void dispatchUiRequest(request.type, session).then((ok) => {
      sendResponse(createResponse(ok, session));
    });
    return true;
  });

  return Object.freeze({ session });
}

async function dispatchUiRequest(
  type: "ui/connect" | "ui/disconnect" | "ui/status/read",
  session: BrowserTabSession,
): Promise<boolean> {
  switch (type) {
    case "ui/connect":
      return session.connect();
    case "ui/disconnect":
      session.disconnect();
      return true;
    case "ui/status/read":
      return true;
  }
}

function createResponse(ok: boolean, session: BrowserTabSession): UiResponse {
  return Object.freeze({ ok, status: session.status });
}

export function isServiceWorkerPopupSender(
  sender: ChromeMessageSender,
  chrome: ChromeApi,
): boolean {
  return isPopupSender(sender, chrome.runtime.id, chrome.runtime.getURL(POPUP_PATH));
}
