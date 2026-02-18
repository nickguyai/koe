import { EventEmitter } from 'events';
import type { AudioTee as AudioTeeType } from 'audiotee';
import * as fs from 'fs';
import * as path from 'path';

const SILENCE_RMS_THRESHOLD = 100;
const MAX_RECOVERY_ATTEMPTS = 3;
const INITIAL_RECOVERY_DELAY_MS = 500;

export type SystemAudioStatus = 'idle' | 'recording' | 'unsupported' | 'error';

export interface SystemAudioStartOptions {
  sampleRate?: number;
  includeProcessNames?: string[];
}

export interface MeetingAppDetectedEvent {
  appName: string;
  processName: string;
  detectedAt: string;
  source: 'stderr' | 'audio';
}

/**
 * Wraps the audiotee npm package and emits PCM16 chunks as 'audio-data' events.
 * The service is a no-op when the platform/runtime does not support system audio capture.
 */
export class SystemAudioService extends EventEmitter {
  private audioTee: AudioTeeType | null = null;
  private status: SystemAudioStatus = 'idle';
  private lastChunk: Buffer | null = null;
  private includeProcessNames: string[] = [];
  private emittedMeetingApps: Set<string> = new Set();
  private lastActiveProcessName: string | null = null;
  private recoveryEnabled = false;
  private recoveryAttempts = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStartOptions: SystemAudioStartOptions = {};

  get currentStatus(): SystemAudioStatus {
    return this.status;
  }

  get latestChunk(): Buffer | null {
    return this.lastChunk;
  }

  /** Enable auto-recovery so the service restarts on unexpected stop/error. */
  enableRecovery(): void {
    this.recoveryEnabled = true;
    this.recoveryAttempts = 0;
  }

