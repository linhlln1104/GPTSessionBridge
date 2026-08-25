import { assertExactKeys, readInteger, toDataRecord } from "./internal/validation.js";

export interface MessageSizePolicy {
  readonly maxBufferedBytes: number;
  readonly maxFrameBytes: number;
}

export interface TimeoutPolicy {
  readonly handshakeMs: number;
  readonly idleMs: number;
  readonly requestMs: number;
  readonly shutdownGraceMs: number;
}

export interface ReplayPolicy {
  readonly maxTrackedNonces: number;
  readonly nonceBytes: number;
  readonly windowMs: number;
}

export interface TransportSecurityPolicy {
  readonly replay: ReplayPolicy;
  readonly size: MessageSizePolicy;
  readonly timeout: TimeoutPolicy;
}

const TOP_LEVEL_KEYS = new Set(["replay", "size", "timeout"]);
const SIZE_KEYS = new Set(["maxBufferedBytes", "maxFrameBytes"]);
const TIMEOUT_KEYS = new Set(["handshakeMs", "idleMs", "requestMs", "shutdownGraceMs"]);
const REPLAY_KEYS = new Set(["maxTrackedNonces", "nonceBytes", "windowMs"]);

export const DEFAULT_TRANSPORT_SECURITY_POLICY: TransportSecurityPolicy = deepFreezePolicy({
  replay: {
    maxTrackedNonces: 2_048,
    nonceBytes: 24,
    windowMs: 60_000,
  },
  size: {
    maxBufferedBytes: 2_097_152,
    maxFrameBytes: 1_048_576,
  },
  timeout: {
    handshakeMs: 10_000,
    idleMs: 30_000,
    requestMs: 120_000,
    shutdownGraceMs: 5_000,
  },
});

export const transportSecurityPolicySchema = Object.freeze({
  parse: parseTransportSecurityPolicy,
  safeParse(
    value: unknown,
  ):
    | { readonly success: true; readonly data: TransportSecurityPolicy }
    | { readonly success: false } {
    try {
      return { data: parseTransportSecurityPolicy(value), success: true };
    } catch {
      return { success: false };
    }
  },
});

export function parseTransportSecurityPolicy(value: unknown): TransportSecurityPolicy {
  const policy = toDataRecord(value);
  assertExactKeys(policy, TOP_LEVEL_KEYS);

  const size = toDataRecord(policy["size"]);
  assertExactKeys(size, SIZE_KEYS);
  const maxFrameBytes = readInteger(size["maxFrameBytes"], 1_024, 16_777_216);
  const maxBufferedBytes = readInteger(size["maxBufferedBytes"], maxFrameBytes, 67_108_864);

  const timeout = toDataRecord(policy["timeout"]);
  assertExactKeys(timeout, TIMEOUT_KEYS);
  const handshakeMs = readInteger(timeout["handshakeMs"], 100, 60_000);
  const requestMs = readInteger(timeout["requestMs"], handshakeMs, 600_000);
  const idleMs = readInteger(timeout["idleMs"], 100, requestMs);
  const shutdownGraceMs = readInteger(timeout["shutdownGraceMs"], 100, 60_000);

  const replay = toDataRecord(policy["replay"]);
  assertExactKeys(replay, REPLAY_KEYS);
  const windowMs = readInteger(replay["windowMs"], 1_000, 300_000);
  const maxTrackedNonces = readInteger(replay["maxTrackedNonces"], 1, 100_000);
  const nonceBytes = readInteger(replay["nonceBytes"], 16, 64);

  return deepFreezePolicy({
    replay: { maxTrackedNonces, nonceBytes, windowMs },
    size: { maxBufferedBytes, maxFrameBytes },
    timeout: { handshakeMs, idleMs, requestMs, shutdownGraceMs },
  });
}

function deepFreezePolicy(policy: TransportSecurityPolicy): TransportSecurityPolicy {
  Object.freeze(policy.replay);
  Object.freeze(policy.size);
  Object.freeze(policy.timeout);
  return Object.freeze(policy);
}
