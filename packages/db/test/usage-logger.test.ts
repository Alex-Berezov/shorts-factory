import { ValidationError } from "@sf/core";
import { describe, expect, it } from "vitest";
import { toCostUsdColumn, toUsageRow } from "../src/usage-logger.js";

describe("toUsageRow validation", () => {
  it("refuses a paid call that reports no price", () => {
    // The entry is assembled from a provider response, so the rule "dollars
    // for the paid vendors" has to hold at runtime and not only in the types
    // of whoever built it: a Gemini row without `costUsd` is spend no
    // aggregate ever sums, and the daily budget stays at zero while the money
    // goes out.
    expect(() =>
      // @ts-expect-error the missing `costUsd` is the point of the case: the
      // union of `@sf/core` requires a price from a paid provider.
      toUsageRow({
        provider: "gemini",
        operation: "generateContent",
        tokensIn: 100,
      }),
    ).toThrow(ValidationError);
  });

  it("refuses a YouTube call that reports no units", () => {
    expect(() =>
      // @ts-expect-error same rule, other half: quota is what YouTube spends.
      toUsageRow({ provider: "youtube_data", operation: "videos.list" }),
    ).toThrow(ValidationError);
  });

  it("names the field but never the value it rejected", () => {
    try {
      toUsageRow({
        // @ts-expect-error a provider outside `PROVIDERS`: what a response
        // parsed from `unknown` looks like once a mapping has drifted.
        provider: "ya29.a0-secret-token",
        operation: "generateContent",
        costUsd: 1,
      });
      expect.unreachable("an unknown provider must not become a row");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const reported = JSON.stringify({
        message: (error as ValidationError).message,
        details: (error as ValidationError).details,
      });
      expect(reported).not.toContain("ya29.a0-secret-token");
      expect(reported).toContain("provider");
    }
  });
});

describe("toUsageRow mapping", () => {
  it("writes the cost as a string and the absent measures as null", () => {
    // The column is `numeric(10, 5)`: the driver takes a string, and the
    // optional fields of an entry are `undefined`, which is not the `null` a
    // column is written with.
    expect(
      toUsageRow({
        provider: "elevenlabs",
        operation: "tts.synthesize",
        costUsd: 0.25,
      }),
    ).toEqual({
      provider: "elevenlabs",
      operation: "tts.synthesize",
      units: null,
      tokensIn: null,
      tokensOut: null,
      costUsd: "0.25000",
      jobId: null,
    });
  });

  it("never stamps the row with the clock of this process", () => {
    // `created_at` is what the aggregate windows end on, and it belongs to the
    // database clock: a process running ahead would write rows outside the
    // window that counts them.
    const row = toUsageRow({
      provider: "system",
      operation: "smoke",
      units: 0,
    });

    expect(Object.keys(row)).not.toContain("createdAt");
  });

  it("keeps the tokens that explain a price", () => {
    expect(
      toUsageRow({
        provider: "gemini",
        operation: "generateContent",
        tokensIn: 1_200,
        tokensOut: 300,
        costUsd: 0.002,
      }),
    ).toMatchObject({ tokensIn: 1_200, tokensOut: 300, costUsd: "0.00200" });
  });

  it("fills in the job of the logger, and keeps the one the entry names", () => {
    const entry = {
      provider: "youtube_data",
      operation: "videos.list",
      units: 3,
    } as const;

    expect(toUsageRow(entry, { jobId: "system.smoke/1" }).jobId).toBe(
      "system.smoke/1",
    );
    // A client that knows better - a retry replaying the call of another job -
    // must not have its own job overwritten.
    expect(
      toUsageRow(
        { ...entry, jobId: "radar.sync-channels/UC123" },
        { jobId: "system.smoke/1" },
      ).jobId,
    ).toBe("radar.sync-channels/UC123");
    expect(toUsageRow(entry).jobId).toBeNull();
  });
});

/**
 * The cap is compared against these numbers, so the only direction the
 * rounding may err in is up. Rounding to the nearest loses every call cheaper
 * than half a hundredth of a cent - and a fan-out of cheap calls is precisely
 * the shape of spend a daily budget exists for.
 */
describe("toCostUsdColumn", () => {
  const cases: Array<[number, string]> = [
    [0.0001, "0.00010"],
    // Prices that already have five decimals and nothing to round, but whose
    // scaled product carries binary noise above the integer (measured:
    // `0.00051 * 1e5` is 51.00000000000001, `0.07 * 1e5` is
    // 7000.000000000001). A `Math.ceil` on the raw product charges the next
    // unit up for both - two per cent on the first of them - so the noise is
    // cleaned off before rounding.
    [0.00051, "0.00051"],
    [0.07, "0.07000"],
    // Below the smallest unit the column holds: recorded as that unit, not as
    // nothing.
    [0.000004, "0.00001"],
    [1e-9, "0.00001"],
    // Free is free: a call that cost nothing must not count against a budget.
    [0, "0.00000"],
    [0.25, "0.25000"],
    [1.234567, "1.23457"],
    [12.5, "12.50000"],
  ];

  for (const [value, expected] of cases) {
    it(`writes ${value} as ${expected}`, () => {
      expect(toCostUsdColumn(value)).toBe(expected);
    });
  }

  it("writes an unreported cost as null, not as zero", () => {
    // A YouTube call spends quota, not money: a zero here would make it look
    // like a priced call that happened to be free.
    expect(toCostUsdColumn(undefined)).toBeNull();
  });
});
