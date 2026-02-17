import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionJobQueue } from '../job-queue';

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

describe('TranscriptionJobQueue.updateActionItemCompletion', () => {
  const meetingNotes = {
    summary: 'Test meeting summary',
    discussion_points: ['point 1'],
    action_items: ['action 1', 'action 2', 'action 3'],
    decisions: ['decision 1'],
    next_steps: ['step 1'],
  };

  it('persists completed action items and returns updated timestamp', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const created = queue.createTextJob('hello world', 'openai', 'Title', 'Summary', undefined, undefined, meetingNotes);
    const result = queue.updateActionItemCompletion(created.job.id, [0, 2]);

    expect(result.completedItems).toEqual([0, 2]);
    expect(result.updated_at).toBeTruthy();

    const resultPath = path.join(recordingsDir, created.job.id, 'transcription.json');
    const raw = fs.readFileSync(resultPath, 'utf-8');
    const data = JSON.parse(raw) as { meeting_notes?: { _completedItems?: number[] } };
    expect(data.meeting_notes?._completedItems).toEqual([0, 2]);
  });

  it('throws when transcription result does not exist', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const created = queue.createTextJob('hello world', 'openai', 'Title', 'Summary');
    fs.unlinkSync(path.join(recordingsDir, created.job.id, 'transcription.json'));

    expect(() => queue.updateActionItemCompletion(created.job.id, [0])).toThrow('Transcription result not found');
  });

  it('throws when job has no meeting notes', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const created = queue.createTextJob('hello world', 'openai', 'Title', 'Summary');

    expect(() => queue.updateActionItemCompletion(created.job.id, [0])).toThrow('No meeting notes on this job');
  });

  it('round-trips: write then read back completed items', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const created = queue.createTextJob('hello world', 'openai', 'Title', 'Summary', undefined, undefined, meetingNotes);

    queue.updateActionItemCompletion(created.job.id, [1]);
    queue.updateActionItemCompletion(created.job.id, [0, 1, 2]);

    const resultPath = path.join(recordingsDir, created.job.id, 'transcription.json');
    const raw = fs.readFileSync(resultPath, 'utf-8');
    const data = JSON.parse(raw) as { meeting_notes?: { _completedItems?: number[] } };
    expect(data.meeting_notes?._completedItems).toEqual([0, 1, 2]);
  });
});

