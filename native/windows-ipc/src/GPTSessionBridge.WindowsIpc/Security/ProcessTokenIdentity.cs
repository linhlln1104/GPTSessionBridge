using System.Runtime.InteropServices;
using System.Security.Principal;
using GPTSessionBridge.WindowsIpc.Interop;
using Microsoft.Win32.SafeHandles;

namespace GPTSessionBridge.WindowsIpc.Security;

internal sealed class ProcessTokenIdentity : IDisposable
{
  private ProcessTokenIdentity(
      uint processId,
      uint sessionId,
      SecurityIdentifier userSid,
      SecurityIdentifier logonSid,
      SafeProcessHandle processHandle)
  {
    ProcessId = processId;
    SessionId = sessionId;
    UserSid = userSid;
    LogonSid = logonSid;
    ProcessHandle = processHandle;
  }

  internal uint ProcessId { get; }

  internal uint SessionId { get; }

  internal SecurityIdentifier UserSid { get; }

  internal SecurityIdentifier LogonSid { get; }

  internal SafeProcessHandle ProcessHandle { get; }

  internal static ProcessTokenIdentity ReadCurrent()
  {
    return Read(unchecked((uint)Environment.ProcessId));
  }

  internal static ProcessTokenIdentity Read(uint processId)
  {
    if (processId == 0)
    {
      throw new IpcException("peer_identity_failed");
    }

    SafeProcessHandle process = NativeMethods.OpenProcess(
        NativeMethods.ProcessQueryLimitedInformation | NativeMethods.Synchronize,
        inheritHandle: false,
        processId);
    if (process.IsInvalid)
    {
      process.Dispose();
      throw new IpcException("peer_identity_failed");
    }

    try
    {
      if (!NativeMethods.ProcessIdToSessionId(processId, out uint processSessionId) ||
          !IsProcessAlive(process) ||
          !NativeMethods.OpenProcessToken(process, NativeMethods.TokenQuery, out SafeAccessTokenHandle token))
      {
        throw new IpcException("peer_identity_failed");
      }

      using (token)
      {
        SecurityIdentifier userSid = ReadUserSid(token);
        SecurityIdentifier logonSid = ReadLogonSid(token);
        uint tokenSessionId = ReadTokenSessionId(token);
        if (tokenSessionId != processSessionId)
        {
          throw new IpcException("peer_identity_failed");
        }

        return new ProcessTokenIdentity(
            processId,
            processSessionId,
            userSid,
            logonSid,
            process);
      }
    }
    catch
    {
      process.Dispose();
      throw;
    }
  }

  public void Dispose()
  {
    ProcessHandle.Dispose();
  }

  internal bool IsAlive()
  {
    return IsProcessAlive(ProcessHandle);
  }

  private static SecurityIdentifier ReadUserSid(SafeAccessTokenHandle token)
  {
    using TokenInformationBuffer buffer = ReadTokenInformation(
        token,
        NativeMethods.TokenInformationClass.TokenUser);
    TokenUser tokenUser = Marshal.PtrToStructure<TokenUser>(buffer.Pointer);
    if (tokenUser.User.Sid == nint.Zero)
    {
      throw new IpcException("peer_identity_failed");
    }

    return new SecurityIdentifier(tokenUser.User.Sid);
  }

  private static bool IsProcessAlive(SafeProcessHandle process)
  {
    return !process.IsInvalid &&
        !process.IsClosed &&
        NativeMethods.WaitForSingleObject(process, milliseconds: 0) == NativeMethods.WaitTimeout;
  }

  private static SecurityIdentifier ReadLogonSid(SafeAccessTokenHandle token)
  {
    using TokenInformationBuffer buffer = ReadTokenInformation(
        token,
        NativeMethods.TokenInformationClass.TokenGroups);
    uint groupCount = unchecked((uint)Marshal.ReadInt32(buffer.Pointer));
    if (groupCount == 0 || groupCount > 4_096)
    {
      throw new IpcException("peer_identity_failed");
    }

    int groupsOffset = Marshal.OffsetOf<TokenGroups>(nameof(TokenGroups.Groups)).ToInt32();
    int groupSize = Marshal.SizeOf<SidAndAttributes>();
    long requiredLength = checked(groupsOffset + ((long)groupCount * groupSize));
    if (requiredLength > buffer.Length)
    {
      throw new IpcException("peer_identity_failed");
    }

    for (uint index = 0; index < groupCount; index += 1)
    {
      nint groupPointer = buffer.Pointer + groupsOffset + checked((int)index * groupSize);
      SidAndAttributes group = Marshal.PtrToStructure<SidAndAttributes>(groupPointer);
      if ((group.Attributes & NativeMethods.SeGroupLogonId) == NativeMethods.SeGroupLogonId &&
          group.Sid != nint.Zero)
      {
        return new SecurityIdentifier(group.Sid);
      }
    }

    throw new IpcException("peer_identity_failed");
  }

  private static uint ReadTokenSessionId(SafeAccessTokenHandle token)
  {
    using TokenInformationBuffer buffer = ReadTokenInformation(
        token,
        NativeMethods.TokenInformationClass.TokenSessionId);
    if (buffer.Length < sizeof(uint))
    {
      throw new IpcException("peer_identity_failed");
    }

    return unchecked((uint)Marshal.ReadInt32(buffer.Pointer));
  }

  private static TokenInformationBuffer ReadTokenInformation(
      SafeAccessTokenHandle token,
      NativeMethods.TokenInformationClass informationClass)
  {
    _ = NativeMethods.GetTokenInformation(token, informationClass, nint.Zero, 0, out uint length);
    if (length == 0 || length > 1_048_576)
    {
      throw new IpcException("peer_identity_failed");
    }

    TokenInformationBuffer buffer = new(length);
    if (!NativeMethods.GetTokenInformation(token, informationClass, buffer.Pointer, length, out uint written) ||
        written == 0 ||
        written > length)
    {
      buffer.Dispose();
      throw new IpcException("peer_identity_failed");
    }

    return buffer;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct SidAndAttributes
  {
    internal nint Sid;
    internal uint Attributes;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct TokenUser
  {
    internal SidAndAttributes User;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct TokenGroups
  {
    internal uint GroupCount;
    internal SidAndAttributes Groups;
  }

  private sealed class TokenInformationBuffer : IDisposable
  {
    private bool _disposed;

    internal TokenInformationBuffer(uint length)
    {
      Length = length;
      Pointer = Marshal.AllocHGlobal(checked((int)length));
    }

    internal uint Length { get; }

    internal nint Pointer { get; }

    public unsafe void Dispose()
    {
      if (_disposed)
      {
        return;
      }

      new Span<byte>((void*)Pointer, checked((int)Length)).Clear();
      Marshal.FreeHGlobal(Pointer);
      _disposed = true;
    }
  }
}
