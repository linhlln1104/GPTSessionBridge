import type { NativeMessagingFrame } from "@gpt-session-bridge/protocol";

import { NativeLinkError } from "./errors.js";
import { NativeLinkSession, type NativeLinkState } from "./link-session.js";
import {
  BRIDGE_TO_EXTENSION_APPLICATION_TYPES,
  EXTENSION_TO_BRIDGE_APPLICATION_TYPES,
} from "./relay-policy.js";

export interface NativeHostRelayOptions {
  readonly implementationVersion: string;
}

export interface NativeHostRelayState {
  readonly bridge: NativeLinkState;
  readonly extension: NativeLinkState;
}

export interface NativeHostRelayResult {
  readonly toBridge?: NativeMessagingFrame;
  readonly toExtension?: NativeMessagingFrame;
}

/**
 * Terminates link-local transport semantics and re-envelopes allowlisted
 * application frames. Application request correlation, browser-session state,
 * and exactly-once turn termination belong to the bridge coordinator and must
 * be enforced before a relayed frame can affect a Responses request.
 */
export class NativeHostRelay {
  readonly #bridge: NativeLinkSession;
  readonly #extension: NativeLinkSession;

  public constructor(options: NativeHostRelayOptions) {
    this.#bridge = new NativeLinkSession({
      implementationVersion: options.implementationVersion,
      incomingApplicationTypes: BRIDGE_TO_EXTENSION_APPLICATION_TYPES,
      localPeer: "nativeHost",
      mode: "initiator",
      outgoingApplicationTypes: EXTENSION_TO_BRIDGE_APPLICATION_TYPES,
      remotePeer: "bridge",
    });
    this.#extension = new NativeLinkSession({
      implementationVersion: options.implementationVersion,
      incomingApplicationTypes: EXTENSION_TO_BRIDGE_APPLICATION_TYPES,
      localPeer: "nativeHost",
      mode: "responder",
      outgoingApplicationTypes: BRIDGE_TO_EXTENSION_APPLICATION_TYPES,
      remotePeer: "extension",
    });
  }

  public get state(): NativeHostRelayState {
    return Object.freeze({ bridge: this.#bridge.state, extension: this.#extension.state });
  }

  public startBridgeHandshake(requestId: string): NativeMessagingFrame {
    return this.#guard(() => this.#bridge.start(requestId));
  }

  public receiveFromBridge(value: unknown): NativeHostRelayResult {
    return this.#guard(() => {
      const result = this.#bridge.receive(value);
      if (result.response !== undefined) {
        return { toBridge: result.response };
      }
      if (result.application !== undefined) {
        if (this.#extension.state !== "ready") {
          throw new NativeLinkError("destination_unavailable");
        }
        return { toExtension: this.#extension.sendApplication(result.application) };
      }
      return {};
    });
  }

  public receiveFromExtension(value: unknown): NativeHostRelayResult {
    return this.#guard(() => {
      const result = this.#extension.receive(value);
      if (result.response !== undefined) {
        return { toExtension: result.response };
      }
      if (result.application !== undefined) {
        if (this.#bridge.state !== "ready") {
          throw new NativeLinkError("destination_unavailable");
        }
        return { toBridge: this.#bridge.sendApplication(result.application) };
      }
      return {};
    });
  }

  public close(): void {
    this.#bridge.close();
    this.#extension.close();
  }

  #guard<Result>(operation: () => Result): Result {
    try {
      return operation();
    } catch (error) {
      this.close();
      throw error;
    }
  }
}
