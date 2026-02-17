import { EventEmitter } from 'events';
import type { AudioTee as AudioTeeType } from 'audiotee';
import * as fs from 'fs';
import * as path from 'path';

const SILENCE_RMS_THRESHOLD = 100;

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

  get currentStatus(): SystemAudioStatus {
    return this.status;
  }

  get latestChunk(): Buffer | null {
    return this.lastChunk;
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
        this.setStatus('error');
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
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
