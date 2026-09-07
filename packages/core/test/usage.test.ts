import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { PROVIDERS } from "../src/domain/provider.js";
import type { Provider } from "../src/domain/provider.js";
import { ApiUsageEntrySchema } from "../src/domain/usage.js";
import type { ApiUsageEntry, UsageLogger } from "../src/domain/usage.js";

/**
 * The entry is what E0-09 turns into a row of `api_usage_log`, so the shape is
 * checked here rather than at every integration. The rule that matters most is
 * "a call reports what it cost in the unit its cap is counted in": a YouTube
 * call without `units` or a Gemini call without `costUsd` would make the spend
 * invisible to the cap that was supposed to stop it.
 */
describe("ApiUsageEntrySchema", () => {
  it("rejects an entry that reports no cost at all", () => {
    const parsed = ApiUsageEntrySchema.safeParse({
      provider: "gemini",
      operation: "generateContent",
    });

    expect(parsed.success).toBe(false);
    // The discriminated union names the missing measure: the operator of E0-09
    // reads the path out of the DLQ, so it has to point at the field that was
    // actually missing.
    expect(parsed.error?.issues[0]?.path).toEqual(["costUsd"]);
  });

  it("makes a quota provider report units", () => {
    // Dollars say nothing about a quota that is counted in units, so an entry
    // priced only in dollars would leave `sumUnitsToday` at zero.
    const priced = ApiUsageEntrySchema.safeParse({
      provider: "youtube_data",
      operation: "videos.list",
      costUsd: 0,
    });

    expect(priced.success).toBe(false);
    expect(priced.error?.issues[0]?.path).toEqual(["units"]);

    expect(
      ApiUsageEntrySchema.safeParse({
        provider: "youtube_analytics",
        operation: "reports.query",
        units: 1,
      }).success,
    ).toBe(true);
  });

  it("makes a paid provider report costUsd", () => {
    // Tokens explain the price, they are not the price:
    // `GEMINI_DAILY_BUDGET_USD` cannot be summed from them.
    expect(
      ApiUsageEntrySchema.safeParse({
        provider: "gemini",
        operation: "generateContent",
        tokensIn: 1200,
        tokensOut: 300,
      }).success,
    ).toBe(false);

    expect(
      ApiUsageEntrySchema.safeParse({
        provider: "elevenlabs",
        operation: "textToSpeech",
        costUsd: 0.12,
      }).success,
    ).toBe(true);
  });

  it("asks no measure of system, which spends nothing external", () => {
    expect(
      ApiUsageEntrySchema.safeParse({
        provider: "system",
        operation: "heartbeat",
      }).success,
    ).toBe(true);
  });

  it("prices every provider", () => {
    // Two guards, one for each direction of the drift: a provider added to
    // `PROVIDERS` without a measure falls out of every branch of the union (and
    // out of every cap), while a value invented in a branch alone is not a
    // `Provider` and never reaches `api_usage_log.provider`.
    expectTypeOf<ApiUsageEntry["provider"]>().toEqualTypeOf<Provider>();

    for (const provider of PROVIDERS) {
      const parsed = ApiUsageEntrySchema.safeParse({
        provider,
        operation: "probe",
        units: 1,
        costUsd: 0.01,
      });

      expect(parsed.success, provider).toBe(true);
    }
  });

  it("accepts a measure of zero - a free call still reports it", () => {
    expect(
      ApiUsageEntrySchema.safeParse({
        provider: "youtube_data",
        operation: "videos.list",
        units: 0,
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown key instead of dropping it", () => {
    // `unit` for `units` would otherwise leave the entry both unpriced and
    // valid.
    const parsed = ApiUsageEntrySchema.safeParse({
      provider: "youtube_data",
      operation: "videos.list",
      units: 1,
      unit: 1,
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.code).toBe("unrecognized_keys");
  });

  it("accepts a fully priced call", () => {
    const parsed = ApiUsageEntrySchema.parse({
      provider: "youtube_data",
      operation: "videos.list",
      units: 1,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      jobId: "radar.score/42/1h",
    });

    expect(parsed.units).toBe(1);
    expect(parsed.jobId).toBe("radar.score/42/1h");
  });

  it("rejects an empty operation", () => {
    expect(
      ApiUsageEntrySchema.safeParse({
        provider: "gemini",
        operation: "",
        costUsd: 0.01,
      }).success,
    ).toBe(false);
  });

  it("rejects negative or fractional units", () => {
    for (const units of [-1, 1.5]) {
      expect(
        ApiUsageEntrySchema.safeParse({
          provider: "youtube_data",
          operation: "videos.list",
          units,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects a negative cost", () => {
    const parsed = ApiUsageEntrySchema.safeParse({
      provider: "gemini",
      operation: "generateContent",
      costUsd: -0.01,
    });

    expect(parsed.success).toBe(false);
    // What turns red on its own is `success`: drop `nonnegative()` here, or
    // `.strict()` in the unknown-key case, and the entry parses. The path, the
    // code and the message pin the contract instead - E0-09 shows the field to
    // fix out of the DLQ, not a blanket line about a measure that was reported.
    expect(parsed.error?.issues[0]?.path).toEqual(["costUsd"]);
    expect(parsed.error?.issues[0]?.message).not.toContain("must report");
  });

  it("rejects an unknown provider", () => {
    const parsed = ApiUsageEntrySchema.safeParse({
      provider: "youtube-data",
      operation: "videos.list",
      units: 1,
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["provider"]);
  });
});

describe("ApiUsageEntry", () => {
  it("is the type the schema parses, with nothing written twice", () => {
    // A refinement on top of one object would infer every measure as optional
    // while the exported type demanded one: `parse` would then not be
    // assignable to it, and E0-09 would need a cast to log what it validated.
    expectTypeOf<
      z.infer<typeof ApiUsageEntrySchema>
    >().toEqualTypeOf<ApiUsageEntry>();

    const logged: ApiUsageEntry = ApiUsageEntrySchema.parse({
      provider: "gemini",
      operation: "generateContent",
      costUsd: 0.0004,
    });

    expect(logged.provider).toBe("gemini");
  });

  it("does not let a caller build an entry without its measure", () => {
    // The compiler carries the same rule as the schema: this is what stops
    // `logUsage({ provider, operation })` in an integration.
    expectTypeOf<{
      provider: "youtube_data";
      operation: "videos.list";
    }>().not.toMatchTypeOf<ApiUsageEntry>();

    expectTypeOf<{
      provider: "gemini";
      operation: "generateContent";
      tokensIn: number;
    }>().not.toMatchTypeOf<ApiUsageEntry>();

    expectTypeOf<{
      provider: "youtube_data";
      operation: "videos.list";
      units: number;
    }>().toMatchTypeOf<ApiUsageEntry>();
  });
});

describe("UsageLogger", () => {
  it("takes an entry of the schema and resolves to nothing", async () => {
    const written: ApiUsageEntry[] = [];
    const logger: UsageLogger = async (entry) => {
      written.push(entry);
    };

    expectTypeOf<UsageLogger>().parameter(0).toEqualTypeOf<ApiUsageEntry>();
    expectTypeOf<UsageLogger>().returns.toEqualTypeOf<Promise<void>>();

    await logger({ provider: "system", operation: "heartbeat", units: 0 });

    expect(written).toEqual([
      { provider: "system", operation: "heartbeat", units: 0 },
    ]);
  });
});
