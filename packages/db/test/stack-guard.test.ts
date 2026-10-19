import { readFileSync } from "node:fs";
import { inspect, parseEnv } from "node:util";
import { testEnvFilePath } from "@sf/config/paths";
import { describe, expect, it } from "vitest";
import {
  TEST_REDIS_DATABASE_OF,
  TEST_STACK,
  assertLocalTestPostgres,
  assertLocalTestRedis,
  assertTestDatabaseName,
  suiteRedisUrl,
} from "../test-support/stack-guard.js";

/**
 * The guard in front of every destructive step of the integration suites -
 * `DROP SCHEMA`, deletes from `api_usage_log`, `obliterate`. A unit test on
 * purpose: with Compose up the guard only ever meets the happy path, so a
 * check removed by accident would reach a commit green. One case per refusal,
 * so each branch is red on its own when it goes.
 */
const LOCAL_DB = "postgresql://sf:sf@localhost:5442/shorts_factory_test";
const LOCAL_REDIS = "redis://localhost:6389/1";

/** `new URL` reads localhost:5442 here, postgres-js reads db.example.com. */
const SPLIT_AT_FIRST_AT =
  "postgresql://sf:sf@db.example.com,x@localhost:5442/shorts_factory_test";
/** postgres-js decodes this host into the list localhost, db.example.com. */
const ENCODED_HOST_LIST =
  "postgresql://sf:sf@localhost%2Cdb.example.com:5442/shorts_factory_test";

/**
 * Both halves of the guard, the way an entry check of a run that touches
 * both services meets them (`assertMigrated`): the cases below name the
 * service a refusal is about.
 */
function assertBothHalves(databaseUrl: string, redisUrl: string): void {
  assertLocalTestPostgres(databaseUrl);
  assertLocalTestRedis(redisUrl);
}

