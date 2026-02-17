import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { ConfigManager } from '../config/config-manager';
import { getFfmpegPath } from '../audio/ffmpeg-paths';
import { buildConsensusVariantPrompt, ConsensusVariant, VariantResult } from './prompts';

export class OpenAITranscriber {
  private config: ConfigManager;
  private client: OpenAI | null = null;
  private clientKey: string | null = null;

  constructor(config: ConfigManager) {
    this.config = config;
  }

  private getClient(): OpenAI {
    const apiKey = this.config.getApiKey('openai');
    if (!apiKey) {
      throw new Error('OpenAI API key is not set.');
    }
    if (!this.client || this.clientKey !== apiKey) {
      this.client = new OpenAI({ apiKey });
      this.clientKey = apiKey;
    }
    return this.client;
  }

  private async convertToWavIfNeeded(audioPath: string): Promise<{ path: string; cleanup?: () => Promise<void> }> {
    const ext = path.extname(audioPath).toLowerCase();
    // GPT-4o audio supports wav, mp3, flac, m4a, mp4, mpeg, mpga, oga, ogg, webm
    const supportedFormats = ['.wav', '.mp3', '.flac', '.m4a', '.mp4', '.mpeg', '.mpga', '.oga', '.ogg', '.webm'];
    if (supportedFormats.includes(ext)) {
      return { path: audioPath };
    }

    const convertedPath = audioPath.replace(new RegExp(`\\${ext}$`, 'i'), '_converted.wav');

    const conversionOk = await new Promise<boolean>((resolve) => {
      const child = spawn(getFfmpegPath(), ['-y', '-i', audioPath, '-ar', '16000', '-ac', '1', convertedPath], {
        stdio: 'ignore',
      });

      child.on('error', (err) => {
        console.warn('ffmpeg not available or failed to start:', err);
        resolve(false);
      });

      child.on('close', (code) => {
        resolve(code === 0 && fs.existsSync(convertedPath));
      });
    });

    if (!conversionOk) {
      return { path: audioPath };
    }

    return {
      path: convertedPath,
      cleanup: async () => {
        try {
          await fs.promises.unlink(convertedPath);
        } catch {
          // Ignore cleanup failures
        }
      },
    };
  }

  private guessMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case '.m4a':
        return 'audio/mp4';
      case '.mp3':
        return 'audio/mpeg';
      case '.wav':
        return 'audio/wav';
      case '.ogg':
        return 'audio/ogg';
      case '.flac':
        return 'audio/flac';
      case '.webm':
        return 'audio/webm';
      default:
        return 'audio/wav';
    }
  }

  private extractJsonPayload(responseText: string): VariantResult {
    let cleaned = responseText.trim();
    if (cleaned.startsWith('```')) {
      const lines = cleaned.split('\n');
      if (lines[0].startsWith('```')) {
        lines.shift();
      }
      if (lines.length && lines[lines.length - 1].trim().startsWith('```')) {
        lines.pop();
      }
      cleaned = lines.join('\n').trim();
    }

    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('No JSON object found in OpenAI response.');
    }

    let jsonStr = cleaned.slice(start, end + 1);
    jsonStr = jsonStr.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
    jsonStr = jsonStr.replace(/\\u(?![0-9a-fA-F]{4})/g, '');
    jsonStr = jsonStr.replace(/\\(?!["\\/bfnrtu])/g, '');

    try {
      const parsed = JSON.parse(jsonStr);
      return {
        variant: 'base',
        title: parsed.title || 'Transcription',
        segments: parsed.segments || [],
        summary: parsed.summary || '',
      };
    } catch (err) {
      throw new Error(`Failed to parse OpenAI response JSON: ${err}`);
    }
  }

  async transcribeAudio(audioPath: string, variant: ConsensusVariant, memoryTerms?: string[]): Promise<VariantResult> {
    const client = this.getClient();
    const settings = this.config.getSettings();

    const prompt = buildConsensusVariantPrompt(
      variant,
      {
        autoDetectSpeakers: settings.autoDetectSpeakers,
        timestamps: settings.timestamps,
        punctuation: settings.punctuation,
        language: settings.language,
        summaryLength: settings.summaryLength,
      },
      memoryTerms,
    );

    const { path: workingPath, cleanup } = await this.convertToWavIfNeeded(audioPath);
    try {
      const audioBytes = await fs.promises.readFile(workingPath);
      const base64Audio = audioBytes.toString('base64');
      const mimeType = this.guessMimeType(workingPath);

      const response = await client.chat.completions.create({
        model: 'gpt-4o-audio-preview',
        modalities: ['text'],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'input_audio',
                input_audio: {
                  data: base64Audio,
                  format: mimeType === 'audio/wav' ? 'wav' : 'mp3',
                },
              },
            ],
          },
        ],
        temperature: 0.3,
        max_tokens: 4096,
      });

      const responseText = response.choices[0]?.message?.content || '';
      const result = this.extractJsonPayload(responseText);
      result.variant = variant;
      return result;
    } finally {
      if (cleanup) {
        await cleanup();
      }
    }
  }
}
