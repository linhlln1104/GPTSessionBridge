import { canonicalizeToolWorkflowJson, type JsonValue } from "@gpt-session-bridge/protocol";

import {
  AgentSessionCoordinatorError,
  type AgentBrowserBinding,
  type AgentCertifiedTool,
  type AgentChildRequestBinding,
  type AgentSessionCoordinator,
  type AgentWorkflowContinuationRequest,
  type AgentWorkflowOutcome,
  type AgentWorkflowStartRequest,
} from "../browser/agent-session-coordinator.js";
import type {
  ResponsesV2AgentSessionPort,
  ResponsesV2CommittedToolCall,
  ResponsesV2ContinuationRequest,
  ResponsesV2InitialRequest,
  ResponsesV2ValidatedOutcome,
} from "./responses-server-v2.js";

export interface ResponsesV2AgentSessionContext {
  readonly browser: AgentBrowserBinding;
  readonly requestBindingId: string;
  readonly threadId: string;
  readonly tools: readonly AgentCertifiedTool[];
  readonly turnId: string;
}

export interface ResponsesV2AgentSessionAdapterOptions {
  readonly context: ResponsesV2AgentSessionContext;
  readonly coordinator: Pick<
    AgentSessionCoordinator,
    "cancelActive" | "close" | "continueWorkflow" | "startWorkflow"
  >;
}

type AdapterPhase = "awaiting_continuation" | "busy" | "idle" | "terminal";

/**
 * One-shot typed interop boundary between admitted Responses requests and one
 * AgentSessionCoordinator workflow. It strips coordinator-private commit data,
 * consumes each pending call once, and never executes or approves a tool.
 */
export class ResponsesV2AgentSessionAdapter implements ResponsesV2AgentSessionPort {
  readonly #context: ResponsesV2AgentSessionContext;
  readonly #coordinator: ResponsesV2AgentSessionAdapterOptions["coordinator"];
  #initial: ResponsesV2InitialRequest | undefined;
  #pending: ResponsesV2CommittedToolCall | undefined;
  #phase: AdapterPhase = "idle";

  public constructor(options: ResponsesV2AgentSessionAdapterOptions) {
    if (!isAdapterOptions(options)) {
      throw new TypeError("Invalid Responses v2 agent-session adapter options.");
    }
    this.#context = options.context;
    this.#coordinator = options.coordinator;
  }

  public async startWorkflow(
    request: ResponsesV2InitialRequest,
  ): Promise<ResponsesV2ValidatedOutcome> {
    const requestKind: unknown = request.kind;
    if (this.#phase !== "idle" || requestKind !== "initial") {
      throw new AgentSessionCoordinatorError("tool_loop_incomplete");
    }
    this.#phase = "busy";
    this.#initial = request;
    try {
      const outcome = await this.#coordinator.startWorkflow(this.#createStartRequest(request));
      return this.#acceptOutcome(request, outcome);
    } catch (error) {
      this.#terminate();
      throw normalizeAdapterError(error, "tool_loop_incomplete");
    }
  }

