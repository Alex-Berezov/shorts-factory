import { env } from "@sf/config";
import { sql } from "drizzle-orm";
import type { Db } from "../src/client.js";
import { type ProbeDb, ProbeLimitError, createProbeDb } from "../src/probe.js";
import { silentTestDatabase, unreachableTestDatabase } from "./fixture.js";
import { TEST_STACK, assertLocalTestPostgres } from "./stack-guard.js";

/**
 * A row of `pg_stat_activity` the check reads, narrowed (`sessionsOf`): a
 * backend on the test database other than the check's own.
 */
export interface TestSession {
  readonly pid: number;
  readonly applicationName: string;
  readonly clientAddr: string | null;
  /** Null only for a row the server could not date; named as such. */
  readonly backendStart: string | null;
  readonly backendType: string;
  /** Null while the backend has not finished its start (authentication). */
  readonly state: string | null;
}

/**
 * How the check measures: `samples` reads of `pg_stat_activity` at most,
 * `pauseMs` apart - three seconds in all. A session counts once it is there
 * in two reads (`lastingSessions`): the backend of a client that has just
 * left - the previous package of the same run, the file before - and a probe
 * of a healthcheck live for milliseconds, a file of another run holds its
 * connection for seconds.
 */
export const SESSION_SAMPLING = { samples: 12, pauseMs: 250 } as const;

/**
 * The bounds of the client of the check (`createProbeDb`): the server ends a
 * statement after `statementTimeoutMs` (`57014`), and a read that gets no
 * answer at all - a paused container, a half-open socket, where nothing the
 * server does reaches this side - is given up on after `limitMs`
 * (`ProbeLimitError`). Either is a named refusal of the entry check, not a
 * `globalSetup` that hangs until the run is killed.
 */
export const SESSION_CHECK_BOUNDS = {
  limitMs: 10_000,
  statementTimeoutMs: 5_000,
  // The client of the run lock is this one: a connection replaced by age
  // would let the lock go in the middle of a run.
  keepConnection: true,
} as const;

/**
 * The application name of the check's own client, set in its URL. Every run
 * checks at its start, so the check of a second run is a session the first
 * one would meet in its next entry check (the api after `@sf/db`); and the
 * client of the run lock (`./run-lock.ts`) of the run itself stays open
 * through the check and the whole run. One by this name is not counted
 * (`countedSessions`). A guard against the checks of the harness, not
 * against a client that takes the name on purpose.
 */
export const SESSION_CHECK_APPLICATION = "sf-session-check";

/**
 * The application name `pg_isready` gives its connection: the healthcheck of
 * CI (`.github/workflows/ci.yml`) runs it every five seconds against the test
 * database; the one of Compose (`infra/docker-compose.yml`) asks the dev
 * database and is not seen here at all.
 */
const HEALTHCHECK_APPLICATION = "pg_isready";

/** What the check reads: the other backends of the test database. */
const SESSIONS_QUERY = sql`
  SELECT pid,
         application_name AS "applicationName",
         client_addr::text AS "clientAddr",
         backend_start::text AS "backendStart",
         backend_type AS "backendType",
         state
    FROM pg_stat_activity
   WHERE datname = current_database()
     AND pid <> pg_backend_pid()
   ORDER BY backend_start
`;

/** `query_canceled`: what the server ends a statement with at its `statement_timeout`. */
const STATEMENT_TIMEOUT_STATE = "57014";

/**
 * The entry check against a second integration run on the same test
 * database: every run resets it (`DROP SCHEMA ... CASCADE` in
 * `resetTestDatabase`) or works on what `@sf/db` migrated, so two runs at once
 * break each other - the flaky red of `test:int` next to a gate run in the
 * background (docs/TECH_DEBT.md, E0-12O). The run itself is kept apart by
 * the run lock (`./run-lock.ts`), taken first; this check is the second line
 * behind it - a client that takes no lock: an open `psql` or IDE, a worker a
 * failed run left behind. Both entry checks of `./entry-check/` call it right
 * after the lock, before the first file and before anything else that reads
 * the database - a refusal "not migrated" during the reset of another run
 * would send the reader to run `@sf/db` and break that run too.
 *
 * A client session on the test database other than its own is a refusal
 * that names each by `pid`, `application_name`, `client_addr`, `state` and
 * `backend_start`, and says how to end it - so that a person can tell
 * another run, a worker a failed run left behind, an open `psql` or IDE
 * apart and stop the right one. The refusal carries no connection string.
 *
 * Counted are client backends that have started (`countedSessions`), and only
 * those seen in two reads (`SESSION_SAMPLING`). The client of the check is a
 * probe handle (`createProbeDb`, `SESSION_CHECK_BOUNDS`) named
 * `SESSION_CHECK_APPLICATION`, and a read that fails is one of three
 * refusals: a database it cannot reach (`unreachableTestDatabase`: its
 * address, and Compose for a stack that is not up); a database that does not
 * answer in time (`silentTestDatabase`: `ProbeLimitError` or `57014`); a row
 * of `pg_stat_activity` of another shape (`sessionsOf`, thrown as it is - a
 * new Postgres, not a database that is down). Its client is closed before it
 * returns or throws, so no file of the run meets it: a close that fails
 * after a refusal is the second line of that refusal (`afterFailure`), one
 * that fails after a clean read is a refusal of its own, named as the close
 * of its client (`closeSessionCheckClient`).
 *
 * `onRead` is told the counted sessions of every read before the check
 * decides on them - for a test that must change the database between two
 * reads rather than race them.
 *
 * What it cannot see: a moment the client holds no session - between two of
 * its queries, or a client that connects only after the check. Measured next
 * to a run of `@sf/db`, whose files open and close clients all the time, it
 * passed in about half of the moments (the file of the case E0-12O, Fix 2) -
 * that is why a second run is refused by the lock, not by this count
 * (docs/60_HARNESS.md, «Известные ограничения»).
 */
