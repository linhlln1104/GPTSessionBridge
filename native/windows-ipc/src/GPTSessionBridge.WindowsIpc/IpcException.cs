using System.Collections.Frozen;

namespace GPTSessionBridge.WindowsIpc;

internal sealed class IpcException : Exception
{
  private static readonly FrozenSet<string> AllowedCodes = new[]
  {
        "connection_timeout",
        "invalid_frame_length",
        "invalid_role",
        "peer_identity_failed",
        "peer_verification_failed",
        "pipe_connect_failed",
        "pipe_create_failed",
        "pipe_security_failed",
        "pipe_unavailable",
        "relay_failed",
        "truncated_frame",
    }.ToFrozenSet(StringComparer.Ordinal);

  internal IpcException(string code)
      : base(ValidateCode(code))
  {
    Code = Message;
  }

  internal IpcException(string code, Exception innerException)
      : base(ValidateCode(code), innerException)
  {
    Code = Message;
  }

  internal string Code { get; }

  private static string ValidateCode(string code)
  {
    return AllowedCodes.Contains(code)
        ? code
        : throw new ArgumentOutOfRangeException(nameof(code));
  }
}
