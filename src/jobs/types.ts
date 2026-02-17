// Types re-exported from gemini-transcriber to avoid cross-domain imports
import { DiarizationStatus, MeetingNotes, SpeechSegment, TranscriptionResult } from '../backend/gemini-transcriber';

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
  is_meeting?: boolean;
  is_retranscription?: boolean;
}

// Re-export types that consumers need
export type { DiarizationStatus, MeetingNotes, SpeechSegment, TranscriptionResult };
