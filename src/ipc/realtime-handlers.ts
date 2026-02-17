import { ipcMain } from 'electron';
import { OpenAIRealtimeClient, RealtimeSegmentEvent, RealtimeStructuredEvent, RealtimeTextEvent } from '../backend/openai-realtime';
import { LIVE_TRANSCRIPTION_PROMPT } from '../backend/prompts';
import { mixPcmBuffers } from '../audio-mixer';
import { IpcDependencies } from './types';

export function registerRealtimeHandlers(deps: IpcDependencies): void {
  ipcMain.handle('openai-realtime-start', async (_event, payload?: { meetingMode?: boolean }) => {
    const apiKey = deps.configManager.getApiKey('openai');
    if (!apiKey) {
      throw new Error('OpenAI API key is not set');
    }
    deps.setRealtimeMeetingMode(Boolean(payload?.meetingMode));

    const currentClient = deps.getOpenAIClient();
    if (currentClient) {
      await currentClient.disconnect();
      deps.setOpenAIClient(null);
    }
    await deps.stopSystemAudioCapture();

    const settings = deps.configManager.getSettings();
    const language = settings.language || 'en';
    const customPrompt = (settings.customTranscriptionPrompt || '').trim();
    const prompt = customPrompt || LIVE_TRANSCRIPTION_PROMPT;
    const openAIClient = new OpenAIRealtimeClient(apiKey, undefined, undefined, {
      single: prompt,
      meeting: prompt,
    }, language);
    openAIClient.on('status', (status: string) => {
      deps.sendRealtimeEvent({ type: 'status', status });
    });
    openAIClient.on('text', (event: RealtimeTextEvent) => {
      deps.sendRealtimeEvent({ type: 'text', content: event.content, isNewResponse: event.isNewResponse });
    });
    openAIClient.on('segment', (event: RealtimeSegmentEvent) => {
      deps.sendRealtimeEvent({ type: 'segment', segment: event.segment, allSegments: event.allSegments });
    });
    openAIClient.on('structured_result', (event: RealtimeStructuredEvent) => {
      deps.sendRealtimeEvent({ type: 'structured_result', result: event.result });
    });
    openAIClient.on('error', (message: string) => {
      deps.sendRealtimeEvent({ type: 'error', content: message });
    });

    deps.setOpenAIClient(openAIClient);

    if (deps.getRealtimeMeetingMode()) {
      await deps.startSystemAudioCapture();
      await openAIClient.startMeeting();
    } else {
      await openAIClient.connect();
    }

    return true;
  });

  ipcMain.on('openai-realtime-audio', (_event, audio: ArrayBuffer | Buffer) => {
    const openAIClient = deps.getOpenAIClient();
    if (!openAIClient) {
      return;
    }
    const micBuffer = Buffer.isBuffer(audio) ? audio : Buffer.from(new Uint8Array(audio));
    if (!deps.getRealtimeMeetingMode()) {
      void openAIClient.sendAudio(micBuffer);
      return;
    }

    // Dequeue one system audio chunk per mic frame for temporal alignment.
    // If no system chunk available, mix with silence (null).
    const systemAudioQueue = deps.getSystemAudioQueue();
    const systemChunk = systemAudioQueue.shift() ?? null;
    const mixed = mixPcmBuffers(micBuffer, systemChunk);
    void openAIClient.sendAudio(mixed.length > 0 ? mixed : micBuffer);
  });

  ipcMain.handle('openai-realtime-stop', async (_event, payload?: { meetingMode?: boolean }) => {
    const isMeeting = Boolean(payload?.meetingMode) || deps.getRealtimeMeetingMode();
    const openAIClient = deps.getOpenAIClient();
    if (openAIClient) {
      if (isMeeting) {
        const transcript = await openAIClient.stopMeeting();
        await deps.stopSystemAudioCapture();
        deps.setRealtimeMeetingMode(false);
        return { transcript };
      }
      await openAIClient.commitAudio();
    }
    return true;
  });

  ipcMain.handle('openai-realtime-disconnect', async () => {
    deps.setRealtimeMeetingMode(false);
    await deps.stopSystemAudioCapture();
    const openAIClient = deps.getOpenAIClient();
    if (openAIClient) {
      await openAIClient.disconnect();
      deps.setOpenAIClient(null);
    }
    return true;
  });
}
