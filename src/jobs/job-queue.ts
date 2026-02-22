import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../backend/config-manager';
import { GeminiTranscriber } from '../backend/gemini-transcriber';
import { ConsensusTranscriber } from '../backend/consensus-transcriber';
import { JobStore } from './job-store';
import { JobRecord, TranscriptionResult, MeetingNotes, DiarizationStatus, SpeechSegment } from './types';
import { cleanText, buildTitle, buildSummary, buildSegments, formatTranscriptionMarkdownExport } from './text-utils';

export class TranscriptionJobQueue {
  private queue: string[] = [];
  private processing = false;
  private diarizationQueue: string[] = [];
  private diarizationProcessing = false;
  private workerTimer: NodeJS.Timeout | null = null;
  private config: ConfigManager;
  private store: JobStore;
  private transcriber: GeminiTranscriber;
  private consensusTranscriber: ConsensusTranscriber | null = null;

  constructor(config: ConfigManager, transcriber?: GeminiTranscriber, consensusTranscriber?: ConsensusTranscriber) {
    this.config = config;
    this.store = new JobStore(config);
    this.transcriber = transcriber ?? new GeminiTranscriber(config);
    this.consensusTranscriber = consensusTranscriber ?? null;
  }

  start(): void {
    this.requeuePendingJobs();
    if (!this.workerTimer) {
      this.workerTimer = setInterval(() => {
        void this.processNext();
        void this.processNextDiarization();
      }, 750);
    }
  }

