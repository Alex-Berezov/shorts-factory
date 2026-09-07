import { describe, expect, expectTypeOf, it } from "vitest";
import { ValidationError } from "../src/domain/errors.js";
import { intervalSlot, jobId, jobIds } from "../src/domain/job-ids.js";

/**
 * Formats are compared against literal strings, not against `jobId()`: a test
 * that builds the expectation with the same function it checks would follow
 * any drift of the separator instead of catching it. The separator is `/`
 * because BullMQ 5 rejects a custom id containing `:`.
 */
describe("jobId", () => {
  it("joins the prefix and the parts with a slash", () => {
    // `dna.full@1.0.0`, not `dna.full/1.0.0`: the prompt version is a path on
    // disk but a single segment in an id (decision of 07.09.2026).
    expect(
      jobId("intel.analyze", 42, "dna.full@1.0.0", "gemini-2.0-flash"),
    ).toBe("intel.analyze/42/dna.full@1.0.0/gemini-2.0-flash");
  });

  it("builds a prefix-only id", () => {
    expect(jobId("system.usage-rollup")).toBe("system.usage-rollup");
  });

  it("refuses a part containing the separator", () => {
    expect(() => jobId("publish", "a/b")).toThrow(ValidationError);
  });

  it("refuses a part containing a colon", () => {
    // Two ids would otherwise collapse into one and BullMQ would drop the
    // second job without a word.
    expect(() => jobId("intel.analyze", "dna:full")).toThrow(ValidationError);
  });

  it("refuses an empty part and an empty prefix", () => {
    expect(() => jobId("radar.sync", "")).toThrow(ValidationError);
    expect(() => jobId("", "abc")).toThrow(ValidationError);
  });

  it("refuses a part that is not a finite number", () => {
    expect(() => jobId("radar.score", Number.NaN, "1h")).toThrow(
      ValidationError,
    );
  });
});

describe("intervalSlot", () => {
  const INTERVAL_MIN = 15;
  const inside = new Date("2026-03-15T20:01:00Z");
  const alsoInside = new Date("2026-03-15T20:14:59Z");
  const next = new Date("2026-03-15T20:15:00Z");

  it("gives one slot to two moments inside the interval", () => {
    expect(intervalSlot(inside, INTERVAL_MIN)).toBe(
      intervalSlot(alsoInside, INTERVAL_MIN),
    );
  });

  it("changes the slot across the boundary", () => {
    expect(intervalSlot(next, INTERVAL_MIN)).toBe(
      intervalSlot(alsoInside, INTERVAL_MIN) + 1,
    );
  });

  it("counts intervals from the epoch", () => {
    expect(intervalSlot(new Date("1970-01-01T00:44:59Z"), 15)).toBe(2);
  });

  it("refuses a non-positive interval", () => {
    for (const min of [0, -15, Number.NaN]) {
      expect(() => intervalSlot(inside, min)).toThrow(ValidationError);
    }
  });

  it("refuses an invalid date instead of returning a NaN slot", () => {
    // A slot of `NaN` would give every tick the same id.
    expect(() => intervalSlot(new Date("not a date"), INTERVAL_MIN)).toThrow(
      ValidationError,
    );
  });
});

describe("jobIds", () => {
  it("builds one sync per channel per slot", () => {
    const slot = intervalSlot(new Date("2026-03-15T20:01:00Z"), 15);

    expect(jobIds.radarSync("UC_x5XG1OV2P6uZZ5FSM9Ttw", slot)).toBe(
      `radar.sync/UC_x5XG1OV2P6uZZ5FSM9Ttw/${slot}`,
    );
  });

  it("builds one scoring per video and snapshot point", () => {
    expect(jobIds.radarScore("dQw4w9WgXcQ", "1h")).toBe(
      "radar.score/dQw4w9WgXcQ/1h",
    );
    expect(jobIds.radarScore("dQw4w9WgXcQ", "adhoc")).toBe(
      "radar.score/dQw4w9WgXcQ/adhoc",
    );
  });

  it("names a channel and a video one way only", () => {
    // An internal `serial` from the cron and a `yt_channel_id` from a manual
    // run would be two ids for one channel in one slot: two syncs, twice the
    // units.
    expectTypeOf<
      Parameters<typeof jobIds.radarSync>[0]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      Parameters<typeof jobIds.radarScore>[0]
    >().toEqualTypeOf<string>();
  });

  it("rejects a channel id that would break the format", () => {
    expect(() => jobIds.radarSync("UC:broken", 1)).toThrow(ValidationError);
  });
});
