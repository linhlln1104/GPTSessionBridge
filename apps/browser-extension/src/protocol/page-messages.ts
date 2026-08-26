import type { WebModelDescriptor } from "@gpt-session-bridge/protocol";

import { PAGE_PROTOCOL_VERSION } from "../constants.js";

export const PAGE_ADAPTER_ID = "chatgpt-dom-v1" as const;
export const PAGE_DEFAULT_REASONING_EFFORT = "medium" as const;

const MAX_CATALOG_MODELS = 128;
const MAX_DELTA_CHARACTERS = 16_384;
const MAX_INPUT_ITEM_CHARACTERS = 65_536;
const MAX_INPUT_TOTAL_CHARACTERS = 262_144;
const MAX_SAFE_MESSAGE_CHARACTERS = 256;

interface PageEnvelope {
  readonly protocolVersion: typeof PAGE_PROTOCOL_VERSION;
  readonly sequence: number;
}

export interface PageProbeMessage extends PageEnvelope {
  readonly type: "page/probe";
}

export interface PageCatalogReadMessage extends PageEnvelope {
  readonly requestId: string;
  readonly type: "page/catalog/read";
}

export interface PageTurnStartMessage extends PageEnvelope {
  readonly catalogRevision: string;
  readonly input: readonly { readonly text: string; readonly type: "text" }[];
  readonly modelId: string;
  readonly reasoningEffort: string;
  readonly requestId: string;
  readonly temporary: false;
  readonly turnId: string;
  readonly type: "page/turn/start";
}

export interface PageTurnCancelMessage extends PageEnvelope {
  readonly requestId: string;
  readonly turnId: string;
  readonly type: "page/turn/cancel";
}

export type PageCommandMessage =
  PageCatalogReadMessage | PageProbeMessage | PageTurnCancelMessage | PageTurnStartMessage;

export interface PageReadyMessage extends PageEnvelope {
  readonly adapter: typeof PAGE_ADAPTER_ID;
  readonly type: "page/ready";
}

export interface PageCatalogResultMessage extends PageEnvelope {
  readonly catalogRevision: string;
  readonly models: readonly WebModelDescriptor[];
  readonly requestId: string;
  readonly type: "page/catalog/result";
}

export interface PageCatalogChangedMessage extends PageEnvelope {
  readonly catalogRevision: string;
  readonly models: readonly WebModelDescriptor[];
  readonly type: "page/catalog/changed";
}

/** Content-free signal that the selected SPA navigation surface changed. */
export interface PageDocumentChangedMessage extends PageEnvelope {
  readonly type: "page/document/changed";
}

export interface PageTurnStartedMessage extends PageEnvelope {
  readonly requestId: string;
  readonly turnId: string;
  readonly type: "page/turn/started";
}

export interface PageTurnDeltaMessage extends PageEnvelope {
  readonly delta: string;
  readonly turnId: string;
  readonly type: "page/turn/delta";
}

export interface PageTurnCompletedMessage extends PageEnvelope {
  readonly turnId: string;
  readonly type: "page/turn/completed";
}

export interface PageTurnCancelledMessage extends PageEnvelope {
  readonly requestId: string;
  readonly turnId: string;
  readonly type: "page/turn/cancelled";
}

export type PageFailureCode =
  | "adapter_unavailable"
  | "browser_state_changed"
  | "model_unavailable"
  | "turn_already_active"
  | "turn_not_found"
  | "unsupported";

export interface PageCommandFailedMessage extends PageEnvelope {
  readonly code: PageFailureCode;
  readonly message: string;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly turnId?: string;
  readonly type: "page/command/failed";
}

export type PageEventMessage =
  | PageCatalogChangedMessage
  | PageCatalogResultMessage
  | PageCommandFailedMessage
  | PageDocumentChangedMessage
  | PageReadyMessage
  | PageTurnCancelledMessage
  | PageTurnCompletedMessage
  | PageTurnDeltaMessage
  | PageTurnStartedMessage;

type PageRuntimeCommand = Exclude<PageCommandMessage, PageProbeMessage>;
type PageRuntimeEvent = Exclude<PageEventMessage, PageReadyMessage>;

export class PageClientLinkError extends Error {
  public constructor() {
    super("page_link_rejected");
    this.name = "PageClientLinkError";
  }
}

/** Strict sequence and direction boundary owned by the extension service worker. */
export class PageClientLink {
  #expectedInboundSequence = 0;
  #nextOutboundSequence = 0;
  #state: "awaitingReady" | "closed" | "idle" | "ready" = "idle";

