import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { TranscriptionJobQueue } from '../backend/job-queue';

function createQueue(recordingsDir: string): TranscriptionJobQueue {
  const config = {
    getRecordingsDir: () => recordingsDir,
    getSettings: () => ({
      consensusEnabled: false,
      autoPolish: false,
      polishStyle: 'natural',
      customPolishPrompt: '',
    }),
  };
  return new TranscriptionJobQueue(config as any, {} as any);
}

function createRecordingsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gammawave-job-queue-'));
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('TranscriptionJobQueue audio-only jobs', () => {
  it('createAudioOnlyJob writes recording.webm and stores failed status metadata', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const created = queue.createAudioOnlyJob('openai', Buffer.from([1, 2, 3, 4]), '00:04');
    const jobDir = path.join(recordingsDir, created.id);
    const jobMetaPath = path.join(jobDir, 'job.json');
    const audioPath = path.join(jobDir, 'recording.webm');

    expect(created.status).toBe('failed');
    expect(created.error).toBe('Transcription in progress');
    expect(created.audio_path).toBe(audioPath);
    expect(fs.existsSync(audioPath)).toBe(true);

    const persistedRaw = fs.readFileSync(jobMetaPath, 'utf-8');
    const persisted = JSON.parse(persistedRaw) as Record<string, unknown>;
    expect(persisted.status).toBe('failed');
    expect(persisted.error).toBe('Transcription in progress');
  });

  it('completeAudioOnlyJob marks the job completed and writes transcript output', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const created = queue.createAudioOnlyJob('openai', Buffer.from([1, 2, 3]));
    const completed = queue.completeAudioOnlyJob(created.id, 'hello world');
    const transcriptionPath = path.join(recordingsDir, created.id, 'transcription.json');

    expect(completed.job.status).toBe('completed');
    expect(completed.job.error).toBeUndefined();
    expect(completed.job.result_path).toBe(transcriptionPath);
    expect(completed.result.summary).toContain('hello world');
    expect(fs.existsSync(transcriptionPath)).toBe(true);

    const persisted = queue.getJob(created.id);
    expect(persisted?.status).toBe('completed');
    expect(persisted?.result_path).toBe(transcriptionPath);
  });

  it('completeAudioOnlyJob persists is_meeting when meeting mode is true', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const created = queue.createAudioOnlyJob('openai', Buffer.from([1, 2, 3]));
    const completed = queue.completeAudioOnlyJob(created.id, 'hello world', undefined, undefined, undefined, undefined, true);
    const transcriptionPath = path.join(recordingsDir, created.id, 'transcription.json');
    const raw = fs.readFileSync(transcriptionPath, 'utf-8');
    const parsed = JSON.parse(raw) as { is_meeting?: boolean };

    expect(completed.result.is_meeting).toBe(true);
    expect(parsed.is_meeting).toBe(true);
  });

  it('completeAudioOnlyJob throws on missing job and empty text', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    expect(() => queue.completeAudioOnlyJob('missing_job', 'hello')).toThrow('Job not found');

    const created = queue.createAudioOnlyJob('openai', Buffer.from([1]));
    expect(() => queue.completeAudioOnlyJob(created.id, '   ')).toThrow('Transcription text is empty');
  });

  it('retranscribeJob works for audio-only jobs', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const created = queue.createAudioOnlyJob('openai', Buffer.from([1, 2]));
    const updated = queue.retranscribeJob(created.id);

    expect(updated.status).toBe('pending');
    expect(updated.error).toBeUndefined();

    const queueEntries = (queue as any).queue as string[];
    expect(queueEntries.filter((id) => id === created.id)).toHaveLength(1);
  });
});

