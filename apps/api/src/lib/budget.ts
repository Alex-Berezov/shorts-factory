import type { BudgetStatus } from "@sf/contracts";
import type { Provider } from "@sf/core";
import {
  type BudgetLimits,
  type Db,
  type ProbeDb,
  countBudgetChecks,
} from "@sf/db";
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
  /** The bounded handle of the section (`createProbeDb`), its own. */
  db: ProbeDb;
  limits: BudgetLimits;
}

/**
 * The spend section of `/system/status`: the caps the guard of the worker
 * counts against, read **without a cache** (`countBudgetChecks`).
 *
 * A minute of cached total would make the answer to "is my spend being
 * counted" depend on when the last job asked. The price is one statement per
 * read, every cap a scalar subquery of it over the index by its own window
 * (`readCaps`, `apiUsageLogRepo.sumUsages`), on a table the api touches
 * nowhere else.
 *
 * Requests that arrive while a read is in flight share it (`singleFlight`):
 * a request that joins a read in flight gets the state as of the start of
 * that read - one read behind at most, nothing kept. It bounds the read a
 * silent Postgres holds - the deadline of the page gives up on it without
 * cancelling it, and without the sharing every open of the page would queue
 * one more read behind the stuck one. The read lives no longer than the
 * limit of its handle, `PROBE_QUERY_LIMIT_MS` (`createProbeDb` of `@sf/db`):
 * past it the connection is destroyed and the next open of the page reads
 * over a new one, on a half-open socket too (docs/TECH_DEBT.md § E0-12H,
 * п.5).
 *
 * Each read goes over the client the handle runs it on: a client destroyed by
 * the limit is replaced, and nothing here holds on to the one before.
 */
export function createBudgetProbe(options: ApiBudgetOptions): BudgetProbe {
  const read = (): Promise<BudgetStatus[]> =>
    options.db.run((db) => readCaps(db, options.limits));

  return { collect: singleFlight(read) };
}

/**
 * Every cap and where it stands, over `db`, in one statement
 * (`countBudgetChecks`). The handle ends each statement at its timeout and
 * the whole call at its limit, so a read of one statement is bounded by the
 * server on an open connection, as the ping of `/health` is; on a fresh
 * client the connect and the statement together use up the limit
 * (`PROBE_QUERY_LIMIT_MS`). Three statements in a row would each get the
 * timeout and together outlive both the deadline of the section and the
 * limit (docs/TECH_DEBT.md § E0-12H, п.5).
 */
async function readCaps(db: Db, limits: BudgetLimits): Promise<BudgetStatus[]> {
  const checks = await countBudgetChecks(db, limits, CAP_REPRESENTATIVES);

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
}