export async function assertNoOtherTestSessions(
  options: {
    readonly onRead?: (
      read: number,
      counted: readonly TestSession[],
    ) => Promise<void>;
  } = {},
): Promise<void> {
  const probe = openSessionCheckClient();
  const readRows = async (): Promise<readonly unknown[]> => {
    try {
      return await probe.run((db) => db.execute(SESSIONS_QUERY));
    } catch (error) {
      throw sessionCheckRefusal("the sessions", error);
    }
  };
  let reads = 0;
  let others: TestSession[];
  try {
    others = await lastingSessions(async () => {
      // Narrowed outside the catch of the read: a row of another shape is
      // its own refusal, not a database that cannot be reached.
      const counted = countedSessions(sessionsOf(await readRows()));
      reads += 1;
      await options.onRead?.(reads, counted);
      return counted;
    });
  } catch (error) {
    return afterFailure(error, "closing its client", () =>
      probe.close({ timeoutSec: 0 }),
    );
  }
  const refusal = otherSessionsRefusal(others);
  if (refusal !== undefined) {
    return afterFailure(new Error(refusal), "closing its client", () =>
      probe.close({ timeoutSec: 0 }),
    );
  }
  await closeSessionCheckClient(probe, "reading the sessions");
}

/**
 * Closes the client of the checks after `after` went well. A close that
 * fails is a refusal of its own, named as the close of that client - not as
 * a read that failed: what it read was clean, but its session may stay open
 * on the test database. The error of the driver is its last part and its
 * `cause`. Both checks against a second run end their clean path here (this
 * one and `./run-lock.ts`).
 */
export async function closeSessionCheckClient(
  probe: ProbeDb,
  after: string,
): Promise<void> {
  try {
    await probe.close({ timeoutSec: 0 });
  } catch (error) {
    throw new Error(
      `the client of the check did not close after ${after} - its session may stay open on the test database ${TEST_STACK.database}: ${textOf(error)}`,
      { cause: error },
    );
  }
}

/**
 * The client of both checks against a second run - this one and the run lock
 * (`./run-lock.ts`): a probe handle on the guarded test database, bounded by
 * `SESSION_CHECK_BOUNDS` and named `SESSION_CHECK_APPLICATION`.
 */
export function openSessionCheckClient(): ProbeDb {
  assertLocalTestPostgres(env.DATABASE_URL);
  const url = new URL(env.DATABASE_URL);
  url.searchParams.set("application_name", SESSION_CHECK_APPLICATION);
  return createProbeDb(url.toString(), SESSION_CHECK_BOUNDS);
}

/**
 * The refusal of a read of `what` by the client of the checks that failed:
 * silent (`ProbeLimitError`, `57014`) or unreachable.
 */
export function sessionCheckRefusal(what: string, error: unknown): Error {
  if (error instanceof ProbeLimitError) {
    return silentTestDatabase(what, error.limitMs, error);
  }
  if (
    error instanceof Error &&
    Reflect.get(error, "code") === STATEMENT_TIMEOUT_STATE
  ) {
    return silentTestDatabase(
      what,
      SESSION_CHECK_BOUNDS.statementTimeoutMs,
      error,
    );
  }
  return unreachableTestDatabase(what, error);
}

/**
 * Runs `cleanup` after `error` and throws `error` on: a cleanup that fails
 * too does not take its place - its text is the second line of a refusal
 * that keeps the first one's text, and the first one as its `cause`. The
 * form of every refusal of both checks against a second run (this one and
 * `./run-lock.ts`) whose client then fails to close or to let go.
 */
