import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/client.js";
import {
  ProbeClosedError,
  ProbeLimitError,
  createProbeDb,
} from "../src/probe.js";

/** A port nothing listens on: no case below sends a byte anywhere. */
const URL = "postgres://sf:sf@127.0.0.1:1/nowhere";
const LIMIT_MS = 4_000;
const STATEMENT_TIMEOUT_MS = 2_000;
const OPTIONS = { limitMs: LIMIT_MS, statementTimeoutMs: STATEMENT_TIMEOUT_MS };

interface RecordedClient {
  args: unknown[];
  end: ReturnType<typeof vi.fn>;
}

/**
 * The driver behind a spy: every client it opens is recorded with its `end`
 * replaced, so the cases count which client was ended, how, and how many were
 * opened. Opening a client sends nothing, and no case runs a query.
 */
const driver = vi.hoisted(() => ({ clients: [] as RecordedClient[] }));

vi.mock("postgres", async (importOriginal) => {
  const actual = await importOriginal<{
    default: (...args: unknown[]) => { end: unknown };
  }>();
  const { vi: hoistedVi } = await import("vitest");
  const spy = (...args: unknown[]): unknown => {
    const client = actual.default(...args);
    const end = hoistedVi.fn(async () => undefined);
    client.end = end;
    driver.clients.push({ args, end });
    return client;
  };
  return { ...actual, default: spy };
});

