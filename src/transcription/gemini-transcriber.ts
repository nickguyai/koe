import { GoogleGenerativeAI } from '@google/generative-ai';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { ConfigManager } from '../config/config-manager';
import { getFfmpegPath } from '../audio/ffmpeg-paths';
import { buildTranscriptionPrompt, buildChunkTranscriptionPrompt, buildPolishPrompt, LIVE_TRANSCRIPTION_PROMPT } from './prompts';
import { splitAudio, cleanupChunks, AudioChunk } from '../audio/audio-chunker';

export interface SpeechSegment {
  content: string;
  start_time: string;
  end_time: string;
  speaker: string;
}

export interface MeetingNotes {
  summary: string;
  discussion_points: string[];
  action_items: string[];
  decisions: string[];
  next_steps: string[];
  _completedItems?: number[];
}

export type DiarizationStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface TranscriptionResult {
  title: string;
  speech_segments: SpeechSegment[];
  summary: string;
  is_meeting?: boolean;
  readability?: {
    text: string;
    updated_at?: string;
  };
  meeting_notes?: MeetingNotes;
  diarization_status?: DiarizationStatus;
}

interface GeminiResponsePayload {
  title?: string;
  speech_segments?: SpeechSegment[];
  summary?: string;
}

interface TranscriptionRunOptions {
  applySmartFormatting?: boolean;
}

export class GeminiTranscriber {
  private config: ConfigManager;
  private client: GoogleGenerativeAI | null = null;
  private clientKey: string | null = null;

  constructor(config: ConfigManager) {
    this.config = config;
  }

  private getClient(): GoogleGenerativeAI {
    const apiKey = this.config.getApiKey('gemini');
    if (!apiKey) {
      throw new Error('Gemini API key is not set.');
    }
    if (!this.client || this.clientKey !== apiKey) {
      this.client = new GoogleGenerativeAI(apiKey);
      this.clientKey = apiKey;
    }
    return this.client;
  }

