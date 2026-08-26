import { createHash, randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";

import type { JsonObject } from "@gpt-session-bridge/protocol";

import {
  AgentSessionCoordinator,
  AgentSessionCoordinatorError,
  type AgentBrowserTurnBoundary,
  type AgentCertifiedTool,
} from "../browser/agent-session-coordinator.js";
import {
  BrowserSessionAgentBoundary,
  type BrowserSessionAgentBoundaryOptions,
} from "../browser/browser-session-agent-boundary.js";
import type { ResolvedBrowserModelRoute } from "../browser/browser-model-catalog.js";
import { matchesCertifiedToolArguments } from "../tooling/certified-tool-schema.js";
import {
  projectCodexResponsesV2Continuation,
  projectCodexResponsesV2Initial,
  type CodexResponsesV2ContractBinding,
} from "./codex-responses-v2-contract.js";
import { ResponsesV2AgentSessionAdapter } from "./responses-v2-agent-session-adapter.js";
import type {
  ResolvedResponsesModelRoute,
  ResponsesAgentHttpHandler,
  ResponsesAgentHttpRequest,
} from "./responses-server.js";
import {
  ResponsesServerV2,
  type ResponsesV2CertifiedToolProfile,
  type ResponsesV2CommittedToolCall,
  type ResponsesV2InitialRequest,
  type ResponsesV2Lifecycle,
} from "./responses-server-v2.js";

const DEFAULT_MAX_PENDING_WORKFLOWS = 32;
const DEFAULT_PENDING_TTL_MS = 5 * 60 * 1_000;
const MAX_PENDING_WORKFLOWS = 256;
const MAX_PENDING_TTL_MS = 15 * 60 * 1_000;
const IDENTIFIER_BYTES = 18;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;
const HTTP_SERVICE_UNAVAILABLE = 503;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";

type RuntimeCoordinator = Pick<
  AgentSessionCoordinator,
  "cancelActive" | "close" | "continueWorkflow" | "startWorkflow"
>;

export interface ResponsesAgentRuntimeBoundaryContext {
  readonly providerRoute: string;
  readonly route: ResolvedBrowserModelRoute;
}

export interface ResponsesAgentRuntimeOptions {
  readonly browserCoordinator?: BrowserSessionAgentBoundaryOptions["coordinator"];
  readonly classifyToolResult?: (tool: string, output: string) => boolean | undefined;
  readonly createBoundary?: (
    context: ResponsesAgentRuntimeBoundaryContext,
  ) => AgentBrowserTurnBoundary;
  readonly createCoordinator?: (boundary: AgentBrowserTurnBoundary) => RuntimeCoordinator;
  readonly createRandomBytes?: (size: number) => Uint8Array;
  readonly createResponsesBoundary?: (
    profile: ResponsesV2CertifiedToolProfile,
  ) => ResponsesServerV2;
  readonly maxPendingWorkflows?: number;
  readonly now?: () => number;
  readonly pendingTtlMs?: number;
}

interface RequestBinding {
  readonly clientRequestId?: string;
  readonly model: string;
  readonly route: ResolvedResponsesModelRoute;
  readonly threadId?: string;
  readonly turnMetadata?: string;
}

interface PendingWorkflow {
  readonly adapter: ResponsesV2AgentSessionAdapter;
  readonly binding: RequestBinding;
  readonly call: ResponsesV2CommittedToolCall;
  readonly contract: CodexResponsesV2ContractBinding;
  readonly expiresAtMs: number;
  readonly initial: ResponsesV2InitialRequest;
  readonly server: ResponsesServerV2;
}

interface RuntimeSession {
  readonly adapter: ResponsesV2AgentSessionAdapter;
  readonly server: ResponsesServerV2;
}

interface RuntimeError {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

interface DisconnectGuard {
  readonly disconnected: boolean;
  commit(): void;
  release(): void;
}

/**
 * Activates the admitted v2 boundaries for one exact loopback Responses route.
 * It only relays committed function calls to the official Codex child; no tool
 * execution, approval, or sandbox policy is implemented in this process.
 */
export class ResponsesAgentRuntime implements ResponsesAgentHttpHandler {
  readonly #activeAdapters = new Set<ResponsesV2AgentSessionAdapter>();
  readonly #classifyToolResult: NonNullable<ResponsesAgentRuntimeOptions["classifyToolResult"]>;
  readonly #createBoundary: NonNullable<ResponsesAgentRuntimeOptions["createBoundary"]>;
  readonly #createCoordinator: NonNullable<ResponsesAgentRuntimeOptions["createCoordinator"]>;
  readonly #createRandomBytes: NonNullable<ResponsesAgentRuntimeOptions["createRandomBytes"]>;
  readonly #createResponsesBoundary: NonNullable<
    ResponsesAgentRuntimeOptions["createResponsesBoundary"]
  >;
  readonly #maxPendingWorkflows: number;
  readonly #now: NonNullable<ResponsesAgentRuntimeOptions["now"]>;
  readonly #pending = new Map<string, PendingWorkflow>();
  readonly #pendingTtlMs: number;
  #closed = false;
  #expiryTimer: NodeJS.Timeout | undefined;
  #inFlightWorkflows = 0;

  public constructor(options: ResponsesAgentRuntimeOptions) {
    const maxPendingWorkflows = options.maxPendingWorkflows ?? DEFAULT_MAX_PENDING_WORKFLOWS;
    const pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    if (
      !Number.isSafeInteger(maxPendingWorkflows) ||
      maxPendingWorkflows < 1 ||
      maxPendingWorkflows > MAX_PENDING_WORKFLOWS ||
      !Number.isSafeInteger(pendingTtlMs) ||
      pendingTtlMs < 1 ||
      pendingTtlMs > MAX_PENDING_TTL_MS
    ) {
      throw new RangeError("Invalid Responses Agent runtime limits.");
    }
    const now = options.now ?? Date.now;
    const createRandomBytes = options.createRandomBytes ?? randomBytes;
    if (typeof now !== "function" || typeof createRandomBytes !== "function") {
      throw new TypeError("Invalid Responses Agent runtime dependencies.");
    }
    const browserCoordinator = options.browserCoordinator;
    const createBoundary = options.createBoundary;
    if (createBoundary === undefined && browserCoordinator === undefined) {
      throw new TypeError("A browser Agent boundary is required.");
    }

    this.#classifyToolResult = options.classifyToolResult ?? (() => true);
    this.#createBoundary =
      createBoundary ??
      ((context) => {
        if (browserCoordinator === undefined) {
          throw new TypeError("A browser Agent boundary is required.");
        }
        return new BrowserSessionAgentBoundary({
          coordinator: browserCoordinator,
          providerRoute: context.providerRoute,
          route: context.route,
        });
      });
    this.#createCoordinator =
      options.createCoordinator ?? ((boundary) => new AgentSessionCoordinator(boundary, { now }));
    this.#createRandomBytes = createRandomBytes;
    this.#createResponsesBoundary =
      options.createResponsesBoundary ??
      ((profile) => new ResponsesServerV2({ toolProfile: profile }));
    this.#maxPendingWorkflows = maxPendingWorkflows;
    this.#now = now;
    this.#pendingTtlMs = pendingTtlMs;
  }

  public get pendingCount(): number {
    this.#pruneExpired();
    return this.#pending.size;
  }

  public async handleRequest(request: ResponsesAgentHttpRequest): Promise<void> {
    setSecurityHeaders(request.response);
    try {
      if (this.#closed) {
        writeError(request.response, unavailableError());
        return;
      }
      this.#pruneExpired();
      const decoded = decodeRequestBody(request.body);
      if (decoded === undefined) {
        writeError(request.response, invalidRequestError());
        return;
      }
      const continuation = readContinuationLookup(decoded);
      if (continuation.kind === "invalid") {
        writeError(request.response, continuationMismatchError());
        return;
      }
      if (continuation.kind === "continuation") {
        await this.#handleContinuation(request, decoded, continuation.callId);
        return;
      }
      await this.#handleInitial(request, decoded);
    } catch (error) {
      if (!request.response.headersSent) {
        writeError(request.response, mapRuntimeError(error));
      } else if (!request.response.destroyed) {
        request.response.destroy();
      }
    }
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#expiryTimer !== undefined) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = undefined;
    }
    for (const adapter of [...this.#activeAdapters]) {
      this.#closeAdapter(adapter);
    }
    this.#pending.clear();
  }

  async #handleInitial(request: ResponsesAgentHttpRequest, body: JsonObject): Promise<void> {
    if (!this.#reserveNewWorkflow()) {
      writeError(request.response, unavailableError());
      return;
    }

    let session: RuntimeSession | undefined;
    let retained = false;
    try {
      if (request.route.profile !== "agent-v2") {
        writeError(request.response, invalidRequestError());
        return;
      }
      const projected = projectCodexResponsesV2Initial(body, {
        ...(request.route.defaultReasoningEffort === undefined
          ? {}
          : { defaultReasoningEffort: request.route.defaultReasoningEffort }),
      });
      if (!projected.ok) {
        writeError(request.response, projectionError(projected.error.code, false));
        return;
      }
      const server = this.#createResponsesBoundary(projected.value.profile);
      const admitted = server.admitInitialRequest(projected.value.canonicalBody);
      if (!admitted.ok || admitted.value.model !== request.model) {
        writeError(
          request.response,
          admitted.ok ? invalidRequestError() : boundaryError(admitted.error.code, false),
        );
        return;
      }

      session = this.#createSession(request, admitted.value, projected.value.profile, server);
      const guard = observeDisconnect(request.response, () => {
        this.#closeAdapter(session?.adapter);
      });
      try {
        await yieldBeforeBrowserMutation();
        if (hasDisconnected(guard)) {
          return;
        }
        const outcome = await session.adapter.startWorkflow(admitted.value);
        if (hasDisconnected(guard)) {
          return;
        }
        const lifecycle = server.createLifecycle(admitted.value, outcome);
        if (!lifecycle.ok) {
          writeError(request.response, boundaryError(lifecycle.error.code, false));
          return;
        }
        if (!(await writeLifecycle(request.response, lifecycle.value, admitted.value.stream))) {
          return;
        }
        if (outcome.kind === "tool_call") {
          const entry = this.#createPendingWorkflow(
            request,
            projected.value,
            admitted.value,
            outcome,
            session,
          );
          if (!this.#insertPending(entry)) {
            writeErrorAfterUncommittedPayload(request.response);
            return;
          }
          retained = true;
        }
        guard.commit();
        request.response.end();
      } finally {
        guard.release();
      }
    } finally {
      this.#inFlightWorkflows -= 1;
      if (!retained && session !== undefined) {
        this.#closeAdapter(session.adapter);
      }
    }
  }

  async #handleContinuation(
    request: ResponsesAgentHttpRequest,
    body: JsonObject,
    callId: string,
  ): Promise<void> {
    const entry = this.#pending.get(callId);
    if (entry === undefined) {
      writeError(request.response, continuationMismatchError());
      return;
    }

    // Consume before any continuation validation. A mismatched, replayed, or
    // disconnected child request can never make the official child execute twice.
    this.#pending.delete(callId);
    this.#inFlightWorkflows += 1;
    this.#scheduleExpiry();
    let retained = false;
    try {
      if (!sameRequestBinding(entry.binding, request)) {
        writeError(request.response, continuationMismatchError());
        return;
      }
      const projected = projectCodexResponsesV2Continuation(body, entry.contract, {
        ...(entry.binding.route.defaultReasoningEffort === undefined
          ? {}
          : { defaultReasoningEffort: entry.binding.route.defaultReasoningEffort }),
      });
      if (!projected.ok) {
        writeError(request.response, projectionError(projected.error.code, true));
        return;
      }
      const admitted = entry.server.admitContinuationRequest(projected.value.canonicalBody, {
        committedCall: entry.call,
        initialRequest: entry.initial,
      });
      if (!admitted.ok) {
        writeError(request.response, boundaryError(admitted.error.code, true));
        return;
      }

      const guard = observeDisconnect(request.response, () => {
        this.#closeAdapter(entry.adapter);
      });
      try {
        await yieldBeforeBrowserMutation();
        if (hasDisconnected(guard)) {
          return;
        }
        const outcome = await entry.adapter.continueWorkflow(admitted.value);
        if (hasDisconnected(guard)) {
          return;
        }
        const lifecycle = entry.server.createLifecycle(admitted.value, outcome);
        if (!lifecycle.ok) {
          writeError(request.response, boundaryError(lifecycle.error.code, true));
          return;
        }
        if (!(await writeLifecycle(request.response, lifecycle.value, entry.initial.stream))) {
          return;
        }
        if (outcome.kind === "tool_call") {
          const next: PendingWorkflow = Object.freeze({
            ...entry,
            call: outcome,
            contract: freezeContractBinding(projected.value),
            expiresAtMs: this.#expiryAt(),
          });
          if (!this.#insertPending(next)) {
            writeErrorAfterUncommittedPayload(request.response);
            return;
          }
          retained = true;
        }
        guard.commit();
        request.response.end();
      } finally {
        guard.release();
      }
    } finally {
      this.#inFlightWorkflows -= 1;
      if (!retained) {
        this.#closeAdapter(entry.adapter);
      }
    }
  }

  #createSession(
    request: ResponsesAgentHttpRequest,
    initial: ResponsesV2InitialRequest,
    profile: ResponsesV2CertifiedToolProfile,
    server: ResponsesServerV2,
  ): RuntimeSession {
    const route = toBrowserRoute(request.route, initial.reasoningEffort);
    const boundary = this.#createBoundary(Object.freeze({ providerRoute: request.model, route }));
    const browser = boundary.readBinding();
    if (browser === undefined) {
      throw new AgentSessionCoordinatorError("tool_protocol_not_activated");
    }
    const coordinator = this.#createCoordinator(boundary);
    let adapter: ResponsesV2AgentSessionAdapter;
    try {
      adapter = new ResponsesV2AgentSessionAdapter({
        context: Object.freeze({
          browser,
          requestBindingId: this.#createIdentifier("request", request.clientRequestId),
          threadId: this.#createIdentifier("thread", request.threadId),
          tools: this.#createAgentTools(profile),
          turnId: this.#createIdentifier("turn", request.turnMetadata),
        }),
        coordinator,
      });
    } catch (error) {
      coordinator.close();
      throw error;
    }
    this.#activeAdapters.add(adapter);
    return Object.freeze({ adapter, server });
  }

  #createAgentTools(profile: ResponsesV2CertifiedToolProfile): readonly AgentCertifiedTool[] {
    return Object.freeze(
      profile.tools.map((tool) =>
        Object.freeze({
          classifyResult: (output: string) => this.#classifyToolResult(tool.name, output),
          description: tool.description,
          name: tool.name,
          parameters: tool.parameters,
          strict: tool.strict,
          validateArguments: (value: JsonObject) =>
            matchesCertifiedToolArguments(tool.parameters, value),
        }),
      ),
    );
  }

  #createIdentifier(kind: "request" | "thread" | "turn", source: string | undefined): string {
    const bytes = this.#createRandomBytes(IDENTIFIER_BYTES);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== IDENTIFIER_BYTES) {
      throw new TypeError("Invalid Responses Agent identifier source.");
    }
    const digest = createHash("sha256")
      .update(kind, "utf8")
      .update("\0", "utf8")
      .update(source ?? "", "utf8")
      .update("\0", "utf8")
      .update(bytes)
      .digest("base64url");
    return `${kind}-${digest}`;
  }

  #createPendingWorkflow(
    request: ResponsesAgentHttpRequest,
    contract: CodexResponsesV2ContractBinding,
    initial: ResponsesV2InitialRequest,
    call: ResponsesV2CommittedToolCall,
    session: RuntimeSession,
  ): PendingWorkflow {
    return Object.freeze({
      adapter: session.adapter,
      binding: freezeRequestBinding(request),
      call,
      contract: freezeContractBinding(contract),
      expiresAtMs: this.#expiryAt(),
      initial,
      server: session.server,
    });
  }

  #insertPending(entry: PendingWorkflow): boolean {
    if (this.#closed || this.#pending.has(entry.call.callId)) {
      this.#closeAdapter(entry.adapter);
      return false;
    }
    this.#pending.set(entry.call.callId, entry);
    try {
      this.#scheduleExpiry();
    } catch (error) {
      this.#pending.delete(entry.call.callId);
      this.#closeAdapter(entry.adapter);
      throw error;
    }
    return true;
  }

  #reserveNewWorkflow(): boolean {
    if (this.#pending.size + this.#inFlightWorkflows >= this.#maxPendingWorkflows) {
      return false;
    }
    this.#inFlightWorkflows += 1;
    return true;
  }

  #expiryAt(): number {
    const now = readNow(this.#now);
    if (now > Number.MAX_SAFE_INTEGER - this.#pendingTtlMs) {
      throw new RangeError("Invalid Responses Agent clock.");
    }
    return now + this.#pendingTtlMs;
  }

  #pruneExpired(): void {
    if (this.#closed || this.#pending.size === 0) {
      return;
    }
    const now = readNow(this.#now);
    for (const [callId, entry] of this.#pending) {
      if (entry.expiresAtMs <= now) {
        this.#pending.delete(callId);
        this.#closeAdapter(entry.adapter);
      }
    }
    this.#scheduleExpiry();
  }

  #scheduleExpiry(): void {
    if (this.#expiryTimer !== undefined) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = undefined;
    }
    if (this.#closed || this.#pending.size === 0) {
      return;
    }
    let expiresAtMs = Number.MAX_SAFE_INTEGER;
    for (const entry of this.#pending.values()) {
      expiresAtMs = Math.min(expiresAtMs, entry.expiresAtMs);
    }
    const delay = Math.max(1, expiresAtMs - readNow(this.#now));
    this.#expiryTimer = setTimeout(() => {
      this.#expiryTimer = undefined;
      try {
        this.#pruneExpired();
      } catch {
        this.close();
      }
    }, delay);
    this.#expiryTimer.unref();
  }

  #closeAdapter(adapter: ResponsesV2AgentSessionAdapter | undefined): void {
    if (adapter === undefined || !this.#activeAdapters.delete(adapter)) {
      return;
    }
    closeAdapter(adapter);
  }
}

