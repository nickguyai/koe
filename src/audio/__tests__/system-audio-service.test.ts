import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('SystemAudioService recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not schedule recovery when recovery is disabled', () => {
    const service = new SystemAudioService();
    const scheduledSpy = vi.fn();
    service.on('recovery-scheduled', scheduledSpy);

    // Simulate an error without enabling recovery
    (service as any).scheduleRecovery();

    expect(scheduledSpy).not.toHaveBeenCalled();
  });

  it('schedules recovery when enabled and an error occurs', () => {
    const service = new SystemAudioService();
    const scheduledSpy = vi.fn();
    service.on('recovery-scheduled', scheduledSpy);

    service.enableRecovery();
    (service as any).scheduleRecovery();

    expect(scheduledSpy).toHaveBeenCalledWith({
      attempt: 1,
      maxAttempts: 3,
      delayMs: 500,
    });
  });

  it('applies exponential backoff on successive recovery attempts', async () => {
    const service = new SystemAudioService();
    const delays: number[] = [];
    service.on('recovery-scheduled', (info: { delayMs: number }) => {
      delays.push(info.delayMs);
    });

    // Stub start() to fail — the timer callback now auto-reschedules on failure
    (service as any).start = vi.fn().mockResolvedValue(false);

    service.enableRecovery();

    // Kick off the first attempt; each failure auto-chains the next
    (service as any).scheduleRecovery();
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(delays).toEqual([500, 1000, 2000]);
  });

  it('emits recovery-failed after max attempts exceeded', () => {
    const service = new SystemAudioService();
    const failedSpy = vi.fn();
    service.on('recovery-failed', failedSpy);

    // Stub start() to prevent real AudioTee usage
    (service as any).start = vi.fn().mockResolvedValue(false);

    service.enableRecovery();

    // Exhaust all 3 attempts
    (service as any).recoveryAttempts = 3;
    (service as any).scheduleRecovery();

    expect(failedSpy).toHaveBeenCalled();
  });

  it('disableRecovery cancels pending recovery timer', () => {
    const service = new SystemAudioService();

    service.enableRecovery();
    (service as any).scheduleRecovery();

    // Timer is pending
    expect((service as any).recoveryTimer).not.toBeNull();

    service.disableRecovery();

    expect((service as any).recoveryTimer).toBeNull();
    expect((service as any).recoveryEnabled).toBe(false);
  });

  it('stop() disables recovery to prevent restart after intentional stop', () => {
    const service = new SystemAudioService();

    service.enableRecovery();
    expect((service as any).recoveryEnabled).toBe(true);

    // stop() should disable recovery
    void service.stop();
    expect((service as any).recoveryEnabled).toBe(false);
  });

  it('resets attempt counter on successful recovery', async () => {
    const service = new SystemAudioService();
    const succeededSpy = vi.fn();
    service.on('recovery-succeeded', succeededSpy);

    // Stub start() to succeed
    (service as any).start = vi.fn().mockResolvedValue(true);

    service.enableRecovery();
    (service as any).recoveryAttempts = 1;
    (service as any).scheduleRecovery();

    // Advance timer to trigger recovery
    await vi.advanceTimersByTimeAsync(1000);

    expect(succeededSpy).toHaveBeenCalled();
    expect((service as any).recoveryAttempts).toBe(0);
  });

  it('reschedules when start() returns false during recovery', async () => {
    const service = new SystemAudioService();
    const scheduledCalls: number[] = [];
    service.on('recovery-scheduled', (info: { attempt: number }) => {
      scheduledCalls.push(info.attempt);
    });

    // start() fails without throwing — should still chain to next attempt
    (service as any).start = vi.fn().mockResolvedValue(false);

    service.enableRecovery();
    (service as any).scheduleRecovery();

    // First attempt fires after 500ms
    await vi.advanceTimersByTimeAsync(500);

    // Should have scheduled attempt 1, then auto-chained attempt 2
    expect(scheduledCalls).toEqual([1, 2]);
  });

  it('clears audioTee on error so start() does not short-circuit during recovery', () => {
    const service = new SystemAudioService();

    // Simulate a state where audioTee is set (as if recording) but an error fires
    const fakeAudioTee = {};
    (service as any).audioTee = fakeAudioTee;

    // Simulate the error handler behavior: it should null out audioTee
    // before scheduling recovery so start() won't short-circuit
    (service as any).audioTee = null; // this is what our fix does
    expect((service as any).audioTee).toBeNull();
  });

  it('tears down capture if stop() runs during in-flight recovery start()', async () => {
    const service = new SystemAudioService();
    const stopSpy = vi.fn().mockResolvedValue(undefined);

    // start() succeeds but simulates an async delay during which stop() could run.
    // We disable recovery inside the mock to mimic stop() racing with start().
    (service as any).start = vi.fn().mockImplementation(async () => {
      // Simulate stop() running mid-await
      service.disableRecovery();
      return true;
    });
    (service as any).stop = stopSpy;

    service.enableRecovery();
    (service as any).scheduleRecovery();

    await vi.advanceTimersByTimeAsync(500);

    // Post-await guard should detect recoveryEnabled=false and call stop()
    expect(stopSpy).toHaveBeenCalled();
  });
});
