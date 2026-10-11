import { once } from "node:events";
import { type Server, type Socket, createServer } from "node:net";
import {
  type BudgetStatus,
  type ProbeFailureCode,
  SystemStatusResponseSchema,
  type WorkerStatus,
} from "@sf/contracts";
import {
  PROVIDERS,
  type Provider,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_SEC,
  budgetScopeFor,
} from "@sf/core";
import { closeDb, createBudgetGuard, createDb } from "@sf/db";
import type { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import type { QueuesSnapshot } from "../src/deps.js";
import { CAP_REPRESENTATIVES, createBudgetProbe } from "../src/lib/budget.js";
import { DEPENDENCY_TIMEOUT_MS, DeadlineError } from "../src/lib/deadline.js";
import { createWorkerProbe } from "../src/lib/heartbeat.js";
import {
  QueueCountersError,
  createQueueStats,
} from "../src/lib/queue-stats.js";
import { createRedis } from "../src/lib/redis.js";
import {
  type Collected,
  collect,
  dependencyCheck,
  dependencyFailureCode,
} from "../src/lib/system-status.js";
import {
  AUTH_HEADER,
  EMPTY_QUEUES,
  IDLE_BUDGET,
  LIVE_WORKER,
  type TestAppOverrides,
  buildTestApp,
  parseErrorBody,
} from "./helpers.js";
import { recordingLogger } from "./recording-logger.js";

// The real guard, replaceable: a case below holds the reads of the budget
// section to count how many a burst of requests sends to the database.
vi.mock("@sf/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sf/db")>();
  return { ...actual, createBudgetGuard: vi.fn(actual.createBudgetGuard) };
});

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

