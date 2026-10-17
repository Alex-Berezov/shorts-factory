import type { ApiUsageEntry, UsageLogger } from "@sf/core";
import {
  type ApiUsageInsert,
  type BudgetGuard,
  closeDb,
  createDb,
  toUsageRow,
} from "@sf/db";
import { Redis } from "ioredis";
import { expect, vi } from "vitest";
import type { JobRuntimeDeps } from "../src/lib/define-job.js";

/**
 * The dependencies of a job run that most tests are not about: the two
 * connections, the budget guard and the usage logger.
 *
 * The guard and the logger refuse rather than pretend by default. A test that
 * does not expect a job to spend anything should fail if it does - a silently
 * permissive guard would make "the cap was never asked" indistinguishable from
 * "the cap said yes", which is the one difference this epic exists for.
 */
export function unusedBudget(): BudgetGuard {
  return {
    check: vi.fn(async () => {
      expect.unreachable("this job was not supposed to ask about a budget");
    }),
    assert: vi.fn(async () => {
      expect.unreachable("this job was not supposed to ask about a budget");
    }),
  };
}

/**
 * A usage logger that records the rows it would write instead of writing them.
 *
 * The entry goes through `toUsageRow` on the way in - the same function
 * `createUsageLogger` turns an entry into a row with, not a second parse: a
 * job that reported spend the real logger would refuse - a paid provider
 * without `costUsd`, units on a provider that has none - fails its test here
 * with the error the real logger throws (`ValidationError`, issues without
 * the rejected value), rather than at the first live run.
 *
 * What is recorded is the row `toUsageRow` returned, not the entry the job
 * passed: the parsed values with the job stamped in, as `api_usage_log` would
 * hold them - so a change the job makes to its object after logging it is
 * not what a test asserts on.
 */
export function recordingUsage(): {
  createUsage: (jobId?: string) => UsageLogger;
  rows: ApiUsageInsert[];
} {
  const rows: ApiUsageInsert[] = [];
  return {
    rows,
    createUsage:
      (jobId?: string): UsageLogger =>
      async (entry: ApiUsageEntry) => {
        rows.push(toUsageRow(entry, jobId === undefined ? {} : { jobId }));
      },
  };
}

/** The two connections of `unusedConnections`, and how to let go of them. */
export interface UnusedConnections
  extends Pick<JobRuntimeDeps, "db" | "redis"> {
  close(): Promise<void>;
}

/**
 * The two connections a processor carries to its handler, for the tests whose
 * handlers never touch them.
 *
 * Real objects rather than a cast: `Db` and `Redis` are types nobody can write
 * out honestly by hand, and a cast to them is the same hole whichever spelling
 * it takes. Neither opens a socket - postgres-js connects on the first query
 * and ioredis is created with `lazyConnect` - so a handler that did reach for
 * one would fail loudly instead of reading a fake answer.
 *
 * A new pair on every call, closed by the caller (`afterAll` of its file):
 * nothing is kept by this module, so a pool that did open is closed by the
 * file that opened it instead of outliving the run.
 */
export function unusedConnections(): UnusedConnections {
  const db = createDb("postgres://sf:sf@127.0.0.1:5442/unused", { max: 1 });
  const redis = new Redis({ lazyConnect: true, port: 6399 });
  return {
    db,
    redis,
    close: async () => {
      redis.disconnect();
      await closeDb(db);
    },
  };
}
