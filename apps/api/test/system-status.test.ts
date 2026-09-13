import {
  type BudgetStatus,
  SystemStatusResponseSchema,
  type WorkerStatus,
} from "@sf/contracts";
import {
  PROVIDERS,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_SEC,
  budgetScopeFor,
} from "@sf/core";
import { describe, expect, it } from "vitest";
import type { QueuesSnapshot } from "../src/deps.js";
import { CAP_REPRESENTATIVES } from "../src/lib/budget.js";
import { DeadlineError } from "../src/lib/deadline.js";
import { createWorkerProbe } from "../src/lib/heartbeat.js";
import { QueueCountersError } from "../src/lib/queue-stats.js";
import { dependencyFailureCode } from "../src/lib/system-status.js";
import {
  AUTH_HEADER,
  EMPTY_QUEUES,
  IDLE_BUDGET,
  LIVE_WORKER,
  type TestAppOverrides,
  buildTestApp,
  parseErrorBody,
} from "./helpers.js";

/** The page as a client gets it, parsed against the contract, not cast. */
async function status(overrides: TestAppOverrides = {}) {
  const app = buildTestApp(overrides);
  await app.ready();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/system/status",
      headers: { authorization: AUTH_HEADER },
    });
    return {
      statusCode: res.statusCode,
      body: SystemStatusResponseSchema.parse(JSON.parse(res.payload)),
    };
  } finally {
    await app.close();
  }
}

/** A collector that fails the way a dependency that is not there does. */
function unreachable(): never {
  const err: NodeJS.ErrnoException = new Error("connect ECONNREFUSED");
  err.code = "ECONNREFUSED";
  throw err;
}

