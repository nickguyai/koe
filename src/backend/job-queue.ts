import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from './config-manager';
import { DiarizationStatus, GeminiTranscriber, MeetingNotes, SpeechSegment, TranscriptionResult } from './gemini-transcriber';
import { ConsensusTranscriber } from './consensus-transcriber';
import { formatMeetingMarkdownExport } from './meeting-notes-generator';

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface JobRecord {
  id: string;
  status: JobStatus;
  diarization_status?: DiarizationStatus;
  created_at: string;
  updated_at: string;
  provider: string;
  audio_path?: string;
  result_path?: string;
  title?: string;
  summary?: string;
  duration?: string;
  error?: string;
}

export class TranscriptionJobQueue {
  private queue: string[] = [];
  private processing = false;
  private diarizationQueue: string[] = [];
  private diarizationProcessing = false;
  private workerTimer: NodeJS.Timeout | null = null;
  private config: ConfigManager;
  private transcriber: GeminiTranscriber;
  private consensusTranscriber: ConsensusTranscriber | null = null;

  constructor(config: ConfigManager, transcriber?: GeminiTranscriber, consensusTranscriber?: ConsensusTranscriber) {
    this.config = config;
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
    const incomingPath = await this.copyToIncoming(filePath, originalName);
    return this.enqueueIncoming(incomingPath, 'gemini');
  }

  async enqueueFromBytes(bytes: Buffer, originalName: string): Promise<JobRecord> {
    const incomingPath = await this.writeIncoming(bytes, originalName);
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
    const cleaned = this.cleanText(text);
    if (!cleaned) {
      throw new Error('Transcription text is empty');
    }

    const now = new Date();
    const jobId = this.formatJobId(now);
    const jobDir = this.jobDir(jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    const result: TranscriptionResult = {
      title: this.buildTitle(cleaned, title),
      summary: this.buildSummary(cleaned, summary),
      speech_segments: this.buildSegments(cleaned),
      is_meeting: isMeeting || undefined,
      meeting_notes: meetingNotes,
      diarization_status: diarizationStatus,
    };

    const resultPath = this.transcriptionPath(jobId);
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
    };
    this.writeJob(record);

    return { job: record, result };
  }

  createAudioOnlyJob(provider: string = 'openai', audioBytes: Buffer, duration?: string): JobRecord {
    if (!audioBytes || audioBytes.length === 0) {
      throw new Error('Audio payload is empty');
    }

    const now = new Date();
    const jobId = this.formatJobId(now);
    const jobDir = this.jobDir(jobId);
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
    this.writeJob(record);
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
    this.validateJobId(jobId);
    const record = this.readJob(jobId);
    if (!record) {
      throw new Error('Job not found');
    }

    const cleaned = this.cleanText(text);
    if (!cleaned) {
      throw new Error('Transcription text is empty');
    }

    const result: TranscriptionResult = {
      title: this.buildTitle(cleaned, title),
      summary: this.buildSummary(cleaned, summary),
      speech_segments: this.buildSegments(cleaned),
      is_meeting: isMeeting || undefined,
      meeting_notes: meetingNotes,
      diarization_status: diarizationStatus,
    };

    const resultPath = this.transcriptionPath(jobId);
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
    };
    this.writeJob(updated);

