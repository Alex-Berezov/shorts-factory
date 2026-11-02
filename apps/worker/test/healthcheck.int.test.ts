import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SEC } from "@sf/core";
import { closeRedis } from "@sf/runtime";
import {
  type ChildRun,
  KILL_DEADLINE_MS,
  collectOutput,
  endOf,
  endWithin,
} from "@sf/runtime/test-support/child-run";
import type { DevCommandParts } from "@sf/runtime/test-support/dev-command";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PACKAGE_DIR } from "./dev-command.js";
import { workerHealthcheckOfRepo } from "./healthcheck-command.js";
import { openTestRedis } from "./helpers.int.js";

/**
 * The container healthcheck of the worker, run the way Compose runs it - a
 * separate node process with the flags and the script of the healthcheck of
 * the image, read from the Compose files (`healthcheck-command.ts`), not
 * written out here - against the test Redis and against a port nothing
 * listens on. A fake client could not show the one property that matters for
 * a dead Redis: that the process ends on its own, with 1, before Docker's own
 * timeout would have to kill it. The flags are locked by the `compose` gate
 * (rule 4, `WORKER_HEALTHCHECK` of `scripts/compose-rules.mjs`), not by this
 * test: a harmless change of them passes here.
 *
 * The command is read in `beforeAll`, not at the top of the module: a Compose
 * file the reader refuses then fails the cases with its reason, not the
 * collection of the file without a name.
 */
let healthcheck: DevCommandParts;

beforeAll(() => {
  healthcheck = workerHealthcheckOfRepo();
});
/** A port nothing listens on; connecting is refused rather than hanging. */
const DEAD_REDIS = "redis://127.0.0.1:1";
/** The command's own deadline; Compose gives it 10 s (`timeout:`). */
const CLI_DEADLINE_MS = 5_000;
/** Room for starting node with tsx on a slow machine. */
const SPAWN_ALLOWANCE_MS = 5_000;
/**
 * The bound of a case that waits out the deadline of the command: its run
 * ends within that deadline and the start of node (`endWithin`), a missed
 * end is followed by a single `SIGKILL` (`KILL_DEADLINE_MS`), and five
 * seconds of room.
 */
const DEADLINE_CASE_MS =
  CLI_DEADLINE_MS + SPAWN_ALLOWANCE_MS + KILL_DEADLINE_MS + 5_000;

const redis = openTestRedis();

/**
 * A run of the command: what it printed on stdout is the `output` of the
 * run, its stderr - which a case holds to silence or to no secret - is read
 * on its own, and the time it took is what the cases of a dead Redis bound.
 */
type HealthcheckRun = ChildRun & { stderr: string; elapsedMs: number };

async function runHealthcheck(
  env: NodeJS.ProcessEnv = {},
  preload: string[] = [],
): Promise<HealthcheckRun> {
  // Monotonic: a step of the wall clock is no time the run took.
  const startedAt = performance.now();
  const cli = resolve(PACKAGE_DIR, healthcheck.script);
  const child = fork(cli, [], {
    execArgv: [...healthcheck.execArgv, ...preload],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, ...env },
  });
  const stderr = collectOutput(child, ["stderr"]);
  const run = await endWithin(
    child,
    endOf(child, collectOutput(child, ["stdout"])),
    CLI_DEADLINE_MS + SPAWN_ALLOWANCE_MS,
    "the healthcheck",
  );
  return {
    ...run,
    stderr: stderr(),
    elapsedMs: performance.now() - startedAt,
  };
}

beforeEach(async () => {
  await redis.del(WORKER_HEARTBEAT_KEY);
});

const scratch = mkdtempSync(join(tmpdir(), "sf-healthcheck-int-"));

afterAll(async () => {
  rmSync(scratch, { recursive: true, force: true });
  await redis.del(WORKER_HEARTBEAT_KEY);
  await closeRedis(redis);
});

/**
 * A module preloaded into the child (`--import`) that fails every read of a
 * file named `.env` the way `fs` fails it on a directory, before anything is
 * read: the checkout's `.env` is never opened.
 */