export async function afterFailure(
  error: unknown,
  what: string,
  cleanup: () => Promise<void>,
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new Error(
      `${textOf(error)}\n${what} failed too: ${textOf(cleanupError)}`,
      { cause: error },
    );
  }
  throw error;
}

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The sessions that last: reads `measure` until a read finds none (none
 * lasts) or a session of a read is in an earlier one too (by `pid` and
 * `backend_start`, so a pid the server gave again is another session). After
 * `SESSION_SAMPLING.samples` reads that kept finding sessions, each one new,
 * those of the last read are returned: a database never without a client
 * for three seconds is not free, whoever they are.
 */
async function lastingSessions(
  measure: () => Promise<TestSession[]>,
): Promise<TestSession[]> {
  const seen = new Set<string>();
  let found: TestSession[] = [];
  for (let read = 0; read < SESSION_SAMPLING.samples; read += 1) {
    if (read > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, SESSION_SAMPLING.pauseMs),
      );
    }
    found = await measure();
    if (found.length === 0) {
      return [];
    }
    const lasting = found.filter((session) => seen.has(sessionKey(session)));
    if (lasting.length > 0) {
      return lasting;
    }
    for (const session of found) {
      seen.add(sessionKey(session));
    }
  }
  return found;
}

/**
 * What tells two sessions apart: pid + backend_start. A pid the server gives
 * again is another session - the same pid with another start is not the
 * session seen before.
 */
export function sessionKey(session: TestSession): string {
  return `${session.pid} ${session.backendStart ?? ""}`;
}

/**
 * The sessions of the test database the check counts, read once through
 * `db`: the query, the narrowing (`sessionsOf`) and the filter
 * (`countedSessions`) of the check, for a test that asks which sessions a
 * command left open. The check reads through the same three, apart only in
 * where it catches: a read it cannot make is a refusal of its own there.
 */
export async function countedTestSessions(
  db: Pick<Db, "execute">,
): Promise<TestSession[]> {
  return countedSessions(sessionsOf(await db.execute(SESSIONS_QUERY)));
}

/**
 * The sessions the check counts: client backends - not autovacuum, a
 * parallel worker or another process of the server, which come and go on
 * their own - that have finished their start (`state` set), and that are
 * neither the `pg_isready` of a healthcheck nor the check of another run
 * (`SESSION_CHECK_APPLICATION`).
 */
function countedSessions(sessions: readonly TestSession[]): TestSession[] {
  return sessions.filter(
    (session) =>
      session.backendType === "client backend" &&
      session.state !== null &&
      session.applicationName !== HEALTHCHECK_APPLICATION &&
      session.applicationName !== SESSION_CHECK_APPLICATION,
  );
}

/**
 * The rows of the query of the check, each narrowed to a `TestSession`; a
 * row of another shape is thrown with its text - a column renamed by a new
 * Postgres must not turn into a session the check counts or misses.
 */
export function sessionsOf(rows: readonly unknown[]): TestSession[] {
  return rows.map((row) => {
    const pid = field(row, "pid");
    const applicationName = field(row, "applicationName");
    const clientAddr = field(row, "clientAddr");
    const backendStart = field(row, "backendStart");
    const backendType = field(row, "backendType");
    const state = field(row, "state");
    if (
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      typeof applicationName !== "string" ||
      !isTextOrNull(clientAddr) ||
      !isTextOrNull(backendStart) ||
      typeof backendType !== "string" ||
      !isTextOrNull(state)
    ) {
      throw new Error(
        `pg_stat_activity gave a row the session check cannot read: ${JSON.stringify(row)}`,
      );
    }
    return {
      pid,
      applicationName,
      clientAddr,
      backendStart,
      backendType,
      state,
    };
  });
}

function field(row: unknown, name: string): unknown {
  return typeof row === "object" && row !== null
    ? Reflect.get(row, name)
    : undefined;
}

function isTextOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** The text of the refusal for the sessions found, undefined for none. */
export function otherSessionsRefusal(
  others: readonly TestSession[],
): string | undefined {
  if (others.length === 0) {
    return undefined;
  }
  const listed = others
    .map(
      ({ pid, applicationName, clientAddr, state, backendStart }) =>
        `pid=${pid} application_name=${JSON.stringify(applicationName)} client_addr=${clientAddr ?? "local socket"} state=${state ?? "starting"} backend_start=${backendStart ?? "unknown"}`,
    )
    .join("; ");
  const pids = others.map(({ pid }) => pid).join(", ");
  // The user is the one of the URL the guard passed; the password is not named.
  const user = new URL(env.DATABASE_URL).username;
  return `${others.length} other session(s) on the test database ${TEST_STACK.database}: ${listed} - another integration run, a process it left behind, or an open psql/IDE works on it; a second run would reset the database under the first. Wait for it or close it, then run again; a session nothing ends any more is ended by its pid: docker compose -f infra/docker-compose.yml exec postgres psql -U ${user} -d ${TEST_STACK.database} -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid IN (${pids})"`;
}
