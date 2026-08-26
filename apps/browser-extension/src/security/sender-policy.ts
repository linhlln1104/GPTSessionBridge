import type {
  ChromeInjectionResult,
  ChromeMessageSender,
  ChromeTab,
} from "../platform/chrome-api.js";

import { CHATGPT_ORIGIN } from "../constants.js";

const MAX_DOCUMENT_ID_LENGTH = 256;
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;

export interface SelectedDocument {
  readonly documentId: string;
  readonly tabId: number;
  readonly url: string;
  readonly windowId: number;
}

export interface SelectedTab {
  readonly tabId: number;
  readonly url: string;
  readonly windowId: number;
}

export function isExactChatGptUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value);
    return url.origin === CHATGPT_ORIGIN && url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

export function isPopupSender(
  sender: ChromeMessageSender,
  extensionId: string,
  popupUrl: string,
): boolean {
  return sender.id === extensionId && sender.url === popupUrl && sender.tab === undefined;
}

export function selectInjectedDocument(
  tabs: readonly ChromeTab[],
  results: readonly ChromeInjectionResult[],
): SelectedDocument | undefined {
  const selectedTab = selectActiveChatGptTab(tabs);
  if (selectedTab === undefined) {
    return undefined;
  }

  const mainFrameResults = results.filter((result) => result.frameId === 0);
  if (mainFrameResults.length !== 1) {
    return undefined;
  }

  const documentId = mainFrameResults[0]?.documentId;
  if (
    typeof documentId !== "string" ||
    documentId.length === 0 ||
    documentId.length > MAX_DOCUMENT_ID_LENGTH ||
    !DOCUMENT_ID_PATTERN.test(documentId)
  ) {
    return undefined;
  }

  return Object.freeze({ documentId, ...selectedTab });
}

export function selectActiveChatGptTab(tabs: readonly ChromeTab[]): SelectedTab | undefined {
  if (tabs.length !== 1) {
    return undefined;
  }

  const tab = tabs[0];
  const tabId = tab?.id;
  const windowId = tab?.windowId;
  if (
    tab?.active !== true ||
    !isNonnegativeSafeInteger(tabId) ||
    !isNonnegativeSafeInteger(windowId) ||
    !isExactChatGptUrl(tab.url)
  ) {
    return undefined;
  }
  return Object.freeze({ tabId, url: tab.url, windowId });
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
