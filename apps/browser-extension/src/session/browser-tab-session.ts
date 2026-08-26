import type {
  BridgeErrorCode,
  NativeMessagingFrame,
  NativeMessagingFrameOf,
  SessionCloseReason,
} from "@gpt-session-bridge/protocol";

import {
  CONTENT_PORT_NAME,
  CONTENT_SCRIPT_PATH,
  EXTENSION_IMPLEMENTATION_VERSION,
  NATIVE_HOST_NAME,
} from "../constants.js";
import type { ChromeApi, ChromePort } from "../platform/chrome-api.js";
import { BrowserNativeLink, BrowserNativeLinkError } from "../protocol/browser-native-link.js";
import {
  PageClientLink,
  PageClientLinkError,
  type PageCommandFailedMessage,
  type PageEventMessage,
  type PageRuntimeCommandInput,
} from "../protocol/page-messages.js";
import type { ToolActivationDocumentBinding } from "../protocol/tool-activation.js";
import type { ExtensionUiReason, UiStatus } from "../protocol/ui-messages.js";
import {
  selectActiveChatGptTab,
  selectInjectedDocument,
  type SelectedDocument,
} from "../security/sender-policy.js";

interface ActivePage {
  readonly generation: number;
  readonly link: PageClientLink;
  readonly port: ChromePort;
  readonly selected: SelectedDocument;
}

interface ActiveNativeConnection {
  readonly generation: number;
  readonly link: BrowserNativeLink;
  readonly port: ChromePort;
}

interface ActiveTurn {
  cancelRequestId?: string;
  readonly requestId: string;
  readonly sessionId: string;
  started: boolean;
  readonly turnId: string;
}

export interface BrowserTabSessionOptions {
  readonly chrome: ChromeApi;
  readonly createRequestId: () => string;
  readonly onDocumentInvalidated?: (reason: "disconnected" | "document_replaced") => void;
}

const MAIN_FRAME_ID = 0;
const PROTOCOL_VERSION = 1;
const BRIDGE_ERROR_CODES = Object.freeze({
  CAPABILITY_UNSUPPORTED: "capability.unsupported",
  BROWSER_STATE_CHANGED: "browser.state_changed",
  BROWSER_UNAVAILABLE: "browser.unavailable",
  MODEL_UNAVAILABLE: "model.unavailable",
  PROTOCOL_INVALID_MESSAGE: "protocol.invalid_message",
  SESSION_ALREADY_CONNECTED: "session.already_connected",
  SESSION_NOT_CONNECTED: "session.not_connected",
  TURN_ALREADY_ACTIVE: "turn.already_active",
  TURN_NOT_FOUND: "turn.not_found",
} as const satisfies Readonly<Record<string, BridgeErrorCode>>);

/**
 * Owns one user-selected document, its strict content-script link, and one
 * native port. DOM work remains confined to that exact injected document.
 */
export class BrowserTabSession {
  readonly #chrome: ChromeApi;
  readonly #createRequestId: () => string;
  readonly #onDocumentInvalidated:
    ((reason: "disconnected" | "document_replaced") => void) | undefined;
  #generation = 0;
  #native: ActiveNativeConnection | undefined;
  readonly #orphanedCatalogRequestIds = new Set<string>();
  readonly #orphanedTurns = new Map<string, ActiveTurn>();
  #page: ActivePage | undefined;
  #pendingCatalogRequestId: string | undefined;
  #sessionId: string | undefined;
  #status: UiStatus = Object.freeze({ reason: "none", state: "idle" });
  #turn: ActiveTurn | undefined;

  public constructor(options: BrowserTabSessionOptions) {
    this.#chrome = options.chrome;
    this.#createRequestId = options.createRequestId;
    this.#onDocumentInvalidated = options.onDocumentInvalidated;
  }

  public get status(): UiStatus {
    return this.#status;
  }

