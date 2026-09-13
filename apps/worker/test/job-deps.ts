import {
  type ApiUsageEntry,
  ApiUsageEntrySchema,
  type UsageLogger,
} from "@sf/core";
import { type BudgetCheck, type BudgetGuard, createDb } from "@sf/db";
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

/** A guard that always clears the call, with the answer a caller may read. */
export function allowingBudget(check: BudgetCheck): BudgetGuard {
  return {
    check: async () => check,
    assert: async () => check,
  };
}

/**
 * A usage logger that records the entries instead of writing them.
 *
 * The entry is parsed on the way in, exactly as `createUsageLogger` parses it
 * before it writes: a job that reported spend the real logger would refuse -
 * a paid provider without `costUsd`, units on a provider that has none - has
 * to fail its test here rather than at the first live run.
 */
export function recordingUsage(): {
  createUsage: (jobId?: string) => UsageLogger;
  entries: Array<{ jobId: string | undefined; entry: ApiUsageEntry }>;
} {
  const entries: Array<{ jobId: string | undefined; entry: ApiUsageEntry }> =
    [];
  return {
    entries,
    createUsage:
      (jobId?: string): UsageLogger =>
      async (entry: ApiUsageEntry) => {
        entries.push({ jobId, entry: ApiUsageEntrySchema.parse(entry) });
      },
  };
}

/**
 * The two connections a processor carries to its handler, for the tests whose
 * handlers never touch them.
 *
 * Real objects rather than a cast: `Db` and `Redis` are types nobody can write
 * out honestly by hand, and a cast to them is the same hole whichever spelling
 * it takes. Neither opens a socket - postgres-js connects on the first query
 * and ioredis is created with `lazyConnect` - so a handler that did reach for
 * one would fail loudly instead of reading a fake answer. Built once for the
 * file: nothing here holds state a test could see.
 */
let connections: Pick<JobRuntimeDeps, "db" | "redis"> | undefined;

export function unusedConnections(): Pick<JobRuntimeDeps, "db" | "redis"> {
  connections ??= {
    db: createDb("postgres://sf:sf@127.0.0.1:5442/unused", { max: 1 }),
    redis: new Redis({ lazyConnect: true, port: 6399 }),
  };
  return connections;
}
