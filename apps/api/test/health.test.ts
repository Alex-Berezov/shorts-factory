import { HealthResponseSchema } from "@sf/contracts";
import { closeDb, createDb, pingDb } from "@sf/db";
import { describe, expect, it, vi } from "vitest";
import { DEPENDENCY_TIMEOUT_MS } from "../src/lib/dependency-timeout.js";
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

describe("createHealthProbes", () => {
  /**
   * Both dependencies silent, on the fake clock: Redis never settles its
   * ping, and the database answers the way `dbAnswer` does - never, unless a
   * case hands in an answer it settles itself.
   */
  async function hangingDependencies(
    dbAnswer: () => Promise<void> = () => new Promise<void>(() => {}),
  ) {
    const { pingDb: realPingDb } =
      await vi.importActual<typeof import("@sf/db")>("@sf/db");
    vi.useFakeTimers();
    vi.mocked(pingDb).mockClear().mockImplementation(dbAnswer);
    const db = createDb(CLOSED_DB_URL);
    // A socket that is open but silent never settles the promise; without a
    // deadline the check - and with it /health - would never return.
    const ping = vi.fn(() => new Promise<string>(() => {}));
    return {
      db,
      ping,
      restore: async (): Promise<void> => {
        vi.useRealTimers();
        vi.mocked(pingDb).mockImplementation(realPingDb);
        await closeDb(db);
      },
    };
  }

  it("reports a dependency that never answers as down", async () => {
    const { db, ping, restore } = await hangingDependencies();
    const probes = createHealthProbes({ db, redis: { ping }, timeoutMs: 50 });

    try {
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
      await restore();
    }
  });

  /**
   * `/health` is public and polled. A ping to a Redis whose socket is open and
   * silent outlives the deadline of the request that sent it; requests that
   * arrive while it hangs must join it instead of leaving one more behind
   * each.
   */
  it("shares one pair of probes between the calls that arrive while it runs", async () => {
    const { db, ping, restore } = await hangingDependencies();
    const probes = createHealthProbes({ db, redis: { ping }, timeoutMs: 50 });

    try {
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
      await restore();
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
    const { db, ping, restore } = await hangingDependencies(
      () =>
        new Promise<void>((resolve) => {
          answerDb = resolve;
        }),
    );
    const probes = createHealthProbes({ db, redis: { ping } });

    try {
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
      await restore();
    }
  });
});
