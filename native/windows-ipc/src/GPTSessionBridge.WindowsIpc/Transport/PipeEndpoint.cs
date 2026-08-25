using System.Security.Cryptography;
using System.Text;
using GPTSessionBridge.WindowsIpc.Security;

namespace GPTSessionBridge.WindowsIpc.Transport;

internal static class PipeEndpoint
{
  private const string DomainSeparator = "gptsessionbridge/windows-ipc/pipe/v1/";

  internal static string CreateName(ProcessTokenIdentity identity)
  {
    ArgumentNullException.ThrowIfNull(identity);
    byte[] material = Encoding.UTF8.GetBytes(DomainSeparator + identity.LogonSid.Value);
    try
    {
      return $"gptsessionbridge-v{PipeProtocolConstants.ProtocolVersion}-{Convert.ToHexString(SHA256.HashData(material)).ToLowerInvariant()}";
    }
    finally
    {
      CryptographicOperations.ZeroMemory(material);
    }
  }

  internal static string CreateFullName(ProcessTokenIdentity identity)
  {
    return $@"\\.\pipe\{CreateName(identity)}";
  }
}
