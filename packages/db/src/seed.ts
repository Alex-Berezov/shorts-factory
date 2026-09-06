import { QUEUE_NAMES } from "@sf/core";
import { sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { appSetting } from "./schema/system.js";

/**
 * One switch per queue of the shared registry. All of them start enabled:
 * money and the channel are guarded by the budget guard (E0-09), the hard caps
 * of §8 and by publishing being an explicit operator action, not by these
 * switches.
 */
function defaultQueueSwitches(): Record<string, boolean> {
  return Object.fromEntries(QUEUE_NAMES.map((name) => [name, true]));
}

/**
 * Settings a fresh installation needs to run at all - no content, no fixtures.
 * Values are starting points meant to be tuned by the operator (E1-10) and by
 * the epics that own the keys (`radar.weights` - E1-06, queue switches - E0-08).
 */
const DEFAULT_APP_SETTINGS: (typeof appSetting.$inferInsert)[] = [
  {
    key: "radar.weights",
    // Shape of TrendWeights in @sf/core; velocity leads, the baseline ratio is
    // the weakest until a channel has enough history for it (E1-05).
    value: { velocity: 0.5, acceleration: 0.3, baselineRatio: 0.2 },
  },
  { key: "queues.enabled", value: defaultQueueSwitches() },
];

/**
 * The defaults are merged under the stored object: missing rows and missing
 * keys are added, the operator's value wins, and a run that changes nothing
 * leaves `updated_at` alone.
 *
 * Every key here is a single row holding a set of keys, so both halves matter.
 * `excluded.value || app_setting.value` puts the stored object last, which is
 * why the operator's choices survive; without the merge, a key a later epic
 * adds (`queues.enabled` grows with the registry in E0-08, `radar.weights`
 * with `TrendWeights` in E1-05) would never reach an already seeded database
 * and would read back as `undefined`. The `where` keeps the run that changes
 * nothing from touching `updated_at`. One statement for every row: the write
 * is atomic and idempotent by the primary key, not by a read-then-write, so
 * two runs at once cannot race.
 */
export async function seedAppSettings(db: Db): Promise<void> {
  const merged = sql`excluded.value || ${appSetting.value}`;
  await db
    .insert(appSetting)
    .values(DEFAULT_APP_SETTINGS)
    .onConflictDoUpdate({
      target: appSetting.key,
      set: { value: merged, updatedAt: sql`now()` },
      setWhere: sql`${merged} IS DISTINCT FROM ${appSetting.value}`,
    });
}
