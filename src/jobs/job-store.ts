import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../backend/config-manager';
import { JobRecord } from './types';

export class JobStore {
  private config: ConfigManager;

  constructor(config: ConfigManager) {
    this.config = config;
  }

  recordingsDir(): string {
    return this.config.getRecordingsDir();
  }

  incomingDir(): string {
    const dir = path.join(this.recordingsDir(), '_incoming');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  jobDir(jobId: string): string {
    return path.join(this.recordingsDir(), jobId);
  }

  jobMetaPath(jobId: string): string {
    return path.join(this.jobDir(jobId), 'job.json');
  }

  transcriptionPath(jobId: string): string {
    return path.join(this.jobDir(jobId), 'transcription.json');
  }

  readJob(jobId: string): JobRecord | null {
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

  writeJob(record: JobRecord): void {
    const dir = this.jobDir(record.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.jobMetaPath(record.id), JSON.stringify(record, null, 2), 'utf-8');
  }

  listJobRecords(): JobRecord[] {
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

  validateJobId(jobId: string): void {
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

  async copyToIncoming(filePath: string, originalName?: string): Promise<string> {
    const ext = path.extname(originalName || filePath) || '.wav';
    const filename = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`;
    const dest = path.join(this.incomingDir(), filename);
    await fs.promises.copyFile(filePath, dest);
    return dest;
  }

  async writeIncoming(bytes: Buffer, originalName: string): Promise<string> {
    const ext = path.extname(originalName) || '.wav';
    const filename = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`;
    const dest = path.join(this.incomingDir(), filename);
    await fs.promises.writeFile(dest, bytes);
    return dest;
  }

  async moveFile(source: string, dest: string): Promise<void> {
    try {
      await fs.promises.rename(source, dest);
    } catch {
      await fs.promises.copyFile(source, dest);
      await fs.promises.unlink(source);
    }
  }

  formatJobId(date: Date): string {
    const pad = (value: number) => value.toString().padStart(2, '0');
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(
      date.getMinutes(),
    )}-${pad(date.getSeconds())}`;
    return `${stamp}_${Math.random().toString(36).slice(2, 6)}`;
  }
}
