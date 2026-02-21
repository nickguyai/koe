import { beforeEach, describe, expect, it, vi } from 'vitest';

const { MockWebSocket } = vi.hoisted(() => {
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readyState = MockWebSocket.OPEN;
    sentPayloads: string[] = [];
    failNextSend = false;
    private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

    constructor(public url: string, public options?: Record<string, unknown>) {
      MockWebSocket.instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      if (!this.handlers[event]) {
        this.handlers[event] = [];
      }
      this.handlers[event].push(handler);
      return this;
    }

    once(event: string, handler: (...args: unknown[]) => void): this {
      const onceHandler = (...args: unknown[]) => {
        this.removeListener(event, onceHandler);
        handler(...args);
      };
      return this.on(event, onceHandler);
    }

    removeListener(event: string, handler: (...args: unknown[]) => void): this {
      const list = this.handlers[event];
      if (!list) {
        return this;
      }
      this.handlers[event] = list.filter((fn) => fn !== handler);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      const list = this.handlers[event] || [];
      for (const handler of [...list]) {
        handler(...args);
      }
    }

    send(payload: string, cb?: (err?: Error) => void): void {
      this.sentPayloads.push(payload);
      if (this.failNextSend) {
        this.failNextSend = false;
        cb?.(new Error('mock send failure'));
        return;
      }
      cb?.();
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close');
    }

    terminate(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close');
    }
  }

  return { MockWebSocket };
});

vi.mock('ws', () => ({
  default: MockWebSocket,
}));

import { OpenAIRealtimeClient } from '../openai-realtime';
import { LIVE_TRANSCRIPTION_PROMPT } from '../../transcription/prompts';

type TestWs = InstanceType<typeof MockWebSocket>;

