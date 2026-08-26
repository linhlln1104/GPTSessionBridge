import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  createLocalhostPolicy,
  evaluateLocalRequest,
  LOOPBACK_IPV4_ADDRESS,
  type CapabilityToken,
  verifyCapabilityToken,
} from "@gpt-session-bridge/core/security";
import {
  BRIDGE_ERROR_CODES,
  MAX_TURN_INPUT_TEXT_CHARACTERS,
  MAX_TURN_INPUT_TOTAL_CHARACTERS,
  catalogRevisionSchema,
  modelIdSchema,
  reasoningEffortSchema,
  sessionIdSchema,
  type BridgeErrorCode,
} from "@gpt-session-bridge/protocol";

import type {
  BrowserTurnHandle,
  BrowserTurnDelta,
  BrowserTurnRequest,
  BrowserTurnSink,
  BrowserTurnTerminal,
} from "../browser/browser-session-coordinator.js";
import type { BrowserModelTarget } from "../browser/browser-model-route.js";
import { BrowserSessionError } from "../browser/browser-session-errors.js";

export const SESSION_NOT_CONNECTED_CODE = "session_not_connected" as const;

const INVALID_REQUEST_CODE = "invalid_request";
const UNSUPPORTED_REQUEST_CODE = "unsupported_request";
const UNSUPPORTED_INPUT_CODE = "unsupported_input";
const UNSUPPORTED_TOOLS_CODE = "unsupported_tools";
const MODEL_NOT_FOUND_CODE = "model_not_found";
const RESPONSE_TOO_LARGE_CODE = "response_too_large";
const UNSUPPORTED_OUTPUT_CODE = "unsupported_output";
const INTERNAL_ERROR_CODE = "internal_error";
const RESPONSES_PATH = "/v1/responses";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";
const MAX_MODEL_CHARACTERS = 256;
const MAX_RESPONSE_ID_BYTES = 18;
const MAX_HTTP_HEADERS = 64;
const SINGLE_REQUEST_PER_SOCKET = 1;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_CONTENT_TOO_LARGE = 413;
const HTTP_UNSUPPORTED_MEDIA_TYPE = 415;
const HTTP_BAD_GATEWAY = 502;
const HTTP_SERVICE_UNAVAILABLE = 503;

const TOP_LEVEL_REQUEST_KEYS = new Set([
  "include",
  "input",
  "model",
  "parallel_tool_calls",
  "previous_response_id",
  "reasoning",
  "store",
  "stream",
  "stream_options",
  "text",
  "tool_choice",
  "tools",
]);
const MESSAGE_KEYS = new Set(["content", "role", "type"]);
const INPUT_TEXT_KEYS = new Set(["text", "type"]);
const REASONING_KEYS = new Set(["effort", "summary"]);
const TEXT_KEYS = new Set(["format"]);
const TEXT_FORMAT_KEYS = new Set(["type"]);
const STREAM_OPTIONS_KEYS = new Set(["include_obfuscation"]);
const INVALID_REASONING = Symbol("invalidReasoning");

export interface ResolvedResponsesModelRoute extends BrowserModelTarget {
  readonly defaultReasoningEffort?: string;
  readonly sessionGeneration: number;
  readonly sessionId: string;
}

export interface ResponsesTurnCoordinator {
  startTurn(request: BrowserTurnRequest, sink?: BrowserTurnSink): BrowserTurnHandle;
}

export interface ResponsesServerOptions {
  readonly coordinator: ResponsesTurnCoordinator;
  readonly headerTimeoutMs: number;
  readonly maxBodyBytes: number;
  readonly maxConnections: number;
  readonly maxOutputBytes: number;
  readonly requestTimeoutMs: number;
  readonly resolveModelRoute: (providerModel: string) => ResolvedResponsesModelRoute | undefined;
  readonly token: CapabilityToken;
}

export interface ResponsesServerAddress {
  readonly baseUrl: string;
  readonly port: number;
}

