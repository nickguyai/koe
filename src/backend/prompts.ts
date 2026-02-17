// Re-export shim — canonical location is now src/transcription/prompts.ts
export {
  buildTranscriptionPrompt,
  buildChunkTranscriptionPrompt,
  buildPolishPrompt,
  buildConsensusVariantPrompt,
  buildSynthesisPrompt,
  LIVE_TRANSCRIPTION_PROMPT,
  MEETING_NOTES_PROMPT,
  GEMINI_TRANSCRIPTION_PROMPT,
  PROMPTS,
  POLISH_STYLES,
} from '../transcription/prompts';
export type { TranscriptionSettings, ChunkContext, ConsensusVariant, VariantResult } from '../transcription/prompts';
