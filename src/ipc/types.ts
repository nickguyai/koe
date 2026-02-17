import { BrowserWindow } from 'electron';
import { ConfigManager } from '../backend/config-manager';
import { GeminiTranscriber } from '../backend/gemini-transcriber';
import { TranscriptionJobQueue } from '../jobs';
import { MeetingNotesGenerator, NotionMcpService } from '../meeting';
import { OpenAIRealtimeClient } from '../backend/openai-realtime';
import { MemoryManager } from '../backend/memory-manager';

export interface IpcDependencies {
  configManager: ConfigManager;
  geminiTranscriber: GeminiTranscriber;
  jobQueue: TranscriptionJobQueue;
  meetingNotesGenerator: MeetingNotesGenerator | null;
  notionMcpService: NotionMcpService | null;
  memoryManager: MemoryManager | null;
  getMainWindow: () => BrowserWindow | null;
  getOpenAIClient: () => OpenAIRealtimeClient | null;
  setOpenAIClient: (client: OpenAIRealtimeClient | null) => void;
  getRealtimeMeetingMode: () => boolean;
  setRealtimeMeetingMode: (mode: boolean) => void;
  getSystemAudioQueue: () => Buffer[];
  startSystemAudioCapture: () => Promise<boolean>;
  stopSystemAudioCapture: () => Promise<void>;
  sendRealtimeEvent: (payload: Record<string, unknown>) => void;
  generateMeetingNotesInBackground: (jobId: string, transcriptText: string) => Promise<void>;
}
