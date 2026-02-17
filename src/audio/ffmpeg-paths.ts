import * as path from 'path';
import { app } from 'electron';

/**
 * Resolve path to a bundled binary (ffmpeg or ffprobe).
 * - Packaged app: Contents/Resources/bin/<name>
 * - Dev mode: bare name (relies on system PATH)
 */
function getBinaryPath(name: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', name);
  }
  return name;
}

export function getFfmpegPath(): string {
  return getBinaryPath('ffmpeg');
}

export function getFfprobePath(): string {
  return getBinaryPath('ffprobe');
}