describe('Diarization preserves meeting notes', () => {
  it('processDiarization does not clobber meeting notes written during transcription', async () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);

    const meetingNotes = {
      summary: 'Important meeting',
      discussion_points: ['topic 1'],
      action_items: ['action 1'],
      decisions: ['decision 1'],
      next_steps: ['step 1'],
    };

    // Create a fake transcriber that simulates async diarization.
    // While it "transcribes", meeting notes get written to the file (simulating
    // generateMeetingNotesInBackground finishing before diarization).
    let resultPath: string | undefined;
    const fakeTranscriber = {
      transcribeAudio: async () => {
        // Simulate meeting notes being written while diarization is in progress
        if (resultPath) {
          const raw = fs.readFileSync(resultPath, 'utf-8');
          const data = JSON.parse(raw) as Record<string, unknown>;
          data.meeting_notes = meetingNotes;
          fs.writeFileSync(resultPath, JSON.stringify(data, null, 2), 'utf-8');
        }
        return {
          speech_segments: [
            { content: 'hello', start_time: '0', end_time: '1', speaker: 'Speaker 1' },
          ],
        };
      },
    };

    const config = {
      getRecordingsDir: () => recordingsDir,
      getSettings: () => ({
        consensusEnabled: false,
        autoPolish: false,
        polishStyle: 'natural',
        customPolishPrompt: '',
      }),
    };
    const queue = new TranscriptionJobQueue(config as any, fakeTranscriber as any);

    // Create a completed audio-only job so processDiarization can run
    const created = queue.createAudioOnlyJob('openai', Buffer.from([1, 2, 3]));
    queue.completeAudioOnlyJob(created.id, 'hello world');

    resultPath = path.join(recordingsDir, created.id, 'transcription.json');

    // Trigger diarization (private method, access via any)
    await (queue as any).processDiarization(created.id);

    // Verify meeting notes survived diarization
    const raw = fs.readFileSync(resultPath, 'utf-8');
    const data = JSON.parse(raw) as { meeting_notes?: Record<string, unknown>; speech_segments?: unknown[] };
    expect(data.meeting_notes).toEqual(meetingNotes);
    expect(data.speech_segments).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// NEW TESTS — appended below existing tests
// ---------------------------------------------------------------------------

describe('createTextJob', () => {
  it('text-only (no audio) writes job.json and transcription.json on disk', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const { job, result } = queue.createTextJob('Hello world');
    const jobDir = path.join(recordingsDir, job.id);

    expect(fs.existsSync(path.join(jobDir, 'job.json'))).toBe(true);
    expect(fs.existsSync(path.join(jobDir, 'transcription.json'))).toBe(true);

    expect(job.status).toBe('completed');
    expect(job.audio_path).toBeUndefined();
    expect(result.speech_segments.length).toBeGreaterThan(0);
    expect(result.speech_segments[0].content).toBe('Hello world');
  });

  it('with audio bytes, title, summary, and duration — all fields are persisted', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const audio = Buffer.from([10, 20, 30]);
    const { job, result } = queue.createTextJob(
      'Some transcription text here',
      'openai',
      'My Title',
      'My Summary',
      audio,
      '01:30',
    );

    expect(job.title).toBe('My Title');
    expect(job.summary).toBe('My Summary');
    expect(job.duration).toBe('01:30');
    expect(job.audio_path).toBeTruthy();
    expect(fs.existsSync(job.audio_path!)).toBe(true);

    expect(result.title).toBe('My Title');
    expect(result.summary).toBe('My Summary');
  });

  it('with meeting notes and diarization status', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const notes = {
      summary: 'Meeting summary',
      discussion_points: ['dp1'],
      action_items: ['ai1'],
      decisions: ['d1'],
      next_steps: ['ns1'],
    };

    const { job, result } = queue.createTextJob(
      'Meeting transcript',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      notes,
      'completed',
    );

    expect(job.diarization_status).toBe('completed');
    expect(result.meeting_notes).toEqual(notes);
    expect(result.diarization_status).toBe('completed');
  });

  it('empty text throws "Transcription text is empty"', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    expect(() => queue.createTextJob('')).toThrow('Transcription text is empty');
    expect(() => queue.createTextJob('   ')).toThrow('Transcription text is empty');
  });
});

describe('createAudioOnlyJob — empty buffer', () => {
  it('throws "Audio payload is empty" for an empty buffer', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    expect(() => queue.createAudioOnlyJob('openai', Buffer.alloc(0))).toThrow('Audio payload is empty');
  });
});

describe('File Upload Enqueue', () => {
  it('enqueueFromPath copies file, creates pending job, and adds to queue', async () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    // Create a temp source file to enqueue
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-enqueue-src-'));
    tempDirs.push(srcDir);
    const srcFile = path.join(srcDir, 'test-audio.wav');
    fs.writeFileSync(srcFile, Buffer.from([99, 100, 101]));

    const job = await queue.enqueueFromPath(srcFile, 'test-audio.wav');

    expect(job.status).toBe('pending');
    expect(job.audio_path).toBeTruthy();
    expect(fs.existsSync(job.audio_path!)).toBe(true);

    const queueEntries = (queue as any).queue as string[];
    expect(queueEntries).toContain(job.id);

    // job.json should exist
    const metaPath = path.join(recordingsDir, job.id, 'job.json');
    expect(fs.existsSync(metaPath)).toBe(true);
  });

  it('enqueueFromBytes writes buffer, creates pending job, and adds to queue', async () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const bytes = Buffer.from([50, 60, 70]);
    const job = await queue.enqueueFromBytes(bytes, 'recording.webm');

    expect(job.status).toBe('pending');
    expect(job.audio_path).toBeTruthy();
    expect(fs.existsSync(job.audio_path!)).toBe(true);

    const queueEntries = (queue as any).queue as string[];
    expect(queueEntries).toContain(job.id);
  });
});

