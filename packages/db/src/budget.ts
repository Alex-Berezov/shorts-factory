import {
  BUDGET_CACHE_TTL_SEC,
  type BudgetCacheValue,
  BudgetCacheValueSchema,
  BudgetExceededError,
  type BudgetScope,
  type BudgetState,
  type Provider,
  ValidationError,
  budgetCacheKey,
  budgetScopeFor,
  budgetState,
} from "@sf/core";
import type { Db } from "./client.js";
import { apiUsageLogRepo } from "./repos/api-usage-log.js";

/**
 * The caps, as the guard needs them.
 *
 * Structurally the `Limits` of `@sf/config`, which can be passed straight in -
 * but written out here, because the library side of `@sf/db` does not read
 * configuration (ADR-0002). The caller decides where the numbers come from:
 * the environment in a running service, a literal in a test.
 */
export interface BudgetLimits {
  readonly youtubeUnitsDailySoftCap: number;
  readonly geminiDailyBudgetUsd: number;
  readonly ttsMonthlyBudgetUsd: number;
}

/**
 * Where a computed total may be parked for a minute.
 *
 * A port, not a Redis client: `@sf/db` must not depend on `ioredis` (ADR-0002)
 * and the api builds a guard with no cache at all. The worker passes an
 * adapter over its own connection (`apps/worker/src/lib/budget.ts`).
 */
export interface BudgetCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
}

/** The part of a pino logger the guard writes to. */
export interface BudgetLogger {
  warn(obj: object, msg: string): void;
}

/** Where one cap stands, and against what. */
export interface BudgetCheck extends BudgetState {
  /** The cap this answer is about - measure, period and the rows it sums. */
  scope: BudgetScope;
  /** Spent in the period, in the measure of the scope. */
  spent: number;
  cap: number;
}

export interface BudgetGuardOptions {
  db: Db;
  limits: BudgetLimits;
  /** Optional: without it every check counts from the database. */
  cache?: BudgetCache;
  /** Seam for tests; the default is the clock of the database. */
  now?: () => Date;
  log?: BudgetLogger;
}

export interface BudgetGuard {
  /**
   * Where the cap of this provider stands, or `null` when it has none yet.
   * Asks, never refuses - this is what `/system/status` is built from.
   */
  check(provider: Provider): Promise<BudgetCheck | null>;
  /**
   * The same question, asked before spending: throws `BudgetExceededError`
   * when the cap is reached.
   */
  assert(provider: Provider): Promise<BudgetCheck>;
}

/**
 * The budget fuse: one place that knows which cap a provider spends against,
 * what has been spent and whether the next call may happen.
 *
 * It lives in `@sf/db` because both processes need the same answer - the
 * worker before a paid call, the api for `/system/status` - and the one thing
 * they must not do is each keep their own idea of which cap covers which
 * provider. Everything a database package should not know is a parameter:
 * `limits` instead of `@sf/config`, a `cache` port instead of `ioredis`.
 *
 * **The cache is not a cache of the answer.** A total is reused only while the
 * state it was written in was below the warning share, and only if it is still
 * below it against the current cap; at or past that share every check counts
 * from the database again. That is where the minute of staleness would
 * actually cost money: with a fan-out of paid jobs running two at a time per
 * queue, a stale total near the cap lets a whole window of calls through.
 * Below the warning share there is no cap to run past, and the spend table is
 * left alone.
 *
 * A cache that fails is not an outage of the guard: the total is counted from
 * the database and the failure is logged. The opposite - refusing to answer
 * because Redis is down - would stop the pipeline over a cache.
 */
