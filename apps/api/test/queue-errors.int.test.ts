import { env } from "@sf/config";
import { QUEUE_NAMES } from "@sf/core";
import { suiteRedisUrl } from "@sf/db/test-support/stack-guard";
import { createQueueFactory, createRequestRedis } from "@sf/runtime";
import { recordingLogger } from "@sf/runtime/test-support/recording-logger";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEPENDENCY_TIMEOUT_MS } from "../src/lib/dependency-timeout.js";

/** How many refusals of the client the log holds so far. */
function refusalsIn(lines: readonly { msg?: unknown }[]): number {
  return lines.filter((line) => line.msg === "redis client error").length;
}

/** How long the verdict on the `init()` of one queue may take. */
const VERDICT_DEADLINE_MS = 5_000;

/**
 * Waits for the verdict on the `init()` of `queue`, whichever it is, or fails
 * naming the queue that gave none - rather than the whole case timing out.
 */
async function verdictOn(queue: {
  readonly name: string;
  waitUntilReady(): Promise<unknown>;
}): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `no verdict on the init() of queue ${queue.name} within ${VERDICT_DEADLINE_MS} ms`,
        ),
      );
    }, VERDICT_DEADLINE_MS);
  });
  try {
    await Promise.race([
      queue.waitUntilReady().then(
        () => undefined,
        () => undefined,
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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
      const queues = QUEUE_NAMES.map((name) => factory.get(name));

      // The verdict on the `init()` of every queue: refused with the first
      // refusal of the client. From here on the factory learns that verdict
      // within microtasks of an error, so a `queue error` line for a refusal
      // is written before the turn of the loop that brought the refusal ends
      // - no window of the factory to wait out.
      await Promise.all(queues.map(verdictOn));
      const settled = refusalsIn(lines);

      // Two refusals after the verdicts, each heard by every queue.
      await vi.waitFor(
        () => {
          expect(refusalsIn(lines)).toBeGreaterThanOrEqual(settled + 2);
        },
        { timeout: 10_000, interval: 50 },
      );
      await new Promise((resolve) => setImmediate(resolve));
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
    // Read after the close as well: what the queues write while they close
    // counts too.
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