function parseMessages(ws: TestWs): Array<Record<string, unknown>> {
  return ws.sentPayloads.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

function firstMessageByType(ws: TestWs, type: string): Record<string, unknown> | undefined {
  return parseMessages(ws).find((msg) => msg.type === type);
}

function typedMessages(ws: TestWs): string[] {
  return parseMessages(ws).map((msg) => String(msg.type || ''));
}

async function connectClient(client: OpenAIRealtimeClient, mode: 'single' | 'meeting' = 'single'): Promise<TestWs> {
  const connectPromise = client.connect(mode);
  const ws = MockWebSocket.instances.at(-1);
  expect(ws).toBeDefined();
  ws!.emit('message', Buffer.from(JSON.stringify({ type: 'session.created' })));
  await connectPromise;
  return ws!;
}

describe('OpenAIRealtimeClient', () => {
  beforeEach(() => {
    MockWebSocket.instances.length = 0;
  });

  it('uses instructions and keeps input_audio_transcription when instructions are provided', async () => {
    const client = new OpenAIRealtimeClient('test-key', 'test-model', 'gpt-4o-transcribe', 'Follow this prompt');
    const ws = await connectClient(client, 'single');

    const sessionUpdate = firstMessageByType(ws, 'session.update');
    expect(sessionUpdate).toBeDefined();

    const session = (sessionUpdate!.session || {}) as Record<string, unknown>;
    expect(session.instructions).toBe('Follow this prompt');
    expect(session.input_audio_transcription).toEqual({ model: 'gpt-4o-transcribe' });
    expect(session.turn_detection).toBeNull();
  });

  it('uses instructions for single mode and input_audio_transcription for meeting mode', async () => {
    const client = new OpenAIRealtimeClient('test-key', 'test-model', 'gpt-4o-transcribe', {
      single: 'Single dictation prompt',
    });

    const singleWs = await connectClient(client, 'single');
    const singleSessionUpdate = firstMessageByType(singleWs, 'session.update');
    expect(singleSessionUpdate).toBeDefined();
    const singleSession = (singleSessionUpdate!.session || {}) as Record<string, unknown>;
    expect(singleSession.instructions).toBe('Single dictation prompt');
    expect(singleSession.input_audio_transcription).toEqual({ model: 'gpt-4o-transcribe' });

    await client.disconnect();

    // Meeting mode: no instructions → falls back to input_audio_transcription
    const meetingWs = await connectClient(client, 'meeting');
    const meetingSessionUpdate = firstMessageByType(meetingWs, 'session.update');
    expect(meetingSessionUpdate).toBeDefined();
    const meetingSession = (meetingSessionUpdate!.session || {}) as Record<string, unknown>;
    expect(meetingSession.instructions).toBeUndefined();
    expect(meetingSession.input_audio_transcription).toEqual({ model: 'gpt-4o-transcribe' });
  });

  it('uses input_audio_transcription when instructions are not provided', async () => {
    const client = new OpenAIRealtimeClient('test-key');
    const ws = await connectClient(client, 'single');

    const sessionUpdate = firstMessageByType(ws, 'session.update');
    expect(sessionUpdate).toBeDefined();

    const session = (sessionUpdate!.session || {}) as Record<string, unknown>;
    expect(session.instructions).toBeUndefined();
    expect(session.input_audio_transcription).toEqual({ model: 'gpt-4o-transcribe' });
    expect(session.turn_detection).toBeNull();
  });

  it('applies tuned server_vad settings in meeting mode', async () => {
    const client = new OpenAIRealtimeClient('test-key', 'test-model', 'gpt-4o-transcribe', 'prompt');
    const ws = await connectClient(client, 'meeting');

    const sessionUpdate = firstMessageByType(ws, 'session.update');
    expect(sessionUpdate).toBeDefined();

    const session = (sessionUpdate!.session || {}) as Record<string, unknown>;
    expect(session.turn_detection).toEqual({
      type: 'server_vad',
      silence_duration_ms: 700,
      prefix_padding_ms: 500,
    });
  });

  it('sends response.create after commitAudio in single mode when instructions are set', async () => {
    const client = new OpenAIRealtimeClient('test-key', 'test-model', 'gpt-4o-transcribe', 'prompt');
    const ws = await connectClient(client, 'single');

    await client.commitAudio();

    const types = typedMessages(ws);
    expect(types).toContain('input_audio_buffer.commit');
    expect(types).toContain('response.create');
    expect(types.indexOf('input_audio_buffer.commit')).toBeLessThan(types.indexOf('response.create'));
  });

  it('does not send response.create after commitAudio when instructions are not set', async () => {
    const client = new OpenAIRealtimeClient('test-key');
    const ws = await connectClient(client, 'single');

    await client.commitAudio();

    const types = typedMessages(ws);
    expect(types).toContain('input_audio_buffer.commit');
    expect(types).not.toContain('response.create');
  });

  it('keeps send queue alive after a websocket send error', async () => {
    const client = new OpenAIRealtimeClient('test-key', 'test-model', 'gpt-4o-transcribe', 'prompt');
    const ws = await connectClient(client, 'single');

    ws.failNextSend = true;
    await expect(client.sendAudio(Buffer.from([1, 2, 3]))).resolves.toBeUndefined();
    await expect(client.sendAudio(Buffer.from([4, 5, 6]))).resolves.toBeUndefined();

    const appendMessages = parseMessages(ws).filter((msg) => msg.type === 'input_audio_buffer.append');
    expect(appendMessages).toHaveLength(2);
  });

  it('stopMeeting skips commitAudio and waits for trailing segments', async () => {
    const client = new OpenAIRealtimeClient('test-key');
    const waitSpy = vi
      .spyOn(client as unknown as { waitForMeetingSegments: (timeout: number) => Promise<void> }, 'waitForMeetingSegments')
      .mockResolvedValue(undefined);
    vi.spyOn(client, 'disconnect').mockResolvedValue(undefined);

    const ws = await connectClient(client, 'meeting');

    await client.stopMeeting();
    expect(waitSpy).toHaveBeenCalledWith(5000);

    // No input_audio_buffer.commit should be sent by stopMeeting
    const types = typedMessages(ws);
    expect(types).not.toContain('input_audio_buffer.commit');
  });

  it('stopMeeting flushes queued audio before starting segment wait', async () => {
    const client = new OpenAIRealtimeClient('test-key');
    const callOrder: string[] = [];

    vi.spyOn(
      client as unknown as { waitForMeetingSegments: (timeout: number) => Promise<void> },
      'waitForMeetingSegments',
    ).mockImplementation(async () => {
      callOrder.push('waitForMeetingSegments');
    });
    vi.spyOn(client, 'disconnect').mockResolvedValue(undefined);

    const ws = await connectClient(client, 'meeting');

    // Simulate a slow send that resolves after a tick
    const originalSend = ws.send.bind(ws);
    ws.send = (payload: string, cb?: (err?: Error) => void) => {
      setTimeout(() => {
        callOrder.push('send');
        originalSend(payload, cb);
      }, 10);
    };

    // Queue audio (fire-and-forget, like main.ts does)
    void client.sendAudio(Buffer.from([1, 2, 3]));

    await client.stopMeeting();

    // send must resolve before waitForMeetingSegments starts
    expect(callOrder.indexOf('send')).toBeLessThan(callOrder.indexOf('waitForMeetingSegments'));
  });

  it('suppresses "buffer too small" errors in meeting mode', async () => {
    const client = new OpenAIRealtimeClient('test-key');
    const ws = await connectClient(client, 'meeting');

    const errorHandler = vi.fn();
    client.on('error', errorHandler);

    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'error', error: { message: 'audio buffer too small' } })),
    );

    expect(errorHandler).not.toHaveBeenCalled();
  });

  it('surfaces non-buffer errors in meeting mode', async () => {
    const client = new OpenAIRealtimeClient('test-key');
    const ws = await connectClient(client, 'meeting');

    const errorHandler = vi.fn();
    client.on('error', errorHandler);

    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'error', error: { message: 'rate limit exceeded' } })),
    );

    expect(errorHandler).toHaveBeenCalledWith('rate limit exceeded');
  });

  it('ignores response text delta events in meeting mode', async () => {
    const client = new OpenAIRealtimeClient('test-key');
    const ws = await connectClient(client, 'meeting');
    const textHandler = vi.fn();

    client.on('text', textHandler);

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'response.text.delta', delta: 'assistant text' })));

    expect(textHandler).not.toHaveBeenCalled();
  });

  it('ignores response done events in meeting mode', async () => {
    const client = new OpenAIRealtimeClient('test-key');
    const ws = await connectClient(client, 'meeting');
    const segmentHandler = vi.fn();

    client.on('segment', segmentHandler);
    (client as unknown as { currentResponseText: string }).currentResponseText = 'assistant final';

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'response.done' })));

    expect(segmentHandler).not.toHaveBeenCalled();
    expect(client.getMeetingSegments()).toEqual([]);
  });

  it('still emits input audio transcription completed segments in meeting mode', async () => {
    const client = new OpenAIRealtimeClient('test-key');
    const ws = await connectClient(client, 'meeting');
    const segmentHandler = vi.fn();

    client.on('segment', segmentHandler);

    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          transcript: 'actual spoken transcript',
        }),
      ),
    );

    expect(segmentHandler).toHaveBeenCalledTimes(1);
    expect(client.getMeetingSegments()).toEqual(['actual spoken transcript']);
  });

  it('ignores response events in single mode when instructions are not set', async () => {
    const client = new OpenAIRealtimeClient('test-key');
    const ws = await connectClient(client, 'single');
    const textHandler = vi.fn();

    client.on('text', textHandler);

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'response.text.delta', delta: 'hello' })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'response.done' })));

    expect(textHandler).not.toHaveBeenCalled();
  });

  it('buffers unmarked response text until done in single mode when instructions are set', async () => {
    const client = new OpenAIRealtimeClient('test-key', 'test-model', 'gpt-4o-transcribe', 'prompt');
    const ws = await connectClient(client, 'single');
    const textHandler = vi.fn();

    client.on('text', textHandler);

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'response.text.delta', delta: 'hello' })));
    expect(textHandler).not.toHaveBeenCalled();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'response.done' })));

    expect(textHandler).toHaveBeenCalledTimes(1);
    expect(textHandler).toHaveBeenNthCalledWith(1, { content: 'hello', isNewResponse: true });
  });

  // Guard: LIVE_TRANSCRIPTION_PROMPT must always be sent for both single and meeting modes.
  it('LIVE_TRANSCRIPTION_PROMPT is sent as instructions in single mode', async () => {
    const client = new OpenAIRealtimeClient('test-key', undefined, undefined, {
      single: LIVE_TRANSCRIPTION_PROMPT,
    });
    const ws = await connectClient(client, 'single');

    const sessionUpdate = firstMessageByType(ws, 'session.update');
    expect(sessionUpdate).toBeDefined();

    const session = (sessionUpdate!.session || {}) as Record<string, unknown>;
    expect(session.instructions).toBe(LIVE_TRANSCRIPTION_PROMPT);
    expect(session.input_audio_transcription).toEqual({ model: 'gpt-4o-transcribe' });
  });

  it('LIVE_TRANSCRIPTION_PROMPT is sent in meeting mode when provided', async () => {
    const client = new OpenAIRealtimeClient('test-key', undefined, undefined, {
      single: LIVE_TRANSCRIPTION_PROMPT,
      meeting: LIVE_TRANSCRIPTION_PROMPT,
    });
    const ws = await connectClient(client, 'meeting');

    const sessionUpdate = firstMessageByType(ws, 'session.update');
    expect(sessionUpdate).toBeDefined();

    const session = (sessionUpdate!.session || {}) as Record<string, unknown>;
    expect(session.instructions).toBe(LIVE_TRANSCRIPTION_PROMPT);
    expect(session.input_audio_transcription).toEqual({ model: 'gpt-4o-transcribe' });
  });

  it('passes language to session config with LIVE_TRANSCRIPTION_PROMPT', async () => {
    const client = new OpenAIRealtimeClient('test-key', undefined, undefined, {
      single: LIVE_TRANSCRIPTION_PROMPT,
    }, 'ja');
    const ws = await connectClient(client, 'single');

    const sessionUpdate = firstMessageByType(ws, 'session.update');
    const session = (sessionUpdate!.session || {}) as Record<string, unknown>;
    expect(session.instructions).toBe(LIVE_TRANSCRIPTION_PROMPT);
    expect(session.input_audio_transcription).toEqual({ model: 'gpt-4o-transcribe', language: 'ja' });
  });

  it('strips brainwave marker prefix from response output', async () => {
    const client = new OpenAIRealtimeClient('test-key', 'test-model', 'gpt-4o-transcribe', 'prompt');
    const ws = await connectClient(client, 'single');
    const textHandler = vi.fn();

    client.on('text', textHandler);

    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'response.text.delta',
          delta: '下面是不改变语言的语音识别结果：\n\nhello world',
        }),
      ),
    );
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'response.done' })));

    expect(textHandler).toHaveBeenNthCalledWith(1, { content: 'hello world', isNewResponse: false });
    expect(textHandler).toHaveBeenNthCalledWith(2, { content: 'hello world', isNewResponse: true });
  });

  it('falls back to ASR transcript when unmarked response looks conversational', async () => {
    const client = new OpenAIRealtimeClient('test-key', 'test-model', 'gpt-4o-transcribe', 'prompt');
    const ws = await connectClient(client, 'single');
    const textHandler = vi.fn();

    client.on('text', textHandler);

    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          transcript: 'book a meeting tomorrow at 3 PM',
        }),
      ),
    );
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'response.text.delta',
          delta: "I'm sorry, but I can only transcribe spoken words. Please provide the speech you want transcribed.",
        }),
      ),
    );
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'response.done' })));

    expect(textHandler).toHaveBeenCalledTimes(1);
    expect(textHandler).toHaveBeenNthCalledWith(1, {
      content: 'book a meeting tomorrow at 3 PM',
      isNewResponse: true,
    });
  });
});