  private async convertWebmIfNeeded(audioPath: string): Promise<{ path: string; cleanup?: () => Promise<void> }> {
    const ext = path.extname(audioPath).toLowerCase();
    if (ext !== '.webm') {
      return { path: audioPath };
    }

    const convertedPath = audioPath.replace(/\.webm$/i, '_converted.wav');

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
          // Ignore cleanup failures.
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
        return 'application/octet-stream';
    }
  }

  private extractJsonPayload(responseText: string): GeminiResponsePayload {
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
      throw new Error('No JSON object found in Gemini response.');
    }

    let jsonStr = cleaned.slice(start, end + 1);
    jsonStr = jsonStr.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
    jsonStr = jsonStr.replace(/\\u(?![0-9a-fA-F]{4})/g, '');
    jsonStr = jsonStr.replace(/\\(?!["\\/bfnrtu])/g, '');

    try {
      return JSON.parse(jsonStr) as GeminiResponsePayload;
    } catch (err) {
      const lines = jsonStr.split('\n');
      const filtered = lines.filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        if (trimmed.startsWith('{') || trimmed.startsWith('}') || trimmed.startsWith('"') || trimmed.startsWith(',')) {
          return true;
        }
        return /[{}[\]:,"]/.test(trimmed);
      });
      const retry = filtered.join('\n');
      return JSON.parse(retry) as GeminiResponsePayload;
    }
  }

  async transcribeAudio(audioPath: string, modelOverride?: string, options: TranscriptionRunOptions = {}): Promise<TranscriptionResult> {
    const applySmartFormatting = options.applySmartFormatting !== false;
    const { path: workingPath, cleanup } = await this.convertWebmIfNeeded(audioPath);
    let chunks: AudioChunk[] | null = null;
    try {
      const chunksDir = workingPath + '_chunks';
      chunks = await splitAudio(workingPath, chunksDir);

      if (chunks.length <= 1) {
        return await this.transcribeSingleAudio(workingPath, modelOverride, applySmartFormatting);
      }

      console.log(`[GeminiTranscriber] Long audio detected: ${chunks.length} chunks`);
      return await this.transcribeChunkedAudio(chunks, modelOverride, applySmartFormatting);
    } finally {
      if (chunks) {
        await cleanupChunks(chunks, workingPath);
      }
      if (cleanup) {
        await cleanup();
      }
    }
  }

  private async transcribeSingleAudio(
    audioPath: string,
    modelOverride?: string,
    applySmartFormatting: boolean = true,
  ): Promise<TranscriptionResult> {
    const client = this.getClient();
    const settings = this.config.getSettings();
    const modelName = modelOverride || settings.geminiModel || 'gemini-3-flash-preview';
    const model = client.getGenerativeModel({ model: modelName });
    const knownSpeakerNames = this.getKnownSpeakerNames(settings.speakerLabels);

    const transcriptionPrompt = buildTranscriptionPrompt({
      autoDetectSpeakers: settings.autoDetectSpeakers,
      timestamps: settings.timestamps,
      punctuation: settings.punctuation,
      language: settings.language,
      summaryLength: settings.summaryLength,
      knownSpeakerNames,
    });

    const audioBytes = await fs.promises.readFile(audioPath);
    const mimeType = this.guessMimeType(audioPath);

    const result = await model.generateContent([
      transcriptionPrompt,
      {
        inlineData: {
          data: audioBytes.toString('base64'),
          mimeType,
        },
      },
    ]);

    const responseText = result.response.text();
    const payload = this.extractJsonPayload(responseText);
    const segments = (payload.speech_segments || []).map((seg) => ({
      content: seg.content,
      start_time: seg.start_time,
      end_time: seg.end_time,
      speaker: seg.speaker,
    }));
    const formattedSegments = applySmartFormatting
      ? await this.applySmartFormattingIfEligible(segments, modelName)
      : segments;

    return {
      title: payload.title || 'Audio Transcription',
      speech_segments: formattedSegments,
      summary: payload.summary || 'No summary available',
    };
  }

  private async transcribeChunkedAudio(
    chunks: AudioChunk[],
    modelOverride?: string,
    applySmartFormatting: boolean = true,
  ): Promise<TranscriptionResult> {
    const settings = this.config.getSettings();
    const modelName = modelOverride || settings.geminiModel || 'gemini-3-flash-preview';
    const model = this.getClient().getGenerativeModel({ model: modelName });

    const promptSettings = {
      autoDetectSpeakers: settings.autoDetectSpeakers,
      timestamps: settings.timestamps,
      punctuation: settings.punctuation,
      language: settings.language,
      summaryLength: settings.summaryLength,
      knownSpeakerNames: this.getKnownSpeakerNames(settings.speakerLabels),
    };

    const allSegments: SpeechSegment[] = [];
    let allTitles: string[] = [];
    let allSummaries: string[] = [];
    let previousLastSegments = '';
    let knownSpeakers: string[] = [];

    for (const chunk of chunks) {
      console.log(`[GeminiTranscriber] Transcribing chunk ${chunk.index + 1}/${chunks.length} (offset ${chunk.startSeconds}s)`);

      const prompt = chunk.index === 0
        ? buildTranscriptionPrompt(promptSettings)
        : buildChunkTranscriptionPrompt(promptSettings, {
            chunkIndex: chunk.index,
            totalChunks: chunks.length,
            offsetSeconds: chunk.startSeconds,
            previousLastSegments,
            previousSpeakers: knownSpeakers,
          });

      const audioBytes = await fs.promises.readFile(chunk.path);
      const mimeType = this.guessMimeType(chunk.path);

      const result = await model.generateContent([
        prompt,
        {
          inlineData: {
            data: audioBytes.toString('base64'),
            mimeType,
          },
        },
      ]);

      const responseText = result.response.text();
      const payload = this.extractJsonPayload(responseText);
      const segments = (payload.speech_segments || []).map((seg) => ({
        content: seg.content,
        start_time: this.adjustTimestamp(seg.start_time, chunk.startSeconds),
        end_time: this.adjustTimestamp(seg.end_time, chunk.startSeconds),
        speaker: seg.speaker,
      }));

      // Deduplicate overlap with previous chunk
      const merged = chunk.index === 0
        ? segments
        : this.deduplicateOverlap(allSegments, segments);

      allSegments.push(...merged);

      if (payload.title) allTitles.push(payload.title);
      if (payload.summary) allSummaries.push(payload.summary);

      // Track context for next chunk
      const lastSegs = segments.slice(-3);
      previousLastSegments = lastSegs.map((s) => s.content).join(' ');
      for (const seg of segments) {
        if (seg.speaker && !knownSpeakers.includes(seg.speaker)) {
          knownSpeakers.push(seg.speaker);
        }
      }
    }

    return {
      title: allTitles[0] || 'Audio Transcription',
      speech_segments: applySmartFormatting
        ? await this.applySmartFormattingIfEligible(allSegments, modelName)
        : allSegments,
      summary: allSummaries[0] || 'No summary available',
    };
  }

  private parseTimestamp(timestamp?: string): number | null {
    if (!timestamp) return null;

    // Match plain seconds: "120.5", "120.5s"
    const plainMatch = timestamp.match(/^([\d.]+)s?$/);
    if (plainMatch) {
      const seconds = parseFloat(plainMatch[1]);
      return Number.isNaN(seconds) ? null : seconds;
    }

    // Match HH:MM:SS.mmm or MM:SS.mmm formats
    const hmsMatch = timestamp.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d+))?$/);
    if (hmsMatch) {
      const hours = hmsMatch[1] ? parseInt(hmsMatch[1], 10) : 0;
      const minutes = parseInt(hmsMatch[2], 10);
      const secs = parseInt(hmsMatch[3], 10);
      const frac = hmsMatch[4] ? parseFloat(`0.${hmsMatch[4]}`) : 0;
      return hours * 3600 + minutes * 60 + secs + frac;
    }

    return null;
  }

  private adjustTimestamp(timestamp: string, offsetSeconds: number): string {
    if (!timestamp || offsetSeconds === 0) return timestamp;

    const seconds = this.parseTimestamp(timestamp);
    if (seconds === null) return timestamp;

    return `${(seconds + offsetSeconds).toFixed(3)}s`;
  }

  private deduplicateOverlap(
    existing: SpeechSegment[],
    incoming: SpeechSegment[],
  ): SpeechSegment[] {
    if (existing.length === 0) return incoming;

    // Find the last timestamp in existing segments
    const lastExisting = existing[existing.length - 1];
    const lastEndSeconds = this.parseTimestamp(lastExisting.end_time);
    const incomingHasTimestamps = incoming.some((seg) => this.parseTimestamp(seg.start_time) !== null);

    if (lastEndSeconds !== null && incomingHasTimestamps) {
      // Skip incoming segments that fall within the overlap zone
      return incoming.filter((seg) => {
        const segStart = this.parseTimestamp(seg.start_time);
        if (segStart === null) return true;
        // Keep segments that start at or after the last existing segment ends.
        // Use a small tolerance to handle floating-point imprecision from the model.
        return segStart >= lastEndSeconds - 0.1;
      });
    }

    const normalize = (value: string) => value.trim().toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
    const maxOverlap = Math.min(10, existing.length, incoming.length);
    if (maxOverlap === 0) return incoming;

    const existingTail = existing.slice(-maxOverlap).map((seg) => normalize(seg.content));
    const incomingHead = incoming.slice(0, maxOverlap).map((seg) => normalize(seg.content));

    // Try exact match first, then fuzzy (substring containment)
    for (let size = maxOverlap; size >= 1; size -= 1) {
      const existingSlice = existingTail.slice(maxOverlap - size);
      const incomingSlice = incomingHead.slice(0, size);
      let matches = true;
      for (let i = 0; i < size; i += 1) {
        const existingValue = existingSlice[i];
        if (!existingValue || existingValue !== incomingSlice[i]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return incoming.slice(size);
      }
    }

    // Fuzzy pass: check if incoming segments are contained within existing tail
    for (let size = maxOverlap; size >= 1; size -= 1) {
      const existingSlice = existingTail.slice(maxOverlap - size);
      const incomingSlice = incomingHead.slice(0, size);
      let fuzzyMatches = true;
      for (let i = 0; i < size; i += 1) {
        const e = existingSlice[i];
        const inc = incomingSlice[i];
        if (!e || !inc) { fuzzyMatches = false; break; }
        if (!e.includes(inc) && !inc.includes(e)) {
          fuzzyMatches = false;
          break;
        }
      }
      if (fuzzyMatches) {
        return incoming.slice(size);
      }
    }

    return incoming;
  }

  async polishText(text: string, style: string, customPrompt: string): Promise<string> {
    const client = this.getClient();
    const modelName = this.config.getSettings().geminiModel || 'gemini-3-flash-preview';
    const model = client.getGenerativeModel({ model: modelName });
    const prompt = buildPolishPrompt(style, customPrompt);
    const result = await model.generateContent(`${prompt}\n\n${text}`);
    return result.response.text().trim();
  }

  private getKnownSpeakerNames(speakerLabels: Record<string, string> | undefined): string[] {
    if (!speakerLabels || typeof speakerLabels !== 'object') {
      return [];
    }
    const labels = Object.values(speakerLabels)
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    return Array.from(new Set(labels)).slice(0, 20);
  }

  private shouldApplySmartFormatting(segments: SpeechSegment[]): boolean {
    if (!Array.isArray(segments) || segments.length === 0) {
      return false;
    }
    const uniqueSpeakers = new Set(
      segments
        .map((segment) => String(segment.speaker || '').trim().toLowerCase())
        .filter(Boolean),
    );
    return uniqueSpeakers.size <= 1;
  }

  private async applySmartFormattingIfEligible(segments: SpeechSegment[], modelName: string): Promise<SpeechSegment[]> {
    if (!this.shouldApplySmartFormatting(segments)) {
      return segments;
    }

    const rawText = segments
      .map((segment) => String(segment.content || '').trim())
      .filter(Boolean)
      .join('\n')
      .trim();
    if (!rawText) {
      return segments;
    }

    try {
      const model = this.getClient().getGenerativeModel({ model: modelName });
      const result = await model.generateContent(`${LIVE_TRANSCRIPTION_PROMPT}\n\nDictation transcript:\n${rawText}`);
      const formatted = this.normalizeMarkdownOutput(result.response.text());
      if (!formatted) {
        return segments;
      }
      return [
        {
          content: formatted,
          start_time: segments[0]?.start_time || '',
          end_time: segments[segments.length - 1]?.end_time || '',
          speaker: segments[0]?.speaker || 'Speaker 1',
        },
      ];
    } catch (err) {
      console.warn('[GeminiTranscriber] Smart formatting failed, using raw transcript:', err);
      return segments;
    }
  }

  private normalizeMarkdownOutput(text: string): string {
    const raw = String(text || '').trim();
    if (!raw) {
      return '';
    }

    if (raw.startsWith('```')) {
      const withoutFence = raw.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
      return withoutFence;
    }
    return raw;
  }
}
