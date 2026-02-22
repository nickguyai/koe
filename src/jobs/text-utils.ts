import { TranscriptionResult } from './types';

export function cleanText(text: string): string {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

export function buildTitle(text: string, provided?: string): string {
  const explicit = String(provided || '').trim();
  if (explicit) {
    return explicit;
  }
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) {
    return 'Live transcription';
  }
  const words = oneLine.split(' ').slice(0, 6).join(' ');
  return words || 'Live transcription';
}

export function buildSummary(text: string, provided?: string): string {
  const explicit = String(provided || '').trim();
  if (explicit) {
    return explicit;
  }
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) {
    return 'No summary available';
  }
  if (oneLine.length <= 200) {
    return oneLine;
  }
  return `${oneLine.slice(0, 197)}...`;
}

export function buildSegments(text: string): TranscriptionResult['speech_segments'] {
  const cleaned = cleanText(text);
  if (!cleaned) {
    return [];
  }
  const lines = cleaned
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const chunks = lines.length > 0 ? lines : [cleaned];
  return chunks.map((line) => ({
    content: line,
    start_time: '',
    end_time: '',
    speaker: 'Speaker 1',
  }));
}

export interface MarkdownExportInput {
  title: string;
  summary?: string;
  transcript?: string;
  createdAt?: string;
}

export function formatTranscriptionMarkdownExport(input: MarkdownExportInput): string {
  const title = String(input.title || '').trim() || 'Untitled Transcription';
  const summary = String(input.summary || '').trim();
  const transcript = String(input.transcript || '').trim();
  const createdAt = String(input.createdAt || '').trim();

  const lines: string[] = [`# ${title}`, ''];

  if (createdAt) {
    lines.push(`_Recorded: ${createdAt}_`, '');
  }

  if (summary) {
    lines.push('## Summary', '', summary, '');
  }

  if (transcript) {
    lines.push('## Transcript', '', transcript, '');
  }

  return lines.join('\n').trim() + '\n';
}
