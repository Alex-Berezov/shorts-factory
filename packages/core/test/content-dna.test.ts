import { describe, expect, it } from "vitest";
import {
  type ContentDna,
  ContentDnaSchema,
  TimelineEntrySchema,
} from "../src/schemas/content-dna.js";

/**
 * The field list of blueprint §5.2, copied verbatim in the spelling of the
 * document. The schema is the contract of the applied `video_analysis.dna`
 * column and of E2, so drift in either direction - a field the blueprint asks
 * for and the schema lost, or a field nobody asked for - has to fail here.
 */
const BLUEPRINT_FIELDS = [
  "topic",
  "subtopic",
  "story_summary",
  "semantic_transcript",
  "timeline[]",
  "hook_type",
  "hook_text_pattern",
  "opening_visual_type",
  "first_visual_object",
  "first_1s_analysis",
  "first_2s_analysis",
  "first_3s_analysis",
  "first_5s_analysis",
  "context_delay_sec",
  "open_loop_type",
  "reveal_timestamp_sec",
  "reveal_pct",
  "story_structure",
  "emotional_driver",
  "speech_pace",
  "sentence_style",
  "visual_change_density",
  "text_overlay_usage",
  "face_presence",
  "ending_type",
  "cta_type",
  "why_it_may_work[]",
  "transferable_patterns[]",
  "risky_to_copy_elements[]",
];

function camelCase(documentName: string): string {
  return documentName
    .replace("[]", "")
    .replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

const VALID: ContentDna = {
  dnaSchemaVersion: 1,
  topic: "space",
  subtopic: "orbital mechanics",
  storySummary: "A satellite loses altitude and is saved by a burn.",
  semanticTranscript: "Narrator explains drag while the orbit decays.",
  timeline: [
    {
      startSec: 0,
      endSec: 3,
      visual: "satellite tumbling against the earth",
      narration: "this satellite has hours to live",
      overlayText: "3 HOURS",
    },
    { startSec: 3, endSec: 20, visual: "animated orbit decay" },
  ],
  hookType: "shocking_fact",
  hookTextPattern: "this {object} has {time} to live",
  openingVisualType: "3d animation",
  firstVisualObject: "satellite",
  first1sAnalysis: "Motion and a countdown promise a deadline.",
  first2sAnalysis: "The stake is named: the satellite falls.",
  first3sAnalysis: "The cause is teased but withheld.",
  first5sAnalysis: "Viewer knows the problem and waits for the fix.",
  contextDelaySec: 4,
  openLoopType: "will it survive",
  revealTimestampSec: 22,
  revealPct: 73,
  storyStructure: "problem then solution",
  emotionalDriver: "suspense",
  speechPace: "fast, few pauses",
  sentenceStyle: "short declarative sentences",
  visualChangeDensity: "a cut every two seconds",
  textOverlayUsage: "large numbers on key beats",
  facePresence: false,
  endingType: "loop back to the opening shot",
  ctaType: null,
  whyItMayWork: ["a deadline in the first second"],
  transferablePatterns: ["state the stake before the topic"],
  riskyToCopyElements: ["footage licensed to the channel"],
};

describe("ContentDnaSchema", () => {
  it("carries exactly the fields of blueprint §5.2, plus the schema version", () => {
    expect(Object.keys(ContentDnaSchema.shape)).toEqual([
      "dnaSchemaVersion",
      ...BLUEPRINT_FIELDS.map(camelCase),
    ]);
  });

  it("describes every field for the Gemini response schema", () => {
    for (const [name, field] of Object.entries(ContentDnaSchema.shape)) {
      expect(field.description, `${name} has no description`).toBeTruthy();
    }
  });

  it("describes every field of a timeline entry", () => {
    for (const [name, field] of Object.entries(TimelineEntrySchema.shape)) {
      expect(field.description, `${name} has no description`).toBeTruthy();
    }
  });

  it("accepts a complete analysis", () => {
    expect(ContentDnaSchema.parse(VALID)).toEqual(VALID);
  });

  it("rejects a payload written against another schema version", () => {
    expect(
      ContentDnaSchema.safeParse({ ...VALID, dnaSchemaVersion: 2 }).success,
    ).toBe(false);
  });

  it("rejects a reveal position outside the video", () => {
    expect(
      ContentDnaSchema.safeParse({ ...VALID, revealPct: 101 }).success,
    ).toBe(false);
  });
});