  public get state(): "awaitingReady" | "closed" | "idle" | "ready" {
    return this.#state;
  }

  public start(): PageProbeMessage {
    if (this.#state !== "idle") {
      return this.#reject();
    }
    this.#state = "awaitingReady";
    return {
      protocolVersion: PAGE_PROTOCOL_VERSION,
      sequence: this.#takeOutboundSequence(),
      type: "page/probe",
    };
  }

  public send(command: PageRuntimeCommandInput): PageRuntimeCommand {
    if (this.#state !== "ready") {
      return this.#reject();
    }
    const parsed = parsePageCommand({
      ...command,
      protocolVersion: PAGE_PROTOCOL_VERSION,
      sequence: this.#takeOutboundSequence(),
    });
    if (parsed === undefined || parsed.type === "page/probe") {
      return this.#reject();
    }
    return parsed;
  }

  public receive(value: unknown): PageRuntimeEvent | PageReadyMessage {
    if (this.#state === "closed") {
      return this.#reject();
    }
    const event = parsePageEvent(value);
    if (event?.sequence !== this.#expectedInboundSequence) {
      return this.#reject();
    }
    if (this.#state === "awaitingReady") {
      if (event.type !== "page/ready") {
        return this.#reject();
      }
      this.#expectedInboundSequence += 1;
      this.#state = "ready";
      return event;
    }
    if (this.#state !== "ready" || event.type === "page/ready") {
      return this.#reject();
    }
    this.#expectedInboundSequence += 1;
    return event;
  }

  public close(): void {
    this.#state = "closed";
  }

  #takeOutboundSequence(): number {
    if (this.#nextOutboundSequence > Number.MAX_SAFE_INTEGER) {
      return this.#reject();
    }
    const sequence = this.#nextOutboundSequence;
    this.#nextOutboundSequence += 1;
    return sequence;
  }

  #reject(): never {
    this.close();
    throw new PageClientLinkError();
  }
}

/** Strict counterpart embedded in the isolated-world content script. */
export class PageServerLink {
  #expectedInboundSequence = 0;
  #nextOutboundSequence = 0;
  #state: "awaitingProbe" | "closed" | "ready" = "awaitingProbe";

  public receive(value: unknown): PageRuntimeCommand | PageProbeMessage {
    if (this.#state === "closed") {
      return this.#reject();
    }
    const command = parsePageCommand(value);
    if (command?.sequence !== this.#expectedInboundSequence) {
      return this.#reject();
    }
    if (this.#state === "awaitingProbe") {
      if (command.type !== "page/probe") {
        return this.#reject();
      }
      this.#expectedInboundSequence += 1;
      this.#state = "ready";
      return command;
    }
    if (command.type === "page/probe") {
      return this.#reject();
    }
    this.#expectedInboundSequence += 1;
    return command;
  }

  public ready(): PageReadyMessage {
    if (this.#state !== "ready" || this.#nextOutboundSequence !== 0) {
      return this.#reject();
    }
    return {
      adapter: PAGE_ADAPTER_ID,
      protocolVersion: PAGE_PROTOCOL_VERSION,
      sequence: this.#takeOutboundSequence(),
      type: "page/ready",
    };
  }

  public send(event: PageRuntimeEventInput): PageRuntimeEvent {
    if (this.#state !== "ready" || this.#nextOutboundSequence === 0) {
      return this.#reject();
    }
    const parsed = parsePageEvent({
      ...event,
      protocolVersion: PAGE_PROTOCOL_VERSION,
      sequence: this.#takeOutboundSequence(),
    });
    if (parsed === undefined || parsed.type === "page/ready") {
      return this.#reject();
    }
    return parsed;
  }

  public close(): void {
    this.#state = "closed";
  }

  #takeOutboundSequence(): number {
    if (this.#nextOutboundSequence > Number.MAX_SAFE_INTEGER) {
      return this.#reject();
    }
    const sequence = this.#nextOutboundSequence;
    this.#nextOutboundSequence += 1;
    return sequence;
  }

  #reject(): never {
    this.close();
    throw new PageClientLinkError();
  }
}

export type PageRuntimeCommandInput =
  | Omit<PageCatalogReadMessage, keyof PageEnvelope>
  | Omit<PageTurnCancelMessage, keyof PageEnvelope>
  | Omit<PageTurnStartMessage, keyof PageEnvelope>;