function freezeContractBinding(
  binding: CodexResponsesV2ContractBinding,
): CodexResponsesV2ContractBinding {
  return Object.freeze({
    fingerprint: binding.fingerprint,
    historyFingerprint: binding.historyFingerprint,
  });
}

function decodeRequestBody(body: Buffer): JsonObject | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? (value as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}

function readContinuationLookup(
  body: JsonObject,
):
  | Readonly<{ kind: "continuation"; callId: string }>
  | Readonly<{ kind: "initial" }>
  | Readonly<{ kind: "invalid" }> {
  const input = body["input"];
  if (!Array.isArray(input) || input.length < 2) {
    return Object.freeze({ kind: "initial" });
  }
  const call = input.at(-2);
  const output = input.at(-1);
  const resemblesContinuation =
    (isRecord(call) && call["type"] === "function_call") ||
    (isRecord(output) && output["type"] === "function_call_output");
  if (!resemblesContinuation) {
    return Object.freeze({ kind: "initial" });
  }
  if (
    !isRecord(call) ||
    call["type"] !== "function_call" ||
    !isRecord(output) ||
    output["type"] !== "function_call_output" ||
    typeof call["call_id"] !== "string" ||
    output["call_id"] !== call["call_id"]
  ) {
    return Object.freeze({ kind: "invalid" });
  }
  return Object.freeze({ callId: call["call_id"], kind: "continuation" });
}