interface ParsedResponsesRequest {
  readonly input: BrowserTurnRequest["input"];
  readonly model: string;
  readonly requestedReasoningEffort?: string;
  readonly stream: boolean;
}

interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

interface ResponseIdentity {
  readonly createdAt: number;
  readonly messageId: string;
  readonly responseId: string;
}

interface SseSequence {
  next: number;
}

export class ResponsesServer {
  readonly #options: ResponsesServerOptions;
  #address: ResponsesServerAddress | undefined;
  #server: Server | undefined;

  public constructor(options: ResponsesServerOptions) {
    if (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes < 1) {
      throw new RangeError("Invalid body limit");
    }
    if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) {
      throw new RangeError("Invalid output limit");
    }
    if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1) {
      throw new RangeError("Invalid request timeout");
    }
    if (!Number.isSafeInteger(options.headerTimeoutMs) || options.headerTimeoutMs < 1) {
      throw new RangeError("Invalid header timeout");
    }
    if (!Number.isSafeInteger(options.maxConnections) || options.maxConnections < 1) {
      throw new RangeError("Invalid connection limit");
    }
    if (
      typeof options.coordinator.startTurn !== "function" ||
      typeof options.resolveModelRoute !== "function"
    ) {
      throw new RangeError("Invalid Responses server dependencies");
    }
    this.#options = options;
  }

  public get address(): ResponsesServerAddress {
    if (this.#address === undefined) {
      throw new Error("Responses server is not listening");
    }
    return this.#address;
  }

  public async start(): Promise<ResponsesServerAddress> {
    if (this.#server !== undefined) {
      throw new Error("Responses server is already started");
    }

    const server = createServer((request, response) => {
      request.socket.setTimeout(this.#options.requestTimeoutMs);
      void this.#handle(request, response).catch(() => {
        if (!response.headersSent) {
          writeError(
            response,
            apiError(HTTP_BAD_GATEWAY, INTERNAL_ERROR_CODE, "Local provider request failed."),
          );
        } else {
          response.destroy();
        }
      });
    });
    server.headersTimeout = this.#options.headerTimeoutMs;
    server.keepAliveTimeout = this.#options.headerTimeoutMs;
    server.maxConnections = this.#options.maxConnections;
    server.maxHeadersCount = MAX_HTTP_HEADERS;
    server.maxRequestsPerSocket = SINGLE_REQUEST_PER_SOCKET;
    server.requestTimeout = this.#options.requestTimeoutMs;
    server.on("connection", (socket) => {
      socket.setTimeout(this.#options.headerTimeoutMs, () => {
        socket.destroy();
      });
    });
    this.#server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, LOOPBACK_IPV4_ADDRESS, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch {
      this.#server = undefined;
      throw new Error("Responses server failed to bind");
    }

    const boundAddress = server.address();
    if (boundAddress === null || typeof boundAddress === "string") {
      await this.close();
      throw new Error("Responses server failed to bind");
    }
    this.#address = Object.freeze({
      baseUrl: `http://${LOOPBACK_IPV4_ADDRESS}:${String(boundAddress.port)}/v1`,
      port: boundAddress.port,
    });
    return this.#address;
  }

  public async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#address = undefined;
    if (server === undefined) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", JSON_CONTENT_TYPE);
    response.setHeader("X-Content-Type-Options", "nosniff");

    const policy = createLocalhostPolicy(this.address.port);
    const localDecision = evaluateLocalRequest(policy, {
      host: request.headers.host,
      origin: request.headers.origin,
    });
    if (!localDecision.allowed) {
      request.resume();
      writeError(response, apiError(HTTP_FORBIDDEN, "request_rejected", "Local request rejected."));
      return;
    }

    if (!verifyCapabilityToken(readBearerToken(request), this.#options.token)) {
      request.resume();
      response.setHeader("WWW-Authenticate", "Bearer");
      writeError(
        response,
        apiError(HTTP_UNAUTHORIZED, "invalid_capability", "Capability token required."),
      );
      return;
    }

    if (request.method !== "POST" || request.url !== RESPONSES_PATH) {
      request.resume();
      writeError(response, apiError(HTTP_NOT_FOUND, "not_found", "Route not found."));
      return;
    }

    if (!isJsonContentType(request.headers["content-type"])) {
      request.resume();
      writeError(
        response,
        apiError(
          HTTP_UNSUPPORTED_MEDIA_TYPE,
          INVALID_REQUEST_CODE,
          "Content-Type must be application/json.",
        ),
      );
      return;
    }

    const declaredLength = readContentLength(request);
    if (declaredLength === "invalid") {
      request.resume();
      writeError(
        response,
        apiError(HTTP_BAD_REQUEST, INVALID_REQUEST_CODE, "Content-Length is invalid."),
      );
      return;
    }
    if (declaredLength !== undefined && declaredLength > this.#options.maxBodyBytes) {
      request.resume();
      writeError(
        response,
        apiError(HTTP_CONTENT_TOO_LARGE, "request_too_large", "Request body is too large."),
      );
      return;
    }

    const body = await readBoundedBody(request, this.#options.maxBodyBytes);
    if (body === undefined) {
      writeError(
        response,
        apiError(HTTP_CONTENT_TOO_LARGE, "request_too_large", "Request body is too large."),
      );
      return;
    }
    const parsedBody = parseJsonObject(body);
    if (parsedBody === undefined) {
      writeError(
        response,
        apiError(HTTP_BAD_REQUEST, INVALID_REQUEST_CODE, "Request body must be a JSON object."),
      );
      return;
    }
    const parsedRequest = parseResponsesRequest(parsedBody);
    if ("error" in parsedRequest) {
      writeError(response, parsedRequest.error);
      return;
    }

    let route: ResolvedResponsesModelRoute | undefined;
    try {
      route = this.#options.resolveModelRoute(parsedRequest.value.model);
    } catch {
      route = undefined;
    }
    const validatedRoute = validateResolvedRoute(route);
    if (validatedRoute === undefined) {
      writeError(
        response,
        apiError(HTTP_BAD_REQUEST, MODEL_NOT_FOUND_CODE, "The requested Web model is unavailable."),
      );
      return;
    }
    const reasoningEffort =
      parsedRequest.value.requestedReasoningEffort ?? validatedRoute.defaultReasoningEffort;
    const parsedEffort = reasoningEffortSchema.safeParse(reasoningEffort);
    if (!parsedEffort.success) {
      writeError(
        response,
        apiError(
          HTTP_BAD_REQUEST,
          INVALID_REQUEST_CODE,
          "A supported reasoning effort is required.",
        ),
      );
      return;
    }

    await this.#runTurn(response, parsedRequest.value, validatedRoute, parsedEffort.data);
  }

  async #runTurn(
    response: ServerResponse,
    request: ParsedResponsesRequest,
    route: ResolvedResponsesModelRoute,
    reasoningEffort: string,
  ): Promise<void> {
    const identity = createResponseIdentity();
    const sseSequence: SseSequence = { next: 0 };
    let handle: BrowserTurnHandle | undefined;
    const cancellation = { requested: false };
    let responseFinished = false;
    let output = "";
    let outputBytes = 0;
    let outputFailure: ApiError | undefined;
    let releaseInitialStream: (() => void) | undefined;
    const initialStreamWritten = request.stream
      ? new Promise<void>((resolve) => {
          releaseInitialStream = resolve;
        })
      : Promise.resolve();
    const clientDisconnected = (): boolean =>
      cancellation.requested || response.destroyed || response.writableEnded;

    const cancelTurn = (): void => {
      cancellation.requested = true;
      if (handle !== undefined) {
        try {
          void handle.cancel().catch(() => undefined);
        } catch {
          // A disconnected client does not receive cancellation diagnostics.
        }
      }
    };
    const onResponseClose = (): void => {
      if (!responseFinished && !response.writableEnded) {
        cancelTurn();
      }
    };
    response.once("close", onResponseClose);

    // Give a disconnect that arrived with the completed request body one event-loop
    // turn to update ServerResponse before the irreversible browser submission.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    if (clientDisconnected()) {
      response.off("close", onResponseClose);
      return;
    }

    const sink: BrowserTurnSink = Object.freeze({
      onDelta: async (delta: BrowserTurnDelta): Promise<void> => {
        await initialStreamWritten;
        if (outputFailure !== undefined || response.destroyed) {
          return;
        }
        if (delta.channel !== "outputText") {
          outputFailure = apiError(
            HTTP_BAD_GATEWAY,
            UNSUPPORTED_OUTPUT_CODE,
            "The Web session returned an unsupported output channel.",
          );
          cancelTurn();
          return;
        }
        const deltaBytes = Buffer.byteLength(delta.delta, "utf8");
        if (deltaBytes > this.#options.maxOutputBytes - outputBytes) {
          outputFailure = apiError(
            HTTP_BAD_GATEWAY,
            RESPONSE_TOO_LARGE_CODE,
            "The Web response exceeded the local output limit.",
          );
          cancelTurn();
          return;
        }
        outputBytes += deltaBytes;
        output += delta.delta;
        if (request.stream) {
          await writeSse(response, sseSequence, "response.output_text.delta", {
            content_index: 0,
            delta: delta.delta,
            item_id: identity.messageId,
            output_index: 0,
            type: "response.output_text.delta",
          });
        }
      },
    });

    try {
      handle = this.#options.coordinator.startTurn(
        {
          catalogRevision: route.catalogRevision,
          input: request.input,
          modelId: route.modelId,
          reasoningEffort,
          sessionGeneration: route.sessionGeneration,
          sessionId: route.sessionId,
          temporary: false,
        },
        sink,
      );
      // Completion carries the terminal browser result. Observe the start
      // acknowledgement separately so a pre-ack failure cannot become an
      // unhandled rejection in the bridge process.
      void handle.started.catch(() => undefined);
    } catch (error) {
      response.off("close", onResponseClose);
      writeError(response, mapTurnStartError(error));
      return;
    }

    if (cancellation.requested) {
      cancelTurn();
    }
    if (request.stream) {
      response.statusCode = HTTP_OK;
      response.setHeader("Content-Type", SSE_CONTENT_TYPE);
      response.setHeader("Connection", "close");
      try {
        await writeInitialSse(response, sseSequence, identity, request.model, reasoningEffort);
      } finally {
        releaseInitialStream?.();
      }
    }

    const terminal = await handle.completion;
    if (response.destroyed) {
      response.off("close", onResponseClose);
      return;
    }
    const terminalError = outputFailure ?? mapTurnTerminal(terminal);
    if (request.stream) {
      if (terminalError === undefined) {
        await writeCompletedSse(
          response,
          sseSequence,
          identity,
          request.model,
          reasoningEffort,
          output,
        );
      } else {
        await writeFailedSse(
          response,
          sseSequence,
          identity,
          request.model,
          reasoningEffort,
          terminalError,
        );
      }
      responseFinished = true;
      response.end();
    } else if (terminalError === undefined) {
      responseFinished = true;
      writeJson(
        response,
        HTTP_OK,
        createCompletedResponse(identity, request.model, reasoningEffort, output),
      );
    } else {
      responseFinished = true;
      writeError(response, terminalError);
    }
    response.off("close", onResponseClose);
  }
}

