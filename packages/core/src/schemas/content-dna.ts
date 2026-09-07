import { z } from "zod";

/**
 * Content DNA — structured output of Gemini whole-video analysis.
 * Mirrors 01_ARCHITECTURE.md §5.2. This schema validates every
 * `video_analysis.dna` payload on write AND on read.
 *
 * Versioning: the schema itself is versioned via `dnaSchemaVersion`;
 * the prompt that produced it is tracked separately in `prompt_version`.
 *
 * Every field carries a `.describe()`: E2 turns this schema into the Gemini
 * `response_schema`, where the descriptions are what tells the model what to
 * put in the field. A field without one is answered by its name alone, so
 * `test/content-dna.test.ts` fails when a new field arrives without a
 * description.
 */

export const TimelineEntrySchema = z.object({
  startSec: z
    .number()
    .nonnegative()
    .describe("When the beat begins, in seconds from the start of the video."),
  endSec: z
    .number()
    .nonnegative()
    .describe("When the beat ends, in seconds from the start of the video."),
  visual: z
    .string()
    .describe("What is on screen during the beat: subject, framing, action."),
  narration: z
    .string()
    .optional()
    .describe("What is said during the beat; omitted when nobody speaks."),
  overlayText: z
    .string()
    .optional()
    .describe("Text burned into the frame during the beat, quoted verbatim."),
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
  dnaSchemaVersion: z
    .literal(1)
    .describe("Revision of this contract; always 1 for payloads written now."),

  topic: z
    .string()
    .describe("Broad subject area the video belongs to, in a few words."),
  subtopic: z
    .string()
    .describe("The narrower angle inside that area this video actually takes."),
  storySummary: z
    .string()
    .describe("What happens, from setup to payoff, in a few sentences."),
  semanticTranscript: z
    .string()
    .describe(
      "Spoken words plus the on-screen information a reader would otherwise miss.",
    ),
  timeline: z
    .array(TimelineEntrySchema)
    .describe("The video split into beats, in chronological order."),

  hookType: HookTypeSchema.describe(
    "Which known opening device the first seconds use.",
  ),
  hookTextPattern: z
    .string()
    .describe(
      "The opening line as a reusable template, specifics replaced by placeholders.",
    ),
  openingVisualType: z
    .string()
    .describe(
      "Kind of shot the video opens on: talking head, object close-up, screen capture.",
    ),
  firstVisualObject: z
    .string()
    .describe("The concrete thing the viewer sees in the very first frame."),
  first1sAnalysis: z
    .string()
    .describe("What second one gives the viewer and why it holds attention."),
  first2sAnalysis: z
    .string()
    .describe("What the second second adds on top of that."),
  first3sAnalysis: z
    .string()
    .describe("What the third second adds, and whether the promise lands."),
  first5sAnalysis: z
    .string()
    .describe(
      "Where the viewer stands by second five: informed, hooked, lost.",
    ),

  contextDelaySec: z
    .number()
    .nonnegative()
    .describe("How long the viewer waits before learning what this is about."),
  openLoopType: z
    .string()
    .describe("The question left open to keep the viewer waiting."),
  revealTimestampSec: z
    .number()
    .nonnegative()
    .describe("When the answer or payoff is finally delivered, in seconds."),
  revealPct: z
    .number()
    .min(0)
    .max(100)
    .describe("The same moment as a share of the whole video, 0 to 100."),
  storyStructure: z
    .string()
    .describe("Shape of the narrative: problem-solution, list, chronology."),
  emotionalDriver: z
    .string()
    .describe("The feeling the video plays on: curiosity, outrage, awe."),

  speechPace: z
    .string()
    .describe("Speed and rhythm of the delivery, pauses included."),
  sentenceStyle: z
    .string()
    .describe("How the narration is written: sentence length, tone, person."),
  visualChangeDensity: z
    .string()
    .describe("How often the picture changes: cuts, zooms, camera moves."),
  textOverlayUsage: z
    .string()
    .describe("How on-screen text is used: how much, where, what for."),
  facePresence: z
    .boolean()
    .describe("Whether a human face appears on screen at any point."),
  endingType: z
    .string()
    .describe("How the video closes: loop back, punchline, cliffhanger."),
  ctaType: z
    .string()
    .nullable()
    .describe("What the viewer is asked to do; null when nothing is asked."),

  whyItMayWork: z
    .array(z.string())
    .describe("Reasons this video plausibly performs, one per item."),
  transferablePatterns: z
    .array(z.string())
    .describe(
      "Abstract patterns worth reusing in our own videos, never the content itself.",
    ),
  riskyToCopyElements: z
    .array(z.string())
    .describe(
      "Elements that would be a mistake to reuse: channel-specific, licensed, misleading.",
    ),
});

export type ContentDna = z.infer<typeof ContentDnaSchema>;
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;
export type HookType = z.infer<typeof HookTypeSchema>;
