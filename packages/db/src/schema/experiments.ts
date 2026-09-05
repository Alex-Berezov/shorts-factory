import {
  integer, jsonb, numeric, pgTable, serial, text, timestamp,
} from "drizzle-orm/pg-core";

export const experiment = pgTable("experiment", {
  id: serial("id").primaryKey(),
  hypothesis: text("hypothesis").notNull(),
  design: jsonb("design").notNull(), // e.g. 5/5 split spec, controlled variables
  status: text("status").notNull().default("planned"), // planned | running | done
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  conclusion: jsonb("conclusion"),
});

export const experimentRecommendation = pgTable("experiment_recommendation", {
  id: serial("id").primaryKey(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  body: text("body").notNull(),
  confidence: numeric("confidence", { precision: 4, scale: 3 }),
  basedOn: jsonb("based_on").notNull(), // data window, features, sample sizes
  experimentId: integer("experiment_id").references(() => experiment.id),
});
