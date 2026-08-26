import {
  NATIVE_MESSAGING_PROTOCOL_VERSION,
  nativeMessagingFrameSchema,
  peerRoleSchema,
  requestIdSchema,
  type NativeMessagingFrame,
  type NativeMessagingFrameType,
  type PeerRole,
} from "@gpt-session-bridge/protocol";

import { NativeLinkError } from "./errors.js";

export type NativeLinkMode = "initiator" | "responder";
export type NativeLinkState =
  "idle" | "awaitingHello" | "awaitingAcknowledgement" | "ready" | "closed";

export interface NativeLinkSessionOptions {
  readonly implementationVersion: string;
  readonly incomingApplicationTypes: readonly NativeMessagingFrameType[];
  readonly localPeer: PeerRole;
  readonly mode: NativeLinkMode;
  readonly outgoingApplicationTypes: readonly NativeMessagingFrameType[];
  readonly remotePeer: PeerRole;
}

export interface NativeLinkReceiveResult {
  readonly application?: NativeMessagingFrame;
  readonly response?: NativeMessagingFrame;
}

const TRANSPORT_FRAME_TYPES = new Set<NativeMessagingFrameType>([
  "ack",
  "heartbeat",
  "hello",
  "hello/acknowledged",
]);
const APPLICATION_FRAME_TYPES = new Set<NativeMessagingFrameType>([
  "session/connect",
  "session/connected",
  "session/disconnect",
  "session/disconnected",
  "agent/status/read",
  "agent/status/result",
  "agent/status/changed",
  "agent/activity/note",
  "agent/activity/result",
  "agent/turn/start",
  "capabilities/read",
  "capabilities/result",
  "capabilities/changed",
  "turn/start",
  "turn/started",
  "turn/delta",
  "turn/completed",
  "turn/cancel",
  "turn/cancelled",
  "turn/failed",
  "error",
]);

export class NativeLinkSession {
  readonly #implementationVersion: string;
  readonly #incomingApplicationTypes: ReadonlySet<NativeMessagingFrameType>;
  readonly #localPeer: PeerRole;
  readonly #mode: NativeLinkMode;
  readonly #outgoingApplicationTypes: ReadonlySet<NativeMessagingFrameType>;
  readonly #remotePeer: PeerRole;
  #expectedInboundSequence = 0;
  #handshakeRequestId: string | undefined;
  #nextOutboundSequence = 0;
  #pendingHeartbeats = new Map<number, string>();
  #state: NativeLinkState;

  public constructor(options: NativeLinkSessionOptions) {
    if (
      !isNativeLinkMode(options.mode) ||
      !peerRoleSchema.safeParse(options.localPeer).success ||
      !peerRoleSchema.safeParse(options.remotePeer).success ||
      options.localPeer === options.remotePeer ||
      !isImplementationVersion(options.implementationVersion) ||
      !isApplicationTypeSet(options.incomingApplicationTypes) ||
      !isApplicationTypeSet(options.outgoingApplicationTypes)
    ) {
      throw new RangeError("Invalid Native Messaging link options");
    }
    this.#implementationVersion = options.implementationVersion;
    this.#incomingApplicationTypes = new Set(options.incomingApplicationTypes);
    this.#localPeer = options.localPeer;
    this.#mode = options.mode;
    this.#outgoingApplicationTypes = new Set(options.outgoingApplicationTypes);
    this.#remotePeer = options.remotePeer;
    this.#state = options.mode === "initiator" ? "idle" : "awaitingHello";
  }

  public get state(): NativeLinkState {
    return this.#state;
  }

  public start(requestId: string): NativeMessagingFrame {
    if (this.#mode !== "initiator" || this.#state !== "idle") {
      return this.#reject("invalid_state");
    }

    try {
      requestIdSchema.parse(requestId);
      const frame = nativeMessagingFrameSchema.parse({
        protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
        requestId,
        sequence: this.#takeOutboundSequence(),
        type: "hello",
        payload: {
          implementationVersion: this.#implementationVersion,
          peer: this.#localPeer,
          supportedProtocolVersions: [NATIVE_MESSAGING_PROTOCOL_VERSION],
        },
      });
      this.#handshakeRequestId = requestId;
      this.#state = "awaitingAcknowledgement";
      return frame;
    } catch (error) {
      if (error instanceof NativeLinkError) {
        throw error;
      }
      return this.#reject("invalid_frame");
    }
  }