describe('TranscriptionJobQueue.retranscribeJob', () => {
  it('createTextJob persists is_meeting when meeting mode is true', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const created = queue.createTextJob(
      'hello world',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    const transcriptionPath = path.join(recordingsDir, created.job.id, 'transcription.json');
    const raw = fs.readFileSync(transcriptionPath, 'utf-8');
    const parsed = JSON.parse(raw) as { is_meeting?: boolean };

    expect(created.result.is_meeting).toBe(true);
    expect(parsed.is_meeting).toBe(true);
  });

  it('resets a completed job to pending and removes stale output files', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const created = queue.createTextJob('hello world', 'openai', 'Test title', 'Test summary', Buffer.from([1, 2, 3]));
    const jobId = created.job.id;
    const jobDir = path.join(recordingsDir, jobId);
    const transcriptionPath = path.join(jobDir, 'transcription.json');
    const summaryPath = path.join(jobDir, 'summary.txt');

    fs.writeFileSync(summaryPath, 'old summary', 'utf-8');
    const raw = fs.readFileSync(path.join(jobDir, 'job.json'), 'utf-8');
    const withOldError = { ...(JSON.parse(raw) as Record<string, unknown>), error: 'old failure' };
    fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(withOldError, null, 2), 'utf-8');

    const updated = queue.retranscribeJob(jobId);

    expect(updated.status).toBe('pending');
    expect(updated.error).toBeUndefined();
    expect(updated.result_path).toBeUndefined();
    expect(fs.existsSync(transcriptionPath)).toBe(false);
    expect(fs.existsSync(summaryPath)).toBe(false);

    const persisted = queue.getJob(jobId);
    expect(persisted?.status).toBe('pending');
    expect(persisted?.error).toBeUndefined();
    expect(persisted?.result_path).toBeUndefined();

    const queueEntries = (queue as any).queue as string[];
    expect(queueEntries.filter((id) => id === jobId)).toHaveLength(1);
  });

  it('rejects re-transcribe for a job that is already pending', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const created = queue.createTextJob('hello world', 'openai', 'Test title', 'Test summary', Buffer.from([1, 2, 3]));
    queue.retranscribeJob(created.job.id);

    expect(() => queue.retranscribeJob(created.job.id)).toThrow('pending or processing');
  });

  it('rejects re-transcribe for a job that is already processing', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const created = queue.createTextJob('hello world', 'openai', 'Test title', 'Test summary', Buffer.from([1, 2, 3]));
    const jobPath = path.join(recordingsDir, created.job.id, 'job.json');
    const raw = fs.readFileSync(jobPath, 'utf-8');
    const asProcessing = { ...(JSON.parse(raw) as Record<string, unknown>), status: 'processing' };
    fs.writeFileSync(jobPath, JSON.stringify(asProcessing, null, 2), 'utf-8');

    expect(() => queue.retranscribeJob(created.job.id)).toThrow('pending or processing');
  });

  it('allows re-transcribe for failed jobs', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const created = queue.createTextJob('hello world', 'openai', 'Test title', 'Test summary', Buffer.from([1, 2, 3]));
    const jobPath = path.join(recordingsDir, created.job.id, 'job.json');
    const raw = fs.readFileSync(jobPath, 'utf-8');
    const asFailed = {
      ...(JSON.parse(raw) as Record<string, unknown>),
      status: 'failed',
      error: 'previous failure',
      result_path: path.join(recordingsDir, created.job.id, 'transcription.json'),
    };
    fs.writeFileSync(jobPath, JSON.stringify(asFailed, null, 2), 'utf-8');

    const updated = queue.retranscribeJob(created.job.id);
    expect(updated.status).toBe('pending');
    expect(updated.error).toBeUndefined();
    expect(updated.result_path).toBeUndefined();
  });

  it('rejects re-transcribe for jobs without audio', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const created = queue.createTextJob('text only');
    expect(() => queue.retranscribeJob(created.job.id)).toThrow('does not have an audio file');
  });

  it('rejects re-transcribe when audio file is missing', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const created = queue.createTextJob('hello world', 'openai', 'Test title', 'Test summary', Buffer.from([1, 2, 3]));
    expect(created.job.audio_path).toBeTruthy();
    fs.unlinkSync(created.job.audio_path!);

    expect(() => queue.retranscribeJob(created.job.id)).toThrow('Audio file not found');
  });

  it('prevents queue duplication when the job is already queued', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const created = queue.createTextJob('hello world', 'openai', 'Test title', 'Test summary', Buffer.from([1, 2, 3]));
    const queueEntries = (queue as any).queue as string[];
    queueEntries.push(created.job.id);

    queue.retranscribeJob(created.job.id);

    expect(queueEntries.filter((id) => id === created.job.id)).toHaveLength(1);
  });

  it('rejects re-transcribe when audio path escapes recordings directory', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const created = queue.createTextJob('hello world', 'openai', 'Test title', 'Test summary', Buffer.from([1, 2, 3]));
    const jobPath = path.join(recordingsDir, created.job.id, 'job.json');
    const raw = fs.readFileSync(jobPath, 'utf-8');
    const escapedPath = { ...(JSON.parse(raw) as Record<string, unknown>), audio_path: '../../etc/passwd' };
    fs.writeFileSync(jobPath, JSON.stringify(escapedPath, null, 2), 'utf-8');

    expect(() => queue.retranscribeJob(created.job.id)).toThrow('Invalid audio file path');
  });
});
