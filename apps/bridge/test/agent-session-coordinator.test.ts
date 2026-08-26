import { createHash } from "node:crypto";

import {
  TOOL_WORKFLOW_ENVELOPE_BEGIN,
  TOOL_WORKFLOW_ENVELOPE_END,
  canonicalizeToolWorkflowJson,
  type JsonObject,
  type JsonValue,
} from "@gpt-session-bridge/protocol";
import { describe, expect, it } from "vitest";

import {
  AgentSessionCoordinator,
  type AgentBrowserBinding,
  type AgentBrowserTurnBoundary,
  type AgentCertifiedTool,
  type AgentChildRequestBinding,
  type AgentToolCallCommit,
  type AgentWorkflowContinuationRequest,
  type AgentWorkflowStartRequest,
} from "../src/browser/agent-session-coordinator.js";
import type {
  BrowserTurnDelta,
  BrowserTurnHandle,
  BrowserTurnRequest,
  BrowserTurnSink,
  BrowserTurnTerminal,
} from "../src/browser/browser-session-coordinator.js";

const NOW = 2_000_000;

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

interface FakeTurn {
  readonly completion: Deferred<BrowserTurnTerminal>;
  readonly request: BrowserTurnRequest;
  readonly sink: BrowserTurnSink;
}

interface PublicRoundBinding {
  readonly challenge: string;
  readonly manifestDigest: string;
  readonly round: number;
  readonly turn: string;
  readonly v: number;
}

class FakeBoundary implements AgentBrowserTurnBoundary {
  public activityCount = 0;
  public activityMutation: Partial<AgentBrowserBinding> | undefined;
  public binding: AgentBrowserBinding | undefined;
  public boundStartCount = 0;
  public cancelCount = 0;
  public driftBeforeStart: Partial<AgentBrowserBinding> | undefined;
  public readonly turns: FakeTurn[] = [];

  public constructor(binding: AgentBrowserBinding | undefined = browserBinding()) {
    this.binding = binding;
  }

  public readBinding(): AgentBrowserBinding | undefined {
    return this.binding;
  }

  public noteAgentActivity(expected: AgentBrowserBinding): AgentBrowserBinding {
    this.activityCount += 1;
    if (!sameBinding(this.binding, expected)) {
      throw new Error("Synthetic activity binding mismatch");
    }
    const refreshed = browserBinding({
      ...expected,
      expiresAtMs: Math.max(expected.expiresAtMs, NOW + 60_000),
      lastActivityAtMs: NOW,
      ...this.activityMutation,
    });
    this.binding = refreshed;
    return refreshed;
  }

  public startBoundTurn(
    expected: AgentBrowserBinding,
    request: BrowserTurnRequest,
    sink: BrowserTurnSink,
  ): BrowserTurnHandle {
    this.boundStartCount += 1;
    if (this.driftBeforeStart !== undefined && this.binding !== undefined) {
      this.binding = { ...this.binding, ...this.driftBeforeStart };
    }
    if (!sameBinding(this.binding, expected)) {
      throw new Error("Synthetic atomic start binding mismatch");
    }
    const completion = deferred<BrowserTurnTerminal>();
    const turn: FakeTurn = { completion, request, sink };
    this.turns.push(turn);
    return Object.freeze({
      cancel: (): Promise<void> => {
        this.cancelCount += 1;
        completion.resolve({ kind: "cancelled" });
        return Promise.resolve();
      },
      completion: completion.promise,
      started: Promise.resolve(),
      turnId: `browser-turn-${String(this.turns.length)}`,
    });
  }

  public async complete(
    index: number,
    output: string,
    finishReason: "length" | "stop" = "stop",
  ): Promise<void> {
    const turn = readTurn(this, index);
    try {
      await turn.sink.onDelta({ channel: "outputText", delta: output });
      turn.completion.resolve({ finishReason, kind: "completed" });
    } catch (error) {
      turn.completion.resolve({ kind: "cancelled" });
      throw error;
    }
  }

  public async delta(index: number, output: string): Promise<void> {
    const turn = readTurn(this, index);
    try {
      await turn.sink.onDelta({ channel: "outputText", delta: output });
    } catch (error) {
      turn.completion.resolve({ kind: "cancelled" });
      throw error;
    }
  }

  public async channelDelta(
    index: number,
    channel: "commentary" | "reasoning",
    output: string,
  ): Promise<void> {
    const turn = readTurn(this, index);
    try {
      await turn.sink.onDelta({ channel, delta: output });
    } catch (error) {
      turn.completion.resolve({ kind: "cancelled" });
      throw error;
    }
  }

  public async unknownDelta(index: number, value: unknown): Promise<void> {
    const turn = readTurn(this, index);
    try {
      await turn.sink.onDelta(value as BrowserTurnDelta);
    } catch (error) {
      turn.completion.resolve({ kind: "cancelled" });
      throw error;
    }
  }

  public completeWithoutOutput(index: number): void {
    readTurn(this, index).completion.resolve({ finishReason: "stop", kind: "completed" });
  }
}