function parseResponsesRequest(
  value: Readonly<Record<string, unknown>>,
): { readonly error: ApiError } | { readonly value: ParsedResponsesRequest } {
  if (!hasOnlyKeys(value, TOP_LEVEL_REQUEST_KEYS)) {
    return unsupportedRequest("The request contains unsupported fields.");
  }
  if (
    typeof value["model"] !== "string" ||
    !isBoundedTrimmedText(value["model"], MAX_MODEL_CHARACTERS)
  ) {
    return invalidRequest("A valid model is required.");
  }
  const parsedInput = parseTextInput(value["input"]);
  if (parsedInput === undefined) {
    return {
      error: apiError(
        HTTP_BAD_REQUEST,
        UNSUPPORTED_INPUT_CODE,
        "Only bounded user text input is supported.",
      ),
    };
  }
  if (value["stream"] !== undefined && typeof value["stream"] !== "boolean") {
    return invalidRequest("The stream field must be boolean.");
  }
  const reasoning = parseReasoning(value["reasoning"]);
  if (reasoning === INVALID_REASONING) {
    return unsupportedRequest("The reasoning configuration is unsupported.");
  }
  if (!isSupportedNoToolConfiguration(value)) {
    return {
      error: apiError(
        HTTP_BAD_REQUEST,
        UNSUPPORTED_TOOLS_CODE,
        "Tool calls are not supported by this Web provider.",
      ),
    };
  }
  if (!isSupportedResponseConfiguration(value)) {
    return unsupportedRequest("The requested Responses feature is unsupported.");
  }

  return {
    value: Object.freeze({
      input: parsedInput,
      model: value["model"],
      ...(reasoning === undefined ? {} : { requestedReasoningEffort: reasoning }),
      stream: value["stream"] === true,
    }),
  };
}

