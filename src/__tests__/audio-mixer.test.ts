import { describe, expect, it } from 'vitest';
import { mixPcmBuffers } from '../audio-mixer';

function toPcmBuffer(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(samples[i], i * 2);
  }
  return buffer;
}

function fromPcmBuffer(buffer: Buffer): number[] {
  const samples: number[] = [];
  for (let i = 0; i < Math.floor(buffer.length / 2); i += 1) {
    samples.push(buffer.readInt16LE(i * 2));
  }
  return samples;
}

describe('mixPcmBuffers', () => {
  it('mixes same-length PCM streams sample-by-sample', () => {
    const mic = toPcmBuffer([1000, -1000, 2500]);
    const system = toPcmBuffer([1000, 500, -500]);

    const mixed = mixPcmBuffers(mic, system);

    expect(fromPcmBuffer(mixed)).toEqual([2000, -500, 2000]);
  });

  it('zero-pads shorter input', () => {
    const mic = toPcmBuffer([300, 400, 500, 600]);
    const system = toPcmBuffer([100]);

    const mixed = mixPcmBuffers(mic, system);

    expect(fromPcmBuffer(mixed)).toEqual([400, 400, 500, 600]);
  });

  it('applies gains before mixing', () => {
    const mic = toPcmBuffer([1000, 1000]);
    const system = toPcmBuffer([1000, 1000]);

    const mixed = mixPcmBuffers(mic, system, 0.5, 0.25);

    expect(fromPcmBuffer(mixed)).toEqual([750, 750]);
  });

  it('clamps mixed output into int16 range', () => {
    const mic = toPcmBuffer([32767, -32768]);
    const system = toPcmBuffer([32767, -32768]);

    const mixed = mixPcmBuffers(mic, system);

    expect(fromPcmBuffer(mixed)).toEqual([32767, -32768]);
  });

  it('returns empty buffer when both inputs are empty', () => {
    expect(mixPcmBuffers(Buffer.alloc(0), Buffer.alloc(0)).length).toBe(0);
  });
});
