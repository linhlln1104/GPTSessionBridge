namespace GPTSessionBridge.WindowsIpc;

internal static class PipeProtocolConstants
{
  internal const int HeaderBytes = 4;
  internal const int MaxFrameBytes = 1_048_576;
  internal const int KernelBufferBytes = 65_536;
  internal const int ProtocolVersion = 1;
  internal static readonly TimeSpan ClientConnectionTimeout = TimeSpan.FromSeconds(10);
  internal static readonly TimeSpan ServerAcceptTimeout = TimeSpan.FromSeconds(30);
}