  /** Redacted epoch used only to bind popup consent to the selected connection. */
  public get selectionRevision(): number {
    return this.#generation;
  }

  public get activationBinding(): ToolActivationDocumentBinding | undefined {
    const page = this.#page;
    if (this.#status.state !== "connected" || page?.link.state !== "ready") {
      return undefined;
    }
    return Object.freeze({
      documentId: page.selected.documentId,
      generation: page.generation,
      tabId: page.selected.tabId,
    });
  }

  /**
   * Revalidates the explicit popup gesture against Chrome's current active tab
   * and an unchanged connected document. No lease is created or renewed here.
   */
  public async readActivationBindingForActiveTab(
    expectedSelectionRevision: number,
  ): Promise<ToolActivationDocumentBinding | undefined> {
    const beforePage = this.#page;
    const beforeBinding = this.activationBinding;
    if (
      beforePage === undefined ||
      beforeBinding === undefined ||
      expectedSelectionRevision !== this.#generation
    ) {
      return undefined;
    }

    let tabs;
    try {
      tabs = await this.#chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
      return undefined;
    }
    const active = selectActiveChatGptTab(tabs);
    const afterPage = this.#page;
    const afterBinding = this.activationBinding;
    if (
      active === undefined ||
      afterPage !== beforePage ||
      afterBinding === undefined ||
      expectedSelectionRevision !== this.#generation ||
      active.tabId !== beforePage.selected.tabId ||
      active.windowId !== beforePage.selected.windowId ||
      active.url !== beforePage.selected.url ||
      !sameActivationBinding(beforeBinding, afterBinding)
    ) {
      return undefined;
    }
    return afterBinding;
  }

  public async connect(): Promise<boolean> {
    if (this.#status.state !== "idle" && this.#status.state !== "error") {
      this.#setStatus(this.#status.state, "already_connected");
      return false;
    }

    this.#terminate(undefined, "idle", "none");
    this.#setStatus("connecting", "none");
    const generation = this.#generation;

    let tabs;
    try {
      tabs = await this.#chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
      if (this.#isCurrentConnect(generation)) {
        this.#terminate(undefined, "error", "browser_unavailable");
      }
      return false;
    }
    if (!this.#isCurrentConnect(generation)) {
      return false;
    }

    const selectedTab = selectActiveChatGptTab(tabs);
    if (selectedTab === undefined) {
      this.#terminate(undefined, "error", "unsupported_page");
      return false;
    }

    try {
      const results = await this.#chrome.scripting.executeScript({
        files: [CONTENT_SCRIPT_PATH],
        target: { frameIds: [MAIN_FRAME_ID], tabId: selectedTab.tabId },
        world: "ISOLATED",
      });
      if (!this.#isCurrentConnect(generation)) {
        return false;
      }
      const selected = selectInjectedDocument(tabs, results);
      if (selected === undefined) {
        this.#terminate(undefined, "error", "page_unavailable");
        return false;
      }

