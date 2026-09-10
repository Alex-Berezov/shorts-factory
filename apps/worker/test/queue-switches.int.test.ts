import { QUEUE_SWITCHES_KEY, QueueSwitchesSchema } from "@sf/core";
import type { QueueName } from "@sf/core";
import { appSettingRepo, closeDb } from "@sf/db";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type PausableQueue,
  QueueSwitchesUnavailableError,
  applyQueueSwitches,
  readQueueSwitches,
  startQueueSwitchSync,
} from "../src/lib/queue-switches.js";
import { createQueueFactory } from "../src/lib/queues.js";
import { closeRedis } from "../src/lib/redis.js";
import {
  obliterateQueues,
  openTestDb,
  openTestRedis,
  seedQueueSwitches,
} from "./helpers.int.js";

/**
 * What `queues.enabled` means in the runtime (decision of 10.09.2026): the
 * BullMQ queue is paused, which is a state in Redis - the same one E13-02
 * shows and the quota autopause of E1-08 sets. Against a real queue, because
 * "paused" is exactly the part a fake cannot have.
 */
const QUEUES = ["system.smoke", "system.dlq"] as const;

const db = openTestDb();
const redis = openTestRedis();
const queues = createQueueFactory(redis);

/** A logger that keeps its lines, so a warning can be asserted. */
function recordingLogger() {
  const lines: string[] = [];
  const log = pino(
    { level: "warn" },
    {
      write: (line: string) => {
        lines.push(line);
      },
    },
  );
  return { log, lines };
}

beforeAll(async () => {
  await obliterateQueues(redis, QUEUES);
});

beforeEach(async () => {
  await seedQueueSwitches(db);
  await queues.get("system.smoke").resume();
});

afterAll(async () => {
  await queues.close();
  await seedQueueSwitches(db);
  await obliterateQueues(redis, QUEUES);
  await closeDb(db);
  await closeRedis(redis);
});

describe("queue switches", () => {
  it("pauses a queue that is switched off and resumes it when it comes back", async () => {
    const { log } = recordingLogger();
    const smoke = queues.get("system.smoke");
    await seedQueueSwitches(db, { "system.smoke": false });

    const paused = await applyQueueSwitches({
      db,
      log,
      getQueue: (name) => queues.get(name),
    });

    expect(paused.paused).toContain("system.smoke");
    expect(await smoke.isPaused()).toBe(true);

    // Without a restart: the operator writes the setting and the next tick
    // picks it up.
    await seedQueueSwitches(db);
    const resumed = await applyQueueSwitches({
      db,
      log,
      getQueue: (name) => queues.get(name),
    });

    expect(resumed.resumed).toContain("system.smoke");
    expect(await smoke.isPaused()).toBe(false);
  });

  it("leaves a queue whose state already matches alone", async () => {
    // A tick every minute must not be a RENAME on every queue every minute.
    const { log } = recordingLogger();

    const result = await applyQueueSwitches({
      db,
      log,
      getQueue: (name) => queues.get(name),
    });

    expect(result).toEqual({ paused: [], resumed: [] });
  });

  it("warns about a switch of a queue that no longer exists and runs on", async () => {
    // The seed drops such keys; a worker refusing to start over a leftover
    // would turn a cosmetic problem into an outage.
    const { log, lines } = recordingLogger();
    await seedQueueSwitches(db, { "radar.sync": true });

    const result = await applyQueueSwitches({
      db,
      log,
      getQueue: (name) => queues.get(name),
    });

    expect(result).toEqual({ paused: [], resumed: [] });
    expect(lines.join("\n")).toContain("radar.sync");
  });

  it("warns about a queue with no switch instead of assuming it is enabled", async () => {
    const { log, lines } = recordingLogger();
    const stored = QueueSwitchesSchema.parse(
      await appSettingRepo.get(db, QUEUE_SWITCHES_KEY),
    );
    const { "system.smoke": _dropped, ...withoutSmoke } = stored;
    await appSettingRepo.set(db, QUEUE_SWITCHES_KEY, withoutSmoke);

    const result = await applyQueueSwitches({
      db,
      log,
      getQueue: (name) => queues.get(name),
    });

    expect(result).toEqual({ paused: [], resumed: [] });
    expect(lines.join("\n")).toContain("system.smoke");
  });

  it("refuses to start against a database that was never seeded", async () => {
    // "No row" is not "everything enabled": guessing would run jobs the
    // operator may have turned off.
    await db.$client`delete from app_setting where key = ${QUEUE_SWITCHES_KEY}`;

    await expect(readQueueSwitches(db)).rejects.toThrow(
      QueueSwitchesUnavailableError,
    );
    await expect(readQueueSwitches(db)).rejects.toThrow(/db:seed/);
  });

  it("refuses a stored value that is not a map of booleans", async () => {
    await appSettingRepo.set(db, QUEUE_SWITCHES_KEY, {
      "system.smoke": "false",
    });

    await expect(readQueueSwitches(db)).rejects.toThrow(
      QueueSwitchesUnavailableError,
    );
  });
});

