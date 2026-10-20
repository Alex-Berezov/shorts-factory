import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/client.js";
import { pingDb } from "../src/health.js";
import { type ProbeDb, ProbeLimitError, createProbeDb } from "../src/probe.js";
import { type Relay, openRelay } from "../test-support/relay.js";

/**
 * The bound of a probe against the real Postgres of the test stack, through a
 * relay that can go silent without closing anything - the half-open socket a
 * changed address of Postgres or a reset of conntrack/NAT leaves behind
 * (docs/TECH_DEBT.md § E0-12H, п.5). A fake that answers at once would prove
 * nothing about a query that never gets an answer.
 */

/**
 * The two bounds of the handle, scaled down from the api (2 s and 4 s) and
 * kept in its proportion. The statement timeout is far above a warm local
 * round trip, so only the sleep below reaches it.
 */
const STATEMENT_TIMEOUT_MS = 500;
const LIMIT_MS = 1_500;
/**
 * A query the server ends by its statement timeout and the handle does not
 * reach: it sleeps half a statement timeout past it and ends half a statement
 * timeout before the limit, so neither a slow start nor a slow answer on a
 * loaded machine moves it across either bound.
 */
const SLEEP_SEC = 1;
/**
 * How late past the limit the refusal may come. Not a measure of the bound -
 * the lower edge (`LIMIT_MS - 50`) is - but a guard against a refusal that
 * only came with the retransmissions of the OS, minutes away: a whole limit
 * of slack keeps a busy machine (a parallel `tsc`, Docker on the same host)
 * from turning it red, and stays far below anything the OS would do.
 */
const LATE_MS = LIMIT_MS;

let relay: Relay | undefined;
let probe: ProbeDb | undefined;

afterEach(async () => {
  relay?.thaw();
  // The query the limit gave up on is already destroyed; a bound keeps a
  // failed case from waiting on a frozen one.
  await probe?.close({ timeoutSec: 1 });
  await relay?.cut();
  probe = undefined;
  relay = undefined;
});

describe("createProbeDb against a silent Postgres", () => {
  it("gives up on a query on a half-open socket at its limit and answers over a new one", async () => {
    relay = await openRelay();
    probe = createProbeDb(relay.url, {
      limitMs: LIMIT_MS,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
    });
    // A live connection first: the freeze has to catch an open socket, not a
    // connect that its own timeout would end.
    await probe.run(pingDb);

    relay.freeze();
    const started = performance.now();
    const outcome = await probe.run(pingDb).then(
      () => "answered",
      (err: unknown) => err,
    );
    const elapsed = performance.now() - started;

    expect(outcome).toBeInstanceOf(ProbeLimitError);
    expect(elapsed).toBeGreaterThanOrEqual(LIMIT_MS - 50);
    expect(elapsed).toBeLessThan(LIMIT_MS + LATE_MS);

    relay.thaw();
    await expect(probe.run(pingDb)).resolves.toBeUndefined();
  });

  /**
   * A Postgres that is there and slow: the server ends the query itself by
   * the statement timeout, before the limit of the handle, and the connection
   * it was on is the one the next call goes over - no reconnect for an honest
   * slow answer (docs/TECH_DEBT.md § E0-12H, п.5).
   */
  it("lets the server end a slow query first and keeps its connection", async () => {
    relay = await openRelay();
    const onLimit = vi.fn();
    probe = createProbeDb(relay.url, {
      limitMs: LIMIT_MS,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      onLimit,
    });
    const seen: Db[] = [];

    const outcome = await probe
      .run((db) => {
        seen.push(db);
        return db.execute(sql`select pg_sleep(${SLEEP_SEC})`);
      })
      .then(
        () => "answered",
        (err: unknown) => err,
      );

    expect(outcome).toMatchObject({ name: "PostgresError", code: "57014" });
    expect(onLimit).not.toHaveBeenCalled();
    await probe.run(async (db) => {
      seen.push(db);
      await pingDb(db);
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
  });

  /**
   * A `statement_timeout` in the DSN would be laid over the one of the probe
   * by the driver: the server would let the sleep run on, past the limit,
   * and the handle would destroy its client instead.
   */
  it("keeps its statement timeout over the one of the DSN", async () => {
    relay = await openRelay();
    const url = new URL(relay.url);
    url.searchParams.set("statement_timeout", "60000");
    const onLimit = vi.fn();
    probe = createProbeDb(url.href, {
      limitMs: LIMIT_MS,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      onLimit,
    });
    const seen: Db[] = [];

    const started = performance.now();
    const outcome = await probe
      .run((db) => {
        seen.push(db);
        return db.execute(sql`select pg_sleep(${SLEEP_SEC})`);
      })
      .then(
        () => "answered",
        (err: unknown) => err,
      );
    const elapsed = performance.now() - started;

    expect(outcome).toMatchObject({ name: "PostgresError", code: "57014" });
    expect(elapsed).toBeLessThan(LIMIT_MS);
    expect(onLimit).not.toHaveBeenCalled();
    await probe.run(async (db) => {
      seen.push(db);
    });
    expect(seen[1]).toBe(seen[0]);
  });

  it("asks the server to end its statements at the statement timeout", async () => {
    relay = await openRelay();
    probe = createProbeDb(relay.url, {
      limitMs: LIMIT_MS,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
    });

    const rows = await probe.run((db) =>
      db.execute<{ statement_timeout: string }>(sql`show statement_timeout`),
    );

    expect(rows[0]?.statement_timeout).toBe(`${STATEMENT_TIMEOUT_MS}ms`);
  });

  /**
   * A host that takes the connection and never answers it - a black hole:
   * the relay is silent from the first byte. The connect gives up by the
   * statement timeout with `CONNECT_TIMEOUT`, which the api reads as
   * unreachable (`dependencyFailureCode`), before the limit: no client is
   * destroyed and nothing is told about a limit.
   */
  it("refuses a connect nobody answers with CONNECT_TIMEOUT before the limit", async () => {
    relay = await openRelay();
    relay.freeze();
    const onLimit = vi.fn();
    probe = createProbeDb(relay.url, {
      limitMs: LIMIT_MS,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      onLimit,
    });
    /** The calls of `end` on each client the work ran on. */
    const ends: Array<{ mock: { calls: unknown[][] } }> = [];

    const started = performance.now();
    const outcome = await probe
      .run((db) => {
        ends.push(vi.spyOn(db.$client, "end"));
        return pingDb(db);
      })
      .then(
        () => "answered",
        (err: unknown) => err,
      );
    const elapsed = performance.now() - started;

    expect(outcome).toMatchObject({ code: "CONNECT_TIMEOUT" });
    expect(elapsed).toBeLessThan(LIMIT_MS);
    expect(onLimit).not.toHaveBeenCalled();
    expect(ends).toHaveLength(1);
    expect(ends[0]?.mock.calls).toEqual([]);
  });
});