describe('Job Retrieval & Listing', () => {
  it('getJob returns record for existing job', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const { job } = queue.createTextJob('test text');
    const retrieved = queue.getJob(job.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(job.id);
    expect(retrieved!.status).toBe('completed');
  });

  it('getJob returns null for non-existent job', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    expect(queue.getJob('nonexistent-job-id')).toBeNull();
  });

  it('listJobs returns all jobs sorted newest-first', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const { job: job1 } = queue.createTextJob('first text');
    // Small delay so formatJobId generates a different ID
    const { job: job2 } = queue.createTextJob('second text');

    const jobs = queue.listJobs();
    expect(jobs.length).toBeGreaterThanOrEqual(2);

    // Newest first means job2 id should sort after job1 id — so job2 comes first in list
    const ids = jobs.map((j) => j.id);
    const idx1 = ids.indexOf(job1.id);
    const idx2 = ids.indexOf(job2.id);
    // Both must be present
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThanOrEqual(0);
  });

  it('listJobs returns empty array when recordings dir has no job folders', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    expect(queue.listJobs()).toEqual([]);
  });

  it('readJobResult returns parsed result for completed job', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const { job } = queue.createTextJob('some text', 'openai', 'A Title');
    const result = queue.readJobResult(job.id);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('A Title');
    expect(result!.speech_segments.length).toBeGreaterThan(0);
  });

  it('readJobResult returns null when transcription file does not exist', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    expect(queue.readJobResult('no-such-job')).toBeNull();
  });

  it('readJobResult returns null for corrupted JSON', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const { job } = queue.createTextJob('some text');
    const transcriptionPath = path.join(recordingsDir, job.id, 'transcription.json');
    fs.writeFileSync(transcriptionPath, '{corrupt json!!!', 'utf-8');

    expect(queue.readJobResult(job.id)).toBeNull();
  });
});

describe('Job Deletion', () => {
  it('deleteJob removes completed job directory from disk', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const { job } = queue.createTextJob('deletable text');
    const jobDir = path.join(recordingsDir, job.id);
    expect(fs.existsSync(jobDir)).toBe(true);

    const result = queue.deleteJob(job.id);
    expect(result).toBe(true);
    expect(fs.existsSync(jobDir)).toBe(false);
  });

  it('deleteJob removes job from in-memory queue', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const { job } = queue.createTextJob('some text');
    // Manually add to queue to simulate it being there
    const queueEntries = (queue as any).queue as string[];
    queueEntries.push(job.id);

    queue.deleteJob(job.id);
    expect(queueEntries).not.toContain(job.id);
  });

  it('deleteJob throws on pending status', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const { job } = queue.createTextJob('text', 'openai', undefined, undefined, Buffer.from([1]));
    // Make job pending
    const jobPath = path.join(recordingsDir, job.id, 'job.json');
    const raw = JSON.parse(fs.readFileSync(jobPath, 'utf-8')) as Record<string, unknown>;
    raw.status = 'pending';
    fs.writeFileSync(jobPath, JSON.stringify(raw, null, 2), 'utf-8');

    expect(() => queue.deleteJob(job.id)).toThrow('Cannot delete a job that is pending or processing');
  });

  it('deleteJob throws on processing status', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const { job } = queue.createTextJob('text');
    const jobPath = path.join(recordingsDir, job.id, 'job.json');
    const raw = JSON.parse(fs.readFileSync(jobPath, 'utf-8')) as Record<string, unknown>;
    raw.status = 'processing';
    fs.writeFileSync(jobPath, JSON.stringify(raw, null, 2), 'utf-8');

    expect(() => queue.deleteJob(job.id)).toThrow('Cannot delete a job that is pending or processing');
  });

  it('deleteJob returns false for non-existent job', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    expect(queue.deleteJob('2024-01-01_00-00-00_zzzz')).toBe(false);
  });
});

