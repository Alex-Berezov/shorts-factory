import { z } from "zod";
import { ValidationError } from "./errors.js";
import type { Provider } from "./provider.js";

/**
 * Share of a cap at which the operator is warned but calls still go through,
 * kept as a fraction so that the comparison below never divides.
 */
const WARN_NUMERATOR = 4;
const WARN_DENOMINATOR = 5;

/** Share of a cap at which the operator is warned but calls still go through. */
export const BUDGET_WARN_RATIO = WARN_NUMERATOR / WARN_DENOMINATOR;

export interface BudgetInput {
  /** Already spent in the period - units or dollars, the caller decides. */
  spent: number;
  /** The cap for the same period and the same unit. */
  cap: number;
}

export interface BudgetState {
  /** `spent / cap`, unrounded: rounding belongs to whoever displays it. */
  ratio: number;
  exceeded: boolean;
  warn: boolean;
}

/**
 * Where a period stands against its cap. Pure - no clock, no database, no
 * formatting.
 *
 * `exceeded` is `>=`, not `>`: the guard of E0-09 asks before the call is made,
 * so sitting exactly on the cap must stop the next one, and E1-08 reads its
 * quota threshold the same way. `warn` stays true past the cap as well - a
 * state that is exceeded is not a state that stopped being worth a warning.
 *
 * A non-positive cap is a bug in the caller, not a budget without a limit: all
 * three caps come from the environment schema as `positive()`. Reporting it as
 * "exceeded" would hide the bug; reporting it as "fine" would remove the fuse.
 *
 * Neither flag is decided by `ratio`: `2.4 / 3` is `0.7999999999999999`, so a
 * dollar budget sitting exactly on the warning share would go unannounced.
 * `ratio` is reported, not compared.
 */
export function budgetState({ spent, cap }: BudgetInput): BudgetState {
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new ValidationError("budget cap must be a positive finite number", {
      spent,
      cap,
    });
  }
  if (!Number.isFinite(spent) || spent < 0) {
    throw new ValidationError(
      "budget spend must be a non-negative finite number",
      { spent, cap },
    );
  }

  const exceeded = spent >= cap;

  return {
    ratio: spent / cap,
    exceeded,
    warn: spent * WARN_DENOMINATOR >= cap * WARN_NUMERATOR,
  };
}

/**
 * Which measure a cap counts, and over which window.
 *
 * Runtime constants rather than bare types: `@sf/contracts` builds the enum of
 * `BudgetStatus` out of them (like `BUDGET_SCOPE_KEYS`), and a set of literals
 * written out a second time there is a set that drifts - a period added here
 * would reach the guard and the response body, and be rejected by the
 * serializer of the route as a 500.
 */
export const BUDGET_MEASURES = ["units", "usd"] as const;
export const BUDGET_PERIODS = ["day", "month"] as const;

export type BudgetMeasure = (typeof BUDGET_MEASURES)[number];
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

/**
 * One cap, and everything needed to count what stands against it: the rows to
 * sum (`providers`), the column (`measure`), the window (`period`), the zone
 * that window is cut in (`timeZone`) and a stable name for the cache key and
 * for `/system/status`.
 *
 * A scope, rather than a provider, is what a cap belongs to, because the caps
 * are not one per provider: the monthly TTS budget is a single cap over four
 * vendors, so a guard that summed one of them would compare a quarter of the
 * spend against the whole cap and never fire. Keeping the three fields
 * together is also what stops the mistake `TECH_DEBT:114` names - units and
 * dollars reaching `budgetState` as two anonymous numbers from different
 * places: inside a scope both sides of the comparison come from the same one.
 *
 * `timeZone` belongs here for the same reason and not to the caller: when a
 * period rolls over is a property of the cap, not of whoever is asking. The
 * YouTube quota resets at midnight in `America/Los_Angeles` and our own money
 * budgets roll over in UTC, so a single zone chosen by the caller cannot say
 * both - and the one it gets wrong is the quota, where a counter that restarts
 * seven hours early hands out a second day's worth of units against a quota
 * that has not moved.
 */