describe("AgentSessionCoordinator", () => {
  it("binds private state, projects only typed public content, and commits before return", async () => {
    const boundary = new FakeBoundary();
    const coordinator = createCoordinator(boundary);
    const request = startRequest();
    const pending = coordinator.startWorkflow(request);
    const turn = readTurn(boundary, 0);
    const prompt = readPrompt(turn);

    expect(prompt).toContain("Web Agent protocol v2 compatibility projection");
    expect(prompt).toContain("synthetic-visible-request");
    expect(prompt).toContain("For every response, return exactly three lines");
    expect(prompt).toContain('TOOL_CALL_SHAPE {"arguments":{},"challenge":');
    expect(prompt).toContain('FINAL_SHAPE {"challenge":');
    for (const privateValue of [
      request.browser.documentId,
      request.browser.leaseId,
      request.browser.providerRoute,
      request.browser.sessionId,
      request.child.requestBindingId,
      request.child.threadId,
      request.child.turnId,
      request.child.promptCacheKey,
    ]) {
      expect(prompt).not.toContain(privateValue ?? "never-present");
    }

    const binding = readPublicBinding(turn);
    await boundary.complete(0, toolCallEnvelope(binding, "exec_command", { cmd: "synthetic" }));
    const outcome = await pending;

    expect(outcome).toMatchObject({ kind: "tool_call", round: 0, tool: "exec_command" });
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.kind === "tool_call" ? outcome.arguments : {})).toBe(true);
    expect(coordinator.state).toEqual({
      pendingCall: true,
      phase: "awaiting_child_continuation",
      round: 0,
      workflowActive: true,
    });
  });

  it("uses passive state reads and enforces exact lease time without renewal", async () => {
    let nowReads = 0;
    const boundary = new FakeBoundary();
    const coordinator = createCoordinator(boundary, () => {
      nowReads += 1;
      return NOW;
    });
    const pending = coordinator.startWorkflow(startRequest());
    const readsAfterStart = nowReads;

    expect(coordinator.state.phase).toBe("awaiting_assistant_envelope");
    expect(coordinator.state.phase).toBe("awaiting_assistant_envelope");
    expect(nowReads).toBe(readsAfterStart);
    expect(boundary.activityCount).toBe(1);

    await boundary.complete(0, finalEnvelope(readPublicBinding(readTurn(boundary, 0)), "done"));
    await expect(pending).resolves.toMatchObject({ kind: "final", text: "done" });
    expect(nowReads).toBeGreaterThan(readsAfterStart);
  });

  it("renews admitted workflow activity and atomically starts against the refreshed binding", async () => {
    const boundary = new FakeBoundary();
    const coordinator = createCoordinator(boundary);
    const request = startRequest();
    const pending = coordinator.startWorkflow(request);

    expect(boundary.activityCount).toBe(1);
    expect(boundary.boundStartCount).toBe(1);
    expect(boundary.binding).toMatchObject({
      lastActivityAtMs: NOW,
      leaseId: request.browser.leaseId,
      documentId: request.browser.documentId,
      sessionGeneration: request.browser.sessionGeneration,
    });
    const activityCount = boundary.activityCount;
    void coordinator.state;
    expect(boundary.activityCount).toBe(activityCount);

    await boundary.complete(
      0,
      toolCallEnvelope(readPublicBinding(readTurn(boundary, 0)), "exec_command", {
        cmd: "renew",
      }),
    );
    const committed = expectToolCall(await pending);
    const continued = coordinator.continueWorkflow(continuationRequest(committed, request));
    expect(boundary.activityCount).toBe(2);
    expect(boundary.boundStartCount).toBe(2);
    const next = readPublicBindingFromEnvelope(readPrompt(readTurn(boundary, 1)));
    await boundary.complete(1, finalEnvelope(next, "renewed"));
    await expect(continued).resolves.toMatchObject({ kind: "final", text: "renewed" });
  });

  it("rejects unstable renewal and atomic start drift before browser mutation", async () => {
    for (const mutation of [
      { documentId: "renewed-document-drift" },
      { leaseId: "renewed-lease-drift" },
      { sessionGeneration: 2 },
      { lastActivityAtMs: NOW - 1_000 },
      { expiresAtMs: NOW + 1 },
    ] satisfies readonly Partial<AgentBrowserBinding>[]) {
      const boundary = new FakeBoundary();
      boundary.activityMutation = mutation;
      const coordinator = createCoordinator(boundary);
      await expect(coordinator.startWorkflow(startRequest())).rejects.toMatchObject({
        code: "browser_state_changed",
      });
      expect(boundary.turns).toHaveLength(0);
      expect(boundary.boundStartCount).toBe(0);
    }

    const boundary = new FakeBoundary();
    boundary.driftBeforeStart = { providerRoute: "atomic-provider-drift" };
    const coordinator = createCoordinator(boundary);
    await expect(coordinator.startWorkflow(startRequest())).rejects.toMatchObject({
      code: "browser_state_changed",
    });
    expect(boundary.boundStartCount).toBe(1);
    expect(boundary.turns).toHaveLength(0);
  });

  it("rejects missing, expired, future, and overlong activation leases before mutation", async () => {
    const cases: (AgentBrowserBinding | undefined)[] = [
      undefined,
      browserBinding({ expiresAtMs: NOW }),
      browserBinding({ issuedAtMs: NOW + 1 }),
      browserBinding({ lastActivityAtMs: NOW + 1 }),
      browserBinding({ expiresAtMs: NOW + 900_001, lastActivityAtMs: NOW }),
    ];

    for (const binding of cases) {
      const boundary = new FakeBoundary();
      boundary.binding = binding;
      const coordinator = createCoordinator(boundary);
      const request = startRequest({ browser: binding ?? browserBinding() });
      await expect(coordinator.startWorkflow(request)).rejects.toMatchObject({
        code: binding === undefined ? "browser_state_changed" : "tool_protocol_not_activated",
      });
      expect(boundary.turns).toHaveLength(0);
    }
  });

  it("rejects temporary chat because the initial certified profile cannot verify it", async () => {
    const boundary = new FakeBoundary();
    const coordinator = createCoordinator(boundary);
    await expect(
      coordinator.startWorkflow(startRequest({ temporary: true })),
    ).rejects.toMatchObject({ code: "unsupported_tool_profile" });
    expect(boundary.turns).toHaveLength(0);
  });

  it("binds serial profile metadata into the manifest digest before submission", async () => {
    const first = startRequest();
    const second = startRequest({ profileVersion: "fixture-v2" });
    expect(first.manifestDigest).not.toBe(second.manifestDigest);

    const boundary = new FakeBoundary();
    const coordinator = createCoordinator(boundary);
    const pending = coordinator.startWorkflow(first);
    const prompt = readPrompt(readTurn(boundary, 0));
    expect(prompt).toContain('"parallelToolCalls":false');
    expect(readPublicBinding(readTurn(boundary, 0)).manifestDigest).toBe(first.manifestDigest);
    await boundary.complete(0, finalEnvelope(readPublicBinding(readTurn(boundary, 0)), "bound"));
    await expect(pending).resolves.toMatchObject({ kind: "final" });

    for (const scenario of [
      {
        code: "protocol_manifest_mismatch",
        request: startRequest({
          manifestDigest: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        }),
      },
      {
        code: "unsupported_tool_profile",
        request: {
          ...startRequest(),
          parallelToolCalls: true,
        } as unknown as AgentWorkflowStartRequest,
      },
      {
        code: "unsupported_tool_profile",
        request: startRequest({ profileVersion: "p".repeat(65) }),
      },
      {
        code: "unsupported_tool_profile",
        request: startRequest({
          tools: [
            {
              ...certifiedTool(),
              parameters: {
                additionalProperties: false,
                properties: { cmd: { maxLength: "invalid", type: "string" } },
                required: ["cmd"],
                type: "object",
              },
            },
          ],
        }),
      },
    ]) {
      const rejectedBoundary = new FakeBoundary();
      const rejected = createCoordinator(rejectedBoundary);
      await expect(rejected.startWorkflow(scenario.request)).rejects.toMatchObject({
        code: scenario.code,
      });
      expect(rejectedBoundary.activityCount).toBe(0);
      expect(rejectedBoundary.turns).toHaveLength(0);
    }
  });

  it("pins every browser, document, model, provider, session, and lease field", async () => {
    const mutations: readonly Partial<AgentBrowserBinding>[] = [
      { catalogRevision: "catalog-drift" },
      { conversationOwnershipId: "ownership-drift" },
      { documentId: "document-drift" },
      { expiresAtMs: NOW + 20_000 },
      { documentGeneration: 2 },
      { issuedAtMs: NOW - 2_000 },
      { lastActivityAtMs: NOW - 2_000 },
      { leaseId: "lease-drift" },
      { modelId: "model-drift" },
      { providerRoute: "provider-drift" },
      { sessionGeneration: 2 },
      { sessionId: "session-drift" },
      { tabId: 8 },
    ];

    for (const mutation of mutations) {
      const boundary = new FakeBoundary();
      const coordinator = createCoordinator(boundary);
      const pending = coordinator.startWorkflow(startRequest());
      boundary.binding = browserBinding(mutation);
      await expect(boundary.delta(0, "untrusted")).rejects.toMatchObject({
        code: "browser_state_changed",
      });
      await expect(pending).rejects.toMatchObject({
        code: "browser_state_changed",
      });
      expect(coordinator.state).toMatchObject({
        phase: "failed_terminal",
        terminalCode: "browser_state_changed",
        workflowActive: false,
      });
    }
  });

  it("consumes the only challenge on the first terminal parse attempt", async () => {
    const boundary = new FakeBoundary();
    const coordinator = createCoordinator(boundary);
    const pending = coordinator.startWorkflow(startRequest());
    await boundary.complete(0, "not-an-envelope");

    await expect(pending).rejects.toMatchObject({
      code: "protocol_envelope_invalid",
    });
    expect(coordinator.state).toEqual({
      pendingCall: false,
      phase: "failed_terminal",
      terminalCode: "protocol_envelope_invalid",
      workflowActive: false,
    });
    expect(boundary.cancelCount).toBe(0);
  });

  it("fails closed for stale turn, round, challenge, and manifest bindings", async () => {
    const cases: readonly {
      readonly code: string;
      readonly mutate: (value: PublicRoundBinding) => PublicRoundBinding;
    }[] = [
      {
        code: "protocol_turn_mismatch",
        mutate: (value) => ({ ...value, turn: "wt_staleAlias000000" }),
      },
      {
        code: "protocol_round_mismatch",
        mutate: (value) => ({ ...value, round: value.round + 1 }),
      },
      {
        code: "protocol_challenge_mismatch",
        mutate: (value) => ({ ...value, challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
      },
      {
        code: "protocol_manifest_mismatch",
        mutate: (value) => ({
          ...value,
          manifestDigest: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        }),
      },
    ];

    for (const scenario of cases) {
      const boundary = new FakeBoundary();
      const coordinator = createCoordinator(boundary);
      const pending = coordinator.startWorkflow(startRequest());
      const binding = scenario.mutate(readPublicBinding(readTurn(boundary, 0)));
      await boundary.complete(0, finalEnvelope(binding, "must-not-pass"));
      await expect(pending).rejects.toMatchObject({ code: scenario.code });
      expect(coordinator.state).toMatchObject({ phase: "failed_terminal", workflowActive: false });
    }
  });

  it("validates the allowlisted tool and exact argument schema before minting a call", async () => {
    for (const scenario of [
      { arguments: { command: "wrong" }, code: "protocol_arguments_invalid", tool: "exec_command" },
      { arguments: { cmd: "synthetic" }, code: "protocol_tool_unknown", tool: "unknown_tool" },
    ]) {
      const boundary = new FakeBoundary();
      const coordinator = createCoordinator(boundary);
      const pending = coordinator.startWorkflow(startRequest());
      await boundary.complete(
        0,
        toolCallEnvelope(
          readPublicBinding(readTurn(boundary, 0)),
          scenario.tool,
          scenario.arguments,
        ),
      );
      await expect(pending).rejects.toMatchObject({ code: scenario.code });
      expect(coordinator.state.pendingCall).toBe(false);
    }

    const boundary = new FakeBoundary();
    const coordinator = createCoordinator(boundary);
    const pending = coordinator.startWorkflow(
      startRequest({
        tools: [
          certifiedTool(() => {
            throw new Error("synthetic validator failure");
          }),
        ],
      }),
    );
    await boundary.complete(
      0,
      toolCallEnvelope(readPublicBinding(readTurn(boundary, 0)), "exec_command", {
        cmd: "synthetic",
      }),
    );
    await expect(pending).rejects.toMatchObject({ code: "protocol_arguments_invalid" });
  });

  it("allows only one active workflow and never re-emits a committed call", async () => {
    const boundary = new FakeBoundary();
    const coordinator = createCoordinator(boundary);
    const first = coordinator.startWorkflow(startRequest());
    await expect(coordinator.startWorkflow(startRequest())).rejects.toMatchObject({
      code: "tool_loop_incomplete",
    });
    expect(boundary.turns).toHaveLength(1);

    await boundary.complete(
      0,
      toolCallEnvelope(readPublicBinding(readTurn(boundary, 0)), "exec_command", {
        cmd: "synthetic",
      }),
    );
    const committed = expectToolCall(await first);
    await expect(coordinator.startWorkflow(startRequest())).rejects.toMatchObject({
      code: "tool_loop_incomplete",
    });
    expect(coordinator.state.pendingCall).toBe(true);
    expect(committed.callId).toMatch(/^call_[A-Za-z0-9_-]{24}$/u);
    expect(boundary.turns).toHaveLength(1);
  });

  it("accepts only the exact child continuation tuple and manifest", async () => {
    const mutationNames = [
      "requestBindingId",
      "threadId",
      "turnId",
      "promptCacheKey",
      "requestPrefix",
      "manifest",
      "callId",
      "itemId",
      "toolName",
      "arguments",
      "outputCallId",
      "extraItem",
    ] as const;

    for (const mutation of mutationNames) {
      const boundary = new FakeBoundary();
      const coordinator = createCoordinator(boundary);
      const request = startRequest();
      const committed = await produceToolCall(coordinator, boundary, request);
      const continuation = continuationRequest(committed, request);
      const mutated = mutateContinuation(continuation, mutation);
      await expect(coordinator.continueWorkflow(mutated)).rejects.toMatchObject({
        code: "child_continuation_mismatch",
      });
      expect(boundary.turns).toHaveLength(1);
      expect(coordinator.state).toMatchObject({
        pendingCall: false,
        phase: "failed_terminal",
        terminalCode: "child_continuation_mismatch",
      });
    }
  });

  it("exact-normalizes initial and continuation DTOs without invoking accessors", async () => {
    let getterCalls = 0;
    const initialWithAccessor = { ...startRequest() } as Record<string, unknown>;
    Object.defineProperty(initialWithAccessor, "tools", {
      enumerable: true,
      get(): unknown {
        getterCalls += 1;
        return [];
      },
    });
    const childWithAccessor = { ...childBinding() } as Record<string, unknown>;
    Object.defineProperty(childWithAccessor, "requestPrefix", {
      enumerable: true,
      get(): unknown {
        getterCalls += 1;
        return {};
      },
    });
    const symbolRequest = { ...startRequest() } as Record<PropertyKey, unknown>;
    symbolRequest[Symbol("extra")] = true;
    const initialCases: unknown[] = [
      { ...startRequest(), extra: true },
      initialWithAccessor,
      { ...startRequest(), child: { ...childBinding(), extra: true } },
      { ...startRequest(), child: childWithAccessor },
      symbolRequest,
    ];

    for (const value of initialCases) {
      const boundary = new FakeBoundary();
      const coordinator = createCoordinator(boundary);
      await expect(
        coordinator.startWorkflow(value as AgentWorkflowStartRequest),
      ).rejects.toMatchObject({ code: "unsupported_tool_profile" });
      expect(boundary.activityCount).toBe(0);
      expect(boundary.turns).toHaveLength(0);
    }
    expect(getterCalls).toBe(0);

    const continuationMutations = [
      (value: AgentWorkflowContinuationRequest): unknown => ({ ...value, extra: true }),
      (value: AgentWorkflowContinuationRequest): unknown => ({
        ...value,
        child: { ...value.child, extra: true },
      }),
      (value: AgentWorkflowContinuationRequest): unknown => {
        const items = [...value.items];
        Object.defineProperty(items, "0", {
          enumerable: true,
          get(): unknown {
            getterCalls += 1;
            return value.items[0];
          },
        });
        return { ...value, items };
      },
      (value: AgentWorkflowContinuationRequest): unknown => {
        const result = { ...value } as Record<PropertyKey, unknown>;
        result[Symbol("extra")] = true;
        return result;
      },
    ];

    for (const mutate of continuationMutations) {
      const boundary = new FakeBoundary();
      const coordinator = createCoordinator(boundary);
      const request = startRequest();
      const commit = await produceToolCall(coordinator, boundary, request);
      const value = mutate(continuationRequest(commit, request));
      await expect(
        coordinator.continueWorkflow(value as AgentWorkflowContinuationRequest),
      ).rejects.toMatchObject({ code: "child_continuation_mismatch" });
      expect(boundary.turns).toHaveLength(1);
    }
    expect(getterCalls).toBe(0);
  });

  it("derives result status from the certified profile and rejects unclassified output", async () => {
    const boundary = new FakeBoundary();
    const coordinator = createCoordinator(boundary);
    const tool = certifiedTool(undefined, (output) =>
      output === "certified-error" ? false : undefined,
    );
    const request = startRequest({ tools: [tool] });
    const committed = await produceToolCall(coordinator, boundary, request);
    const accepted = coordinator.continueWorkflow(
      continuationRequest(committed, request, "certified-error"),
    );
    const prompt = readPrompt(readTurn(boundary, 1));
    expect(prompt).toContain('"ok":false');
    await boundary.complete(1, finalEnvelope(readPublicBindingFromEnvelope(prompt), "classified"));
    await expect(accepted).resolves.toMatchObject({ kind: "final" });

    const rejectedBoundary = new FakeBoundary();
    const rejectedCoordinator = createCoordinator(rejectedBoundary);
    const rejectedRequest = startRequest({ tools: [tool] });
    const rejectedCommit = await produceToolCall(
      rejectedCoordinator,
      rejectedBoundary,
      rejectedRequest,
    );
    await expect(
      rejectedCoordinator.continueWorkflow(
        continuationRequest(rejectedCommit, rejectedRequest, "unknown-result-shape"),
      ),
    ).rejects.toMatchObject({ code: "child_continuation_mismatch" });
    expect(rejectedBoundary.turns).toHaveLength(1);

    const rewriteBoundary = new FakeBoundary();
    const rewriteCoordinator = createCoordinator(rewriteBoundary);
    const rewritingClassifier = (() => ({
      ok: true,
      output: "rewritten",
    })) as unknown as AgentCertifiedTool["classifyResult"];
    const rewriteRequest = startRequest({
      tools: [certifiedTool(undefined, rewritingClassifier)],
    });
    const rewriteCommit = await produceToolCall(
      rewriteCoordinator,
      rewriteBoundary,
      rewriteRequest,
    );
    await expect(
      rewriteCoordinator.continueWorkflow(
        continuationRequest(rewriteCommit, rewriteRequest, "exact-child-output"),
      ),
    ).rejects.toMatchObject({ code: "child_continuation_mismatch" });
    expect(rewriteBoundary.turns).toHaveLength(1);
  });

  it("serializes one exact result, advances with a fresh challenge, then completes", async () => {
    const boundary = new FakeBoundary();
    const coordinator = createCoordinator(boundary);
    const request = startRequest();
    const committed = await produceToolCall(coordinator, boundary, request);
    const continued = coordinator.continueWorkflow(continuationRequest(committed, request));
    const resultPrompt = readPrompt(readTurn(boundary, 1));
    const nextBinding = readPublicBindingFromEnvelope(resultPrompt);

    expect(resultPrompt).toContain('"kind":"tool_result"');
    expect(resultPrompt).toContain('"output":"synthetic-output"');
    expect(nextBinding.round).toBe(1);
    expect(nextBinding.challenge).not.toBe(readPublicBinding(readTurn(boundary, 0)).challenge);

    await boundary.complete(1, finalEnvelope(nextBinding, "completed"));
    await expect(continued).resolves.toEqual({
      kind: "final",
      manifestDigest: committed.manifestDigest,
      round: 1,
      text: "completed",
      workflowAlias: committed.workflowAlias,
    });
    expect(coordinator.state).toEqual({
      pendingCall: false,
      phase: "completed",
      workflowActive: false,
    });
  });

  it("admits only one concurrent continuation and creates only one next browser round", async () => {
    const boundary = new FakeBoundary();
    const coordinator = createCoordinator(boundary);
    const request = startRequest();
    const committed = await produceToolCall(coordinator, boundary, request);
    const continuation = continuationRequest(committed, request);

    const accepted = coordinator.continueWorkflow(continuation);
    await expect(coordinator.continueWorkflow(continuation)).rejects.toMatchObject({
      code: "child_continuation_mismatch",
    });
    expect(boundary.turns).toHaveLength(2);

    const nextBinding = readPublicBindingFromEnvelope(readPrompt(readTurn(boundary, 1)));
    await boundary.complete(1, finalEnvelope(nextBinding, "once"));
    await expect(accepted).resolves.toMatchObject({ kind: "final", text: "once" });
    expect(boundary.turns).toHaveLength(2);
  });

  it("supports exactly 32 committed calls and the reserved final round 32", async () => {
    const boundary = new FakeBoundary();
    const coordinator = createCoordinator(boundary);
    const request = startRequest();
    let pending = coordinator.startWorkflow(request);

    for (let round = 0; round < 32; round += 1) {
      const turn = readTurn(boundary, round);
      const binding = readPublicBindingFromAnyPrompt(readPrompt(turn));
      expect(binding.round).toBe(round);
      await boundary.complete(
        round,
        toolCallEnvelope(binding, "exec_command", { cmd: `synthetic-${String(round)}` }),
      );
      const committed = expectToolCall(await pending);
      expect(committed.round).toBe(round);
      pending = coordinator.continueWorkflow(
        continuationRequest(committed, request, `result-${String(round)}`),
      );
    }

    const finalTurn = readTurn(boundary, 32);
    const finalBinding = readPublicBindingFromAnyPrompt(readPrompt(finalTurn));
    expect(finalBinding.round).toBe(32);
    await boundary.complete(32, finalEnvelope(finalBinding, "all-done"));
    await expect(pending).resolves.toMatchObject({ kind: "final", round: 32, text: "all-done" });
  });

  it("enforces individual and aggregate tool-result byte budgets", async () => {
    const oversizedBoundary = new FakeBoundary();
    const oversizedCoordinator = createCoordinator(oversizedBoundary);
    const request = startRequest();
    const oversizedCommit = await produceToolCall(oversizedCoordinator, oversizedBoundary, request);
    await expect(
      oversizedCoordinator.continueWorkflow(
        continuationRequest(oversizedCommit, request, "x".repeat(128 * 1_024 + 1)),
      ),
    ).rejects.toMatchObject({ code: "tool_result_too_large" });
    expect(oversizedBoundary.turns).toHaveLength(1);

    const aggregateBoundary = new FakeBoundary();
    const aggregateCoordinator = createCoordinator(aggregateBoundary);
    let pending = aggregateCoordinator.startWorkflow(request);
    for (let round = 0; round < 9; round += 1) {
      const binding = readPublicBindingFromAnyPrompt(
        readPrompt(readTurn(aggregateBoundary, round)),
      );
      await aggregateBoundary.complete(
        round,
        toolCallEnvelope(binding, "exec_command", { cmd: `aggregate-${String(round)}` }),
      );
      const commit = expectToolCall(await pending);
      const next = aggregateCoordinator.continueWorkflow(
        continuationRequest(commit, request, "r".repeat(60 * 1_024)),
      );
      if (round === 8) {
        await expect(next).rejects.toMatchObject({ code: "tool_result_too_large" });
      } else {
        pending = next;
      }
    }
    expect(aggregateBoundary.turns).toHaveLength(9);
  });

  it("cancels and tears down terminally without retry or fallback", async () => {
    const activeBoundary = new FakeBoundary();
    const activeCoordinator = createCoordinator(activeBoundary);
    const pending = activeCoordinator.startWorkflow(startRequest());
    await expect(activeCoordinator.cancelActive()).resolves.toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "turn_cancelled" });
    expect(activeBoundary.cancelCount).toBe(1);
    expect(activeBoundary.turns).toHaveLength(1);
    expect(activeCoordinator.state).toMatchObject({
      phase: "cancelled_terminal",
      terminalCode: "turn_cancelled",
      workflowActive: false,
    });

    const committedBoundary = new FakeBoundary();
    const committedCoordinator = createCoordinator(committedBoundary);
    const request = startRequest();
    const committed = await produceToolCall(committedCoordinator, committedBoundary, request);
    committedCoordinator.close();
    await expect(
      committedCoordinator.continueWorkflow(continuationRequest(committed, request)),
    ).rejects.toMatchObject({ code: "turn_cancelled" });
    expect(committedBoundary.turns).toHaveLength(1);
    expect(committedCoordinator.state.phase).toBe("closed");
  });

  it("rejects truncated generations, duplicate envelopes, and oversized streamed output", async () => {
    const lengthBoundary = new FakeBoundary();
    const lengthCoordinator = createCoordinator(lengthBoundary);
    const lengthPending = lengthCoordinator.startWorkflow(startRequest());
    await lengthBoundary.complete(
      0,
      finalEnvelope(readPublicBinding(readTurn(lengthBoundary, 0)), "truncated"),
      "length",
    );
    await expect(lengthPending).rejects.toMatchObject({ code: "tool_loop_incomplete" });

    const duplicateBoundary = new FakeBoundary();
    const duplicateCoordinator = createCoordinator(duplicateBoundary);
    const duplicatePending = duplicateCoordinator.startWorkflow(startRequest());
    const response = finalEnvelope(readPublicBinding(readTurn(duplicateBoundary, 0)), "one");
    await duplicateBoundary.complete(0, `${response}\n${response}`);
    await expect(duplicatePending).rejects.toMatchObject({ code: "protocol_envelope_invalid" });

    const oversizedBoundary = new FakeBoundary();
    const oversizedCoordinator = createCoordinator(oversizedBoundary);
    const oversizedPending = oversizedCoordinator.startWorkflow(startRequest());
    await expect(oversizedBoundary.delta(0, "x".repeat(256 * 1_024 + 1))).rejects.toMatchObject({
      code: "protocol_envelope_invalid",
    });
    await expect(oversizedPending).rejects.toMatchObject({ code: "protocol_envelope_invalid" });
  });

  it("fails closed on non-output channels", async () => {
    for (const channel of ["reasoning", "commentary"] as const) {
      const boundary = new FakeBoundary();
      const coordinator = createCoordinator(boundary);
      const pending = coordinator.startWorkflow(startRequest());
      await expect(boundary.channelDelta(0, channel, "must-not-be-accepted")).rejects.toMatchObject(
        {
          code: "protocol_envelope_invalid",
        },
      );
      await expect(pending).rejects.toMatchObject({ code: "protocol_envelope_invalid" });
    }
  });

  it("rejects malformed delta records without invoking accessors", async () => {
    let getterCalls = 0;
    const accessorDelta: Record<string, unknown> = { channel: "outputText" };
    Object.defineProperty(accessorDelta, "delta", {
      enumerable: true,
      get(): string {
        getterCalls += 1;
        return "hidden";
      },
    });
    const symbolDelta: Record<PropertyKey, unknown> = {
      channel: "outputText",
      delta: "synthetic",
    };
    symbolDelta[Symbol("extra")] = true;
    const malformed: readonly unknown[] = [
      { channel: "outputText", delta: "synthetic", extra: true },
      { channel: "outputText", delta: "" },
      { channel: "outputText", delta: 1 },
      { channel: "unknown", delta: "synthetic" },
      { channel: "outputText", delta: "x".repeat(16_385) },
      accessorDelta,
      symbolDelta,
    ];

    for (const value of malformed) {
      const boundary = new FakeBoundary();
      const coordinator = createCoordinator(boundary);
      const pending = coordinator.startWorkflow(startRequest());
      await expect(boundary.unknownDelta(0, value)).rejects.toMatchObject({
        code: "protocol_envelope_invalid",
      });
      await expect(pending).rejects.toMatchObject({ code: "protocol_envelope_invalid" });
    }
    expect(getterCalls).toBe(0);
  });

  it("caps the number of streamed deltas per round", async () => {
    const boundary = new FakeBoundary();
    const coordinator = createCoordinator(boundary);
    const pending = coordinator.startWorkflow(startRequest());
    const turn = readTurn(boundary, 0);
    for (let index = 0; index < 4_096; index += 1) {
      await turn.sink.onDelta({ channel: "outputText", delta: "x" });
    }
    await expect(
      boundary.unknownDelta(0, { channel: "outputText", delta: "x" }),
    ).rejects.toMatchObject({
      code: "tool_budget_exhausted",
    });
    await expect(pending).rejects.toMatchObject({ code: "tool_budget_exhausted" });
  });

  it("accepts fragmented complete output", async () => {
    const boundary = new FakeBoundary();
    const coordinator = createCoordinator(boundary);
    const pending = coordinator.startWorkflow(startRequest());
    const turn = readTurn(boundary, 0);
    const response = finalEnvelope(readPublicBinding(turn), "fragmented");
    await turn.sink.onDelta({ channel: "outputText", delta: response.slice(0, 20) });
    await turn.sink.onDelta({ channel: "outputText", delta: response.slice(20) });
    turn.completion.resolve({ finishReason: "stop", kind: "completed" });
    await expect(pending).resolves.toMatchObject({ kind: "final", text: "fragmented" });
  });

  it("validates constructor dependencies and random uniqueness failures", async () => {
    expect(() => new AgentSessionCoordinator({} as AgentBrowserTurnBoundary)).toThrow(TypeError);
    const boundary = new FakeBoundary();
    const invalidBytes = new AgentSessionCoordinator(boundary, {
      createRandomBytes: () => new Uint8Array(1),
      now: () => NOW,
    });
    await expect(invalidBytes.startWorkflow(startRequest())).rejects.toMatchObject({
      code: "tool_loop_incomplete",
    });

    const repeatedBytes = new AgentSessionCoordinator(boundary, {
      createRandomBytes: (size) => new Uint8Array(size),
      now: () => NOW,
    });
    const first = repeatedBytes.startWorkflow(startRequest());
    boundary.completeWithoutOutput(0);
    await expect(first).rejects.toMatchObject({ code: "protocol_envelope_invalid" });
    boundary.binding = browserBinding();
    await expect(repeatedBytes.startWorkflow(startRequest())).rejects.toMatchObject({
      code: "tool_loop_incomplete",
    });
  });
});