function envFileFailing(error: string): string[] {
  const module = join(scratch, "env-file-failing.preload.mjs");
  writeFileSync(
    module,
    [
      'import fs from "node:fs";',
      'import { basename } from "node:path";',
      'import { syncBuiltinESMExports } from "node:module";',
      "const read = fs.readFileSync;",
      "fs.readFileSync = (path, ...rest) => {",
      '  if (typeof path === "string" && basename(path) === ".env") {',
      `    throw ${error};`,
      "  }",
      "  return read(path, ...rest);",
      "};",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
  );
  return ["--import", pathToFileURL(module).href];
}

/**
 * A module preloaded into the child (`--import`) under which reading
 * `REDIS_URL` throws `error` - not a refusal of `readRedisUrl`, the fault of
 * something else on the way to Redis.
 */
function redisUrlThrowing(error: string): string[] {
  const module = join(scratch, "redis-url-throwing.preload.mjs");
  writeFileSync(
    module,
    [
      "process.env = new Proxy(process.env, {",
      "  get(target, key) {",
      `    if (key === "REDIS_URL") throw ${error};`,
      "    return Reflect.get(target, key);",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  return ["--import", pathToFileURL(module).href];
}

describe("worker healthcheck", () => {
  it("exits 0 on a fresh stamp", async () => {
    await redis.set(
      WORKER_HEARTBEAT_KEY,
      new Date().toISOString(),
      "EX",
      WORKER_HEARTBEAT_TTL_SEC,
    );

    const run = await runHealthcheck();

    expect(run.code).toBe(0);
    expect(run.output.trim()).toMatch(/^healthy: last heartbeat at /);
  });

  it("reads REDIS_URL alone: a malformed key it does not use changes nothing", async () => {
    await redis.set(
      WORKER_HEARTBEAT_KEY,
      new Date().toISOString(),
      "EX",
      WORKER_HEARTBEAT_TTL_SEC,
    );

    // Both fail the full configuration schema; neither is the healthcheck's.
    const run = await runHealthcheck({
      WORKER_CONCURRENCY: "lots",
      ADMIN_PASSWORD: "short",
    });

    expect(run.code).toBe(0);
    expect(run.output.trim()).toMatch(/^healthy: last heartbeat at /);
  });

  it("exits 1 with its own reason when REDIS_URL is not a url", async () => {
    const run = await runHealthcheck({ REDIS_URL: "not a url" });

    expect(run.code).toBe(1);
    // The reason whole, with nothing of the parser after it: whatever the
    // parser says may one day name the value.
    expect(run.output.trim()).toBe("unhealthy: REDIS_URL is not a valid url");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])(
    "exits 1 saying REDIS_URL is not set when it is %s",
    async (_case, value) => {
      // `VITEST` reaches the child, so no root `.env` fills the gap.
      const run = await runHealthcheck({ REDIS_URL: value });

      expect(run.code).toBe(1);
      expect(run.output.trim()).toBe("unhealthy: REDIS_URL is not set");
    },
  );

  it("gives a REDIS_URL with a password that is not a url the same reason, whole", async () => {
    // The exact line is the check that nothing of the value follows it; the
    // process writes nothing else (stderr stays empty).
    const run = await runHealthcheck({
      REDIS_URL: "redis://user:s3cret-pass@[bad",
    });

    expect(run.code).toBe(1);
    expect(run.output.trim()).toBe("unhealthy: REDIS_URL is not a valid url");
    expect(run.stderr).toBe("");
  });

  it.each([
    [
      "a directory",
      `Object.assign(new Error("EISDIR: illegal operation on a directory, read"), { code: "EISDIR", errno: -21, syscall: "read" })`,
      ".env is not readable (EISDIR)",
    ],
    [
      "a failure without a code",
      'new Error("read failed at /srv/app/.env")',
      ".env is not readable (unknown)",
    ],
  ])(
    "exits 1 saying .env is not readable when it is %s, with its code alone",
    async (_case, error, reason) => {
      // Without `VITEST` the child fills the environment from `.env`, as in
      // a container; `REDIS_URL` is in order, so the file is the only fault.
      const run = await runHealthcheck(
        { VITEST: undefined, REDIS_URL: "redis://user:s3cret-pass@redis:6379" },
        envFileFailing(error),
      );

      expect(run.code).toBe(1);
      expect(run.output.trim()).toBe(`unhealthy: ${reason}`);
      expect(run.stderr).toBe("");
    },
  );

  it("exits 1 with a reason of its own on a failure that is not a refusal, printing nothing of it", async () => {
    const run = await runHealthcheck(
      {},
      redisUrlThrowing('new Error("secret")'),
    );

    expect(run.signal).toBeNull();
    expect(run.code).toBe(1);
    expect(run.output.trim()).toBe(
      "unhealthy: healthcheck failed before reaching redis",
    );
    expect(run.output).not.toContain("secret");
    expect(run.stderr).not.toContain("secret");
  });

  it("exits 1 on a stamp that is not the worker's format", async () => {
    await redis.set(WORKER_HEARTBEAT_KEY, "yesterday-ish");

    const run = await runHealthcheck();

    expect(run.code).toBe(1);
    expect(run.output.trim()).toBe(
      "unhealthy: heartbeat stamp is not the worker's format",
    );
    expect(run.output).not.toContain("yesterday-ish");
  });

  it("exits 1 when the stamp is missing", async () => {
    const run = await runHealthcheck();

    expect(run.code).toBe(1);
    expect(run.output.trim()).toBe("unhealthy: no heartbeat stamp in redis");
  });

  it("exits 1 on a stamp older than the TTL", async () => {
    const old = new Date(
      Date.now() - (WORKER_HEARTBEAT_TTL_SEC + 60) * 1_000,
    ).toISOString();
    await redis.set(WORKER_HEARTBEAT_KEY, old);

    const run = await runHealthcheck();

    expect(run.code).toBe(1);
    // The age is counted against the clock of the process, read a moment
    // after the stamp was written here: at least the 60 s past the TTL.
    const line = run.output.trim();
    const age =
      /^unhealthy: last heartbeat (\d+) s ago at (\S+), worker stopped writing$/.exec(
        line,
      );
    expect(age?.[2]).toBe(old);
    expect(Number(age?.[1])).toBeGreaterThanOrEqual(
      WORKER_HEARTBEAT_TTL_SEC + 60,
    );
  });

  it(
    "exits 1 on its own, within its deadline, when redis is not there",
    async () => {
      const run = await runHealthcheck({ REDIS_URL: DEAD_REDIS });

      expect(run.signal).toBeNull();
      expect(run.code).toBe(1);
      expect(run.output.trim()).toMatch(/^unhealthy: /);
      expect(run.elapsedMs).toBeLessThan(CLI_DEADLINE_MS + SPAWN_ALLOWANCE_MS);
    },
    DEADLINE_CASE_MS,
  );

  it(
    "exits 1 at its deadline when redis accepts the connection and never answers",
    async () => {
      // A real socket that swallows every byte: the connect succeeds, so no
      // connect timeout or refusal ends the wait - only the deadline does.
      const sockets: Socket[] = [];
      const silent: Server = createServer((socket) => {
        // The healthcheck leaves through `process.exit`, which resets the
        // connection rather than closing it; that reset is expected here.
        socket.on("error", () => undefined);
        sockets.push(socket);
      });
      await new Promise<void>((resolve) => {
        silent.listen(0, "127.0.0.1", resolve);
      });
      const address = silent.address();
      if (address === null || typeof address === "string") {
        throw new Error("silent redis has no tcp port");
      }

      try {
        const run = await runHealthcheck({
          REDIS_URL: `redis://127.0.0.1:${address.port}`,
        });

        expect(run.signal).toBeNull();
        expect(run.code).toBe(1);
        expect(run.output.trim()).toBe(
          `unhealthy: no answer from redis within ${CLI_DEADLINE_MS} ms`,
        );
        expect(run.elapsedMs).toBeGreaterThanOrEqual(CLI_DEADLINE_MS);
        expect(run.elapsedMs).toBeLessThan(
          CLI_DEADLINE_MS + SPAWN_ALLOWANCE_MS,
        );
      } finally {
        for (const socket of sockets) {
          socket.destroy();
        }
        await new Promise<void>((resolve) => {
          silent.close(() => resolve());
        });
      }
    },
    DEADLINE_CASE_MS,
  );
});