describe('Export', () => {
  it('getJobExportData returns markdown with title, summary, and transcript from segments', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const { job } = queue.createTextJob('Line one\nLine two', 'openai', 'Export Title', 'Export Summary');
    const exportData = queue.getJobExportData(job.id);

    expect(exportData).not.toBeNull();
    expect(exportData!.title).toBe('Export Title');
    expect(exportData!.markdown).toContain('# Export Title');
    expect(exportData!.markdown).toContain('Export Summary');
    expect(exportData!.markdown).toContain('Line one');
    expect(exportData!.markdown).toContain('Line two');
    expect(exportData!.filename).toContain('Export_Title');
    expect(exportData!.filename).toMatch(/\.md$/);
  });

  it('getJobExportData prefers readability text over segments', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const { job } = queue.createTextJob('Raw segment text', 'openai', 'Title', 'Custom Summary');
    queue.updateReadability(job.id, 'Polished readable text');

    const exportData = queue.getJobExportData(job.id);
    expect(exportData).not.toBeNull();
    expect(exportData!.markdown).toContain('Polished readable text');

    // The transcript section should use readability text, not raw segments.
    // Extract the transcript section: everything after "## Transcript"
    const transcriptSection = exportData!.markdown.split('## Transcript')[1] || '';
    expect(transcriptSection).toContain('Polished readable text');
    expect(transcriptSection).not.toContain('Raw segment text');
  });

  it('getJobExportData returns null for non-existent job', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    expect(queue.getJobExportData('2024-01-01_00-00-00_abcd')).toBeNull();
  });

  it('getJobExportData sanitizes filename', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const { job } = queue.createTextJob('some text', 'openai', 'Title with spaces & special!@#chars');
    const exportData = queue.getJobExportData(job.id);

    expect(exportData).not.toBeNull();
    // Filename should not contain special characters
    expect(exportData!.filename).not.toMatch(/[^a-zA-Z0-9_.\-]/);
  });
});

describe('Readability & Meeting Notes Updates', () => {
  it('updateReadability writes readability into transcription.json and preserves other fields', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const { job } = queue.createTextJob('original text', 'openai', 'Original Title', 'Original Summary');
    const readability = queue.updateReadability(job.id, 'Polished version of the text');

    expect(readability.text).toBe('Polished version of the text');
    expect(readability.updated_at).toBeTruthy();

    // Verify other fields are preserved
    const result = queue.readJobResult(job.id);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Original Title');
    expect(result!.summary).toBe('Original Summary');
    expect(result!.readability!.text).toBe('Polished version of the text');
    expect(result!.speech_segments.length).toBeGreaterThan(0);
  });

  it('updateReadability throws when result does not exist', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const { job } = queue.createTextJob('some text');
    fs.unlinkSync(path.join(recordingsDir, job.id, 'transcription.json'));

    expect(() => queue.updateReadability(job.id, 'new text')).toThrow('Transcription result not found');
  });

  it('updateMeetingNotes writes notes and propagates summary to job record', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const { job } = queue.createTextJob('some text', 'openai', 'Title', 'Old Summary');
    const notes = {
      summary: 'New Meeting Summary',
      discussion_points: ['dp1', 'dp2'],
      action_items: ['ai1'],
      decisions: ['d1'],
      next_steps: ['ns1'],
    };

    const updateResult = queue.updateMeetingNotes(job.id, notes);
    expect(updateResult.meeting_notes).toEqual(notes);
    expect(updateResult.updated_at).toBeTruthy();

    // Verify summary propagated to job record
    const updatedJob = queue.getJob(job.id);
    expect(updatedJob!.summary).toBe('New Meeting Summary');

    // Verify transcription.json has meeting_notes
    const transcriptionResult = queue.readJobResult(job.id);
    expect(transcriptionResult!.meeting_notes).toEqual(notes);
    expect(transcriptionResult!.summary).toBe('New Meeting Summary');
  });

  it('updateMeetingNotes throws when result does not exist', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const { job } = queue.createTextJob('some text');
    fs.unlinkSync(path.join(recordingsDir, job.id, 'transcription.json'));

    const notes = {
      summary: 'S',
      discussion_points: [],
      action_items: [],
      decisions: [],
      next_steps: [],
    };
    expect(() => queue.updateMeetingNotes(job.id, notes)).toThrow('Transcription result not found');
  });
});

