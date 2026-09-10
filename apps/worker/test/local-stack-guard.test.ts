import { describe, expect, it } from "vitest";
import { assertLocalTestStack } from "./local-stack-guard.js";

/**
 * The worker integration fixture deletes usage rows, overwrites the queue
 * switches and obliterates queues. A unit test on purpose: with Compose up the
 * guard is only ever exercised on the happy path, the `test:int` gate is not
 * on yet, and a guard removed by accident would reach a commit green.
 */
const LOCAL_DB = "postgresql://sf:sf@localhost:5442/shorts_factory_test";
const LOCAL_REDIS = "redis://localhost:6389/1";

describe("worker integration stack guard", () => {
  it("allows the local Postgres and Redis of infra/docker-compose.yml", () => {
    expect(() => assertLocalTestStack(LOCAL_DB, LOCAL_REDIS)).not.toThrow();
    expect(() =>
      assertLocalTestStack(
        "postgresql://sf:sf@127.0.0.1:5442/shorts_factory_test",
        "redis://127.0.0.1:6389/1",
      ),
    ).not.toThrow();
  });

  it("refuses a database on another machine", () => {
    expect(() =>
      assertLocalTestStack(
        "postgresql://sf:sf@db.example.com:5432/shorts_factory_test",
        LOCAL_REDIS,
      ),
    ).toThrow(/db\.example\.com/);
  });

  it("refuses a Redis on another machine", () => {
    // A tunnel makes a remote Redis look like a local port; the URL is what
    // says which one it is, and `obliterate` does not ask twice.
    expect(() =>
      assertLocalTestStack(LOCAL_DB, "redis://redis.example.com:6379/1"),
    ).toThrow(/redis\.example\.com/);
  });

  it("refuses the development database next to the test one", () => {
    expect(() =>
      assertLocalTestStack(
        "postgresql://sf:sf@localhost:5442/shorts_factory",
        LOCAL_REDIS,
      ),
    ).toThrow(/shorts_factory_test/);
  });

  it("refuses the Redis database the api and the worker really use", () => {
    expect(() =>
      assertLocalTestStack(LOCAL_DB, "redis://localhost:6389"),
    ).toThrow(/redis database/);
  });
});
