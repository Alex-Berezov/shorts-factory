import { type ChildProcess, fork } from "node:child_process";
import { type Socket, connect, createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "@sf/config";
import { SystemStatusResponseSchema } from "@sf/contracts";
import { openRelay } from "@sf/db/test-support/relay";
import {
  TEST_REDIS_DATABASE_OF,
  suiteRedisUrl,
} from "@sf/db/test-support/stack-guard";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SHUTDOWN_TIMEOUT_MS, composeApp } from "../src/compose-app.js";
import { devCommandParts } from "./dev-command.js";
import { openTestRedis, whenReady } from "./helpers.int.js";
import { basicAuthHeader, recordingServiceLogger } from "./helpers.js";

/**
 * The entry point itself, against the stack of `infra/docker-compose.yml`:
 * the entry point started with the command `pnpm dev` runs (`DEV_COMMAND`,
 * taken apart by `devCommandParts`), with one build label that is a label and
 * one that is not. What only the entry point does - reading
 * which labels the config dropped (`rejectedBuildLabels`) and handing the
 * parsed config to `composeApp`, which turns it into the fingerprint of
 * `/system/status` - is seen from the outside: in the log of the process and
 * in the page.
 */
const APP_DIR = fileURLToPath(new URL("../", import.meta.url));
const VERSION = "1.4.0";
/** Not a build label: a space and a bracket are outside `BUILD_LABEL`. */
const REJECTED_COMMIT = "abc1234 (dirty)";
/** How long the process may take to come up and answer. */
const START_DEADLINE_MS = 10_000;

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  if (address === null || typeof address === "string") {
    throw new Error("the port probe is not listening on a tcp port");
  }
  return address.port;
}

