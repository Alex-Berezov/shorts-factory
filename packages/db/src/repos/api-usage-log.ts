import type { Provider } from "@sf/core";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { apiUsageLog } from "../schema/system.js";

/**
 * Window options for the aggregates. The time zone is the caller's decision,
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

const DEFAULT_TIME_ZONE = "UTC";

/**
 * The half-open-in-spirit window `[start of the day or month in `timeZone`,
 * now]`. Both ends are computed by Postgres: doing it in JavaScript would mean
 * re-implementing the DST rules that the database already knows, and an
 * unknown zone name would silently fall back to UTC instead of failing.
 */
function periodWindow(unit: "day" | "month", opts: UsagePeriodOptions) {
  const timeZone = opts.timeZone ?? DEFAULT_TIME_ZONE;
  // Without an explicit moment the window ends at `now()` of the database, the
  // same clock that stamps `created_at`. Taking it from the process instead
  // would drop the rows written in the interval a lagging clock has not
  // reached yet (separate container, VPS, a host waking from sleep), and the
  // budget guard (E0-09) would see less spent than there is.
  const instant =
    opts.now === undefined
      ? sql`now()`
      : sql`${opts.now.toISOString()}::timestamptz`;
  return {
    start: sql`(date_trunc(${unit}::text, ${instant} AT TIME ZONE ${timeZone}::text) AT TIME ZONE ${timeZone}::text)`,
    end: instant,
  };
}

/**
 * `sum()` comes back as a string (bigint and numeric are not JavaScript
 * numbers) and as `null` when the window holds no rows. Both are handled
 * explicitly: an empty window is a real zero, anything unparseable is an error
 * rather than a quietly reported "nothing spent".
 */
function toTotal(value: unknown, column: string): number {
  if (value === null || value === undefined) {
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
  throw new Error(
    `api_usage_log.${column}: unexpected sum of type ${typeof value}`,
  );
}

async function sumWindow(
  db: Db,
  column: typeof apiUsageLog.units | typeof apiUsageLog.costUsd,
  name: string,
  provider: Provider,
  window: ReturnType<typeof periodWindow>,
): Promise<number> {
  const rows = await db
    .select({ total: sql<string | null>`sum(${column})` })
    .from(apiUsageLog)
    .where(
      and(
        eq(apiUsageLog.provider, provider),
        gte(apiUsageLog.createdAt, window.start),
        // Closed at `now` as well: without it "today" for a past `now` means
        // "that day and everything after it", turning a historical recount
        // (E13 api_usage_daily) into a running total.
        lte(apiUsageLog.createdAt, window.end),
      ),
    );

  const row = rows[0];
  if (row === undefined) {
    throw new Error(`api_usage_log.${name}: aggregate returned no row`);
  }
  return toTotal(row.total, name);
}

/**
 * Thin access to `api_usage_log`: one insert and the three totals the budget
 * guard (E0-09) compares against `limits`. No business rules here - the guard
 * decides what an exceeded budget means.
 *
 * The provider is a `Provider` (`@sf/core`) rather than a free string, even
 * though the column is `text`: a misspelt name is indistinguishable from "no
 * spend at all" here, and every aggregate would answer 0 while the money or
 * the quota went out.
 */
export const apiUsageLogRepo = {
  /**
   * `createdAt` is not part of the entry on purpose: the column defaults to
   * `now()` of the database, and the aggregates end their window on the same
   * clock. A caller stamping the row from its own process (natural for
   * `createUsageLogger` in E0-09) would put the call outside the window
   * whenever that clock runs ahead - the budget guard would then see less
   * spent than there is and let a call past an exhausted cap. Backdated rows
   * (a historical import) go through a migration, not through this method.
   */
  async insert(
    db: Db,
    entry: Omit<typeof apiUsageLog.$inferInsert, "createdAt" | "provider"> & {
      provider: Provider;
    },
  ): Promise<void> {
    await db.insert(apiUsageLog).values(entry);
  },

  /** YouTube quota units spent by `provider` between the start of its day and `now`. */
  async sumUnitsToday(
    db: Db,
    provider: Provider,
    opts: UsagePeriodOptions = {},
  ): Promise<number> {
    return sumWindow(
      db,
      apiUsageLog.units,
      "units",
      provider,
      periodWindow("day", opts),
    );
  },

  /** Dollars spent by `provider` between the start of its day and `now`. */
  async sumCostUsdToday(
    db: Db,
    provider: Provider,
    opts: UsagePeriodOptions = {},
  ): Promise<number> {
    return sumWindow(
      db,
      apiUsageLog.costUsd,
      "cost_usd",
      provider,
      periodWindow("day", opts),
    );
  },

  /** Dollars spent by `provider` between the start of its month and `now`. */
  async sumCostUsdThisMonth(
    db: Db,
    provider: Provider,
    opts: UsagePeriodOptions = {},
  ): Promise<number> {
    return sumWindow(
      db,
      apiUsageLog.costUsd,
      "cost_usd",
      provider,
      periodWindow("month", opts),
    );
  },
};
