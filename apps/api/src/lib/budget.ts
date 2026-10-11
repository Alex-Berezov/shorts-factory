import type { BudgetStatus } from "@sf/contracts";
import type { Provider } from "@sf/core";
import { type BudgetLimits, type Db, createBudgetGuard } from "@sf/db";
import type { BudgetProbe } from "../deps.js";
import { singleFlight } from "./single-flight.js";

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
 * A minute of cached total would make the answer to "is my spend being
 * counted" depend on when the last job asked. The price is one aggregate per
 * cap - three per request, one index scan each, on a table the api touches
 * nowhere else.
 *
 * Requests that arrive while a read is in flight share it (`singleFlight`):
 * a request that joins a read in flight gets the state as of the start of
 * that read - one read behind at most, nothing kept. It bounds the read a
 * silent Postgres holds - the deadline of the page gives up on it without
 * cancelling it, and without the sharing every open of the page would take
 * three more connections of the pool until there were none left. A query
 * has no timeout of its own (`lib/health.ts`): it lasts until the server
 * answers or the OS breaks the socket - on a half-open socket that is
 * retransmission for up to ~15 minutes, since keepalive only acts on an idle
 * connection - and all that time the section is empty while Postgres is
 * alive.
 */
export function createBudgetProbe(options: ApiBudgetOptions): BudgetProbe {
  const guard = createBudgetGuard({ db: options.db, limits: options.limits });

  const read = async (): Promise<BudgetStatus[]> => {
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
  };

  return { collect: singleFlight(read) };
}
