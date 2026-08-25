using GPTSessionBridge.WindowsIpc.Interop;
using Microsoft.Win32.SafeHandles;

namespace GPTSessionBridge.WindowsIpc.Security;

internal static class PeerVerifier
{
  internal static VerifiedPeer VerifyClient(
      SafePipeHandle pipe,
      ProcessTokenIdentity currentIdentity)
  {
    ArgumentNullException.ThrowIfNull(pipe);
    ArgumentNullException.ThrowIfNull(currentIdentity);

    return Verify(
        pipe,
        currentIdentity,
        NativeMethods.GetNamedPipeClientProcessId,
        NativeMethods.GetNamedPipeClientSessionId);
  }

  internal static VerifiedPeer VerifyServer(
      SafePipeHandle pipe,
      ProcessTokenIdentity currentIdentity)
  {
    ArgumentNullException.ThrowIfNull(pipe);
    ArgumentNullException.ThrowIfNull(currentIdentity);

    return Verify(
        pipe,
        currentIdentity,
        NativeMethods.GetNamedPipeServerProcessId,
        NativeMethods.GetNamedPipeServerSessionId);
  }

  private static VerifiedPeer Verify(
      SafePipeHandle pipe,
      ProcessTokenIdentity currentIdentity,
      PipeValueReader processIdReader,
      PipeValueReader sessionIdReader)
  {
    if (pipe.IsInvalid ||
        !processIdReader(pipe, out uint peerProcessId) ||
        !sessionIdReader(pipe, out uint pipeSessionId) ||
        peerProcessId == 0 ||
        peerProcessId == currentIdentity.ProcessId ||
        pipeSessionId != currentIdentity.SessionId)
    {
      throw new IpcException("peer_verification_failed");
    }

    ProcessTokenIdentity peerIdentity;
    try
    {
      peerIdentity = ProcessTokenIdentity.Read(peerProcessId);
    }
    catch (IpcException error)
    {
      throw new IpcException("peer_verification_failed", error);
    }

    if (peerIdentity.SessionId != currentIdentity.SessionId ||
        !peerIdentity.UserSid.Equals(currentIdentity.UserSid) ||
        !peerIdentity.LogonSid.Equals(currentIdentity.LogonSid) ||
        !processIdReader(pipe, out uint confirmedProcessId) ||
        !sessionIdReader(pipe, out uint confirmedSessionId) ||
        confirmedProcessId != peerProcessId ||
        confirmedSessionId != pipeSessionId ||
        !peerIdentity.IsAlive())
    {
      peerIdentity.Dispose();
      throw new IpcException("peer_verification_failed");
    }

    return new VerifiedPeer(peerIdentity);
  }

  private delegate bool PipeValueReader(SafePipeHandle pipe, out uint value);
}

internal sealed class VerifiedPeer : IDisposable
{
  private readonly ProcessTokenIdentity _identity;

  internal VerifiedPeer(ProcessTokenIdentity identity)
  {
    _identity = identity;
  }

  public void Dispose()
  {
    _identity.Dispose();
  }
}
