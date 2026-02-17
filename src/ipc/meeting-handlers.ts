import { ipcMain } from 'electron';
import { IpcDependencies } from './types';

export function registerMeetingHandlers(deps: IpcDependencies): void {
  ipcMain.handle('generate-meeting-notes', async (_event, jobId: string) => {
    if (!jobId) {
      throw new Error('Job ID is required');
    }
    const record = deps.jobQueue.getJob(jobId);
    if (!record) {
      throw new Error('Job not found');
    }
    const result = deps.jobQueue.readJobResult(jobId);
    if (!result || !result.speech_segments) {
      throw new Error('Transcription result not found');
    }
    const text = result.speech_segments.map((seg) => seg.content).join('\n').trim();
    if (!text) {
      throw new Error('No transcript text available');
    }
    if (!deps.meetingNotesGenerator) {
      throw new Error('Meeting notes generator not available');
    }
    const notes = await deps.meetingNotesGenerator.generate(text);
    const updated = deps.jobQueue.updateMeetingNotes(jobId, notes);
    return { meeting_notes: updated.meeting_notes, updated_at: updated.updated_at };
  });

  ipcMain.handle('transcription-job-share-notion', async (_event, payload: { jobId?: string }) => {
    const jobId = String(payload?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Job ID is required');
    }

    const exportData = deps.jobQueue.getJobExportData(jobId);
    if (!exportData || !exportData.markdown) {
      throw new Error('No meeting notes available to share');
    }

    if (!deps.notionMcpService || !deps.notionMcpService.isConfigured()) {
      return {
        ok: false,
        message: 'Notion MCP is not configured',
      };
    }

    return deps.notionMcpService.shareMeetingMarkdown({
      title: exportData.title || 'Meeting Notes',
      markdown: exportData.markdown,
    });
  });
}
