import { QUEUE_NAMES, type QueueName } from "@sf/core";
import type { Logger } from "pino";
import { HEARTBEAT_INTERVAL_MIN } from "./jobs/system-heartbeat.js";

/**
 * Cron registry: the repeatable jobs this worker declares, and the sync that
 * makes Redis agree with the declaration.
 *
 * BullMQ keeps a Job Scheduler in Redis until someone removes it, so a
 * schedule deleted from this file would otherwise keep firing from a machine
 * that has been redeployed - a job whose code no longer exists, failing every
 * minute forever. The declaration here is the source of truth; the sync adds
 * what is missing and removes what is no longer declared.
 */
export interface ScheduleDeclaration {
  queue: QueueName;
  /** Scheduler id, unique within its queue; also the name of its key. */
  id: string;
  /** Cron pattern, in the timezone of the process. */
  pattern: string;
}

/** Every repeatable job of the system. E0 declares one. */
export const SCHEDULES: readonly ScheduleDeclaration[] = [
  {
    queue: "system.heartbeat",
    id: "system.heartbeat",
    pattern: `*/${HEARTBEAT_INTERVAL_MIN} * * * *`,
  },
];

/**
 * The part of `Queue` the sync uses. No custom `jobId` is given to the
 * template: BullMQ derives the id of each occurrence itself
 * (`repeat:<schedulerId>:<millis>`), and a fixed one would make every tick
 * after the first a duplicate that is silently dropped.
 */
export interface SchedulableQueue {
  upsertJobScheduler(
    id: string,
    repeat: { pattern: string },
    template?: { name?: string; data?: unknown },
  ): Promise<unknown>;
  getJobSchedulers(
    start?: number,
    end?: number,
    asc?: boolean,
  ): Promise<{ key: string }[]>;
  removeJobScheduler(id: string): Promise<boolean>;
}

/** How many schedulers are read per round trip. */
const PAGE_SIZE = 100;

/**
 * Every scheduler key of a queue. Paginated because `getJobSchedulers` reads a
 * range: without the loop a queue with more schedulers than one page would
 * keep the ones past the end forever - exactly the case this sync exists for.
 */
async function listSchedulerIds(queue: SchedulableQueue): Promise<string[]> {
  const ids: string[] = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const page = await queue.getJobSchedulers(
      start,
      start + PAGE_SIZE - 1,
      true,
    );
    for (const scheduler of page) {
      ids.push(scheduler.key);
    }
    if (page.length < PAGE_SIZE) {
      return ids;
    }
  }
}

export interface SyncSchedulesOptions {
  /** Opens the queue by name; the whole registry is scanned for strays. */
  getQueue(name: QueueName): SchedulableQueue;
  log: Logger;
  /** Overridable so a test can declare its own; production uses `SCHEDULES`. */
  schedules?: readonly ScheduleDeclaration[];
}

export interface SyncSchedulesResult {
  declared: string[];
  removed: string[];
}

/**
 * Brings the Job Schedulers in Redis to what this file declares.
 *
 * Upserting is idempotent - a schedule that is already there with the same
 * pattern keeps its next run - so the sync can run on every start. The removal
 * pass walks the whole registry rather than the declared queues alone: a
 * schedule that moved from one queue to another leaves its old key behind, and
 * a queue with no declarations at all is exactly where such a leftover hides.
 */
export async function syncSchedules(
  options: SyncSchedulesOptions,
): Promise<SyncSchedulesResult> {
  const schedules = options.schedules ?? SCHEDULES;
  const declared = new Map<QueueName, Set<string>>();
  for (const schedule of schedules) {
    const ids = declared.get(schedule.queue) ?? new Set<string>();
    ids.add(schedule.id);
    declared.set(schedule.queue, ids);
  }

  for (const schedule of schedules) {
    await options
      .getQueue(schedule.queue)
      .upsertJobScheduler(
        schedule.id,
        { pattern: schedule.pattern },
        { name: schedule.queue, data: {} },
      );
  }

  const removed: string[] = [];
  for (const name of QUEUE_NAMES) {
    const queue = options.getQueue(name);
    const known = declared.get(name) ?? new Set<string>();
    for (const id of await listSchedulerIds(queue)) {
      if (known.has(id)) {
        continue;
      }
      await queue.removeJobScheduler(id);
      removed.push(`${name}/${id}`);
      options.log.warn(
        { queue: name, schedulerId: id },
        "removed a job scheduler that is no longer declared",
      );
    }
  }

  const declaredIds = schedules.map(
    (schedule) => `${schedule.queue}/${schedule.id}`,
  );
  options.log.info(
    { declared: declaredIds, removed },
    "job schedulers synchronised",
  );
  return { declared: declaredIds, removed };
}
