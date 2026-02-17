import { ConfigManager } from '../backend/config-manager';
import { LlmProcessor } from '../backend/llm-processor';
import { MeetingNotes } from '../backend/gemini-transcriber';
import { MEETING_NOTES_PROMPT } from '../backend/prompts';

export const DEFAULT_MEETING_NOTES_MODEL = 'gpt-5.2-2025-12-11';

export interface MeetingMarkdownExportInput {
  title: string;
  summary?: string;
  transcript?: string;
  meetingNotes?: MeetingNotes | null;
  createdAt?: string;
}

export function formatMeetingMarkdownExport(input: MeetingMarkdownExportInput): string {
  const title = String(input.title || '').trim() || 'Untitled Meeting';
  const summary = String(input.summary || '').trim();
  const transcript = String(input.transcript || '').trim();
  const notes = input.meetingNotes || null;
  const createdAt = String(input.createdAt || '').trim();

  const lines: string[] = [`# ${title}`, ''];

  if (createdAt) {
    lines.push(`_Recorded: ${createdAt}_`, '');
  }

  if (summary) {
    lines.push('## Summary', '', summary, '');
  }

  if (notes) {
    const pushListSection = (heading: string, entries?: string[]) => {
      const items = Array.isArray(entries)
        ? entries.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
      if (items.length === 0) {
        return;
      }
      lines.push(heading, '', ...items.map((item) => `- ${item}`), '');
    };

    lines.push('## Meeting Notes', '');
    if (notes.summary) {
      lines.push('### Executive Summary', '', String(notes.summary || '').trim(), '');
    }
    pushListSection('### Discussion Points', notes.discussion_points);
    pushListSection('### Action Items', notes.action_items);
    pushListSection('### Decisions', notes.decisions);
    pushListSection('### Next Steps', notes.next_steps);
  }

  if (transcript) {
    lines.push('## Transcript', '', transcript, '');
  }

  return lines.join('\n').trim() + '\n';
}

export class MeetingNotesGenerator {
  private llmProcessor: LlmProcessor;
  private config: ConfigManager;

  constructor(config: ConfigManager, llmProcessor?: LlmProcessor) {
    this.config = config;
    this.llmProcessor = llmProcessor ?? new LlmProcessor(config);
  }

  async generate(transcriptText: string, modelOverride?: string): Promise<MeetingNotes> {
    const input = String(transcriptText || '').trim();
    if (!input) {
      throw new Error('Transcript text is empty');
    }

    const model = modelOverride || this.config.getSettings().meetingNotesModel || DEFAULT_MEETING_NOTES_MODEL;
    const raw = await this.llmProcessor.processOpenAI(input, MEETING_NOTES_PROMPT, model);
    return this.normalizeNotes(this.extractJson(raw));
  }

  private extractJson(rawResponse: string): Record<string, unknown> {
    const raw = String(rawResponse || '').trim();
    if (!raw) {
      throw new Error('Meeting notes model returned an empty response');
    }

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('Meeting notes response did not contain valid JSON');
    }

    const candidate = raw.slice(start, end + 1);
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Failed to parse meeting notes JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private normalizeNotes(payload: Record<string, unknown>): MeetingNotes {
    const toStringArray = (value: unknown): string[] => {
      if (!Array.isArray(value)) {
        return [];
      }
      return value
        .map((item) => String(item || '').trim())
        .filter(Boolean);
    };

    return {
      summary: String(payload.summary || '').trim(),
      discussion_points: toStringArray(payload.discussion_points),
      action_items: toStringArray(payload.action_items),
      decisions: toStringArray(payload.decisions),
      next_steps: toStringArray(payload.next_steps),
    };
  }
}
