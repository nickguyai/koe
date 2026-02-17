import { describe, expect, it, vi } from 'vitest';
import { MeetingNotesGenerator, formatMeetingMarkdownExport } from '../meeting-notes-generator';

describe('MeetingNotesGenerator', () => {
  it('generates structured notes from JSON response', async () => {
    const config = {
      getSettings: () => ({ meetingNotesModel: 'gpt-5.2-2025-12-11' }),
    } as any;
    const llm = {
      processOpenAI: vi.fn().mockResolvedValue(
        JSON.stringify({
          summary: 'Discussed roadmap updates.',
          discussion_points: ['Q2 milestones', 'Hiring timeline'],
          action_items: ['Alice: publish draft plan'],
          decisions: ['Ship beta in May'],
          next_steps: ['Review draft in next sync'],
        }),
      ),
    } as any;

    const generator = new MeetingNotesGenerator(config, llm);
    const notes = await generator.generate('meeting transcript');

    expect(notes.summary).toBe('Discussed roadmap updates.');
    expect(notes.discussion_points).toEqual(['Q2 milestones', 'Hiring timeline']);
    expect(notes.action_items).toEqual(['Alice: publish draft plan']);
    expect(notes.decisions).toEqual(['Ship beta in May']);
    expect(notes.next_steps).toEqual(['Review draft in next sync']);
    expect(llm.processOpenAI).toHaveBeenCalled();
  });

  it('extracts JSON when model wraps output in prose', async () => {
    const config = {
      getSettings: () => ({ meetingNotesModel: 'gpt-5.2-2025-12-11' }),
    } as any;
    const llm = {
      processOpenAI: vi.fn().mockResolvedValue(
        'Here is your result:\n{"summary":"Done","discussion_points":[],"action_items":[],"decisions":[],"next_steps":[]}',
      ),
    } as any;

    const generator = new MeetingNotesGenerator(config, llm);
    const notes = await generator.generate('meeting transcript');
    expect(notes.summary).toBe('Done');
  });

  it('throws when response does not contain JSON', async () => {
    const config = {
      getSettings: () => ({ meetingNotesModel: 'gpt-5.2-2025-12-11' }),
    } as any;
    const llm = {
      processOpenAI: vi.fn().mockResolvedValue('not json'),
    } as any;

    const generator = new MeetingNotesGenerator(config, llm);
    await expect(generator.generate('meeting transcript')).rejects.toThrow('valid JSON');
  });

  it('formats structured meeting markdown export', () => {
    const markdown = formatMeetingMarkdownExport({
      title: 'Weekly Sync',
      createdAt: '2026-02-16',
      summary: 'Discussed launch blockers.',
      transcript: 'Alice: Let us ship this week.',
      meetingNotes: {
        summary: 'Team aligned on launch scope.',
        discussion_points: ['Launch date options'],
        action_items: ['Alice: finalize release notes'],
        decisions: ['Ship on Friday'],
        next_steps: ['Review checklist tomorrow'],
      },
    });

    expect(markdown).toContain('# Weekly Sync');
    expect(markdown).toContain('## Meeting Notes');
    expect(markdown).toContain('### Action Items');
    expect(markdown).toContain('- Alice: finalize release notes');
    expect(markdown).toContain('## Transcript');
  });
});