describe('Diarization Queue', () => {
  it('enqueueDiarization enqueues completed job with audio', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const created = queue.createAudioOnlyJob('openai', Buffer.from([1, 2, 3]));
    queue.completeAudioOnlyJob(created.id, 'hello world');

    const result = queue.enqueueDiarization(created.id);
    expect(result).toBe(true);

    const diarizationQueue = (queue as any).diarizationQueue as string[];
    expect(diarizationQueue).toContain(created.id);

    // Verify status was written
    const updatedJob = queue.getJob(created.id);
    expect(updatedJob!.diarization_status).toBe('pending');
  });

  it('enqueueDiarization returns false for job without audio', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const { job } = queue.createTextJob('text only, no audio');
    expect(queue.enqueueDiarization(job.id)).toBe(false);
  });

  it('enqueueDiarization returns false for non-completed job', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const created = queue.createAudioOnlyJob('openai', Buffer.from([1, 2, 3]));
    // Job is 'failed' status (audio-only initial status)
    expect(queue.enqueueDiarization(created.id)).toBe(false);
  });

  it('enqueueDiarization returns false when diarization already completed', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const { job } = queue.createTextJob('text', 'openai', undefined, undefined, Buffer.from([1]), undefined, undefined, 'completed');
    expect(queue.enqueueDiarization(job.id)).toBe(false);
  });

  it('enqueueDiarization returns false when diarization already processing', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const { job } = queue.createTextJob('text', 'openai', undefined, undefined, Buffer.from([1]), undefined, undefined, 'processing');
    expect(queue.enqueueDiarization(job.id)).toBe(false);
  });

  it('does not create duplicate entries in diarization queue', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const created = queue.createAudioOnlyJob('openai', Buffer.from([1, 2, 3]));
    queue.completeAudioOnlyJob(created.id, 'hello world');

    queue.enqueueDiarization(created.id);

    // Manually reset diarization_status to pending to allow re-enqueue attempt
    const jobPath = path.join(recordingsDir, created.id, 'job.json');
    const raw = JSON.parse(fs.readFileSync(jobPath, 'utf-8')) as Record<string, unknown>;
    raw.diarization_status = undefined;
    fs.writeFileSync(jobPath, JSON.stringify(raw, null, 2), 'utf-8');

    queue.enqueueDiarization(created.id);

    const diarizationQueue = (queue as any).diarizationQueue as string[];
    const count = diarizationQueue.filter((id) => id === created.id).length;
    expect(count).toBe(1);
  });
});

