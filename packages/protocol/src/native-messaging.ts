import { z } from "zod";

import { bridgeErrorSchema } from "./errors.js";
import { isSafeSingleLineText } from "./safe-text.js";

export const NATIVE_MESSAGING_PROTOCOL_VERSION = 2 as const;
export const AGENT_WORKFLOW_PROTOCOL_VERSION = 2 as const;
export const AGENT_ACTIVATION_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1_000;
export const MAX_TURN_INPUT_ITEMS = 16;
export const MAX_TURN_INPUT_TEXT_CHARACTERS = 65_536;
export const MAX_TURN_INPUT_TOTAL_CHARACTERS = 262_144;
export const MAX_TURN_DELTA_CHARACTERS = 16_384;

export const nativeMessagingProtocolVersionSchema = z.literal(NATIVE_MESSAGING_PROTOCOL_VERSION);

const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;

export const requestIdSchema = z.string().min(1).max(128).regex(opaqueIdPattern);
export const catalogRevisionSchema = z.string().min(1).max(128).regex(opaqueIdPattern);
export const sessionIdSchema = z.string().min(1).max(128).regex(opaqueIdPattern);
export const turnIdSchema = z.string().min(1).max(128).regex(opaqueIdPattern);
export const modelIdSchema = z.string().min(1).max(256).regex(modelIdPattern);
export const frameSequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const conversationOwnershipIdSchema = z.string().min(1).max(128).regex(opaqueIdPattern);
export const documentIdSchema = z.string().min(1).max(256).regex(opaqueIdPattern);
export const leaseIdSchema = z.string().min(1).max(128).regex(opaqueIdPattern);

const implementationVersionSchema = z.string().min(1).max(64).regex(opaqueIdPattern);
const displayNameSchema = z.string().min(1).max(128).refine(isSafeSingleLineText);

export const peerRoleSchema = z.enum(["bridge", "nativeHost", "extension"]);

export const sessionCloseReasonSchema = z.enum([
  "user",
  "shutdown",
  "replaced",
  "transportLost",
  "pageUnavailable",
]);

export const turnFinishReasonSchema = z.enum(["stop", "length"]);
export const turnDeltaChannelSchema = z.enum(["outputText", "reasoning", "commentary"]);
export const reasoningEffortSchema = z.string().min(1).max(64).regex(opaqueIdPattern);

export const reasoningEffortOptionSchema = z
  .object({
    reasoningEffort: reasoningEffortSchema,
    description: z.string().min(1).max(256).refine(isSafeSingleLineText),
  })
  .strict();

export const webModelDescriptorSchema = z
  .object({
    id: modelIdSchema,
    displayName: displayNameSchema,
    inputModalities: z.tuple([z.literal("text")]),
    supportedReasoningEfforts: z.array(reasoningEffortOptionSchema).min(1).max(16),
    defaultReasoningEffort: reasoningEffortSchema,
  })
  .strict()
  .superRefine((model, context) => {
    const effortIds = model.supportedReasoningEfforts.map((option) => option.reasoningEffort);

    if (new Set(effortIds).size !== effortIds.length) {
      context.addIssue({
        code: "custom",
        message: "Supported reasoning efforts must be unique.",
        path: ["supportedReasoningEfforts"],
      });
    }

    if (!effortIds.includes(model.defaultReasoningEffort)) {
      context.addIssue({
        code: "custom",
        message: "The default reasoning effort must be supported by the model.",
        path: ["defaultReasoningEffort"],
      });
    }
  });

export const browserCapabilitiesSchema = z
  .object({
    catalogRevision: catalogRevisionSchema,
    modelDiscovery: z.boolean(),
    streaming: z.boolean(),
    cancellation: z.boolean(),
    temporaryChat: z.boolean(),
    imageInput: z.literal(false),
    toolCalls: z.literal(false),
    models: z.array(webModelDescriptorSchema).max(128),
  })
  .strict()
  .superRefine((capabilities, context) => {
    const modelIds = capabilities.models.map((model) => model.id);

    if (new Set(modelIds).size !== modelIds.length) {
      context.addIssue({
        code: "custom",
        message: "Browser model identifiers must be unique.",
        path: ["models"],
      });
    }

    if (!capabilities.modelDiscovery && capabilities.models.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Models cannot be reported when model discovery is unavailable.",
        path: ["models"],
      });
    }
  });

export const agentActivationDocumentBindingSchema = z
  .object({
    documentId: documentIdSchema,
    generation: frameSequenceSchema,
    tabId: frameSequenceSchema,
  })
  .strict();

export const activeAgentStatusSnapshotSchema = z
  .object({
    binding: agentActivationDocumentBindingSchema,
    conversationOwnershipId: conversationOwnershipIdSchema,
    expiresAtMs: frameSequenceSchema,
    issuedAtMs: frameSequenceSchema,
    lastActivityAtMs: frameSequenceSchema,
    leaseId: leaseIdSchema,
    revision: frameSequenceSchema,
    state: z.literal("active"),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      snapshot.issuedAtMs > snapshot.lastActivityAtMs ||
      snapshot.lastActivityAtMs >
        Number.MAX_SAFE_INTEGER - AGENT_ACTIVATION_INACTIVITY_TIMEOUT_MS ||
      snapshot.expiresAtMs !== snapshot.lastActivityAtMs + AGENT_ACTIVATION_INACTIVITY_TIMEOUT_MS
    ) {
      context.addIssue({
        code: "custom",
        message: "The active agent status timestamps are inconsistent.",
      });
    }
  });

