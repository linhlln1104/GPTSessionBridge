using System.Buffers.Binary;
using GPTSessionBridge.WindowsIpc.Transport;

namespace GPTSessionBridge.WindowsIpc.Tests;

public sealed class LengthFramedRelayTests
{
  [Fact]
  public async Task RelaysCompleteFramesWithoutChangingBytes()
  {
    byte[] first = CreateFrame([1, 2, 3]);
    byte[] second = CreateFrame([4, 5]);
    byte[] input = [.. first, .. second];
    await using ChunkedReadStream source = new(input, maxChunkBytes: 2);
    await using MemoryStream destination = new();

    await LengthFramedRelay.CopyFramesAsync(source, destination);

    Assert.Equal(input, destination.ToArray());
  }

  [Fact]
  public async Task AcceptsCleanEndOfStreamBetweenFrames()
  {
    await using MemoryStream source = new();
    await using MemoryStream destination = new();

    await LengthFramedRelay.CopyFramesAsync(source, destination);

    Assert.Empty(destination.ToArray());
  }

  [Theory]
  [InlineData(0u)]
  [InlineData(1_048_577u)]
  public async Task RejectsInvalidFrameLengths(uint length)
  {
    byte[] header = new byte[4];
    BinaryPrimitives.WriteUInt32LittleEndian(header, length);
    await using MemoryStream source = new(header);
    await using MemoryStream destination = new();

    IpcException error = await Assert.ThrowsAsync<IpcException>(
        () => LengthFramedRelay.CopyFramesAsync(source, destination));

    Assert.Equal("invalid_frame_length", error.Code);
    Assert.Empty(destination.ToArray());
  }

  [Fact]
  public async Task RejectsTruncatedHeadersAndPayloads()
  {
    byte[] completeFrame = CreateFrame([1, 2, 3, 4]);
    byte[][] malformedInputs =
    [
        completeFrame[..2],
            completeFrame[..^1],
        ];

    foreach (byte[] malformed in malformedInputs)
    {
      await using MemoryStream source = new(malformed);
      await using MemoryStream destination = new();
      IpcException error = await Assert.ThrowsAsync<IpcException>(
          () => LengthFramedRelay.CopyFramesAsync(source, destination));
      Assert.Equal("truncated_frame", error.Code);
      Assert.Empty(destination.ToArray());
    }
  }

  [Fact]
  public async Task DuplexRelayDoesNotHideMalformedInputBehindConcurrentEndOfInput()
  {
    await using MemoryStream standardInput = new();
    await using MemoryStream standardOutput = new();
    await using MemoryStream malformedPipe = new(new byte[4]);

    IpcException error = await Assert.ThrowsAsync<IpcException>(
        () => LengthFramedRelay.RunDuplexAsync(standardInput, standardOutput, malformedPipe));

    Assert.Equal("invalid_frame_length", error.Code);
    Assert.Empty(standardOutput.ToArray());
  }

  [Fact]
  public async Task DuplexRelayDoesNotHideTruncatedInputBehindConcurrentEndOfInput()
  {
    await using MemoryStream standardInput = new();
    await using MemoryStream standardOutput = new();
    await using MemoryStream truncatedPipe = new([1, 0]);

    IpcException error = await Assert.ThrowsAsync<IpcException>(
        () => LengthFramedRelay.RunDuplexAsync(standardInput, standardOutput, truncatedPipe));

    Assert.Equal("truncated_frame", error.Code);
    Assert.Empty(standardOutput.ToArray());
  }

  private static byte[] CreateFrame(byte[] payload)
  {
    byte[] frame = new byte[4 + payload.Length];
    BinaryPrimitives.WriteUInt32LittleEndian(frame, unchecked((uint)payload.Length));
    payload.CopyTo(frame, 4);
    return frame;
  }

  private sealed class ChunkedReadStream : MemoryStream
  {
    private readonly int _maxChunkBytes;

    internal ChunkedReadStream(byte[] buffer, int maxChunkBytes)
        : base(buffer, writable: false)
    {
      _maxChunkBytes = maxChunkBytes;
    }

    public override ValueTask<int> ReadAsync(
        Memory<byte> buffer,
        CancellationToken cancellationToken = default)
    {
      return base.ReadAsync(buffer[..Math.Min(buffer.Length, _maxChunkBytes)], cancellationToken);
    }
  }
}
