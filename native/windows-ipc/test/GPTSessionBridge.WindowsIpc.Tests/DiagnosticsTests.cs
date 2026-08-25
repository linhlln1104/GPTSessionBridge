namespace GPTSessionBridge.WindowsIpc.Tests;

public sealed class DiagnosticsTests
{
  [Fact]
  public void RejectsNonAllowlistedDiagnosticCodes()
  {
    Assert.Throws<ArgumentOutOfRangeException>(
        () => new IpcException("unsafe_dynamic_detail"));
  }
}