function createCoordinator(
  boundary: FakeBoundary,
  now: () => number = () => NOW,
): AgentSessionCoordinator {
  let counter = 1;
  return new AgentSessionCoordinator(boundary, {
    createRandomBytes: (size) => {
      const value = new Uint8Array(size);
      value.fill(counter);
      counter += 1;
      return value;
    },
    now,
  });
}

function browserBinding(overrides: Partial<AgentBrowserBinding> = {}): AgentBrowserBinding {
  return {
    catalogRevision: "catalog-private-canary",
    conversationOwnershipId: "ownership-private-canary",
    documentGeneration: 1,
    documentId: "document-private-canary",
    expiresAtMs: NOW + 60_000,
    issuedAtMs: NOW - 1_000,
    lastActivityAtMs: NOW - 500,
    leaseId: "lease-private-canary",
    modelId: "model-web-synthetic",
    providerRoute: "provider-private-canary",
    sessionGeneration: 1,
    sessionId: "session-private-canary",
    tabId: 7,
    ...overrides,
  };
}

function childBinding(overrides: Partial<AgentChildRequestBinding> = {}): AgentChildRequestBinding {
  return {
    promptCacheKey: "cache-private-canary",
    requestBindingId: "request-private-canary",
    requestPrefix: { input: ["synthetic"], model: "web-agent-test" },
    threadId: "thread-private-canary",
    turnId: "turn-private-canary",
    ...overrides,
  };
}

