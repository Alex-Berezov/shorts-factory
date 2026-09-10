import {
  QUEUE_NAMES,
  QUEUE_SWITCHES_KEY,
  type QueueName,
  type QueueSwitches,
  QueueSwitchesSchema,
  isQueueName,
} from "@sf/core";
import { type Db, appSettingRepo } from "@sf/db";
import type { Logger } from "pino";

/**
 * `app_setting.queues.enabled` in the runtime (decision of 10.09.2026).
 *
 * `false` means the BullMQ queue is paused: jobs keep arriving and waiting,
 * nobody picks them up, and the state is visible in Redis as `paused` -
 * the same state `/system/queues` shows and toggles in E13-02 and the quota
 * autopause of E1-08 sets. Not creating a `Worker` would mean the same thing
 * invisibly and only until the next restart; refusing to enqueue would throw
 * events away, which for `radar.*` is a hole in the data.
 *
 * The setting is re-read on a timer, so a switch takes effect within a minute
 * without restarting anything. The other side of that: a pause made by hand
 * (`queue.pause()` from a script, from the api) is undone by the next tick.
 * Whoever wants a queue paused writes it here - this module is the only place
 * that calls `pause()`/`resume()`.
 */

/** How often the setting is re-read; a switch takes effect within one tick. */
export const QUEUE_SWITCH_SYNC_INTERVAL_MS = 60_000;

/** The row is missing or unreadable - the worker cannot know what to run. */
export class QueueSwitchesUnavailableError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "QueueSwitchesUnavailableError";
  }
}

/** The part of `Queue` the switches use. */
export interface PausableQueue {
  isPaused(): Promise<boolean>;
  pause(): Promise<void>;
  resume(): Promise<void>;
}

export interface QueueSwitchDeps {
  db: Db;
  log: Logger;
  getQueue(name: QueueName): PausableQueue;
  /**
   * Keys already complained about. A disagreement between the registry and
   * the setting does not fix itself between two ticks, so without this the
   * same warning is written once a minute per queue - a deploy that added
   * three queues and forgot `pnpm db:seed` writes thousands of lines a day,
   * and the first real error is somewhere in the middle of them. Shared by
   * the start and the resync so that the start says it once.
   */
  warned?: Set<string>;
}

/** Warns about this key unless the same key has been warned about before. */
function warnOnce(
  deps: QueueSwitchDeps,
  key: string,
  obj: object,
  msg: string,
): void {
  if (deps.warned?.has(key) === true) {
    return;
  }
  deps.warned?.add(key);
  deps.log.warn(obj, msg);
}

/**
 * The switches as stored, or an error naming the fix.
 *
 * A missing row is not "everything enabled": the seed writes one switch per
 * queue, so an absent row means the database was never seeded, and guessing
 * would start a worker that runs jobs an operator may have turned off.
 */
