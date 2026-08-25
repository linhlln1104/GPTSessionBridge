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
  UNAVAILABLE_CATALOG_REVISION,
} from "../constants.js";
import type { ChromeApi, ChromePort } from "../platform/chrome-api.js";
import { BrowserNativeLink, BrowserNativeLinkError } from "../protocol/browser-native-link.js";
import { createPageProbeMessage, parsePageReadyMessage } from "../protocol/page-messages.js";
import type { ExtensionUiReason, UiStatus } from "../protocol/ui-messages.js";
import {
  selectActiveChatGptTab,
  selectInjectedDocument,
  type SelectedDocument,
} from "../security/sender-policy.js";

interface ActivePage {
  readonly generation: number;
  readonly port: ChromePort;
  readonly selected: SelectedDocument;
  ready: boolean;
}

interface ActiveNativeConnection {
  readonly generation: number;
  readonly link: BrowserNativeLink;
  readonly port: ChromePort;
}

export interface BrowserTabSessionOptions {
  readonly chrome: ChromeApi;
  readonly createRequestId: () => string;
}

const MAIN_FRAME_ID = 0;
const PROTOCOL_VERSION = 1;
const BRIDGE_ERROR_CODES = Object.freeze({
  CAPABILITY_UNSUPPORTED: "capability.unsupported",
  PROTOCOL_INVALID_MESSAGE: "protocol.invalid_message",
  SESSION_ALREADY_CONNECTED: "session.already_connected",
  SESSION_NOT_CONNECTED: "session.not_connected",
  TURN_NOT_FOUND: "turn.not_found",
} as const satisfies Readonly<Record<string, BridgeErrorCode>>);

/**
 * Owns one user-selected document and one native port. It deliberately exposes
 * no DOM automation: the current shell reports an unavailable adapter and
 * fails every turn closed until a separately reviewed adapter is installed.
 */
export class BrowserTabSession {
  readonly #chrome: ChromeApi;
  readonly #createRequestId: () => string;
  #generation = 0;
  #native: ActiveNativeConnection | undefined;
  #page: ActivePage | undefined;
  #sessionId: string | undefined;
  #status: UiStatus = Object.freeze({ reason: "none", state: "idle" });

  public constructor(options: BrowserTabSessionOptions) {
    this.#chrome = options.chrome;
    this.#createRequestId = options.createRequestId;
  }

  public get status(): UiStatus {
    return this.#status;
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
      this.#page = { generation, port, ready: false, selected };
      port.onMessage.addListener((message) => {
        this.#receiveFromPage(generation, message);
      });
      port.onDisconnect.addListener(() => {
        this.#pageDisconnected(generation);
      });
      port.postMessage(createPageProbeMessage());
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
    if (page?.generation !== generation || page.ready) {
      return;
    }
    if (parsePageReadyMessage(value) === undefined) {
      this.#terminate("pageUnavailable", "error", "protocol_error");
      return;
    }
    page.ready = true;
    this.#openNativeConnection(generation);
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
        this.#sessionId = undefined;
        return this.#applicationFrame("session/disconnected", frame.requestId, {
          reason: frame.payload.reason ?? "shutdown",
          sessionId: frame.payload.sessionId,
        });
      case "capabilities/read":
        if (!this.#matchesSession(frame.payload.sessionId)) {
          return this.#sessionNotConnected(frame.requestId);
        }
        return this.#applicationFrame("capabilities/result", frame.requestId, {
          capabilities: {
            cancellation: false,
            catalogRevision: UNAVAILABLE_CATALOG_REVISION,
            imageInput: false,
            modelDiscovery: false,
            models: [],
            streaming: false,
            temporaryChat: false,
            toolCalls: false,
          },
          sessionId: frame.payload.sessionId,
        });
      case "turn/start":
        return this.#turnFailed(
          frame,
          this.#matchesSession(frame.payload.sessionId)
            ? BRIDGE_ERROR_CODES.CAPABILITY_UNSUPPORTED
            : BRIDGE_ERROR_CODES.SESSION_NOT_CONNECTED,
          this.#matchesSession(frame.payload.sessionId)
            ? "The browser adapter is not available."
            : "The browser session is not connected.",
        );
      case "turn/cancel":
        return this.#turnFailed(
          frame,
          this.#matchesSession(frame.payload.sessionId)
            ? BRIDGE_ERROR_CODES.TURN_NOT_FOUND
            : BRIDGE_ERROR_CODES.SESSION_NOT_CONNECTED,
          this.#matchesSession(frame.payload.sessionId)
            ? "The requested browser turn is not active."
            : "The browser session is not connected.",
        );
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

  #errorFrame(requestId: string, code: BridgeErrorCode, message: string): NativeMessagingFrame {
    return this.#applicationFrame("error", requestId, {
      error: { code, message, retryable: false },
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
    this.#page = undefined;
    this.#sessionId = undefined;

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
    tryDisconnect(native?.port);
    tryDisconnect(page?.port);
    this.#setStatus(state, reason);
  }

  #setStatus(state: UiStatus["state"], reason: ExtensionUiReason): void {
    this.#status = Object.freeze({ reason, state });
  }
}

function tryDisconnect(port: ChromePort | undefined): void {
  try {
    port?.disconnect();
  } catch {
    // A disconnected Chrome port is already in the desired terminal state.
  }
}