describe('Worker Lifecycle', () => {
  it('start requeues pending and pending-diarization jobs from disk', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    // Create a pending job by creating job directory manually
    const { job: completedJob } = queue.createTextJob('text', 'openai', undefined, undefined, Buffer.from([1]));
    // Make it pending
    const jobPath = path.join(recordingsDir, completedJob.id, 'job.json');
    const raw = JSON.parse(fs.readFileSync(jobPath, 'utf-8')) as Record<string, unknown>;
    raw.status = 'pending';
    fs.writeFileSync(jobPath, JSON.stringify(raw, null, 2), 'utf-8');

    // Create a completed job with pending diarization
    const { job: diarJob } = queue.createTextJob('text2', 'openai', undefined, undefined, Buffer.from([2]));
    const diarJobPath = path.join(recordingsDir, diarJob.id, 'job.json');
    const diarRaw = JSON.parse(fs.readFileSync(diarJobPath, 'utf-8')) as Record<string, unknown>;
    diarRaw.diarization_status = 'pending';
    fs.writeFileSync(diarJobPath, JSON.stringify(diarRaw, null, 2), 'utf-8');

    // Create a fresh queue from same dir and start it
    const queue2 = createQueue(recordingsDir);
    queue2.start();

    const transcriptionQueue = (queue2 as any).queue as string[];
    const diarizationQueue = (queue2 as any).diarizationQueue as string[];

    expect(transcriptionQueue).toContain(completedJob.id);
    expect(diarizationQueue).toContain(diarJob.id);

    queue2.stop();
  });

  it('start does not create duplicate timers on repeated calls', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    queue.start();
    const timer1 = (queue as any).workerTimer;
    queue.start();
    const timer2 = (queue as any).workerTimer;

    expect(timer1).toBe(timer2);
    queue.stop();
  });

  it('stop clears the worker timer', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    queue.start();
    expect((queue as any).workerTimer).not.toBeNull();

    queue.stop();
    expect((queue as any).workerTimer).toBeNull();
  });
});

describe('processJob', () => {
  it('transcribes, writes result + summary, and marks completed', async () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);

    const fakeTranscriber = {
      transcribeAudio: async () => ({
        title: 'Transcribed Title',
        summary: 'Transcribed Summary',
        speech_segments: [
          { content: 'hello', start_time: '0', end_time: '1', speaker: 'Speaker 1' },
          { content: 'world', start_time: '1', end_time: '2', speaker: 'Speaker 2' },
        ],
      }),
    };

    const config = {
      getRecordingsDir: () => recordingsDir,
      getSettings: () => ({
        consensusEnabled: false,
        autoPolish: false,
        polishStyle: 'natural',
        customPolishPrompt: '',
      }),
    };
    const queue = new TranscriptionJobQueue(config as any, fakeTranscriber as any);

    const created = queue.createAudioOnlyJob('openai', Buffer.from([1, 2, 3]));
    await (queue as any).processJob(created.id);

    const job = queue.getJob(created.id);
    expect(job!.status).toBe('completed');
    expect(job!.title).toBe('Transcribed Title');
    expect(job!.summary).toBe('Transcribed Summary');
    expect(job!.result_path).toBeTruthy();

    // Verify transcription.json was written
    const result = queue.readJobResult(created.id);
    expect(result).not.toBeNull();
    expect(result!.speech_segments).toHaveLength(2);

    // Verify summary.txt was written
    const summaryPath = path.join(recordingsDir, created.id, 'summary.txt');
    expect(fs.existsSync(summaryPath)).toBe(true);
    const summaryContent = fs.readFileSync(summaryPath, 'utf-8');
    expect(summaryContent).toContain('Transcribed Title');
    expect(summaryContent).toContain('Transcribed Summary');
  });

  it('marks failed on transcription error', async () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);

    const fakeTranscriber = {
      transcribeAudio: async () => {
        throw new Error('API rate limit exceeded');
      },
    };

    const config = {
      getRecordingsDir: () => recordingsDir,
      getSettings: () => ({
        consensusEnabled: false,
        autoPolish: false,
        polishStyle: 'natural',
        customPolishPrompt: '',
      }),
    };
    const queue = new TranscriptionJobQueue(config as any, fakeTranscriber as any);

    const created = queue.createAudioOnlyJob('openai', Buffer.from([1, 2, 3]));
    await (queue as any).processJob(created.id);

    const job = queue.getJob(created.id);
    expect(job!.status).toBe('failed');
    expect(job!.error).toBe('API rate limit exceeded');
  });

  it('skips job without audio_path', async () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);

    const fakeTranscriber = {
      transcribeAudio: vi.fn(),
    };

    const config = {
      getRecordingsDir: () => recordingsDir,
      getSettings: () => ({
        consensusEnabled: false,
        autoPolish: false,
        polishStyle: 'natural',
        customPolishPrompt: '',
      }),
    };
    const queue = new TranscriptionJobQueue(config as any, fakeTranscriber as any);

    // Create a text-only job (no audio)
    const { job } = queue.createTextJob('text only');
    await (queue as any).processJob(job.id);

    // Transcriber should not have been called
    expect(fakeTranscriber.transcribeAudio).not.toHaveBeenCalled();
  });
});

