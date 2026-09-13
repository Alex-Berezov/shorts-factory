import {
  type BudgetMeasure,
  type BudgetPeriod,
  type Provider,
  ValidationError,
} from "@sf/core";
import { and, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { apiUsageLog } from "../schema/system.js";

/**
 * Window options for the aggregate. The time zone is the caller's decision,
 * not the repository's: the YouTube quota resets at midnight in
 * `America/Los_Angeles` (docs/31_E1_TASKS.md), while the money budgets are our
 * own.
 */
export interface UsagePeriodOptions {
  /** IANA name, e.g. "America/Los_Angeles". Rejected by Postgres if unknown. */
  timeZone?: string;
  /**
   * The moment the window ends and whose day or month it belongs to. When it
   * is left out the database clock is used, not the process one. A past `now`
   * therefore reports that past period only, which is what a recount of a
   * historical day needs.
   */
  now?: Date;
}

/**
 * The part of a `Db` an aggregate needs: one `select`.
 *
 * Narrower than `Db` on purpose. A drizzle transaction handle is not a `Db` -
 * it has no `$client` - but it is a query builder on the connection inside the
 * transaction, and that is the one place the total has to be answerable from:
 * a guard asked in the middle of a unit of work would otherwise have to open a
 * second connection to ask what has been spent.
 */
export type UsageQuerier = Pick<Db, "select">;

/** One row of `api_usage_log` as a caller may write it. */
export type ApiUsageInsert = Omit<
  typeof apiUsageLog.$inferInsert,
  "id" | "createdAt" | "provider"
> & { provider: Provider };

/**
 * What to sum: the rows, the column and the window.
 *
 * Structurally the same three fields as a `BudgetScope` of `@sf/core` (which
 * satisfies this type and can be passed straight in), minus the `key` - the
 * repository counts rows and has no opinion on which cap the total is for.
 *
 * `providers` is a list rather than one name because the caps are not one per
 * provider: the monthly TTS budget covers four vendors at once, and an
 * aggregate over a single one of them would report a quarter of the spend.
 */
export interface UsageAggregate {
  readonly providers: readonly Provider[];
  readonly measure: BudgetMeasure;
  readonly period: BudgetPeriod;
}

const DEFAULT_TIME_ZONE = "UTC";

/**
 * The column each measure is counted in, and with it the name used in the
 * failure messages below: one lookup, so a caller cannot ask for units and be
 * told about `cost_usd`.
 */
const MEASURE_COLUMN = {
  units: apiUsageLog.units,
  usd: apiUsageLog.costUsd,
} as const satisfies Record<
  BudgetMeasure,
  typeof apiUsageLog.units | typeof apiUsageLog.costUsd
>;

/**
 * The half-open-in-spirit window `[start of the day or month in `timeZone`,
 * now]`. Both ends are computed by Postgres: doing it in JavaScript would mean
 * re-implementing the DST rules that the database already knows, and an
 * unknown zone name would silently fall back to UTC instead of failing.
 *
 * The period unit travels as a bound parameter, and that is not a workaround
 * for an identifier that could not be bound: `date_trunc(text, timestamptz)`
 * takes the unit as an ordinary `text` argument, so `$1::text` is what the
 * function signature asks for. The value is one of two internal literals
 * either way (`BudgetPeriod`), so there is nothing here for a caller to inject
 * into.
 */
function periodWindow(unit: BudgetPeriod, opts: UsagePeriodOptions) {
  const timeZone = opts.timeZone ?? DEFAULT_TIME_ZONE;
  // Without an explicit moment the window ends at the database clock, the same
  // one that stamps `created_at`. Taking it from the process instead would
  // drop the rows written in the interval a lagging clock has not reached yet
  // (separate container, VPS, a host waking from sleep), and the budget guard
  // would see less spent than there is.
  //
  // `statement_timestamp()`, not `now()`: `now()` is `transaction_timestamp()`
  // and freezes at the moment a transaction started, so a guard called inside
  // `db.transaction` would end its window before every row committed since -
  // an under-reported spend at exactly the place that decides whether to spend
  // more (docs/TECH_DEBT.md, 06.09.2026). It advances on every statement, so
  // that property holds for this query too.
  //
  // And not `clock_timestamp()`, which has the same property: that one is
  // VOLATILE, and Postgres will not use a volatile expression as a key of an
  // index scan - the bound would degrade into a filter and every aggregate
  // would read the whole history of the provider (decision of 13.09.2026).
  // `statement_timestamp()` is STABLE, which is what
  // `api_usage_provider_created_idx` needs to be walked by both columns.
  const instant =
    opts.now === undefined
      ? sql`statement_timestamp()`
      : sql`${opts.now.toISOString()}::timestamptz`;
  return {
    start: sql`(date_trunc(${unit}::text, ${instant} AT TIME ZONE ${timeZone}::text) AT TIME ZONE ${timeZone}::text)`,
    end: instant,
  };
}

/**
 * `sum()` comes back as a string (bigint and numeric are not JavaScript
 * numbers) and as `null` when the window holds no rows. Every other shape is
 * an error rather than a quietly reported "nothing spent" - including
 * `undefined`, which is not an empty window but a missing field: an aggregate
 * whose alias was renamed would otherwise report zero spend forever.
 */
function toTotal(value: unknown, column: string): number {
  if (value === null) {
    return 0;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const total = Number(value);
    if (!Number.isFinite(total)) {
      throw new Error(`api_usage_log.${column}: unexpected sum "${value}"`);
    }
    return total;
  }
  if (value === undefined) {
    throw new Error(
      `api_usage_log.${column}: aggregate row has no total field`,
    );
  }
  throw new Error(
    `api_usage_log.${column}: unexpected sum of type ${typeof value}`,
  );
}

/**
 * Thin access to `api_usage_log`: one insert and one total. No business rules
 * here - the budget guard (`src/budget.ts`) decides what an exhausted cap
 * means.
 *
 * The provider is a `Provider` (`@sf/core`) rather than a free string, even
 * though the column is `text`: a misspelt name is indistinguishable from "no
 * spend at all" here, and the aggregate would answer 0 while the money or the
 * quota went out.
 */
export const apiUsageLogRepo = {
  /**
   * `createdAt` is not part of the entry on purpose: the column defaults to
   * `now()` of the database, and the aggregate ends its window on the same
   * clock. A caller stamping the row from its own process (natural for
   * `createUsageLogger`) would put the call outside the window whenever that
   * clock runs ahead - the budget guard would then see less spent than there
   * is and let a call past an exhausted cap. Backdated rows (a historical
   * import) go through a migration, not through this method.
   *
   * `id` is excluded for the same class of reason: it is a `serial`, and a
   * value supplied by hand bypasses the sequence and collides with it later.
   */
  async insert(db: Db, entry: ApiUsageInsert): Promise<void> {
    await db.insert(apiUsageLog).values(entry);
  },

  /**
   * What the given providers spent in the current day or month of the given
   * time zone - units or dollars, whichever the aggregate asks for.
   *
   * An empty `providers` is refused rather than answered with 0: the only ways
   * to get here with one are a scope built by hand and a filter that removed
   * every name, and both are callers asking the wrong question. Returning zero
   * would answer "nothing spent" and let every call past the cap.
   */
  async sumUsage(
    db: UsageQuerier,
    aggregate: UsageAggregate,
    opts: UsagePeriodOptions = {},
  ): Promise<number> {
    if (aggregate.providers.length === 0) {
      throw new ValidationError(
        "usage aggregate needs at least one provider to sum",
        { measure: aggregate.measure, period: aggregate.period },
      );
    }

    const column = MEASURE_COLUMN[aggregate.measure];
    const window = periodWindow(aggregate.period, opts);

    const rows = await db
      .select({ total: sql<string | null>`sum(${column})` })
      .from(apiUsageLog)
      .where(
        and(
          inArray(apiUsageLog.provider, [...aggregate.providers]),
          gte(apiUsageLog.createdAt, window.start),
          // Closed at `now` as well: without it "today" for a past `now` means
          // "that day and everything after it", turning a historical recount
          // (E13 api_usage_daily) into a running total.
          lte(apiUsageLog.createdAt, window.end),
        ),
      );

    const row = rows[0];
    if (row === undefined) {
      throw new Error(
        `api_usage_log.${column.name}: aggregate returned no row`,
      );
    }
    return toTotal(row.total, column.name);
  },
};