function freezeRequestBinding(request: ResponsesAgentHttpRequest): RequestBinding {
  return Object.freeze({
    ...(request.clientRequestId === undefined ? {} : { clientRequestId: request.clientRequestId }),
    model: request.model,
    route: Object.freeze({ ...request.route }),
    ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
    ...(request.turnMetadata === undefined ? {} : { turnMetadata: request.turnMetadata }),
  });
}

function sameRequestBinding(binding: RequestBinding, request: ResponsesAgentHttpRequest): boolean {
  const route = binding.route;
  return (
    binding.clientRequestId === request.clientRequestId &&
    binding.model === request.model &&
    binding.threadId === request.threadId &&
    binding.turnMetadata === request.turnMetadata &&
    route.catalogRevision === request.route.catalogRevision &&
    route.defaultReasoningEffort === request.route.defaultReasoningEffort &&
    route.modelId === request.route.modelId &&
    route.profile === request.route.profile &&
    route.sessionGeneration === request.route.sessionGeneration &&
    route.sessionId === request.route.sessionId
  );
}

function toBrowserRoute(
  route: ResolvedResponsesModelRoute,
  reasoningEffort: string,
): ResolvedBrowserModelRoute {
  return Object.freeze({
    catalogRevision: route.catalogRevision,
    defaultReasoningEffort: route.defaultReasoningEffort ?? reasoningEffort,
    modelId: route.modelId,
    profile: route.profile,
    sessionGeneration: route.sessionGeneration,
    sessionId: route.sessionId,
  });
}

