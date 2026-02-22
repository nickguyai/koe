import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { IpcDependencies } from './types';
import { getAudioMimeType } from './utils';

export function registerJobHandlers(deps: IpcDependencies): void {
  const shouldRunConsensusForOpenAILive = (provider: string, hasAudio: boolean): boolean => {
    if (!hasAudio) {
      return false;
    }
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    if (normalizedProvider !== 'openai') {
      return false;
    }
    return deps.configManager.getSettings().consensusEnabled === true;
  };

  ipcMain.handle('transcription-job-enqueue', async (_event, payload: { path?: string; name?: string; bytes?: ArrayBuffer }) => {
    if (payload?.path) {
      return deps.jobQueue.enqueueFromPath(payload.path, payload.name);
    }
    if (payload?.bytes) {
      const bytes = Buffer.from(new Uint8Array(payload.bytes));
      return deps.jobQueue.enqueueFromBytes(bytes, payload.name || 'recording.webm');
    }
    throw new Error('Missing audio payload');
  });

  ipcMain.handle('live-audio-save', (_event, payload: { audioBytes?: ArrayBuffer; duration?: string; provider?: string }) => {
    if (!payload?.audioBytes) {
      throw new Error('Missing audio payload');
    }
    const audioBuffer = Buffer.from(new Uint8Array(payload.audioBytes));
    return deps.jobQueue.createAudioOnlyJob(payload?.provider || 'openai', audioBuffer, payload?.duration);
  });

  ipcMain.handle(
    'live-audio-complete',
    async (
      _event,
      payload: {
        jobId?: string;
        text?: string;
        title?: string;
        summary?: string;
      },
    ) => {
      const jobId = String(payload?.jobId || '').trim();
      if (!jobId) {
        throw new Error('Job ID is required');
      }
      const text = String(payload?.text || '').trim();
      if (!text) {
        throw new Error('Missing transcription text');
      }

      const existing = deps.jobQueue.getJob(jobId);
      if (!existing) {
        throw new Error('Job not found');
      }

      const shouldUseConsensus = shouldRunConsensusForOpenAILive(
        existing.provider || 'openai',
        Boolean(existing.audio_path),
      );
      if (shouldUseConsensus) {
        // Live OpenAI mode can stream a fast preview text, but when consensus is
        // enabled we re-transcribe from saved audio through the queued consensus path.
        const queued = deps.jobQueue.retranscribeJob(jobId);
        return { job: queued };
      }

      const completed = deps.jobQueue.completeAudioOnlyJob(
        jobId,
        text,
        payload?.title,
        payload?.summary,
      );

      return completed;
    },
  );

  ipcMain.handle(
    'transcription-job-save',
    async (
      _event,
      payload: {
        text?: string;
        title?: string;
        summary?: string;
        provider?: string;
        audioBytes?: ArrayBuffer;
        duration?: string;
      },
    ) => {
      const text = String(payload?.text || '').trim();
      if (!text) {
        throw new Error('Missing transcription text');
      }
      const provider = payload?.provider || 'openai';
      const audioBuffer = payload?.audioBytes ? Buffer.from(new Uint8Array(payload.audioBytes)) : undefined;
      const shouldUseConsensus = shouldRunConsensusForOpenAILive(
        provider,
        Boolean(audioBuffer && audioBuffer.length > 0),
      );
      if (shouldUseConsensus && audioBuffer) {
        // Fallback live save path: create an audio-only job and route it through
        // the queue so consensus can execute with the same logic as batch jobs.
        const seeded = deps.jobQueue.createAudioOnlyJob(provider, audioBuffer, payload?.duration);
        const queued = deps.jobQueue.retranscribeJob(seeded.id);
        return { job: queued };
      }

      const created = deps.jobQueue.createTextJob(
        text,
        provider,
        payload?.title,
        payload?.summary,
        audioBuffer,
        payload?.duration,
      );

      return created;
    },
  );

  ipcMain.handle('transcription-job-list', () => {
    return deps.jobQueue.listJobs();
  });

  ipcMain.handle('transcription-job-get', (_event, jobId: string) => {
    const record = deps.jobQueue.getJob(jobId);
    if (!record) {
      throw new Error('Job not found');
    }
    const result = deps.jobQueue.readJobResult(jobId);
    return result ? { ...record, result } : record;
  });

  ipcMain.handle('transcription-job-retranscribe', (_event, jobId: string) => {
    if (!jobId) {
      throw new Error('Job ID is required');
    }
    return deps.jobQueue.retranscribeJob(jobId);
  });

  ipcMain.handle('transcription-job-audio', (_event, jobId: string) => {
    try {
      if (!jobId || !/^[\w-]+$/.test(jobId) || jobId.includes('..')) {
        return null;
      }
      const record = deps.jobQueue.getJob(jobId);
      if (!record?.audio_path) {
        return null;
      }
      const recordingsDir = deps.configManager.getRecordingsDir();
      const resolvedAudio = path.resolve(recordingsDir, record.audio_path);
      const recordingsResolved = path.resolve(recordingsDir);
      if (!resolvedAudio.startsWith(recordingsResolved + path.sep)) {
        return null;
      }
      if (!fs.existsSync(resolvedAudio)) {
        return null;
      }
      const stat = fs.statSync(resolvedAudio);
      if (!stat.isFile()) {
        return null;
      }
      const data = fs.readFileSync(resolvedAudio);
      const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      return { data: arrayBuffer, mimeType: getAudioMimeType(resolvedAudio) };
    } catch (err) {
      console.warn('Failed to read job audio:', err);
      return null;
    }
  });

  ipcMain.handle('transcription-job-polish', async (_event, payload: { jobId: string; style?: string; customPrompt?: string }) => {
    const jobId = payload?.jobId;
    if (!jobId) {
      throw new Error('Job ID is required');
    }

    // Pre-flight check: Gemini API key is required for polish
    const geminiApiKey = deps.configManager.getApiKey('gemini');
    if (!geminiApiKey) {
      throw new Error('Google API key required. Go to Settings to add your key.');
    }

    const record = deps.jobQueue.getJob(jobId);
    if (!record) {
      throw new Error('Job not found');
    }
    const result = deps.jobQueue.readJobResult(jobId);
    if (!result || !result.speech_segments) {
      throw new Error('Transcription result not found');
    }
    const rawText = result.speech_segments.map((seg) => seg.content).join('\n').trim();
    if (!rawText) {
      throw new Error('No transcript segments found');
    }
    const settings = deps.configManager.getSettings();
    const style = payload.style || settings.polishStyle;
    const customPrompt = payload.customPrompt || settings.customPolishPrompt;

    try {
      const polished = await deps.geminiTranscriber.polishText(rawText, style, customPrompt);
      const readability = deps.jobQueue.updateReadability(jobId, polished);
      return { status: 'ok', readability, style };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Polish failed';
      // Surface common API errors with user-friendly messages
      if (message.includes('API key not valid') || message.includes('INVALID_ARGUMENT')) {
        throw new Error('Invalid Google API key. Check your key in Settings.');
      }
      if (message.includes('quota') || message.includes('RESOURCE_EXHAUSTED')) {
        throw new Error('API quota exceeded. Try again later or check your billing.');
      }
      if (message.includes('model') || message.includes('not found') || message.includes('404')) {
        throw new Error(`Model not available. Check geminiModel setting or try a different model.`);
      }
      throw new Error(message);
    }
  });

  ipcMain.handle('transcription-job-delete', (_event, jobId: string) => {
    if (!jobId) {
      throw new Error('Job ID is required');
    }
    const deleted = deps.jobQueue.deleteJob(jobId);
    return { deleted };
  });

  ipcMain.handle('transcription-job-export', (_event, jobId: string) => {
    if (!jobId) {
      throw new Error('Job ID is required');
    }
    const exportData = deps.jobQueue.getJobExportData(jobId);
    if (!exportData) {
      throw new Error('Job not found');
    }
    return exportData;
  });

  ipcMain.handle('transcription-job-update-action-items', (_event, payload: { jobId: string; completedItems: number[] }) => {
    const jobId = String(payload?.jobId || '').trim();
    if (!jobId) {
      throw new Error('Job ID is required');
    }
    const completedItems = Array.isArray(payload?.completedItems)
      ? payload.completedItems.filter((n: unknown) => Number.isInteger(n) && (n as number) >= 0)
      : [];
    return deps.jobQueue.updateActionItemCompletion(jobId, completedItems);
  });
}