beforeEach(() => {
  driver.clients = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A piece of work that settles only when the case says so. */
function manual<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (err: unknown) => void = () => undefined;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("createProbeDb", () => {
  /**
   * The server ends a slow query itself, before the limit: the bound for a
   * Postgres that is there, which keeps the connection. Only this client
   * carries it.
   */
  it("opens one connection whose statements the server ends before the limit", () => {
    createProbeDb(URL, OPTIONS);

    expect(driver.clients).toHaveLength(1);
    expect(driver.clients[0]?.args[1]).toMatchObject({
      max: 1,
      connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
    });
  });

  /**
   * A host that takes the connection and never answers it is unreachable,
   * not a timeout: the connect gives up by the statement timeout, before the
   * limit would destroy the client.
   */
  it("bounds the connect of its client by the statement timeout", () => {
    createProbeDb(URL, OPTIONS);

    expect(driver.clients[0]?.args[1]).toMatchObject({
      connect_timeout: STATEMENT_TIMEOUT_MS / 1000,
    });
  });

  /**
   * A statement timeout at or past the limit would never get to end a slow
   * query: the handle would destroy its connection first, every time.
   */
  it.each([LIMIT_MS, LIMIT_MS + 1])(
    "refuses a statement timeout of %i ms that is not below the limit",
    (statementTimeoutMs) => {
      expect(() =>
        createProbeDb(URL, { limitMs: LIMIT_MS, statementTimeoutMs }),
      ).toThrow(
        new RangeError(
          `statementTimeoutMs (${statementTimeoutMs}) must be below limitMs (${LIMIT_MS})`,
        ),
      );
      expect(driver.clients).toHaveLength(0);
    },
  );

  /**
   * Zero is no bound at all for Postgres and for the driver, and a negative
   * or fractional one is nobody's intent: each would pass the order check and
   * leave a slow answer to the limit.
   */
  it.each([
    ["limitMs", 0],
    ["limitMs", -1],
    ["limitMs", Number.NaN],
    ["limitMs", 1.5],
    ["limitMs", Number.POSITIVE_INFINITY],
    ["statementTimeoutMs", 0],
    ["statementTimeoutMs", -1],
    ["statementTimeoutMs", Number.NaN],
    ["statementTimeoutMs", 1.5],
    ["statementTimeoutMs", Number.POSITIVE_INFINITY],
  ] as const)("refuses %s of %s", (field, value) => {
    expect(() => createProbeDb(URL, { ...OPTIONS, [field]: value })).toThrow(
      new RangeError(
        `${field} (${value}) must be a positive whole number of ms`,
      ),
    );
    expect(driver.clients).toHaveLength(0);
  });

  /**
   * One statement per call is what the bounds allow: the type fetch postgres-js
   * sends on every new connection would be a second one in front of the probe.
   */
  it("opens its client without the type fetch", () => {
    createProbeDb(URL, OPTIONS);

    expect(driver.clients[0]?.args[1]).toMatchObject({ fetch_types: false });
  });

  /**
   * postgres-js lays the query parameters of a DSN over `connection`: a
   * `statement_timeout` left in the url would replace the bound of the probe.
   */
  it("drops a statement timeout of the url and keeps its own", () => {
    createProbeDb(
      `${URL}?statement_timeout=60000&application_name=sf`,
      OPTIONS,
    );

    const [url, options] = driver.clients[0]?.args ?? [];
    expect(url).toBe(`${URL}?application_name=sf`);
    expect(options).toMatchObject({
      connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
    });
  });

  /**
   * Names of settings are case-insensitive for Postgres: a parameter in
   * another case lifts the bound of the server all the same. Everything else
   * of the DSN reaches the driver as it was written - an escaped password
   * included - and a DSN with nothing to drop is not rewritten at all.
   */
  it.each([
    [
      "in another case",
      `${URL}?STATEMENT_TIMEOUT=0&application_name=sf`,
      `${URL}?application_name=sf`,
    ],
    ["as the only parameter", `${URL}?statement_timeout=60000`, URL],
    [
      "absent",
      `${URL}?application_name=sf%20probe`,
      `${URL}?application_name=sf%20probe`,
    ],
    [
      "next to an escaped password",
      "postgres://sf:p%40ss@127.0.0.1:1/nowhere?Statement_Timeout=0",
      "postgres://sf:p%40ss@127.0.0.1:1/nowhere",
    ],
  ])("drops a statement timeout of the url %s", (_case, given, opened) => {
    createProbeDb(given, OPTIONS);

    expect(driver.clients[0]?.args[0]).toBe(opened);
    expect(driver.clients[0]?.args[1]).toMatchObject({
      connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
    });
  });

  it("answers with the work when it answers in time, on the same client", async () => {
    const probe = createProbeDb(URL, OPTIONS);
    const seen: Db[] = [];

    await expect(
      probe.run(async (db) => {
        seen.push(db);
        return "pong";
      }),
    ).resolves.toBe("pong");
    await probe.run(async (db) => {
      seen.push(db);
    });

    expect(seen[0]).toBe(seen[1]);
    expect(driver.clients).toHaveLength(1);
    expect(driver.clients[0]?.end).not.toHaveBeenCalled();
  });

  it("passes the failure of the work on as it is", async () => {
    const probe = createProbeDb(URL, OPTIONS);
    const failure = new Error("relation does not exist");

    await expect(
      probe.run(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(driver.clients[0]?.end).not.toHaveBeenCalled();
  });

  /**
   * Work that throws before it returns a promise is a failure of that call,
   * not a throw out of `run` with a timer left armed to destroy a healthy
   * client.
   */
  it("passes a failure thrown before the work started on as a refusal", async () => {
    const onLimit = vi.fn();
    const probe = createProbeDb(URL, { ...OPTIONS, onLimit });
    const failure = new TypeError("not a query");

    await expect(
      probe.run(() => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(LIMIT_MS);

    expect(driver.clients).toHaveLength(1);
    expect(driver.clients[0]?.end).not.toHaveBeenCalled();
    expect(onLimit).not.toHaveBeenCalled();
  });

  /**
   * One connection: a second call on the handle waits behind the first. When
   * the first outlives the limit, the client both are on is destroyed, and the
   * second is refused by the limit with it - not left to whatever the driver
   * rejects its query with (`CONNECTION_DESTROYED`), which reads as a
   * Postgres that went away.
   */
  it("refuses with the limit every call waiting on the client it destroys", async () => {
    const onLimit = vi.fn();
    const probe = createProbeDb(URL, { ...OPTIONS, onLimit });
    const first = manual<void>();
    const second = manual<void>();
    const outcomes: unknown[] = [];
    const record = (run: Promise<void>): void => {
      run.then(
        () => outcomes.push("answered"),
        (err: unknown) => outcomes.push(err),
      );
    };
    record(probe.run(() => first.promise));
    await vi.advanceTimersByTimeAsync(LIMIT_MS / 2);
    record(probe.run(() => second.promise));

    await vi.advanceTimersByTimeAsync(LIMIT_MS / 2);

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toBeInstanceOf(ProbeLimitError);
    expect(outcomes[1]).toBeInstanceOf(ProbeLimitError);
    // What the driver then does to the queries lands nowhere.
    const destroyed = Object.assign(new Error("write CONNECTION_DESTROYED"), {
      code: "CONNECTION_DESTROYED",
    });
    second.reject(destroyed);
    first.reject(destroyed);
    await vi.advanceTimersByTimeAsync(LIMIT_MS);
    expect(outcomes).toHaveLength(2);
    expect(driver.clients[0]?.end).toHaveBeenCalledTimes(1);
    expect(driver.clients).toHaveLength(2);
    expect(driver.clients[1]?.end).not.toHaveBeenCalled();
    expect(onLimit).toHaveBeenCalledTimes(1);
  });

  /**
   * The one sign that the database went silent rather than slow is the limit
   * destroying a client; the package has no logger, the caller is told.
   */
  it("tells the caller when the limit destroys a client, and only then", async () => {
    const onLimit = vi.fn();
    const probe = createProbeDb(URL, { ...OPTIONS, onLimit });

    await probe.run(async () => "pong");
    expect(onLimit).not.toHaveBeenCalled();

    const run = probe.run(() => manual<void>().promise);
    run.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(LIMIT_MS);

    expect(onLimit).toHaveBeenCalledTimes(1);
    expect(onLimit).toHaveBeenCalledWith({ limitMs: LIMIT_MS });
  });

  /**
   * A callback of the caller that throws is its own failure: the client is
   * ended all the same, the call is refused by the limit, and nothing leaves
   * the timer as an uncaught exception of the process.
   */
  it("ends the client and refuses the call when the callback throws", async () => {
    const onLimit = vi.fn(() => {
      throw new Error("logger is gone");
    });
    const probe = createProbeDb(URL, { ...OPTIONS, onLimit });
    const run = probe.run(() => manual<void>().promise);
    const outcome = run.then(
      () => "answered",
      (err: unknown) => err,
    );

    await vi.advanceTimersByTimeAsync(LIMIT_MS);

    expect(await outcome).toBeInstanceOf(ProbeLimitError);
    expect(onLimit).toHaveBeenCalledTimes(1);
    expect(driver.clients[0]?.end).toHaveBeenCalledTimes(1);
    expect(driver.clients[0]?.end).toHaveBeenCalledWith({ timeout: 0 });
    expect(driver.clients).toHaveLength(2);
  });

  /**
   * The half-open socket: nothing answers and nothing fails. The work is given
   * up on at the limit, its client destroyed, and the next call goes over a
   * new one instead of joining the dead query (docs/TECH_DEBT.md § E0-12H, п.5).
   */
  it("gives up on work that outlives the limit and opens a fresh client", async () => {
    const probe = createProbeDb(URL, OPTIONS);
    const hanging = manual<void>();
    const seen: Db[] = [];
    let outcome: unknown;
    probe
      .run((db) => {
        seen.push(db);
        return hanging.promise;
      })
      .then(
        () => {
          outcome = "answered";
        },
        (err: unknown) => {
          outcome = err;
        },
      );

    await vi.advanceTimersByTimeAsync(LIMIT_MS - 1);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome).toBeInstanceOf(ProbeLimitError);
    expect(outcome).toMatchObject({ code: "PROBE_LIMIT", limitMs: LIMIT_MS });
    expect(driver.clients[0]?.end).toHaveBeenCalledTimes(1);
    expect(driver.clients[0]?.end).toHaveBeenCalledWith({ timeout: 0 });

    await probe.run(async (db) => {
      seen.push(db);
    });
    expect(driver.clients).toHaveLength(2);
    expect(seen[1]).not.toBe(seen[0]);
    expect(driver.clients[1]?.end).not.toHaveBeenCalled();
  });

  /**
   * After the limit the destroyed client rejects the query it gave up on, and
   * its own `end()` may fail too. Neither has a caller left; both are handled
   * here rather than surfacing as `unhandledRejection`.
   */
  it("lets neither the abandoned query nor the end of its client go unhandled", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const probe = createProbeDb(URL, OPTIONS);
      driver.clients[0]?.end.mockRejectedValue(new Error("end failed"));
      const hanging = manual<void>();
      const run = probe.run(() => hanging.promise);
      run.catch(() => undefined);

      await vi.advanceTimersByTimeAsync(LIMIT_MS);
      await expect(run).rejects.toBeInstanceOf(ProbeLimitError);
      hanging.reject(new Error("CONNECTION_DESTROYED"));
      await vi.advanceTimersByTimeAsync(0);
      // Unhandled rejections are reported after the microtask queue drains:
      // one macrotask of the real clock lets that happen.
      vi.useRealTimers();
      await new Promise((done) => setImmediate(done));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  /**
   * An answer in the same tick as the limit is one outcome, not two: the
   * limit was armed first and fires first, the caller hears the limit, the
   * client is destroyed once, and the answer that lands right after it is
   * dropped rather than resolving a settled call or reviving its client.
   */
  it("settles once when the answer lands in the tick of the limit", async () => {
    const probe = createProbeDb(URL, OPTIONS);
    const run = probe.run(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("pong"), LIMIT_MS);
        }),
    );
    run.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(LIMIT_MS);

    await expect(run).rejects.toBeInstanceOf(ProbeLimitError);
    expect(driver.clients[0]?.end).toHaveBeenCalledTimes(1);
    expect(driver.clients).toHaveLength(2);
  });

  it("closes the current client with the bound it is given", async () => {
    const probe = createProbeDb(URL, OPTIONS);

    await probe.close({ timeoutSec: 3 });

    expect(driver.clients[0]?.end).toHaveBeenCalledTimes(1);
    expect(driver.clients[0]?.end).toHaveBeenCalledWith({ timeout: 3 });
  });

  it("waits for a client the limit destroyed before it is closed", async () => {
    const probe = createProbeDb(URL, OPTIONS);
    const ended = manual<undefined>();
    driver.clients[0]?.end.mockReturnValue(ended.promise);
    const run = probe.run(() => manual<void>().promise);
    run.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(LIMIT_MS);

    let closed = false;
    const closing = probe.close({ timeoutSec: 3 }).then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);

    ended.resolve(undefined);
    await closing;
    expect(closed).toBe(true);
    expect(driver.clients[1]?.end).toHaveBeenCalledTimes(1);
  });

  /**
   * After `close()` no client is opened again: one opened by a late call would
   * be a socket nobody closes, holding the process open.
   */
  it("refuses work after close and opens no client for it", async () => {
    const probe = createProbeDb(URL, OPTIONS);
    await probe.close({ timeoutSec: 3 });
    const work = vi.fn(async () => undefined);

    await expect(probe.run(work)).rejects.toBeInstanceOf(ProbeClosedError);
    expect(work).not.toHaveBeenCalled();
    expect(driver.clients).toHaveLength(1);
  });

  /**
   * The timer of a call does not hold the process: a stop whose last handle
   * is a pending probe call would otherwise wait out the limit.
   */
  it("arms a limit that does not keep the process up", () => {
    const armed = vi.spyOn(globalThis, "setTimeout");
    const probe = createProbeDb(URL, OPTIONS);
    probe.run(() => manual<void>().promise).catch(() => undefined);

    expect(armed).toHaveBeenCalledTimes(1);
    const timer: unknown = armed.mock.results[0]?.value;
    expect(timer).toMatchObject({ hasRef: expect.any(Function) });
    expect((timer as { hasRef(): boolean }).hasRef()).toBe(false);
  });

  /**
   * `close()` disarms the limits of the calls in flight: the query is left to
   * the close and its bound, with no fresh client and no second `end` that
   * would cut the bound of the stop short. The call settles with its work -
   * here the rejection of the driver when the close ends the client - and
   * never with the limit.
   */
  it("leaves a call in flight to the close and its bound, not to the limit", async () => {
    const onLimit = vi.fn();
    const probe = createProbeDb(URL, { ...OPTIONS, onLimit });
    const ended = manual<undefined>();
    driver.clients[0]?.end.mockReturnValue(ended.promise);
    const work = manual<void>();
    const outcomes: unknown[] = [];
    probe
      .run(() => work.promise)
      .then(
        () => outcomes.push("answered"),
        (err: unknown) => outcomes.push(err),
      );
    const closing = probe.close({ timeoutSec: 3 });

    await vi.advanceTimersByTimeAsync(LIMIT_MS * 2);
    expect(outcomes).toEqual([]);

    const destroyed = new Error("write CONNECTION_DESTROYED");
    work.reject(destroyed);
    ended.resolve(undefined);
    await closing;

    expect(outcomes).toEqual([destroyed]);
    expect(driver.clients).toHaveLength(1);
    expect(driver.clients[0]?.end).toHaveBeenCalledTimes(1);
    expect(driver.clients[0]?.end).toHaveBeenCalledWith({ timeout: 3 });
    expect(onLimit).not.toHaveBeenCalled();
  });

  /**
   * A call the close left unanswered has no client left to answer it: it is
   * refused as closed once the close is done, rather than hanging or being
   * told about a limit that was disarmed.
   */
  it("refuses as closed a call the close left unanswered", async () => {
    const probe = createProbeDb(URL, OPTIONS);
    const outcomes: unknown[] = [];
    probe
      .run(() => manual<void>().promise)
      .then(
        () => outcomes.push("answered"),
        (err: unknown) => outcomes.push(err),
      );

    await probe.close({ timeoutSec: 3 });
    await vi.advanceTimersByTimeAsync(0);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toBeInstanceOf(ProbeClosedError);
    await vi.advanceTimersByTimeAsync(LIMIT_MS);
    expect(outcomes).toHaveLength(1);
    expect(driver.clients).toHaveLength(1);
  });

  /**
   * A close of the current client that fails is the answer of the close, but
   * only once the clients a limit destroyed are done too: a stop that moved on
   * at the first failure would leave their sockets being torn down behind it.
   * Every call to `close()` gets the same answer.
   */
  it("waits for the destroyed clients when closing the current one fails", async () => {
    const probe = createProbeDb(URL, OPTIONS);
    const ended = manual<undefined>();
    driver.clients[0]?.end.mockReturnValue(ended.promise);
    const run = probe.run(() => manual<void>().promise);
    run.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(LIMIT_MS);
    const failure = new Error("end failed");
    driver.clients[1]?.end.mockRejectedValue(failure);

    let outcome: unknown;
    const closing = probe.close({ timeoutSec: 3 }).then(
      () => "closed",
      (err: unknown) => err,
    );
    void closing.then((value) => {
      outcome = value;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBeUndefined();

    ended.resolve(undefined);
    await expect(closing).resolves.toBe(failure);
    await expect(probe.close({ timeoutSec: 3 })).rejects.toBe(failure);
    expect(driver.clients[1]?.end).toHaveBeenCalledTimes(1);
  });
});
