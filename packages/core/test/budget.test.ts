import { describe, expect, it } from "vitest";
import {
  BUDGET_SCOPE_BY_PROVIDER,
  BUDGET_SCOPE_KEYS,
  BUDGET_WARN_RATIO,
  type BudgetScope,
  budgetScopeFor,
  budgetState,
} from "../src/domain/budget.js";
import { ValidationError } from "../src/domain/errors.js";
import { PROVIDERS, type Provider } from "../src/domain/provider.js";

/**
 * The guard of E0-09 asks this function before it lets an external call
 * happen, so every boundary below is a decision to spend money or not to.
 */
describe("budgetState", () => {
  const cases: Array<{
    name: string;
    spent: number;
    cap: number;
    ratio: number;
    exceeded: boolean;
    warn: boolean;
  }> = [
    {
      name: "nothing spent",
      spent: 0,
      cap: 10_000,
      ratio: 0,
      exceeded: false,
      warn: false,
    },
    {
      name: "below the warning threshold",
      spent: 7_999,
      cap: 10_000,
      ratio: 0.7999,
      exceeded: false,
      warn: false,
    },
    {
      name: "exactly at 80 per cent",
      spent: 8_000,
      cap: 10_000,
      ratio: 0.8,
      exceeded: false,
      warn: true,
    },
    {
      name: "between the warning and the cap",
      spent: 9_999,
      cap: 10_000,
      ratio: 0.9999,
      exceeded: false,
      warn: true,
    },
    {
      name: "exactly at the cap",
      spent: 10_000,
      cap: 10_000,
      ratio: 1,
      exceeded: true,
      warn: true,
    },
    {
      name: "past the cap",
      spent: 12_500,
      cap: 10_000,
      ratio: 1.25,
      exceeded: true,
      warn: true,
    },
  ];

  for (const c of cases) {
    it(`reports ${c.name}`, () => {
      const state = budgetState({ spent: c.spent, cap: c.cap });

      expect(state.ratio).toBeCloseTo(c.ratio, 10);
      expect(state.exceeded).toBe(c.exceeded);
      expect(state.warn).toBe(c.warn);
    });
  }

  it("keeps warning once the cap is passed", () => {
    // A budget that is exceeded is not a budget that stopped being worth a
    // warning: /system reads `warn` to paint the row.
    expect(budgetState({ spent: 50, cap: 10 })).toEqual({
      ratio: 5,
      exceeded: true,
      warn: true,
    });
  });

  it("does not round the ratio", () => {
    expect(budgetState({ spent: 1, cap: 3 }).ratio).toBe(1 / 3);
  });

  it("warns at exactly BUDGET_WARN_RATIO of any cap", () => {
    expect(BUDGET_WARN_RATIO).toBe(0.8);
    expect(budgetState({ spent: 4, cap: 5 }).warn).toBe(true);
    expect(budgetState({ spent: 3.99, cap: 5 }).warn).toBe(false);
  });

  it("warns on a dollar cap where the ratio falls short of the share", () => {
    // `2.4 / 3` is 0.7999999999999999 in binary floating point: comparing the
    // ratio would leave the operator unwarned at exactly 80 per cent of a
    // budget in dollars.
    const state = budgetState({ spent: 2.4, cap: 3 });

    expect(state.ratio).toBeLessThan(BUDGET_WARN_RATIO);
    expect(state.warn).toBe(true);
    expect(state.exceeded).toBe(false);
  });

  it("refuses a cap that is not a positive finite number", () => {
    for (const cap of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => budgetState({ spent: 1, cap })).toThrow(ValidationError);
    }
  });

  it("refuses a negative or non-finite spend", () => {
    for (const spent of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => budgetState({ spent, cap: 10 })).toThrow(ValidationError);
    }
  });

  it("puts both numbers into the error details", () => {
    try {
      budgetState({ spent: 5, cap: 0 });
      expect.unreachable("a non-positive cap must not produce a state");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toEqual({ spent: 5, cap: 0 });
    }
  });
});

/**
 * The map is the fuse panel: a provider missing from it is a provider whose
 * spend nothing compares against a cap, and a scope listing the wrong rows
 * compares a fraction of the spend against the whole budget.
 */
describe("BUDGET_SCOPE_BY_PROVIDER", () => {
  it("has an entry for every provider, and for no one else", () => {
    expect(Object.keys(BUDGET_SCOPE_BY_PROVIDER).sort()).toEqual(
      [...PROVIDERS].sort(),
    );
  });

  it("names a cap for every provider that spends quota or money", () => {
    const capped: Record<Provider, string | null> = {
      youtube_data: "youtube_data_units_day",
      // No cap of its own until the OAuth quota of E7-01.
      youtube_analytics: null,
      gemini: "gemini_usd_day",
      elevenlabs: "tts_usd_month",
      openai_tts: "tts_usd_month",
      google_tts: "tts_usd_month",
      cartesia: "tts_usd_month",
      // Our own bookkeeping: `system` rows spend nothing external.
      system: null,
    };

    for (const provider of PROVIDERS) {
      expect(budgetScopeFor(provider)?.key ?? null).toBe(capped[provider]);
    }
  });

  it("sums all four paid speech vendors under the one monthly TTS cap", () => {
    // A cap of $50 a month against one vendor out of four never fires: the
    // spend is spread over `elevenlabs`, `openai_tts`, `google_tts` and
    // `cartesia`, and `gemini-tts` bills as `gemini` on the daily cap.
    const scope = budgetScopeFor("elevenlabs");

    expect(scope).not.toBeNull();
    expect([...(scope as BudgetScope).providers].sort()).toEqual([
      "cartesia",
      "elevenlabs",
      "google_tts",
      "openai_tts",
    ]);
    expect(scope).toMatchObject({ measure: "usd", period: "month" });
  });

  it("counts YouTube in units per day and Gemini in dollars per day", () => {
    expect(budgetScopeFor("youtube_data")).toMatchObject({
      measure: "units",
      period: "day",
      providers: ["youtube_data"],
    });
    expect(budgetScopeFor("gemini")).toMatchObject({
      measure: "usd",
      period: "day",
      providers: ["gemini"],
    });
  });

  /**
   * When a cap rolls over decides how much of it is left, and the YouTube
   * quota rolls over at midnight Pacific: counted in UTC, the units counter
   * restarts at 17:00 PT while Google's does not, and the fuse hands out a
   * second day's worth of units against a quota that is already half gone.
   */
  it("cuts the YouTube day in Pacific time and the money periods in UTC", () => {
    expect(budgetScopeFor("youtube_data")).toMatchObject({
      timeZone: "America/Los_Angeles",
    });
    expect(budgetScopeFor("gemini")).toMatchObject({ timeZone: "UTC" });
    expect(budgetScopeFor("elevenlabs")).toMatchObject({ timeZone: "UTC" });
  });

  it("names zones Postgres and Intl both know", () => {
    // The name travels into `date_trunc(... AT TIME ZONE ...)`, where an
    // unknown zone is an error at the moment a paid call asks about its cap.
    const known = new Set(Intl.supportedValuesOf("timeZone"));

    for (const provider of PROVIDERS) {
      const scope = budgetScopeFor(provider);
      if (scope === null) {
        continue;
      }
      expect(known.has(scope.timeZone) || scope.timeZone === "UTC").toBe(true);
    }
  });

  it("declares exactly the scopes the map uses", () => {
    const used = new Set(
      PROVIDERS.map((provider) => budgetScopeFor(provider)?.key).filter(
        (key) => key !== undefined,
      ),
    );

    expect([...used].sort()).toEqual([...BUDGET_SCOPE_KEYS].sort());
  });
});