      const port = this.#chrome.tabs.connect(selected.tabId, {
        documentId: selected.documentId,
        name: CONTENT_PORT_NAME,
      });
      const link = new PageClientLink();
      this.#page = { generation, link, port, selected };
      port.onMessage.addListener((message) => {
        this.#receiveFromPage(generation, message);
      });
      port.onDisconnect.addListener(() => {
        this.#pageDisconnected(generation);
      });
      port.postMessage(link.start());
      return true;
    } catch {
      if (this.#isCurrentConnect(generation)) {
        this.#terminate(undefined, "error", "page_unavailable");
      }
      return false;
    }
  }

  public disconnect(): void {
    this.#terminate("user", "idle", "none");
  }

  #receiveFromPage(generation: number, value: unknown): void {
    const page = this.#page;
    if (page?.generation !== generation) {
      return;
    }
    try {
      const event = page.link.receive(value);
      if (event.type === "page/ready") {
        this.#openNativeConnection(generation);
        return;
      }
      this.#handlePageEvent(event);
    } catch {
      this.#terminate("pageUnavailable", "error", "protocol_error");
    }
  }

  #openNativeConnection(generation: number): void {
    if (this.#page?.generation !== generation || this.#native !== undefined) {
      return;
    }

    try {
      const port = this.#chrome.runtime.connectNative(NATIVE_HOST_NAME);
      const link = new BrowserNativeLink();
      this.#native = { generation, link, port };
      port.onMessage.addListener((message) => {
        this.#receiveFromNative(generation, message);
      });
      port.onDisconnect.addListener(() => {
        this.#nativeDisconnected(generation);
      });
      port.postMessage(link.start(this.#createRequestId(), EXTENSION_IMPLEMENTATION_VERSION));
    } catch {
      this.#terminate("transportLost", "error", "native_unavailable");
    }
  }

  #receiveFromNative(generation: number, value: unknown): void {
    const connection = this.#native;
    if (connection?.generation !== generation) {
      return;
    }

    try {
      const previousState = connection.link.state;
      const result = connection.link.receive(value);
      if (result.response !== undefined) {
        connection.port.postMessage(result.response);
      }
      if (previousState !== "ready" && connection.link.state === "ready") {
        this.#setStatus("connected", "none");
      }
      if (result.application !== undefined) {
        const response = this.#handleApplication(result.application);
        if (response !== undefined) {
          connection.port.postMessage(connection.link.sendApplication(response));
        }
      }
    } catch (error) {
      const reason =
        error instanceof BrowserNativeLinkError ? "protocol_error" : "native_unavailable";
      this.#terminate("transportLost", "error", reason);
    }
  }

  #handleApplication(frame: NativeMessagingFrame): NativeMessagingFrame | undefined {
    switch (frame.type) {
      case "session/connect":
        if (this.#sessionId !== undefined) {
          return this.#errorFrame(
            frame.requestId,
            BRIDGE_ERROR_CODES.SESSION_ALREADY_CONNECTED,
            "A browser session is already connected.",
          );
        }
        this.#sessionId = frame.payload.sessionId;
        return this.#applicationFrame("session/connected", frame.requestId, {
          sessionId: frame.payload.sessionId,
        });
      case "session/disconnect":
        if (!this.#matchesSession(frame.payload.sessionId)) {
          return this.#sessionNotConnected(frame.requestId);
        }
        if (this.#pendingCatalogRequestId !== undefined) {
          this.#orphanedCatalogRequestIds.add(this.#pendingCatalogRequestId);
        }
        if (this.#turn !== undefined) {
          this.#orphanedTurns.set(this.#turn.turnId, this.#turn);
        }
        this.#sessionId = undefined;
        this.#pendingCatalogRequestId = undefined;
        this.#turn = undefined;
        this.#notifyDocumentInvalidated("disconnected");
        return this.#applicationFrame("session/disconnected", frame.requestId, {
          reason: frame.payload.reason ?? "shutdown",
          sessionId: frame.payload.sessionId,
        });
      case "capabilities/read":
        if (!this.#matchesSession(frame.payload.sessionId)) {
          return this.#sessionNotConnected(frame.requestId);
        }
        if (
          this.#pendingCatalogRequestId !== undefined ||
          this.#turn !== undefined ||
          this.#hasOrphanedPageOperation()
        ) {
          return this.#errorFrame(
            frame.requestId,
            BRIDGE_ERROR_CODES.BROWSER_UNAVAILABLE,
            "Browser model discovery is already active.",
          );
        }
        this.#pendingCatalogRequestId = frame.requestId;
        if (!this.#sendPage({ requestId: frame.requestId, type: "page/catalog/read" })) {
          return undefined;
        }
        return undefined;
      case "turn/start": {
        if (!this.#matchesSession(frame.payload.sessionId)) {
          return this.#turnFailed(
            frame,
            BRIDGE_ERROR_CODES.SESSION_NOT_CONNECTED,
            "The browser session is not connected.",
          );
        }
        if (this.#turn !== undefined) {
          return this.#turnFailed(
            frame,
            BRIDGE_ERROR_CODES.TURN_ALREADY_ACTIVE,
            "A browser turn is already active.",
          );
        }
        if (this.#pendingCatalogRequestId !== undefined || this.#hasOrphanedPageOperation()) {
          return this.#turnFailed(
            frame,
            BRIDGE_ERROR_CODES.BROWSER_UNAVAILABLE,
            "Browser model discovery is still active.",
          );
        }
        if (frame.payload.input.length !== 1) {
          return this.#turnFailed(
            frame,
            BRIDGE_ERROR_CODES.CAPABILITY_UNSUPPORTED,
            "Exactly one text input is required for a browser turn.",
          );
        }
        if (frame.payload.temporary) {
          return this.#turnFailed(
            frame,
            BRIDGE_ERROR_CODES.CAPABILITY_UNSUPPORTED,
            "Temporary ChatGPT Web turns are not supported.",
          );
        }
        this.#turn = {
          requestId: frame.requestId,
          sessionId: frame.payload.sessionId,
          started: false,
          turnId: frame.payload.turnId,
        };
        if (
          !this.#sendPage({
            catalogRevision: frame.payload.catalogRevision,
            input: frame.payload.input,
            modelId: frame.payload.modelId,
            reasoningEffort: frame.payload.reasoningEffort,
            requestId: frame.requestId,
            temporary: false,
            turnId: frame.payload.turnId,
            type: "page/turn/start",
          })
        ) {
          return undefined;
        }
        return undefined;
      }
      case "turn/cancel": {
        if (!this.#matchesSession(frame.payload.sessionId)) {
          return this.#turnFailed(
            frame,
            BRIDGE_ERROR_CODES.SESSION_NOT_CONNECTED,
            "The browser session is not connected.",
          );
        }
        const turn = this.#turn;
        if (turn?.turnId !== frame.payload.turnId || turn.cancelRequestId !== undefined) {
          return this.#turnFailed(
            frame,
            BRIDGE_ERROR_CODES.TURN_NOT_FOUND,
            "The requested browser turn is not cancellable.",
          );
        }
        turn.cancelRequestId = frame.requestId;
        if (
          !this.#sendPage({
            requestId: frame.requestId,
            turnId: frame.payload.turnId,
            type: "page/turn/cancel",
          })
        ) {
          return undefined;
        }
        return undefined;
      }
      case "error":
        this.#terminate("transportLost", "error", "protocol_error");
        return undefined;
      default:
        return this.#errorFrame(
          frame.requestId,
          BRIDGE_ERROR_CODES.PROTOCOL_INVALID_MESSAGE,
          "The browser extension received an unsupported message.",
        );
    }
  }

  #handlePageEvent(event: Exclude<PageEventMessage, { readonly type: "page/ready" }>): void {
    if (event.type === "page/document/changed") {
      this.#terminate("pageUnavailable", "error", "page_unavailable");
      return;
    }
    if (this.#drainOrphanedPageEvent(event)) {
      return;
    }
    const sessionId = this.#sessionId;
    if (sessionId === undefined) {
      // Passive catalog observations may race the native handshake. Every
      // command-correlated stale event must have been drained above.
      if (event.type === "page/catalog/changed") {
        return;
      }
      throw new PageClientLinkError();
    }
    switch (event.type) {
      case "page/catalog/changed":
        if (this.#pendingCatalogRequestId !== undefined || this.#hasOrphanedPageOperation()) {
          return;
        }
        this.#sendNative(
          this.#applicationFrame("capabilities/changed", this.#createRequestId(), {
            capabilities: {
              cancellation: true,
              catalogRevision: event.catalogRevision,
              imageInput: false,
              modelDiscovery: true,
              models: [...event.models],
              streaming: true,
              temporaryChat: false,
              toolCalls: false,
            },
            sessionId,
          }),
        );
        return;
      case "page/catalog/result":
        if (event.requestId !== this.#pendingCatalogRequestId) {
          throw new PageClientLinkError();
        }
        this.#pendingCatalogRequestId = undefined;
        this.#sendNative(
          this.#applicationFrame("capabilities/result", event.requestId, {
            capabilities: {
              cancellation: true,
              catalogRevision: event.catalogRevision,
              imageInput: false,
              modelDiscovery: true,
              models: [...event.models],
              streaming: true,
              temporaryChat: false,
              toolCalls: false,
            },
            sessionId,
          }),
        );
        return;
      case "page/turn/started": {
        const turn = this.#expectPageTurn(event.turnId);
        if (turn.started || event.requestId !== turn.requestId) {
          throw new PageClientLinkError();
        }
        turn.started = true;
        this.#sendNative(
          this.#applicationFrame("turn/started", event.requestId, {
            sessionId: turn.sessionId,
            turnId: turn.turnId,
          }),
        );
        return;
      }
      case "page/turn/delta": {
        const turn = this.#expectStartedPageTurn(event.turnId);
        this.#sendNative(
          this.#applicationFrame("turn/delta", turn.requestId, {
            channel: "outputText",
            delta: event.delta,
            sessionId: turn.sessionId,
            turnId: turn.turnId,
          }),
        );
        return;
      }
      case "page/turn/completed": {
        const turn = this.#expectStartedPageTurn(event.turnId);
        this.#turn = undefined;
        this.#sendNative(
          this.#applicationFrame("turn/completed", turn.requestId, {
            finishReason: "stop",
            sessionId: turn.sessionId,
            turnId: turn.turnId,
          }),
        );
        return;
      }
      case "page/turn/cancelled": {
        const turn = this.#expectPageTurn(event.turnId);
        if (turn.cancelRequestId === undefined || event.requestId !== turn.cancelRequestId) {
          throw new PageClientLinkError();
        }
        this.#turn = undefined;
        this.#sendNative(
          this.#applicationFrame("turn/cancelled", event.requestId, {
            sessionId: turn.sessionId,
            turnId: turn.turnId,
          }),
        );
        return;
      }
      case "page/command/failed":
        this.#handlePageFailure(event);
        return;
    }
  }

  #drainOrphanedPageEvent(
    event: Exclude<PageEventMessage, { readonly type: "page/ready" }>,
  ): boolean {
    if (
      (event.type === "page/catalog/result" ||
        (event.type === "page/command/failed" && event.turnId === undefined)) &&
      this.#orphanedCatalogRequestIds.delete(event.requestId)
    ) {
      return true;
    }
    if (
      event.type !== "page/turn/started" &&
      event.type !== "page/turn/delta" &&
      event.type !== "page/turn/completed" &&
      event.type !== "page/turn/cancelled" &&
      !(event.type === "page/command/failed" && event.turnId !== undefined)
    ) {
      return false;
    }
    const turnId = event.turnId;
    if (turnId === undefined) {
      return false;
    }
    const turn = this.#orphanedTurns.get(turnId);
    if (turn === undefined) {
      return false;
    }
    switch (event.type) {
      case "page/turn/started":
        if (turn.started || event.requestId !== turn.requestId) {
          throw new PageClientLinkError();
        }
        turn.started = true;
        break;
      case "page/turn/delta":
        if (!turn.started) {
          throw new PageClientLinkError();
        }
        break;
      case "page/turn/completed":
        if (!turn.started) {
          throw new PageClientLinkError();
        }
        this.#orphanedTurns.delete(turnId);
        break;
      case "page/turn/cancelled":
        if (turn.cancelRequestId === undefined || event.requestId !== turn.cancelRequestId) {
          throw new PageClientLinkError();
        }
        this.#orphanedTurns.delete(turnId);
        break;
      case "page/command/failed":
        if (event.requestId === turn.requestId) {
          this.#orphanedTurns.delete(turnId);
        } else if (event.requestId === turn.cancelRequestId) {
          delete turn.cancelRequestId;
        } else {
          throw new PageClientLinkError();
        }
        break;
    }
    return true;
  }

  #hasOrphanedPageOperation(): boolean {
    return this.#orphanedCatalogRequestIds.size > 0 || this.#orphanedTurns.size > 0;
  }

  #handlePageFailure(event: PageCommandFailedMessage): void {
    const sessionId = this.#sessionId;
    if (event.requestId === this.#pendingCatalogRequestId && event.turnId === undefined) {
      this.#pendingCatalogRequestId = undefined;
      this.#sendNative(
        this.#errorFrame(
          event.requestId,
          mapPageFailureCode(event.code),
          event.message,
          event.retryable,
        ),
      );
      return;
    }
    const turn = this.#turn;
    if (turn === undefined || event.turnId !== turn.turnId || sessionId !== turn.sessionId) {
      throw new PageClientLinkError();
    }
    if (event.requestId === turn.cancelRequestId) {
      delete turn.cancelRequestId;
      this.#sendNative(
        this.#errorFrame(
          event.requestId,
          mapPageFailureCode(event.code),
          event.message,
          event.retryable,
        ),
      );
      return;
    }
    if (event.requestId !== turn.requestId) {
      throw new PageClientLinkError();
    }
    this.#turn = undefined;
    this.#sendNative(
      this.#applicationFrame("turn/failed", event.requestId, {
        error: {
          code: mapPageFailureCode(event.code),
          message: event.message,
          retryable: event.retryable,
        },
        sessionId,
        turnId: turn.turnId,
      }),
    );
  }

  #sendPage(command: PageRuntimeCommandInput): boolean {
    const page = this.#page;
    if (page?.link.state !== "ready") {
      this.#terminate("pageUnavailable", "error", "page_unavailable");
      return false;
    }
    try {
      page.port.postMessage(page.link.send(command));
      return true;
    } catch {
      this.#terminate("pageUnavailable", "error", "page_unavailable");
      return false;
    }
  }

  #sendNative(frame: NativeMessagingFrame): void {
    const native = this.#native;
    if (native?.link.state !== "ready") {
      throw new BrowserNativeLinkError();
    }
    native.port.postMessage(native.link.sendApplication(frame));
  }

  #expectPageTurn(turnId: string): ActiveTurn {
    const turn = this.#turn;
    if (turn?.turnId !== turnId || turn.sessionId !== this.#sessionId) {
      throw new PageClientLinkError();
    }
    return turn;
  }

  #expectStartedPageTurn(turnId: string): ActiveTurn {
    const turn = this.#expectPageTurn(turnId);
    if (!turn.started) {
      throw new PageClientLinkError();
    }
    return turn;
  }

  #turnFailed(
    frame: NativeMessagingFrameOf<"turn/cancel"> | NativeMessagingFrameOf<"turn/start">,
    code: BridgeErrorCode,
    message: string,
  ): NativeMessagingFrame {
    return this.#applicationFrame("turn/failed", frame.requestId, {
      error: { code, message, retryable: false },
      sessionId: frame.payload.sessionId,
      turnId: frame.payload.turnId,
    });
  }

  #sessionNotConnected(requestId: string): NativeMessagingFrame {
    return this.#errorFrame(
      requestId,
      BRIDGE_ERROR_CODES.SESSION_NOT_CONNECTED,
      "The browser session is not connected.",
    );
  }

  #errorFrame(
    requestId: string,
    code: BridgeErrorCode,
    message: string,
    retryable = false,
  ): NativeMessagingFrame {
    return this.#applicationFrame("error", requestId, {
      error: { code, message, retryable },
    });
  }

  #applicationFrame<Type extends NativeMessagingFrame["type"]>(
    type: Type,
    requestId: string,
    payload: Extract<NativeMessagingFrame, { type: Type }>["payload"],
  ): NativeMessagingFrame {
    return {
      payload,
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      sequence: 0,
      type,
    } as NativeMessagingFrame;
  }

  #matchesSession(sessionId: string): boolean {
    return this.#sessionId !== undefined && this.#sessionId === sessionId;
  }

  #isCurrentConnect(generation: number): boolean {
    return this.#generation === generation && this.#status.state === "connecting";
  }

  #pageDisconnected(generation: number): void {
    if (this.#page?.generation === generation) {
      this.#terminate("pageUnavailable", "error", "page_unavailable");
    }
  }

  #nativeDisconnected(generation: number): void {
    if (this.#native?.generation === generation) {
      this.#terminate("transportLost", "error", "native_unavailable");
    }
  }

  #terminate(
    closeReason: SessionCloseReason | undefined,
    state: UiStatus["state"],
    reason: ExtensionUiReason,
  ): void {
    const native = this.#native;
    const page = this.#page;
    const sessionId = this.#sessionId;
    this.#generation += 1;
    this.#native = undefined;
    this.#orphanedCatalogRequestIds.clear();
    this.#orphanedTurns.clear();
    this.#page = undefined;
    this.#pendingCatalogRequestId = undefined;
    this.#sessionId = undefined;
    this.#turn = undefined;

    if (page !== undefined) {
      this.#notifyDocumentInvalidated(
        closeReason === "pageUnavailable" ? "document_replaced" : "disconnected",
      );
    }

    if (closeReason !== undefined && sessionId !== undefined && native?.link.state === "ready") {
      try {
        const frame = this.#applicationFrame("session/disconnected", this.#createRequestId(), {
          reason: closeReason,
          sessionId,
        });
        native.port.postMessage(native.link.sendApplication(frame));
      } catch {
        // Closing is best-effort; prompts and turns are never replayed after transport loss.
      }
    }

    native?.link.close();
    page?.link.close();
    tryDisconnect(native?.port);
    tryDisconnect(page?.port);
    this.#setStatus(state, reason);
  }

  #setStatus(state: UiStatus["state"], reason: ExtensionUiReason): void {
    this.#status = Object.freeze({ reason, state });
  }

  #notifyDocumentInvalidated(reason: "disconnected" | "document_replaced"): void {
    try {
      this.#onDocumentInvalidated?.(reason);
    } catch {
      // Lease invalidation observers are isolated from the session shutdown path.
    }
  }
}

function sameActivationBinding(
  left: ToolActivationDocumentBinding,
  right: ToolActivationDocumentBinding,
): boolean {
  return (
    left.documentId === right.documentId &&
    left.generation === right.generation &&
    left.tabId === right.tabId
  );
}

function tryDisconnect(port: ChromePort | undefined): void {
  try {
    port?.disconnect();
  } catch {
    // A disconnected Chrome port is already in the desired terminal state.
  }
}

function mapPageFailureCode(code: PageCommandFailedMessage["code"]): BridgeErrorCode {
  switch (code) {
    case "adapter_unavailable":
      return BRIDGE_ERROR_CODES.BROWSER_UNAVAILABLE;
    case "browser_state_changed":
      return BRIDGE_ERROR_CODES.BROWSER_STATE_CHANGED;
    case "model_unavailable":
      return BRIDGE_ERROR_CODES.MODEL_UNAVAILABLE;
    case "turn_already_active":
      return BRIDGE_ERROR_CODES.TURN_ALREADY_ACTIVE;
    case "turn_not_found":
      return BRIDGE_ERROR_CODES.TURN_NOT_FOUND;
    case "unsupported":
      return BRIDGE_ERROR_CODES.CAPABILITY_UNSUPPORTED;
  }
}
