import { EventEmitter } from 'events';
import WebSocket, { RawData } from 'ws';

type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'processing' | 'reconnecting' | 'completed';
type SessionMode = 'single' | 'meeting';
export type RealtimeInstructions = string | { single?: string; meeting?: string };

export interface RealtimeTextEvent {
  content: string;
  isNewResponse: boolean;
}

export interface RealtimeSegmentEvent {
  segment: string;
  allSegments: string[];
}

export interface RealtimeStructuredEvent {
  result: Record<string, unknown>;
}

const BRAINWAVE_MARKER_PREFIX = 'The following is the speech recognition result in the original language:\n\n';

export class OpenAIRealtimeClient extends EventEmitter {
  private apiKey: string;
  private model: string;
  private transcriptionModel: string;
  private singleModeInstructions?: string;
  private meetingModeInstructions?: string;
  private language?: string;
  private ws: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private pendingAudio: Buffer[] = [];
  private sendQueue: Promise<void> = Promise.resolve();
  private currentResponseText = '';
  private responsePrefixBuffer: string[] = [];
  private markerSeen = false;
  private markerMatched = false;
  private readyResolver: (() => void) | null = null;
  private readyRejecter: ((err: Error) => void) | null = null;
  private readyPromise: Promise<void> | null = null;
  private disconnectPromise: Promise<void> | null = null;
  private sessionMode: SessionMode = 'single';
  private meetingSegments: string[] = [];
  private meetingStopRequested = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 3;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private wasManuallyDisconnected = false;
  private lastSegmentAt = 0;
  private commitAudioAt = 0;

  constructor(
    apiKey: string,
    model: string = 'gpt-realtime-2025-08-28',
    transcriptionModel: string = 'gpt-4o-transcribe',
    instructions?: RealtimeInstructions,
    language?: string,
  ) {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.transcriptionModel = transcriptionModel;
    this.setInstructions(instructions);
    const lang = language?.trim();
    this.language = lang && lang !== 'auto' ? lang : undefined;
  }

