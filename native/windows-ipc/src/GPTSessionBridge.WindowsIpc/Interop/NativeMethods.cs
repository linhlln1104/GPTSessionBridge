using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace GPTSessionBridge.WindowsIpc.Interop;

internal static partial class NativeMethods
{
  internal const uint ErrorAccessDenied = 5;
  internal const uint ErrorFileNotFound = 2;
  internal const uint ErrorInsufficientBuffer = 122;
  internal const uint ErrorPipeBusy = 231;
  internal const uint ErrorSemTimeout = 121;
  internal const uint FileFlagFirstPipeInstance = 0x0008_0000;
  internal const uint FileFlagOverlapped = 0x4000_0000;
  internal const uint FileReadAttributes = 0x0000_0080;
  internal const uint FileReadData = 0x0000_0001;
  internal const uint FileWriteAttributes = 0x0000_0100;
  internal const uint FileWriteData = 0x0000_0002;
  internal const uint OpenExisting = 3;
  internal const uint PipeAccessDuplex = 0x0000_0003;
  internal const uint PipeRejectRemoteClients = 0x0000_0008;
  internal const uint ProcessQueryLimitedInformation = 0x0000_1000;
  internal const uint SecurityIdentification = 0x0001_0000;
  internal const uint SecuritySqosPresent = 0x0010_0000;
  internal const uint SeGroupLogonId = 0xC000_0000;
  internal const uint Synchronize = 0x0010_0000;
  internal const uint TokenQuery = 0x0000_0008;
  internal const uint WaitTimeout = 258;

  internal static readonly nint InvalidHandleValue = new(-1);

  [LibraryImport("kernel32.dll", EntryPoint = "CreateFileW", SetLastError = true,
      StringMarshalling = StringMarshalling.Utf16)]
  internal static partial nint CreateFile(
      string fileName,
      uint desiredAccess,
      uint shareMode,
      nint securityAttributes,
      uint creationDisposition,
      uint flagsAndAttributes,
      nint templateFile);

  [LibraryImport("kernel32.dll", EntryPoint = "CreateNamedPipeW", SetLastError = true,
      StringMarshalling = StringMarshalling.Utf16)]
  internal static partial nint CreateNamedPipe(
      string name,
      uint openMode,
      uint pipeMode,
      uint maxInstances,
      uint outputBufferSize,
      uint inputBufferSize,
      uint defaultTimeoutMilliseconds,
      ref SecurityAttributes securityAttributes);

  [LibraryImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  internal static partial bool GetNamedPipeClientProcessId(
      SafePipeHandle pipe,
      out uint clientProcessId);

  [LibraryImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  internal static partial bool GetNamedPipeClientSessionId(
      SafePipeHandle pipe,
      out uint clientSessionId);

  [LibraryImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  internal static partial bool GetNamedPipeInfo(
      SafePipeHandle pipe,
      out uint flags,
      nint outputBufferSize,
      nint inputBufferSize,
      nint maxInstances);

  [LibraryImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  internal static partial bool GetNamedPipeServerProcessId(
      SafePipeHandle pipe,
      out uint serverProcessId);

  [LibraryImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  internal static partial bool GetNamedPipeServerSessionId(
      SafePipeHandle pipe,
      out uint serverSessionId);

  [LibraryImport("advapi32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  internal static partial bool GetTokenInformation(
      SafeAccessTokenHandle token,
      TokenInformationClass tokenInformationClass,
      nint tokenInformation,
      uint tokenInformationLength,
      out uint returnLength);

  [LibraryImport("kernel32.dll", SetLastError = true)]
  internal static partial SafeProcessHandle OpenProcess(
      uint desiredAccess,
      [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
      uint processId);

  [LibraryImport("advapi32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  internal static partial bool OpenProcessToken(
      SafeProcessHandle process,
      uint desiredAccess,
      out SafeAccessTokenHandle token);

  [LibraryImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  internal static partial bool ProcessIdToSessionId(
      uint processId,
      out uint sessionId);

  [LibraryImport("kernel32.dll", EntryPoint = "WaitNamedPipeW", SetLastError = true,
      StringMarshalling = StringMarshalling.Utf16)]
  [return: MarshalAs(UnmanagedType.Bool)]
  internal static partial bool WaitNamedPipe(
      string name,
      uint timeoutMilliseconds);

  [LibraryImport("kernel32.dll", SetLastError = true)]
  internal static partial uint WaitForSingleObject(
      SafeProcessHandle handle,
      uint milliseconds);

  [StructLayout(LayoutKind.Sequential)]
  internal struct SecurityAttributes
  {
    internal uint Length;
    internal nint SecurityDescriptor;
    internal int InheritHandle;
  }

  internal enum TokenInformationClass
  {
    TokenUser = 1,
    TokenGroups = 2,
    TokenSessionId = 12,
  }
}