export interface BudgetScope {
  readonly key: BudgetScopeKey;
  readonly measure: BudgetMeasure;
  readonly period: BudgetPeriod;
  readonly providers: readonly Provider[];
  /** IANA name of the zone the day or month of this cap is cut in. */
  readonly timeZone: string;
}

/** The caps that exist. Names are stable: they reach Redis and the operator. */
export const BUDGET_SCOPE_KEYS = [
  "youtube_data_units_day",
  "gemini_usd_day",
  "tts_usd_month",
] as const;

export type BudgetScopeKey = (typeof BUDGET_SCOPE_KEYS)[number];

/**
 * Where the YouTube Data API cuts its day. Google resets the quota at midnight
 * Pacific time, and that is also the zone the `quota-reset` cron of E1 runs in;
 * counting the units in any other zone would move our fuse away from the limit
 * it is protecting. A literal rather than a setting: it is Google's calendar,
 * not a preference of this deployment.
 */
const PACIFIC = "America/Los_Angeles";

/** The zone our own money budgets roll over in. */
const UTC = "UTC";

const YOUTUBE_DATA_UNITS_DAY: BudgetScope = {
  key: "youtube_data_units_day",
  measure: "units",
  period: "day",
  providers: ["youtube_data"],
  timeZone: PACIFIC,
};

const GEMINI_USD_DAY: BudgetScope = {
  key: "gemini_usd_day",
  measure: "usd",
  period: "day",
  providers: ["gemini"],
  timeZone: UTC,
};

/**
 * One cap over the paid speech vendors. `gemini-tts` is not among them: it
 * bills as Gemini and writes `provider: "gemini"`, so its spend belongs to the
 * daily Gemini cap and counting it here as well would charge it twice.
 */
const TTS_USD_MONTH: BudgetScope = {
  key: "tts_usd_month",
  measure: "usd",
  period: "month",
  providers: ["elevenlabs", "openai_tts", "google_tts", "cartesia"],
  timeZone: UTC,
};

/**
 * Which cap a call by this provider is spending against, or `null` when the
 * provider has no cap yet.
 *
 * `null` is not "spend freely": it is a third outcome the guard reports as
 * such (`check` answers `null`, `assert` refuses to be asked), so that a
 * provider nobody gave a cap to cannot pass a fuse that was never installed.
 * `youtube_analytics` gets one with the OAuth quota of E7-01; `system` is our
 * own bookkeeping and spends nothing external.
 *
 * `satisfies Record<Provider, ...>` rather than a lookup with a fallback: a
 * provider added to `PROVIDERS` without a cap - or without an explicit "no cap
 * yet" - fails to compile here instead of silently becoming unguarded.
 */
export const BUDGET_SCOPE_BY_PROVIDER = {
  youtube_data: YOUTUBE_DATA_UNITS_DAY,
  youtube_analytics: null,
  gemini: GEMINI_USD_DAY,
  elevenlabs: TTS_USD_MONTH,
  openai_tts: TTS_USD_MONTH,
  google_tts: TTS_USD_MONTH,
  cartesia: TTS_USD_MONTH,
  system: null,
} satisfies Record<Provider, BudgetScope | null>;

/** The cap a provider spends against; `null` when it has none yet. */
export function budgetScopeFor(provider: Provider): BudgetScope | null {
  return BUDGET_SCOPE_BY_PROVIDER[provider];
}

/**
 * What the cached total of a scope holds (`budgetCacheKey`).
 *
 * In `@sf/core` rather than in the package that writes it, because the value
 * sits in Redis between two services and two releases: the worker writes it,
 * anything guarding the same cap reads it, and a shape that drifted has to be
 * a cache miss rather than a number that walks into a cap comparison.
 *
 * `warn` is the state the total was in when it was written, and it is what
 * decides whether the cached value may be used at all: near a cap a minute-old
 * total is exactly the thing that lets a call past it.
 */
export const BudgetCacheValueSchema = z
  .object({
    spent: z.number().nonnegative().finite(),
    warn: z.boolean(),
  })
  .strict();

export type BudgetCacheValue = z.infer<typeof BudgetCacheValueSchema>;