describe("queue switch resync", () => {
  it("applies a value that changed while the worker was running", async () => {
    // The whole point of the timer (decision of 10.09.2026): an operator
    // writes the setting and the queue follows without a restart. Every other
    // test calls `applyQueueSwitches` by hand, so a runtime that never starts
    // the timer would leave them all green.
    const { log } = recordingLogger();
    const smoke = queues.get("system.smoke");
    const stop = startQueueSwitchSync({
      db,
      log,
      getQueue: (name) => queues.get(name),
      intervalMs: 100,
    });

    try {
      await seedQueueSwitches(db, { "system.smoke": false });
      await waitForCondition(
        async () => await smoke.isPaused(),
        "the tick to pause the queue",
      );

      await seedQueueSwitches(db);
      await waitForCondition(
        async () => !(await smoke.isPaused()),
        "the tick to resume the queue",
      );
    } finally {
      await stop();
    }
  });

  it("waits for the tick in flight before it lets go", async () => {
    // A tick holds a queue and is about to ask the factory for the next one;
    // the factory is closed a moment later. Returning early lets it open a
    // `Queue` nobody will close, on a process that is trying to exit.
    const { log } = recordingLogger();
    let releaseTick = (): void => {};
    const held = new Promise<void>((resolve) => {
      releaseTick = resolve;
    });
    let asked = 0;
    const slowQueue: PausableQueue = {
      isPaused: async () => {
        asked += 1;
        await held;
        return false;
      },
      pause: async () => {},
      resume: async () => {},
    };

    const stop = startQueueSwitchSync({
      db,
      log,
      getQueue: (_name: QueueName) => slowQueue,
      intervalMs: 20,
    });
    await waitForCondition(async () => asked > 0, "the tick to start");

    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);

    releaseTick();
    await stopping;
    expect(stopped).toBe(true);

    // And no tick after the stop: the interval is gone, not merely ignored.
    const afterStop = asked;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(asked).toBe(afterStop);
  });

  it("reads the queue states in one round, not one at a time", async () => {
    // Twenty-nine independent reads every sixty seconds: sequential they are
    // ~42k round trips a day for a question almost always answered "nothing
    // to do". The writes stay sequential - there are a few of them at most.
    const { log } = recordingLogger();
    let inFlight = 0;
    let peak = 0;
    const countingQueue = {
      isPaused: async (): Promise<boolean> => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return false;
      },
      pause: async () => {},
      resume: async () => {},
    };

    await applyQueueSwitches({
      db,
      log,
      getQueue: (_name: QueueName) => countingQueue,
    });

    expect(peak).toBeGreaterThan(1);
  });

  it("warns about a queue with no switch once, not once a tick", async () => {
    // A disagreement between the registry and the setting does not fix itself
    // between two ticks: repeating the warning every minute per queue buries
    // the first real error under thousands of lines a day.
    const { log, lines } = recordingLogger();
    const stored = QueueSwitchesSchema.parse(
      await appSettingRepo.get(db, QUEUE_SWITCHES_KEY),
    );
    const { "system.smoke": _dropped, ...withoutSmoke } = stored;
    await appSettingRepo.set(db, QUEUE_SWITCHES_KEY, {
      ...withoutSmoke,
      "radar.sync": true,
    });
    const deps = {
      db,
      log,
      getQueue: (name: QueueName) => queues.get(name),
      warned: new Set<string>(),
    };

    await applyQueueSwitches(deps);
    await applyQueueSwitches(deps);
    await applyQueueSwitches(deps);

    expect(lines.filter((line) => line.includes("system.smoke"))).toHaveLength(
      1,
    );
    expect(lines.filter((line) => line.includes("radar.sync"))).toHaveLength(1);
  });

  it("refuses to open a queue after the factory was closed", async () => {
    // Where a late tick would land: the cache is empty by then, so a new
    // `Queue` would be created with listeners nobody is going to close.
    const factory = createQueueFactory(redis);
    factory.get("system.smoke");
    await factory.close();

    expect(() => factory.get("system.smoke")).toThrow(/closed/);
  });
});

/** Polls until the condition holds, or fails the test by throwing. */
async function waitForCondition(
  probe: () => Promise<boolean>,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
