/**
 * Mix two little-endian Int16 PCM mono buffers.
 * Buffers can be different lengths; missing samples are treated as silence.
 */
export function mixPcmBuffers(
  mic: Buffer | null | undefined,
  system: Buffer | null | undefined,
  micGain: number = 1,
  systemGain: number = 1,
): Buffer {
  const micBuffer = mic && mic.length > 0 ? mic : Buffer.alloc(0);
  const systemBuffer = system && system.length > 0 ? system : Buffer.alloc(0);

  const micSamples = Math.floor(micBuffer.length / 2);
  const systemSamples = Math.floor(systemBuffer.length / 2);
  const totalSamples = Math.max(micSamples, systemSamples);

  if (totalSamples === 0) {
    return Buffer.alloc(0);
  }

  const output = Buffer.alloc(totalSamples * 2);

  for (let i = 0; i < totalSamples; i += 1) {
    const micSample = i < micSamples ? micBuffer.readInt16LE(i * 2) * micGain : 0;
    const systemSample = i < systemSamples ? systemBuffer.readInt16LE(i * 2) * systemGain : 0;
    const mixed = Math.round(micSample + systemSample);

    // Clamp to Int16 range.
    const clamped = Math.max(-32768, Math.min(32767, mixed));
    output.writeInt16LE(clamped, i * 2);
  }

  return output;
}
