import { z } from "zod";

/**
 * Content DNA — structured output of Gemini whole-video analysis.
 * Mirrors 01_ARCHITECTURE.md §5.2. This schema validates every
 * `video_analysis.dna` payload on write AND on read.
 *
 * Versioning: the schema itself is versioned via `dnaSchemaVersion`;
 * the prompt that produced it is tracked separately in `prompt_version`.
 */

export const TimelineEntrySchema = z.object({
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  visual: z.string(),
  narration: z.string().optional(),
  overlayText: z.string().optional(),
});

export const HookTypeSchema = z.enum([
  "question",
  "shocking_fact",
  "result_first",
  "bold_claim",
  "story_open",
  "visual_shock",
  "challenge",
  "other",
]);

export const ContentDnaSchema = z.object({
  dnaSchemaVersion: z.literal(1),

  topic: z.string(),
  subtopic: z.string(),
  storySummary: z.string(),
  semanticTranscript: z.string(),
  timeline: z.array(TimelineEntrySchema),

  hookType: HookTypeSchema,
  hookTextPattern: z.string(),
  openingVisualType: z.string(),
  firstVisualObject: z.string(),
  first1sAnalysis: z.string(),
  first2sAnalysis: z.string(),
  first3sAnalysis: z.string(),
  first5sAnalysis: z.string(),

  contextDelaySec: z.number().nonnegative(),
  openLoopType: z.string(),
  revealTimestampSec: z.number().nonnegative(),
  revealPct: z.number().min(0).max(100),
  storyStructure: z.string(),
  emotionalDriver: z.string(),

  speechPace: z.string(),
  sentenceStyle: z.string(),
  visualChangeDensity: z.string(),
  textOverlayUsage: z.string(),
  facePresence: z.boolean(),
  endingType: z.string(),
  ctaType: z.string().nullable(),

  whyItMayWork: z.array(z.string()),
  transferablePatterns: z.array(z.string()),
  riskyToCopyElements: z.array(z.string()),
});

export type ContentDna = z.infer<typeof ContentDnaSchema>;
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;
export type HookType = z.infer<typeof HookTypeSchema>;
