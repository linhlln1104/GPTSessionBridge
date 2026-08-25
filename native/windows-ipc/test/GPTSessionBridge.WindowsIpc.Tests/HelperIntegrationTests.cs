using System.Buffers.Binary;
using System.Diagnostics;

namespace GPTSessionBridge.WindowsIpc.Tests;

public sealed class HelperIntegrationTests
{
  private static readonly TimeSpan TestTimeout = TimeSpan.FromSeconds(20);

  [Fact]
  public async Task ServerAndClientVerifyEachOtherAndRelayBothDirections()
  {
    using Process server = StartHelper("server");
    using Process client = StartHelper("client");

    try
    {
      Assert.Equal("ipc_listening", await ReadLineAsync(server.StandardError));
      Assert.Equal("ipc_connected", await ReadLineAsync(server.StandardError));
      Assert.Equal("ipc_connected", await ReadLineAsync(client.StandardError));

      byte[] serverFrame = CreateFrame([1, 2, 3, 4]);
      await server.StandardInput.BaseStream.WriteAsync(serverFrame);
      await server.StandardInput.BaseStream.FlushAsync();
      Assert.Equal(serverFrame, await ReadExactlyAsync(client.StandardOutput.BaseStream, serverFrame.Length));

      byte[] clientFrame = CreateFrame([5, 6, 7]);
      await client.StandardInput.BaseStream.WriteAsync(clientFrame);
      await client.StandardInput.BaseStream.FlushAsync();
      Assert.Equal(clientFrame, await ReadExactlyAsync(server.StandardOutput.BaseStream, clientFrame.Length));

      server.StandardInput.Close();
      client.StandardInput.Close();
      await Task.WhenAll(server.WaitForExitAsync(), client.WaitForExitAsync()).WaitAsync(TestTimeout);

      Assert.Equal(0, server.ExitCode);
      Assert.Equal(0, client.ExitCode);
      Assert.Equal(string.Empty, await server.StandardError.ReadToEndAsync());
      Assert.Equal(string.Empty, await client.StandardError.ReadToEndAsync());
    }
    finally
    {
      StopHelper(server);
      StopHelper(client);
    }
  }

  private static Process StartHelper(string role)
  {
    string assemblyDirectory = Path.GetDirectoryName(typeof(ProgramEntry).Assembly.Location)
      ?? throw new InvalidOperationException("Helper assembly directory is unavailable.");
    string helperPath = Path.Combine(assemblyDirectory, "gptsessionbridge-windows-ipc.exe");
    ProcessStartInfo startInfo = new(helperPath)
    {
      CreateNoWindow = true,
      RedirectStandardError = true,
      RedirectStandardInput = true,
      RedirectStandardOutput = true,
      UseShellExecute = false,
    };
    startInfo.ArgumentList.Add(role);
    return Process.Start(startInfo) ?? throw new InvalidOperationException("Helper did not start.");
  }

  private static async Task<string?> ReadLineAsync(StreamReader reader)
  {
    return await reader.ReadLineAsync().WaitAsync(TestTimeout);
  }

  private static async Task<byte[]> ReadExactlyAsync(Stream stream, int length)
  {
    byte[] buffer = new byte[length];
    await stream.ReadExactlyAsync(buffer).AsTask().WaitAsync(TestTimeout);
    return buffer;
  }

  private static byte[] CreateFrame(byte[] payload)
  {
    byte[] frame = new byte[4 + payload.Length];
    BinaryPrimitives.WriteUInt32LittleEndian(frame, unchecked((uint)payload.Length));
    payload.CopyTo(frame, 4);
    return frame;
  }

  private static void StopHelper(Process process)
  {
    if (!process.HasExited)
    {
      process.Kill(entireProcessTree: true);
      process.WaitForExit();
    }
  }
}