function certifiedTool(
  validateArguments: AgentCertifiedTool["validateArguments"] = (value) =>
    Object.keys(value).length === 1 && typeof value["cmd"] === "string",
  classifyResult: AgentCertifiedTool["classifyResult"] = () => true,
): AgentCertifiedTool {
  return {
    classifyResult,
    description: "Run a synthetic command fixture.",
    name: "exec_command",
    parameters: {
      additionalProperties: false,
      properties: { cmd: { type: "string" } },
      required: ["cmd"],
      type: "object",
    },
    validateArguments,
  };
}

function startRequest(
  overrides: Partial<AgentWorkflowStartRequest> = {},
): AgentWorkflowStartRequest {
  const request: AgentWorkflowStartRequest = {
    browser: browserBinding(),
    child: childBinding(),
    manifestDigest: "pending",
    parallelToolCalls: false as const,
    profileVersion: "fixture-v1",
    reasoningEffort: "medium",
    temporary: false,
    tools: [certifiedTool()],
    visibleRequest: {
      instructions: "Synthetic developer context.",
      messages: [{ content: ["synthetic-visible-request"], role: "user" }],
    },
    ...overrides,
  };
  return {
    ...request,
    manifestDigest:
      overrides.manifestDigest ??
      digestCanonical(canonicalizeToolWorkflowJson(manifestValue(request))),
  };
}

