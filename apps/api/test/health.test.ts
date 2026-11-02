import { HealthResponseSchema } from "@sf/contracts";
import { type Db, type ProbeDb, createProbeDb, pingDb } from "@sf/db";
import { describe, expect, it, vi } from "vitest";
import {
  DEPENDENCY_TIMEOUT_MS,
  PROBE_DB_BOUNDS,
  PROBE_QUERY_LIMIT_MS,
} from "../src/lib/dependency-timeout.js";
import { createHealthProbes } from "../src/lib/health.js";
import { AUTH_HEADER, buildTestApp } from "./helpers.js";

// The real `pingDb`, counted: a case below asserts how many probes a burst of
// requests sends to the database.
vi.mock("@sf/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sf/db")>();
  return { ...actual, pingDb: vi.fn(actual.pingDb) };
});

/** A port nothing listens on, so the probe fails instead of hanging on DNS. */
const CLOSED_DB_URL = "postgres://sf:sf@127.0.0.1:1/nowhere";

/**
 * A database handle for a probe whose `pingDb` is mocked: it is only handed
 * along. The one thing `pingDb` does with a handle - `execute` - throws by
 * name, so a case that lost the mock fails on the spot instead of dialing a
 * database on the fake clock. Nothing else of it throws: a failed assertion
 * prints the calls of the mock, this handle among them, and a handle that
 * refused to be printed would hide the failure behind its own.
 */
function standInDb(): Db {
  const refuse = (): never => {
    throw new Error(
      "the stand-in database was used: pingDb is not mocked in this case",
    );
  };
  const handle: Partial<Db> = { execute: refuse };
  return handle as Db;
}

async function healthOf(report: {
  db: "up" | "down";
  redis: "up" | "down";
}): Promise<{ statusCode: number; status: string; cacheControl: unknown }> {
  const app = buildTestApp({ report });
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/health" });
    return {
      statusCode: res.statusCode,
      status: HealthResponseSchema.parse(JSON.parse(res.payload)).status,
      cacheControl: res.headers["cache-control"],
    };
  } finally {
    await app.close();
  }
}

/**
 * Every case below reads `cache-control` too: the answer is about this
 * moment, and a cache between the caller and the api that kept a 200 would
 * report a database that went down a minute ago as up - while a kept 503
 * would hold a recovered service out of rotation.
 */
