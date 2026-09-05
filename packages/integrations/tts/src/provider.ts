/**
 * TtsProvider — provider abstraction for the Voice Factory (epic E10).
 * Adapters (elevenlabs, openai, chirp, gemini-tts, cartesia) live in
 * ./providers/ and are selected per language via the voice registry.
 * YouTube Auto Dubbing is a baseline in bake-off reports, NOT a provider here.
 */
export interface SynthesizeRequest {
  text: string;
  language: string; // BCP-47
  voiceRef: string; // provider-specific voice id
  instructions?: string;
  speakingRate?: number;
}

export interface SynthesizeResult {
  audioPath: string;
  costUsd: number;
  meta: Record<string, unknown>;
}

export interface TtsProvider {
  readonly name: string;
  synthesize(req: SynthesizeRequest): Promise<SynthesizeResult>;
}
