import { ANALYSIS_KINDS, IdeaStatusSchema, SNAPSHOT_POINTS } from "@sf/core";
import { describe, expect, it } from "vitest";
import { ideaStatus } from "../src/schema/idea-flow.js";
import { analysisKind } from "../src/schema/intelligence.js";
import { snapshotPoint } from "../src/schema/radar.js";

/**
 * The same three enums exist twice: as a pgEnum here and as a Zod enum in
 * `@sf/core`. A value added to one side only compiles on both, and shows up as
 * a failed insert or a rejected parse at runtime, in E1 or E2 - far from the
 * line that caused it.
 *
 * The canary lives in `@sf/db` because §6 of the system design allows the
 * import `db -> core` and not the other way round. Order is compared too: the
 * lists are read as ordered pairs by whoever renders a filter.
 */
describe("core enums against pgEnum", () => {
  it("agrees on snapshot_point", () => {
    expect(snapshotPoint.enumValues).toEqual([...SNAPSHOT_POINTS]);
  });

  it("agrees on analysis_kind", () => {
    expect(analysisKind.enumValues).toEqual([...ANALYSIS_KINDS]);
  });

  it("agrees on idea_status", () => {
    expect(ideaStatus.enumValues).toEqual([...IdeaStatusSchema.options]);
  });
});
