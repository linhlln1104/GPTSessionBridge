import { POPUP_PATH } from "../constants.js";
import { ToolActivationLease } from "../activation/tool-activation-lease.js";
import type { ChromeApi, ChromeMessageSender } from "../platform/chrome-api.js";
import {
  parseUiRequest,
  toUiToolActivationStatus,
  type UiRequest,
  type UiResponse,
} from "../protocol/ui-messages.js";
import { isPopupSender } from "../security/sender-policy.js";
import { BrowserTabSession } from "../session/browser-tab-session.js";

export interface InstalledServiceWorker {
  readonly activation: ToolActivationLease;
  readonly session: BrowserTabSession;
}

export function installServiceWorker(chrome: ChromeApi): InstalledServiceWorker {
  const activation = new ToolActivationLease({
    createLeaseId: () => globalThis.crypto.randomUUID(),
    now: () => Math.floor(globalThis.performance.timeOrigin + globalThis.performance.now()),
    scheduleTimer: (callback, delayMs) => {
      const handle = globalThis.setTimeout(callback, delayMs);
      return () => {
        globalThis.clearTimeout(handle);
      };
    },
  });
  const session = new BrowserTabSession({
    chrome,
    createRequestId: () => globalThis.crypto.randomUUID(),
    onDocumentInvalidated: (reason) => {
      activation.invalidate(reason);
    },
  });
  const popupUrl = chrome.runtime.getURL(POPUP_PATH);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isPopupSender(sender, chrome.runtime.id, popupUrl)) {
      return undefined;
    }

    const request = parseUiRequest(message);
    if (request === undefined) {
      sendResponse(createResponse(false, session, activation));
      return undefined;
    }

    void dispatchUiRequest(request, session, activation).then((ok) => {
      sendResponse(createResponse(ok, session, activation));
    });
    return true;
  });

  return Object.freeze({ activation, session });
}

async function dispatchUiRequest(
  request: UiRequest,
  session: BrowserTabSession,
  activation: ToolActivationLease,
): Promise<boolean> {
  switch (request.type) {
    case "ui/connect":
      return session.connect();
    case "ui/disconnect":
      session.disconnect();
      return true;
    case "ui/status/read":
      return true;
    case "ui/tool-activation/activate": {
      const binding = await session.readActivationBindingForActiveTab(request.selectionRevision);
      return binding !== undefined && activation.activate(binding, request.disclosureVersion);
    }
    case "ui/tool-activation/deactivate":
      return activation.deactivate();
  }
}

function createResponse(
  ok: boolean,
  session: BrowserTabSession,
  activation: ToolActivationLease,
): UiResponse {
  return Object.freeze({
    activation: toUiToolActivationStatus(activation.snapshot),
    ok,
    selectionRevision: session.selectionRevision,
    status: session.status,
  });
}

export function isServiceWorkerPopupSender(
  sender: ChromeMessageSender,
  chrome: ChromeApi,
): boolean {
  return isPopupSender(sender, chrome.runtime.id, chrome.runtime.getURL(POPUP_PATH));
}
