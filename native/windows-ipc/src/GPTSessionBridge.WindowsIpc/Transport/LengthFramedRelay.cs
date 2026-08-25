using System.Buffers;
using System.Buffers.Binary;

namespace GPTSessionBridge.WindowsIpc.Transport;

internal static class LengthFramedRelay
{
  internal static async Task RunDuplexAsync(
      Stream standardInput,
      Stream standardOutput,
      Stream pipe)
  {
    ArgumentNullException.ThrowIfNull(standardInput);
    ArgumentNullException.ThrowIfNull(standardOutput);
    ArgumentNullException.ThrowIfNull(pipe);

    using CancellationTokenSource shutdown = new();
    Task toPipe = CopyFramesAsync(standardInput, pipe, shutdown.Token);
    Task fromPipe = CopyFramesAsync(pipe, standardOutput, shutdown.Token);
    Task completed = await Task.WhenAny(toPipe, fromPipe).ConfigureAwait(false);

    Exception? completedFailure = await ObserveAsync(completed).ConfigureAwait(false);
    bool toPipeCompletedBeforeShutdown = toPipe.IsCompleted;
    bool fromPipeCompletedBeforeShutdown = fromPipe.IsCompleted;

    shutdown.Cancel();
    pipe.Dispose();
    standardInput.Dispose();
    Exception? toPipeFailure = await ObserveAsync(toPipe).ConfigureAwait(false);
    Exception? fromPipeFailure = await ObserveAsync(fromPipe).ConfigureAwait(false);
    Exception? failure = SelectFailure(
        completedFailure,
        toPipeFailure,
        fromPipeFailure,
        toPipeCompletedBeforeShutdown,
        fromPipeCompletedBeforeShutdown);

    if (failure is IpcException ipcError)
    {
      throw ipcError;
    }
    if (failure is not null && failure is not OperationCanceledException)
    {
      throw new IpcException("relay_failed", failure);
    }
  }

  internal static async Task CopyFramesAsync(
      Stream source,
      Stream destination,
      CancellationToken cancellationToken = default)
  {
    ArgumentNullException.ThrowIfNull(source);
    ArgumentNullException.ThrowIfNull(destination);

    byte[] header = new byte[PipeProtocolConstants.HeaderBytes];
    while (await ReadHeaderAsync(source, header, cancellationToken).ConfigureAwait(false))
    {
      uint payloadLength = BinaryPrimitives.ReadUInt32LittleEndian(header);
      if (payloadLength == 0 || payloadLength > PipeProtocolConstants.MaxFrameBytes)
      {
        throw new IpcException("invalid_frame_length");
      }

      byte[] payload = ArrayPool<byte>.Shared.Rent(checked((int)payloadLength));
      try
      {
        await ReadExactlyAsync(
                source,
                payload.AsMemory(0, checked((int)payloadLength)),
                cancellationToken)
            .ConfigureAwait(false);
        await destination.WriteAsync(header, cancellationToken).ConfigureAwait(false);
        await destination.WriteAsync(
                payload.AsMemory(0, checked((int)payloadLength)),
                cancellationToken)
            .ConfigureAwait(false);
        await destination.FlushAsync(cancellationToken).ConfigureAwait(false);
      }
      finally
      {
        ArrayPool<byte>.Shared.Return(payload, clearArray: true);
      }
    }
  }

  private static async Task<bool> ReadHeaderAsync(
      Stream source,
      byte[] header,
      CancellationToken cancellationToken)
  {
    int firstRead = await source.ReadAsync(header.AsMemory(), cancellationToken).ConfigureAwait(false);
    if (firstRead == 0)
    {
      return false;
    }

    if (firstRead < header.Length)
    {
      await ReadExactlyAsync(
              source,
              header.AsMemory(firstRead, header.Length - firstRead),
              cancellationToken)
          .ConfigureAwait(false);
    }

    return true;
  }

  private static async Task ReadExactlyAsync(
      Stream source,
      Memory<byte> destination,
      CancellationToken cancellationToken)
  {
    int offset = 0;
    while (offset < destination.Length)
    {
      int read = await source.ReadAsync(destination[offset..], cancellationToken).ConfigureAwait(false);
      if (read == 0)
      {
        throw new IpcException("truncated_frame");
      }

      offset += read;
    }
  }

  private static async Task<Exception?> ObserveAsync(Task task)
  {
    try
    {
      await task.ConfigureAwait(false);
      return null;
    }
    catch (Exception error)
    {
      return error;
    }
  }

  private static Exception? SelectFailure(
      Exception? completedFailure,
      Exception? toPipeFailure,
      Exception? fromPipeFailure,
      bool toPipeCompletedBeforeShutdown,
      bool fromPipeCompletedBeforeShutdown)
  {
    if (completedFailure is IpcException)
    {
      return completedFailure;
    }
    if (toPipeFailure is IpcException)
    {
      return toPipeFailure;
    }
    if (fromPipeFailure is IpcException)
    {
      return fromPipeFailure;
    }
    if (completedFailure is not null and not OperationCanceledException)
    {
      return completedFailure;
    }
    if (toPipeCompletedBeforeShutdown && toPipeFailure is not null and not OperationCanceledException)
    {
      return toPipeFailure;
    }
    if (fromPipeCompletedBeforeShutdown && fromPipeFailure is not null and not OperationCanceledException)
    {
      return fromPipeFailure;
    }

    return null;
  }
}