/** Asks the page until the process answers it or the deadline passes. */
async function statusOf(port: number): Promise<unknown> {
  const deadline = performance.now() + START_DEADLINE_MS;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/system/status`, {
        headers: { authorization: basicAuthHeader(env.ADMIN_PASSWORD) },
      });
      expect(res.status).toBe(200);
      return await res.json();
    } catch (error) {
      if (performance.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** A client of `CLIENT LIST`, by the fields the cases read. */
interface ListedClient {
  id: number;
  db: string;
  /** What the client said it is (`CLIENT SETINFO LIB-NAME`); "" when it said nothing. */
  lib: string;
}

/**
 * `id`, `db` and `lib-name` of each client `CLIENT LIST` names. A line
 * without an `id` or a `db` it can read is thrown with the line: a client
 * that became `NaN` would fall out of every window of ids without a word
 * (L-028).
 */
function clientsOf(list: string): ListedClient[] {
  return list
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const id = /(?:^|\s)id=(\d+)(?=\s|$)/.exec(line)?.[1];
      const db = /(?:^|\s)db=(\d+)(?=\s|$)/.exec(line)?.[1];
      if (id === undefined || db === undefined) {
        throw new Error(
          `CLIENT LIST gave a line without an id or a db to read: ${JSON.stringify(line)}`,
        );
      }
      return {
        id: Number(id),
        db,
        lib: /(?:^|\s)lib-name=(\S*)/.exec(line)?.[1] ?? "",
      };
    });
}

/** The library name ioredis gives its connections: `ioredis`, or `ioredis(<tag>)`. */
const IOREDIS_LIB = /^ioredis(?:\(.*\))?$/;

/**
 * The clients of a fork among `listed`: those of the window of ids
 * `[from, before)` - opened after the fork started and before the reading
 * client - that ioredis named (`CLIENT SETINFO LIB-NAME`). Throws, naming
 * them, while the window holds a client that has named no library and is not
 * one of `known`: an unnamed connection of the fork, before its `SETINFO`,
 * looks just like the `redis-cli ping` of a healthcheck, and a reading taken
 * then would leave one of the fork's connections out unseen. Both pass within
 * milliseconds and the caller reads again (`vi.waitFor`); one that stays -
 * a Redis older than 7.2, which has no `SETINFO`, a `MONITOR`, an IDE on the
 * stack - is the reason its wait ends with, not a bare timeout.
 */
function forkClientsOf(
  listed: readonly ListedClient[],
  window: { from: number; before: number; known: ReadonlySet<number> },
): ListedClient[] {
  const inWindow = listed.filter(
    (client) => client.id >= window.from && client.id < window.before,
  );
  const unnamed = inWindow.filter(
    (client) => !IOREDIS_LIB.test(client.lib) && !window.known.has(client.id),
  );
  if (unnamed.length > 0) {
    const named = unnamed.map(({ id, db }) => `id=${id} db=${db}`).join(", ");
    throw new Error(
      `${unnamed.length} client(s) of the window [${window.from}, ${window.before}) named no library: ${named} - a connection of the fork before its CLIENT SETINFO, or a client that never names one (a Redis older than 7.2, a MONITOR, an IDE or redis-cli on the stack)`,
    );
  }
  return inWindow.filter((client) => IOREDIS_LIB.test(client.lib));
}

/** A bare client and the id the server gave it. */
interface BareClient {
  readonly id: number;
  readonly socket: Socket;
}

/**
 * A client the way `redis-cli ping` of the healthcheck of Compose and CI
 * (`infra/docker-compose.yml`, `.github/workflows/ci.yml`) is one: a bare
 * socket to the Redis of `redisUrl` in database 0 that never sends
 * `CLIENT SETINFO`. It asks `CLIENT ID` instead of `PING`, so the caller
 * knows which client of the list it is. Resolves once the server has
 * answered, so the server lists it; a socket that fails or closes before an
 * answer is a rejection that says so, and an error after it - the server
 * dropping the socket - is the end of the socket, not an uncaught exception
 * of the vitest worker. An answer that is no id is a rejection with the
 * answer, the socket destroyed; otherwise the caller destroys it.
 */
async function openBareClient(redisUrl: string): Promise<BareClient> {
  const { hostname, port } = new URL(redisUrl);
  if (port === "") {
    throw new Error(
      "the URL of the bare client names no port: it would dial port 0",
    );
  }
  const socket = connect({ host: hostname, port: Number(port) });
  const id = await new Promise<number>((resolve, reject) => {
    let reply = "";
    const settle = (): void => {
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.off("data", onData);
    };
    const onError = (error: Error): void => {
      settle();
      reject(error);
    };
    const onClose = (): void => {
      settle();
      reject(new Error("the server closed the bare client before it answered"));
    };
    const onData = (chunk: Buffer): void => {
      reply += chunk.toString();
      if (!reply.includes("\r\n")) {
        return;
      }
      settle();
      const answered = /^:(\d+)\r\n/.exec(reply)?.[1];
      if (answered === undefined) {
        // Nobody reads this socket any more: an error of it would be uncaught.
        socket.destroy();
        reject(
          new Error(
            `the server answered CLIENT ID of the bare client with ${JSON.stringify(reply)}`,
          ),
        );
        return;
      }
      resolve(Number(answered));
    };
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.on("data", onData);
    socket.once("connect", () => {
      socket.write("CLIENT ID\r\n");
    });
  });
  // From here on an error only ends the socket; the case reads the list.
  socket.on("error", () => undefined);
  return { id, socket };
}

/** The id the server gives the next client: one past the newest so far. */
async function nextClientId(): Promise<number> {
  const redis = openTestRedis();
  try {
    await whenReady(redis);
    return Number(await redis.client("ID")) + 1;
  } finally {
    redis.disconnect();
  }
}

/** How long the server may take to drop the connections of a dead process. */
const CONNECTIONS_GONE_DEADLINE_MS = 5_000;

/**
 * The bound of the case of the Redis databases: every wait in it ends by its
 * own deadline, with its own reason, before the bound of the case would cut
 * it short with none - the page (`START_DEADLINE_MS`), the named clients of
 * the fork (`START_DEADLINE_MS`, `forkClientsOf`), the stop of the process
 * (`SHUTDOWN_TIMEOUT_MS`, and a second for its exit), the connections
 * leaving with it (`CONNECTIONS_GONE_DEADLINE_MS`) - and five seconds of
 * room. The test timeout of the suite (15 s) is below their sum.
 */
const REDIS_DATABASES_CASE_MS =
  2 * START_DEADLINE_MS +
  SHUTDOWN_TIMEOUT_MS +
  1_000 +
  CONNECTIONS_GONE_DEADLINE_MS +
  5_000;

/** Stops a child and waits for its end; a child already ended is left be. */
async function stopped(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => {
    child.on("exit", () => {
      resolve();
    });
  });
  child.kill();
  await exited;
}

/** A forked entry point, and what the cases read of it. */
interface RunningApi {
  child: ChildProcess;
  port: number;
  /**
   * The id the server gave the next client just before the fork: client ids
   * are handed out in order, so every client from here on is the fork's or
   * one opened after it, and a client left by another run - a worker fork of
   * a crashed run, in its own database - is older.
   */
  firstClientId: number;
  /** What the process wrote so far, stdout and stderr together. */
  output(): string;
}

/**
 * The entry point started with the command `pnpm dev` runs, with the config
 * of the test run (`.env.test`, loaded by the vitest setup), the two labels
 * and a free port on top, and the Redis database of the api suite instead of
 * the one the worker suite uses. The caller stops it (`stopped`).
 */
async function startApi(): Promise<RunningApi> {
  const firstClientId = await nextClientId();
  const port = await freePort();
  const { execArgv, script } = devCommandParts();
  const child = fork(join(APP_DIR, script), [], {
    cwd: APP_DIR,
    execArgv,
    env: {
      ...process.env,
      REDIS_URL: suiteRedisUrl(env.REDIS_URL, "api"),
      API_PORT: String(port),
      APP_VERSION: VERSION,
      GIT_COMMIT: REJECTED_COMMIT,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  return { child, port, firstClientId, output: () => output };
}

describe("api entry point", () => {
  let api: RunningApi;

  beforeAll(async () => {
    api = await startApi();
  });

  afterAll(async () => {
    await stopped(api.child);
  });

  it("reports the label it was given and null for the one it dropped", async () => {
    const status = SystemStatusResponseSchema.parse(await statusOf(api.port));

    expect(status.build).toEqual({ version: VERSION, commit: null });
  });

  it("names the dropped label in its log, without the value", async () => {
    await statusOf(api.port);
    const output = api.output();
    const warnings = output
      .split("\n")
      .filter((line) => line.includes("build label ignored"))
      .map((line): Record<string, unknown> => JSON.parse(line));

    expect(warnings).toEqual([
      expect.objectContaining({ level: 40, variable: "GIT_COMMIT" }),
    ]);
    expect(output).not.toContain(REJECTED_COMMIT);
  });
});

/**
 * The case stops the process it reads - its connections must leave with it -
 * so it has a process of its own: one shared with other cases would leave
 * them without one, whatever order they run in.
 */
describe("api entry point and the Redis databases", () => {
  let api: RunningApi;

  beforeAll(async () => {
    api = await startApi();
  });

  afterAll(async () => {
    await stopped(api.child);
  });

  it(
    "keeps its Redis connections out of the database of the worker suite",
    async () => {
      await statusOf(api.port);
      // A client of the window that is not the fork's: `redis-cli ping` of the
      // healthcheck of Compose and CI comes in like this one, in database 0.
      const bare = await openBareClient(env.REDIS_URL);
      const redis = openTestRedis();
      try {
        // No offline queue: a command before the socket is up is refused.
        await whenReady(redis);
        // Every client between the fork's start and this one is the fork's or
        // one that came from outside the file, as `bare` did. The fork's are
        // the ones ioredis named (`CLIENT SETINFO LIB-NAME`, sent right after
        // the connect - waited for, not assumed): the list is read again until
        // no client of the window is unnamed but `bare`, and a wait that runs
        // out ends with the clients that stayed unnamed.
        const own = Number(await redis.client("ID"));
        const forked = await vi.waitFor(
          async () => {
            const found = forkClientsOf(
              clientsOf(String(await redis.client("LIST"))),
              {
                from: api.firstClientId,
                before: own,
                known: new Set([bare.id]),
              },
            );
            // The fork has a connection open by now (it answered the page).
            expect(found.length).toBeGreaterThan(0);
            return found;
          },
          { timeout: START_DEADLINE_MS, interval: 50 },
        );

        // Every one of them sits in the api's database.
        expect(forked.map((client) => client.db)).toEqual(
          forked.map(() => TEST_REDIS_DATABASE_OF.api),
        );

        // And they are the fork's, not some other client's of the window: they
        // leave with it.
        await stopped(api.child);
        const forkedIds = new Set(forked.map((client) => client.id));
        await vi.waitFor(
          async () => {
            const left = clientsOf(String(await redis.client("LIST"))).filter(
              (client) => forkedIds.has(client.id),
            );
            expect(left).toEqual([]);
          },
          { timeout: CONNECTIONS_GONE_DEADLINE_MS, interval: 50 },
        );
      } finally {
        bare.socket.destroy();
        redis.disconnect();
      }
    },
    REDIS_DATABASES_CASE_MS,
  );
});

/**
 * How long the process on a taken port gets to leave: its start, the stop
 * with its own deadline of ten seconds, and the flush of the log after it.
 */
const EXIT_DEADLINE_MS = 20_000;

/** The exit code of a child, or a failure once `EXIT_DEADLINE_MS` passes. */
function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the api did not exit within ${EXIT_DEADLINE_MS}ms`));
    }, EXIT_DEADLINE_MS);
    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
}

