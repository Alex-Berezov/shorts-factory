import type { QueueName } from "@sf/core";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import {
  SCHEDULES,
  type SchedulableQueue,
  syncSchedules,
} from "../src/schedules.js";

const log = pino({ level: "silent" });

/** A queue that already holds `existing` schedulers and records the calls. */
function fakeQueue(existing: string[] = []) {
  const keys = [...existing];
  const upserted: string[] = [];
  const removed: string[] = [];
  const queue: SchedulableQueue & { upserted: string[]; removed: string[] } = {
    upserted,
    removed,
    async upsertJobScheduler(id: string) {
      upserted.push(id);
      if (!keys.includes(id)) {
        keys.push(id);
      }
    },
    async getJobSchedulers(start = 0, end = -1) {
      const last = end === -1 ? keys.length : end + 1;
      return keys.slice(start, last).map((key) => ({ key }));
    },
    async removeJobScheduler(id: string) {
      removed.push(id);
      return true;
    },
  };
  return queue;
}

function factory(
  queues: Partial<Record<QueueName, ReturnType<typeof fakeQueue>>>,
) {
  const store = new Map<QueueName, ReturnType<typeof fakeQueue>>(
    Object.entries(queues) as [QueueName, ReturnType<typeof fakeQueue>][],
  );
  return {
    store,
    getQueue(name: QueueName) {
      const existing = store.get(name);
      if (existing !== undefined) {
        return existing;
      }
      const created = fakeQueue();
      store.set(name, created);
      return created;
    },
  };
}

describe("syncSchedules", () => {
  it("declares the schedules of this worker", async () => {
    const queues = factory({});

    const result = await syncSchedules({ getQueue: queues.getQueue, log });

    expect(result.declared).toEqual(["system.heartbeat/system.heartbeat"]);
    expect(queues.store.get("system.heartbeat")?.upserted).toEqual([
      "system.heartbeat",
    ]);
  });

  it("removes a scheduler that is no longer declared", async () => {
    // A schedule deleted from the file keeps firing from Redis otherwise - a
    // job whose code no longer exists, failing every minute forever.
    const stray = fakeQueue(["radar.snapshot-hourly"]);
    const queues = factory({ "radar.snapshot": stray });

    const result = await syncSchedules({ getQueue: queues.getQueue, log });

    expect(stray.removed).toEqual(["radar.snapshot-hourly"]);
    expect(result.removed).toEqual(["radar.snapshot/radar.snapshot-hourly"]);
  });

  it("leaves a scheduler that is still declared where it is", async () => {
    const heartbeat = fakeQueue(["system.heartbeat"]);
    const queues = factory({ "system.heartbeat": heartbeat });

    await syncSchedules({ getQueue: queues.getQueue, log });

    // Upserting keeps the next run; removing and re-adding would lose it.
    expect(heartbeat.removed).toEqual([]);
    expect(heartbeat.upserted).toEqual(["system.heartbeat"]);
  });

  it("reads past the first page of schedulers", async () => {
    // A queue with more schedulers than one page would keep the ones past the
    // end forever - the exact leftover this sync exists to remove.
    const many = Array.from({ length: 150 }, (_, i) => `stale-${i}`);
    const crowded = fakeQueue(many);
    const queues = factory({ "radar.snapshot": crowded });

    await syncSchedules({ getQueue: queues.getQueue, log });

    expect(crowded.removed).toHaveLength(150);
  });

  it("declares every schedule against a queue of the registry", () => {
    // A schedule pointing at a queue nobody handles fires jobs into a void.
    for (const schedule of SCHEDULES) {
      expect(schedule.pattern).toMatch(/^[\d */,-]+$/);
    }
  });
});