export const inactiveAgentStatusSnapshotSchema = z
  .object({
    revision: frameSequenceSchema,
    state: z.literal("inactive"),
  })
  .strict();

export const agentStatusSnapshotSchema = z.discriminatedUnion("state", [
  activeAgentStatusSnapshotSchema,
  inactiveAgentStatusSnapshotSchema,
]);

const agentStatusPayloadSchema = z
  .object({
    agentProtocolVersion: z.literal(AGENT_WORKFLOW_PROTOCOL_VERSION),
    sessionId: sessionIdSchema,
    status: agentStatusSnapshotSchema,
  })
  .strict();

const sessionPayloadSchema = z
  .object({
    sessionId: sessionIdSchema,
  })
  .strict();

const turnPayloadSchema = z
  .object({
    sessionId: sessionIdSchema,
    turnId: turnIdSchema,
  })
  .strict();

const textInputSchema = z
  .object({
    type: z.literal("text"),
    text: z.string().min(1).max(MAX_TURN_INPUT_TEXT_CHARACTERS),
  })
  .strict();

const turnInputSchema = z
  .array(textInputSchema)
  .min(1)
  .max(MAX_TURN_INPUT_ITEMS)
  .refine(
    (items) =>
      items.reduce((total, item) => total + item.text.length, 0) <= MAX_TURN_INPUT_TOTAL_CHARACTERS,
    { message: "Turn input exceeds the protocol character limit." },
  );

const agentTurnInputSchema = z.array(textInputSchema).length(1);

const frameBaseShape = {
  protocolVersion: nativeMessagingProtocolVersionSchema,
  requestId: requestIdSchema,
  sequence: frameSequenceSchema,
} as const;

const supportedProtocolVersionsSchema = z
  .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
  .min(1)
  .max(16)
  .refine((versions) => new Set(versions).size === versions.length, {
    message: "Supported protocol versions must be unique.",
  })
  .refine((versions) => versions.includes(NATIVE_MESSAGING_PROTOCOL_VERSION), {
    message: "The current protocol version must be advertised.",
  });

export const helloFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("hello"),
    payload: z
      .object({
        peer: peerRoleSchema,
        implementationVersion: implementationVersionSchema,
        supportedProtocolVersions: supportedProtocolVersionsSchema,
      })
      .strict(),
  })
  .strict();

export const helloAcknowledgedFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("hello/acknowledged"),
    payload: z
      .object({
        peer: peerRoleSchema,
        implementationVersion: implementationVersionSchema,
      })
      .strict(),
  })
  .strict();

export const heartbeatFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("heartbeat"),
    payload: z.object({}).strict(),
  })
  .strict();

export const acknowledgedFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("ack"),
    payload: z
      .object({
        acknowledgedSequence: frameSequenceSchema,
      })
      .strict(),
  })
  .strict();

export const sessionConnectFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("session/connect"),
    payload: sessionPayloadSchema,
  })
  .strict();

export const sessionConnectedFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("session/connected"),
    payload: sessionPayloadSchema,
  })
  .strict();

export const sessionDisconnectFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("session/disconnect"),
    payload: z
      .object({
        sessionId: sessionIdSchema,
        reason: sessionCloseReasonSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const sessionDisconnectedFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("session/disconnected"),
    payload: z
      .object({
        sessionId: sessionIdSchema,
        reason: sessionCloseReasonSchema,
      })
      .strict(),
  })
  .strict();

export const capabilitiesReadFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("capabilities/read"),
    payload: sessionPayloadSchema,
  })
  .strict();

export const capabilitiesResultFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("capabilities/result"),
    payload: z
      .object({
        sessionId: sessionIdSchema,
        capabilities: browserCapabilitiesSchema,
      })
      .strict(),
  })
  .strict();

export const capabilitiesChangedFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("capabilities/changed"),
    payload: z
      .object({
        sessionId: sessionIdSchema,
        capabilities: browserCapabilitiesSchema,
      })
      .strict(),
  })
  .strict();

export const agentStatusReadFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("agent/status/read"),
    payload: sessionPayloadSchema,
  })
  .strict();

export const agentStatusResultFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("agent/status/result"),
    payload: agentStatusPayloadSchema,
  })
  .strict();

export const agentStatusChangedFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("agent/status/changed"),
    payload: agentStatusPayloadSchema,
  })
  .strict();

export const agentActivityNoteFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("agent/activity/note"),
    payload: z
      .object({
        expected: activeAgentStatusSnapshotSchema,
        sessionId: sessionIdSchema,
      })
      .strict(),
  })
  .strict();

