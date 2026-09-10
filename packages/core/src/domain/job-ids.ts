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
  return finalize(
    [head, ...parts.map((part, i) => segment(part, `part ${i + 1}`))].join("/"),
  );
}

/** An id BullMQ reads as a number is refused: `Job.addJob -> validateOptions`. */
const ALL_DIGITS = /^\d+$/;

/**
 * The last gate every builder here goes through. BullMQ rejects a custom id
 * that parses back to itself as an integer ("Custom Id cannot be integers"),
 * and an id of digits alone is exactly that: `jobId("42")` passes every rule
 * above and then fails inside `queue.add` - in the runtime, not in a test.
 */
function finalize(id: string): string {
  if (ALL_DIGITS.test(id)) {
    throw new ValidationError(
      `jobId "${id}" consists of digits only; BullMQ refuses such an id ("Custom Id cannot be integers") - give it a prefix`,
      { id },
    );
  }
  return id;
}

/**
 * A finished id carried inside another id (a DLQ copy of a failed job, the
 * retry of that copy in E13-02).
 *
 * It cannot go through `segment()`: an id already holds `/`, and the ids BullMQ
 * builds for its schedulers hold `:` as well (`repeat:<schedulerId>:<millis>`).
 * The separators are the reason both are forbidden inside a part, so the only
 * thing this does is make the value legal as a custom id again: `:` becomes
 * `@`, because a custom id with a colon survives `validateOptions` today only
 * by an exception for exactly three segments that BullMQ promises to drop.
 *
 * The result is not reversible, and nothing tries to reverse it: a DLQ record
 * carries the queue, the id and the name as fields (decision of 10.09.2026).
 */
function embedJobId(value: string, position: string): string {
  if (value === "") {
    throw new ValidationError(`jobId ${position} is empty`, { value });
  }
  return value.replaceAll(":", "@");
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

  /**
   * One smoke job per moment it was asked for (E0-08). The millisecond is the
   * whole id: two operators running `pnpm --filter @sf/worker smoke` at once
   * want two runs, and a stable id would silently give them one.
   */
  systemSmoke(requestedAtMs: number): string {
    return jobId("system.smoke", requestedAtMs);
  },

  /**
   * The heartbeat tick of `apps/worker` (E0-08), one per interval slot. The
   * scheduler that normally fires it builds its own ids; this builder is for a
   * tick asked for by hand, and the slot is what keeps two such asks inside
   * one minute from writing the stamp twice.
   */
  systemHeartbeat(slot: number): string {
    return jobId("system.heartbeat", slot);
  },

  /**
   * The copy of a finally failed job in `system.dlq` (E0-08, decision of
   * 10.09.2026). Deterministic so that a second `failed` event for the same
   * job - a worker restarted while the job was dying - does not leave two
   * records for E13-02 to deduplicate.
   *
   * The tail is `job.timestamp`, not `attemptsMade`: at a final failure the
   * attempts made always equal the attempts allowed and tell two records
   * apart in no way, while the timestamp differs exactly when there really is
   * a second record to keep - the same id enqueued again after
   * `removeOnFail` dropped the first instance.
   */
  dlqEntry(queue: string, originalId: string, createdAtMs: number): string {
    return finalize(
      [
        jobId("dlq", queue),
        embedJobId(originalId, "original id"),
        segment(createdAtMs, "created at"),
      ].join("/"),
    );
  },
} as const;