/** What postgres-js raises when the server answered with a SQLSTATE. */
function postgresError(code: string): Error {
  const err: NodeJS.ErrnoException = new Error(`server said ${code}`);
  err.name = "PostgresError";
  err.code = code;
  return err;
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
   * A Postgres that answers with a SQLSTATE of a server going away - a
   * shutdown, a crash, a start or a recovery, a broken connection - is a
   * Postgres that is not there, like a refused socket (Р4 E0-11B).
   */
  it.each(["57P01", "57P02", "57P03", "08006", "08001"])(
    "calls a Postgres on its way down or up unreachable (%s)",
    (code) => {
      expect(dependencyFailureCode(postgresError(code))).toBe("unreachable");
    },
  );

  /**
   * A missing table, a missing grant, a missing schema, bad data, a broken
   * constraint: the database answered correctly about a query of ours that is
   * wrong. Reported as `db: down` it would send the operator to restart a
   * healthy Postgres (decision of 13.09.2026, Р4 E0-11B).
   */
  it.each(["42P01", "42501", "3F000", "22P02", "23505"])(
    "leaves a Postgres refusal caused by our own query to the caller (%s)",
    (code) => {
      expect(dependencyFailureCode(postgresError(code))).toBe(undefined);
    },
  );

  it("calls any other Postgres refusal an error", () => {
    // Too many connections: the server is there and cannot take this one.
    expect(dependencyFailureCode(postgresError("53300"))).toBe("error");
  });

  /**
   * A query the server gave up on - a `statement_timeout`, a cancel request -
   * is a dependency that did not answer in time: the same `timeout` ioredis
   * gets after its `commandTimeout`, so one state reads the same whichever
   * driver saw it.
   */
  it("calls a query Postgres cancelled a timeout (57014)", () => {
    expect(dependencyFailureCode(postgresError("57014"))).toBe("timeout");
  });

  it("answers 500 rather than a reason for a defect reported by Postgres", async () => {
    const { log } = recordingLogger();

    await expect(
      collect(
        "budget",
        async () => {
          throw postgresError("42P01");
        },
        log,
      ),
    ).rejects.toMatchObject({ name: "PostgresError", code: "42P01" });
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

/**
 * The two refusals of ioredis that mean "the socket is down" carry neither a
 * class nor a code on 5.11.1 - one is a literal in `built/Redis.js`, the other
 * a constant of `built/utils` that is not exported - so `REDIS_DOWN_MESSAGES`
 * matches their text. These cases take the text from a real client rather than
 * from a copy of it: a release that rewords either one turns them red instead
 * of quietly turning a Redis that is down into a 500.
 */
describe("the ioredis refusals the page calls unreachable", () => {
  /** A port nothing listens on: refused at once, no Docker needed. */
  const CLOSED_REDIS_URL = "redis://127.0.0.1:1";

  /** The rejection of a command, as the caller of the client receives it. */
  async function refusal(command: () => Promise<unknown>): Promise<unknown> {
    try {
      await command();
    } catch (err) {
      return err;
    }
    throw new Error("the command was expected to be refused");
  }

  it("calls a command on a socket that is not up unreachable", async () => {
    // Issued right after creation: the client is `connecting` (and after the
    // refusal `reconnecting`), and with the offline queue off the command is
    // refused instead of waiting for a socket that will not come.
    const client = createRedis(CLOSED_REDIS_URL);
    try {
      const err = await refusal(() => client.ping());

      expect(err).toBeInstanceOf(Error);
      expect(err).toHaveProperty(
        "message",
        "Stream isn't writeable and enableOfflineQueue options is false",
      );
      expect(dependencyFailureCode(err)).toBe("unreachable");
    } finally {
      client.disconnect();
    }
  });

  it("calls a command on a closed client unreachable", async () => {
    const client = createRedis(CLOSED_REDIS_URL);
    try {
      // The client reaches `end` on the `close` of its socket, not inside
      // `disconnect()`: a command issued in between is refused with the other
      // text, and this case would prove the first one twice.
      const ended = once(client, "end");
      client.disconnect();
      await ended;
      const err = await refusal(() => client.ping());

      expect(err).toBeInstanceOf(Error);
      expect(err).toHaveProperty("message", "Connection is closed.");
      expect(dependencyFailureCode(err)).toBe("unreachable");
    } finally {
      client.disconnect();
    }
  });

  /**
   * A `Queue` opened on a client that is not `ready` waits in bullmq for
   * `ready` or `end`, and a client that reconnects forever reaches neither:
   * every pass of the page would hang until its deadline and stay in flight
   * after it. The queues section has to be refused the way a command is.
   */
  it("refuses the queues section at once instead of waiting for the client", async () => {
    const client = createRedis(CLOSED_REDIS_URL);
    const stats = createQueueStats({ connection: client });
    const { log } = recordingLogger();
    try {
      const started = performance.now();
      const section = await collect("queues", () => stats.collect(), log);
      const elapsed = performance.now() - started;

      expect(section).toEqual({ ok: false, reason: "unreachable" });
      expect(elapsed).toBeLessThan(DEPENDENCY_TIMEOUT_MS);
    } finally {
      // The client first: a pass still waiting for it ends with its `end`.
      client.disconnect();
      await stats.close();
    }
  });
});

/** One command of a client: its arguments, and where the next one starts. */
function takeCommand(
  buffer: string,
  start: number,
): { args: string[]; end: number } | undefined {
  const line = (from: number): { text: string; next: number } | undefined => {
    const eol = buffer.indexOf("\r\n", from);
    return eol === -1
      ? undefined
      : { text: buffer.slice(from, eol), next: eol + 2 };
  };
  const header = line(start);
  if (header === undefined) {
    return undefined;
  }
  if (!header.text.startsWith("*")) {
    throw new Error(`the silent server got no command but "${header.text}"`);
  }
  const args: string[] = [];
  let at = header.next;
  for (let i = 0; i < Number(header.text.slice(1)); i += 1) {
    const size = line(at);
    if (size === undefined) {
      return undefined;
    }
    const end = size.next + Number(size.text.slice(1));
    if (buffer.length < end + 2) {
      return undefined;
    }
    args.push(buffer.slice(size.next, end));
    at = end + 2;
  }
  return { args, end: at };
}

/**
 * The commands that arrived whole, and what is left of the buffer: a client
 * sends RESP arrays of bulk strings, and the handshake can arrive in one
 * chunk or in several, split anywhere. Read as `latin1`, one character per
 * byte, so the lengths in the protocol are the lengths of the string.
 */
function takeCommands(buffer: string): { commands: string[][]; rest: string } {
  const commands: string[][] = [];
  let at = 0;
  for (;;) {
    const command = takeCommand(buffer, at);
    if (command === undefined) {
      return { commands, rest: buffer.slice(at) };
    }
    commands.push(command.args);
    at = command.end;
  }
}

/**
 * A Redis that took the connection and then went silent - a frozen process, a
 * network that drops the replies. The socket stays open, so nothing refuses
 * the command; the server below answers the handshake ioredis needs to call
 * the client `ready` (`CLIENT SETINFO` and the `INFO` of the ready check) and
 * nothing after it. A command of the handshake it does not know is refused,
 * so a new step of a later ioredis shows up as an error of the client rather
 * than as a wait.
 */
async function silentRedis(): Promise<{ url: string; stop: () => void }> {
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    let pending = "";
    let ready = false;
    socket.on("data", (chunk: Buffer) => {
      if (ready) {
        return;
      }
      const { commands, rest } = takeCommands(
        pending + chunk.toString("latin1"),
      );
      pending = rest;
      for (const [name] of commands) {
        if (ready) {
          return;
        }
        const command = name?.toUpperCase();
        if (command === "CLIENT") {
          socket.write("+OK\r\n");
        } else if (command === "INFO") {
          ready = true;
          socket.write("$0\r\n\r\n");
        } else {
          socket.write(`-ERR the silent server does not answer ${command}\r\n`);
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the silent server is not listening on a tcp port");
  }
  return {
    url: `redis://127.0.0.1:${address.port}`,
    stop: () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
    },
  };
}

/**
 * Waits for the client to call itself `ready`, and fails with the reason
 * instead of holding the case until the timeout of the runner: a handshake a
 * later ioredis changed is a broken fake, not a slow one.
 */
async function readyWithin(client: Redis, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      once(client, "ready"),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `the client was not ready against the silent server in ${timeoutMs}ms: its handshake is not the one the server answers`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("a command to a Redis that went silent", () => {
  /**
   * The deadline of a request gives up on such a command without ending it,
   * so without a bound of its own every poll of `/health` would leave one more
   * ping waiting on the socket for as long as it stays open.
   */
  it("fails by itself at the deadline of the api and is a timeout", async () => {
    const redis = await silentRedis();
    const client = createRedis(redis.url);
    try {
      await readyWithin(client, 1_000);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let outcome: unknown;
      let settled = false;
      void client.ping().then(
        () => {
          settled = true;
        },
        (err: unknown) => {
          outcome = err;
          settled = true;
        },
      );

      await vi.advanceTimersByTimeAsync(DEPENDENCY_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(settled).toBe(true);
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).toHaveProperty("message", "Command timed out");
      expect(dependencyFailureCode(outcome)).toBe("timeout");
    } finally {
      vi.useRealTimers();
      client.disconnect();
      redis.stop();
    }
  });
});

/**
 * One dependency, several sections: the reason on the page is the most
 * definite one among them, not whichever section happens to be listed first.
 */
describe("dependencyCheck", () => {
  const ok: Collected<unknown> = { ok: true, value: null };
  const failed = (reason: ProbeFailureCode): Collected<unknown> => ({
    ok: false,
    reason,
  });

  it("calls a dependency up when every section answered", () => {
    expect(dependencyCheck([ok, ok])).toEqual({ status: "up", reason: null });
    expect(dependencyCheck([])).toEqual({ status: "up", reason: null });
  });

  it("reports the reason of a single failed section", () => {
    for (const reason of ["timeout", "unreachable", "error"] as const) {
      expect(dependencyCheck([ok, failed(reason)])).toEqual({
        status: "down",
        reason,
      });
    }
  });

  it("prefers unreachable over a timeout whatever the order", () => {
    // A section that gave up first only knows nothing came back; the one that
    // hit the refused socket knows why.
    expect(dependencyCheck([failed("timeout"), failed("unreachable")])).toEqual(
      { status: "down", reason: "unreachable" },
    );
    expect(dependencyCheck([failed("unreachable"), failed("timeout")])).toEqual(
      { status: "down", reason: "unreachable" },
    );
  });

  it("prefers an answer of the server over a timeout", () => {
    expect(dependencyCheck([failed("timeout"), failed("error")])).toEqual({
      status: "down",
      reason: "error",
    });
  });

  it("prefers unreachable over an answer of the server whatever the order", () => {
    // A refused socket is the state of the dependency now; a refusal another
    // section got a moment earlier is the server it no longer is.
    expect(dependencyCheck([failed("error"), failed("unreachable")])).toEqual({
      status: "down",
      reason: "unreachable",
    });
    expect(dependencyCheck([failed("unreachable"), failed("error")])).toEqual({
      status: "down",
      reason: "unreachable",
    });
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

  /**
   * The deadline of the page gives up on a `GET` to a silent Redis without
   * ending it; requests that arrive meanwhile join it rather than leave one
   * more command each, and the next one after it reads again.
   */
  it("shares one read between the requests that arrive while it is in flight", async () => {
    const answers: Array<(value: string | null) => void> = [];
    const get = vi.fn(
      (_key: string) =>
        new Promise<string | null>((resolve) => {
          answers.push(resolve);
        }),
    );
    const probe = createWorkerProbe({
      redis: { get },
      now: () => new Date("2026-09-13T10:00:30.000Z"),
    });
    const live = { heartbeatAt: stamp, stale: false };

    const requests = [probe.read(), probe.read(), probe.read()];
    expect(get).toHaveBeenCalledTimes(1);
    answers[0]?.(stamp);
    await expect(Promise.all(requests)).resolves.toEqual([live, live, live]);

    const next = probe.read();
    expect(get).toHaveBeenCalledTimes(2);
    answers[1]?.(stamp);
    await expect(next).resolves.toEqual(live);
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

  /**
   * A silent Postgres holds the reads of the section: the deadline of the
   * page gives up on them without ending them, and a query has no timeout of
   * its own. Requests that arrive meanwhile join the read in flight rather
   * than take three more connections of the pool each.
   */
  it("shares one read between the requests that arrive while it is in flight", async () => {
    const answers: Array<() => void> = [];
    const check = vi.fn(
      (_provider: Provider) =>
        new Promise<null>((resolve) => {
          answers.push(() => resolve(null));
        }),
    );
    vi.mocked(createBudgetGuard).mockReturnValueOnce({
      check,
      assert: async () => {
        throw new Error("the page never asks before spending");
      },
    });
    const db = createDb("postgres://sf:sf@127.0.0.1:1/nowhere");
    const probe = createBudgetProbe({
      db,
      limits: {
        youtubeUnitsDailySoftCap: 1,
        geminiDailyBudgetUsd: 1,
        ttsMonthlyBudgetUsd: 1,
      },
    });
    const answerAll = (): void => {
      for (const answer of answers.splice(0)) {
        answer();
      }
    };

    try {
      const requests = [probe.collect(), probe.collect(), probe.collect()];
      expect(check).toHaveBeenCalledTimes(CAP_REPRESENTATIVES.length);
      answerAll();
      await expect(Promise.all(requests)).resolves.toEqual([[], [], []]);

      const next = probe.collect();
      expect(check).toHaveBeenCalledTimes(CAP_REPRESENTATIVES.length * 2);
      answerAll();
      await expect(next).resolves.toEqual([]);
    } finally {
      await closeDb(db);
    }
  });
});
