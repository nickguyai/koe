import { BrowserWindow } from 'electron';
import { ConfigManager } from '../backend/config-manager';
import { GeminiTranscriber } from '../backend/gemini-transcriber';
import { TranscriptionJobQueue } from '../jobs';
import { OpenAIRealtimeClient } from '../backend/openai-realtime';
import { MemoryManager } from '../backend/memory-manager';

export interface IpcDependencies {
  configManager: ConfigManager;
  geminiTranscriber: GeminiTranscriber;
  jobQueue: TranscriptionJobQueue;
  memoryManager: MemoryManager | null;
  getMainWindow: () => BrowserWindow | null;
  getOpenAIClient: () => OpenAIRealtimeClient | null;
  setOpenAIClient: (client: OpenAIRealtimeClient | null) => void;
  sendRealtimeEvent: (payload: Record<string, unknown>) => void;
}