export const agentActivityResultFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("agent/activity/result"),
    payload: z
      .object({
        agentProtocolVersion: z.literal(AGENT_WORKFLOW_PROTOCOL_VERSION),
        sessionId: sessionIdSchema,
        status: activeAgentStatusSnapshotSchema,
      })
      .strict(),
  })
  .strict();

export const agentTurnStartFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("agent/turn/start"),
    payload: z
      .object({
        agentProtocolVersion: z.literal(AGENT_WORKFLOW_PROTOCOL_VERSION),
        catalogRevision: catalogRevisionSchema,
        expected: activeAgentStatusSnapshotSchema,
        input: agentTurnInputSchema,
        modelId: modelIdSchema,
        reasoningEffort: reasoningEffortSchema,
        sessionId: sessionIdSchema,
        temporary: z.literal(false),
        turnId: turnIdSchema,
      })
      .strict(),
  })
  .strict();

export const turnStartFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("turn/start"),
    payload: z
      .object({
        sessionId: sessionIdSchema,
        turnId: turnIdSchema,
        catalogRevision: catalogRevisionSchema,
        modelId: modelIdSchema,
        reasoningEffort: reasoningEffortSchema,
        input: turnInputSchema,
        temporary: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const turnStartedFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("turn/started"),
    payload: turnPayloadSchema,
  })
  .strict();

export const turnDeltaFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("turn/delta"),
    payload: z
      .object({
        sessionId: sessionIdSchema,
        turnId: turnIdSchema,
        channel: turnDeltaChannelSchema,
        delta: z.string().min(1).max(MAX_TURN_DELTA_CHARACTERS),
      })
      .strict(),
  })
  .strict();

export const turnCompletedFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("turn/completed"),
    payload: z
      .object({
        sessionId: sessionIdSchema,
        turnId: turnIdSchema,
        finishReason: turnFinishReasonSchema,
      })
      .strict(),
  })
  .strict();

export const turnCancelFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("turn/cancel"),
    payload: turnPayloadSchema,
  })
  .strict();

export const turnCancelledFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("turn/cancelled"),
    payload: turnPayloadSchema,
  })
  .strict();

export const turnFailedFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("turn/failed"),
    payload: z
      .object({
        sessionId: sessionIdSchema,
        turnId: turnIdSchema,
        error: bridgeErrorSchema,
      })
      .strict(),
  })
  .strict();

export const errorFrameSchema = z
  .object({
    ...frameBaseShape,
    type: z.literal("error"),
    payload: z
      .object({
        error: bridgeErrorSchema,
      })
      .strict(),
  })
  .strict();

/**
 * Native Messaging is a security boundary, so every v2 frame and payload is
 * closed to unknown fields. Additions require a protocol-version change or a
 * new explicit variant.
 */
export const nativeMessagingFrameSchema = z.discriminatedUnion("type", [
  helloFrameSchema,
  helloAcknowledgedFrameSchema,
  heartbeatFrameSchema,
  acknowledgedFrameSchema,
  sessionConnectFrameSchema,
  sessionConnectedFrameSchema,
  sessionDisconnectFrameSchema,
  sessionDisconnectedFrameSchema,
  capabilitiesReadFrameSchema,
  capabilitiesResultFrameSchema,
  capabilitiesChangedFrameSchema,
  agentStatusReadFrameSchema,
  agentStatusResultFrameSchema,
  agentStatusChangedFrameSchema,
  agentActivityNoteFrameSchema,
  agentActivityResultFrameSchema,
  agentTurnStartFrameSchema,
  turnStartFrameSchema,
  turnStartedFrameSchema,
  turnDeltaFrameSchema,
  turnCompletedFrameSchema,
  turnCancelFrameSchema,
  turnCancelledFrameSchema,
  turnFailedFrameSchema,
  errorFrameSchema,
]);

export type PeerRole = z.infer<typeof peerRoleSchema>;
export type SessionCloseReason = z.infer<typeof sessionCloseReasonSchema>;
export type TurnFinishReason = z.infer<typeof turnFinishReasonSchema>;
export type TurnDeltaChannel = z.infer<typeof turnDeltaChannelSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type WebModelDescriptor = z.infer<typeof webModelDescriptorSchema>;
export type BrowserCapabilities = z.infer<typeof browserCapabilitiesSchema>;
export type AgentActivationDocumentBinding = z.infer<typeof agentActivationDocumentBindingSchema>;
export type ActiveAgentStatusSnapshot = z.infer<typeof activeAgentStatusSnapshotSchema>;
export type InactiveAgentStatusSnapshot = z.infer<typeof inactiveAgentStatusSnapshotSchema>;
export type AgentStatusSnapshot = z.infer<typeof agentStatusSnapshotSchema>;
export type NativeMessagingFrame = z.infer<typeof nativeMessagingFrameSchema>;
export type NativeMessagingFrameType = NativeMessagingFrame["type"];
export type NativeMessagingFrameOf<Type extends NativeMessagingFrameType> = Extract<
  NativeMessagingFrame,
  { type: Type }
>;