function manifestValue(request: AgentWorkflowStartRequest): JsonValue {
  return {
    parallelToolCalls: false,
    profileVersion: request.profileVersion,
    tools: request.tools.map((tool) => ({
      description: tool.description,
      name: tool.name,
      parameters: tool.parameters,
      strict: true,
      type: "function",
    })),
  };
}

async function produceToolCall(
  coordinator: AgentSessionCoordinator,
  boundary: FakeBoundary,
  request: AgentWorkflowStartRequest,
): Promise<AgentToolCallCommit> {
  const pending = coordinator.startWorkflow(request);
  await boundary.complete(
    0,
    toolCallEnvelope(readPublicBinding(readTurn(boundary, 0)), "exec_command", {
      cmd: "synthetic",
    }),
  );
  return expectToolCall(await pending);
}

function continuationRequest(
  commit: AgentToolCallCommit,
  request: AgentWorkflowStartRequest,
  output = "synthetic-output",
): AgentWorkflowContinuationRequest {
  return {
    child: request.child,
    items: [
      {
        argumentsJson: commit.argumentsJson,
        callId: commit.callId,
        itemId: commit.itemId,
        name: commit.tool,
        type: "function_call",
      },
      { callId: commit.callId, output, type: "function_call_output" },
    ],
    manifest: manifestValue(request),
  };
}

