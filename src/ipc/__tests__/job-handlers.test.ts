import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ipcHandlers, mockIpcMain } = vi.hoisted(() => {
  const capturedHandlers: Record<string, Function> = {};
  return {
    ipcHandlers: capturedHandlers,
    mockIpcMain: {
      handle: vi.fn((channel: string, handler: Function) => {
        capturedHandlers[channel] = handler;
      }),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
}));

import { registerJobHandlers } from '../job-handlers';

type TestDeps = ReturnType<typeof buildDeps>;

function buildDeps() {
  const configManager = {
    getSettings: vi.fn(() => ({ consensusEnabled: true })),
    getApiKey: vi.fn(() => ''),
    getRecordingsDir: vi.fn(() => '/tmp'),
  };

  const jobQueue = {
    enqueueFromPath: vi.fn(),
    enqueueFromBytes: vi.fn(),
    createAudioOnlyJob: vi.fn(),
    completeAudioOnlyJob: vi.fn(),
    createTextJob: vi.fn(),
    enqueueDiarization: vi.fn(),
    getJob: vi.fn(),
    readJobResult: vi.fn(),
    listJobs: vi.fn(() => []),
    retranscribeJob: vi.fn(),
    updateReadability: vi.fn(),
    deleteJob: vi.fn(),
    getJobExportData: vi.fn(),
    updateActionItemCompletion: vi.fn(),
  };

  const deps = {
    configManager,
    geminiTranscriber: {
      polishText: vi.fn(),
    },
    jobQueue,
    meetingNotesGenerator: null,
    notionMcpService: null,
    memoryManager: null,
    getMainWindow: vi.fn(() => null),
    getOpenAIClient: vi.fn(() => null),
    setOpenAIClient: vi.fn(),
    getRealtimeMeetingMode: vi.fn(() => false),
    setRealtimeMeetingMode: vi.fn(),
    getSystemAudioQueue: vi.fn(() => []),
    startSystemAudioCapture: vi.fn(async () => true),
    stopSystemAudioCapture: vi.fn(async () => {}),
    sendRealtimeEvent: vi.fn(),
    generateMeetingNotesInBackground: vi.fn(async () => {}),
  } as any;

  return deps;
}

function getHandler(name: string): Function {
  const handler = ipcHandlers[name];
  expect(handler).toBeDefined();
  return handler;
}

describe('registerJobHandlers live consensus routing', () => {
  let deps: TestDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(ipcHandlers).forEach((key) => delete ipcHandlers[key]);
    deps = buildDeps();
    registerJobHandlers(deps);
  });

  it('routes live-audio-complete through retranscribe when consensus is enabled for openai dictation', async () => {
    deps.jobQueue.getJob.mockReturnValue({
      id: 'job_live_1',
      provider: 'openai',
      audio_path: '/tmp/recording.webm',
    });
    deps.jobQueue.retranscribeJob.mockReturnValue({
      id: 'job_live_1',
      status: 'pending',
    });

    const handler = getHandler('live-audio-complete');
    const response = await handler({}, { jobId: 'job_live_1', text: 'hello world' });

    expect(deps.jobQueue.retranscribeJob).toHaveBeenCalledWith('job_live_1');
    expect(deps.jobQueue.completeAudioOnlyJob).not.toHaveBeenCalled();
    expect(response).toEqual({
      job: {
        id: 'job_live_1',
        status: 'pending',
      },
    });
  });

  it('does not route meeting mode through consensus in live-audio-complete', async () => {
    deps.jobQueue.getJob.mockReturnValue({
      id: 'job_meeting_1',
      provider: 'openai',
      audio_path: '/tmp/meeting.webm',
    });
    deps.jobQueue.completeAudioOnlyJob.mockReturnValue({
      job: { id: 'job_meeting_1', status: 'completed' },
      result: { title: 'Meeting', summary: 'ok', speech_segments: [] },
    });

    const handler = getHandler('live-audio-complete');
    await handler({}, { jobId: 'job_meeting_1', text: 'meeting text', meetingMode: true });

    expect(deps.jobQueue.retranscribeJob).not.toHaveBeenCalled();
    expect(deps.jobQueue.completeAudioOnlyJob).toHaveBeenCalled();
  });

  it('routes transcription-job-save fallback through audio-only + retranscribe when consensus is enabled', async () => {
    deps.jobQueue.createAudioOnlyJob.mockReturnValue({
      id: 'job_save_1',
      status: 'failed',
    });
    deps.jobQueue.retranscribeJob.mockReturnValue({
      id: 'job_save_1',
      status: 'pending',
    });

    const handler = getHandler('transcription-job-save');
    const response = await handler({}, {
      text: 'live fallback transcript',
      provider: 'openai',
      audioBytes: new Uint8Array([1, 2, 3]).buffer,
      duration: '0:03',
    });

    expect(deps.jobQueue.createAudioOnlyJob).toHaveBeenCalled();
    expect(deps.jobQueue.retranscribeJob).toHaveBeenCalledWith('job_save_1');
    expect(deps.jobQueue.createTextJob).not.toHaveBeenCalled();
    expect(response).toEqual({
      job: {
        id: 'job_save_1',
        status: 'pending',
      },
    });
  });

  it('keeps transcription-job-save text path when no audio is present', async () => {
    deps.jobQueue.createTextJob.mockReturnValue({
      job: { id: 'job_text_1', status: 'completed' },
      result: { title: 'Title', summary: 'Summary', speech_segments: [] },
    });

    const handler = getHandler('transcription-job-save');
    await handler({}, {
      text: 'text only path',
      provider: 'openai',
    });

    expect(deps.jobQueue.retranscribeJob).not.toHaveBeenCalled();
    expect(deps.jobQueue.createAudioOnlyJob).not.toHaveBeenCalled();
    expect(deps.jobQueue.createTextJob).toHaveBeenCalled();
  });
});
