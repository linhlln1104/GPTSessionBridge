using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using GPTSessionBridge.WindowsIpc.Interop;
using GPTSessionBridge.WindowsIpc.Security;
using Microsoft.Win32.SafeHandles;

namespace GPTSessionBridge.WindowsIpc.Transport;

internal static class SecurePipeFactory
{
  internal static async Task<NamedPipeServerStream> AcceptServerAsync(
      ProcessTokenIdentity currentIdentity,
      Action? onListening = null,
      TimeSpan? acceptTimeout = null)
  {
    NamedPipeServerStream server = CreateServer(currentIdentity);
    onListening?.Invoke();
    TimeSpan timeoutValue = acceptTimeout ?? PipeProtocolConstants.ServerAcceptTimeout;
    if (timeoutValue <= TimeSpan.Zero)
    {
      await server.DisposeAsync().ConfigureAwait(false);
      throw new ArgumentOutOfRangeException(nameof(acceptTimeout));
    }

    using CancellationTokenSource timeout = new(timeoutValue);
    try
    {
      await server.WaitForConnectionAsync(timeout.Token).ConfigureAwait(false);
      return server;
    }
    catch (OperationCanceledException error) when (timeout.IsCancellationRequested)
    {
      await server.DisposeAsync().ConfigureAwait(false);
      throw new IpcException("connection_timeout", error);
    }
    catch
    {
      await server.DisposeAsync().ConfigureAwait(false);
      throw;
    }
  }

  internal static NamedPipeServerStream CreateServer(ProcessTokenIdentity currentIdentity)
  {
    ArgumentNullException.ThrowIfNull(currentIdentity);
    string pipeName = PipeEndpoint.CreateFullName(currentIdentity);
    byte[] descriptor = PipeSecurityDescriptor.Build(currentIdentity);
    using SecurityDescriptorAllocation allocation = new(descriptor);
    CryptographicOperations.ZeroMemory(descriptor);

    NativeMethods.SecurityAttributes attributes = new()
    {
      Length = unchecked((uint)Marshal.SizeOf<NativeMethods.SecurityAttributes>()),
      SecurityDescriptor = allocation.Pointer,
      InheritHandle = 0,
    };
    uint openMode =
        NativeMethods.PipeAccessDuplex |
        NativeMethods.FileFlagFirstPipeInstance |
        NativeMethods.FileFlagOverlapped;
    nint rawHandle = NativeMethods.CreateNamedPipe(
        pipeName,
        openMode,
        NativeMethods.PipeRejectRemoteClients,
        maxInstances: 1,
        outputBufferSize: PipeProtocolConstants.KernelBufferBytes,
        inputBufferSize: PipeProtocolConstants.KernelBufferBytes,
        defaultTimeoutMilliseconds: unchecked((uint)PipeProtocolConstants.ClientConnectionTimeout.TotalMilliseconds),
        ref attributes);
    if (rawHandle == NativeMethods.InvalidHandleValue)
    {
      uint error = unchecked((uint)Marshal.GetLastPInvokeError());
      throw new IpcException(
          error == NativeMethods.ErrorAccessDenied || error == NativeMethods.ErrorPipeBusy
              ? "pipe_unavailable"
              : "pipe_create_failed");
    }

    SafePipeHandle safeHandle = new(rawHandle, ownsHandle: true);
    try
    {
      return new NamedPipeServerStream(
          PipeDirection.InOut,
          isAsync: true,
          isConnected: false,
          safeHandle);
    }
    catch
    {
      safeHandle.Dispose();
      throw;
    }
  }

  internal static async Task<NamedPipeClientStream> ConnectClientAsync(
      ProcessTokenIdentity currentIdentity)
  {
    ArgumentNullException.ThrowIfNull(currentIdentity);
    string pipeName = PipeEndpoint.CreateFullName(currentIdentity);
    long startedAt = Stopwatch.GetTimestamp();

    while (Stopwatch.GetElapsedTime(startedAt) < PipeProtocolConstants.ClientConnectionTimeout)
    {
      nint rawHandle = NativeMethods.CreateFile(
          pipeName,
          unchecked((uint)PipeSecurityDescriptor.ClientAccessMask),
          shareMode: 0,
          securityAttributes: nint.Zero,
          creationDisposition: NativeMethods.OpenExisting,
          flagsAndAttributes:
              NativeMethods.FileFlagOverlapped |
              NativeMethods.SecuritySqosPresent |
              NativeMethods.SecurityIdentification,
          templateFile: nint.Zero);
      if (rawHandle != NativeMethods.InvalidHandleValue)
      {
        SafePipeHandle safeHandle = new(rawHandle, ownsHandle: true);
        try
        {
          return new NamedPipeClientStream(
              PipeDirection.InOut,
              isAsync: true,
              isConnected: true,
              safeHandle);
        }
        catch
        {
          safeHandle.Dispose();
          throw;
        }
      }

      uint error = unchecked((uint)Marshal.GetLastPInvokeError());
      if (error != NativeMethods.ErrorFileNotFound && error != NativeMethods.ErrorPipeBusy)
      {
        throw new IpcException("pipe_connect_failed");
      }

      TimeSpan remaining = PipeProtocolConstants.ClientConnectionTimeout - Stopwatch.GetElapsedTime(startedAt);
      if (remaining <= TimeSpan.Zero)
      {
        break;
      }

      uint waitMilliseconds = unchecked((uint)Math.Clamp(remaining.TotalMilliseconds, 1, 250));
      if (!NativeMethods.WaitNamedPipe(pipeName, waitMilliseconds))
      {
        uint waitError = unchecked((uint)Marshal.GetLastPInvokeError());
        if (waitError != NativeMethods.ErrorFileNotFound &&
            waitError != NativeMethods.ErrorPipeBusy &&
            waitError != NativeMethods.ErrorSemTimeout)
        {
          throw new IpcException("pipe_connect_failed");
        }

        await Task.Delay(TimeSpan.FromMilliseconds(10)).ConfigureAwait(false);
      }
    }

    throw new IpcException("connection_timeout");
  }
}