  public async continueWorkflow(
    request: ResponsesV2ContinuationRequest,
  ): Promise<ResponsesV2ValidatedOutcome> {
    const initial = this.#initial;
    const pending = this.#pending;
    const requestKind: unknown = request.kind;
    if (
      this.#phase !== "awaiting_continuation" ||
      initial === undefined ||
      pending === undefined ||
      requestKind !== "continuation" ||
      request.initialRequest !== initial ||
      request.requestPrefixDigest !== initial.requestPrefixDigest ||
      request.call !== request.inputSuffix[0] ||
      request.functionCallOutput !== request.inputSuffix[1] ||
      !sameCommittedCallAndContinuation(pending, request)
    ) {
      return this.#rejectContinuation();
    }

    this.#phase = "busy";
    this.#pending = undefined;
    try {
      const outcome = await this.#coordinator.continueWorkflow(
        this.#createContinuationRequest(initial, request),
      );
      return this.#acceptOutcome(initial, outcome);
    } catch (error) {
      this.#terminate();
      throw normalizeAdapterError(error, "child_continuation_mismatch");
    }
  }

  public async cancelActive(): Promise<boolean> {
    if (this.#phase === "idle" || this.#phase === "terminal") {
      return false;
    }
    this.#terminate();
    return this.#coordinator.cancelActive();
  }

  public close(): void {
    this.#terminate();
    this.#coordinator.close();
  }

  #createStartRequest(request: ResponsesV2InitialRequest): AgentWorkflowStartRequest {
    return Object.freeze({
      browser: this.#context.browser,
      child: this.#childBinding(request),
      manifestDigest: request.manifestDigest,
      parallelToolCalls: false as const,
      profileVersion: request.profileVersion,
      reasoningEffort: request.reasoningEffort,
      temporary: false,
      tools: this.#context.tools,
      visibleRequest: Object.freeze({
        ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
        messages: Object.freeze(
          request.messages.map((message) =>
            Object.freeze({
              content: Object.freeze(message.content.map((part) => part.text)),
              role: message.role,
            }),
          ),
        ),
      }),
    });
  }

  #createContinuationRequest(
    initial: ResponsesV2InitialRequest,
    request: ResponsesV2ContinuationRequest,
  ): AgentWorkflowContinuationRequest {
    const items: AgentWorkflowContinuationRequest["items"] = [
      Object.freeze({
        argumentsJson: request.call.arguments,
        callId: request.call.call_id,
        itemId: request.call.id,
        name: request.call.name,
        type: "function_call" as const,
      }),
      Object.freeze({
        callId: request.functionCallOutput.call_id,
        output: request.functionCallOutput.output,
        type: "function_call_output" as const,
      }),
    ];
    Object.freeze(items);
    return Object.freeze({
      child: this.#childBinding(initial),
      items,
      manifest: JSON.parse(initial.canonicalManifest) as JsonValue,
    });
  }

  #childBinding(request: ResponsesV2InitialRequest): AgentChildRequestBinding {
    return Object.freeze({
      ...(request.promptCacheKey === undefined ? {} : { promptCacheKey: request.promptCacheKey }),
      requestBindingId: this.#context.requestBindingId,
      requestPrefix: request.requestPrefix,
      threadId: this.#context.threadId,
      turnId: this.#context.turnId,
    });
  }

  #acceptOutcome(
    initial: ResponsesV2InitialRequest,
    outcome: AgentWorkflowOutcome,
  ): ResponsesV2ValidatedOutcome {
    if (outcome.manifestDigest !== initial.manifestDigest) {
      this.#terminate();
      throw new AgentSessionCoordinatorError("protocol_manifest_mismatch");
    }
    if (outcome.kind === "final") {
      this.#terminate();
      return Object.freeze({ kind: "final", text: outcome.text });
    }
    const committed = Object.freeze({
      arguments: outcome.arguments,
      argumentsJson: outcome.argumentsJson,
      callId: outcome.callId,
      callRef: outcome.callRef,
      itemId: outcome.itemId,
      kind: "tool_call" as const,
      tool: outcome.tool,
    });
    this.#pending = committed;
    this.#phase = "awaiting_continuation";
    return committed;
  }

  #terminate(): void {
    this.#pending = undefined;
    this.#phase = "terminal";
  }

  async #rejectContinuation(): Promise<never> {
    this.#terminate();
    try {
      await this.#coordinator.cancelActive();
    } catch {
      // The local workflow remains terminal even if best-effort cancellation fails.
    }
    throw new AgentSessionCoordinatorError("child_continuation_mismatch");
  }
}

function isAdapterOptions(value: unknown): value is ResponsesV2AgentSessionAdapterOptions {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const context = candidate["context"];
  const coordinator = candidate["coordinator"];
  if (
    context === null ||
    typeof context !== "object" ||
    coordinator === null ||
    typeof coordinator !== "object"
  ) {
    return false;
  }
  const methods = coordinator as Record<string, unknown>;
  return (
    typeof methods["startWorkflow"] === "function" &&
    typeof methods["continueWorkflow"] === "function" &&
    typeof methods["cancelActive"] === "function" &&
    typeof methods["close"] === "function"
  );
}

function sameCommittedCallAndContinuation(
  pending: ResponsesV2CommittedToolCall,
  request: ResponsesV2ContinuationRequest,
): boolean {
  try {
    return (
      request.call.call_id === pending.callId &&
      request.call.id === pending.itemId &&
      request.call.name === pending.tool &&
      request.call.arguments === pending.argumentsJson &&
      request.functionCallOutput.call_id === pending.callId &&
      canonicalizeToolWorkflowJson(pending.arguments) === pending.argumentsJson
    );
  } catch {
    return false;
  }
}

function normalizeAdapterError(
  error: unknown,
  fallback: "child_continuation_mismatch" | "tool_loop_incomplete",
): AgentSessionCoordinatorError {
  return error instanceof AgentSessionCoordinatorError
    ? error
    : new AgentSessionCoordinatorError(fallback);
}