describe("api entry point on a port that is taken", () => {
  /**
   * The connections are open by the time `listen` fails: the stop closes
   * them the way a signal would and leaves with the code of a failure, rather
   * than a bare `process.exit(1)` past everything it opened.
   */
  it(
    "closes what it opened through the stop and exits with 1",
    async () => {
      const taken = createServer();
      await new Promise<void>((resolve) => {
        taken.listen(0, "0.0.0.0", resolve);
      });
      const address = taken.address();
      if (address === null || typeof address === "string") {
        throw new Error("the port holder is not listening on a tcp port");
      }
      let child: ChildProcess | undefined;
      try {
        const { execArgv, script } = devCommandParts();
        child = fork(join(APP_DIR, script), [], {
          cwd: APP_DIR,
          execArgv,
          env: {
            ...process.env,
            REDIS_URL: suiteRedisUrl(env.REDIS_URL, "api"),
            API_PORT: String(address.port),
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        let output = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        const code = await exitOf(child);

        expect(code).toBe(1);
        const lines = output
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line): Record<string, unknown> => JSON.parse(line));
        expect(lines.map((line) => line.msg)).toEqual(
          expect.arrayContaining([
            "failed to start the api",
            "shutdown started",
            "shutdown complete",
          ]),
        );
        expect(
          lines.find((line) => line.msg === "shutdown complete"),
        ).toMatchObject({ signal: "listen failure", failed: true });
        // Redis may not be connected yet when the port is refused: torn down
        // instead of a QUIT, it writes "closed by disconnect" - closed all the same.
        expect(
          lines
            .filter(
              (line) =>
                line.msg === "closed" || line.msg === "closed by disconnect",
            )
            .map((line) => line.target),
        ).toEqual(expect.arrayContaining(["app", "db", "queues", "redis"]));
      } finally {
        // A process that did not leave on its own - a failed assertion, a
        // stop that hung - does not outlive the case.
        if (child !== undefined) {
          await stopped(child);
        }
        await new Promise<void>((resolve) => {
          taken.close(() => {
            resolve();
          });
        });
      }
    },
    EXIT_DEADLINE_MS + 5_000,
  );
});

describe("api stop under a silent Postgres", () => {
  /**
   * The stop of the api with a db probe stuck on a half-open socket: the
   * `db` stage closes every handle with a bound of its own, so a clean
   * SIGTERM ends with 0 before the deadline of the stop instead of 1 by it
   * (docs/TECH_DEBT.md § E0-12H, п.6). Once per handle - the ping of
   * `/health` and the read of the `budget` section - since either can be the
   * one in flight when the signal comes.
   *
   * Here rather than next to `compose-app.test.ts`: the case needs the live
   * stack - a relay in front of the test Postgres and the Redis of the
   * suite - which only the integration run is behind the entry check for,
   * and this file is the one about how the process ends. In process rather
   * than forked: the stop is what is under test, the signal is the argument
   * of the handler `composeApp` subscribes, and a fork on Windows cannot be
   * sent a signal its handlers would see. The composition is the entry
   * point's own - `composeApp` with the parsed config of the run, the
   * database behind a relay.
   */
  it.each([
    { probe: "health", url: "/health", stuckStatus: 503 },
    { probe: "budget", url: "/system/status", stuckStatus: 200 },
  ])(
    "exits with 0 on SIGTERM while the $probe probe hangs, before the deadline of the stop",
    async ({ url, stuckStatus }) => {
      const relay = await openRelay();
      const codes: number[] = [];
      const runEnv = {
        ...env,
        DATABASE_URL: relay.url,
        REDIS_URL: suiteRedisUrl(env.REDIS_URL, "api"),
      };
      const { log, entries } = recordingServiceLogger(runEnv);
      const { app, shutdown } = composeApp(runEnv, {
        log,
        rejectedBuildLabels: [],
        subscribe: () => {},
        exit: (code) => codes.push(code),
      });
      const ask = () =>
        app.inject({
          method: "GET",
          url,
          headers: { authorization: basicAuthHeader(env.ADMIN_PASSWORD) },
        });
      try {
        await app.ready();
        // A live connection of the handle under test first: the freeze has
        // to catch an open socket.
        await vi.waitFor(
          async () => {
            const res = await ask();
            expect(res.statusCode).toBe(200);
            if (url === "/system/status") {
              expect(
                SystemStatusResponseSchema.parse(JSON.parse(res.payload)).checks
                  .db,
              ).toEqual({ status: "up", reason: null });
            }
          },
          { timeout: START_DEADLINE_MS, interval: 100 },
        );

        relay.freeze();
        const polled = ask();
        const stoppedAt = performance.now();
        const stop = shutdown("SIGTERM");

        await vi.waitFor(
          () => {
            expect(codes).toHaveLength(1);
          },
          { timeout: SHUTDOWN_TIMEOUT_MS + 5_000, interval: 50 },
        );
        const took = performance.now() - stoppedAt;
        await stop;
        expect((await polled).statusCode).toBe(stuckStatus);

        expect(codes).toEqual([0]);
        expect(took).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
        expect(
          entries().find((entry) => entry.msg === "shutdown complete"),
        ).toMatchObject({ signal: "SIGTERM" });
      } finally {
        relay.thaw();
        await shutdown("SIGTERM");
        await relay.cut();
      }
    },
    SHUTDOWN_TIMEOUT_MS + 10_000,
  );
});

describe("clientsOf", () => {
  it("reads the id, the database and the library of each client", () => {
    expect(
      clientsOf(
        "id=7 addr=127.0.0.1:1 db=2 lib-name=ioredis lib-ver=5.11.1\nid=8 addr=127.0.0.1:2 db=0 lib-name= lib-ver=\n",
      ),
    ).toEqual([
      { id: 7, db: "2", lib: "ioredis" },
      { id: 8, db: "0", lib: "" },
    ]);
  });

  it.each([
    ["without an id", "addr=127.0.0.1:1 db=2 lib-name=ioredis"],
    ["with an id that is no number", "id=x addr=127.0.0.1:1 db=2"],
    ["without a db", "id=7 addr=127.0.0.1:1 lib-name=ioredis"],
  ])("throws, with the line, on a line %s", (_what, line) => {
    expect(() => clientsOf(`${line}\n`)).toThrow(JSON.stringify(line));
  });
});

describe("forkClientsOf", () => {
  const window = { from: 10, before: 20, known: new Set([12]) };

  it("takes the named clients of the window, past the known bare one and the clients outside it", () => {
    expect(
      forkClientsOf(
        clientsOf(
          "id=9 db=0 lib-name=ioredis\nid=11 db=2 lib-name=ioredis\nid=12 db=0 lib-name=\nid=13 db=2 lib-name=ioredis(api)\nid=20 db=2 lib-name=ioredis\nid=21 db=0 lib-name=\n",
        ),
        window,
      ),
    ).toEqual([
      { id: 11, db: "2", lib: "ioredis" },
      { id: 13, db: "2", lib: "ioredis(api)" },
    ]);
  });

  it("takes a client with the first id of the window: the fork's first connection is the id read before the fork", () => {
    expect(
      forkClientsOf(clientsOf("id=10 db=2 lib-name=ioredis\n"), window),
    ).toEqual([{ id: 10, db: "2", lib: "ioredis" }]);
  });

  it("throws, naming it, while a client of the window is unnamed and not known: a connection of the fork before its SETINFO, or one that never names itself", () => {
    expect(() =>
      forkClientsOf(
        clientsOf("id=11 db=2 lib-name=ioredis\nid=14 db=0 lib-name=\n"),
        window,
      ),
    ).toThrow(
      "1 client(s) of the window [10, 20) named no library: id=14 db=0 - a connection of the fork before its CLIENT SETINFO, or a client that never names one (a Redis older than 7.2",
    );
  });
});

describe("openBareClient", () => {
  /** A server on a free port that does `onSocket` with each connection. */
  async function serverThat(
    onSocket: (socket: Socket) => void,
  ): Promise<{ url: string; close(): Promise<void> }> {
    const server = createServer(onSocket);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the stand-in server is not listening on a tcp port");
    }
    return {
      url: `redis://127.0.0.1:${address.port}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    };
  }

  it("is refused, saying so, by a server that closes it before an answer", async () => {
    const server = await serverThat((socket) => {
      // Read what the client sends, so the server side reaches its end too.
      socket.resume();
      socket.end();
    });
    try {
      await expect(openBareClient(server.url)).rejects.toThrow(
        "the server closed the bare client before it answered",
      );
    } finally {
      await server.close();
    }
  }, 3_000);

  it("survives a reset of the socket after the answer: the end of it, not an uncaught error", async () => {
    const server = await serverThat((socket) => {
      socket.once("data", () => {
        socket.write(":7\r\n", () => {
          setTimeout(() => {
            socket.resetAndDestroy();
          }, 20);
        });
      });
    });
    try {
      const bare = await openBareClient(server.url);
      expect(bare.id).toBe(7);
      await new Promise<void>((resolve) => {
        bare.socket.once("close", () => {
          resolve();
        });
      });
    } finally {
      await server.close();
    }
  });

  it("is refused with the error of the socket when it cannot connect", async () => {
    // Nothing listens there: the error comes before any answer.
    const port = await freePort();

    await expect(openBareClient(`redis://127.0.0.1:${port}`)).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  it("is refused, with the answer, by a server that answers CLIENT ID with no id, and leaves no socket to reset", async () => {
    let serverSide: Promise<void> | undefined;
    const server = await serverThat((socket) => {
      serverSide = new Promise<void>((resolve) => {
        socket.on("error", () => undefined);
        socket.on("close", () => {
          resolve();
        });
      });
      socket.once("data", () => {
        socket.write("-ERR unknown command 'CLIENT'\r\n", () => {
          // A socket of the client still open meets the reset uncaught.
          setTimeout(() => {
            socket.resetAndDestroy();
          }, 20);
        });
      });
    });
    try {
      await expect(openBareClient(server.url)).rejects.toThrow(
        `the server answered CLIENT ID of the bare client with "-ERR unknown command 'CLIENT'\\r\\n"`,
      );
      await serverSide;
      // Room for an error of the reset to reach the client side, if it is open.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      await server.close();
    }
  });

  it("refuses a URL without a port instead of dialing port 0", async () => {
    await expect(openBareClient("redis://127.0.0.1/0")).rejects.toThrow(
      "names no port",
    );
  });
});
