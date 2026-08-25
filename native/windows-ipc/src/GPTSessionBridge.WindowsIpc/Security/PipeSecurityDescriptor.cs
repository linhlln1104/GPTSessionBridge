using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using GPTSessionBridge.WindowsIpc.Interop;

namespace GPTSessionBridge.WindowsIpc.Security;

internal static class PipeSecurityDescriptor
{
  internal const int ClientAccessMask =
      unchecked((int)(
          NativeMethods.FileReadData |
          NativeMethods.FileWriteData |
          NativeMethods.FileReadAttributes |
          NativeMethods.FileWriteAttributes |
          NativeMethods.Synchronize));

  internal static byte[] Build(ProcessTokenIdentity identity)
  {
    ArgumentNullException.ThrowIfNull(identity);

    RawAcl discretionaryAcl = new(GenericAcl.AclRevision, capacity: 1);
    discretionaryAcl.InsertAce(
        0,
        new CommonAce(
            AceFlags.None,
            AceQualifier.AccessAllowed,
            ClientAccessMask,
            identity.LogonSid,
            isCallback: false,
            opaque: null));

    RawSecurityDescriptor descriptor = new(
        ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclProtected,
        identity.UserSid,
        group: null,
        systemAcl: null,
        discretionaryAcl);
    byte[] bytes = new byte[descriptor.BinaryLength];
    descriptor.GetBinaryForm(bytes, 0);
    return bytes;
  }
}

internal sealed class SecurityDescriptorAllocation : IDisposable
{
  private readonly int _length;
  private bool _disposed;

  internal SecurityDescriptorAllocation(byte[] descriptor)
  {
    ArgumentNullException.ThrowIfNull(descriptor);
    if (descriptor.Length == 0)
    {
      throw new IpcException("pipe_security_failed");
    }

    _length = descriptor.Length;
    Pointer = Marshal.AllocHGlobal(_length);
    Marshal.Copy(descriptor, 0, Pointer, _length);
  }

  internal nint Pointer { get; }

  public unsafe void Dispose()
  {
    if (_disposed)
    {
      return;
    }

    new Span<byte>((void*)Pointer, _length).Clear();
    Marshal.FreeHGlobal(Pointer);
    _disposed = true;
  }
}