function parseTextInput(value: unknown): BrowserTurnRequest["input"] | undefined {
  const items: { readonly text: string; readonly type: "text" }[] = [];
  if (typeof value === "string") {
    if (!isBoundedText(value, MAX_TURN_INPUT_TEXT_CHARACTERS)) {
      return undefined;
    }
    items.push(Object.freeze({ text: value, type: "text" }));
  } else if (Array.isArray(value) && value.length > 0) {
    for (const message of value) {
      if (!isRecord(message) || !hasOnlyKeys(message, MESSAGE_KEYS)) {
        return undefined;
      }
      if (
        message["role"] !== "user" ||
        (message["type"] !== undefined && message["type"] !== "message")
      ) {
        return undefined;
      }
      const content = message["content"];
      if (typeof content === "string") {
        if (!isBoundedText(content, MAX_TURN_INPUT_TEXT_CHARACTERS)) {
          return undefined;
        }
        items.push(Object.freeze({ text: content, type: "text" }));
      } else if (Array.isArray(content) && content.length > 0) {
        for (const part of content) {
          if (
            !isRecord(part) ||
            !hasOnlyKeys(part, INPUT_TEXT_KEYS) ||
            part["type"] !== "input_text" ||
            typeof part["text"] !== "string" ||
            !isBoundedText(part["text"], MAX_TURN_INPUT_TEXT_CHARACTERS)
          ) {
            return undefined;
          }
          items.push(Object.freeze({ text: part["text"], type: "text" }));
        }
      } else {
        return undefined;
      }
      if (items.length > 1) {
        return undefined;
      }
    }
  } else {
    return undefined;
  }

  const totalCharacters = items.reduce((total, item) => total + item.text.length, 0);
  if (items.length !== 1 || totalCharacters > MAX_TURN_INPUT_TOTAL_CHARACTERS) {
    return undefined;
  }
  return items;
}

