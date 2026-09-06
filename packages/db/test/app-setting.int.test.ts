import { QUEUE_NAMES } from "@sf/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../src/client.js";
import { appSettingRepo } from "../src/repos/app-setting.js";
import { seedAppSettings } from "../src/seed.js";
import { openTestDb, resetTestDatabase } from "./helpers.int.js";

const db = openTestDb();

beforeAll(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await closeDb(db);
});

describe("appSettingRepo", () => {
  it("returns undefined for a key that was never written", async () => {
    expect(await appSettingRepo.get(db, "nothing.here")).toBeUndefined();
  });

  it("writes and reads a value back", async () => {
    await appSettingRepo.set(db, "test.key", { a: 1, b: ["x"] });

    expect(await appSettingRepo.get(db, "test.key")).toEqual({
      a: 1,
      b: ["x"],
    });
  });

  it("overwrites an existing key and moves updated_at forward", async () => {
    await appSettingRepo.set(db, "test.stamp", 1);
    const first = await stampOf("test.stamp");

    await appSettingRepo.set(db, "test.stamp", 2);

    expect(await appSettingRepo.get(db, "test.stamp")).toBe(2);
    // Strictly forward: both writes stamp the column from `now()`, so an equal
    // timestamp means the second write did not stamp it at all.
    expect(await stampOf("test.stamp")).toBeGreaterThan(first);
  });

  it("refuses undefined instead of losing the write", async () => {
    await appSettingRepo.set(db, "test.undefined", { kept: true });
    const before = await stampOf("test.undefined");

    // The message has to name the way out that exists: the column is NOT NULL,
    // so `null` is not one.
    await expect(
      appSettingRepo.set(db, "test.undefined", undefined),
    ).rejects.toThrow(/must not be undefined; the column is NOT NULL/);

    expect(await appSettingRepo.get(db, "test.undefined")).toEqual({
      kept: true,
    });
    expect(await stampOf("test.undefined")).toBe(before);
  });
});

describe("seedAppSettings", () => {
  it("writes the defaults a fresh installation needs", async () => {
    await seedAppSettings(db);

    expect(await appSettingRepo.get(db, "radar.weights")).toEqual({
      velocity: 0.5,
      acceleration: 0.3,
      baselineRatio: 0.2,
    });
    // The whole registry, not a sample: a queue missing from the seed reads
    // back as `undefined` in E0-08 instead of a switch.
    const queues = await appSettingRepo.get(db, "queues.enabled");
    expect(queues).toEqual(
      Object.fromEntries(QUEUE_NAMES.map((name) => [name, true])),
    );
  });

  it("run twice, leaves the defaults in place", async () => {
    await seedAppSettings(db);

    expect(await appSettingRepo.get(db, "radar.weights")).toEqual({
      velocity: 0.5,
      acceleration: 0.3,
      baselineRatio: 0.2,
    });
  });

  it("does not undo a value the operator changed", async () => {
    const tuned = { velocity: 0.7, acceleration: 0.2, baselineRatio: 0.1 };
    await appSettingRepo.set(db, "radar.weights", tuned);

    await seedAppSettings(db);

    expect(await appSettingRepo.get(db, "radar.weights")).toEqual(tuned);
  });

  /**
   * The registry grows: E0-08 adds the `system.*` queues to `QUEUE_NAMES` long
   * after the operator has seeded the database. A switch that is never written
   * reads back as `undefined` there, so a rerun has to fill the gaps - without
   * turning back on what the operator turned off.
   */
  it("adds switches a later registry brought, keeping the operator's choices", async () => {
    const [turnedOff, ...others] = QUEUE_NAMES;
    const addedLater = others.at(-1);
    if (turnedOff === undefined || addedLater === undefined) {
      throw new Error("the queue registry needs at least two names");
    }
    // What an older seed left behind: every queue but the last one, and one of
    // them switched off by hand.
    const alreadySeeded: Record<string, boolean> = Object.fromEntries(
      QUEUE_NAMES.filter((name) => name !== addedLater).map((name) => [
        name,
        true,
      ]),
    );
    alreadySeeded[turnedOff] = false;
    await appSettingRepo.set(db, "queues.enabled", alreadySeeded);

    await seedAppSettings(db);

    expect(await appSettingRepo.get(db, "queues.enabled")).toEqual({
      ...Object.fromEntries(QUEUE_NAMES.map((name) => [name, true])),
      [turnedOff]: false,
    });
  });

  /**
   * The same gap on the other row: `radar.weights` is one row holding a set of
   * keys too. E1-05 adds a weight to `TrendWeights`, and an already seeded
   * database has to get it - otherwise the scorer multiplies by `undefined`
   * and every `trend_signal` ends up with `NaN`.
   */
  it("adds a weight a later default brought, keeping the operator's numbers", async () => {
    await appSettingRepo.set(db, "radar.weights", {
      velocity: 0.7,
      acceleration: 0.2,
    });

    await seedAppSettings(db);

    expect(await appSettingRepo.get(db, "radar.weights")).toEqual({
      velocity: 0.7,
      acceleration: 0.2,
      baselineRatio: 0.2,
    });
  });

  /**
   * `updated_at` answers "when did the operator last touch this setting". A
   * seed that merges nothing new must not answer it with the time of the last
   * deploy: `pnpm db:seed` runs on every start of the migration service
   * (E0-11).
   */
  it("run with nothing to merge, leaves updated_at where it was", async () => {
    await seedAppSettings(db);
    const before = {
      queues: await stampOf("queues.enabled"),
      weights: await stampOf("radar.weights"),
    };

    await seedAppSettings(db);

    expect(await stampOf("queues.enabled")).toBe(before.queues);
    expect(await stampOf("radar.weights")).toBe(before.weights);
  });
});

/**
 * Microseconds, not a `Date`: the column keeps microsecond precision, while a
 * JS `Date` truncates to milliseconds, and two writes one round trip apart can
 * land inside the same millisecond on a fast machine - the assertion above
 * would then flake instead of failing on a real regression. Values come back
 * as text: the drizzle driver replaces the parsers of its own client with
 * transparent ones.
 */
async function stampOf(key: string): Promise<bigint> {
  const rows = await db.$client<{ stamp_us: string }[]>`
    SELECT (extract(epoch FROM updated_at) * 1000000)::bigint AS stamp_us
    FROM app_setting WHERE key = ${key}
  `;
  const stamp = rows[0]?.stamp_us;
  if (stamp === undefined) {
    throw new Error(`app_setting row "${key}" is missing`);
  }
  return BigInt(stamp);
}