function mutateContinuation(
  value: AgentWorkflowContinuationRequest,
  mutation:
    | "arguments"
    | "callId"
    | "extraItem"
    | "itemId"
    | "manifest"
    | "outputCallId"
    | "promptCacheKey"
    | "requestBindingId"
    | "requestPrefix"
    | "threadId"
    | "toolName"
    | "turnId",
): AgentWorkflowContinuationRequest {
  const call = { ...value.items[0] };
  const output = { ...value.items[1] };
  let child = { ...value.child };
  let manifest = value.manifest;
  let items: unknown[] = [call, output];
  switch (mutation) {
    case "requestBindingId":
      child = { ...child, requestBindingId: "request-drift" };
      break;
    case "threadId":
      child = { ...child, threadId: "thread-drift" };
      break;
    case "turnId":
      child = { ...child, turnId: "turn-drift" };
      break;
    case "promptCacheKey":
      child = { ...child, promptCacheKey: "cache-drift" };
      break;
    case "requestPrefix":
      child = { ...child, requestPrefix: { drift: true } };
      break;
    case "manifest":
      manifest = { profileVersion: "drift", tools: [] };
      break;
    case "callId":
      call.callId = "call_drift";
      break;
    case "itemId":
      call.itemId = "fc_drift";
      break;
    case "toolName":
      call.name = "write_stdin";
      break;
    case "arguments":
      call.argumentsJson = "{}";
      break;
    case "outputCallId":
      output.callId = "call_drift";
      break;
    case "extraItem":
      items = [call, output, output];
      break;
  }
  return { child, items, manifest } as unknown as AgentWorkflowContinuationRequest;
}

