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

  it("refuses a numeric part that is NaN, as not a safe integer of zero or more", () => {
    expect(() => jobId("radar.score", Number.NaN, "1h")).toThrow(
      ValidationError,
    );
  });

  it.each([
    ["a fraction", 1.5],
    ["an integer that prints in exponent form", 1e21],
    ["a negative integer", -1],
    ["an integer beyond the safe range", Number.MAX_SAFE_INTEGER + 1],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ])("refuses a numeric part that is %s", (_label, value) => {
    // Each of these prints in a way of its own (`1.5`, `1e+21`, `-1`,
    // `9007199254740992`), and the id would carry that print rather than the
    // number - two calls meaning one job could get two ids.
    expect(() => jobId("radar.sync", "UC_x", value)).toThrow(ValidationError);
    expect(() => jobId("radar.sync", "UC_x", value)).toThrow(/part 2/);
  });

  it("accepts zero and the largest safe integer as a numeric part", () => {
    expect(jobId("radar.sync", "UC_x", 0)).toBe("radar.sync/UC_x/0");
    expect(jobId("radar.sync", "UC_x", Number.MAX_SAFE_INTEGER)).toBe(
      "radar.sync/UC_x/9007199254740991",
    );
  });

  it("writes negative zero as 0, the same id as zero", () => {
    // `String(-0)` is "0", but only because of that; the test pins that the
    // two spellings of one number cannot make two ids.
    expect(jobId("radar.sync", "UC_x", -0)).toBe("radar.sync/UC_x/0");
    expect(jobId("radar.sync", "UC_x", -0)).toBe(
      jobId("radar.sync", "UC_x", 0),
    );
  });

  it("refuses an id made of digits alone", () => {
    // BullMQ answers such an id with "Custom Id cannot be integers" inside
    // `queue.add`, so without this the failure lands in the runtime.
    expect(() => jobId("42")).toThrow(ValidationError);
    expect(() => jobId("1", 2)).not.toThrow();
  });
});

describe("jobIds.systemSmoke", () => {
  it("names the queue and the moment the run was asked for", () => {
    expect(jobIds.systemSmoke(1_773_000_000_000)).toBe(
      "system.smoke/1773000000000",
    );
  });

  it("gives two runs two ids", () => {
    expect(jobIds.systemSmoke(1)).not.toBe(jobIds.systemSmoke(2));
  });
});

describe("jobIds.dlqEntry", () => {
  it("carries the original id and the moment the instance was created", () => {
    expect(
      jobIds.dlqEntry(
        "radar.score",
        "radar.score/abc123/24h",
        1_773_000_000_000,
      ),
    ).toBe("dlq/radar.score/radar.score/abc123/24h/1773000000000");
  });

  it("encodes the colons of a scheduler id", () => {
    // BullMQ builds `repeat:<schedulerId>:<millis>` for a scheduled job, and a
    // custom id with a colon survives `validateOptions` only by an exception
    // for exactly three segments that BullMQ promises to drop.
    expect(
      jobIds.dlqEntry(
        "system.heartbeat",
        "repeat:system.heartbeat:1773000000000",
        7,
      ),
    ).toBe("dlq/system.heartbeat/repeat@system.heartbeat@1773000000000/7");
  });

  it("keeps an id of digits alone out of the record", () => {
    // The default id BullMQ hands out is a number; wrapped it is still a legal
    // custom id, and the guard has to stay true for the assembled string.
    expect(jobIds.dlqEntry("system.smoke", "128", 7)).toBe(
      "dlq/system.smoke/128/7",
    );
  });

  it.each([
    ["a fraction", 1.5],
    ["a negative integer", -1],
    ["an integer beyond the safe range", Number.MAX_SAFE_INTEGER + 1],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ])("refuses a creation moment that is %s", (_label, value) => {
    // The builder goes around `jobId()`, so the numeric rule has to hold for
    // its own parts too; the message names the part, so the refusal cannot
    // come from the original id.
    expect(() => jobIds.dlqEntry("system.smoke", "abc", value)).toThrow(
      ValidationError,
    );
    expect(() => jobIds.dlqEntry("system.smoke", "abc", value)).toThrow(
      /created at/,
    );
  });

  it("writes a creation moment of negative zero as 0", () => {
    expect(jobIds.dlqEntry("system.smoke", "abc", -0)).toBe(
      "dlq/system.smoke/abc/0",
    );
  });

  it("refuses an empty original id", () => {
    expect(() => jobIds.dlqEntry("system.smoke", "", 7)).toThrow(
      ValidationError,
    );
  });

  it("refuses a NaN creation moment, as not a safe integer of zero or more", () => {
    expect(() => jobIds.dlqEntry("system.smoke", "abc", Number.NaN)).toThrow(
      ValidationError,
    );
    expect(() => jobIds.dlqEntry("system.smoke", "abc", Number.NaN)).toThrow(
      /created at/,
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
