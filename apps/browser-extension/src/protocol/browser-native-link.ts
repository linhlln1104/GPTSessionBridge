import type { NativeMessagingFrame, NativeMessagingFrameType } from "@gpt-session-bridge/protocol";

export type BrowserNativeLinkState = "awaitingAcknowledgement" | "closed" | "idle" | "ready";

export class BrowserNativeLinkError extends Error {
  public constructor() {
    super("native_link_rejected");
    this.name = "BrowserNativeLinkError";
  }
}

const PROTOCOL_VERSION = 1;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const TRANSPORT_TYPES = new Set<NativeMessagingFrameType>([
  "ack",
  "heartbeat",
  "hello",
  "hello/acknowledged",
]);
const INCOMING_APPLICATION_TYPES = new Set<NativeMessagingFrameType>([
  "capabilities/read",
  "error",
  "session/connect",
  "session/disconnect",
  "turn/cancel",
  "turn/start",
]);
const OUTGOING_APPLICATION_TYPES = new Set<NativeMessagingFrameType>([
  "capabilities/changed",
  "capabilities/result",
  "error",
  "session/connected",
  "session/disconnected",
  "turn/cancelled",
  "turn/completed",
  "turn/delta",
  "turn/failed",
  "turn/started",
]);

/** Browser-only initiator for the extension-to-host link. */
export class BrowserNativeLink {
  #expectedInboundSequence = 0;
  #handshakeRequestId: string | undefined;
  #nextOutboundSequence = 0;
  #state: BrowserNativeLinkState = "idle";

  public get state(): BrowserNativeLinkState {
    return this.#state;
  }

  public start(requestId: string, implementationVersion: string): NativeMessagingFrame {
    if (
      this.#state !== "idle" ||
      !isOpaqueId(requestId, 128) ||
      !isOpaqueId(implementationVersion, 64)
    ) {
      return this.#reject();
    }
    this.#handshakeRequestId = requestId;
    this.#state = "awaitingAcknowledgement";
    return {
      payload: {
        implementationVersion,
        peer: "extension",
        supportedProtocolVersions: [PROTOCOL_VERSION],
      },
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      sequence: this.#takeOutboundSequence(),
      type: "hello",
    };
  }

  public receive(value: unknown): {
    readonly application?: NativeMessagingFrame;
    readonly response?: NativeMessagingFrame;
  } {
    if (this.#state === "closed") {
      throw new BrowserNativeLinkError();
    }
    const frame = parseNativeMessagingFrame(value);
    if (frame?.sequence !== this.#expectedInboundSequence) {
      return this.#reject();
    }

    if (this.#state === "awaitingAcknowledgement") {
      if (
        frame.type !== "hello/acknowledged" ||
        frame.payload.peer !== "nativeHost" ||
        frame.requestId !== this.#handshakeRequestId
      ) {
        return this.#reject();
      }
      this.#expectedInboundSequence = 1;
      this.#handshakeRequestId = undefined;
      this.#state = "ready";
      return {};
    }
    if (this.#state !== "ready") {
      return this.#reject();
    }

    this.#expectedInboundSequence += 1;
    if (frame.type === "heartbeat") {
      return {
        response: {
          payload: { acknowledgedSequence: frame.sequence },
          protocolVersion: PROTOCOL_VERSION,
          requestId: frame.requestId,
          sequence: this.#takeOutboundSequence(),
          type: "ack",
        },
      };
    }
    if (TRANSPORT_TYPES.has(frame.type) || !INCOMING_APPLICATION_TYPES.has(frame.type)) {
      return this.#reject();
    }
    return { application: frame };
  }

  public sendApplication(value: unknown): NativeMessagingFrame {
    if (this.#state !== "ready") {
      return this.#reject();
    }
    const frame = parseNativeMessagingFrame(value);
    if (frame === undefined || !OUTGOING_APPLICATION_TYPES.has(frame.type)) {
      return this.#reject();
    }
    return { ...frame, protocolVersion: PROTOCOL_VERSION, sequence: this.#takeOutboundSequence() };
  }

  public close(): void {
    this.#state = "closed";
    this.#handshakeRequestId = undefined;
  }

  #takeOutboundSequence(): number {
    if (this.#nextOutboundSequence > MAX_SEQUENCE) {
      return this.#reject();
    }
    const sequence = this.#nextOutboundSequence;
    this.#nextOutboundSequence += 1;
    return sequence;
  }

  #reject(): never {
    this.close();
    throw new BrowserNativeLinkError();
  }
}