function toolCallEnvelope(
  binding: PublicRoundBinding,
  tool: string,
  argumentsValue: JsonObject,
): string {
  return envelope({
    arguments: argumentsValue,
    challenge: binding.challenge,
    kind: "tool_call",
    manifestDigest: binding.manifestDigest,
    round: binding.round,
    tool,
    turn: binding.turn,
    v: 2,
  });
}

function finalEnvelope(binding: PublicRoundBinding, text: string): string {
  return envelope({
    challenge: binding.challenge,
    kind: "final",
    manifestDigest: binding.manifestDigest,
    round: binding.round,
    text,
    turn: binding.turn,
    v: 2,
  });
}

function envelope(value: JsonValue): string {
  return `${TOOL_WORKFLOW_ENVELOPE_BEGIN}\n${canonicalizeToolWorkflowJson(value)}\n${TOOL_WORKFLOW_ENVELOPE_END}`;
}

function readPrompt(turn: FakeTurn): string {
  const item = turn.request.input[0];
  if (item === undefined) {
    throw new Error("Missing synthetic prompt");
  }
  return item.text;
}

function readPublicBinding(turn: FakeTurn): PublicRoundBinding {
  const line = readPrompt(turn)
    .split("\n")
    .find((candidate) => candidate.startsWith("PUBLIC_BINDING "));
  if (line === undefined) {
    throw new Error("Missing public binding");
  }
  return JSON.parse(line.slice("PUBLIC_BINDING ".length)) as PublicRoundBinding;
}

