import {
  type ApiUsageEntry,
  ApiUsageEntrySchema,
  type UsageLogger,
  ValidationError,
} from "@sf/core";
import type { Db } from "./client.js";
import { type ApiUsageInsert, apiUsageLogRepo } from "./repos/api-usage-log.js";

/** Decimal places of `api_usage_log.cost_usd` (`numeric(10, 5)`). */
const COST_SCALE = 1e5;
const COST_DECIMALS = 5;

/**
 * Significant digits kept before rounding up. A product of two doubles carries
 * binary noise in the last places - `0.0001 * 1e5` is `10.000000000000002` -
 * and rounding that up directly turns a hundredth of a cent into a tenth of
 * one, ten per cent above the real price on every such call. Twelve digits is
 * far below the noise (a double holds about sixteen) and far above the five
 * decimals the column keeps.
 */
const COST_PRECISION = 12;

/**
 * `costUsd` as the `numeric(10, 5)` column takes it: a string, rounded **up**
 * to five decimals.
 *
 * Up, not to the nearest: the number this produces is what a cap is compared
 * against, and a cap may never be shown less than was really spent. `toFixed`
 * alone would round a call of $0.000004 down to zero - and a batch of cheap
 * calls to "nothing spent at all", which is exactly how a budget guard lets
 * spending run past its cap (docs/TECH_DEBT.md, 07.09.2026). What the rounding
 * costs instead is under $0.00001 per call, in our favour.
 *
 * Zero stays zero: a call that really was free must not be recorded as the
 * smallest unit of money, or every free call would count against a budget.
 */
export function toCostUsdColumn(costUsd: number | undefined): string | null {
  if (costUsd === undefined) {
    return null;
  }
  const scaled = Number((costUsd * COST_SCALE).toPrecision(COST_PRECISION));
  return (Math.ceil(scaled) / COST_SCALE).toFixed(COST_DECIMALS);
}

export interface UsageLoggerOptions {
  /**
   * The job every row of this logger belongs to. Filled in for entries that
   * do not carry one - a client deep inside a handler knows what it spent, not
   * which job is running it.
   */
  jobId?: string;
}

/**
 * A validated entry as the table takes it: the measure fields explicit, the
 * price a string, no stamp of our own.
 *
 * Pure and exported, because everything that can go wrong between a provider
 * response and a row of `api_usage_log` happens here - a paid call recorded
 * without a price, a cheap call rounded away, a job lost from the row - and
 * none of it needs a database to be shown.
 */
export function toUsageRow(
  entry: ApiUsageEntry,
  options: UsageLoggerOptions = {},
): ApiUsageInsert {
  const parsed = ApiUsageEntrySchema.safeParse(entry);
  if (!parsed.success) {
    // Where and what, never the value: for a discriminated union, an enum or a
    // literal zod puts the rejected value into the issue, and an entry carries
    // the identifiers of a provider call.
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
    }));
    throw new ValidationError(
      `api usage entry rejected by its schema (${issues.length} issue(s))`,
      { issues },
    );
  }

  const usage = parsed.data;

  return {
    provider: usage.provider,
    operation: usage.operation,
    // `undefined` is not `null` for the driver under
    // `exactOptionalPropertyTypes`, and a column left out of an insert is not
    // the same row as a column written as NULL.
    units: usage.units ?? null,
    tokensIn: usage.tokensIn ?? null,
    tokensOut: usage.tokensOut ?? null,
    costUsd: toCostUsdColumn(usage.costUsd),
    // The job of the entry wins: a client replaying the call of another job
    // knows which one it is spending for, the factory only knows who built it.
    jobId: usage.jobId ?? options.jobId ?? null,
  };
}

/**
 * The `UsageLogger` of `@sf/core`, writing to `api_usage_log`.
 *
 * Every priced call goes through here, which makes this the one place where
 * "what the provider answered" becomes "what we spent". Three things happen,
 * and each of them is the reason the logger exists rather than the insert
 * being called directly:
 *
 * - the entry is **parsed, not trusted**: it is assembled from a provider
 *   response, so the rule that gives it a measure at all ("units for YouTube,
 *   dollars for the paid vendors") has to hold at runtime and not only in the
 *   types of whoever built it. A row with no measure is spend that no
 *   aggregate ever sums;
 * - `costUsd` is **mapped to the column** - a `number` against `numeric`, and
 *   rounded up (see above);
 * - the job is **stamped**, so that a row can be traced back to the run that
 *   made the call.
 *
 * What it deliberately does not do is deduplicate. `api_usage_log` is a
 * journal of calls that were made, not of calls that were intended: a handler
 * re-run after a crash makes the external call a second time and is charged a
 * second time, so the second row is the truth. Not paying twice is the job of
 * the handler (checking for its artefact before calling), not of the journal -
 * and a unique key here would reject the legitimate case of one job making
 * several calls of the same kind (a batch of `videos.list` pages).
 */
export function createUsageLogger(
  db: Db,
  options: UsageLoggerOptions = {},
): UsageLogger {
  return async (entry: ApiUsageEntry): Promise<void> => {
    await apiUsageLogRepo.insert(db, toUsageRow(entry, options));
  };
}
