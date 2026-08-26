import { TOOL_ACTIVATION_DISCLOSURE_VERSION } from "../protocol/tool-activation.js";
import {
  parseUiResponse,
  type UiRequest,
  type UiResponse,
  type UiStatus,
  type UiToolActivationStatus,
} from "../protocol/ui-messages.js";

const STATUS_REFRESH_INTERVAL_MS = 500;

interface PopupRuntime {
  sendMessage(message: unknown): Promise<unknown>;
}

export interface PopupControllerOptions {
  readonly document: Document;
  readonly now: () => number;
  readonly runtime: PopupRuntime;
  readonly scheduleRefresh: (callback: () => void, intervalMs: number) => () => void;
}

export interface PopupController {
  dispose(): void;
}

type ElementConstructor<Type extends HTMLElement> = new () => Type;

export function installPopupController(options: PopupControllerOptions): PopupController {
  const statusElement = requireElement(options.document, "status", HTMLParagraphElement);
  const connectButton = requireElement(options.document, "connect", HTMLButtonElement);
  const disconnectButton = requireElement(options.document, "disconnect", HTMLButtonElement);
  const toolStatusElement = requireElement(options.document, "tool-status", HTMLParagraphElement);
  const consentCheckbox = requireElement(options.document, "tool-consent", HTMLInputElement);
  const activateButton = requireElement(options.document, "activate-tools", HTMLButtonElement);
  const deactivateButton = requireElement(options.document, "deactivate-tools", HTMLButtonElement);

  const lifecycle = { disposed: false };
  let consentSelectionRevision: number | undefined;
  let lastAppliedRequestSequence = -1;
  let latest: UiResponse | undefined;
  let nextRequestSequence = 0;
  let pendingCommand = false;

  const sendRequest = async (request: UiRequest, isCommand = false): Promise<void> => {
    if (lifecycle.disposed || pendingCommand) {
      return;
    }
    const requestSequence = nextRequestSequence;
    nextRequestSequence += 1;
    if (isCommand) {
      pendingCommand = true;
      renderControls();
    }
    try {
      const response = parseUiResponse(await options.runtime.sendMessage(request));
      if (isDisposed()) {
        return;
      }
      if (requestSequence < lastAppliedRequestSequence) {
        return;
      }
      lastAppliedRequestSequence = requestSequence;
      if (response === undefined) {
        latest = undefined;
        renderUnavailable("The extension returned an invalid status message.");
        return;
      }
      latest = response;
      renderResponse(response);
    } catch {
      if (!isDisposed() && requestSequence >= lastAppliedRequestSequence) {
        lastAppliedRequestSequence = requestSequence;
        latest = undefined;
        renderUnavailable("Chrome could not read the local bridge status.");
      }
    } finally {
      if (isCommand && !isDisposed()) {
        pendingCommand = false;
        renderControls();
      }
    }
  };

  connectButton.addEventListener("click", () => {
    clearConsent();
    void sendRequest({ type: "ui/connect" }, true);
  });
  disconnectButton.addEventListener("click", () => {
    clearConsent();
    void sendRequest({ type: "ui/disconnect" }, true);
  });
  consentCheckbox.addEventListener("change", () => {
    if (
      consentCheckbox.checked &&
      latest?.status.state === "connected" &&
      latest.activation.state === "inactive"
    ) {
      consentSelectionRevision = latest.selectionRevision;
    } else {
      clearConsent();
    }
    renderControls();
  });
  activateButton.addEventListener("click", () => {
    if (
      !consentCheckbox.checked ||
      consentSelectionRevision === undefined ||
      consentSelectionRevision !== latest?.selectionRevision
    ) {
      return;
    }
    const selectionRevision = consentSelectionRevision;
    clearConsent();
    void sendRequest(
      {
        disclosureVersion: TOOL_ACTIVATION_DISCLOSURE_VERSION,
        selectionRevision,
        type: "ui/tool-activation/activate",
      },
      true,
    );
  });
  deactivateButton.addEventListener("click", () => {
    void sendRequest({ type: "ui/tool-activation/deactivate" }, true);
  });

  void sendRequest({ type: "ui/status/read" });
  const cancelRefresh = options.scheduleRefresh(() => {
    void sendRequest({ type: "ui/status/read" });
  }, STATUS_REFRESH_INTERVAL_MS);

  function renderResponse(response: UiResponse): void {
    setTextIfChanged(statusElement, describeConnectionStatus(response.status));
    setTextIfChanged(toolStatusElement, describeToolStatus(response.activation, options.now()));
    if (
      response.activation.state === "active" ||
      response.status.state !== "connected" ||
      (consentSelectionRevision !== undefined &&
        consentSelectionRevision !== response.selectionRevision)
    ) {
      clearConsent();
    }
    renderControls();
  }

  function isDisposed(): boolean {
    return lifecycle.disposed;
  }

  function renderUnavailable(message: string): void {
    setTextIfChanged(statusElement, message);
    setTextIfChanged(
      toolStatusElement,
      "Tool access status is unavailable and is treated as inactive.",
    );
    clearConsent();
    renderControls();
  }

  function clearConsent(): void {
    consentSelectionRevision = undefined;
    consentCheckbox.checked = false;
  }

  function renderControls(): void {
    const connection = latest?.status.state;
    const activation = latest?.activation.state;
    const connected = connection === "connected";
    const active = activation === "active";
    const consentBound =
      consentCheckbox.checked && consentSelectionRevision === latest?.selectionRevision;
    connectButton.disabled =
      pendingCommand || connection === "connecting" || connection === "connected";
    disconnectButton.disabled = pendingCommand || connection === undefined || connection === "idle";
    consentCheckbox.disabled = pendingCommand || !connected || active;
    activateButton.disabled = pendingCommand || !connected || active || !consentBound;
    deactivateButton.disabled = pendingCommand || !active;
  }

  return Object.freeze({
    dispose(): void {
      if (!lifecycle.disposed) {
        lifecycle.disposed = true;
        cancelRefresh();
      }
    },
  });
}

function setTextIfChanged(element: HTMLElement, value: string): void {
  if (element.textContent !== value) {
    element.textContent = value;
  }
}

function describeConnectionStatus(status: UiStatus): string {
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

function describeToolStatus(activation: UiToolActivationStatus, now: number): string {
  if (activation.state === "active") {
    const remainingMs = Math.max(0, activation.expiresAtMs - now);
    const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    return `The tool consent lease is active for this tab and expires after about ${String(remainingMinutes)} minute${remainingMinutes === 1 ? "" : "s"} without admitted agent activity. The Web Agent model remains unavailable in this build.`;
  }
  switch (activation.reason) {
    case "deactivated":
      return "Tool access is inactive because you deactivated it.";
    case "disconnected":
      return "Tool access is inactive because the local bridge disconnected.";
    case "document_replaced":
      return "Tool access is inactive because the selected ChatGPT document changed.";
    case "expired":
      return "Tool access is inactive because the 15-minute inactivity lease expired.";
    case "extension_restart":
      return "Tool access starts inactive and is reset whenever the extension restarts.";
  }
}

function requireElement<Type extends HTMLElement>(
  documentValue: Document,
  id: string,
  constructor: ElementConstructor<Type>,
): Type {
  const element = documentValue.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error("The extension popup is missing a required element.");
  }
  return element;
}
