import OpenAI from 'openai';
import { ConfigManager } from '../config/config-manager';
import { buildSynthesisPrompt, VariantResult } from './prompts';
import { TranscriptionResult, SpeechSegment } from './gemini-transcriber';

export interface ConsensusMetadata {
  agreement_rate: number;
  corrections_made: number;
}

export interface ConsensusTranscriptionResult extends TranscriptionResult {
  consensus_metadata?: ConsensusMetadata;
}

export class SynthesisProcessor {
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

  private extractJsonPayload(responseText: string): ConsensusTranscriptionResult {
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
      throw new Error('No JSON object found in synthesis response.');
    }

    let jsonStr = cleaned.slice(start, end + 1);
    jsonStr = jsonStr.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

    try {
      const parsed = JSON.parse(jsonStr);
      const segments: SpeechSegment[] = (parsed.speech_segments || []).map(
        (seg: { content?: string; start_time?: string; end_time?: string; speaker?: string }) => ({
          content: seg.content || '',
          start_time: seg.start_time || '',
          end_time: seg.end_time || '',
          speaker: seg.speaker || '',
        }),
      );

      return {
        title: parsed.title || 'Consensus Transcription',
        speech_segments: segments,
        summary: parsed.summary || '',
        consensus_metadata: parsed.consensus_metadata || undefined,
      };
    } catch (err) {
      throw new Error(`Failed to parse synthesis response JSON: ${err}`);
    }
  }

  async synthesize(variants: VariantResult[], memoryTerms: string[]): Promise<ConsensusTranscriptionResult> {
    const client = this.getClient();
    const systemPrompt = buildSynthesisPrompt(memoryTerms);

    // Format variants for the synthesis prompt
    const variantsText = variants
      .map((v) => {
        const segmentsText = v.segments
          .map((s) => {
            let line = s.content;
            if (s.speaker) line = `[${s.speaker}] ${line}`;
            if (s.start_time) line = `(${s.start_time}) ${line}`;
            return line;
          })
          .join('\n');

        return `### ${v.variant.toUpperCase()} VARIANT
Title: ${v.title}
Summary: ${v.summary}
Segments:
${segmentsText}`;
      })
      .join('\n\n');

    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: variantsText },
      ],
      temperature: 0.2,
      max_tokens: 4096,
    });

    const responseText = response.choices[0]?.message?.content || '';
    return this.extractJsonPayload(responseText);
  }
}
