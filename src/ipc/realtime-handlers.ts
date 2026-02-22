import { ipcMain } from 'electron';
import { OpenAIRealtimeClient, RealtimeSegmentEvent, RealtimeStructuredEvent, RealtimeTextEvent } from '../backend/openai-realtime';
import { LIVE_TRANSCRIPTION_PROMPT } from '../backend/prompts';
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

  ipcMain.handle('openai-realtime-start', async () => {
    const apiKey = deps.configManager.getApiKey('openai');
    if (!apiKey) {
      throw new Error('OpenAI API key is not set');
    }

    const currentClient = deps.getOpenAIClient();
    if (currentClient) {
      await currentClient.disconnect();
      deps.setOpenAIClient(null);
    }

    const settings = deps.configManager.getSettings();
    const language = settings.language || 'en';
    // Realtime dictation is pinned to the Brainwave prompt/workflow for stability.
    const openAIClient = new OpenAIRealtimeClient(
      apiKey,
      undefined,
      undefined,
      { single: LIVE_TRANSCRIPTION_PROMPT },
      language,
    );
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
    await openAIClient.connect();

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
      await openAIClient.sendAudio(micBuffer);
    });
  });

  ipcMain.handle('openai-realtime-stop', async () => {
    const openAIClient = deps.getOpenAIClient();
    if (openAIClient) {
      await waitForAudioIngressToSettle();
      await openAIClient.commitAudio();
    }
    return true;
  });

  ipcMain.handle('openai-realtime-disconnect', async () => {
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
