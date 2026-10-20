import { type Db, clientOptions, closeDb, openDb } from "./client.js";

/**
 * The refusal of `ProbeDb.run` when the client the work was on was given up
 * on by the limit of the probe: the work itself outlived the limit, or it was
 * waiting on the same connection behind work that did. The client is
 * ended with it, so the caller is not left hanging on the query behind it.
 */
export class ProbeLimitError extends Error {
  readonly code = "PROBE_LIMIT";

  constructor(readonly limitMs: number) {
    super(`probe query outlived its limit of ${limitMs} ms`);
    this.name = "ProbeLimitError";
  }
}

/** The refusal of `ProbeDb.run` after `close()`: no client is opened again. */
export class ProbeClosedError extends Error {
  readonly code = "PROBE_CLOSED";

  constructor() {
    super("probe database handle is closed");
    this.name = "ProbeClosedError";
  }
}

/**
 * A database handle for a probe - a liveness check, a status read - whose
 * every call ends by `limitMs` however the database behaves.
 *
 * A query of postgres-js has no time limit of its own: `connect_timeout` is
 * lifted once the connection is ready, and on a half-open socket (a changed
 * address of Postgres, a reset of conntrack/NAT) the query waits for the
 * retransmissions of the operating system, up to ~15 minutes, while every
 * caller that shares it waits too. Two bounds close that, one per kind of
 * silence:
 *
 * - `statement_timeout` of the session is `statementTimeoutMs`, shorter than
 *   `limitMs`: a server that is there and slow ends the query itself, first,
 *   with `57014`, and the connection lives on for the next call. First on a
 *   connection that is already open: on a fresh client the connect comes
 *   before the query, and a connect and a statement that each take their
 *   whole bound use up a limit of twice the statement timeout with nothing
 *   to spare - a database that slow is treated as a silent one. The server
 *   bounds each statement and the limit the whole call, so a call is meant
 *   to be one statement - three in a row would take the server's bound
 *   three times over, past the limit;
 * - `run` holds its own timer of `limitMs`, only for a socket that cannot
 *   answer at all - the half-open one, where nothing the server does reaches
 *   this side. The client the work was on is ended
 *   (`end({ timeout: 0 })`: the call is released and the socket is closed
 *   with a FIN; a half-open one lives on until the OS timeout), every call on it is refused with
 *   `ProbeLimitError`, the query in flight is rejected by the driver and that
 *   rejection is swallowed here, a fresh client takes its place, so the
 *   next `run` goes over a new connection instead of joining the dead one,
 *   and `onLimit` is told. The timer does not keep the process up, and
 *   `close()` disarms it.
 *
 * The connect of every client is bounded by `statementTimeoutMs` as well
 * (`connect_timeout`): a host that never answers the connect is
 * `CONNECT_TIMEOUT` - unreachable - before the limit, not an ended client.
 * A caller whose own deadline equals `statementTimeoutMs` sees that deadline
 * before `CONNECT_TIMEOUT`, since its timer is armed before the connect.
 *
 * One connection (`max: 1`): a probe sends one query at a time, and a pool
 * would only hold more sockets for the dead one to take down. Cancelling the
 * query (`Query.cancel()`) is not what ends it: on a half-open socket the
 * answer to a cancel would travel the same dead route, and postgres-js loses
 * the promise of a cancel to `unhandledRejection` (docs/TECH_DEBT.md
 * § E0-12H, п.5; docs/adr/0002-db-connection-and-cli-config.md).
 *
 * `statement_timeout` lives on this client only, never in `clientOptions` or
 * `createDb`: a migration or a worker job has no business being cut at the
 * limit of a probe. It is a startup parameter of the session, which a pooler
 * in transaction mode refuses unless told to ignore it (the ADR above).
 */
