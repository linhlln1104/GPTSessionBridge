using System.Diagnostics;
using GPTSessionBridge.WindowsIpc.Security;

namespace GPTSessionBridge.WindowsIpc.Tests;

public sealed class ProcessTokenIdentityTests
{
  [Fact]
  public void RetainedProcessHandleObservesPeerExit()
  {
    string pingPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.System),
        "ping.exe");
    ProcessStartInfo startInfo = new(pingPath)
    {
      CreateNoWindow = true,
      RedirectStandardError = true,
      RedirectStandardOutput = true,
      UseShellExecute = false,
    };
    startInfo.ArgumentList.Add("-n");
    startInfo.ArgumentList.Add("30");
    startInfo.ArgumentList.Add("127.0.0.1");

    using Process child = Process.Start(startInfo)
        ?? throw new InvalidOperationException("Test peer process did not start.");
    try
    {
      using ProcessTokenIdentity identity = ProcessTokenIdentity.Read(unchecked((uint)child.Id));
      Assert.True(identity.IsAlive());

      child.Kill();
      child.WaitForExit();

      Assert.False(identity.IsAlive());
    }
    finally
    {
      if (!child.HasExited)
      {
        child.Kill(entireProcessTree: true);
        child.WaitForExit();
      }
    }
  }
}