function readPublicBindingFromEnvelope(value: string): PublicRoundBinding {
  const body = value.slice(
    `${TOOL_WORKFLOW_ENVELOPE_BEGIN}\n`.length,
    -`\n${TOOL_WORKFLOW_ENVELOPE_END}`.length,
  );
  const parsed = JSON.parse(body) as Record<string, unknown>;
  return {
    challenge: String(parsed["challenge"]),
    manifestDigest: String(parsed["manifestDigest"]),
    round: Number(parsed["round"]),
    turn: String(parsed["turn"]),
    v: Number(parsed["v"]),
  };
}

function readPublicBindingFromAnyPrompt(value: string): PublicRoundBinding {
  return value.startsWith(`${TOOL_WORKFLOW_ENVELOPE_BEGIN}\n`)
    ? readPublicBindingFromEnvelope(value)
    : readPublicBinding({ request: { input: [{ text: value, type: "text" }] } } as FakeTurn);
}

function readTurn(boundary: FakeBoundary, index: number): FakeTurn {
  const turn = boundary.turns[index];
  if (turn === undefined) {
    throw new Error(`Missing synthetic turn ${String(index)}`);
  }
  return turn;
}

function expectToolCall(
  value: Awaited<ReturnType<AgentSessionCoordinator["startWorkflow"]>>,
): AgentToolCallCommit {
  if (value.kind !== "tool_call") {
    throw new Error("Expected a synthetic tool call");
  }
  return value;
}

function deferred<Value>(): Deferred<Value> {
  let resolveValue: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve(value: Value): void {
      if (resolveValue === undefined) {
        throw new Error("Synthetic deferred is unavailable");
      }
      const resolve = resolveValue;
      resolveValue = undefined;
      resolve(value);
    },
  };
}

function digestCanonical(value: string): string {
  return `sha256-${createHash("sha256").update(value, "utf8").digest("base64url")}`;
}

function sameBinding(left: AgentBrowserBinding | undefined, right: AgentBrowserBinding): boolean {
  return (
    left !== undefined &&
    canonicalizeToolWorkflowJson(left as unknown as JsonValue) ===
      canonicalizeToolWorkflowJson(right as unknown as JsonValue)
  );
}
