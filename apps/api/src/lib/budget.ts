import type { BudgetStatus } from "@sf/contracts";
import type { Provider } from "@sf/core";
import { type BudgetLimits, type Db, createBudgetGuard } from "@sf/db";
import type { BudgetProbe } from "../deps.js";

/**
 * One provider per cap, so that each cap is counted once. Which cap a provider
 * spends against is decided in `@sf/core`; this list only has to name a member
 * of every scope, and the guard answers with the scope itself.
 */
export const CAP_REPRESENTATIVES: readonly Provider[] = [
  "youtube_data",
  "gemini",
  "elevenlabs",
];

export interface ApiBudgetOptions {
  db: Db;
  limits: BudgetLimits;
}

/**
 * The spend section of `/system/status`: the same guard the worker asks,
 * **without a cache**.
 *
 * The page is what proves a row written a moment ago is accounted for, and a
 * minute of cached total would make the answer to "is my spend being counted"
 * depend on when the last job asked. The price is one aggregate per cap -
 * three per request, one index scan each, on a table the api touches nowhere
 * else.
 */
export function createBudgetProbe(options: ApiBudgetOptions): BudgetProbe {
  const guard = createBudgetGuard({ db: options.db, limits: options.limits });

  return {
    async collect(): Promise<BudgetStatus[]> {
      const checks = await Promise.all(
        CAP_REPRESENTATIVES.map((provider) => guard.check(provider)),
      );

      return checks.flatMap((check): BudgetStatus[] =>
        check === null
          ? []
          : [
              {
                key: check.scope.key,
                measure: check.scope.measure,
                period: check.scope.period,
                timeZone: check.scope.timeZone,
                spent: check.spent,
                cap: check.cap,
                ratio: check.ratio,
                warn: check.warn,
                exceeded: check.exceeded,
              },
            ],
      );
    },
  };
}
