import { describe, expect, it } from 'vitest';
import { SystemAudioService } from '../system-audio-service';

function toPcmBuffer(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(samples[i], i * 2);
  }
  return buffer;
}

describe('SystemAudioService silence gate', () => {
  it('treats all-zero PCM buffer as silent', () => {
    const service = new SystemAudioService();
    const silent = toPcmBuffer([0, 0, 0, 0, 0, 0]);

    const isSilent = (service as any).isSilent(silent);
    expect(isSilent).toBe(true);
  });

  it('treats low-amplitude noise below threshold as silent', () => {
    const service = new SystemAudioService();
    const lowNoise = toPcmBuffer([80, -80, 60, -60, 40, -40, 20, -20]);

    const isSilent = (service as any).isSilent(lowNoise);
    expect(isSilent).toBe(true);
  });

  it('passes through speech-like amplitude above threshold', () => {
    const service = new SystemAudioService();
    const speechLike = toPcmBuffer([260, -240, 320, -300, 280, -260]);

    const isSilent = (service as any).isSilent(speechLike);
    expect(isSilent).toBe(false);
  });

  it('treats exact RMS threshold as non-silent (boundary)', () => {
    const service = new SystemAudioService();
    const boundary = toPcmBuffer([100, -100, 100, -100]);

    const isSilent = (service as any).isSilent(boundary);
    expect(isSilent).toBe(false);
  });
});
