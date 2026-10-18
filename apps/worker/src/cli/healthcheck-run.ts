/**
 * What the container healthcheck (`healthcheck.ts`) actually decides, without
 * the process around it: read the stamp, judge it by the rule `/system` uses,
 * and say why in one line.
 *
 * Kept apart so that every verdict - including "Redis took the connection and
 * never answered" - can be tested without a Redis to hang against.
 */
import { WORKER_HEARTBEAT_KEY, readHeartbeat } from "@sf/core";
import { settleWithin } from "@sf/runtime/deadline";
import type { Redis } from "ioredis";

/** Everything - connect, read, verdict - fits in this, or the check fails. */
export const HEALTHCHECK_DEADLINE_MS = 5_000;

interface HealthcheckVerdict {
  healthy: boolean;
  /** One line for `docker inspect`, next to the exit code. */
  reason: string;
}

/** The part of the Redis client the check reads with. */
export type HealthcheckRedis = Pick<Redis, "get">;

interface HealthcheckRunOptions {
  redis: HealthcheckRedis;
  /**
   * Asked once the stamp is in hand, not before the read: the connect and the
   * read may take most of the deadline, and the age of a stamp is measured
   * against the moment it was seen.
   */
  now: () => Date;
  deadlineMs: number;
}

/**
 * When the process gives up if no verdict came out of the read at all: later
 * than the read's deadline, so the read always answers first.
 */
export const HEALTHCHECK_BACKSTOP_MS = HEALTHCHECK_DEADLINE_MS + 500;

/**
 * The line of that verdict, in words of its own: in `docker inspect` a hang
 * outside the read must not look like a Redis that kept silent, nor carry the
 * read's duration.
 */
export const HEALTHCHECK_BACKSTOP_REASON = `no verdict within ${HEALTHCHECK_BACKSTOP_MS} ms, stuck outside the redis read`;

/** What `get` settled with, so a hang, a refusal and a value stay apart. */
type StampRead =
  | { kind: "stamp"; stamp: string | null }
  | { kind: "failed"; error: unknown }
  | { kind: "timeout" };

/**
 * Reads the stamp under a deadline and answers with a verdict, never with a
 * hang: a Redis that accepts the connection and never replies leaves `get`
 * pending forever, and only the deadline turns that into an answer.
 */
export async function runHealthcheck(
  options: HealthcheckRunOptions,
): Promise<HealthcheckVerdict> {
  const read = (): Promise<StampRead> =>
    options.redis.get(WORKER_HEARTBEAT_KEY).then(
      (stamp): StampRead => ({ kind: "stamp", stamp }),
      (error: unknown): StampRead => ({ kind: "failed", error }),
    );
  // Live: in the healthcheck process the deadline is the verdict, and a loop
  // that ran empty must not end the process before it is written.
  const outcome = await settleWithin<StampRead, StampRead>(
    read,
    options.deadlineMs,
    { kind: "timeout" },
    { unref: false },
  );

  if (outcome.kind === "timeout") {
    return {
      healthy: false,
      reason: `no answer from redis within ${options.deadlineMs} ms`,
    };
  }
  if (outcome.kind === "failed") {
    const message =
      outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error);
    return { healthy: false, reason: `redis unreachable: ${message}` };
  }

  const { stamp } = outcome;
  const reading = readHeartbeat(stamp, options.now());
  const reason =
    stamp === null
      ? "no heartbeat stamp in redis"
      : reading.heartbeatAt === null
        ? "heartbeat stamp is not a date"
        : `last heartbeat at ${reading.heartbeatAt}`;
  return { healthy: !reading.stale, reason };
}
