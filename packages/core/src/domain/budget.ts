import { ValidationError } from "./errors.js";

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
