import * as fs from 'fs';
import { spawn } from 'child_process';
import { ConfigManager } from '../config/config-manager';
import { getFfmpegPath } from '../audio/ffmpeg-paths';
import { OpenAIRealtimeClient } from '../realtime/openai-realtime';
import { ConsensusVariant, VariantResult } from './prompts';

// 1 second of PCM16 at 24kHz mono = 48 000 bytes — keeps WebSocket messages small.
const AUDIO_CHUNK_BYTES = 48000;

export class OpenAITranscriber {
  private config: ConfigManager;

  constructor(config: ConfigManager) {
    this.config = config;
  }

  private async convertToPcm16(audioPath: string, variant: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const pcmPath = audioPath.replace(/\.[^.]+$/, `_realtime_${variant}.pcm`);

    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(
        getFfmpegPath(),
        ['-y', '-i', audioPath, '-ar', '24000', '-ac', '1', '-f', 's16le', pcmPath],
        { stdio: 'ignore' },
      );
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0 && fs.existsSync(pcmPath)));
    });

    if (!ok) {
      throw new Error(`Failed to convert audio to PCM16 for Realtime transcription: ${audioPath}`);
    }

    return {
      path: pcmPath,
      cleanup: async () => {
        try {
          await fs.promises.unlink(pcmPath);
        } catch {
          // ignore cleanup failures
        }
      },
    };
  }

  async transcribeAudio(audioPath: string, variant: ConsensusVariant, _memoryTerms?: string[]): Promise<VariantResult> {
    const apiKey = this.config.getApiKey('openai');
    if (!apiKey) {
      throw new Error('OpenAI API key is not set.');
    }

    const settings = this.config.getSettings();
    const lang = settings.language && settings.language !== 'auto' ? settings.language : undefined;

    const { path: pcmPath, cleanup } = await this.convertToPcm16(audioPath, variant);
    try {
      const client = new OpenAIRealtimeClient(apiKey, undefined, undefined, undefined, lang);
      const segments: Array<{ content: string }> = [];

      // Register error listener synchronously before startMeeting() so that
      // websocket failures, invalid API keys, and quota/rate errors are caught
      // here rather than crashing the process with ERR_UNHANDLED_ERROR.
      await new Promise<void>((resolve, reject) => {
        client.on('error', (message: string) => reject(new Error(message)));
        client.on('segment', (event: { segment: string }) => {
          segments.push({ content: event.segment });
        });

        (async () => {
          await client.startMeeting();
          const pcmBuffer = await fs.promises.readFile(pcmPath);
          for (let offset = 0; offset < pcmBuffer.length; offset += AUDIO_CHUNK_BYTES) {
            await client.sendAudio(pcmBuffer.slice(offset, offset + AUDIO_CHUNK_BYTES));
          }
          await client.stopMeeting();
        })().then(resolve, reject);
      });

      return {
        variant,
        title: 'Transcription',
        segments,
        summary: '',
      };
    } finally {
      await cleanup();
    }
  }
}
