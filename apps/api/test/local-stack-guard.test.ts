import { describe, expect, it } from "vitest";
import { apiTestRedisUrl, assertApiTestStack } from "./local-stack-guard.js";

/**
 * The api integration fixture deletes usage rows, writes a spend fixture and
 * pauses a queue. A unit test on purpose: with Compose up the guard is only
 * ever exercised on the happy path, the `test:int` gate is not on yet, and a
 * guard removed by accident would reach a commit green.
 */
const LOCAL_DB = "postgresql://sf:sf@localhost:5442/shorts_factory_test";
const LOCAL_REDIS = "redis://localhost:6389/1";

describe("api integration stack guard", () => {
  it("allows the local Postgres and Redis of infra/docker-compose.yml", () => {
    expect(() => assertApiTestStack(LOCAL_DB, LOCAL_REDIS)).not.toThrow();
    expect(() =>
      assertApiTestStack(
        "postgresql://sf:sf@127.0.0.1:5442/shorts_factory_test",
        "redis://127.0.0.1:6389/1",
      ),
    ).not.toThrow();
  });

  it("refuses a database on another machine", () => {
    // CI and the VPS of E0-11 both have a `shorts_factory_test` of their own,
    // and this suite would delete from the journal of whichever it is given.
    expect(() =>
      assertApiTestStack(
        "postgresql://sf:sf@db.example.com:5432/shorts_factory_test",
        LOCAL_REDIS,
      ),
    ).toThrow(/db\.example\.com/);
  });

  it("refuses the development database next to the test one", () => {
    // One character apart, and the difference is between a fixture of 37 units
    // and 37 units counted against the real quota cap.
    expect(() =>
      assertApiTestStack(
        "postgresql://sf:sf@localhost:5442/shorts_factory",
        LOCAL_REDIS,
      ),
    ).toThrow(/shorts_factory_test/);
  });

  it("refuses a Redis on another machine", () => {
    expect(() =>
      assertApiTestStack(LOCAL_DB, "redis://redis.example.com:6379/1"),
    ).toThrow(/redis\.example\.com/);
  });

  it("refuses a Redis server .env.test does not name", () => {
    // The database of the environment URL, not of the one `apiTestRedisUrl`
    // derives: a guard that checks the number it has just written itself can
    // never refuse, and this suite pauses a queue and rewrites the heartbeat
    // key. A development Redis on the default port names database 0 - one
    // line in `.env.test` away - and database 2 of *that* server holds
    // nothing this suite is allowed to touch.
    expect(() =>
      assertApiTestStack(LOCAL_DB, "redis://localhost:6379/0"),
    ).toThrow(/redis database/);
  });
});

describe("apiTestRedisUrl", () => {
  /**
   * What keeps this suite and the worker suite apart while `turbo run
   * test:int` runs both: the pause of a queue here must not be a pause of a
   * queue the worker is taking jobs from. Asserted on the derived URL rather
   * than by reading the other suite's Redis - reading it would be the very
   * coupling this is here to rule out.
   */
  it("moves the suite off the Redis database .env.test names", () => {
    expect(new URL(apiTestRedisUrl(LOCAL_REDIS)).pathname).toBe("/2");
    expect(apiTestRedisUrl(LOCAL_REDIS)).not.toBe(LOCAL_REDIS);
  });

  it("keeps the server of .env.test, changing only the database", () => {
    const url = new URL(apiTestRedisUrl("redis://localhost:6389/1"));

    expect(url.hostname).toBe("localhost");
    expect(url.port).toBe("6389");
  });
});