export interface ProbeDb {
  /**
   * Runs `fn` against the current client and settles by `limitMs` at the
   * latest while the handle is open: with the answer of `fn`, its failure, or
   * `ProbeLimitError`. Refuses with `ProbeClosedError` after `close()`, and a
   * call in flight at the close is settled by the close, not by its limit
   * (`close`).
   */
  run<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /**
   * Closes the current client and waits for every client a limit destroyed.
   * `timeoutSec` bounds how long a query in flight on the current client is
   * waited for (`closeDb`): it is the bound of the stop, and the limits of
   * the calls in flight are disarmed by `close()` - no timer of a closed
   * handle keeps the process up or answers `ProbeLimitError`. A call in
   * flight settles with its work, whose query the close lets finish or the
   * driver rejects; one still unsettled once the close is done is refused
   * with `ProbeClosedError`. Settles once for every call: a failure of the
   * close is the answer of each, given after the destroyed clients are done
   * all the same.
   */
  close(opts: { timeoutSec: number }): Promise<void>;
}

/** How a probe handle is opened. */
export interface ProbeDbOptions {
  /** The bound of `run`: the life of a call on a socket that cannot answer. */
  limitMs: number;
  /**
   * The `statement_timeout` of the session, below `limitMs`: the server ends
   * a slow query first and the connection is kept.
   */
  statementTimeoutMs: number;
  /**
   * Told when the limit destroys a client - the one sign that the database
   * went silent rather than slow. The package has no logger of its own; the
   * caller writes it. Called once the end of the client has been started,
   * not after it settled; a throw from it is swallowed and changes nothing
   * about the destruction or the refusals.
   */
  onLimit?: (event: { limitMs: number }) => void;
}

/** A call of `run` that has not settled yet. */
interface PendingCall {
  /** Settles the call with `err`, unless it has settled already. */
  refuse(err: Error): void;
  /** Stops its limit from firing, leaving the call to its work. */
  disarm(): void;
}

/**
 * Both bounds are whole positive milliseconds. Zero is not "a short bound"
 * but none at all: a `statement_timeout` of 0 is no limit for Postgres and a
 * `connect_timeout` of 0 none for the driver, so every slow answer would run
 * into the limit and cost a destroyed client.
 */
function assertBound(name: string, value: number): void {
  if (!(Number.isInteger(value) && value > 0)) {
    throw new RangeError(
      `${name} (${value}) must be a positive whole number of ms`,
    );
  }
}

/**
 * The url without a `statement_timeout` query parameter. postgres-js lays the
 * query parameters of a DSN over `connection`, so one left in `DATABASE_URL`
 * would replace the statement timeout of the probe - the server would stop
 * ending slow queries first and every one of them would run into the limit.
 * The DSN is not refused for it: the parameter is legitimate for every other
 * client of the same url.
 */
function withoutStatementTimeout(url: string): string {
  const parsed = new URL(url);
  // Names of settings are case-insensitive for Postgres: `STATEMENT_TIMEOUT=0`
  // lifts the bound of the server as surely as the lower-case name does.
  const names = [...parsed.searchParams.keys()].filter(
    (name) => name.toLowerCase() === "statement_timeout",
  );
  if (names.length === 0) {
    return url;
  }
  for (const name of names) {
    parsed.searchParams.delete(name);
  }
  return parsed.href;
}

/**
 * Opens a bounded handle on `url` (see `ProbeDb`). Refuses with a
 * `RangeError` a bound that is not a positive whole number of milliseconds,
 * and a `statementTimeoutMs` that is not below `limitMs`: the server would
 * never get to end a slow query before the handle destroys its connection,
 * and every honest slow answer would cost a reconnect.
 */
