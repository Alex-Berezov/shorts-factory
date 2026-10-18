import { env } from "@sf/config";
import { QUEUE_NAMES } from "@sf/core";
import { suiteRedisUrl } from "@sf/db/test-support/stack-guard";
import { createQueueFactory, createRequestRedis } from "@sf/runtime";
import { recordingLogger } from "@sf/runtime/test-support/recording-logger";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEPENDENCY_TIMEOUT_MS } from "../src/lib/dependency-timeout.js";

/**
 * An error of the shared client on real BullMQ: every `RedisConnection`
 * re-emits the `error` of the client it runs on, on its own `Queue`, and the
 * factory of `@sf/runtime` keeps that from becoming a line per queue by
 * recognising the very object the client emitted. That rests on how BullMQ
 * forwards - the order of the listeners, the identity of the error - which a
 * fake `Queue` can only imitate; this is the version that ships.
 *
 * The refusal is a real one: a user Redis does not know. The stack of
 * `infra/docker-compose.yml` runs Redis with its default user and ACLs on, so
 * the AUTH of every connect attempt is refused with WRONGPASS - a reply error,
 * not a connection failure - and the client keeps reconnecting.
 */
describe("the errors of the shared client on real queues", () => {
  let client: Redis | undefined;

  afterEach(() => {
    client?.disconnect();
    client = undefined;
  });

  it("writes one line per refusal of the client, none per queue", async () => {
    const url = new URL(suiteRedisUrl(env.REDIS_URL, "api"));
    url.username = "sf-no-such-user";
    url.password = "not-a-password";
    const { log, lines } = recordingLogger();
    client = createRequestRedis(url.toString(), {
      commandTimeoutMs: DEPENDENCY_TIMEOUT_MS,
      log,
    });
    const factory = createQueueFactory({
      connection: client,
      log,
      readOnly: true,
    });
    try {
      // Opened and kept, the way the worker opens its queues at the start: a
      // `Queue` a failed read throws away no longer hears the client, and the
      // reconnects after the first refusal are what reaches every queue.
      for (const name of QUEUE_NAMES) {
        factory.get(name);
      }

      // Two refusals at least: the first one, and one after a reconnect.
      await vi.waitFor(
        () => {
          expect(
            lines.filter((line) => line.msg === "redis client error").length,
          ).toBeGreaterThanOrEqual(2);
        },
        { timeout: 10_000, interval: 50 },
      );
    } finally {
      // Closed whatever the wait ended with: the listeners of the queues stay
      // on the client otherwise.
      await factory.close();
    }

    const refusals = lines.filter((line) => line.msg === "redis client error");
    expect(refusals[0]).toMatchObject({
      level: "error",
      err: expect.objectContaining({
        message: expect.stringContaining("WRONGPASS"),
      }),
    });
    expect(lines.map((line) => line.msg)).not.toContain("queue error");
    // The first refusal is the one `error` line; the rest fade.
    expect(lines.filter((line) => line.level === "error")).toEqual([
      expect.objectContaining({
        msg: "redis client error",
        err: expect.objectContaining({
          message: expect.stringContaining("WRONGPASS"),
        }),
      }),
    ]);
  });
});
