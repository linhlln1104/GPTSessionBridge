import { readChromeApi } from "../platform/chrome-api.js";
import { parseUiResponse, type UiRequest, type UiStatus } from "../protocol/ui-messages.js";

const STATUS_REFRESH_INTERVAL_MS = 500;

type ElementConstructor<Type extends HTMLElement> = new () => Type;

const chromeApi = readChromeApi();
const statusElement = requireElement("status", HTMLParagraphElement);
const connectButton = requireElement("connect", HTMLButtonElement);
const disconnectButton = requireElement("disconnect", HTMLButtonElement);

connectButton.addEventListener("click", () => {
  void sendRequest({ type: "ui/connect" });
});
disconnectButton.addEventListener("click", () => {
  void sendRequest({ type: "ui/disconnect" });
});

void sendRequest({ type: "ui/status/read" });
globalThis.setInterval(() => {
  void sendRequest({ type: "ui/status/read" });
}, STATUS_REFRESH_INTERVAL_MS);

async function sendRequest(request: UiRequest): Promise<void> {
  try {
    const response = parseUiResponse(await chromeApi.runtime.sendMessage(request));
    if (response === undefined) {
      renderStatus({ reason: "protocol_error", state: "error" });
      return;
    }
    renderStatus(response.status);
  } catch {
    renderStatus({ reason: "browser_unavailable", state: "error" });
  }
}

function renderStatus(status: UiStatus): void {
  statusElement.textContent = describeStatus(status);
  connectButton.disabled = status.state === "connecting" || status.state === "connected";
  disconnectButton.disabled = status.state === "idle";
}

function describeStatus(status: UiStatus): string {
  if (status.reason !== "none") {
    switch (status.reason) {
      case "already_connected":
        return "A tab is already connected.";
      case "browser_unavailable":
        return "Chrome could not access the selected tab.";
      case "native_unavailable":
        return "The local Native Messaging host is unavailable.";
      case "page_unavailable":
        return "The selected page is no longer available.";
      case "protocol_error":
        return "The local connection rejected an invalid message.";
      case "unsupported_page":
        return "Open chatgpt.com in this tab before connecting.";
    }
  }

  switch (status.state) {
    case "connected":
      return "Connected for text-only Web turns. Keep this bridge-owned conversation open.";
    case "connecting":
      return "Connecting this ChatGPT tab…";
    case "error":
      return "The selected tab could not be connected.";
    case "idle":
      return "No ChatGPT tab is connected.";
  }
}

function requireElement<Type extends HTMLElement>(
  id: string,
  constructor: ElementConstructor<Type>,
): Type {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error("The extension popup is missing a required element.");
  }
  return element;
}
