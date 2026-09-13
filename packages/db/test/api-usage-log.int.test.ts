import { ValidationError } from "@sf/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb } from "../src/client.js";
import { apiUsageLogRepo } from "../src/repos/api-usage-log.js";
import * as schema from "../src/schema/index.js";
import { apiUsageLog } from "../src/schema/system.js";
import { openTestDb, openTestSql, resetTestDatabase } from "./helpers.int.js";

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

const db = openTestDb();

beforeAll(async () => {
  await resetTestDatabase();

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
  await db.insert(apiUsageLog).values(
    rows.map((row) => ({
      provider: PROVIDER,
      operation: "videos.list",
      units: row.units,
      costUsd: row.costUsd,
      createdAt: new Date(row.createdAt),
    })),
  );

  // another provider inside every window - must never be mixed in
  await db.insert(apiUsageLog).values({
    provider: "gemini",
    operation: "generateContent",
    units: 42,
    costUsd: "5.00000",
    createdAt: new Date("2026-03-15T10:00:00Z"),
  });
});

afterAll(async () => {
  await closeDb(db);
});

describe("apiUsageLogRepo.sumUsage", () => {
  it("sums today's units in UTC by default", async () => {
    expect(await apiUsageLogRepo.sumUsage(db, unitsToday, { now: NOW })).toBe(
      18,
    );
  });

  it("moves the day boundary with the caller's time zone", async () => {
    expect(
      await apiUsageLogRepo.sumUsage(db, unitsToday, {
        now: NOW,
        timeZone: PACIFIC,
      }),
    ).toBe(8);
  });

  it("sums today's cost, ignoring rows that recorded none", async () => {
    expect(
      await apiUsageLogRepo.sumUsage(db, costToday, { now: NOW }),
    ).toBeCloseTo(0.15, 5);
    expect(
      await apiUsageLogRepo.sumUsage(db, costToday, {
        now: NOW,
        timeZone: PACIFIC,
      }),
    ).toBeCloseTo(0.05, 5);
  });

  it("sums this month's cost and moves its boundary with the time zone", async () => {
    expect(
      await apiUsageLogRepo.sumUsage(db, costThisMonth, { now: NOW }),
    ).toBeCloseTo(3.15, 5);
    expect(
      await apiUsageLogRepo.sumUsage(db, costThisMonth, {
        now: NOW,
        timeZone: PACIFIC,
      }),
    ).toBeCloseTo(1.15, 5);
  });

  it("keeps providers apart", async () => {
    expect(
      await apiUsageLogRepo.sumUsage(
        db,
        { providers: ["gemini"], measure: "units", period: "day" },
        { now: NOW },
      ),
    ).toBe(42);
    expect(
      await apiUsageLogRepo.sumUsage(
        db,
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
    await db.insert(apiUsageLog).values(
      rows.map((row) => ({
        provider: row.provider,
        operation: "tts.synthesize",
        costUsd: row.costUsd,
        createdAt: new Date("2026-05-10T10:00:00Z"),
      })),
    );

    expect(
      await apiUsageLogRepo.sumUsage(
        db,
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
        db,
        { providers: [], measure: "usd", period: "day" },
        { now: NOW },
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("reports zero for a provider with no rows in the window", async () => {
    const none = { providers: ["elevenlabs"] } as const;

    expect(
      await apiUsageLogRepo.sumUsage(
        db,
        { ...none, measure: "units", period: "day" },
        { now: NOW },
      ),
    ).toBe(0);
    expect(
      await apiUsageLogRepo.sumUsage(
        db,
        { ...none, measure: "usd", period: "day" },
        { now: NOW },
      ),
    ).toBe(0);
    expect(
      await apiUsageLogRepo.sumUsage(
        db,
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
      await apiUsageLogRepo.sumUsage(db, unitsToday, { now: yesterday }),
    ).toBe(100);
    expect(
      await apiUsageLogRepo.sumUsage(db, costToday, { now: yesterday }),
    ).toBeCloseTo(1, 5);
  });

  it("counts the month of a past `now` and nothing after it", async () => {
    expect(
      await apiUsageLogRepo.sumUsage(db, costThisMonth, {
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
    // A provider no fixture writes to, so the window below holds exactly the
    // row this case inserts.
    const provider = "cartesia";
    const scope = { providers: [provider] } as const;
    await apiUsageLogRepo.insert(db, {
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
        await apiUsageLogRepo.sumUsage(db, {
          ...scope,
          measure: "units",
          period: "day",
        }),
      ).toBe(11);
      expect(
        await apiUsageLogRepo.sumUsage(db, {
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

    await apiUsageLogRepo.insert(db, {
      provider,
      operation: "tts.synthesize",
      costUsd: "4.00000",
    });

    const inside = await db.transaction(async (tx) => {
      // The transaction is open from here on, so `transaction_timestamp()` -
      // which is what `now()` returns - stops moving.
      await tx.execute(sql`select 1`);

      // Committed by another connection of the pool while it is open.
      await apiUsageLogRepo.insert(db, {
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
   * with a later insert. The type is the whole guard - both values do reach
   * the table at runtime.
   */
  it("takes neither createdAt nor id from the caller", async () => {
    // Likewise unused by the fixtures - the counts here are this row alone.
    const provider = "openai_tts";
    const scope = {
      providers: [provider],
      measure: "units",
      period: "day",
    } as const;

    await apiUsageLogRepo.insert(db, {
      provider,
      operation: "videos.list",
      units: 4,
      // @ts-expect-error `createdAt` is excluded from the entry type: rows are
      // stamped by the database clock the aggregate ends its window on.
      createdAt: new Date("2026-03-15T10:00:00Z"),
    });

    await expect(
      apiUsageLogRepo.insert(db, {
        provider,
        operation: "videos.list",
        units: 4,
        // @ts-expect-error `id` is excluded as well: it comes from the
        // sequence of the `serial` column, never from a caller.
        id: 999_999,
      }),
    ).resolves.toBeUndefined();

    expect(await apiUsageLogRepo.sumUsage(db, scope)).toBe(4);
    expect(await apiUsageLogRepo.sumUsage(db, scope, { now: NOW })).toBe(4);
  });

  it("fails on an unknown time zone instead of falling back to UTC", async () => {
    await expect(
      apiUsageLogRepo.sumUsage(db, unitsToday, {
        now: NOW,
        timeZone: "Mars/Olympus",
      }),
    ).rejects.toThrow(/time zone/i);
  });
});

/** The clock the rows are stamped with; text, like every timestamp here. */
async function currentDatabaseTime(): Promise<Date> {
  const rows = await db.$client<{ now: string }[]>`SELECT now() AS now`;
  const now = rows[0]?.now;
  if (now === undefined) {
    throw new Error("SELECT now() returned no row");
  }
  return new Date(now);
}

/**
 * The plan of the aggregate, not only its answer.
 *
 * `sumUsage` sits in front of every paid call (`assert`) and runs three times
 * per `/system/status`, and the difference between an upper bound Postgres can
 * use as an index key and one it can only filter with is the difference
 * between reading today's rows and reading every row this provider ever wrote.
 * A volatile `clock_timestamp()` is exactly the second case, which is why the
 * bound is `statement_timestamp()` - and why that is asserted here rather than
 * described in a comment.
 */
describe("the window of sumUsage as an index key", () => {
  it("bounds created_at inside the index condition", async () => {
    const client = openTestSql();
    const logged: Array<{ query: string; params: unknown[] }> = [];
    // The same statement the repository runs, captured through the logger of
    // drizzle rather than written out again: a copy here could keep passing
    // while the repository moved back to a volatile bound.
    const watched = drizzle(client, {
      schema,
      logger: {
        logQuery: (query: string, params: unknown[]): void => {
          logged.push({ query, params });
        },
      },
    });

    try {
      await apiUsageLogRepo.sumUsage(watched, unitsToday);

      const statement = logged.at(-1);
      expect(statement).toBeDefined();
      const params = (statement?.params ?? []).map((value) => String(value));

      // The table of a test is small enough for a sequential scan to win on
      // cost alone, so the choice is taken away: what is asserted is that the
      // index *can* carry the bound, not which plan the planner prefers today.
      //
      // `explain ${...}` is a concatenation, and the one place it is allowed:
      // the string is the statement drizzle just built and handed to the
      // logger above - it never leaves this process, and its parameters are
      // still bound separately below. Nothing user-supplied may be pasted into
      // SQL this way anywhere else (SEC6).
      const plan = await client.begin(async (tx) => {
        await tx`set local enable_seqscan = off`;
        const rows = await tx.unsafe<Array<Record<string, string>>>(
          `explain ${statement?.query ?? ""}`,
          params,
        );
        return rows.map((row) => Object.values(row).join(" ")).join("\n");
      });

      expect(plan).toContain("api_usage_provider_created_idx");
      const indexCond = plan
        .split("\n")
        .filter((line) => line.includes("Index Cond"))
        .join("\n");
      expect(indexCond).toContain("created_at");
    } finally {
      await client.end();
    }
  });
});