  public receive(value: unknown): NativeLinkReceiveResult {
    if (this.#state === "closed") {
      throw new NativeLinkError("invalid_state");
    }

    let frame: NativeMessagingFrame;
    try {
      frame = nativeMessagingFrameSchema.parse(value);
    } catch {
      return this.#reject("invalid_frame");
    }

    if (frame.sequence !== this.#expectedInboundSequence) {
      return this.#reject("sequence_violation");
    }

    if (this.#state === "awaitingHello") {
      return this.#acceptHello(frame);
    }
    if (this.#state === "awaitingAcknowledgement") {
      return this.#acceptHelloAcknowledgement(frame);
    }
    if (this.#state !== "ready") {
      return this.#reject("invalid_state");
    }

    this.#expectedInboundSequence += 1;
    switch (frame.type) {
      case "heartbeat":
        return {
          response: nativeMessagingFrameSchema.parse({
            protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
            requestId: frame.requestId,
            sequence: this.#takeOutboundSequence(),
            type: "ack",
            payload: { acknowledgedSequence: frame.sequence },
          }),
        };
      case "ack": {
        const requestId = this.#pendingHeartbeats.get(frame.payload.acknowledgedSequence);
        if (requestId !== frame.requestId) {
          return this.#reject("correlation_violation");
        }
        this.#pendingHeartbeats.delete(frame.payload.acknowledgedSequence);
        return {};
      }
      case "hello":
      case "hello/acknowledged":
        return this.#reject("invalid_state");
      default:
        if (!this.#incomingApplicationTypes.has(frame.type)) {
          return this.#reject("direction_violation");
        }
        return { application: frame };
    }
  }

  public sendApplication(value: unknown): NativeMessagingFrame {
    if (this.#state !== "ready") {
      return this.#reject("invalid_state");
    }

    let frame: NativeMessagingFrame;
    try {
      frame = nativeMessagingFrameSchema.parse(value);
    } catch {
      return this.#reject("invalid_frame");
    }
    if (!this.#outgoingApplicationTypes.has(frame.type)) {
      return this.#reject("direction_violation");
    }

    return nativeMessagingFrameSchema.parse({
      ...frame,
      protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
      sequence: this.#takeOutboundSequence(),
    });
  }

  public sendHeartbeat(requestId: string): NativeMessagingFrame {
    if (this.#state !== "ready") {
      return this.#reject("invalid_state");
    }
    if (this.#pendingHeartbeats.size > 0) {
      return this.#reject("invalid_state");
    }

    try {
      requestIdSchema.parse(requestId);
      const sequence = this.#takeOutboundSequence();
      const frame = nativeMessagingFrameSchema.parse({
        protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
        requestId,
        sequence,
        type: "heartbeat",
        payload: {},
      });
      this.#pendingHeartbeats.set(sequence, requestId);
      return frame;
    } catch (error) {
      if (error instanceof NativeLinkError) {
        throw error;
      }
      return this.#reject("invalid_frame");
    }
  }

  public close(): void {
    this.#state = "closed";
    this.#handshakeRequestId = undefined;
    this.#pendingHeartbeats.clear();
  }

  #acceptHello(frame: NativeMessagingFrame): NativeLinkReceiveResult {
    if (frame.type !== "hello") {
      return this.#reject("invalid_state");
    }
    if (frame.payload.peer !== this.#remotePeer) {
      return this.#reject("unexpected_peer");
    }

    this.#expectedInboundSequence = 1;
    this.#state = "ready";
    return {
      response: nativeMessagingFrameSchema.parse({
        protocolVersion: NATIVE_MESSAGING_PROTOCOL_VERSION,
        requestId: frame.requestId,
        sequence: this.#takeOutboundSequence(),
        type: "hello/acknowledged",
        payload: {
          implementationVersion: this.#implementationVersion,
          peer: this.#localPeer,
        },
      }),
    };
  }

  #acceptHelloAcknowledgement(frame: NativeMessagingFrame): NativeLinkReceiveResult {
    if (frame.type !== "hello/acknowledged") {
      return this.#reject("invalid_state");
    }
    if (frame.payload.peer !== this.#remotePeer) {
      return this.#reject("unexpected_peer");
    }
    if (frame.requestId !== this.#handshakeRequestId) {
      return this.#reject("correlation_violation");
    }

    this.#expectedInboundSequence = 1;
    this.#handshakeRequestId = undefined;
    this.#state = "ready";
    return {};
  }

  #takeOutboundSequence(): number {
    if (this.#nextOutboundSequence > Number.MAX_SAFE_INTEGER) {
      return this.#reject("sequence_exhausted");
    }
    const sequence = this.#nextOutboundSequence;
    this.#nextOutboundSequence += 1;
    return sequence;
  }

  #reject(code: ConstructorParameters<typeof NativeLinkError>[0]): never {
    this.close();
    throw new NativeLinkError(code);
  }
}

function isImplementationVersion(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(value);
}

function isNativeLinkMode(value: unknown): value is NativeLinkMode {
  return value === "initiator" || value === "responder";
}

function isApplicationTypeSet(types: readonly NativeMessagingFrameType[]): boolean {
  return (
    new Set(types).size === types.length &&
    types.every((type) => APPLICATION_FRAME_TYPES.has(type) && !TRANSPORT_FRAME_TYPES.has(type))
  );
}