/** The error `fn` throws; fails the test when it throws nothing. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal, got none");
}

describe("the stack guard: allows", () => {
  it.each([
    ["localhost", LOCAL_DB, LOCAL_REDIS],
    [
      "127.0.0.1",
      "postgresql://sf:sf@127.0.0.1:5442/shorts_factory_test",
      "redis://127.0.0.1:6389/1",
    ],
    [
      "[::1]",
      "postgresql://sf:sf@[::1]:5442/shorts_factory_test",
      "redis://[::1]:6389/1",
    ],
  ])("the local Compose test stack on %s", (_host, db, redis) => {
    expect(() => assertBothHalves(db, redis)).not.toThrow();
  });
});

describe("the stack guard: refuses", () => {
  it("a Postgres on another machine", () => {
    // CI and a future VPS can both hold a `shorts_factory_test` of their own.
    expect(() =>
      assertBothHalves(
        "postgresql://sf:sf@db.example.com:5442/shorts_factory_test",
        LOCAL_REDIS,
      ),
    ).toThrow(/host "db\.example\.com".*\.env\.test/);
  });

  it("a Redis on another machine", () => {
    // A tunnel makes a remote Redis look like a local port; the URL is what
    // says which one it is, and `obliterate` does not ask twice.
    expect(() =>
      assertBothHalves(LOCAL_DB, "redis://redis.example.com:6389/1"),
    ).toThrow(/host "redis\.example\.com"/);
  });

  it("a local Postgres on the default port", () => {
    // 5432 on a developer machine is usually another project's server, and
    // a `shorts_factory_test` there would lose its schemas.
    expect(() =>
      assertBothHalves(
        "postgresql://sf:sf@localhost:5432/shorts_factory_test",
        LOCAL_REDIS,
      ),
    ).toThrow(/Postgres on port 5432 of localhost.*port 5442.*\.env\.test/);
  });

  it("a Postgres URL without a port", () => {
    expect(() =>
      assertBothHalves(
        "postgresql://sf:sf@localhost/shorts_factory_test",
        LOCAL_REDIS,
      ),
    ).toThrow(/Postgres on the default port/);
  });

  it("a local Redis on the default port", () => {
    expect(() =>
      assertBothHalves(LOCAL_DB, "redis://localhost:6379/1"),
    ).toThrow(/Redis on port 6379 of localhost.*port 6389/);
  });

  it("a Redis URL without a port", () => {
    expect(() => assertBothHalves(LOCAL_DB, "redis://localhost/1")).toThrow(
      /Redis on the default port/,
    );
  });

  it("the development database next to the test one", () => {
    expect(() =>
      assertBothHalves(
        "postgresql://sf:sf@localhost:5442/shorts_factory",
        LOCAL_REDIS,
      ),
    ).toThrow(/database "shorts_factory".*"shorts_factory_test"/);
  });

  it("Redis database 0, the one a running worker keeps its queues in", () => {
    expect(() => assertBothHalves(LOCAL_DB, "redis://localhost:6389")).toThrow(
      /redis database 0 \(none named\)/,
    );
    expect(() =>
      assertBothHalves(LOCAL_DB, "redis://localhost:6389/0"),
    ).toThrow(/redis database "0"/);
  });

  it("a Postgres URL whose query names another host", () => {
    // postgres-js reads connection options from the query string; a URL that
    // only looks local is refused whatever the driver would make of it.
    expect(() =>
      assertBothHalves(`${LOCAL_DB}?host=db.example.com`, LOCAL_REDIS),
    ).toThrow(
      /Postgres on localhost:5442 with connection options in its URL \(host\)/,
    );
  });

  it("a Redis URL with a query string", () => {
    expect(() =>
      assertBothHalves(LOCAL_DB, `${LOCAL_REDIS}?host=redis.example.com`),
    ).toThrow(
      /Redis on localhost:6389 with connection options in its URL \(host\)/,
    );
  });

  it("a Postgres URL listing several hosts", () => {
    // The multihost form of postgres-js: the second host is not local.
    expect(() =>
      assertBothHalves(
        "postgresql://sf:sf@localhost:5442,db.example.com:5432/shorts_factory_test",
        LOCAL_REDIS,
      ),
    ).toThrow(/Postgres: its URL lists several hosts/);
  });

  it("a host the driver reads after the first @, not after the last", () => {
    // `new URL` sees localhost:5442 here; postgres-js dials db.example.com.
    expect(() => assertBothHalves(SPLIT_AT_FIRST_AT, LOCAL_REDIS)).toThrow(
      /Postgres: its URL has a second `@` after the user/,
    );
    expect(() =>
      assertBothHalves(
        LOCAL_DB,
        "redis://:pw@redis.example.com@localhost:6389/1",
      ),
    ).toThrow(/Redis: its URL has a second `@` after the user/);
  });

  it("a percent-encoded host, which the driver decodes into a list", () => {
    expect(() => assertBothHalves(ENCODED_HOST_LIST, LOCAL_REDIS)).toThrow(
      /Postgres: its URL has a percent-encoded host/,
    );
  });

  it("a host written in a form the driver reads differently", () => {
    // `new URL` folds the port to 5442; the text the driver reads is not that.
    expect(() =>
      assertBothHalves(
        "postgresql://sf:sf@localhost:05442/shorts_factory_test",
        LOCAL_REDIS,
      ),
    ).toThrow(
      /Postgres: its URL names its host in a form the driver reads differently/,
    );
  });

  it("a space, a backslash or a fragment in a URL", () => {
    // ioredis 5 parses a WHATWG URL, but a reader that still treats a
    // backslash as a `/` would end the host there; postgres-js does not stop
    // at `#`.
    const AMBIGUOUS =
      /its URL holds a space, a control character, a backslash or a fragment/;
    for (const redis of [
      String.raw`redis://redis.example.com:6389\@localhost:6389/1`,
      "redis://local host:6389/1",
      "redis://localhost:6389/1\t",
    ]) {
      expect(() => assertBothHalves(LOCAL_DB, redis), redis).toThrow(AMBIGUOUS);
    }
    expect(() =>
      assertBothHalves(`${LOCAL_DB}#@db.example.com`, LOCAL_REDIS),
    ).toThrow(AMBIGUOUS);
  });

  it("a URL of another scheme", () => {
    expect(() =>
      assertBothHalves(
        "http://localhost:5442/shorts_factory_test",
        LOCAL_REDIS,
      ),
    ).toThrow(
      /Postgres: its URL is not a postgres:\/\/ or postgresql:\/\/ URL \(scheme http:\)/,
    );
    expect(() =>
      assertBothHalves(LOCAL_DB, "rediss://localhost:6389/1"),
    ).toThrow(/Redis: its URL is not a redis:\/\/ URL \(scheme rediss:\)/);
    expect(() =>
      assertBothHalves("postgresql:localhost:5442/x", LOCAL_REDIS),
    ).toThrow(/Postgres: its URL names no host/);
  });

  it("a URL that does not parse, without repeating it", () => {
    // The TypeError of `new URL` carries the whole input - the password too.
    const secret = "s3cret-password";
    const errors = [
      thrownBy(() =>
        assertBothHalves(
          `postgresql://sf:${secret}@localhost:99999/shorts_factory_test`,
          LOCAL_REDIS,
        ),
      ),
      thrownBy(() =>
        assertBothHalves(LOCAL_DB, `redis://:${secret}@[::1:6389/1`),
      ),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/URL does not parse.*\.env\.test/);
      // Everything a report prints of an error: message, stack, own
      // properties and the cause chain.
      expect(inspect(error, { depth: 10 })).not.toContain(secret);
      expect(error instanceof Error ? error.cause : null).toBeUndefined();
    }
  });

  it("a Redis database .env.test does not name", () => {
    // Checked on the number of the environment, not on the one a suite
    // derives from it: database 2 is the api's, but only of the server that
    // `.env.test` describes.
    expect(() =>
      assertBothHalves(LOCAL_DB, "redis://localhost:6389/2"),
    ).toThrow(/redis database "2"/);
  });
});

describe("assertTestDatabaseName", () => {
  it("allows the test database", () => {
    expect(() => assertTestDatabaseName("shorts_factory_test")).not.toThrow();
  });

  it("refuses the database the server says it is connected to, if it is not the test one", () => {
    // What `resetTestDatabase` asks `current_database()` before `DROP SCHEMA`.
    expect(() => assertTestDatabaseName("shorts_factory")).toThrow(
      /database "shorts_factory"/,
    );
    expect(() => assertTestDatabaseName(undefined)).toThrow(/database ""/);
  });
});

describe("the two halves of the guard", () => {
  it("check one service each", () => {
    // A Postgres-only helper does not depend on a Redis URL, and back.
    expect(() => assertLocalTestPostgres(LOCAL_DB)).not.toThrow();
    expect(() => assertLocalTestRedis(LOCAL_REDIS)).not.toThrow();
    expect(() =>
      assertLocalTestPostgres(
        "postgresql://sf:sf@localhost:5432/shorts_factory_test",
      ),
    ).toThrow(/Postgres on port 5432/);
    expect(() => assertLocalTestRedis("redis://localhost:6389/0")).toThrow(
      /redis database "0"/,
    );
  });
});

describe("suiteRedisUrl", () => {
  it("refuses a Redis that is not the test one before it derives anything", () => {
    // A suite that opens its Redis through this function cannot skip the
    // guard: `obliterate` and a queue pause follow on whatever it returns.
    expect(() =>
      suiteRedisUrl("redis://redis.example.com:6389/1", "api"),
    ).toThrow(/host "redis\.example\.com"/);
    expect(() => suiteRedisUrl("redis://localhost:6379/1", "worker")).toThrow(
      /port 6379/,
    );
    expect(() => suiteRedisUrl("redis://localhost:6389/0", "api")).toThrow(
      /redis database "0"/,
    );
  });

  it("moves a suite to its own database on the same server", () => {
    const api = new URL(suiteRedisUrl(LOCAL_REDIS, "api"));
    expect(api.pathname).toBe("/2");
    expect(api.hostname).toBe("localhost");
    expect(api.port).toBe("6389");
  });

  it("keeps the worker on the database .env.test names", () => {
    // Processes the worker suite forks read REDIS_URL as is.
    expect(suiteRedisUrl(LOCAL_REDIS, "worker")).toBe(LOCAL_REDIS);
    expect(TEST_REDIS_DATABASE_OF.worker).toBe(TEST_STACK.envRedisDatabase);
  });

  it("gives every suite a database of its own, never database 0", () => {
    const numbers = Object.values(TEST_REDIS_DATABASE_OF);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).not.toContain("0");
  });
});

describe("TEST_STACK", () => {
  it("is the stack .env.test points at", () => {
    // The fixture the integration runs load, read the way `@sf/config`
    // reads it (`parseEnv` of `node:util`, `testEnvFilePath`).
    const env = parseEnv(readFileSync(testEnvFilePath, "utf8"));
    const db = new URL(env.DATABASE_URL ?? "");
    const redis = new URL(env.REDIS_URL ?? "");

    expect(db.port).toBe(TEST_STACK.postgresPort);
    expect(db.pathname).toBe(`/${TEST_STACK.database}`);
    expect(redis.port).toBe(TEST_STACK.redisPort);
    expect(redis.pathname).toBe(`/${TEST_STACK.envRedisDatabase}`);
    expect(() =>
      assertBothHalves(env.DATABASE_URL ?? "", env.REDIS_URL ?? ""),
    ).not.toThrow();
  });
});
