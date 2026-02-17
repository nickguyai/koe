import * as path from 'path';

export function getAudioMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.webm':
      return 'audio/webm';
    case '.wav':
      return 'audio/wav';
    case '.mp3':
    case '.mpeg':
      return 'audio/mpeg';
    case '.m4a':
    case '.mp4':
      return 'audio/mp4';
    case '.ogg':
    case '.oga':
      return 'audio/ogg';
    case '.flac':
      return 'audio/flac';
    case '.aac':
      return 'audio/aac';
    default:
      return 'application/octet-stream';
  }
}

export function normalizeSpeakerKey(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}