export async function readQueueSwitches(db: Db): Promise<QueueSwitches> {
  const raw = await appSettingRepo.get(db, QUEUE_SWITCHES_KEY);
  if (raw === undefined) {
    throw new QueueSwitchesUnavailableError(
      `app_setting."${QUEUE_SWITCHES_KEY}" is missing; run "pnpm db:seed" before starting the worker`,
    );
  }

  const parsed = QueueSwitchesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new QueueSwitchesUnavailableError(
      `app_setting."${QUEUE_SWITCHES_KEY}" is not a map of queue name to boolean`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export interface QueueSwitchResult {
  paused: QueueName[];
  resumed: QueueName[];
}

/**
 * Makes the queues match the setting, and touches nothing else.
 *
 * Three kinds of disagreement, three different answers:
 * - a key that is not a queue any more (renamed, dropped): a `warn` and
 *   nothing else. The seed removes such keys; the worker refusing to start
 *   over a leftover would turn a cosmetic problem into an outage;
 * - a queue with no key at all (the registry grew and the database has not
 *   been seeded since): a `warn`, and the queue is left in whatever state it
 *   is in. Defaulting to "enabled" would silently override a pause;
 * - a queue whose state already matches: nothing at all, so that a tick every
 *   minute is not a `RENAME` on every queue every minute.
 */
export async function applyQueueSwitches(
  deps: QueueSwitchDeps,
): Promise<QueueSwitchResult> {
  const switches = await readQueueSwitches(deps.db);

  for (const key of Object.keys(switches)) {
    if (!isQueueName(key)) {
      warnOnce(
        deps,
        `unknown:${key}`,
        { key, setting: QUEUE_SWITCHES_KEY },
        "queue switch for a name that is not in the registry; ignored - run pnpm db:seed to drop it",
      );
    }
  }

  const wanted: { name: QueueName; enabled: boolean; queue: PausableQueue }[] =
    [];
  for (const name of QUEUE_NAMES) {
    const enabled = switches[name];
    if (enabled === undefined) {
      warnOnce(
        deps,
        `missing:${name}`,
        { queue: name, setting: QUEUE_SWITCHES_KEY },
        "no switch for this queue; leaving its state as it is - run pnpm db:seed",
      );
      continue;
    }
    wanted.push({ name, enabled, queue: deps.getQueue(name) });
  }

  // The reads go together: they are independent per queue, and one round trip
  // each would be twenty-nine of them every minute for a question that is
  // almost always answered "nothing to do". The writes stay one at a time -
  // there are at most a few of them, and a pause is worth its own log line in
  // the order it happened.
  const states = await Promise.all(
    wanted.map(async (entry) => ({
      ...entry,
      paused: await entry.queue.isPaused(),
    })),
  );

  const result: QueueSwitchResult = { paused: [], resumed: [] };
  for (const { name, enabled, queue, paused } of states) {
    if (enabled && paused) {
      await queue.resume();
      result.resumed.push(name);
      deps.log.info({ queue: name }, "queue resumed by its switch");
    } else if (!enabled && !paused) {
      await queue.pause();
      result.paused.push(name);
      deps.log.info({ queue: name }, "queue paused by its switch");
    }
  }

  return result;
}

export interface QueueSwitchSyncOptions extends QueueSwitchDeps {
  intervalMs?: number;
}

/**
 * Re-applies the setting every minute; returns the stop function.
 *
 * The timer lives here and not inside the `system.heartbeat` job on purpose:
 * a job is subject to the very switch it would be re-reading, so turning
 * `system.heartbeat` off would stop the resync and make every switch
 * unrecoverable without a restart.
 *
 * A tick that cannot read the setting logs and changes nothing: a database
 * that is briefly unreachable must not pause or resume anything, and the next
 * tick will find out what the truth is.
 */
export function startQueueSwitchSync(
  options: QueueSwitchSyncOptions,
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? QUEUE_SWITCH_SYNC_INTERVAL_MS;
  const deps: QueueSwitchDeps = {
    ...options,
    warned: options.warned ?? new Set(),
  };
  let inFlight: Promise<void> | undefined;

  const tick = (): void => {
    // A tick slower than the interval (a loaded database) must not overlap
    // with the next one: two passes would fight over the same `pause()`.
    if (inFlight !== undefined) {
      return;
    }
    const pass = applyQueueSwitches(deps)
      .then(() => {})
      .catch((err: unknown) => {
        options.log.error(
          { err, setting: QUEUE_SWITCHES_KEY },
          "could not re-read the queue switches; queue states left as they are",
        );
      })
      .finally(() => {
        inFlight = undefined;
      });
    inFlight = pass;
  };

  const timer = setInterval(tick, intervalMs);
  // The shutdown clears this timer; `unref` is the second line of defence, so
  // that a forgotten stop cannot keep the process alive on its own.
  timer.unref();

  /**
   * Stops the resync and waits for the tick that is already running.
   *
   * Awaited rather than fire-and-forget: a tick holds a queue, asks the
   * factory for the next one and pauses or resumes it. Returning before it is
   * done lets it open a `Queue` on a factory that has just been closed - a
   * connection nobody will close, on a process that is trying to exit.
   */
  return async (): Promise<void> => {
    clearInterval(timer);
    await inFlight;
  };
}