describe("GET /system/status", () => {
  it("reports the build, the uptime and every section", async () => {
    const { statusCode, body } = await status({
      buildInfo: { version: "1.2.3", commit: "abc1234" },
    });

    expect(statusCode).toBe(200);
    expect(body).toMatchObject({
      build: { version: "1.2.3", commit: "abc1234" },
      checks: {
        db: { status: "up", reason: null },
        redis: { status: "up", reason: null },
      },
      dlq: { size: 0 },
      worker: LIVE_WORKER,
      budget: IDLE_BUDGET,
    });
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(body.queues).toEqual(EMPTY_QUEUES.queues);
  });

  it("reports an unknown build as null rather than inventing a version", async () => {
    const { body } = await status({
      buildInfo: { version: null, commit: null },
    });

    expect(body.build).toEqual({ version: null, commit: null });
  });

  /**
   * The state the route exists for: the operator opens it because something is
   * broken. A section that could not be read is `null` with a reason on the
   * dependency - a zero would say "the queue is empty" about a queue nobody
   * could ask.
   */
  it("answers 200 with null sections when Redis is unreachable", async () => {
    const { statusCode, body } = await status({
      queues: { collect: async () => unreachable() },
      worker: { read: async () => unreachable() },
    });

    expect(statusCode).toBe(200);
    expect(body.queues).toBeNull();
    expect(body.dlq).toBeNull();
    expect(body.worker).toBeNull();
    expect(body.checks.redis).toEqual({
      status: "down",
      reason: "unreachable",
    });
    // The other dependency answered, and its section is still there.
    expect(body.checks.db).toEqual({ status: "up", reason: null });
    expect(body.budget).toEqual(IDLE_BUDGET);
  });

  it("answers 200 with a null budget when the database is unreachable", async () => {
    const { statusCode, body } = await status({
      budget: { collect: async () => unreachable() },
    });

    expect(statusCode).toBe(200);
    expect(body.budget).toBeNull();
    expect(body.checks.db).toEqual({ status: "down", reason: "unreachable" });
    expect(body.checks.redis).toEqual({ status: "up", reason: null });
  });

  it("gives up on a section that never answers instead of holding the page", async () => {
    const { body } = await status({
      worker: { read: () => new Promise<WorkerStatus>(() => {}) },
    });

    expect(body.worker).toBeNull();
    expect(body.checks.redis).toEqual({ status: "down", reason: "timeout" });
  }, 10_000);

  it("keeps the text of a driver failure out of the response", async () => {
    // The message of a driver failure carries the host, the port and sometimes
    // the credentials; this body is read by a browser.
    const { body } = await status({
      budget: {
        collect: async (): Promise<BudgetStatus[]> => {
          // What postgres-js raises when the server refused the query.
          const err = new Error("password authentication failed for user sf");
          err.name = "PostgresError";
          throw err;
        },
      },
    });

    expect(JSON.stringify(body)).not.toContain("password");
    expect(body.checks.db).toEqual({ status: "down", reason: "error" });
  });

  /**
   * A defect of ours is not an outage of Postgres. Reported as `db: down` it
   * sends the operator to restart a database that is answering perfectly well,
   * and the page - which is the thing being read during the incident - becomes
   * the source of the wrong lead. It leaves as a 500 instead, with the error in
   * the log next to the request id.
   */
  it("answers 500 when a section failed for a reason of its own", async () => {
    const app = buildTestApp({
      budget: {
        collect: async (): Promise<BudgetStatus[]> => {
          throw new TypeError("cap is not a number");
        },
      },
    });
    await app.ready();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/system/status",
        headers: { authorization: AUTH_HEADER },
      });

      expect(res.statusCode).toBe(500);
      const body = parseErrorBody(res.payload);
      expect(body.error.code).toBe("INTERNAL_ERROR");
      expect(JSON.stringify(body)).not.toContain("cap is not a number");
    } finally {
      await app.close();
    }
  });

  /**
   * The same rule one level up, on the section an operator would act on: a
   * counter bullmq did not return is a 500 with the request id in the log, not
   * a page that says Redis is down while Redis answers every command.
   */
  it("answers 500 when bullmq returned an answer it could not read", async () => {
    const app = buildTestApp({
      queues: {
        collect: async (): Promise<QueuesSnapshot> => {
          throw new QueueCountersError(
            'queue system.dlq: bullmq returned no "wait" counter',
          );
        },
      },
    });
    await app.ready();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/system/status",
        headers: { authorization: AUTH_HEADER },
      });

      expect(res.statusCode).toBe(500);
      expect(parseErrorBody(res.payload).error.code).toBe("INTERNAL_ERROR");
    } finally {
      await app.close();
    }
  });

  it("is behind the password like every other route but /health", async () => {
    const app = buildTestApp();
    await app.ready();

    try {
      const res = await app.inject({ method: "GET", url: "/system/status" });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

/**
 * The three outcomes an operator acts on differently, and the fourth that is
 * not an outcome of a dependency at all.
 */
describe("dependencyFailureCode", () => {
  it("calls our own deadline a timeout", () => {
    expect(dependencyFailureCode(new DeadlineError(2_000))).toBe("timeout");
  });

  it("tells a socket that is not there from one that answered", () => {
    const refused: NodeJS.ErrnoException = new Error("connect ECONNREFUSED");
    refused.code = "ECONNREFUSED";
    expect(dependencyFailureCode(refused)).toBe("unreachable");

    // ioredis with the offline queue off: a plain `Error` with no code at all.
    expect(
      dependencyFailureCode(
        new Error(
          "Stream isn't writeable and enableOfflineQueue options is false",
        ),
      ),
    ).toBe("unreachable");

    // postgres-js when `connect_timeout` runs out.
    const connect: NodeJS.ErrnoException = new Error("write CONNECT_TIMEOUT");
    connect.code = "CONNECT_TIMEOUT";
    expect(dependencyFailureCode(connect)).toBe("unreachable");
  });

  /**
   * The server that went away with a query in flight - a restart, a failover,
   * a `pg_terminate_backend`. postgres-js raises these as plain `Error`s with
   * a code of their own, and the page has to survive "Postgres came back" the
   * same way it survives "Postgres is off".
   */
  it("tells a Postgres that left mid-query from one that refused", () => {
    for (const code of [
      "CONNECTION_CLOSED",
      "CONNECTION_DESTROYED",
      "CONNECTION_ENDED",
    ]) {
      const err: NodeJS.ErrnoException = new Error(`write ${code} localhost`);
      err.code = code;
      expect(dependencyFailureCode(err)).toBe("unreachable");
    }
  });

  /**
   * ioredis flushes the command queue with this one when the socket is dead
   * and the retry budget (`maxRetriesPerRequest: 1`) is spent - "nobody is
   * there", not "the server said no". It carries no code at all.
   */
  it("calls a spent retry budget unreachable, not an error", () => {
    const flushed = new Error(
      'Reached the max retries per request limit (which is 1). Refer to "maxRetriesPerRequest" option for details.',
    );
    flushed.name = "MaxRetriesPerRequestError";

    expect(dependencyFailureCode(flushed)).toBe("unreachable");
  });

  it("calls a refusal of a driver an error", () => {
    const reply = new Error("ERR unknown command");
    reply.name = "ReplyError";
    expect(dependencyFailureCode(reply)).toBe("error");

    const postgres = new Error("relation does not exist");
    postgres.name = "PostgresError";
    expect(dependencyFailureCode(postgres)).toBe("error");
  });

  /**
   * Everything that is a defect of ours is left to the caller: a `TypeError`
   * or a `ValidationError` dressed as "the database is down" is a page that
   * sends the operator after the wrong dependency.
   */
  it("refuses to classify a failure of ours as a failure of a dependency", () => {
    expect(dependencyFailureCode(new TypeError("cap is not a number"))).toBe(
      undefined,
    );
    // An answer of bullmq this code could not read is a defect of ours, not a
    // state of Redis: a release that renamed a counter would otherwise show
    // "redis: down" while every command is being answered.
    expect(dependencyFailureCode(new QueueCountersError("no counter"))).toBe(
      undefined,
    );
    expect(dependencyFailureCode(new Error("relation does not exist"))).toBe(
      undefined,
    );
    expect(dependencyFailureCode("not even an error")).toBe(undefined);
  });
});

describe("createWorkerProbe", () => {
  const stamp = "2026-09-13T10:00:00.000Z";
  const reader = (value: string | null) => ({
    get: async (key: string) => {
      expect(key).toBe(WORKER_HEARTBEAT_KEY);
      return value;
    },
  });

  it("reports a fresh stamp as a live worker", async () => {
    const probe = createWorkerProbe({
      redis: reader(stamp),
      now: () => new Date("2026-09-13T10:00:30.000Z"),
    });

    await expect(probe.read()).resolves.toEqual({
      heartbeatAt: stamp,
      stale: false,
    });
  });

  it("reports a stamp older than the ttl as stale", async () => {
    const probe = createWorkerProbe({
      redis: reader(stamp),
      now: () =>
        new Date(Date.parse(stamp) + (WORKER_HEARTBEAT_TTL_SEC + 1) * 1_000),
    });

    await expect(probe.read()).resolves.toMatchObject({ stale: true });
  });

  it("reports a missing key as a worker that is not there", async () => {
    // The key expires on its own, so "nobody wrote it" and "the worker is
    // down" are the same answer - and neither is a failure of the page.
    const probe = createWorkerProbe({ redis: reader(null) });

    await expect(probe.read()).resolves.toEqual({
      heartbeatAt: null,
      stale: true,
    });
  });

  it("reports a value that is not a timestamp as no heartbeat at all", async () => {
    const probe = createWorkerProbe({ redis: reader("alive") });

    await expect(probe.read()).resolves.toEqual({
      heartbeatAt: null,
      stale: true,
    });
  });
});

describe("the budget section", () => {
  it("asks about every cap exactly once", () => {
    // One provider per scope: a cap missing from the list is a cap nobody sees
    // on the page, and a second provider of the same scope would show it twice.
    const covered = CAP_REPRESENTATIVES.map(
      (provider) => budgetScopeFor(provider)?.key,
    );

    expect(new Set(covered).size).toBe(covered.length);
    for (const provider of PROVIDERS) {
      const key = budgetScopeFor(provider)?.key;
      if (key !== undefined) {
        expect(covered).toContain(key);
      }
    }
  });
});
