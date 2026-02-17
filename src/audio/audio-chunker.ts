import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getFfmpegPath, getFfprobePath } from './ffmpeg-paths';

export interface AudioChunk {
  path: string;
  index: number;
  startSeconds: number;
  durationSeconds: number;
}

// 10 minutes per chunk, 15 seconds overlap
const CHUNK_DURATION_SECONDS = 600;
const OVERLAP_SECONDS = 15;

// ~20MB base64 limit → ~15MB raw audio. 16kHz mono 16-bit PCM = ~1.92 MB/min.
// 10 minutes ≈ 19.2 MB raw, safe margin for compressed formats.
const LONG_AUDIO_THRESHOLD_SECONDS = 660;

export async function getAudioDuration(audioPath: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(getFfprobePath(), [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      audioPath,
    ]);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`ffprobe not available: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed (code ${code}): ${stderr}`));
        return;
      }
      const duration = parseFloat(stdout.trim());
      if (isNaN(duration)) {
        reject(new Error(`Could not parse duration from ffprobe output: ${stdout}`));
        return;
      }
      resolve(duration);
    });
  });
}

export function isLongAudio(durationSeconds: number): boolean {
  return durationSeconds > LONG_AUDIO_THRESHOLD_SECONDS;
}

export function computeChunkRanges(totalDuration: number): Array<{ start: number; duration: number }> {
  const ranges: Array<{ start: number; duration: number }> = [];
  let start = 0;

  while (start < totalDuration) {
    const remaining = totalDuration - start;
    const duration = Math.min(CHUNK_DURATION_SECONDS, remaining);
    ranges.push({ start, duration });

    const next = start + CHUNK_DURATION_SECONDS - OVERLAP_SECONDS;
    if (next >= totalDuration) break;
    start = next;
  }

  return ranges;
}

export async function splitAudio(audioPath: string, outputDir: string): Promise<AudioChunk[]> {
  const duration = await getAudioDuration(audioPath);

  if (!isLongAudio(duration)) {
    // Not long enough to chunk — return single "chunk" pointing to original
    return [{ path: audioPath, index: 0, startSeconds: 0, durationSeconds: duration }];
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const ranges = computeChunkRanges(duration);
  const ext = path.extname(audioPath);
  const chunks: AudioChunk[] = [];

  for (let i = 0; i < ranges.length; i++) {
    const { start, duration: chunkDur } = ranges[i];
    const chunkPath = path.join(outputDir, `chunk_${i}${ext}`);

    await extractChunk(audioPath, chunkPath, start, chunkDur);

    chunks.push({
      path: chunkPath,
      index: i,
      startSeconds: start,
      durationSeconds: chunkDur,
    });
  }

  return chunks;
}

async function extractChunk(
  inputPath: string,
  outputPath: string,
  startSeconds: number,
  durationSeconds: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(getFfmpegPath(), [
      '-y',
      '-i', inputPath,
      '-ss', startSeconds.toString(),
      '-t', durationSeconds.toString(),
      '-ar', '16000',
      '-ac', '1',
      outputPath,
    ], { stdio: 'ignore' });

    child.on('error', (err) => {
      reject(new Error(`ffmpeg not available: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg chunk extraction failed (code ${code})`));
        return;
      }
      resolve();
    });
  });
}

export async function cleanupChunks(chunks: AudioChunk[], originalPath: string): Promise<void> {
  const chunkDirs = new Set<string>();
  const originalDir = path.dirname(originalPath);

  for (const chunk of chunks) {
    if (chunk.path !== originalPath) {
      chunkDirs.add(path.dirname(chunk.path));
      try {
        await fs.promises.unlink(chunk.path);
      } catch {
        // Ignore cleanup failures
      }
    }
  }

  for (const dir of chunkDirs) {
    if (dir === originalDir || !dir.endsWith('_chunks')) {
      continue;
    }
    try {
      await fs.promises.rmdir(dir);
    } catch {
      // Ignore cleanup failures
    }
  }
}
