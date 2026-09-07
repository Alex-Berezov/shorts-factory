import { describe, expect, it } from "vitest";
import { BUDGET_WARN_RATIO, budgetState } from "../src/domain/budget.js";
import { ValidationError } from "../src/domain/errors.js";

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
