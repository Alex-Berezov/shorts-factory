import { randomUUID } from "node:crypto";
import { type Provider, ValidationError } from "@sf/core";
import { TransactionRollbackError, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type UsagePeriodOptions,
  type UsageQuerier,
  apiUsageLogRepo,
} from "../src/repos/api-usage-log.js";
import * as schema from "../src/schema/index.js";
import { apiUsageLog } from "../src/schema/system.js";
import { openTestSql, useTestDb } from "../test-support/fixture.js";

/**
 * Fixed instant, so day and month boundaries are asserted instead of waited
 * for. 20:00 UTC on 15 March 2026 is 13:00 in `America/Los_Angeles` (PDT):
 * the UTC day starts at 00:00Z, the Pacific day at 07:00Z, and the Pacific
 * month at 2026-03-01T08:00Z (still PST).
 */
const NOW = new Date("2026-03-15T20:00:00Z");
const PACIFIC = "America/Los_Angeles";
const PROVIDER = "youtube_data";

/** The three shapes the caps of E0-09 ask for, spelled once. */
const unitsToday = {
  providers: [PROVIDER],
  measure: "units",
  period: "day",
} as const;
const costToday = {
  providers: [PROVIDER],
  measure: "usd",
  period: "day",
} as const;
const costThisMonth = {
  providers: [PROVIDER],
  measure: "usd",
  period: "month",
} as const;

/** The daily Gemini cap and the monthly cap of the speech vendors, as in `@sf/core`. */
const GEMINI_DAY = {
  providers: ["gemini"],
  measure: "usd",
  period: "day",
  timeZone: "UTC",
} as const;
const TTS_MONTH = {
  providers: ["elevenlabs", "openai_tts", "google_tts", "cartesia"],
  measure: "usd",
  period: "month",
  timeZone: "UTC",
} as const;

const db = useTestDb({ beforeAll, afterAll });

beforeAll(async () => {
  const rows = [
    // today by UTC, yesterday by Pacific time
    { units: 10, costUsd: "0.10000", createdAt: "2026-03-15T03:00:00Z" },
    // today by both
    { units: 5, costUsd: "0.05000", createdAt: "2026-03-15T10:00:00Z" },
    // today by both, no money recorded at all
    { units: 3, costUsd: null, createdAt: "2026-03-15T11:00:00Z" },
    // yesterday by both, same month
    { units: 100, costUsd: "1.00000", createdAt: "2026-03-14T20:00:00Z" },
    // this month by UTC, previous month by Pacific time
    { units: 7, costUsd: "2.00000", createdAt: "2026-03-01T03:00:00Z" },
    // previous month by both
    { units: 1000, costUsd: "10.00000", createdAt: "2026-02-20T12:00:00Z" },
  ];

  // Backdated fixtures go in through the table, not through the repository:
  // `apiUsageLogRepo.insert` deliberately takes no `createdAt`, because the
  // production stamp belongs to the database clock.
  await db()
    .insert(apiUsageLog)
    .values(
      rows.map((row) => ({
        provider: PROVIDER,
        operation: "videos.list",
        units: row.units,
        costUsd: row.costUsd,
        createdAt: new Date(row.createdAt),
      })),
    );

  // another provider inside every window - must never be mixed in
  await db()
    .insert(apiUsageLog)
    .values({
      provider: "gemini",
      operation: "generateContent",
      units: 42,
      costUsd: "5.00000",
      createdAt: new Date("2026-03-15T10:00:00Z"),
    });
});

