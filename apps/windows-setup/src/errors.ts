export type WindowsSetupErrorCode =
  | "artifact_changed"
  | "artifact_hash_mismatch"
  | "artifact_missing"
  | "artifact_size_mismatch"
  | "filesystem_conflict"
  | "invalid_chrome_manifest"
  | "invalid_install_root"
  | "invalid_invocation"
  | "invalid_package_manifest"
  | "invalid_package_path"
  | "package_contents_mismatch"
  | "registry_conflict"
  | "registry_failure"
  | "unsupported_platform";

export class WindowsSetupError extends Error {
  public readonly code: WindowsSetupErrorCode;

  public constructor(code: WindowsSetupErrorCode, options: ErrorOptions = {}) {
    super(code, options);
    this.name = "WindowsSetupError";
    this.code = code;
  }
}