function observeDisconnect(response: ServerResponse, onDisconnect: () => void): DisconnectGuard {
  let committed = false;
  let disconnected = response.destroyed || response.writableEnded;
  const onClose = (): void => {
    if (!committed) {
      disconnected = true;
      onDisconnect();
    }
  };
  response.once("close", onClose);
  return {
    get disconnected(): boolean {
      return disconnected || response.destroyed;
    },
    commit: () => {
      committed = true;
    },
    release: () => {
      response.off("close", onClose);
    },
  };
}

function hasDisconnected(guard: DisconnectGuard): boolean {
  return guard.disconnected;
}

async function writeLifecycle(
  response: ServerResponse,
  lifecycle: ResponsesV2Lifecycle,
  stream: boolean,
): Promise<boolean> {
  response.statusCode = HTTP_OK;
  response.setHeader("Connection", "close");
  response.setHeader("Content-Type", stream ? SSE_CONTENT_TYPE : JSON_CONTENT_TYPE);
  if (!stream) {
    return writeChunk(response, JSON.stringify(lifecycle.response));
  }
  for (const event of lifecycle.events) {
    if (!(await writeChunk(response, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))) {
      return false;
    }
  }
  return true;
}

async function writeChunk(response: ServerResponse, value: string): Promise<boolean> {
  if (response.destroyed || response.writableEnded) {
    return false;
  }
  if (response.write(value)) {
    return true;
  }
  return new Promise<boolean>((resolve) => {
    const done = (writable: boolean): void => {
      response.off("close", onClose);
      response.off("drain", onDrain);
      resolve(writable);
    };
    const onClose = (): void => {
      done(false);
    };
    const onDrain = (): void => {
      done(true);
    };
    response.once("close", onClose);
    response.once("drain", onDrain);
  });
}

