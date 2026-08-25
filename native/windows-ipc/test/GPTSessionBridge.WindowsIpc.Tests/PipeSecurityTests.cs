using System.Security.AccessControl;
using GPTSessionBridge.WindowsIpc.Interop;
using GPTSessionBridge.WindowsIpc.Security;
using GPTSessionBridge.WindowsIpc.Transport;

namespace GPTSessionBridge.WindowsIpc.Tests;

public sealed class PipeSecurityTests
{
  [Fact]
  public void DescriptorAllowsOnlyTheCurrentLogonSidWithoutInstanceCreation()
  {
    using ProcessTokenIdentity identity = ProcessTokenIdentity.ReadCurrent();

    byte[] bytes = PipeSecurityDescriptor.Build(identity);
    RawSecurityDescriptor descriptor = new(bytes, 0);

    Assert.True(descriptor.ControlFlags.HasFlag(ControlFlags.DiscretionaryAclPresent));
    Assert.True(descriptor.ControlFlags.HasFlag(ControlFlags.DiscretionaryAclProtected));
    Assert.Equal(identity.UserSid, descriptor.Owner);
    Assert.NotNull(descriptor.DiscretionaryAcl);
    Assert.Single(descriptor.DiscretionaryAcl);
    CommonAce ace = Assert.IsType<CommonAce>(descriptor.DiscretionaryAcl[0]);
    Assert.Equal(AceQualifier.AccessAllowed, ace.AceQualifier);
    Assert.Equal(identity.LogonSid, ace.SecurityIdentifier);
    Assert.Equal(PipeSecurityDescriptor.ClientAccessMask, ace.AccessMask);
    Assert.Equal(0, ace.AccessMask & 0x0000_0004);
  }

  [Fact]
  public void EndpointNameIsStableAndDoesNotContainTheSid()
  {
    using ProcessTokenIdentity identity = ProcessTokenIdentity.ReadCurrent();

    string first = PipeEndpoint.CreateName(identity);
    string second = PipeEndpoint.CreateName(identity);

    Assert.Equal(first, second);
    Assert.StartsWith("gptsessionbridge-v1-", first, StringComparison.Ordinal);
    Assert.DoesNotContain(identity.LogonSid.Value, first, StringComparison.Ordinal);
    Assert.Matches("^gptsessionbridge-v1-[a-f0-9]{64}$", first);
  }

  [Fact]
  public void ServerIsSingleInstanceAndRejectsRemoteClients()
  {
    using ProcessTokenIdentity identity = ProcessTokenIdentity.ReadCurrent();
    using System.IO.Pipes.NamedPipeServerStream first = SecurePipeFactory.CreateServer(identity);

    Assert.True(NativeMethods.GetNamedPipeInfo(
        first.SafePipeHandle,
        out uint flags,
        nint.Zero,
        nint.Zero,
        nint.Zero));
    Assert.NotEqual(0u, flags & NativeMethods.PipeRejectRemoteClients);

    IpcException error = Assert.Throws<IpcException>(() => SecurePipeFactory.CreateServer(identity));
    Assert.Equal("pipe_unavailable", error.Code);
  }

  [Fact]
  public async Task AcceptTimeoutBoundsAnOrphanedListenerAndReleasesOwnership()
  {
    using ProcessTokenIdentity identity = ProcessTokenIdentity.ReadCurrent();

    IpcException error = await Assert.ThrowsAsync<IpcException>(
        () => SecurePipeFactory.AcceptServerAsync(
            identity,
            acceptTimeout: TimeSpan.FromMilliseconds(50)));

    Assert.Equal("connection_timeout", error.Code);
    using System.IO.Pipes.NamedPipeServerStream replacement = SecurePipeFactory.CreateServer(identity);
    Assert.False(replacement.SafePipeHandle.IsInvalid);
  }
}
