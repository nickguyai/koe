import { ipcMain } from 'electron';
import { OpenAIRealtimeClient, RealtimeSegmentEvent, RealtimeStructuredEvent, RealtimeTextEvent } from '../backend/openai-realtime';
import { LIVE_TRANSCRIPTION_PROMPT } from '../backend/prompts';
import { mixPcmBuffers } from '../audio-mixer';
import { IpcDependencies } from './types';

export function registerRealtimeHandlers(deps: IpcDependencies): void {
  let audioIngressQueue: Promise<void> = Promise.resolve();
  let lastAudioIngressAt = 0;

  const enqueueAudioForward = (task: () => Promise<void>): void => {
    audioIngressQueue = audioIngressQueue.then(task, task);
  };

  const waitForAudioIngressToSettle = async (settleMs: number = 80, maxWaitMs: number = 1200): Promise<void> => {
    const start = Date.now();
    while (true) {
      await audioIngressQueue;
      const idleFor = Date.now() - lastAudioIngressAt;
      if (idleFor >= settleMs || Date.now() - start >= maxWaitMs) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

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
    // Single live dictation uses prompt-guided transcription; meeting mode remains pure ASR.
    const openAIClient = new OpenAIRealtimeClient(apiKey, undefined, undefined, { single: prompt }, language);
    audioIngressQueue = Promise.resolve();
    lastAudioIngressAt = 0;
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
    lastAudioIngressAt = Date.now();
    const micBuffer = Buffer.isBuffer(audio) ? audio : Buffer.from(new Uint8Array(audio));
    enqueueAudioForward(async () => {
      const openAIClient = deps.getOpenAIClient();
      if (!openAIClient) {
        return;
      }
      if (!deps.getRealtimeMeetingMode()) {
        await openAIClient.sendAudio(micBuffer);
        return;
      }

      // Dequeue one system audio chunk per mic frame for temporal alignment.
      // If no system chunk available, mix with silence (null).
      const systemAudioQueue = deps.getSystemAudioQueue();
      const systemChunk = systemAudioQueue.shift() ?? null;
      const mixed = mixPcmBuffers(micBuffer, systemChunk);
      await openAIClient.sendAudio(mixed.length > 0 ? mixed : micBuffer);
    });
  });

  ipcMain.handle('openai-realtime-stop', async (_event, payload?: { meetingMode?: boolean }) => {
    const isMeeting = Boolean(payload?.meetingMode) || deps.getRealtimeMeetingMode();
    const openAIClient = deps.getOpenAIClient();
    if (openAIClient) {
      await waitForAudioIngressToSettle();
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
    audioIngressQueue = Promise.resolve();
    lastAudioIngressAt = 0;
    const openAIClient = deps.getOpenAIClient();
    if (openAIClient) {
      await openAIClient.disconnect();
      deps.setOpenAIClient(null);
    }
    return true;
  });
}