export function createProbeDb(url: string, opts: ProbeDbOptions): ProbeDb {
  const { limitMs, statementTimeoutMs, onLimit } = opts;
  assertBound("limitMs", limitMs);
  assertBound("statementTimeoutMs", statementTimeoutMs);
  if (!(statementTimeoutMs < limitMs)) {
    throw new RangeError(
      `statementTimeoutMs (${statementTimeoutMs}) must be below limitMs (${limitMs})`,
    );
  }
  const target = withoutStatementTimeout(url);
  // The connect is bounded by the statement timeout too: a host that takes
  // the connection and never answers it (a black hole) is `CONNECT_TIMEOUT`,
  // an unreachable database, well before the limit would destroy the client
  // and call the same silence a timeout.
  //
  // No type fetch: by default postgres-js asks `pg_type` on every new
  // connection before the first query, a second statement under the bound
  // that `limitMs` only allows one of. A probe reads no custom types, and a
  // fresh client after a destroyed one would fetch them all over again.
  const open = (): Db =>
    openDb(target, {
      ...clientOptions({
        max: 1,
        connectTimeoutSec: statementTimeoutMs / 1000,
      }),
      fetch_types: false,
      connection: { statement_timeout: statementTimeoutMs },
    });

  let current = open();
  let closed = false;
  let closing: Promise<void> | undefined;
  /** Clients a limit destroyed whose `end()` has not settled yet. */
  const destroying = new Set<Promise<void>>();
  /** The calls waiting on each client, refused together when it is destroyed. */
  const waiting = new Map<Db, Set<PendingCall>>();

  const destroy = (db: Db): void => {
    for (const call of waiting.get(db) ?? []) {
      call.refuse(new ProbeLimitError(limitMs));
    }
    waiting.delete(db);
    if (db !== current) {
      return;
    }
    current = open();
    const ended: Promise<void> = db.$client
      .end({ timeout: 0 })
      .catch(() => undefined)
      .finally(() => {
        destroying.delete(ended);
      });
    destroying.add(ended);
    // Told last, once the client is on its way down, and never allowed to
    // throw out of here: a callback that fails is the caller's to fix, while
    // a throw from the timer would be an uncaught exception of the process.
    try {
      onLimit?.({ limitMs });
    } catch {
      // Nothing to tell it to: the package has no logger of its own.
    }
  };

  const pendingCalls = (): PendingCall[] =>
    [...waiting.values()].flatMap((calls) => [...calls]);

  return {
    run<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      if (closed) {
        return Promise.reject(new ProbeClosedError());
      }
      const db = current;
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const calls = waiting.get(db) ?? new Set<PendingCall>();
        waiting.set(db, calls);
        const settle = (): boolean => {
          if (settled) {
            return false;
          }
          settled = true;
          clearTimeout(timer);
          calls.delete(call);
          return true;
        };
        const call: PendingCall = {
          refuse: (err) => {
            if (settle()) {
              reject(err);
            }
          },
          disarm: () => {
            clearTimeout(timer);
          },
        };
        calls.add(call);
        // Fires only while the handle is open: `close()` disarms it. A timer
        // that kept the process up would make a stop wait out the limit.
        const timer = setTimeout(() => {
          if (!settled) {
            destroy(db);
          }
        }, limitMs);
        timer.unref();
        let work: Promise<T>;
        try {
          work = fn(db);
        } catch (err) {
          work = Promise.reject(err);
        }
        // Both branches stay attached after the limit: the query the limit
        // gave up on is rejected by the driver once its client is destroyed,
        // and that rejection must land here rather than nowhere.
        work.then(
          (value) => {
            if (settle()) {
              resolve(value);
            }
          },
          (err: unknown) => {
            if (settle()) {
              reject(err);
            }
          },
        );
      });
    },

    close(closeOpts: { timeoutSec: number }): Promise<void> {
      if (closing === undefined) {
        closed = true;
        // The query in flight is left to the bound of the stop: no limit
        // destroys a client from here on, and none ends the current one a
        // second time and cuts that bound short.
        for (const call of pendingCalls()) {
          call.disarm();
        }
        closing = (async () => {
          // Settled, not raced: a close of the current client that fails
          // still waits for the clients a limit destroyed before it answers.
          const [ended] = await Promise.allSettled([
            closeDb(current, closeOpts),
            ...destroying,
          ]);
          // Whatever the close left unanswered has no client to answer it.
          for (const call of pendingCalls()) {
            call.refuse(new ProbeClosedError());
          }
          if (ended?.status === "rejected") {
            throw ended.reason;
          }
        })();
      }
      return closing;
    },
  };
}