function setSecurityHeaders(response: ServerResponse): void {
  if (!response.headersSent) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", JSON_CONTENT_TYPE);
    response.setHeader("X-Content-Type-Options", "nosniff");
  }
}

function writeError(response: ServerResponse, error: RuntimeError): void {
  if (response.destroyed || response.writableEnded || response.headersSent) {
    return;
  }
  setSecurityHeaders(response);
  response.statusCode = error.status;
  response.end(
    JSON.stringify({
      error: Object.freeze({ code: error.code, message: error.message, type: "bridge_error" }),
    }),
  );
}

function writeErrorAfterUncommittedPayload(response: ServerResponse): void {
  if (!response.destroyed) {
    response.destroy();
  }
}

function projectionError(code: string, continuation: boolean): RuntimeError {
  return continuation
    ? continuationMismatchError()
    : runtimeError(HTTP_BAD_REQUEST, code, "The Web Agent request is unsupported.");
}

function boundaryError(code: string, continuation: boolean): RuntimeError {
  return continuation || code === "child_continuation_mismatch"
    ? continuationMismatchError()
    : runtimeError(HTTP_BAD_REQUEST, code, "The Web Agent request is unsupported.");
}

function mapRuntimeError(error: unknown): RuntimeError {
  if (error instanceof AgentSessionCoordinatorError) {
    const status =
      error.code === "tool_protocol_not_activated"
        ? HTTP_SERVICE_UNAVAILABLE
        : error.code === "browser_state_changed" || error.code === "child_continuation_mismatch"
          ? HTTP_CONFLICT
          : HTTP_BAD_GATEWAY;
    return runtimeError(status, error.code, "The Web Agent workflow failed.");
  }
  return runtimeError(HTTP_BAD_GATEWAY, "agent_runtime_failed", "The Web Agent workflow failed.");
}

function invalidRequestError(): RuntimeError {
  return runtimeError(HTTP_BAD_REQUEST, "invalid_request", "The Web Agent request is unsupported.");
}

function continuationMismatchError(): RuntimeError {
  return runtimeError(
    HTTP_CONFLICT,
    "child_continuation_mismatch",
    "The Web Agent continuation was rejected.",
  );
}

function unavailableError(): RuntimeError {
  return runtimeError(
    HTTP_SERVICE_UNAVAILABLE,
    "agent_runtime_unavailable",
    "The Web Agent workflow is unavailable.",
  );
}

function runtimeError(status: number, code: string, message: string): RuntimeError {
  return Object.freeze({ code, message, status });
}

function closeAdapter(adapter: ResponsesV2AgentSessionAdapter): void {
  try {
    void adapter.cancelActive().catch(() => undefined);
  } catch {
    // Teardown is terminal and never retried.
  }
  try {
    adapter.close();
  } catch {
    // Teardown remains terminal even if a dependency throws.
  }
}

function readNow(source: () => number): number {
  const now = source();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("Invalid Responses Agent clock.");
  }
  return now;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function yieldBeforeBrowserMutation(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
