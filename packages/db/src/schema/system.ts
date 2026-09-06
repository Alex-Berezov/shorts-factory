import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** Every external API call cost — quota units, tokens, dollars. */
export const apiUsageLog = pgTable(
  "api_usage_log",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull(), // youtube_data | youtube_analytics | gemini | elevenlabs | ...
    operation: text("operation").notNull(),
    units: integer("units"), // YouTube quota units
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 5 }),
    jobId: text("job_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // Daily and monthly spend per provider: the aggregates in
  // `repos/api-usage-log.ts` scan exactly this pair.
  (t) => [index("api_usage_provider_created_idx").on(t.provider, t.createdAt)],
);

export const promptVersion = pgTable(
  "prompt_version",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(), // e.g. "dna.full", "dna.hook_pass", "script.master"
    version: text("version").notNull(),
    template: text("template").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("prompt_uq").on(t.name, t.version)],
);

export const appSetting = pgTable("app_setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Encrypted Google OAuth tokens (single operator). */
export const oauthToken = pgTable("oauth_token", {
  id: serial("id").primaryKey(),
  provider: text("provider").notNull().unique(), // "google"
  encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
  scopes: jsonb("scopes").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