export function parseNativeMessagingFrame(value: unknown): NativeMessagingFrame | undefined {
  if (!hasExactKeys(value, ["payload", "protocolVersion", "requestId", "sequence", "type"])) {
    return undefined;
  }
  if (
    value["protocolVersion"] !== PROTOCOL_VERSION ||
    !isOpaqueId(value["requestId"], 128) ||
    !isSequence(value["sequence"]) ||
    typeof value["type"] !== "string"
  ) {
    return undefined;
  }

  const payload = value["payload"];
  const valid = isPayload(value["type"], payload);
  return valid ? (value as unknown as NativeMessagingFrame) : undefined;
}

function isPayload(type: string, payload: unknown): boolean {
  switch (type) {
    case "hello":
      return (
        hasExactKeys(payload, ["implementationVersion", "peer", "supportedProtocolVersions"]) &&
        isPeer(payload["peer"]) &&
        isOpaqueId(payload["implementationVersion"], 64) &&
        isSupportedProtocolVersions(payload["supportedProtocolVersions"])
      );
    case "hello/acknowledged":
      return (
        hasExactKeys(payload, ["implementationVersion", "peer"]) &&
        isPeer(payload["peer"]) &&
        isOpaqueId(payload["implementationVersion"], 64)
      );
    case "heartbeat":
      return hasExactKeys(payload, []);
    case "ack":
      return (
        hasExactKeys(payload, ["acknowledgedSequence"]) &&
        isSequence(payload["acknowledgedSequence"])
      );
    case "session/connect":
    case "session/connected":
    case "capabilities/read":
      return isSessionPayload(payload);
    case "session/disconnect":
      return (
        hasExactKeys(payload, ["sessionId"], ["reason"]) &&
        isOpaqueId(payload["sessionId"], 128) &&
        (payload["reason"] === undefined || isCloseReason(payload["reason"]))
      );
    case "session/disconnected":
      return (
        hasExactKeys(payload, ["reason", "sessionId"]) &&
        isOpaqueId(payload["sessionId"], 128) &&
        isCloseReason(payload["reason"])
      );
    case "capabilities/result":
    case "capabilities/changed":
      return (
        hasExactKeys(payload, ["capabilities", "sessionId"]) &&
        isOpaqueId(payload["sessionId"], 128) &&
        isCapabilities(payload["capabilities"])
      );
    case "turn/start":
      return isTurnStartPayload(payload);
    case "turn/started":
    case "turn/cancel":
    case "turn/cancelled":
      return isTurnPayload(payload);
    case "turn/delta":
      return (
        hasExactKeys(payload, ["channel", "delta", "sessionId", "turnId"]) &&
        isOpaqueId(payload["sessionId"], 128) &&
        isOpaqueId(payload["turnId"], 128) &&
        (payload["channel"] === "outputText" ||
          payload["channel"] === "reasoning" ||
          payload["channel"] === "commentary") &&
        typeof payload["delta"] === "string" &&
        payload["delta"].length >= 1 &&
        payload["delta"].length <= 16_384
      );
    case "turn/completed":
      return (
        hasExactKeys(payload, ["finishReason", "sessionId", "turnId"]) &&
        isOpaqueId(payload["sessionId"], 128) &&
        isOpaqueId(payload["turnId"], 128) &&
        (payload["finishReason"] === "stop" || payload["finishReason"] === "length")
      );
    case "turn/failed":
      return (
        hasExactKeys(payload, ["error", "sessionId", "turnId"]) &&
        isOpaqueId(payload["sessionId"], 128) &&
        isOpaqueId(payload["turnId"], 128) &&
        isBridgeError(payload["error"])
      );
    case "error":
      return hasExactKeys(payload, ["error"]) && isBridgeError(payload["error"]);
    default:
      return false;
  }
}

function isTurnStartPayload(value: unknown): boolean {
  if (
    !hasExactKeys(value, [
      "catalogRevision",
      "input",
      "modelId",
      "reasoningEffort",
      "sessionId",
      "temporary",
      "turnId",
    ]) ||
    !isOpaqueId(value["sessionId"], 128) ||
    !isOpaqueId(value["turnId"], 128) ||
    !isOpaqueId(value["catalogRevision"], 128) ||
    !isModelId(value["modelId"]) ||
    !isOpaqueId(value["reasoningEffort"], 64) ||
    typeof value["temporary"] !== "boolean" ||
    !Array.isArray(value["input"]) ||
    value["input"].length < 1 ||
    value["input"].length > 16
  ) {
    return false;
  }
  let totalCharacters = 0;
  for (const item of value["input"]) {
    if (
      !hasExactKeys(item, ["text", "type"]) ||
      item["type"] !== "text" ||
      typeof item["text"] !== "string" ||
      item["text"].length < 1 ||
      item["text"].length > 65_536
    ) {
      return false;
    }
    totalCharacters += item["text"].length;
  }
  return totalCharacters <= 262_144;
}