function parseReasoning(value: unknown): typeof INVALID_REASONING | string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, REASONING_KEYS)) {
    return INVALID_REASONING;
  }
  if (value["summary"] !== undefined && value["summary"] !== null) {
    return INVALID_REASONING;
  }
  const effort = value["effort"];
  return reasoningEffortSchema.safeParse(effort).success ? (effort as string) : INVALID_REASONING;
}

function isSupportedNoToolConfiguration(value: Readonly<Record<string, unknown>>): boolean {
  const tools = value["tools"];
  const toolChoice = value["tool_choice"];
  const parallel = value["parallel_tool_calls"];
  return (
    (tools === undefined || (Array.isArray(tools) && tools.length === 0)) &&
    (toolChoice === undefined || toolChoice === "none") &&
    (parallel === undefined || parallel === false)
  );
}

function isSupportedResponseConfiguration(value: Readonly<Record<string, unknown>>): boolean {
  const include = value["include"];
  if (include !== undefined && (!Array.isArray(include) || include.length !== 0)) {
    return false;
  }
  if (value["store"] !== undefined && value["store"] !== false) {
    return false;
  }
  if (value["previous_response_id"] !== undefined && value["previous_response_id"] !== null) {
    return false;
  }
  const text = value["text"];
  if (text !== undefined) {
    if (!isRecord(text) || !hasOnlyKeys(text, TEXT_KEYS)) {
      return false;
    }
    const format = text["format"];
    if (!isRecord(format) || !hasOnlyKeys(format, TEXT_FORMAT_KEYS) || format["type"] !== "text") {
      return false;
    }
  }
  const streamOptions = value["stream_options"];
  if (streamOptions !== undefined) {
    if (
      value["stream"] !== true ||
      !isRecord(streamOptions) ||
      !hasOnlyKeys(streamOptions, STREAM_OPTIONS_KEYS) ||
      streamOptions["include_obfuscation"] !== false
    ) {
      return false;
    }
  }
  return true;
}