describe("GET /health", () => {
  it("answers 200 while both dependencies answer", async () => {
    expect(await healthOf({ db: "up", redis: "up" })).toEqual({
      statusCode: 200,
      status: "ok",
      cacheControl: "no-store",
    });
  });

  it("answers 503 when the database is down", async () => {
    // The status code carries the verdict on its own: a container healthcheck
    // and `depends_on` in Compose do not read the body.
    expect(await healthOf({ db: "down", redis: "up" })).toEqual({
      statusCode: 503,
      status: "degraded",
      cacheControl: "no-store",
    });
  });

  it("answers 503 when Redis is down", async () => {
    expect(await healthOf({ db: "up", redis: "down" })).toEqual({
      statusCode: 503,
      status: "degraded",
      cacheControl: "no-store",
    });
  });

  it("answers 503 when both are down", async () => {
    expect(await healthOf({ db: "down", redis: "down" })).toEqual({
      statusCode: 503,
      status: "degraded",
      cacheControl: "no-store",
    });
  });

  /**
   * An answer of the error handler is a verdict about this moment too: a
   * proxy with `stale-if-error` that kept the 500 of a probe that threw would
   * go on serving it after the service recovered.
   */
  it("forbids caching an answer of the error handler", async () => {
    const app = buildTestApp({
      health: {
        check: async () => {
          throw new TypeError("a defect of the probe");
        },
      },
    });
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/health" });

      expect(res.statusCode).toBe(500);
      expect(res.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });

  it("tells nothing about the build or the dependencies", async () => {
    const app = buildTestApp({
      buildInfo: { version: "9.9.9-secret", commit: "deadbee" },
      report: { db: "down", redis: "up" },
    });
    await app.ready();

    try {
      const res = await app.inject({ method: "GET", url: "/health" });

      expect(res.payload).not.toContain("9.9.9-secret");
      expect(res.payload).not.toContain("deadbee");
      expect(res.payload).not.toContain("db");
    } finally {
      await app.close();
    }
  });
});

describe("the stand-in database", () => {
  it("refuses the query of pingDb by name and still lets a failed assertion print it", async () => {
    const { pingDb: realPingDb } =
      await vi.importActual<typeof import("@sf/db")>("@sf/db");

    await expect(realPingDb(standInDb())).rejects.toThrow(
      "the stand-in database was used",
    );
    expect(() => expect(standInDb()).toBeNull()).toThrow(
      /expected .* to be null/,
    );
  });
});

describe("createHealthProbes", () => {
  /**
   * Both dependencies silent, on the fake clock: Redis never settles its
   * ping, and the database answers the way `dbAnswer` does - never, unless a
   * case hands in an answer it settles itself.
   *
   * Nothing global changes here: the fake clock and the mock of `pingDb` are
   * put in place by `arm`, which a case calls inside its `try`, so a throw on
   * the way there leaves neither to the next case - `restore` in its
   * `finally` takes both back.
   */
  async function hangingDependencies(
    dbAnswer: () => Promise<void> = () => new Promise<void>(() => {}),
  ) {
    const { pingDb: realPingDb } =
      await vi.importActual<typeof import("@sf/db")>("@sf/db");
    // A handle without a limit of its own: the cases that use it are about
    // the sharing, and a limit would end the hanging probe under them. No
    // client behind it either: `pingDb` is mocked and never reads the one it
    // is handed.
    const db: ProbeDb = {
      run: (fn) => fn(standInDb()),
      close: async () => undefined,
    };
    // A socket that is open but silent never settles the promise; without a
    // deadline the check - and with it /health - would never return.
    const ping = vi.fn(() => new Promise<string>(() => {}));
    return {
      db,
      ping,
      arm: (): void => {
        vi.useFakeTimers();
        vi.mocked(pingDb).mockClear().mockImplementation(dbAnswer);
      },
      restore: (): void => {
        vi.useRealTimers();
        vi.mocked(pingDb).mockImplementation(realPingDb);
      },
    };
  }

  it("reports a dependency that never answers as down", async () => {
    const { db, ping, arm, restore } = await hangingDependencies();
    const probes = createHealthProbes({ db, redis: { ping }, timeoutMs: 50 });

    try {
      arm();
      let report: unknown;
      void probes.check().then((value) => {
        report = value;
      });
      // The deadline, not the probe, is what ends the check.
      await vi.advanceTimersByTimeAsync(49);
      expect(report).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(report).toEqual({ db: "down", redis: "down" });
    } finally {
      restore();
    }
  });

  /**
   * `/health` is public and polled. A ping to a Redis whose socket is open and
   * silent outlives the deadline of the request that sent it; requests that
   * arrive while it hangs must join it instead of leaving one more behind
   * each.
   */
  it("shares one pair of probes between the calls that arrive while it runs", async () => {
    const { db, ping, arm, restore } = await hangingDependencies();
    const probes = createHealthProbes({ db, redis: { ping }, timeoutMs: 50 });

    try {
      arm();
      let reports: unknown;
      void Promise.all([probes.check(), probes.check(), probes.check()]).then(
        (value) => {
          reports = value;
        },
      );
      await vi.advanceTimersByTimeAsync(50);

      expect(reports).toEqual(Array(3).fill({ db: "down", redis: "down" }));
      expect(ping).toHaveBeenCalledTimes(1);
      expect(pingDb).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  /**
   * The sharing is over the raw probe, not over the verdict, and lasts until
   * the probe settles: polls that each gave up on a probe that hangs leave
   * that one probe behind them, not one each - and once it settles, the next
   * poll asks again.
   */
  it("keeps one hanging probe per dependency however many polls give up on it", async () => {
    let answerDb: () => void = () => {};
    const { db, ping, arm, restore } = await hangingDependencies(
      () =>
        new Promise<void>((resolve) => {
          answerDb = resolve;
        }),
    );
    const probes = createHealthProbes({ db, redis: { ping } });

    try {
      arm();
      for (let poll = 0; poll < 3; poll += 1) {
        const report = probes.check();
        await vi.advanceTimersByTimeAsync(DEPENDENCY_TIMEOUT_MS);
        await expect(report).resolves.toEqual({ db: "down", redis: "down" });
      }
      expect(pingDb).toHaveBeenCalledTimes(1);
      expect(ping).toHaveBeenCalledTimes(1);

      // The database answers at last: the next poll asks it again.
      answerDb();
      await vi.advanceTimersByTimeAsync(0);
      void probes.check();
      expect(pingDb).toHaveBeenCalledTimes(2);
      expect(ping).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
  /**
   * The bound of the sharing: a probe stuck on a half-open socket is given up
   * on at the limit of its handle, and the next poll asks the database again
   * over a new connection instead of joining it until the OS breaks the
   * socket (docs/TECH_DEBT.md § E0-12H, п.5).
   */
  it("lets a stuck database probe go at its limit and asks again", async () => {
    const { ping, arm, restore } = await hangingDependencies();
    const db = createProbeDb(CLOSED_DB_URL, PROBE_DB_BOUNDS);
    const probes = createHealthProbes({ db, redis: { ping } });

    try {
      arm();
      // Two polls that give up on it at their deadline, one after the other,
      // join the one stuck probe while it is under the limit.
      for (let poll = 0; poll < 2; poll += 1) {
        const report = probes.check();
        await vi.advanceTimersByTimeAsync(DEPENDENCY_TIMEOUT_MS);
        await expect(report).resolves.toEqual({ db: "down", redis: "down" });
      }
      expect(PROBE_QUERY_LIMIT_MS).toBe(2 * DEPENDENCY_TIMEOUT_MS);
      expect(pingDb).toHaveBeenCalledTimes(1);

      // The limit has run out with the second deadline: the next poll asks
      // over a fresh connection, not the stuck one.
      void probes.check();
      expect(pingDb).toHaveBeenCalledTimes(2);
      expect(vi.mocked(pingDb).mock.calls[1]?.[0]).not.toBe(
        vi.mocked(pingDb).mock.calls[0]?.[0],
      );
    } finally {
      // The clock and the mock go back even when the close of the handle
      // fails: the next case must not start on either.
      try {
        await vi.advanceTimersByTimeAsync(PROBE_QUERY_LIMIT_MS);
        await db.close({ timeoutSec: 0 });
      } finally {
        restore();
      }
    }
  });
});
