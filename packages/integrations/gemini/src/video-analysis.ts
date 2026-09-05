/**
 * VideoAnalysisClient — Gemini whole-video analysis (epic E2).
 *
 * Inputs: public YouTube URL (competitors) or local file (own videos,
 * denser frame sampling). Output MUST validate against ContentDnaSchema;
 * invalid JSON gets one repair retry, then the job fails to DLQ.
 * Every call records model, promptVersion and costUsd.
 */
import type { ContentDna } from "@sf/core";

export interface AnalysisRequest {
  source: { kind: "youtube_url"; url: string } | { kind: "local_file"; path: string };
  pass: "full" | "hook_pass";
  promptVersion: string;
}

export interface AnalysisResult {
  dna: ContentDna;
  model: string;
  promptVersion: string;
  costUsd: number;
}

export class VideoAnalysisClient {
  async analyze(_req: AnalysisRequest): Promise<AnalysisResult> {
    throw new Error("TODO(E2): implement Gemini structured video analysis");
  }
}
