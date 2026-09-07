import { z } from "zod";
import { ProviderSchema } from "./provider.js";

/**
 * One external call, priced. The field names mirror the writable columns of
 * `api_usage_log` (`packages/db/src/schema/system.ts`) so that the logger of
 * E0-09 keeps a mapper of the smallest possible size, but the entry is not the
 * insert type: `costUsd` is a `number` against a `numeric` column, and under
 * `exactOptionalPropertyTypes` every optional field here is `T | undefined`
 * while `$inferInsert` asks for `T | null`. The mapper (five fields, plus the
 * decision on how many cents a rounding to five decimals may drop) belongs to
 * E0-09 - see `docs/TECH_DEBT.md`.
 *
 * Which measure a call has to report follows from what its provider spends,
 * because that is what the caps are counted in:
 * - YouTube spends quota, and every cap on it is in units, so `units` is
 *   required and dollars are meaningless;
 * - Gemini and the TTS vendors spend money (`GEMINI_DAILY_BUDGET_USD`,
 *   `TTS_MONTHLY_BUDGET_USD`), so `costUsd` is required; tokens stay optional
 *   because they explain the price rather than being the price;
 * - `system` is our own bookkeeping, spends nothing external and reports
 *   whatever it has.
 *
 * The rule is carried by the schema being a union rather than by a refinement:
 * a refinement makes the schema a `ZodEffects` whose inferred type keeps every
 * measure optional, and the type would then have to be written a second time by
 * hand - two truths for one contract. Here `ApiUsageEntry` is the `z.infer` of
 * the union, so a `parse` result goes straight into a `UsageLogger`.
 *
 * The union is discriminated on `provider`, and the difference was measured: a
 * plain `z.union` rejecting an entry that omits its required measure reports a
 * single `invalid_union` with an empty `path`, so the operator of E0-09 is not
 * shown the field at all. Discriminated, the failure keeps the path of the
 * field that caused it.
 */

const entryFields = {
  operation: z.string().min(1),
  /** YouTube quota units. */
  units: z.number().int().nonnegative().optional(),
  tokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  /** Job that made the call; absent for calls made outside a job. */
  jobId: z.string().min(1).optional(),
};

// The provider lists are carved out of `ProviderSchema`, not spelled again: a
// value added to `PROVIDERS` alone fails to compile here, and a value invented
// here is not a `Provider`. Strict everywhere, so that a misspelled measure
// (`unit`) is an error rather than a silently dropped key that would leave the
// entry unpriced.
const quotaEntry = z
  .object({
    ...entryFields,
    provider: ProviderSchema.extract(["youtube_data", "youtube_analytics"]),
    units: z.number().int().nonnegative(),
  })
  .strict();

const paidEntry = z
  .object({
    ...entryFields,
    provider: ProviderSchema.extract([
      "gemini",
      "elevenlabs",
      "openai_tts",
      "google_tts",
      "cartesia",
    ]),
    costUsd: z.number().nonnegative(),
  })
  .strict();

const systemEntry = z
  .object({ ...entryFields, provider: z.literal("system") })
  .strict();

export const ApiUsageEntrySchema = z.discriminatedUnion("provider", [
  quotaEntry,
  paidEntry,
  systemEntry,
]);

/** One priced call, as the schema parses it. */
export type ApiUsageEntry = z.infer<typeof ApiUsageEntrySchema>;

/**
 * How an integration reports what a call cost. Integrations depend on
 * `@sf/core` only, so the implementation (a write to `api_usage_log`) is
 * injected by the composition root - `@sf/core` never learns about the
 * database.
 */
export type UsageLogger = (entry: ApiUsageEntry) => Promise<void>;
