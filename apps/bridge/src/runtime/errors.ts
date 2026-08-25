export const BRIDGE_RUNTIME_ERROR_CODES = [
  "already_active",
  "child_exited",
  "codex_not_found",
  "invalid_codex_executable",
  "invalid_state",
  "reserved_override",
  "startup_failed",
] as const;

export type BridgeRuntimeErrorCode = (typeof BRIDGE_RUNTIME_ERROR_CODES)[number];

export class BridgeRuntimeError extends Error {
  public readonly code: BridgeRuntimeErrorCode;

  public constructor(code: BridgeRuntimeErrorCode) {
    super(code);
    this.name = "BridgeRuntimeError";
    this.code = code;
  }
}