  stop(): void {
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }
  }

  async enqueueFromPath(filePath: string, originalName?: string): Promise<JobRecord> {
    const incomingPath = await this.store.copyToIncoming(filePath, originalName);
    return this.enqueueIncoming(incomingPath, 'gemini');
  }

  async enqueueFromBytes(bytes: Buffer, originalName: string): Promise<JobRecord> {
    const incomingPath = await this.store.writeIncoming(bytes, originalName);
    return this.enqueueIncoming(incomingPath, 'gemini');
  }

  createTextJob(
    text: string,
    provider: string = 'openai',
    title?: string,
    summary?: string,
    audioBytes?: Buffer,
    duration?: string,
    meetingNotes?: MeetingNotes,
    diarizationStatus?: DiarizationStatus,
    isMeeting?: boolean,
  ): { job: JobRecord; result: TranscriptionResult } {
    const cleaned = cleanText(text);
    if (!cleaned) {
      throw new Error('Transcription text is empty');
    }

    const now = new Date();
    const jobId = this.store.formatJobId(now);
    const jobDir = this.store.jobDir(jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    const result: TranscriptionResult = {
      title: buildTitle(cleaned, title),
      summary: buildSummary(cleaned, summary),
      speech_segments: buildSegments(cleaned),
      is_meeting: isMeeting || undefined,
      meeting_notes: meetingNotes,
      diarization_status: diarizationStatus,
    };

    const resultPath = this.store.transcriptionPath(jobId);
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf-8');

    // Write audio file if provided
    let audioPath: string | undefined;
    if (audioBytes && audioBytes.length > 0) {
      audioPath = path.join(jobDir, 'recording.webm');
      fs.writeFileSync(audioPath, audioBytes);
    }

    const record: JobRecord = {
      id: jobId,
      status: 'completed',
      diarization_status: diarizationStatus,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      provider,
      audio_path: audioPath,
      result_path: resultPath,
      title: result.title,
      summary: result.summary,
      duration,
      is_meeting: isMeeting || undefined,
    };
    this.store.writeJob(record);

    return { job: record, result };
  }

  createAudioOnlyJob(provider: string = 'openai', audioBytes: Buffer, duration?: string): JobRecord {
    if (!audioBytes || audioBytes.length === 0) {
      throw new Error('Audio payload is empty');
    }

    const now = new Date();
    const jobId = this.store.formatJobId(now);
    const jobDir = this.store.jobDir(jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    const audioPath = path.join(jobDir, 'recording.webm');
    fs.writeFileSync(audioPath, audioBytes);

    const record: JobRecord = {
      id: jobId,
      status: 'failed',
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      provider: String(provider || 'openai'),
      audio_path: audioPath,
      duration,
      error: 'Transcription in progress',
    };
    this.store.writeJob(record);
    return record;
  }

  completeAudioOnlyJob(
    jobId: string,
    text: string,
    title?: string,
    summary?: string,
    meetingNotes?: MeetingNotes,
    diarizationStatus?: DiarizationStatus,
    isMeeting?: boolean,
  ): { job: JobRecord; result: TranscriptionResult } {
    this.store.validateJobId(jobId);
    const record = this.store.readJob(jobId);
    if (!record) {
      throw new Error('Job not found');
    }

    const cleaned = cleanText(text);
    if (!cleaned) {
      throw new Error('Transcription text is empty');
    }

    const result: TranscriptionResult = {
      title: buildTitle(cleaned, title),
      summary: buildSummary(cleaned, summary),
      speech_segments: buildSegments(cleaned),
      is_meeting: isMeeting || undefined,
      meeting_notes: meetingNotes,
      diarization_status: diarizationStatus,
    };

    const resultPath = this.store.transcriptionPath(jobId);
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf-8');

    const updated: JobRecord = {
      ...record,
      status: 'completed',
      diarization_status: diarizationStatus,
      updated_at: new Date().toISOString(),
      result_path: resultPath,
      title: result.title,
      summary: result.summary,
      error: undefined,
      is_meeting: isMeeting || record.is_meeting || undefined,
    };
    this.store.writeJob(updated);

    return { job: updated, result };
  }

  getJob(jobId: string): JobRecord | null {
    return this.store.readJob(jobId);
  }

  listJobs(): JobRecord[] {
    const jobs = this.store.listJobRecords();
    return jobs;
  }

  readJobResult(jobId: string): TranscriptionResult | null {
    const resultPath = this.store.transcriptionPath(jobId);
    if (!fs.existsSync(resultPath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(resultPath, 'utf-8');
      return JSON.parse(raw) as TranscriptionResult;
    } catch (err) {
      console.warn(`Failed to read transcription result for ${jobId}:`, err);
      return null;
    }
  }

  deleteJob(jobId: string): boolean {
    this.store.validateJobId(jobId);
    const record = this.store.readJob(jobId);
    if (!record) {
      return false;
    }
    if (record.status === 'pending' || record.status === 'processing') {
      throw new Error('Cannot delete a job that is pending or processing');
    }
    // Remove from in-memory queue if present
    const queueIndex = this.queue.indexOf(jobId);
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1);
    }
    // Delete the job directory on disk
    const jobDir = this.store.jobDir(jobId);
    if (fs.existsSync(jobDir)) {
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
    return true;
  }

  retranscribeJob(jobId: string): JobRecord {
    this.store.validateJobId(jobId);
    const record = this.store.readJob(jobId);
    if (!record) {
      throw new Error('Job not found');
    }
    if (record.status === 'pending' || record.status === 'processing') {
      throw new Error('Cannot re-transcribe a job that is pending or processing');
    }
    if (!record.audio_path) {
      throw new Error('Job does not have an audio file');
    }

    const recordingsResolved = path.resolve(this.store.recordingsDir());
    const resolvedAudio = path.resolve(recordingsResolved, record.audio_path);
    if (resolvedAudio === recordingsResolved || !resolvedAudio.startsWith(recordingsResolved + path.sep)) {
      throw new Error('Invalid audio file path');
    }
    if (!fs.existsSync(resolvedAudio)) {
      throw new Error('Audio file not found');
    }
    const audioStat = fs.statSync(resolvedAudio);
    if (!audioStat.isFile()) {
      throw new Error('Audio path is not a file');
    }

    // Preserve is_meeting from result before deleting (migration for old records)
    if (!record.is_meeting) {
      const existingResult = this.readJobResult(jobId);
      if (existingResult?.is_meeting) {
        record.is_meeting = true;
      }
    }

    const transcriptionPath = this.store.transcriptionPath(jobId);
    if (fs.existsSync(transcriptionPath)) {
      fs.unlinkSync(transcriptionPath);
    }
    const summaryPath = path.join(this.store.jobDir(jobId), 'summary.txt');
    if (fs.existsSync(summaryPath)) {
      fs.unlinkSync(summaryPath);
    }

    record.status = 'pending';
    record.error = undefined;
    record.result_path = undefined;
    record.is_retranscription = true;
    record.updated_at = new Date().toISOString();
    this.store.writeJob(record);

    if (!this.queue.includes(jobId)) {
      this.queue.push(jobId);
    }

    return record;
  }

  getJobExportData(jobId: string): { title: string; markdown: string; filename: string } | null {
    this.store.validateJobId(jobId);
    const record = this.store.readJob(jobId);
    if (!record) {
      return null;
    }
    const result = this.readJobResult(jobId);
    const title = record.title || result?.title || 'Untitled Transcription';
    const summary = record.summary || result?.summary || '';

    let transcript = '';
    if (result?.readability?.text) {
      transcript = result.readability.text;
    } else if (result?.speech_segments) {
      transcript = result.speech_segments.map((seg) => seg.content).join('\n\n');
    }

    const markdown = formatTranscriptionMarkdownExport({
      title,
      summary,
      transcript,
      createdAt: record.created_at,
    });

    const safeTitle = title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    const filename = `${safeTitle}_${jobId}.md`;

    return { title, markdown, filename };
  }

  updateReadability(jobId: string, text: string): { text: string; updated_at: string } {
    const resultPath = this.store.transcriptionPath(jobId);
    if (!fs.existsSync(resultPath)) {
      throw new Error('Transcription result not found');
    }
    const raw = fs.readFileSync(resultPath, 'utf-8');
    const data = JSON.parse(raw) as TranscriptionResult;
    const readability = {
      text,
      updated_at: new Date().toISOString(),
    };
    data.readability = readability;
    fs.writeFileSync(resultPath, JSON.stringify(data, null, 2), 'utf-8');
    return readability;
  }

  updateMeetingNotes(jobId: string, notes: MeetingNotes): { meeting_notes: MeetingNotes; updated_at: string } {
    const resultPath = this.store.transcriptionPath(jobId);
    if (!fs.existsSync(resultPath)) {
      throw new Error('Transcription result not found');
    }

    const raw = fs.readFileSync(resultPath, 'utf-8');
    const data = JSON.parse(raw) as TranscriptionResult;
    const updatedAt = new Date().toISOString();

    data.meeting_notes = notes;
    if (notes.summary && String(notes.summary).trim()) {
      data.summary = notes.summary.trim();
    }
    fs.writeFileSync(resultPath, JSON.stringify(data, null, 2), 'utf-8');

    const record = this.store.readJob(jobId);
    if (record) {
      if (notes.summary && String(notes.summary).trim()) {
        record.summary = notes.summary.trim();
      }
      record.updated_at = updatedAt;
      this.store.writeJob(record);
    }

    return {
      meeting_notes: notes,
      updated_at: updatedAt,
    };
  }

  updateActionItemCompletion(jobId: string, completedItems: number[]): { completedItems: number[]; updated_at: string } {
    this.store.validateJobId(jobId);
    const resultPath = this.store.transcriptionPath(jobId);
    if (!fs.existsSync(resultPath)) {
      throw new Error('Transcription result not found');
    }

    const raw = fs.readFileSync(resultPath, 'utf-8');
    const data = JSON.parse(raw) as TranscriptionResult;
    if (!data.meeting_notes) {
      throw new Error('No meeting notes on this job');
    }

    const updatedAt = new Date().toISOString();
    data.meeting_notes._completedItems = completedItems;
    fs.writeFileSync(resultPath, JSON.stringify(data, null, 2), 'utf-8');

    return { completedItems, updated_at: updatedAt };
  }

  enqueueDiarization(jobId: string): boolean {
    const record = this.store.readJob(jobId);
    if (!record || !record.audio_path) {
      return false;
    }
    if (record.status !== 'completed') {
      return false;
    }
    if (record.diarization_status === 'completed' || record.diarization_status === 'processing') {
      return false;
    }

    record.diarization_status = 'pending';
    record.updated_at = new Date().toISOString();
    this.store.writeJob(record);

    if (!this.diarizationQueue.includes(jobId)) {
      this.diarizationQueue.push(jobId);
    }
    return true;
  }

  private async enqueueIncoming(filePath: string, provider: string): Promise<JobRecord> {
    const now = new Date();
    const jobId = this.store.formatJobId(now);
    const jobDir = this.store.jobDir(jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    const destAudio = path.join(jobDir, path.basename(filePath));
    await this.store.moveFile(filePath, destAudio);

    const record: JobRecord = {
      id: jobId,
      status: 'pending',
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      provider,
      audio_path: destAudio,
    };
    this.store.writeJob(record);
    this.queue.push(jobId);
    return record;
  }

  private requeuePendingJobs(): void {
    for (const job of this.store.listJobRecords()) {
      if (job.status === 'pending' || job.status === 'processing') {
        this.queue.push(job.id);
      }
      if (job.status === 'completed' && (job.diarization_status === 'pending' || job.diarization_status === 'processing')) {
        this.diarizationQueue.push(job.id);
      }
    }
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }
    const jobId = this.queue.shift();
    if (!jobId) {
      return;
    }
    this.processing = true;
    try {
      await this.processJob(jobId);
    } finally {
      this.processing = false;
    }
  }

  private async processJob(jobId: string): Promise<void> {
    const record = this.store.readJob(jobId);
    if (!record || !record.audio_path) {
      return;
    }

    record.status = 'processing';
    record.updated_at = new Date().toISOString();
    this.store.writeJob(record);

    try {
      const settings = this.config.getSettings();
      let result: TranscriptionResult;

      if (settings.consensusEnabled && this.consensusTranscriber) {
        console.log(`[JobQueue] Using consensus transcription for job ${jobId}`);
        result = await this.consensusTranscriber.transcribeAudio(record.audio_path);
        record.provider = 'consensus';
      } else {
        result = await this.transcriber.transcribeAudio(record.audio_path);
      }

      // Restore is_meeting from job record (preserved through retranscription)
      if (record.is_meeting && !result.is_meeting) {
        result.is_meeting = true;
      }

      const jobDir = this.store.jobDir(jobId);
      const resultPath = this.store.transcriptionPath(jobId);
      fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf-8');

      const summaryPath = path.join(jobDir, 'summary.txt');
      fs.writeFileSync(summaryPath, `Title: ${result.title}\n\nSummary:\n${result.summary}`, 'utf-8');

      if (this.config.getSettings().autoPolish) {
        try {
          const settings = this.config.getSettings();
          const rawText = result.speech_segments.map((seg) => seg.content).join('\n');
          const polished = await this.transcriber.polishText(rawText, settings.polishStyle, settings.customPolishPrompt);
          result.readability = {
            text: polished,
            updated_at: new Date().toISOString(),
          };
          fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf-8');
        } catch (err) {
          console.warn(`Auto-polish failed for job ${jobId}:`, err);
        }
      }

      record.status = 'completed';
      record.title = result.title;
      record.summary = result.summary;
      record.result_path = resultPath;
      record.is_retranscription = undefined;
      record.updated_at = new Date().toISOString();
      this.store.writeJob(record);
    } catch (err) {
      record.status = 'failed';
      record.error = err instanceof Error ? err.message : String(err);
      record.updated_at = new Date().toISOString();
      this.store.writeJob(record);
    }
  }

  private async processNextDiarization(): Promise<void> {
    if (this.diarizationProcessing || this.diarizationQueue.length === 0) {
      return;
    }

    const jobId = this.diarizationQueue.shift();
    if (!jobId) {
      return;
    }

    this.diarizationProcessing = true;
    try {
      await this.processDiarization(jobId);
    } finally {
      this.diarizationProcessing = false;
    }
  }

  private async processDiarization(jobId: string): Promise<void> {
    const record = this.store.readJob(jobId);
    if (!record || record.status !== 'completed' || !record.audio_path) {
      return;
    }

    record.diarization_status = 'processing';
    record.updated_at = new Date().toISOString();
    this.store.writeJob(record);

    try {
      const resultPath = this.store.transcriptionPath(jobId);
      if (!fs.existsSync(resultPath)) {
        throw new Error('Transcription result not found');
      }

      const diarized = await this.transcriber.transcribeAudio(record.audio_path, undefined, {
        applySmartFormatting: false,
      });

      // Re-read AFTER transcription to preserve any meeting notes written during diarization
      const existingRaw = fs.readFileSync(resultPath, 'utf-8');
      const existing = JSON.parse(existingRaw) as TranscriptionResult;
      existing.speech_segments = this.normalizeSegments(diarized.speech_segments);
      existing.diarization_status = 'completed';
      fs.writeFileSync(resultPath, JSON.stringify(existing, null, 2), 'utf-8');

      record.diarization_status = 'completed';
      record.updated_at = new Date().toISOString();
      this.store.writeJob(record);
    } catch (err) {
      record.diarization_status = 'failed';
      record.error = err instanceof Error ? err.message : String(err);
      record.updated_at = new Date().toISOString();
      this.store.writeJob(record);
    }
  }

  private normalizeSegments(segments: SpeechSegment[]): SpeechSegment[] {
    if (!Array.isArray(segments)) {
      return [];
    }
    return segments.map((segment, index) => ({
      content: String(segment.content || '').trim(),
      start_time: String(segment.start_time || ''),
      end_time: String(segment.end_time || ''),
      speaker: String(segment.speaker || `Speaker ${index + 1}`),
    }));
  }

  // --- Backward-compat delegates (accessed by tests via `(queue as any)`) ---

  private cleanText(text: string): string {
    return cleanText(text);
  }

  private buildTitle(text: string, provided?: string): string {
    return buildTitle(text, provided);
  }

  private buildSummary(text: string, provided?: string): string {
    return buildSummary(text, provided);
  }

  private buildSegments(text: string): TranscriptionResult['speech_segments'] {
    return buildSegments(text);
  }

  private validateJobId(jobId: string): void {
    this.store.validateJobId(jobId);
  }
}
