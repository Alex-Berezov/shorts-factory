import { eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { appSetting } from "../schema/system.js";

/**
 * Thin access to `app_setting`. Values stay `unknown`: the shape of each key
 * belongs to its owner (`radar.weights` to @sf/core, queue switches to the
 * worker registry), and validating it here would put a copy of every Zod
 * schema into the data package.
 */
export const appSettingRepo = {
  /** `undefined` when the key was never written. */
  async get(db: Db, key: string): Promise<unknown> {
    const rows = await db
      .select({ value: appSetting.value })
      .from(appSetting)
      .where(eq(appSetting.key, key))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    return row.value;
  },

  /**
   * Writes the value and stamps `updated_at`, inserting the key if new.
   *
   * `undefined` is rejected instead of being passed on: JSONB has no such
   * value, and drizzle would read it as "column not given" - a new key would
   * fail on the NOT NULL constraint, while an existing one would keep its old
   * value and still get a fresh `updated_at`, losing the write silently.
   * The timestamp comes from `now()` so that this branch and both the column
   * default and `seedAppSettings` read the same clock.
   */
  async set(db: Db, key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      throw new TypeError(
        `app_setting.${key}: value must not be undefined; the column is NOT NULL, so write the value you mean (an empty object, false) - null is rejected by the database`,
      );
    }
    const updatedAt = sql`now()`;
    await db
      .insert(appSetting)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({
        target: appSetting.key,
        set: { value, updatedAt },
      });
  },
};
