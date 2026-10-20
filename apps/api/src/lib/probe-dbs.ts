import { type ProbeDb, createProbeDb } from "@sf/db";
import type { Logger } from "pino";
import { PROBE_DB_BOUNDS } from "./dependency-timeout.js";

/**
 * How long the `db` stage waits for a query still in flight before the
 * driver destroys it, in seconds (`closeDb({ timeoutSec })`). A probe query
 * is bounded by `PROBE_QUERY_LIMIT_MS` already, but the stop must not lean on
 * that: a Postgres gone silent would otherwise hold the stop until
 * `SHUTDOWN_TIMEOUT_MS` (`compose-app.ts`) and turn a clean SIGTERM into
 * exit code 1. The app stage drains its requests within a deadline of the
 * dependencies, so the two stages together stay well under
 * `SHUTDOWN_TIMEOUT_MS` (docs/TECH_DEBT.md § E0-12H, п.6).
 */
export const DB_CLOSE_TIMEOUT_SEC = 3;

/** The bounded database handles of the api, one per probe, and their stop. */
export interface ProbeDbs {
  health: ProbeDb;
  budget: ProbeDb;
  /**
   * Closes every handle with the bound of the `db` stage
   * (`DB_CLOSE_TIMEOUT_SEC`), and answers once all of them are done: with
   * the first failure, if any (the others are written as warnings).
   */
  close(): Promise<void>;
}

/**
 * Opens the database handles of the api, each on a connection of its own: a
 * read of the budget stuck on one connection must not queue the ping of
 * `/health` behind it. Every handle is bounded by `PROBE_DB_BOUNDS` and
 * writes a warning when its limit destroys a connection - the one line that
 * tells a Postgres gone silent, or a storm of reconnects, from one that is
 * merely slow (docs/TECH_DEBT.md § E0-12H, п.5). A handle added here is
 * closed by the stop with the others, and by a failure to open the next one.
 */
export function openProbeDbs(url: string, log: Pick<Logger, "warn">): ProbeDbs {
  const open = (probe: string): ProbeDb =>
    createProbeDb(url, {
      ...PROBE_DB_BOUNDS,
      onLimit: ({ limitMs }) => {
        log.warn(
          { probe, limitMs },
          "database probe connection destroyed at its limit",
        );
      },
    });
  const health = open("health");
  let budget: ProbeDb;
  try {
    budget = open("budget");
  } catch (err) {
    // The start fails, and nothing will ever stop the handle already opened:
    // it is closed here, or its client outlives the failure. The failure of
    // the start is the answer; a failed close is only written down.
    health.close({ timeoutSec: DB_CLOSE_TIMEOUT_SEC }).catch((closeErr) => {
      log.warn(
        { probe: "health", err: closeErr },
        "database probe handle failed to close after the start failed",
      );
    });
    throw err;
  }
  const handles = { health, budget };
  return {
    ...handles,
    close: async () => {
      // Settled, not raced: a handle whose close fails is the answer of the
      // stage, but only once every other handle is closed too - a stage that
      // answered at the first failure would leave sockets being torn down
      // behind a stop that already reported its code.
      const entries = Object.entries(handles);
      const closed = await Promise.allSettled(
        entries.map(([, handle]) =>
          handle.close({ timeoutSec: DB_CLOSE_TIMEOUT_SEC }),
        ),
      );
      // The first failure is the answer and the stop writes it; the others
      // would be lost behind it, so they are written down here.
      let first: PromiseRejectedResult | undefined;
      for (const [index, outcome] of closed.entries()) {
        if (outcome.status !== "rejected") {
          continue;
        }
        if (first === undefined) {
          first = outcome;
          continue;
        }
        log.warn(
          { probe: entries[index]?.[0], err: outcome.reason },
          "database probe handle failed to close",
        );
      }
      if (first !== undefined) {
        throw first.reason;
      }
    },
  };
}