function validateResolvedRoute(
  route: ResolvedResponsesModelRoute | undefined,
): ResolvedResponsesModelRoute | undefined {
  if (route === undefined) {
    return undefined;
  }
  const revision = catalogRevisionSchema.safeParse(route.catalogRevision);
  const model = modelIdSchema.safeParse(route.modelId);
  const defaultEffort =
    route.defaultReasoningEffort === undefined
      ? undefined
      : reasoningEffortSchema.safeParse(route.defaultReasoningEffort);
  const sessionId = sessionIdSchema.safeParse(route.sessionId);
  if (
    !revision.success ||
    !model.success ||
    defaultEffort?.success === false ||
    !sessionId.success ||
    !Number.isSafeInteger(route.sessionGeneration) ||
    route.sessionGeneration < 1
  ) {
    return undefined;
  }
  return Object.freeze({
    catalogRevision: revision.data,
    ...(defaultEffort === undefined ? {} : { defaultReasoningEffort: defaultEffort.data }),
    modelId: model.data,
    sessionGeneration: route.sessionGeneration,
    sessionId: sessionId.data,
  });
}

function mapTurnStartError(error: unknown): ApiError {
  if (!(error instanceof BrowserSessionError)) {
    return apiError(HTTP_BAD_GATEWAY, INTERNAL_ERROR_CODE, "The Web turn could not be started.");
  }
  return mapBridgeError(error.code);
}

function mapTurnTerminal(terminal: BrowserTurnTerminal): ApiError | undefined {
  if (terminal.kind === "completed") {
    return terminal.finishReason === "stop"
      ? undefined
      : apiError(
          HTTP_BAD_GATEWAY,
          "response_incomplete",
          "The Web response ended before completion.",
        );
  }
  if (terminal.kind === "cancelled") {
    return apiError(HTTP_CONFLICT, "turn_cancelled", "The Web turn was cancelled.");
  }
  return mapBridgeError(terminal.error.code);
}

function mapBridgeError(code: BridgeErrorCode): ApiError {
  switch (code) {
    case BRIDGE_ERROR_CODES.SESSION_NOT_CONNECTED:
    case BRIDGE_ERROR_CODES.SESSION_CLOSED:
    case BRIDGE_ERROR_CODES.TRANSPORT_UNAVAILABLE:
    case BRIDGE_ERROR_CODES.BROWSER_UNAVAILABLE:
      return apiError(
        HTTP_SERVICE_UNAVAILABLE,
        SESSION_NOT_CONNECTED_CODE,
        "No explicitly connected ChatGPT Web tab is available.",
      );
    case BRIDGE_ERROR_CODES.CAPABILITY_UNSUPPORTED:
    case BRIDGE_ERROR_CODES.MODEL_UNAVAILABLE:
    case BRIDGE_ERROR_CODES.BROWSER_STATE_CHANGED:
      return apiError(
        HTTP_CONFLICT,
        "web_route_unavailable",
        "The selected Web route is no longer available.",
      );
    case BRIDGE_ERROR_CODES.TURN_ALREADY_ACTIVE:
      return apiError(HTTP_CONFLICT, "turn_already_active", "Another Web turn is already active.");
    case BRIDGE_ERROR_CODES.TURN_CANCELLED:
      return apiError(HTTP_CONFLICT, "turn_cancelled", "The Web turn was cancelled.");
    case BRIDGE_ERROR_CODES.TRANSPORT_TIMEOUT:
      return apiError(HTTP_SERVICE_UNAVAILABLE, "web_timeout", "The Web turn timed out.");
    case BRIDGE_ERROR_CODES.PROTOCOL_INVALID_MESSAGE:
    case BRIDGE_ERROR_CODES.PROTOCOL_UNSUPPORTED_VERSION:
    case BRIDGE_ERROR_CODES.PROTOCOL_SEQUENCE_VIOLATION:
    case BRIDGE_ERROR_CODES.SESSION_ALREADY_CONNECTED:
    case BRIDGE_ERROR_CODES.TURN_NOT_FOUND:
    case BRIDGE_ERROR_CODES.INTERNAL_ERROR:
      return apiError(HTTP_BAD_GATEWAY, INTERNAL_ERROR_CODE, "The Web turn failed.");
  }
}

