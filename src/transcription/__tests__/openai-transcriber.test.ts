import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, existsSyncMock, readFileMock, unlinkMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  existsSyncMock: vi.fn(),
  readFileMock: vi.fn(),
  unlinkMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../../audio/ffmpeg-paths', () => ({
  getFfmpegPath: () => '/usr/bin/ffmpeg',
}));

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  promises: {
    readFile: readFileMock,
    unlink: unlinkMock,
  },
}));

import { OpenAITranscriber } from '../openai-transcriber';

function createConfig() {
  return {
    getApiKey: vi.fn(() => 'test-openai-key'),
    getSettings: vi.fn(() => ({
      autoDetectSpeakers: true,
      timestamps: true,
      punctuation: true,
      language: 'auto',
      summaryLength: 'medium',
    })),
  };
}

describe('OpenAITranscriber audio normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    existsSyncMock.mockReset();
    readFileMock.mockReset();
    unlinkMock.mockReset();
  });

  it('converts webm input to wav for OpenAI transcription', async () => {
    const config = createConfig();
    const transcriber = new OpenAITranscriber(config as any);
    existsSyncMock.mockImplementation((candidate: string) => String(candidate).endsWith('_converted.wav'));
    unlinkMock.mockResolvedValue(undefined);

    spawnMock.mockImplementation(() => {
      const child = {
        on: vi.fn((event: string, callback: Function) => {
          if (event === 'close') {
            callback(0);
          }
          return child;
        }),
      };
      return child as any;
    });

    const converted = await (transcriber as any).convertToWavIfNeeded('/tmp/live-input.webm');
    expect(converted.path).toBe('/tmp/live-input_converted.wav');
    expect(spawnMock).toHaveBeenCalledTimes(1);

    await converted.cleanup?.();
    expect(unlinkMock).toHaveBeenCalledWith('/tmp/live-input_converted.wav');
  });

  it('throws when non-wav/mp3 conversion fails', async () => {
    const config = createConfig();
    const transcriber = new OpenAITranscriber(config as any);
    existsSyncMock.mockReturnValue(false);

    spawnMock.mockImplementation(() => {
      const child = {
        on: vi.fn((event: string, callback: Function) => {
          if (event === 'close') {
            callback(1);
          }
          return child;
        }),
      };
      return child as any;
    });

    await expect((transcriber as any).convertToWavIfNeeded('/tmp/bad-input.webm'))
      .rejects
      .toThrow('Failed to convert audio to wav for OpenAI transcription');
  });

  it('sends wav format to input_audio after conversion', async () => {
    const config = createConfig();
    const transcriber = new OpenAITranscriber(config as any);
    const createMock = vi.fn(async () => ({
      choices: [
        {
          message: {
            content: '{"title":"Consensus","segments":[],"summary":"ok"}',
          },
        },
      ],
    }));

    (transcriber as any).getClient = vi.fn(() => ({
      chat: {
        completions: {
          create: createMock,
        },
      },
    }));
    (transcriber as any).convertToWavIfNeeded = vi.fn(async () => ({ path: '/tmp/live-input_converted.wav' }));
    readFileMock.mockResolvedValue(Buffer.from([1, 2, 3, 4]));

    await transcriber.transcribeAudio('/tmp/live-input.webm', 'base', []);

    const request = createMock.mock.calls[0][0];
    const inputAudio = request.messages[0].content[1].input_audio;
    expect(inputAudio.format).toBe('wav');
  });
});