function isCapabilities(value: unknown): boolean {
  if (
    !hasExactKeys(value, [
      "cancellation",
      "catalogRevision",
      "imageInput",
      "modelDiscovery",
      "models",
      "streaming",
      "temporaryChat",
      "toolCalls",
    ]) ||
    !isOpaqueId(value["catalogRevision"], 128) ||
    typeof value["modelDiscovery"] !== "boolean" ||
    typeof value["streaming"] !== "boolean" ||
    typeof value["cancellation"] !== "boolean" ||
    typeof value["temporaryChat"] !== "boolean" ||
    value["imageInput"] !== false ||
    value["toolCalls"] !== false ||
    !Array.isArray(value["models"]) ||
    value["models"].length > 128
  ) {
    return false;
  }
  const modelIds = new Set<string>();
  for (const model of value["models"]) {
    if (!isModel(model) || modelIds.has(model.id)) {
      return false;
    }
    modelIds.add(model.id);
  }
  return value["modelDiscovery"] || value["models"].length === 0;
}

function isModel(value: unknown): value is Record<string, unknown> & { readonly id: string } {
  if (
    !hasExactKeys(value, [
      "defaultReasoningEffort",
      "displayName",
      "id",
      "inputModalities",
      "supportedReasoningEfforts",
    ]) ||
    !isModelId(value["id"]) ||
    !isSafeText(value["displayName"], 128) ||
    !Array.isArray(value["inputModalities"]) ||
    value["inputModalities"].length !== 1 ||
    value["inputModalities"][0] !== "text" ||
    !Array.isArray(value["supportedReasoningEfforts"]) ||
    value["supportedReasoningEfforts"].length < 1 ||
    value["supportedReasoningEfforts"].length > 16 ||
    !isOpaqueId(value["defaultReasoningEffort"], 64)
  ) {
    return false;
  }
  const efforts = new Set<string>();
  for (const option of value["supportedReasoningEfforts"]) {
    if (
      !hasExactKeys(option, ["description", "reasoningEffort"]) ||
      !isOpaqueId(option["reasoningEffort"], 64) ||
      !isSafeText(option["description"], 256) ||
      efforts.has(option["reasoningEffort"])
    ) {
      return false;
    }
    efforts.add(option["reasoningEffort"]);
  }
  return efforts.has(value["defaultReasoningEffort"]);
}

const ERROR_CODES = new Set([
  "browser.state_changed",
  "browser.unavailable",
  "capability.unsupported",
  "internal.error",
  "model.unavailable",
  "protocol.invalid_message",
  "protocol.sequence_violation",
  "protocol.unsupported_version",
  "session.already_connected",
  "session.closed",
  "session.not_connected",
  "transport.timeout",
  "transport.unavailable",
  "turn.already_active",
  "turn.cancelled",
  "turn.not_found",
]);

function isBridgeError(value: unknown): boolean {
  return (
    hasExactKeys(value, ["code", "message", "retryable"]) &&
    typeof value["code"] === "string" &&
    ERROR_CODES.has(value["code"]) &&
    isSafeText(value["message"], 512) &&
    typeof value["retryable"] === "boolean"
  );
}

function isSessionPayload(value: unknown): boolean {
  return hasExactKeys(value, ["sessionId"]) && isOpaqueId(value["sessionId"], 128);
}

function isTurnPayload(value: unknown): boolean {
  return (
    hasExactKeys(value, ["sessionId", "turnId"]) &&
    isOpaqueId(value["sessionId"], 128) &&
    isOpaqueId(value["turnId"], 128)
  );
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isOpaqueId(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function isModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)
  );
}

function isSafeText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maxLength &&
    !hasUnsafeTextCharacter(value)
  );
}

function hasUnsafeTextCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPeer(value: unknown): boolean {
  return value === "bridge" || value === "extension" || value === "nativeHost";
}

function isSupportedProtocolVersions(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 16 &&
    value.every((version) => Number.isSafeInteger(version) && version > 0) &&
    new Set(value).size === value.length &&
    value.includes(PROTOCOL_VERSION)
  );
}

function isCloseReason(value: unknown): boolean {
  return (
    value === "pageUnavailable" ||
    value === "replaced" ||
    value === "shutdown" ||
    value === "transportLost" ||
    value === "user"
  );
}