export function createBudgetGuard(options: BudgetGuardOptions): BudgetGuard {
  const { db, limits, cache, log } = options;

  const capOf = (scope: BudgetScope): number => {
    // Exhaustive over `BudgetScopeKey`: a cap added to `@sf/core` without a
    // number here fails to compile, instead of reading as "no limit".
    switch (scope.key) {
      case "youtube_data_units_day":
        return limits.youtubeUnitsDailySoftCap;
      case "gemini_usd_day":
        return limits.geminiDailyBudgetUsd;
      case "tts_usd_month":
        return limits.ttsMonthlyBudgetUsd;
    }
  };

  // The zone comes from the cap, never from this call: the YouTube day ends at
  // midnight Pacific and the money days end in UTC, and a guard holding one
  // zone for all three would have to get one of them wrong (decision of
  // 13.09.2026). Only the clock is a seam, and only for tests.
  const periodOptions = (scope: BudgetScope) => ({
    timeZone: scope.timeZone,
    ...(options.now === undefined ? {} : { now: options.now() }),
  });

  /** A total good enough to answer with, or `null` to go and count. */
  const cachedSpend = async (
    scope: BudgetScope,
    cap: number,
  ): Promise<BudgetCheck | null> => {
    if (cache === undefined) {
      return null;
    }
    let raw: string | null;
    try {
      raw = await cache.get(budgetCacheKey(scope.key));
    } catch (err) {
      log?.warn({ err, scope: scope.key }, "budget cache read failed");
      return null;
    }
    if (raw === null) {
      return null;
    }

    const parsed = readCachedSpend(raw);
    if (parsed === null) {
      log?.warn({ scope: scope.key }, "budget cache value is not readable");
      return null;
    }
    if (parsed.warn) {
      // It was already close to the cap when it was written, so the answer has
      // to be current.
      return null;
    }

    const state = budgetState({ spent: parsed.spent, cap });
    if (state.warn) {
      // The cap moved down under a total that used to be comfortable.
      return null;
    }
    return { scope, spent: parsed.spent, cap, ...state };
  };

  const countSpend = async (
    scope: BudgetScope,
    cap: number,
  ): Promise<BudgetCheck> => {
    const spent = await apiUsageLogRepo.sumUsage(
      db,
      scope,
      periodOptions(scope),
    );
    const state = budgetState({ spent, cap });

    if (cache !== undefined) {
      try {
        await cache.set(
          budgetCacheKey(scope.key),
          JSON.stringify({ spent, warn: state.warn }),
          BUDGET_CACHE_TTL_SEC,
        );
      } catch (err) {
        // Written even when the state warns, so that a reader of the key sees
        // the same spend the guard did; failing to write it changes nothing
        // about the answer.
        log?.warn({ err, scope: scope.key }, "budget cache write failed");
      }
    }

    return { scope, spent, cap, ...state };
  };

  return {
    async check(provider: Provider): Promise<BudgetCheck | null> {
      const scope = budgetScopeFor(provider);
      if (scope === null) {
        return null;
      }
      return countOrCached(scope, capOf(scope));
    },

    async assert(provider: Provider): Promise<BudgetCheck> {
      const scope = budgetScopeFor(provider);
      if (scope === null) {
        // Not "nothing stops you": a provider with no cap has no fuse, and
        // asking a fuse that was never installed to clear a call is the
        // caller's mistake. Whoever spends on such a provider says so
        // explicitly until the cap exists (`youtube_analytics` - E7-01).
        throw new ValidationError("provider has no budget cap to assert", {
          provider,
        });
      }

      const check = await countOrCached(scope, capOf(scope));
      if (check.exceeded) {
        throw new BudgetExceededError(
          `${scope.key}: cap reached, refusing the call`,
          { provider, spent: check.spent, cap: check.cap },
        );
      }
      return check;
    },
  };

  async function countOrCached(
    scope: BudgetScope,
    cap: number,
  ): Promise<BudgetCheck> {
    return (await cachedSpend(scope, cap)) ?? (await countSpend(scope, cap));
  }
}

/**
 * The cached total, or `null` for anything that is not one. Unparseable JSON
 * and a value of the wrong shape are both cache misses: the guard counts again
 * rather than comparing a cap against whatever was in the key.
 */
function readCachedSpend(raw: string): BudgetCacheValue | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = BudgetCacheValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