function createResponseIdentity(): ResponseIdentity {
  return Object.freeze({
    createdAt: Math.floor(Date.now() / 1_000),
    messageId: `msg_${randomBytes(MAX_RESPONSE_ID_BYTES).toString("base64url")}`,
    responseId: `resp_${randomBytes(MAX_RESPONSE_ID_BYTES).toString("base64url")}`,
  });
}

function createResponseBase(
  identity: ResponseIdentity,
  model: string,
  reasoningEffort: string,
  status: "completed" | "failed" | "in_progress",
  output: readonly unknown[],
  error: { readonly code: string; readonly message: string } | null = null,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    created_at: identity.createdAt,
    error,
    id: identity.responseId,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    metadata: Object.freeze({}),
    model,
    object: "response",
    output,
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: Object.freeze({ effort: reasoningEffort, summary: null }),
    status,
    store: false,
    temperature: null,
    text: Object.freeze({ format: Object.freeze({ type: "text" }) }),
    tool_choice: "none",
    tools: Object.freeze([]),
    top_p: null,
    truncation: "disabled",
    usage: null,
  });
}

function createOutputMessage(
  identity: ResponseIdentity,
  text: string,
  status: "completed" | "in_progress",
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    content: Object.freeze([
      Object.freeze({ annotations: Object.freeze([]), text, type: "output_text" }),
    ]),
    id: identity.messageId,
    role: "assistant",
    status,
    type: "message",
  });
}

function createCompletedResponse(
  identity: ResponseIdentity,
  model: string,
  reasoningEffort: string,
  text: string,
): Readonly<Record<string, unknown>> {
  return createResponseBase(
    identity,
    model,
    reasoningEffort,
    "completed",
    Object.freeze([createOutputMessage(identity, text, "completed")]),
  );
}

async function writeInitialSse(
  response: ServerResponse,
  sequence: SseSequence,
  identity: ResponseIdentity,
  model: string,
  reasoningEffort: string,
): Promise<void> {
  const created = createResponseBase(
    identity,
    model,
    reasoningEffort,
    "in_progress",
    Object.freeze([]),
  );
  await writeSse(response, sequence, "response.created", {
    response: created,
    type: "response.created",
  });
  await writeSse(response, sequence, "response.in_progress", {
    response: created,
    type: "response.in_progress",
  });
  await writeSse(response, sequence, "response.output_item.added", {
    item: Object.freeze({
      content: Object.freeze([]),
      id: identity.messageId,
      role: "assistant",
      status: "in_progress",
      type: "message",
    }),
    output_index: 0,
    type: "response.output_item.added",
  });
  await writeSse(response, sequence, "response.content_part.added", {
    content_index: 0,
    item_id: identity.messageId,
    output_index: 0,
    part: Object.freeze({ annotations: Object.freeze([]), text: "", type: "output_text" }),
    type: "response.content_part.added",
  });
}

