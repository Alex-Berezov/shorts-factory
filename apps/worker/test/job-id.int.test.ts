import { jobIds } from "@sf/core";
import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeRedis } from "../src/lib/redis.js";
import { obliterateQueues, openTestRedis } from "./helpers.int.js";

/**
 * The id format is held by a unit test in `@sf/core`, but the rules it obeys
 * are BullMQ's (`Job.addJob -> validateOptions`) and they are not written
 * down anywhere we control. This file puts the ids we build in front of the
 * real thing, so that a new builder with a colon in it - or an id that reads
 * as a number - fails here and not in the runtime (docs/TECH_DEBT.md,
 * 07.09.2026).
 */
const QUEUES = ["system.smoke"] as const;

const redis = openTestRedis();
let queue: Queue;

beforeAll(async () => {
  await obliterateQueues(redis, QUEUES);
  queue = new Queue("system.smoke", { connection: redis });
});

afterAll(async () => {
  await queue.close();
  await obliterateQueues(redis, QUEUES);
  await closeRedis(redis);
});

describe("job ids against BullMQ", () => {
  it("accepts the ids the builders produce", async () => {
    await expect(
      queue.add("probe", {}, { jobId: jobIds.radarScore("abc123", "24h") }),
    ).resolves.toBeDefined();
    await expect(
      queue.add("probe", {}, { jobId: jobIds.systemSmoke(1_773_000_000_000) }),
    ).resolves.toBeDefined();
  });

  it("accepts a dlq record id built from a scheduler id", async () => {
    // The ids BullMQ gives its own scheduled jobs look like
    // `repeat:<schedulerId>:<millis>`, and the encoding is what makes them
    // legal inside another id.
    const id = jobIds.dlqEntry(
      "system.heartbeat",
      "repeat:system.heartbeat:1773000000000",
      1_773_000_000_001,
    );

    await expect(queue.add("probe", {}, { jobId: id })).resolves.toBeDefined();
  });

  it("is refused an id of digits alone", async () => {
    // The rule `jobId()` enforces, from the other side: this is what would
    // happen at runtime if a builder ever produced one.
    await expect(queue.add("probe", {}, { jobId: "42" })).rejects.toThrow(
      /Custom Id cannot be integers/,
    );
  });

  it("is refused a raw id that carries colons", async () => {
    await expect(
      queue.add("probe", {}, { jobId: "dlq:system.heartbeat:repeat:1:2" }),
    ).rejects.toThrow(/Custom Id cannot contain :/);
  });
});