export type PageRuntimeEventInput =
  | Omit<PageCatalogChangedMessage, keyof PageEnvelope>
  | Omit<PageCatalogResultMessage, keyof PageEnvelope>
  | Omit<PageCommandFailedMessage, keyof PageEnvelope>
  | Omit<PageDocumentChangedMessage, keyof PageEnvelope>
  | Omit<PageTurnCancelledMessage, keyof PageEnvelope>
  | Omit<PageTurnCompletedMessage, keyof PageEnvelope>
  | Omit<PageTurnDeltaMessage, keyof PageEnvelope>
  | Omit<PageTurnStartedMessage, keyof PageEnvelope>;

export function createPageProbeMessage(): PageProbeMessage {
  return new PageClientLink().start();
}

export function parsePageReadyMessage(value: unknown): PageReadyMessage | undefined {
  const event = parsePageEvent(value);
  return event?.type === "page/ready" ? event : undefined;
}

export function parsePageCommand(value: unknown): PageCommandMessage | undefined {
  if (!isEnvelope(value) || typeof value["type"] !== "string") {
    return undefined;
  }
  switch (value["type"]) {
    case "page/probe":
      return hasExactKeys(value, ["protocolVersion", "sequence", "type"])
        ? (value as unknown as PageProbeMessage)
        : undefined;
    case "page/catalog/read":
      return hasExactKeys(value, ["protocolVersion", "requestId", "sequence", "type"]) &&
        isOpaqueId(value["requestId"], 128)
        ? (value as unknown as PageCatalogReadMessage)
        : undefined;
    case "page/turn/cancel":
      return hasExactKeys(value, ["protocolVersion", "requestId", "sequence", "turnId", "type"]) &&
        isOpaqueId(value["requestId"], 128) &&
        isOpaqueId(value["turnId"], 128)
        ? (value as unknown as PageTurnCancelMessage)
        : undefined;
    case "page/turn/start":
      return isTurnStartMessage(value) ? (value as unknown as PageTurnStartMessage) : undefined;
    default:
      return undefined;
  }
}

export function parsePageEvent(value: unknown): PageEventMessage | undefined {
  if (!isEnvelope(value) || typeof value["type"] !== "string") {
    return undefined;
  }
  switch (value["type"]) {
    case "page/ready":
      return hasExactKeys(value, ["adapter", "protocolVersion", "sequence", "type"]) &&
        value["adapter"] === PAGE_ADAPTER_ID
        ? (value as unknown as PageReadyMessage)
        : undefined;
    case "page/catalog/result":
      return isCatalogResult(value) ? (value as unknown as PageCatalogResultMessage) : undefined;
    case "page/catalog/changed":
      return isCatalogChanged(value) ? (value as unknown as PageCatalogChangedMessage) : undefined;
    case "page/document/changed":
      return hasExactKeys(value, ["protocolVersion", "sequence", "type"])
        ? (value as unknown as PageDocumentChangedMessage)
        : undefined;
    case "page/turn/started":
      return hasExactKeys(value, ["protocolVersion", "requestId", "sequence", "turnId", "type"]) &&
        isOpaqueId(value["requestId"], 128) &&
        isOpaqueId(value["turnId"], 128)
        ? (value as unknown as PageTurnStartedMessage)
        : undefined;
    case "page/turn/delta":
      return hasExactKeys(value, ["delta", "protocolVersion", "sequence", "turnId", "type"]) &&
        typeof value["delta"] === "string" &&
        value["delta"].length >= 1 &&
        value["delta"].length <= MAX_DELTA_CHARACTERS &&
        isOpaqueId(value["turnId"], 128)
        ? (value as unknown as PageTurnDeltaMessage)
        : undefined;
    case "page/turn/completed":
      return hasExactKeys(value, ["protocolVersion", "sequence", "turnId", "type"]) &&
        isOpaqueId(value["turnId"], 128)
        ? (value as unknown as PageTurnCompletedMessage)
        : undefined;
    case "page/turn/cancelled":
      return hasExactKeys(value, ["protocolVersion", "requestId", "sequence", "turnId", "type"]) &&
        isOpaqueId(value["requestId"], 128) &&
        isOpaqueId(value["turnId"], 128)
        ? (value as unknown as PageTurnCancelledMessage)
        : undefined;
    case "page/command/failed":
      return isCommandFailure(value) ? (value as unknown as PageCommandFailedMessage) : undefined;
    default:
      return undefined;
  }
}