describe("apiUsageLogRepo.sumUsage", () => {
  it("sums today's units in UTC by default", async () => {
    expect(await apiUsageLogRepo.sumUsage(db(), unitsToday, { now: NOW })).toBe(
      18,
    );
  });

  it("moves the day boundary with the caller's time zone", async () => {
    expect(
      await apiUsageLogRepo.sumUsage(db(), unitsToday, {
        now: NOW,
        timeZone: PACIFIC,
      }),
    ).toBe(8);
  });

  it("sums today's cost, ignoring rows that recorded none", async () => {
    expect(
      await apiUsageLogRepo.sumUsage(db(), costToday, { now: NOW }),
    ).toBeCloseTo(0.15, 5);
    expect(
      await apiUsageLogRepo.sumUsage(db(), costToday, {
        now: NOW,
        timeZone: PACIFIC,
      }),
    ).toBeCloseTo(0.05, 5);
  });

  it("sums this month's cost and moves its boundary with the time zone", async () => {
    expect(
      await apiUsageLogRepo.sumUsage(db(), costThisMonth, { now: NOW }),
    ).toBeCloseTo(3.15, 5);
    expect(
      await apiUsageLogRepo.sumUsage(db(), costThisMonth, {
        now: NOW,
        timeZone: PACIFIC,
      }),
    ).toBeCloseTo(1.15, 5);
  });

  it("keeps providers apart", async () => {
    expect(
      await apiUsageLogRepo.sumUsage(
        db(),
        { providers: ["gemini"], measure: "units", period: "day" },
        { now: NOW },
      ),
    ).toBe(42);
    expect(
      await apiUsageLogRepo.sumUsage(
        db(),
        { providers: ["gemini"], measure: "usd", period: "month" },
        { now: NOW },
      ),
    ).toBeCloseTo(5, 5);
  });

  /**
   * The monthly TTS cap is one budget over four vendors, so the aggregate has
   * to be one total over four names. Summed per provider it would compare a
   * quarter of the spend against the whole cap and never fire.
   */
  it("sums a set of providers into a single total", async () => {
    const month = new Date("2026-05-20T12:00:00Z");
    const rows = [
      { provider: "elevenlabs", costUsd: "12.00000" },
      { provider: "openai_tts", costUsd: "3.50000" },
      { provider: "cartesia", costUsd: "0.25000" },
      // A fourth vendor of the same cap with nothing spent, and a provider
      // outside it that must not be picked up.
      { provider: "gemini", costUsd: "99.00000" },
    ];
    await db()
      .insert(apiUsageLog)
      .values(
        rows.map((row) => ({
          provider: row.provider,
          operation: "tts.synthesize",
          costUsd: row.costUsd,
          createdAt: new Date("2026-05-10T10:00:00Z"),
        })),
      );

    expect(
      await apiUsageLogRepo.sumUsage(
        db(),
        {
          providers: ["elevenlabs", "openai_tts", "google_tts", "cartesia"],
          measure: "usd",
          period: "month",
        },
        { now: month },
      ),
    ).toBeCloseTo(15.75, 5);
  });

  it("refuses an aggregate over no providers instead of reporting zero", async () => {
    // "Nothing to sum" is a caller that built the scope wrong, not a budget
    // with nothing spent - and answering 0 would let every call past the cap.
    await expect(
      apiUsageLogRepo.sumUsage(
        db(),
        { providers: [], measure: "usd", period: "day" },
        { now: NOW },
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("reports zero for a provider with no rows in the window", async () => {
    const none = { providers: ["elevenlabs"] } as const;

    expect(
      await apiUsageLogRepo.sumUsage(
        db(),
        { ...none, measure: "units", period: "day" },
        { now: NOW },
      ),
    ).toBe(0);
    expect(
      await apiUsageLogRepo.sumUsage(
        db(),
        { ...none, measure: "usd", period: "day" },
        { now: NOW },
      ),
    ).toBe(0);
    expect(
      await apiUsageLogRepo.sumUsage(
        db(),
        { ...none, measure: "usd", period: "month" },
        { now: NOW },
      ),
    ).toBe(0);
  });

  /**
   * `now` names the period being counted, so a past one must not pick up
   * everything recorded since - that is what a recount of a historical day or
   * month (E13 api_usage_daily) asks for.
   */
  it("counts the day of a past `now` and nothing after it", async () => {
    const yesterday = new Date("2026-03-14T23:00:00Z");

    expect(
      await apiUsageLogRepo.sumUsage(db(), unitsToday, { now: yesterday }),
    ).toBe(100);
    expect(
      await apiUsageLogRepo.sumUsage(db(), costToday, { now: yesterday }),
    ).toBeCloseTo(1, 5);
  });

  it("counts the month of a past `now` and nothing after it", async () => {
    expect(
      await apiUsageLogRepo.sumUsage(db(), costThisMonth, {
        now: new Date("2026-02-25T00:00:00Z"),
      }),
    ).toBeCloseTo(10, 5);
  });

  /**
   * `created_at` is written by Postgres, so the end of a window the caller did
   * not name has to come from Postgres too. The process clock is moved back a
   * minute here to stand for the drift a separate database container, a VPS or
   * a host waking from sleep produces: rows stamped by the database in that
   * gap must still be counted, or the budget guard - which calls the aggregate
   * without options - lets a call past an exhausted cap.
   */
  it("ends a window without `now` on the database clock, not the process one", async () => {
    // The other `cartesia` rows of this file are dated in May 2026 ("sums a
    // set of providers…"), outside today's window: the window below holds
    // exactly the row this case inserts.
    const provider = "cartesia";
    const scope = { providers: [provider] } as const;
    await apiUsageLogRepo.insert(db(), {
      provider,
      operation: "videos.list",
      units: 11,
      costUsd: "0.25000",
    });
    const databaseNow = await currentDatabaseTime();

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(databaseNow.getTime() - 60_000));

      expect(
        await apiUsageLogRepo.sumUsage(db(), {
          ...scope,
          measure: "units",
          period: "day",
        }),
      ).toBe(11);
      expect(
        await apiUsageLogRepo.sumUsage(db(), {
          ...scope,
          measure: "usd",
          period: "day",
        }),
      ).toBeCloseTo(0.25, 5);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The other half of the same rule, and the one the budget guard depends on:
   * `now()` is `transaction_timestamp()`, so a window ending on it freezes at
   * the moment the transaction started. A guard asked inside `db.transaction`
   * would then miss every row committed since - it would under-report the
   * spend at exactly the point where the decision to spend more is made.
   */
  it("counts a row committed after a transaction started", async () => {
    // Untouched by every other case here, so the totals below are these rows.
    const provider = "google_tts";
    const scope = {
      providers: [provider],
      measure: "usd",
      period: "day",
    } as const;

    await apiUsageLogRepo.insert(db(), {
      provider,
      operation: "tts.synthesize",
      costUsd: "4.00000",
    });

    const inside = await db().transaction(async (tx) => {
      // The transaction is open from here on, so `transaction_timestamp()` -
      // which is what `now()` returns - stops moving.
      await tx.execute(sql`select 1`);

      // Committed by another connection of the pool while it is open.
      await apiUsageLogRepo.insert(db(), {
        provider,
        operation: "tts.synthesize",
        costUsd: "3.00000",
      });

      // Asked through the transaction handle itself, which is what a guard
      // called in the middle of a unit of work would have.
      return apiUsageLogRepo.sumUsage(tx, scope);
    });

    expect(inside).toBeCloseTo(7, 5);
  });

  /**
   * Both generated columns are outside the entry type. `created_at` because
   * the stamp belongs to the database clock the window ends on; `id` because
   * it is a `serial` whose sequence a hand-written value walks past, colliding
   * with a later insert. The type keeps both out (the `@ts-expect-error` lines
   * below), and the row the repository writes carries the stamp of the
   * database: it falls between a `now()` read before the insert and the
   * `now()` of the count, both compared in SQL, so no clock of this process
   * and no millisecond rounding of a JS `Date` takes part.
   */
  it("stamps a row with the database clock; createdAt and id are not the caller's to give", async () => {
    // Written by no other case of this file - the count below is this row
    // alone.
    const provider = "youtube_analytics";

    const stampedByCaller: Parameters<typeof apiUsageLogRepo.insert>[1] = {
      provider,
      operation: "videos.list",
      units: 4,
      // @ts-expect-error `createdAt` is excluded from the entry type: rows are
      // stamped by the database clock the aggregate ends its window on.
      createdAt: new Date(0),
    };
    // A second object of the same type: an object literal reports only its
    // first excess property, so `id` next to `createdAt` would go unchecked.
    const numberedByCaller: Parameters<typeof apiUsageLogRepo.insert>[1] = {
      provider,
      operation: "videos.list",
      units: 4,
      // @ts-expect-error `id` is excluded as well: it comes from the
      // sequence of the `serial` column, never from a caller.
      id: 999_999,
    };
    void [stampedByCaller, numberedByCaller];

    const before = await databaseClockText();

    await apiUsageLogRepo.insert(db(), {
      provider,
      operation: "videos.list",
      units: 4,
    });

    const stamped = await db().$client<{ count: string }[]>`
      SELECT count(*)::text AS count FROM api_usage_log
      WHERE provider = ${provider}
        AND created_at >= ${before}::timestamptz
        AND created_at <= now()
    `;
    expect(stamped[0]?.count).toBe("1");
  });

  /**
   * The type keeps `createdAt` and `id` out of a literal; an object that is
   * wider than the type - built elsewhere, passed through a variable - is not
   * checked for excess fields, and at runtime it carries both. The repository
   * writes the columns of the entry and nothing else: a stamp of the caller,
   * whether a backdated one or the process clock running behind the database,
   * and a hand-written id never reach the table.
   */
  it("writes only the columns of the entry from an object wider than its type", async () => {
    // The operations carry a mark of this run of the case: the counts below
    // are these two rows, whatever else any case writes under `system`.
    const provider: Provider = "system";
    const mark = `wide-${randomUUID()}`;
    const operations = [`${mark}.backdated`, `${mark}.process-clock`];
    const databaseNow = await currentDatabaseTime();
    const before = await databaseClockText();

    const backdated = {
      provider,
      operation: `${mark}.backdated`,
      units: 1,
      createdAt: new Date(0),
      id: 999_999,
    };
    await apiUsageLogRepo.insert(db(), backdated);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // A process clock an hour behind the database stamps its own `Date`.
      vi.setSystemTime(new Date(databaseNow.getTime() - 3_600_000));
      const processStamped = {
        provider,
        operation: `${mark}.process-clock`,
        units: 1,
        createdAt: new Date(),
      };
      await apiUsageLogRepo.insert(db(), processStamped);
    } finally {
      vi.useRealTimers();
    }

    const rows = await db().$client<{ all: string; stamped: string }[]>`
      SELECT count(*)::text AS all,
        count(*) FILTER (
          WHERE id <> 999999
            AND created_at >= ${before}::timestamptz
            AND created_at <= now()
        )::text AS stamped
      FROM api_usage_log
      WHERE provider = ${provider} AND operation = ANY(${operations})
    `;
    expect(rows[0]).toEqual({ all: "2", stamped: "2" });
  });

  /**
   * A field the entry leaves out is left out of the insert, and the column
   * gets what the table gives it. None of the columns has a default today, so
   * the case gives each of the five optional ones a default inside a
   * transaction it rolls back: an insert that wrote `null` for any field it
   * was not given would override it, and a later migration adding a default -
   * or `NOT NULL DEFAULT` - would see it ignored or every write of a cost
   * refused. The rollback takes the defaults and the row with it, so a run
   * cut short here leaves the shared test database as the migrations made it.
   */
  it("leaves a field the entry does not give to the default of its column", async () => {
    const operation = `default-${randomUUID()}`;
    let written: Array<{
      units: number | null;
      tokensIn: number | null;
      tokensOut: number | null;
      costUsd: string | null;
      jobId: string | null;
    }> = [];

    await expect(
      db().transaction(async (tx) => {
        await tx.execute(sql`
          ALTER TABLE api_usage_log
            ALTER COLUMN units SET DEFAULT 7,
            ALTER COLUMN tokens_in SET DEFAULT 8,
            ALTER COLUMN tokens_out SET DEFAULT 9,
            ALTER COLUMN cost_usd SET DEFAULT 0.5,
            ALTER COLUMN job_id SET DEFAULT 'default-job'
        `);
        await apiUsageLogRepo.insert(tx, { provider: "system", operation });
        written = await tx
          .select({
            units: apiUsageLog.units,
            tokensIn: apiUsageLog.tokensIn,
            tokensOut: apiUsageLog.tokensOut,
            costUsd: apiUsageLog.costUsd,
            jobId: apiUsageLog.jobId,
          })
          .from(apiUsageLog)
          .where(eq(apiUsageLog.operation, operation));
        tx.rollback();
      }),
    ).rejects.toThrow(TransactionRollbackError);

    expect(written).toEqual([
      {
        units: 7,
        tokensIn: 8,
        tokensOut: 9,
        costUsd: "0.50000",
        jobId: "default-job",
      },
    ]);
    const left = await db().$client<
      { column_name: string; column_default: string | null }[]
    >`
      SELECT column_name, column_default FROM information_schema.columns
      WHERE table_name = 'api_usage_log'
        AND column_name IN ('units', 'tokens_in', 'tokens_out', 'cost_usd', 'job_id')
      ORDER BY column_name
    `;
    expect(left).toEqual(
      ["cost_usd", "job_id", "tokens_in", "tokens_out", "units"].map(
        (column_name) => ({ column_name, column_default: null }),
      ),
    );
  });

  /**
   * `sumUsage` takes the zone from its options and from nowhere else: an
   * aggregate that carries a zone of its own (a `BudgetScope` does) is read
   * in the zone of the options, and in UTC when they name none.
   */
  it("reads the zone of the options, not the one the aggregate carries", async () => {
    const inPacific = { ...unitsToday, timeZone: PACIFIC };
    expect(
      await apiUsageLogRepo.sumUsage(db(), inPacific, {
        now: NOW,
        timeZone: "UTC",
      }),
    ).toBe(18);
    expect(await apiUsageLogRepo.sumUsage(db(), inPacific, { now: NOW })).toBe(
      18,
    );
    expect(
      await apiUsageLogRepo.sumUsage(db(), unitsToday, {
        now: NOW,
        timeZone: PACIFIC,
      }),
    ).toBe(8);
  });

  it("fails on an unknown time zone instead of falling back to UTC", async () => {
    await expect(
      apiUsageLogRepo.sumUsage(db(), unitsToday, {
        now: NOW,
        timeZone: "Mars/Olympus",
      }),
    ).rejects.toThrow(/time zone/i);
  });
});

/**
 * The clock the rows are stamped with, as the text Postgres gives: compared
 * back in SQL (`::timestamptz`) it keeps its microseconds, which a JS `Date`
 * would round away. The one reader of that clock in this file.
 */
async function databaseClockText(): Promise<string> {
  const rows = await db().$client<{ now: string }[]>`SELECT now()::text AS now`;
  const now = rows[0]?.now;
  if (now === undefined) {
    throw new Error("SELECT now() returned no row");
  }
  return now;
}

/** The same clock as a `Date`, for a case that sets the process clock by it. */
async function currentDatabaseTime(): Promise<Date> {
  return new Date(await databaseClockText());
}

/**
 * Several windows in one statement, each in its own zone: the totals are the
 * ones the fixture gives window by window (the same windows are asked of
 * `sumUsage` above, one at a time).
 */
describe("apiUsageLogRepo.sumUsages", () => {
  it("answers each window in its own zone, in the order asked", async () => {
    const totals = await apiUsageLogRepo.sumUsages(
      db(),
      [
        { ...unitsToday, timeZone: PACIFIC },
        { ...costToday, timeZone: "UTC" },
        { ...costThisMonth, timeZone: PACIFIC },
      ],
      { now: NOW },
    );

    expect(totals[0]).toBe(8);
    expect(totals[1]).toBeCloseTo(0.15, 5);
    expect(totals[2]).toBeCloseTo(1.15, 5);
  });

  /**
   * The windows of the caps as they are - the YouTube day in Pacific time,
   * the Gemini day in UTC, the month of the speech vendors - next to a row of
   * the YouTube Data API ten days back: inside the month, but of a provider
   * the monthly cap does not cover, so no total takes it in. It reads the
   * answer only: how each window walks the index is the explain case of
   * `the window of sumUsage as an index key`.
   */
  it("answers the caps as they are with a stray row of another provider in none of them", async () => {
    const [stray] = await db()
      .insert(apiUsageLog)
      .values({
        provider: PROVIDER,
        operation: "videos.list",
        units: 500,
        costUsd: "50.00000",
        createdAt: new Date("2026-03-05T20:00:00Z"),
      })
      .returning({ id: apiUsageLog.id });

    try {
      const totals = await apiUsageLogRepo.sumUsages(
        db(),
        [{ ...unitsToday, timeZone: PACIFIC }, GEMINI_DAY, TTS_MONTH],
        { now: NOW },
      );

      expect(totals).toEqual([8, 5, 0]);
    } finally {
      if (stray !== undefined) {
        await db().delete(apiUsageLog).where(eq(apiUsageLog.id, stray.id));
      }
    }
  });

  /**
   * Without `now` every window ends on the clock of the database: the rows of
   * the fixture are all in March 2026, so the current day and month hold none
   * of them.
   */
  /**
   * `sumUsages` reads `now` of its options and nothing else: an options object
   * of `sumUsage` (wider than the type of this parameter, and assignable to
   * it) carries a zone that must not override the one of the aggregate.
   */
  it("keeps the zone of each aggregate against a wider options object", async () => {
    const options: UsagePeriodOptions = { now: NOW, timeZone: "UTC" };

    const totals = await apiUsageLogRepo.sumUsages(
      db(),
      [{ ...unitsToday, timeZone: PACIFIC }],
      options,
    );

    expect(totals).toEqual([8]);
  });

  it("ends every window on the database clock without `now`", async () => {
    await expect(
      apiUsageLogRepo.sumUsages(db(), [
        { ...unitsToday, timeZone: PACIFIC },
        costThisMonth,
      ]),
    ).resolves.toEqual([0, 0]);
  });

  /**
   * One aggregate over no providers refuses the whole read: answering the
   * others and zero for it would report "nothing spent" for a cap.
   */
  it("refuses a batch with an aggregate over no providers", async () => {
    await expect(
      apiUsageLogRepo.sumUsages(
        db(),
        [unitsToday, { providers: [], measure: "usd", period: "day" }],
        { now: NOW },
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("asks nothing for no windows", async () => {
    await expect(apiUsageLogRepo.sumUsages(db(), [])).resolves.toEqual([]);
  });
});

/**
 * The plan of the statement `run` makes the repository send, captured
 * through the logger of drizzle rather than written out again: a copy here
 * could keep passing while the repository moved back to a volatile bound.
 *
 * The table of a test is small enough for a sequential scan to win on cost
 * alone, so the choice is taken away: what is asserted is that the index
 * *can* carry the bound, not which plan the planner prefers today.
 *
 * `explain ${...}` is a concatenation, and the one place it is allowed: the
 * string is the statement drizzle just built and handed to the logger - it
 * never leaves this process, and its parameters are still bound separately.
 * Nothing user-supplied may be pasted into SQL this way anywhere else (SEC6).
 */
async function planOf(
  run: (watched: UsageQuerier) => Promise<unknown>,
): Promise<string[]> {
  const client = openTestSql();
  const logged: Array<{ query: string; params: unknown[] }> = [];
  const watched = drizzle(client, {
    schema,
    logger: {
      logQuery: (query: string, params: unknown[]): void => {
        logged.push({ query, params });
      },
    },
  });

  try {
    await run(watched);

    const statement = logged.at(-1);
    expect(statement).toBeDefined();
    const params = (statement?.params ?? []).map((value) => String(value));
    return await client.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      const rows = await tx.unsafe<Array<Record<string, string>>>(
        `explain ${statement?.query ?? ""}`,
        params,
      );
      return rows.map((row) => Object.values(row).join(" "));
    });
  } finally {
    await client.end();
  }
}

/**
 * The plan of the aggregate, not only its answer.
 *
 * `sumUsage` sits in front of every paid call (`assert`) and `sumUsages`
 * reads every cap of `/system/status` in one statement, and the difference
 * between an upper bound Postgres can use as an index key and one it can only
 * filter with is the difference between reading today's rows and reading
 * every row this provider ever wrote. A volatile `clock_timestamp()` is
 * exactly the second case, which is why the bound is `statement_timestamp()`
 * - and why that is asserted here rather than described in a comment.
 */
describe("the window of sumUsage as an index key", () => {
  it("bounds created_at inside the index condition", async () => {
    const plan = await planOf((watched) =>
      apiUsageLogRepo.sumUsage(watched, unitsToday),
    );

    expect(plan.join("\n")).toContain("api_usage_provider_created_idx");
    expect(
      plan.filter((line) => line.includes("Index Cond")).join("\n"),
    ).toContain("created_at");
  });

  /**
   * Each window walks the index by its own providers and its own bounds: a
   * month of the speech vendors next to the days of the other two caps is
   * not one scan of every provider asked from the start of the month.
   */
  it("walks the index once per window of sumUsages, each by its own bounds", async () => {
    const windows = [
      { ...unitsToday, timeZone: PACIFIC },
      GEMINI_DAY,
      TTS_MONTH,
    ];

    const plan = await planOf((watched) =>
      apiUsageLogRepo.sumUsages(watched, windows),
    );

    const bounded = plan.filter(
      (line) =>
        line.includes("Index Cond") &&
        line.includes("created_at") &&
        line.includes("provider"),
    );
    expect(bounded).toHaveLength(windows.length);
    expect(
      plan.filter((line) => line.includes("api_usage_provider_created_idx")),
    ).toHaveLength(windows.length);
  });
});