async function writeCompletedSse(
  response: ServerResponse,
  sequence: SseSequence,
  identity: ResponseIdentity,
  model: string,
  reasoningEffort: string,
  text: string,
): Promise<void> {
  const part = Object.freeze({ annotations: Object.freeze([]), text, type: "output_text" });
  const message = createOutputMessage(identity, text, "completed");
  await writeSse(response, sequence, "response.output_text.done", {
    content_index: 0,
    item_id: identity.messageId,
    output_index: 0,
    text,
    type: "response.output_text.done",
  });
  await writeSse(response, sequence, "response.content_part.done", {
    content_index: 0,
    item_id: identity.messageId,
    output_index: 0,
    part,
    type: "response.content_part.done",
  });
  await writeSse(response, sequence, "response.output_item.done", {
    item: message,
    output_index: 0,
    type: "response.output_item.done",
  });
  await writeSse(response, sequence, "response.completed", {
    response: createCompletedResponse(identity, model, reasoningEffort, text),
    type: "response.completed",
  });
}

async function writeFailedSse(
  response: ServerResponse,
  sequence: SseSequence,
  identity: ResponseIdentity,
  model: string,
  reasoningEffort: string,
  error: ApiError,
): Promise<void> {
  await writeSse(response, sequence, "response.failed", {
    response: createResponseBase(
      identity,
      model,
      reasoningEffort,
      "failed",
      Object.freeze([]),
      Object.freeze({ code: error.code, message: error.message }),
    ),
    type: "response.failed",
  });
}

async function writeSse(
  response: ServerResponse,
  sequence: SseSequence,
  event: string,
  data: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  let release: (() => void) | undefined;
  const writable = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = (): void => {
    response.off("close", done);
    response.off("drain", done);
    release?.();
  };
  response.once("close", done);
  response.once("drain", done);
  try {
    const payload = { ...data, sequence_number: sequence.next };
    sequence.next += 1;
    if (response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)) {
      done();
    }
  } catch (error) {
    done();
    throw error;
  }
  await writable;
}

function parseJsonObject(body: Buffer): Readonly<Record<string, unknown>> | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readContentLength(request: IncomingMessage): number | "invalid" | undefined {
  const value = request.headers["content-length"];
  if (value === undefined) {
    return undefined;
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    return "invalid";
  }
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : "invalid";
}

function readBearerToken(request: IncomingMessage): unknown {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return undefined;
  }
  const token = authorization.slice("Bearer ".length);
  return token.length > 0 && !token.includes(" ") ? token : undefined;
}

async function readBoundedBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<Buffer | undefined> {
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  for await (const rawChunk of request) {
    const chunk: unknown = rawChunk;
    const buffer =
      typeof chunk === "string"
        ? Buffer.from(chunk, "utf8")
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : undefined;
    if (buffer === undefined) {
      throw new TypeError("Invalid request chunk");
    }
    receivedBytes += buffer.byteLength;
    if (receivedBytes > maxBodyBytes) {
      request.resume();
      return undefined;
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks, receivedBytes);
}

function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu.test(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedText(value: string, maxCharacters: number): boolean {
  return value.length > 0 && value.length <= maxCharacters;
}

function isBoundedTrimmedText(value: string, maxCharacters: number): boolean {
  return isBoundedText(value, maxCharacters) && value.trim() === value;
}

function unsupportedRequest(message: string): { readonly error: ApiError } {
  return { error: apiError(HTTP_BAD_REQUEST, UNSUPPORTED_REQUEST_CODE, message) };
}

function invalidRequest(message: string): { readonly error: ApiError } {
  return { error: apiError(HTTP_BAD_REQUEST, INVALID_REQUEST_CODE, message) };
}

function apiError(status: number, code: string, message: string): ApiError {
  return Object.freeze({ code, message, status });
}

function writeError(response: ServerResponse, error: ApiError): void {
  writeJson(response, error.status, {
    error: Object.freeze({ code: error.code, message: error.message, type: "bridge_error" }),
  });
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.end(JSON.stringify(value));
}