  /** Disable auto-recovery (called on intentional stop). */
  disableRecovery(): void {
    this.recoveryEnabled = false;
    this.recoveryAttempts = 0;
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  async start(options: SystemAudioStartOptions = {}): Promise<boolean> {
    if (this.audioTee) {
      return true;
    }

    if (process.platform !== 'darwin') {
      this.setStatus('unsupported');
      return false;
    }

    // Resolve binary path for packaged Electron apps where the binary
    // lives in resources/bin/ rather than the default node_modules location.
    const binaryPath = this.resolveBinaryPath();

    this.lastStartOptions = options;
    this.includeProcessNames = (options.includeProcessNames || [])
      .map((name) => String(name || '').trim())
      .filter(Boolean);
    this.emittedMeetingApps.clear();
    this.lastActiveProcessName = null;

    try {
      const { AudioTee } = await import('audiotee');
      const audioTee = new AudioTee({
        sampleRate: options.sampleRate ?? 24000,
        ...(binaryPath ? { binaryPath } : {}),
      });

      audioTee.on('data', (chunk) => {
        const pcm = Buffer.from(chunk.data);
        if (pcm.length === 0) {
          return;
        }

        // Gate near-silent system audio to prevent transcription hallucinations.
        const gated = this.isSilent(pcm) ? Buffer.alloc(pcm.length) : pcm;
        this.lastChunk = gated;
        this.emit('audio-data', gated);
        this.emitMeetingDetectionFromAudio();
      });

      audioTee.on('error', (err) => {
        // Clear the failed instance so start() won't short-circuit during recovery.
        if (this.audioTee === audioTee) {
          this.audioTee = null;
        }
        this.setStatus('error');
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
        this.scheduleRecovery();
      });

      audioTee.on('log', (_level, message) => {
        const text = message.message || '';
        if (text) {
          this.emitMeetingDetectionFromLog(text);
        }
      });

      audioTee.on('stop', () => {
        if (this.audioTee === audioTee) {
          this.audioTee = null;
          this.lastChunk = null;
          this.includeProcessNames = [];
          this.emittedMeetingApps.clear();
          this.lastActiveProcessName = null;
          if (this.status !== 'idle') {
            this.setStatus('idle');
          }
          this.scheduleRecovery();
        }
      });

      await audioTee.start();
      this.audioTee = audioTee;
      this.setStatus('recording');
      return true;
    } catch (err) {
      this.audioTee = null;
      this.setStatus('error');
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  async stop(): Promise<void> {
    this.disableRecovery();
    const audioTee = this.audioTee;
    this.lastChunk = null;
    this.includeProcessNames = [];
    this.emittedMeetingApps.clear();
    this.lastActiveProcessName = null;

    if (!audioTee) {
      this.setStatus('idle');
      return;
    }

    this.audioTee = null;
    await audioTee.stop();
    this.setStatus('idle');
  }

  private setStatus(next: SystemAudioStatus): void {
    if (this.status === next) {
      return;
    }
    this.status = next;
    this.emit('status', next);
  }

  private scheduleRecovery(): void {
    if (!this.recoveryEnabled) {
      return;
    }
    if (this.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      console.warn(`[SystemAudio] Recovery exhausted after ${MAX_RECOVERY_ATTEMPTS} attempts`);
      this.emit('recovery-failed');
      this.disableRecovery();
      return;
    }

    const delay = INITIAL_RECOVERY_DELAY_MS * Math.pow(2, this.recoveryAttempts);
    this.recoveryAttempts += 1;
    console.log(`[SystemAudio] Scheduling recovery attempt ${this.recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS} in ${delay}ms`);
    this.emit('recovery-scheduled', { attempt: this.recoveryAttempts, maxAttempts: MAX_RECOVERY_ATTEMPTS, delayMs: delay });

    this.recoveryTimer = setTimeout(async () => {
      this.recoveryTimer = null;
      if (!this.recoveryEnabled) {
        return;
      }
      console.log(`[SystemAudio] Attempting recovery ${this.recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS}`);
      const ok = await this.start(this.lastStartOptions);
      // Re-check after await: stop() may have run during start(), disabling
      // recovery. If so, tear down the just-started capture to avoid
      // resurrecting system audio after an intentional stop.
      if (!this.recoveryEnabled) {
        if (ok) {
          await this.stop();
        }
        return;
      }
      if (ok) {
        console.log('[SystemAudio] Recovery successful');
        this.recoveryAttempts = 0;
        this.emit('recovery-succeeded');
      } else {
        // start() returned false without throwing (e.g. permission denied).
        // The audioTee error handler won't fire, so reschedule explicitly.
        this.scheduleRecovery();
      }
    }, delay);
  }

  private isSilent(pcm: Buffer): boolean {
    const sampleCount = Math.floor(pcm.length / 2);
    if (sampleCount === 0) {
      return true;
    }

    let sumOfSquares = 0;
    for (let i = 0; i < sampleCount; i += 1) {
      const sample = pcm.readInt16LE(i * 2);
      sumOfSquares += sample * sample;
    }

    return Math.sqrt(sumOfSquares / sampleCount) < SILENCE_RMS_THRESHOLD;
  }

  /**
   * In packaged Electron apps the binary is copied to resources/bin/.
   * In development, the AudioTee class finds it at its default location
   * (node_modules/audiotee/bin/audiotee) so we return null.
   */
  private resolveBinaryPath(): string | null {
    if (process.resourcesPath) {
      const candidate = path.join(process.resourcesPath, 'bin', 'audiotee');
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private emitMeetingDetectionFromAudio(): void {
    if (this.includeProcessNames.length === 0) {
      return;
    }

    const processName =
      this.lastActiveProcessName ||
      (this.includeProcessNames.length === 1 ? this.includeProcessNames[0] : null);
    if (!processName) {
      this.emitMeetingAppDetected('meeting app', 'audio');
      return;
    }
    this.emitMeetingAppDetected(processName, 'audio');
  }

  private emitMeetingDetectionFromLog(message: string): void {
    if (this.includeProcessNames.length === 0) {
      return;
    }

    const lowerMessage = String(message || '').toLowerCase();
    if (!lowerMessage) {
      return;
    }

    const processName = this.includeProcessNames.find((name) =>
      lowerMessage.includes(this.normalizeProcessName(name)),
    );

    if (!processName) {
      return;
    }

    const hasActivitySignal =
      lowerMessage.includes('audio') ||
      lowerMessage.includes('stream') ||
      lowerMessage.includes('capture') ||
      lowerMessage.includes('detected') ||
      lowerMessage.includes('active') ||
      lowerMessage.includes('start');

    if (!hasActivitySignal) {
      return;
    }

    this.lastActiveProcessName = processName;
    this.emitMeetingAppDetected(processName, 'stderr');
  }

  private emitMeetingAppDetected(processName: string, source: 'stderr' | 'audio'): void {
    const appName = this.resolveMeetingAppName(processName);
    const appKey = appName.toLowerCase();
    if (this.emittedMeetingApps.has(appKey)) {
      return;
    }

    this.emittedMeetingApps.add(appKey);
    this.emit('meeting-app-detected', {
      appName,
      processName,
      detectedAt: new Date().toISOString(),
      source,
    } as MeetingAppDetectedEvent);
  }

  private normalizeProcessName(name: string): string {
    return String(name || '')
      .toLowerCase()
      .replace(/\.app$/g, '')
      .replace(/\s+/g, '');
  }

  private resolveMeetingAppName(processName: string): string {
    const normalized = this.normalizeProcessName(processName);
    if (normalized.includes('zoom')) {
      return 'Zoom';
    }
    if (normalized.includes('googlechrome') || normalized.includes('meet') || normalized.includes('googlemeet')) {
      return 'Google Meet';
    }
    if (normalized.includes('teams')) {
      return 'Microsoft Teams';
    }
    return processName;
  }
}

let systemAudioServiceInstance: SystemAudioService | null = null;

export function getSystemAudioService(): SystemAudioService {
  if (!systemAudioServiceInstance) {
    systemAudioServiceInstance = new SystemAudioService();
  }
  return systemAudioServiceInstance;
}