  async connect(mode: SessionMode = 'single'): Promise<void> {
    this.sessionMode = mode;
    this.resetSingleResponseState();

    if (this.disconnectPromise) {
      await this.disconnectPromise;
    }

    if (this.ws) {
      return this.readyPromise ?? Promise.resolve();
    }

    this.clearReconnectTimer();
    this.wasManuallyDisconnected = false;

    if (this.closed) {
      this.closed = false;
    }

    this.emitStatus('connecting');

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolver = resolve;
      this.readyRejecter = reject;
    });

    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${this.model}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    this.ws = ws;

    ws.on('message', (data: RawData) => {
      this.handleMessage(data.toString());
    });

    ws.on('close', () => {
      this.handleSocketClose();
    });

    ws.on('error', (err: Error) => {
      if (!this.ready && this.readyRejecter) {
        this.readyRejecter(err instanceof Error ? err : new Error(String(err)));
        this.readyResolver = null;
        this.readyRejecter = null;
        this.readyPromise = null;
      }

      // During long-running meeting mode, transient network blips are recoverable.
      // Reconnection is driven by close events, so avoid emitting a fatal error here.
      if (this.ready && this.isRecoverableMeetingDrop()) {
        this.emitStatus('reconnecting');
        return;
      }
      this.emitError(err instanceof Error ? err.message : String(err));
    });

    return this.readyPromise;
  }

  async startMeeting(): Promise<void> {
    this.sessionMode = 'meeting';
    this.meetingStopRequested = false;
    this.meetingSegments = [];
    this.reconnectAttempts = 0;
    this.lastSegmentAt = 0;
    this.commitAudioAt = 0;
    await this.connect('meeting');
  }

  async stopMeeting(): Promise<string> {
    this.meetingStopRequested = true;

    // Flush any queued audio appends before starting the shutdown timer
    await this.sendQueue;

    await this.commitAudio();

    await this.waitForMeetingSegments(5000);
    const transcript = this.meetingSegments.join('\n').trim();
    this.emitStatus('completed');
    await this.disconnect();
    return transcript;
  }

  getMeetingSegments(): string[] {
    return [...this.meetingSegments];
  }

  async sendAudio(audio: ArrayBuffer | Buffer): Promise<void> {
    const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
    if (!this.ready) {
      this.pendingAudio.push(buffer);
      return;
    }

    await this.enqueueSend(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: buffer.toString('base64'),
      }),
    );
  }

  async commitAudio(): Promise<void> {
    if (!this.ready || !this.ws) {
      return;
    }
    await this.sendQueue;

    // Send ~500ms of trailing silence (PCM16 zeros) before committing.
    // At 24kHz mono PCM16, 500ms = 12000 samples = 24000 bytes.
    // This prevents OpenAI from truncating the final word/syllable when
    // turn_detection is null and audio ends abruptly.
    const silenceBytes = 24000;
    const silence = Buffer.alloc(silenceBytes, 0);
    await this.enqueueSend(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: silence.toString('base64'),
      }),
    );

    this.emitStatus('processing');
    this.commitAudioAt = Date.now();
    await this.enqueueSend(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    if (this.sessionMode === 'single' && this.hasInstructions()) {
      this.resetSingleResponseState();
      await this.enqueueSend(JSON.stringify({ type: 'response.create' }));
    }
  }

  async disconnect(): Promise<void> {
    if (this.disconnectPromise) {
      return this.disconnectPromise;
    }

    this.closed = true;
    this.wasManuallyDisconnected = true;
    this.clearReconnectTimer();

    const ws = this.ws;
    if (!ws) {
      this.ready = false;
      this.ws = null;
      return;
    }

    this.disconnectPromise = new Promise<void>((resolve) => {
      const finalize = () => {
        ws.removeListener('close', handleClose);
        ws.removeListener('error', handleError);
        this.ready = false;
        this.ws = null;
        resolve();
      };
      const handleClose = () => finalize();
      const handleError = () => finalize();
      ws.once('close', handleClose);
      ws.once('error', handleError);

      if (ws.readyState === WebSocket.CLOSED) {
        finalize();
        return;
      }
      try {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        } else {
          ws.close();
        }
      } catch {
        finalize();
      }
    });

    try {
      await this.disconnectPromise;
    } finally {
      this.disconnectPromise = null;
      this.emitStatus('idle');
    }
  }

  private async enqueueSend(payload: string): Promise<void> {
    const enqueue = () =>
      new Promise<void>((resolve) => {
        const socket = this.ws;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          resolve();
          return;
        }
        socket.send(payload, (err?: Error) => {
          if (err) {
            console.warn('[Realtime] WebSocket send error:', err.message);
          }
          // Always resolve to keep the queue healthy after transient failures.
          resolve();
        });
      });

    this.sendQueue = this.sendQueue.then(enqueue, enqueue);
    return this.sendQueue;
  }

  private async handleSessionCreated(): Promise<void> {
    if (!this.ws) {
      return;
    }

    const session: Record<string, unknown> = {
      modalities: ['text'],
      input_audio_format: 'pcm16',
      turn_detection: null,
      input_audio_transcription: {
        model: this.transcriptionModel,
        ...(this.language ? { language: this.language } : {}),
      },
    };

    const activeInstructions = this.getCurrentInstructions();
    if (activeInstructions) {
      session.instructions = activeInstructions;
    }

    await this.enqueueSend(
      JSON.stringify({
        type: 'session.update',
        session,
      }),
    );

    this.ready = true;
    this.reconnectAttempts = 0;
    if (this.readyResolver) {
      this.readyResolver();
    }
    this.readyResolver = null;
    this.readyRejecter = null;
    this.emitStatus('connected');

    if (this.pendingAudio.length > 0) {
      const chunks = [...this.pendingAudio];
      this.pendingAudio = [];
      for (const chunk of chunks) {
        await this.sendAudio(chunk);
      }
    }
  }

  private handleSocketClose(): void {
    const wasReady = this.ready;
    this.ready = false;
    this.ws = null;

    if (!wasReady && this.readyRejecter) {
      this.readyRejecter(new Error('WebSocket closed before ready'));
    }

    this.readyResolver = null;
    this.readyRejecter = null;
    this.readyPromise = null;

    if (this.shouldReconnectForMeeting()) {
      this.scheduleReconnect();
      return;
    }

    if (!this.wasManuallyDisconnected && this.meetingStopRequested) {
      this.emitStatus('completed');
      return;
    }

    this.emitStatus('idle');
  }

  private shouldReconnectForMeeting(): boolean {
    return (
      this.sessionMode === 'meeting' &&
      !this.closed &&
      !this.wasManuallyDisconnected &&
      !this.meetingStopRequested &&
      this.reconnectAttempts < this.maxReconnectAttempts
    );
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectAttempts += 1;
    const delayMs = Math.min(3000, this.reconnectAttempts * 1000);
    this.emitStatus('reconnecting');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect('meeting').catch((err) => {
        this.emitError(err instanceof Error ? err.message : String(err));
      });
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private handleMessage(message: string): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(message) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = String(data.type || '');
    if (type === 'session.created' || type === 'transcription_session.created') {
      void this.handleSessionCreated();
      return;
    }

    if (type === 'response.created') {
      if (this.sessionMode === 'single' && this.hasInstructions()) {
        this.resetSingleResponseState();
      }
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.delta') {
      if (this.sessionMode === 'single' && this.hasInstructions()) {
        return;
      }
      const delta = String((data as { delta?: string }).delta || '');
      if (delta) {
        this.emit('text', { content: delta, isNewResponse: false } as RealtimeTextEvent);
      }
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = String((data as { transcript?: string }).transcript || '').trim();
      if (transcript) {
        if (this.sessionMode === 'meeting') {
          this.appendMeetingSegment(transcript);
        } else if (!this.hasInstructions()) {
          this.emit('text', { content: transcript, isNewResponse: true } as RealtimeTextEvent);
        }
      }

      if (this.sessionMode === 'single') {
        if (this.hasInstructions()) {
          return;
        }
        this.emitStatus('completed');
        void this.disconnect();
      }
      return;
    }

    if (type === 'response.text.delta' || type === 'response.output_text.delta') {
      // In pure transcription mode (no instructions), ignore assistant response events.
      if (this.sessionMode === 'meeting' || !this.hasInstructions()) {
        return;
      }
      const delta = String((data as { delta?: string }).delta || '');
      if (delta) {
        if (this.markerSeen) {
          this.emitResponseDelta(delta);
          return;
        }

        this.responsePrefixBuffer.push(delta);

        const joined = this.responsePrefixBuffer.join('');
        const markerNoTrailingNl = BRAINWAVE_MARKER_PREFIX.replace(/\n+$/, '');

        let markerIndex = joined.indexOf(BRAINWAVE_MARKER_PREFIX);
        let markerLength = BRAINWAVE_MARKER_PREFIX.length;
        if (markerIndex === -1) {
          markerIndex = joined.indexOf(markerNoTrailingNl);
          markerLength = markerNoTrailingNl.length;
        }

        if (markerIndex !== -1) {
          this.markerSeen = true;
          this.markerMatched = true;
          const remaining = joined.slice(markerIndex + markerLength).replace(/^\n+/, '');
          this.responsePrefixBuffer = [];
          if (remaining) {
            this.emitResponseDelta(remaining);
          }
          return;
        }
      }
      return;
    }

    if (type === 'response.done' || type === 'response.text.done' || type === 'response.output_text.done') {
      // In pure transcription mode (no instructions), ignore assistant response events.
      if (this.sessionMode === 'meeting' || !this.hasInstructions()) {
        return;
      }
      this.handleResponseDone();
      return;
    }

    if (type === 'error') {
      const messageText = String((data as { error?: { message?: string } }).error?.message || 'OpenAI error');
      // suppress benign empty-buffer errors in meeting mode
      if (this.sessionMode === 'meeting' && messageText.includes('buffer too small')) {
        return;
      }
      this.emitError(messageText);
    }
  }

  private appendMeetingSegment(segment: string): void {
    const cleaned = segment.trim();
    if (!cleaned) {
      return;
    }

    this.meetingSegments.push(cleaned);
    this.lastSegmentAt = Date.now();
    this.emit('segment', {
      segment: cleaned,
      allSegments: [...this.meetingSegments],
    } as RealtimeSegmentEvent);
  }

  private handleResponseDone(): void {
    if (!this.markerMatched && this.responsePrefixBuffer.length > 0) {
      const flushed = this.stripMarkerPrefix(this.responsePrefixBuffer.join(''));
      this.responsePrefixBuffer = [];
      this.markerSeen = true;
      if (flushed) {
        this.currentResponseText += flushed;
      }
    }

    const raw = (this.currentResponseText || '').trim();
    this.resetSingleResponseState();

    const parsed = this.tryParseStructuredResult(raw);
    if (parsed) {
      this.emit('structured_result', { result: parsed } as RealtimeStructuredEvent);
    }

    let finalText = raw;
    if (parsed && Array.isArray((parsed as { speech_segments?: unknown }).speech_segments)) {
      const segments = (parsed as { speech_segments?: Array<{ content?: string }> }).speech_segments || [];
      finalText = segments.map((seg) => seg.content || '').filter(Boolean).join('\n');
    }

    if (finalText) {
      if (this.sessionMode === 'meeting') {
        this.appendMeetingSegment(finalText);
      } else {
        this.emit('text', { content: finalText, isNewResponse: true } as RealtimeTextEvent);
      }
    }

    if (this.sessionMode === 'single') {
      this.emitStatus('completed');
      void this.disconnect();
    }
  }

  private tryParseStructuredResult(text: string): Record<string, unknown> | null {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }
    const candidate = text.slice(start, end + 1);
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private async waitForMeetingSegments(timeoutMs: number): Promise<void> {
    const start = Date.now();
    // Track segment count at call time to detect if a new segment arrives post-commit
    const segmentCountAtCommit = this.meetingSegments.length;

    while (Date.now() - start < timeoutMs) {
      // No finalized segment yet: keep waiting until timeout.
      if (this.lastSegmentAt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }

      // If commitAudioAt is set, wait until a segment arrives AFTER the commit.
      // This ensures we don't exit early when commitAudio() triggers a trailing transcription.
      if (this.commitAudioAt > 0 && this.lastSegmentAt < this.commitAudioAt) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }

      // Require at least one new segment since commit was issued
      if (this.commitAudioAt > 0 && this.meetingSegments.length === segmentCountAtCommit) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }

      const sinceLastSegment = Date.now() - this.lastSegmentAt;
      // 450ms threshold: Wait long enough for any trailing audio from server VAD to be finalized
      // after commitAudio(), but short enough to avoid noticeable delay. OpenAI typically finalizes
      // segments within 200-400ms of silence detection.
      if (sinceLastSegment >= 450) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private isRecoverableMeetingDrop(): boolean {
    return this.sessionMode === 'meeting' && !this.closed && !this.wasManuallyDisconnected && !this.meetingStopRequested;
  }

  private emitResponseDelta(delta: string): void {
    if (!delta) {
      return;
    }
    this.currentResponseText += delta;
    this.emit('text', { content: delta, isNewResponse: false } as RealtimeTextEvent);
  }

  private stripMarkerPrefix(text: string): string {
    const source = String(text || '');
    if (!source) {
      return '';
    }

    const markerNoTrailingNl = BRAINWAVE_MARKER_PREFIX.replace(/\n+$/, '');
    if (source.startsWith(BRAINWAVE_MARKER_PREFIX)) {
      return source.slice(BRAINWAVE_MARKER_PREFIX.length);
    }
    if (source.startsWith(markerNoTrailingNl)) {
      return source.slice(markerNoTrailingNl.length).replace(/^\n+/, '');
    }

    const markerIndex = source.indexOf(BRAINWAVE_MARKER_PREFIX);
    if (markerIndex !== -1) {
      return source.slice(markerIndex + BRAINWAVE_MARKER_PREFIX.length);
    }

    const markerNoNlIndex = source.indexOf(markerNoTrailingNl);
    if (markerNoNlIndex !== -1) {
      return source.slice(markerNoNlIndex + markerNoTrailingNl.length).replace(/^\n+/, '');
    }

    return source;
  }

  private resetSingleResponseState(): void {
    this.currentResponseText = '';
    this.responsePrefixBuffer = [];
    this.markerSeen = false;
    this.markerMatched = false;
  }

  private hasInstructions(): boolean {
    return Boolean(this.getCurrentInstructions());
  }

  private setInstructions(instructions?: RealtimeInstructions): void {
    if (typeof instructions === 'string') {
      const trimmed = instructions.trim();
      this.singleModeInstructions = trimmed || undefined;
      this.meetingModeInstructions = trimmed || undefined;
      return;
    }

    const single = instructions?.single?.trim() || '';
    const meeting = instructions?.meeting?.trim() || '';
    this.singleModeInstructions = single || undefined;
    this.meetingModeInstructions = meeting || undefined;
  }

  private getCurrentInstructions(): string | undefined {
    if (this.sessionMode === 'meeting') {
      return this.meetingModeInstructions;
    }
    return this.singleModeInstructions;
  }

  private emitStatus(status: RealtimeStatus): void {
    this.emit('status', status);
  }

  private emitError(message: string): void {
    this.emit('error', message);
  }
}