function isTurnStartMessage(value: Record<string, unknown>): boolean {
  if (
    !hasExactKeys(value, [
      "catalogRevision",
      "input",
      "modelId",
      "protocolVersion",
      "reasoningEffort",
      "requestId",
      "sequence",
      "temporary",
      "turnId",
      "type",
    ]) ||
    !isOpaqueId(value["catalogRevision"], 128) ||
    !isModelId(value["modelId"]) ||
    !isOpaqueId(value["reasoningEffort"], 64) ||
    !isOpaqueId(value["requestId"], 128) ||
    value["temporary"] !== false ||
    !isOpaqueId(value["turnId"], 128) ||
    !Array.isArray(value["input"]) ||
    value["input"].length !== 1
  ) {
    return false;
  }
  let total = 0;
  for (const item of value["input"]) {
    if (
      !hasExactKeys(item, ["text", "type"]) ||
      item["type"] !== "text" ||
      typeof item["text"] !== "string" ||
      item["text"].length < 1 ||
      item["text"].length > MAX_INPUT_ITEM_CHARACTERS
    ) {
      return false;
    }
    total += item["text"].length;
  }
  return total <= MAX_INPUT_TOTAL_CHARACTERS;
}

function isCatalogResult(value: Record<string, unknown>): boolean {
  if (
    !hasExactKeys(value, [
      "catalogRevision",
      "models",
      "protocolVersion",
      "requestId",
      "sequence",
      "type",
    ]) ||
    !isOpaqueId(value["catalogRevision"], 128) ||
    !isOpaqueId(value["requestId"], 128) ||
    !isCatalog(value["models"])
  ) {
    return false;
  }
  return true;
}

function isCatalogChanged(value: Record<string, unknown>): boolean {
  return (
    hasExactKeys(value, ["catalogRevision", "models", "protocolVersion", "sequence", "type"]) &&
    isOpaqueId(value["catalogRevision"], 128) &&
    isCatalog(value["models"])
  );
}

function isCatalog(value: unknown): value is readonly WebModelDescriptor[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CATALOG_MODELS) {
    return false;
  }
  const ids = new Set<string>();
  for (const model of value) {
    if (!isModel(model) || ids.has(model.id)) {
      return false;
    }
    ids.add(model.id);
  }
  return true;
}

function isModel(value: unknown): value is WebModelDescriptor {
  if (
    !hasExactKeys(value, [
      "defaultReasoningEffort",
      "displayName",
      "id",
      "inputModalities",
      "supportedReasoningEfforts",
    ]) ||
    !isModelId(value["id"]) ||
    !isSafeSingleLineText(value["displayName"], 128) ||
    !Array.isArray(value["inputModalities"]) ||
    value["inputModalities"].length !== 1 ||
    value["inputModalities"][0] !== "text" ||
    value["defaultReasoningEffort"] !== PAGE_DEFAULT_REASONING_EFFORT ||
    !Array.isArray(value["supportedReasoningEfforts"]) ||
    value["supportedReasoningEfforts"].length !== 1
  ) {
    return false;
  }
  const options = value["supportedReasoningEfforts"] as unknown[];
  const option: unknown = options[0];
  return (
    hasExactKeys(option, ["description", "reasoningEffort"]) &&
    option["reasoningEffort"] === PAGE_DEFAULT_REASONING_EFFORT &&
    isSafeSingleLineText(option["description"], 256)
  );
}

function isCommandFailure(value: Record<string, unknown>): boolean {
  return (
    hasExactKeys(
      value,
      ["code", "message", "protocolVersion", "requestId", "retryable", "sequence", "type"],
      ["turnId"],
    ) &&
    isFailureCode(value["code"]) &&
    isSafeSingleLineText(value["message"], MAX_SAFE_MESSAGE_CHARACTERS) &&
    isOpaqueId(value["requestId"], 128) &&
    typeof value["retryable"] === "boolean" &&
    (value["turnId"] === undefined || isOpaqueId(value["turnId"], 128))
  );
}

function isEnvelope(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record["protocolVersion"] === PAGE_PROTOCOL_VERSION && isSequence(record["sequence"]);
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
    /^ui-[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?-[a-f0-9]{24}$/u.test(value)
  );
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFailureCode(value: unknown): value is PageFailureCode {
  return (
    value === "adapter_unavailable" ||
    value === "browser_state_changed" ||
    value === "model_unavailable" ||
    value === "turn_already_active" ||
    value === "turn_not_found" ||
    value === "unsupported"
  );
}

function isSafeSingleLineText(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return false;
    }
  }
  return true;
}
