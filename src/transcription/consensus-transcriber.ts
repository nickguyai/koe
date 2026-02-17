import { ConfigManager } from '../config/config-manager';
import { OpenAITranscriber } from './openai-transcriber';
import { SynthesisProcessor, ConsensusTranscriptionResult } from './synthesis-processor';
import { MemoryManager } from '../backend/memory-manager';

export class ConsensusTranscriber {
  private config: ConfigManager;
  private openai: OpenAITranscriber;
  private synthesis: SynthesisProcessor;
  private memory: MemoryManager;

  constructor(
    config: ConfigManager,
    openaiTranscriber: OpenAITranscriber,
    synthesisProcessor: SynthesisProcessor,
    memoryManager: MemoryManager,
  ) {
    this.config = config;
    this.openai = openaiTranscriber;
    this.synthesis = synthesisProcessor;
    this.memory = memoryManager;
  }

  async transcribeAudio(audioPath: string): Promise<ConsensusTranscriptionResult> {
    // Get top vocabulary terms from memory
    const terms = this.memory.getTopTerms(50);

    console.log(`[Consensus] Starting 3 parallel transcriptions with ${terms.length} memory terms`);

    // Run all 3 transcriptions in parallel
    const [baseResult, detailResult, verifyResult] = await Promise.all([
      this.openai.transcribeAudio(audioPath, 'base', terms),
      this.openai.transcribeAudio(audioPath, 'detail', terms),
      this.openai.transcribeAudio(audioPath, 'verify', terms),
    ]);

    console.log('[Consensus] All variants complete, synthesizing...');

    // Synthesize the results
    const result = await this.synthesis.synthesize([baseResult, detailResult, verifyResult], terms);

    console.log('[Consensus] Synthesis complete, updating memory...');

    // Update memory with new terms from transcription
    const fullText = result.speech_segments.map((s) => s.content).join(' ');
    await this.memory.updateFromTranscription(fullText);

    console.log('[Consensus] Memory updated');

    return result;
  }
}