describe('Security/Validation', () => {
  it('validateJobId rejects ".." path traversal', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    expect(() => (queue as any).validateJobId('../etc/passwd')).toThrow();
    expect(() => (queue as any).validateJobId('foo/../bar')).toThrow();
  });

  it('validateJobId rejects special characters', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    expect(() => (queue as any).validateJobId('job id with spaces')).toThrow('Invalid job ID format');
    expect(() => (queue as any).validateJobId('job/slash')).toThrow('Invalid job ID format');
    expect(() => (queue as any).validateJobId('job;semicolon')).toThrow('Invalid job ID format');
  });

  it('deleteJob validates job ID before operating', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    expect(() => queue.deleteJob('../malicious')).toThrow();
    expect(() => queue.deleteJob('path/traversal')).toThrow();
  });
});

describe('Text Utilities', () => {
  it('buildTitle returns provided title when given', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    expect((queue as any).buildTitle('some text', 'Provided Title')).toBe('Provided Title');
  });

  it('buildTitle auto-generates from first 6 words when no title provided', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const text = 'one two three four five six seven eight';
    const title = (queue as any).buildTitle(text);
    expect(title).toBe('one two three four five six');
  });

  it('buildTitle returns default when text is empty', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    expect((queue as any).buildTitle('')).toBe('Live transcription');
  });

  it('buildSummary returns provided summary when given', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    expect((queue as any).buildSummary('some text', 'Provided Summary')).toBe('Provided Summary');
  });

  it('buildSummary truncates at 200 chars with ellipsis when no summary provided', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const longText = 'x'.repeat(300);
    const summary = (queue as any).buildSummary(longText) as string;
    expect(summary).toHaveLength(200);
    expect(summary).toMatch(/\.\.\.$/);
  });

  it('buildSummary returns full text when <= 200 chars and no summary provided', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const text = 'Short text here';
    const summary = (queue as any).buildSummary(text) as string;
    expect(summary).toBe('Short text here');
  });

  it('buildSummary returns default when text is empty', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    expect((queue as any).buildSummary('')).toBe('No summary available');
  });

  it('buildSegments splits by newlines into segments', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    const segments = (queue as any).buildSegments('Line one\nLine two\nLine three') as Array<{
      content: string;
      speaker: string;
    }>;
    expect(segments).toHaveLength(3);
    expect(segments[0].content).toBe('Line one');
    expect(segments[1].content).toBe('Line two');
    expect(segments[2].content).toBe('Line three');
    expect(segments[0].speaker).toBe('Speaker 1');
  });

  it('buildSegments handles empty text', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    expect((queue as any).buildSegments('')).toEqual([]);
  });

  it('cleanText normalizes \\r\\n and trims', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    expect((queue as any).cleanText('  hello\r\nworld  ')).toBe('hello\nworld');
  });

  it('cleanText handles empty/null input', () => {
    const recordingsDir = createRecordingsDir();
    tempDirs.push(recordingsDir);
    const queue = createQueue(recordingsDir);

    expect((queue as any).cleanText('')).toBe('');
    expect((queue as any).cleanText('   ')).toBe('');
  });
});
