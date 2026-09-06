import {
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const experimentStatus = pgEnum("experiment_status", [
  "planned",
  "running",
  "done",
]);

export const experiment = pgTable("experiment", {
  id: serial("id").primaryKey(),
  hypothesis: text("hypothesis").notNull(),
  design: jsonb("design").notNull(), // e.g. 5/5 split spec, controlled variables
  status: experimentStatus("status").notNull().default("planned"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  conclusion: jsonb("conclusion"),
});

export const experimentRecommendation = pgTable(
  "experiment_recommendation",
  {
    id: serial("id").primaryKey(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    body: text("body").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    basedOn: jsonb("based_on").notNull(), // data window, features, sample sizes
    experimentId: integer("experiment_id").references(() => experiment.id),
  },
  (t) => [index("experiment_recommendation_experiment_idx").on(t.experimentId)],
);