    return { job: updated, result };
  }

  getJob(jobId: string): JobRecord | null {
    return this.readJob(jobId);
  }

  listJobs(): JobRecord[] {
    const jobs = this.listJobRecords();
    return jobs;
  }

  readJobResult(jobId: string): TranscriptionResult | null {
    const resultPath = this.transcriptionPath(jobId);
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

  private validateJobId(jobId: string): void {
    // JobId format: YYYY-MM-DD_HH-MM-SS_XXXX (alphanumeric with dashes/underscores only)
    if (!/^[\w-]+$/.test(jobId) || jobId.includes('..')) {
      throw new Error('Invalid job ID format');
    }
    // Defense-in-depth: verify resolved path stays within recordingsDir
    const resolved = path.resolve(this.jobDir(jobId));
    const recordingsResolved = path.resolve(this.recordingsDir());
    if (!resolved.startsWith(recordingsResolved + path.sep)) {
      throw new Error('Invalid job ID');
    }
  }

  deleteJob(jobId: string): boolean {
    this.validateJobId(jobId);
    const record = this.readJob(jobId);
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
    const jobDir = this.jobDir(jobId);
    if (fs.existsSync(jobDir)) {
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
    return true;
  }

  retranscribeJob(jobId: string): JobRecord {
    this.validateJobId(jobId);
    const record = this.readJob(jobId);
    if (!record) {
      throw new Error('Job not found');
    }
    if (record.status === 'pending' || record.status === 'processing') {
      throw new Error('Cannot re-transcribe a job that is pending or processing');
    }
    if (!record.audio_path) {
      throw new Error('Job does not have an audio file');
    }

    const recordingsResolved = path.resolve(this.recordingsDir());
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

    const transcriptionPath = this.transcriptionPath(jobId);
    if (fs.existsSync(transcriptionPath)) {
      fs.unlinkSync(transcriptionPath);
    }
    const summaryPath = path.join(this.jobDir(jobId), 'summary.txt');
    if (fs.existsSync(summaryPath)) {
      fs.unlinkSync(summaryPath);
    }

    record.status = 'pending';
    record.error = undefined;
    record.result_path = undefined;
    record.updated_at = new Date().toISOString();
    this.writeJob(record);

    if (!this.queue.includes(jobId)) {
      this.queue.push(jobId);
    }

    return record;
  }

  getJobExportData(jobId: string): { title: string; markdown: string; filename: string } | null {
    this.validateJobId(jobId);
    const record = this.readJob(jobId);
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

    const markdown = formatMeetingMarkdownExport({
      title,
      summary,
      transcript,
      meetingNotes: result?.meeting_notes || null,
      createdAt: record.created_at,
    });

    const safeTitle = title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    const filename = `${safeTitle}_${jobId}.md`;

    return { title, markdown, filename };
  }

  updateReadability(jobId: string, text: string): { text: string; updated_at: string } {
    const resultPath = this.transcriptionPath(jobId);
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
    const resultPath = this.transcriptionPath(jobId);
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

    const record = this.readJob(jobId);
    if (record) {
      if (notes.summary && String(notes.summary).trim()) {
        record.summary = notes.summary.trim();
      }
      record.updated_at = updatedAt;
      this.writeJob(record);
    }

    return {
      meeting_notes: notes,
      updated_at: updatedAt,
    };
  }

  enqueueDiarization(jobId: string): boolean {
    const record = this.readJob(jobId);
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
    this.writeJob(record);

    if (!this.diarizationQueue.includes(jobId)) {
      this.diarizationQueue.push(jobId);
    }
    return true;
  }

  private recordingsDir(): string {
    return this.config.getRecordingsDir();
  }

  private incomingDir(): string {
    const dir = path.join(this.recordingsDir(), '_incoming');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private jobDir(jobId: string): string {
    return path.join(this.recordingsDir(), jobId);
  }

  private jobMetaPath(jobId: string): string {
    return path.join(this.jobDir(jobId), 'job.json');
  }

  private transcriptionPath(jobId: string): string {
    return path.join(this.jobDir(jobId), 'transcription.json');
  }

  private listJobRecords(): JobRecord[] {
    const base = this.recordingsDir();
    if (!fs.existsSync(base)) {
      return [];
    }
    const entries = fs.readdirSync(base, { withFileTypes: true });
    const dirs = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
      .map((entry) => entry.name)
      .sort((a, b) => (a > b ? -1 : 1));

    const records: JobRecord[] = [];
    for (const dir of dirs) {
      const record = this.readJob(dir);
      if (record) {
        records.push(record);
      }
    }
    return records;
  }

  private readJob(jobId: string): JobRecord | null {
    const metaPath = this.jobMetaPath(jobId);
    if (!fs.existsSync(metaPath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(metaPath, 'utf-8');
      const data = JSON.parse(raw) as JobRecord;
      if (data.status === 'pending' || data.status === 'processing' || data.status === 'completed' || data.status === 'failed') {
        return data;
      }
      return { ...data, status: 'pending' };
    } catch (err) {
      console.warn(`Failed to read job metadata for ${jobId}:`, err);
      return null;
    }
  }

  private writeJob(record: JobRecord): void {
    const dir = this.jobDir(record.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.jobMetaPath(record.id), JSON.stringify(record, null, 2), 'utf-8');
  }

  private async copyToIncoming(filePath: string, originalName?: string): Promise<string> {
    const ext = path.extname(originalName || filePath) || '.wav';
    const filename = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`;
    const dest = path.join(this.incomingDir(), filename);
    await fs.promises.copyFile(filePath, dest);
    return dest;
  }

  private async writeIncoming(bytes: Buffer, originalName: string): Promise<string> {
    const ext = path.extname(originalName) || '.wav';
    const filename = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`;
    const dest = path.join(this.incomingDir(), filename);
    await fs.promises.writeFile(dest, bytes);
    return dest;
  }

  private async enqueueIncoming(filePath: string, provider: string): Promise<JobRecord> {
    const now = new Date();
    const jobId = this.formatJobId(now);
    const jobDir = this.jobDir(jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    const destAudio = path.join(jobDir, path.basename(filePath));
    await this.moveFile(filePath, destAudio);

    const record: JobRecord = {
      id: jobId,
      status: 'pending',
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      provider,
      audio_path: destAudio,
    };
    this.writeJob(record);
    this.queue.push(jobId);
    return record;
  }

  private formatJobId(date: Date): string {
    const pad = (value: number) => value.toString().padStart(2, '0');
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(
      date.getMinutes(),
    )}-${pad(date.getSeconds())}`;
    return `${stamp}_${Math.random().toString(36).slice(2, 6)}`;
  }

  private async moveFile(source: string, dest: string): Promise<void> {
    try {
      await fs.promises.rename(source, dest);
    } catch {
      await fs.promises.copyFile(source, dest);
      await fs.promises.unlink(source);
    }
  }

  private cleanText(text: string): string {
    return String(text || '').replace(/\r\n/g, '\n').trim();
  }

  private buildTitle(text: string, provided?: string): string {
    const explicit = String(provided || '').trim();
    if (explicit) {
      return explicit;
    }
    const oneLine = text.replace(/\s+/g, ' ').trim();
    if (!oneLine) {
      return 'Live transcription';
    }
    const words = oneLine.split(' ').slice(0, 6).join(' ');
    return words || 'Live transcription';
  }

  private buildSummary(text: string, provided?: string): string {
    const explicit = String(provided || '').trim();
    if (explicit) {
      return explicit;
    }
    const oneLine = text.replace(/\s+/g, ' ').trim();
    if (!oneLine) {
      return 'No summary available';
    }
    if (oneLine.length <= 200) {
      return oneLine;
    }
    return `${oneLine.slice(0, 197)}...`;
  }

  private buildSegments(text: string): TranscriptionResult['speech_segments'] {
    const cleaned = this.cleanText(text);
    if (!cleaned) {
      return [];
    }
    const lines = cleaned
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const chunks = lines.length > 0 ? lines : [cleaned];
    return chunks.map((line) => ({
      content: line,
      start_time: '',
      end_time: '',
      speaker: 'Speaker 1',
    }));
  }

  private requeuePendingJobs(): void {
    for (const job of this.listJobRecords()) {
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
    const record = this.readJob(jobId);
    if (!record || !record.audio_path) {
      return;
    }

    record.status = 'processing';
    record.updated_at = new Date().toISOString();
    this.writeJob(record);

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

      const jobDir = this.jobDir(jobId);
      const resultPath = this.transcriptionPath(jobId);
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
      record.updated_at = new Date().toISOString();
      this.writeJob(record);
    } catch (err) {
      record.status = 'failed';
      record.error = err instanceof Error ? err.message : String(err);
      record.updated_at = new Date().toISOString();
      this.writeJob(record);
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
    const record = this.readJob(jobId);
    if (!record || record.status !== 'completed' || !record.audio_path) {
      return;
    }

    record.diarization_status = 'processing';
    record.updated_at = new Date().toISOString();
    this.writeJob(record);

    try {
      const resultPath = this.transcriptionPath(jobId);
      if (!fs.existsSync(resultPath)) {
        throw new Error('Transcription result not found');
      }

      const existingRaw = fs.readFileSync(resultPath, 'utf-8');
      const existing = JSON.parse(existingRaw) as TranscriptionResult;

      const diarized = await this.transcriber.transcribeAudio(record.audio_path, undefined, {
        applySmartFormatting: false,
      });
      existing.speech_segments = this.normalizeSegments(diarized.speech_segments);
      existing.diarization_status = 'completed';
      fs.writeFileSync(resultPath, JSON.stringify(existing, null, 2), 'utf-8');

      record.diarization_status = 'completed';
      record.updated_at = new Date().toISOString();
      this.writeJob(record);
    } catch (err) {
      record.diarization_status = 'failed';
      record.error = err instanceof Error ? err.message : String(err);
      record.updated_at = new Date().toISOString();
      this.writeJob(record);
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
}
