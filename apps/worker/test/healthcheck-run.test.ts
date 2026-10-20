import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SEC } from "@sf/core";
import { describe, expect, it } from "vitest";
import {
  HEALTHCHECK_BACKSTOP_MS,
  HEALTHCHECK_BACKSTOP_REASON,
  HEALTHCHECK_DEADLINE_MS,
  type HealthcheckRedis,
  runHealthcheck,
} from "../src/cli/healthcheck-run.js";

/**
 * The verdicts of the container healthcheck, without a process or a Redis.
 * The texts are the ones `healthcheck.int.test.ts` reads off stdout of the
 * real command; here every branch, including a Redis that never answers, is
 * reached in milliseconds.
 */
const NOW = new Date("2026-10-10T12:00:00.000Z");
const DEADLINE_MS = 1_000;

function stampAgo(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1_000).toISOString();
}

/** Answers every `get` with `stamp` and records the keys asked for. */
function redisWith(stamp: string | null): HealthcheckRedis & {
  keys: string[];
} {
  const keys: string[] = [];
  return {
    keys,
    get: async (key: string) => {
      keys.push(key);
      return stamp;
    },
  };
}

describe("runHealthcheck", () => {
  it("is healthy on a fresh stamp read from the heartbeat key", async () => {
    const stamp = stampAgo(30);
    const redis = redisWith(stamp);

    await expect(
      runHealthcheck({ redis, now: () => NOW, deadlineMs: DEADLINE_MS }),
    ).resolves.toEqual({
      healthy: true,
      reason: `last heartbeat at ${stamp}`,
    });
    expect(redis.keys).toEqual([WORKER_HEARTBEAT_KEY]);
  });

  it("is unhealthy on a stamp older than the TTL, and says the worker stopped", async () => {
    const stamp = stampAgo(WORKER_HEARTBEAT_TTL_SEC + 1);

    await expect(
      runHealthcheck({
        redis: redisWith(stamp),
        now: () => NOW,
        deadlineMs: DEADLINE_MS,
      }),
    ).resolves.toEqual({
      healthy: false,
      reason: `last heartbeat ${WORKER_HEARTBEAT_TTL_SEC + 1} s ago at ${stamp}, worker stopped writing`,
    });
  });

  it("is unhealthy on a stamp further ahead of the clock than the TTL, and says the clocks disagree", async () => {
    const stamp = stampAgo(-(WORKER_HEARTBEAT_TTL_SEC + 1));

    await expect(
      runHealthcheck({
        redis: redisWith(stamp),
        now: () => NOW,
        deadlineMs: DEADLINE_MS,
      }),
    ).resolves.toEqual({
      healthy: false,
      reason: `heartbeat at ${stamp} is ${WORKER_HEARTBEAT_TTL_SEC + 1} s ahead of this clock, clocks disagree`,
    });
  });

  /** The reason the check gives for `stamp`. */
  const reasonOf = async (stamp: string): Promise<string> =>
    (
      await runHealthcheck({
        redis: redisWith(stamp),
        now: () => NOW,
        deadlineMs: DEADLINE_MS,
      })
    ).reason;

  it("counts whole seconds up either way: past the bound never prints the bound", async () => {
    const behind = stampAgo(WORKER_HEARTBEAT_TTL_SEC + 1.7);
    const ahead = stampAgo(-(WORKER_HEARTBEAT_TTL_SEC + 0.2));

    expect(await reasonOf(behind)).toBe(
      `last heartbeat ${WORKER_HEARTBEAT_TTL_SEC + 2} s ago at ${behind}, worker stopped writing`,
    );
    expect(await reasonOf(ahead)).toBe(
      `heartbeat at ${ahead} is ${WORKER_HEARTBEAT_TTL_SEC + 1} s ahead of this clock, clocks disagree`,
    );
  });

  it.each([
    [
      "behind",
      WORKER_HEARTBEAT_TTL_SEC + 0.4,
      (stamp: string) =>
        `last heartbeat ${WORKER_HEARTBEAT_TTL_SEC + 1} s ago at ${stamp}, worker stopped writing`,
    ],
    [
      "ahead",
      -(WORKER_HEARTBEAT_TTL_SEC + 0.4),
      (stamp: string) =>
        `heartbeat at ${stamp} is ${WORKER_HEARTBEAT_TTL_SEC + 1} s ahead of this clock, clocks disagree`,
    ],
  ])(
    "agrees with the verdict at the bound %s: the TTL exactly is fresh, 0.4 s past it is not and says so",
    async (_side, pastSec, reasonFor) => {
      const atBound = stampAgo(Math.sign(pastSec) * WORKER_HEARTBEAT_TTL_SEC);
      const past = stampAgo(pastSec);

      await expect(
        runHealthcheck({
          redis: redisWith(atBound),
          now: () => NOW,
          deadlineMs: DEADLINE_MS,
        }),
      ).resolves.toEqual({
        healthy: true,
        reason: `last heartbeat at ${atBound}`,
      });
      await expect(
        runHealthcheck({
          redis: redisWith(past),
          now: () => NOW,
          deadlineMs: DEADLINE_MS,
        }),
      ).resolves.toEqual({ healthy: false, reason: reasonFor(past) });
    },
  );

  it("calls a stamp within the TTL ahead of the clock fresh, in the words of a fresh one", async () => {
    const stamp = stampAgo(-(WORKER_HEARTBEAT_TTL_SEC - 1));

    await expect(
      runHealthcheck({
        redis: redisWith(stamp),
        now: () => NOW,
        deadlineMs: DEADLINE_MS,
      }),
    ).resolves.toEqual({
      healthy: true,
      reason: `last heartbeat at ${stamp}`,
    });
  });

  it("is unhealthy on a stamp that is not the writer's date", async () => {
    await expect(
      runHealthcheck({
        redis: redisWith("99999"),
        now: () => NOW,
        deadlineMs: DEADLINE_MS,
      }),
    ).resolves.toEqual({
      healthy: false,
      reason: "heartbeat stamp is not the worker's format",
    });
  });

  it("is unhealthy when there is no stamp", async () => {
    await expect(
      runHealthcheck({
        redis: redisWith(null),
        now: () => NOW,
        deadlineMs: DEADLINE_MS,
      }),
    ).resolves.toEqual({
      healthy: false,
      reason: "no heartbeat stamp in redis",
    });
  });

  it("is unhealthy and names the failure when the read is refused", async () => {
    const redis: HealthcheckRedis = {
      get: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:1");
      },
    };

    await expect(
      runHealthcheck({ redis, now: () => NOW, deadlineMs: DEADLINE_MS }),
    ).resolves.toEqual({
      healthy: false,
      reason: "redis unreachable: connect ECONNREFUSED 127.0.0.1:1",
    });
  });

  it("reads the clock only once Redis has answered", async () => {
    // The connect and the read may take most of the deadline; a clock read
    // before them would judge the stamp against a moment it was not seen at.
    const events: string[] = [];
    const stamp = stampAgo(30);
    const redis: HealthcheckRedis = {
      get: () =>
        new Promise<string | null>((resolve) => {
          setTimeout(() => {
            events.push("answered");
            resolve(stamp);
          }, 0);
        }),
    };

    await runHealthcheck({
      redis,
      now: () => {
        events.push("clock");
        return NOW;
      },
      deadlineMs: DEADLINE_MS,
    });

    expect(events).toEqual(["answered", "clock"]);
  });

  it("answers at its deadline when the read never settles", async () => {
    // A Redis that took the connection and never replies: `get` stays pending
    // forever, and the verdict has to come out anyway.
    const redis: HealthcheckRedis = {
      get: () => new Promise<string | null>(() => {}),
    };

    await expect(
      runHealthcheck({ redis, now: () => NOW, deadlineMs: 50 }),
    ).resolves.toEqual({
      healthy: false,
      reason: "no answer from redis within 50 ms",
    });
  });
});

describe("the healthcheck backstop", () => {
  it("comes after the read's deadline and says how long it really waited", () => {
    expect(HEALTHCHECK_DEADLINE_MS).toBe(5_000);
    expect(HEALTHCHECK_BACKSTOP_MS).toBe(5_500);
    expect(HEALTHCHECK_BACKSTOP_REASON).toContain(
      `within ${HEALTHCHECK_BACKSTOP_MS} ms`,
    );
    // Not the read's line: a hang elsewhere must not read as a silent Redis.
    expect(HEALTHCHECK_BACKSTOP_REASON).not.toMatch(/^no answer from redis/);
  });
});
