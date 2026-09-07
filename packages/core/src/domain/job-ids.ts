import type { SnapshotPoint } from "./enums.js";
import { ValidationError } from "./errors.js";

/**
 * Deterministic job ids (decision 5 of E0): BullMQ ignores a second `add` with
 * a custom id while the job record is still in Redis, so the id being built the
 * same way everywhere is what keeps a duplicate out. It is not idempotence on
 * its own: once `removeOnComplete`/`removeOnFail` drops the record, the id is
 * forgotten and the same job can be added again - the handler still has to be
 * safe to run twice.
 *
 * Segments are joined with `/`, not `:`. BullMQ 5 rejects a custom id
 * containing `:` (`Job.addJob -> validateOptions`) unless it happens to have
 * exactly three segments, and promises a full ban in the next major; `/`
 * appears in none of the values we put into an id (YouTube ids are
 * `A-Za-z0-9-_`, snapshot points, dates, model names).
 *
 * There is no `jobIds.snapshot(videoId, point)`: decision 1 of E1 replaced the
 * per-(video, point) snapshot job with a batched `radar.snapshot` tick, and the
 * job that does take that pair is `radar.score`.
 *
 * Every epic adds its own named builder here. Calling `jobId()` straight from a
 * processor is what review looks for - it is the way a format drifts.
 */

/** A number is allowed because most ids we build carry database ids and slots. */
export type JobIdPart = string | number;

const FORBIDDEN_IN_PART = /[/:]/;

function segment(value: JobIdPart, position: string): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ValidationError(`jobId ${position} is not a finite number`, {
        value,
      });
    }
    return String(value);
  }
  if (value === "") {
    throw new ValidationError(`jobId ${position} is empty`, { value });
  }
  if (FORBIDDEN_IN_PART.test(value)) {
    throw new ValidationError(`jobId ${position} may not contain "/" or ":"`, {
      value,
    });
  }
  return value;
}

/**
 * `<prefix>/<part>/<part>...`. The prefix is a free string rather than a
 * `QueueName`: the documents name jobs after what they do (`radar.sync`,
 * `publish`) while the queues that carry them are called `radar.sync-channel`
 * and `publish.upload`.
 */
export function jobId(prefix: string, ...parts: JobIdPart[]): string {
  const head = segment(prefix, "prefix");
  return [head, ...parts.map((part, i) => segment(part, `part ${i + 1}`))].join(
    "/",
  );
}

/**
 * The interval the moment falls into, counted from the epoch. Two runs of the
 * same repeatable job inside one interval produce one id - and therefore one
 * job - however many times the tick fires.
 */
export function intervalSlot(now: Date, intervalMin: number): number {
  if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
    throw new ValidationError(
      "job interval must be a positive finite number of minutes",
      { intervalMin },
    );
  }
  // An invalid date would give a slot of `NaN`, and every tick would then share
  // one id - a failure far away from its cause.
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new ValidationError("job slot needs a valid date", {
      now: String(now),
    });
  }
  return Math.floor(now.getTime() / (intervalMin * 60_000));
}

export const jobIds = {
  /**
   * One sync per channel per interval slot (E1-03). The channel is named by its
   * `yt_channel_id`, never by the internal `serial`: two names for one channel
   * in one slot would pass as two jobs and spend the quota twice.
   */
  radarSync(channelId: string, slot: number): string {
    return jobId("radar.sync", channelId, slot);
  },

  /** One scoring per video per snapshot point (E1-06), by `yt_video_id`. */
  radarScore(videoId: string, point: SnapshotPoint): string {
    return jobId("radar.score", videoId, point);
  },
} as const;
