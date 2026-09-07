import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb } from "../src/client.js";
import { apiUsageLogRepo } from "../src/repos/api-usage-log.js";
import { apiUsageLog } from "../src/schema/system.js";
import { openTestDb, resetTestDatabase } from "./helpers.int.js";

/**
 * Fixed instant, so day and month boundaries are asserted instead of waited
 * for. 20:00 UTC on 15 March 2026 is 13:00 in `America/Los_Angeles` (PDT):
 * the UTC day starts at 00:00Z, the Pacific day at 07:00Z, and the Pacific
 * month at 2026-03-01T08:00Z (still PST).
 */
const NOW = new Date("2026-03-15T20:00:00Z");
const PACIFIC = "America/Los_Angeles";
const PROVIDER = "youtube_data";

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

describe("apiUsageLogRepo aggregates", () => {
  it("sums today's units in UTC by default", async () => {
    expect(
      await apiUsageLogRepo.sumUnitsToday(db, PROVIDER, { now: NOW }),
    ).toBe(18);
  });

  it("moves the day boundary with the caller's time zone", async () => {
    expect(
      await apiUsageLogRepo.sumUnitsToday(db, PROVIDER, {
        now: NOW,
        timeZone: PACIFIC,
      }),
    ).toBe(8);
  });

  it("sums today's cost, ignoring rows that recorded none", async () => {
    expect(
      await apiUsageLogRepo.sumCostUsdToday(db, PROVIDER, { now: NOW }),
    ).toBeCloseTo(0.15, 5);
    expect(
      await apiUsageLogRepo.sumCostUsdToday(db, PROVIDER, {
        now: NOW,
        timeZone: PACIFIC,
      }),
    ).toBeCloseTo(0.05, 5);
  });

  it("sums this month's cost and moves its boundary with the time zone", async () => {
    expect(
      await apiUsageLogRepo.sumCostUsdThisMonth(db, PROVIDER, { now: NOW }),
    ).toBeCloseTo(3.15, 5);
    expect(
      await apiUsageLogRepo.sumCostUsdThisMonth(db, PROVIDER, {
        now: NOW,
        timeZone: PACIFIC,
      }),
    ).toBeCloseTo(1.15, 5);
  });

  it("keeps providers apart", async () => {
    expect(
      await apiUsageLogRepo.sumUnitsToday(db, "gemini", { now: NOW }),
    ).toBe(42);
    expect(
      await apiUsageLogRepo.sumCostUsdThisMonth(db, "gemini", { now: NOW }),
    ).toBeCloseTo(5, 5);
  });

  it("reports zero for a provider with no rows in the window", async () => {
    expect(
      await apiUsageLogRepo.sumUnitsToday(db, "elevenlabs", { now: NOW }),
    ).toBe(0);
    expect(
      await apiUsageLogRepo.sumCostUsdToday(db, "elevenlabs", { now: NOW }),
    ).toBe(0);
    expect(
      await apiUsageLogRepo.sumCostUsdThisMonth(db, "elevenlabs", { now: NOW }),
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
      await apiUsageLogRepo.sumUnitsToday(db, PROVIDER, { now: yesterday }),
    ).toBe(100);
    expect(
      await apiUsageLogRepo.sumCostUsdToday(db, PROVIDER, { now: yesterday }),
    ).toBeCloseTo(1, 5);
  });

  it("counts the month of a past `now` and nothing after it", async () => {
    expect(
      await apiUsageLogRepo.sumCostUsdThisMonth(db, PROVIDER, {
        now: new Date("2026-02-25T00:00:00Z"),
      }),
    ).toBeCloseTo(10, 5);
  });

  /**
   * `created_at` is written by Postgres, so the end of a window the caller did
   * not name has to come from Postgres too. The process clock is moved back a
   * minute here to stand for the drift a separate database container, a VPS or
   * a host waking from sleep produces: rows stamped by the database in that
   * gap must still be counted, or the budget guard (E0-09) - which calls the
   * aggregates without options - lets a call past an exhausted cap.
   */
  it("ends a window without `now` on the database clock, not the process one", async () => {
    // A provider no fixture writes to, so the window below holds exactly the
    // row this case inserts.
    const provider = "cartesia";
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

      expect(await apiUsageLogRepo.sumUnitsToday(db, provider)).toBe(11);
      expect(await apiUsageLogRepo.sumCostUsdToday(db, provider)).toBeCloseTo(
        0.25,
        5,
      );
      expect(
        await apiUsageLogRepo.sumCostUsdThisMonth(db, provider),
      ).toBeCloseTo(0.25, 5);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The stamp belongs to the database, so the entry carries no `createdAt`: a
   * logger reaching for its own clock (`createUsageLogger` of E0-09) has to
   * fail to compile, not to hide spend outside the window the aggregates
   * count. The type is the whole guard - the value below does reach the column
   * at runtime, and the row lands in a window that "today" no longer covers.
   */
  it("takes no createdAt from the caller", async () => {
    // Likewise unused by the fixtures - the counts here are this row alone.
    const provider = "openai_tts";

    await apiUsageLogRepo.insert(db, {
      provider,
      operation: "videos.list",
      units: 4,
      // @ts-expect-error `createdAt` is excluded from the entry type: rows are
      // stamped by the database clock the aggregates end their window on.
      createdAt: new Date("2026-03-15T10:00:00Z"),
    });

    expect(await apiUsageLogRepo.sumUnitsToday(db, provider)).toBe(0);
    expect(
      await apiUsageLogRepo.sumUnitsToday(db, provider, { now: NOW }),
    ).toBe(4);
  });

  it("fails on an unknown time zone instead of falling back to UTC", async () => {
    await expect(
      apiUsageLogRepo.sumUnitsToday(db, PROVIDER, {
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
