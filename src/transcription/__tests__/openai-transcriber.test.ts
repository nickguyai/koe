import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, existsSyncMock, readFileMock, unlinkMock, MockRealtimeClient, mockOn, mockStartMeeting, mockSendAudio, mockStopMeeting } =
  vi.hoisted(() => {
    const mockOn = vi.fn();
    const mockStartMeeting = vi.fn().mockResolvedValue(undefined);
    const mockSendAudio = vi.fn().mockResolvedValue(undefined);
    const mockStopMeeting = vi.fn().mockResolvedValue('');
    const MockRealtimeClient = vi.fn().mockImplementation(() => ({
      on: mockOn,
      startMeeting: mockStartMeeting,
      sendAudio: mockSendAudio,
      stopMeeting: mockStopMeeting,
    }));
    return {
      spawnMock: vi.fn(),
      existsSyncMock: vi.fn(),
      readFileMock: vi.fn(),
      unlinkMock: vi.fn(),
      MockRealtimeClient,
      mockOn,
      mockStartMeeting,
      mockSendAudio,
      mockStopMeeting,
    };
  });

vi.mock('child_process', () => ({ spawn: spawnMock }));
vi.mock('../../audio/ffmpeg-paths', () => ({ getFfmpegPath: () => '/usr/bin/ffmpeg' }));
vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  promises: { readFile: readFileMock, unlink: unlinkMock },
}));
vi.mock('../../realtime/openai-realtime', () => ({ OpenAIRealtimeClient: MockRealtimeClient }));

import { OpenAITranscriber } from '../openai-transcriber';

function createConfig(language = 'auto') {
  return {
    getApiKey: vi.fn(() => 'test-openai-key'),
    getSettings: vi.fn(() => ({
      autoDetectSpeakers: true,
      timestamps: true,
      punctuation: true,
      language,
      summaryLength: 'medium',
    })),
  };
}

function mockSuccessfulSpawn() {
  spawnMock.mockImplementation(() => {
    const child = {
      on: vi.fn((event: string, cb: (code?: number) => void) => {
        if (event === 'close') cb(0);
        return child;
      }),
    };
    return child;
  });
}

describe('OpenAITranscriber', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOn.mockReset();
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue(Buffer.alloc(96000)); // 2 seconds of PCM16
    unlinkMock.mockResolvedValue(undefined);
    mockSuccessfulSpawn();
  });

  it('converts audio to PCM16 at 24kHz and drives the Realtime API', async () => {
    const config = createConfig();
    const transcriber = new OpenAITranscriber(config as any);

    await transcriber.transcribeAudio('/tmp/audio.webm', 'base', []);

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/ffmpeg',
      expect.arrayContaining(['-ar', '24000', '-ac', '1', '-f', 's16le']),
      expect.anything(),
    );
    expect(mockStartMeeting).toHaveBeenCalled();
    expect(mockSendAudio).toHaveBeenCalled();
    expect(mockStopMeeting).toHaveBeenCalled();
  });

  it('sends audio in 1-second chunks', async () => {
    readFileMock.mockResolvedValue(Buffer.alloc(144000)); // 3 seconds
    const config = createConfig();
    const transcriber = new OpenAITranscriber(config as any);

    await transcriber.transcribeAudio('/tmp/audio.webm', 'base', []);

    // 144000 / 48000 = 3 chunks
    expect(mockSendAudio).toHaveBeenCalledTimes(3);
  });

  it('passes language to the Realtime client when settings specify a non-auto language', async () => {
    const config = createConfig('ja');
    const transcriber = new OpenAITranscriber(config as any);

    await transcriber.transcribeAudio('/tmp/audio.webm', 'detail', []);

    expect(MockRealtimeClient).toHaveBeenCalledWith('test-openai-key', undefined, undefined, undefined, 'ja');
  });

  it('does not pass language when settings use auto', async () => {
    const config = createConfig('auto');
    const transcriber = new OpenAITranscriber(config as any);

    await transcriber.transcribeAudio('/tmp/audio.webm', 'verify', []);

    expect(MockRealtimeClient).toHaveBeenCalledWith('test-openai-key', undefined, undefined, undefined, undefined);
  });

  it('maps variant correctly in returned VariantResult', async () => {
    const config = createConfig();
    const transcriber = new OpenAITranscriber(config as any);

    const result = await transcriber.transcribeAudio('/tmp/audio.webm', 'verify', []);

    expect(result.variant).toBe('verify');
    expect(result.title).toBe('Transcription');
    expect(result.summary).toBe('');
    expect(Array.isArray(result.segments)).toBe(true);
  });

  it('throws when PCM16 conversion fails', async () => {
    existsSyncMock.mockReturnValue(false);
    spawnMock.mockImplementation(() => {
      const child = {
        on: vi.fn((event: string, cb: (code?: number) => void) => {
          if (event === 'close') cb(1);
          return child;
        }),
      };
      return child;
    });

    const config = createConfig();
    const transcriber = new OpenAITranscriber(config as any);

    await expect(transcriber.transcribeAudio('/tmp/audio.webm', 'base', [])).rejects.toThrow(
      'Failed to convert audio to PCM16',
    );
  });

  it('rejects and cleans up when the Realtime client emits an error event', async () => {
    // Simulate error firing (e.g. invalid API key, quota exceeded) during the session.
    // Without the error listener this would throw ERR_UNHANDLED_ERROR in Node.
    mockOn.mockImplementation((event: string, handler: (msg: string) => void) => {
      if (event === 'error') {
        // fire synchronously so it races with startMeeting
        handler('rate limit exceeded');
      }
    });

    const config = createConfig();
    const transcriber = new OpenAITranscriber(config as any);

    await expect(transcriber.transcribeAudio('/tmp/audio.webm', 'base', [])).rejects.toThrow('rate limit exceeded');
    expect(unlinkMock).toHaveBeenCalledWith('/tmp/audio_realtime_base.pcm');
  });

  it('cleans up PCM temp file even when transcription throws', async () => {
    mockStartMeeting.mockRejectedValueOnce(new Error('connection failed'));

    const config = createConfig();
    const transcriber = new OpenAITranscriber(config as any);

    await expect(transcriber.transcribeAudio('/tmp/audio.webm', 'base', [])).rejects.toThrow('connection failed');
    expect(unlinkMock).toHaveBeenCalledWith('/tmp/audio_realtime_base.pcm');
  });
});
