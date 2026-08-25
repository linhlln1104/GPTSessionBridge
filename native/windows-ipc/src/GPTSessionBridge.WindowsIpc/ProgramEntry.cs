using GPTSessionBridge.WindowsIpc.Security;
using GPTSessionBridge.WindowsIpc.Transport;

namespace GPTSessionBridge.WindowsIpc;

internal static class ProgramEntry
{
  private const int SuccessExitCode = 0;
  private const int InvalidInvocationExitCode = 64;
  private const int RuntimeFailureExitCode = 70;

  internal static async Task<int> RunAsync(string[] args)
  {
    if (!OperatingSystem.IsWindows() || args.Length != 1)
    {
      return InvalidInvocationExitCode;
    }

    PipeRole role;
    if (string.Equals(args[0], "server", StringComparison.Ordinal))
    {
      role = PipeRole.Server;
    }
    else if (string.Equals(args[0], "client", StringComparison.Ordinal))
    {
      role = PipeRole.Client;
    }
    else
    {
      return InvalidInvocationExitCode;
    }

    try
    {
      using ProcessTokenIdentity currentIdentity = ProcessTokenIdentity.ReadCurrent();
      await using Stream standardInput = Console.OpenStandardInput();
      await using Stream standardOutput = Console.OpenStandardOutput();
      System.IO.Pipes.PipeStream connectedPipe = role switch
      {
        PipeRole.Server => await SecurePipeFactory.AcceptServerAsync(
                currentIdentity,
                static () => Console.Error.WriteLine("ipc_listening"))
            .ConfigureAwait(false),
        PipeRole.Client => await SecurePipeFactory.ConnectClientAsync(currentIdentity).ConfigureAwait(false),
        _ => throw new IpcException("invalid_role"),
      };
      await using System.IO.Pipes.PipeStream pipe = connectedPipe;

      using VerifiedPeer peer = role switch
      {
        PipeRole.Server => PeerVerifier.VerifyClient(pipe.SafePipeHandle, currentIdentity),
        PipeRole.Client => PeerVerifier.VerifyServer(pipe.SafePipeHandle, currentIdentity),
        _ => throw new IpcException("invalid_role"),
      };

      Console.Error.WriteLine("ipc_connected");
      await LengthFramedRelay.RunDuplexAsync(standardInput, standardOutput, pipe)
          .ConfigureAwait(false);
      return SuccessExitCode;
    }
    catch (IpcException error)
    {
      Console.Error.WriteLine($"gptsessionbridge_windows_ipc:{error.Code}");
      return RuntimeFailureExitCode;
    }
    catch (Exception)
    {
      Console.Error.WriteLine("gptsessionbridge_windows_ipc:internal_error");
      return RuntimeFailureExitCode;
    }
  }

  private enum PipeRole
  {
    Server,
    Client,
  }
}
