import type { Logger } from "pino";

/**
 * What `pnpm --filter @sf/worker smoke` actually does, without the process
 * around it: put one job on `system.smoke` and wait for the worker in the
 * other process to finish it.
 *
 * Kept apart from `smoke.ts` so that the two answers that matter - "it timed
 * out" and "and here is why" - can be tested without a Redis to hang against.
 */

/** How long the worker is given before the run is called a failure. */
export const SMOKE_DEADLINE_MS = 30_000;
/** Backstop for the event stream: the state is also polled this often. */
export const SMOKE_POLL_INTERVAL_MS = 500;
/** How long the verdict waits for Redis to say whether the queue is paused. */
export const SMOKE_PROBE_MS = 1_000;

export interface SmokeOutcome {
  ok: boolean;
  reason?: string;
}

/** The part of `Queue` the run reads. */
export interface SmokeQueue {
  isPaused(): Promise<boolean>;
  getJob(
    id: string,
  ): Promise<
    | { getState(): Promise<string>; failedReason?: string | undefined }
    | undefined
  >;
}

/** The part of `QueueEvents` the run listens to. */
export interface SmokeEvents {
  /** Resolves with the client it opened; the run only waits for it. */
  waitUntilReady(): Promise<unknown>;
  on(
    event: "completed" | "failed",
    listener: (args: { jobId: string; failedReason?: string }) => void,
  ): unknown;
}

export interface SmokeRunOptions {
  events: SmokeEvents;
  queue: SmokeQueue;
  /** Adds the job and answers with its id. */
  enqueue(): Promise<string>;
  log: Logger;
  deadlineMs?: number;
  pollIntervalMs?: number;
  /** How long the verdict waits for the queue to answer; see `SMOKE_PROBE_MS`. */
  probeMs?: number;
}

/** What the queue answered when it was asked whether it is switched off. */
export type SmokeQueueState = boolean | "unreachable";

/**
 * Runs `work`, but gives up on it after `timeoutMs` and answers `fallback`.
 *
 * Every promise this command holds can be one that never settles: the
 * connection underneath has no request retry limit and an offline queue
 * (BullMQ's requirement, `lib/redis.ts`), so a command issued while Redis is
 * down waits for a socket instead of failing. `Promise.race` with a real timer
 * is the only thing between that and a command with no output and no exit
 * code.
 */
export async function settleWithin<T, F>(
  work: Promise<T>,
  timeoutMs: number,
  fallback: F,
): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the queue is switched off, when the answer is allowed to be "no
 * idea". `Queue.isPaused()` is a command like any other and goes through
 * BullMQ's `waitUntilReady`, which resolves on `ready` or on `end` - and a
 * client that reconnects forever reaches neither. Asked without a deadline of
 * its own, this is where the whole command used to hang: the timer had already
 * fired, and its handler waited for the same dead Redis.
 */
export async function probeQueueState(
  queue: SmokeQueue,
  timeoutMs: number,
): Promise<SmokeQueueState> {
  const asked = queue
    .isPaused()
    .catch((): SmokeQueueState => "unreachable")
    .then((state): SmokeQueueState => state);
  return await settleWithin<SmokeQueueState, SmokeQueueState>(
    asked,
    timeoutMs,
    "unreachable",
  );
}

/**
 * Why nothing happened, in the words of the three things that are actually
 * different: a stack that is not up, a queue nobody is serving, and a queue
 * that is switched off.
 *
 * A paused queue keeps the job in `waiting` (decision of 10.09.2026), so the
 * run failing here does not mean the job is gone - it means it will run
 * whenever an operator switches the queue back on, with the timestamp it was
 * asked for. Sending someone to look for a worker that is running fine is how
 * an hour goes by before anyone looks at the switch.
 */
export function smokeTimeoutReason(
  deadlineMs: number,
  state: SmokeQueueState,
): string {
  const seconds = Math.round(deadlineMs / 1_000);
  if (state === "unreachable") {
    return `no result in ${seconds}s - the "system.smoke" queue could not even be asked: is Redis up (docker compose -f infra/docker-compose.yml up -d)?`;
  }
  return state
    ? `no result in ${seconds}s - the "system.smoke" queue is paused; turn it back on in app_setting "queues.enabled" (the job is waiting and will run then)`
    : `no result in ${seconds}s - is the worker running (pnpm --filter @sf/worker dev)?`;
}

/**
 * Runs the smoke check and answers with a verdict, never with a hang.
 *
 * The deadline is armed before anything is asked of Redis, and everything it
 * asks afterwards is bounded too, and that is the point: the connection this runs on has an offline queue and no request
 * retry limit (BullMQ's requirement, `lib/redis.ts`), so with the stack down
 * both `waitUntilReady` and the `add` wait for a socket that never comes.
 * Inside the promise the timer would only start after them - and the command
 * an operator ran to find out what is wrong would print nothing at all.
 *
 * The event stream is the fast path and the polled state is the truth: a job
 * that finished while this process was starting has no event left to catch.
 */
export async function runSmoke(
  options: SmokeRunOptions,
): Promise<SmokeOutcome> {
  const deadlineMs = options.deadlineMs ?? SMOKE_DEADLINE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? SMOKE_POLL_INTERVAL_MS;
  const probeMs = options.probeMs ?? SMOKE_PROBE_MS;

  let settled = false;
  let finish: (outcome: SmokeOutcome) => void = () => {};
  const verdict = new Promise<SmokeOutcome>((resolve) => {
    finish = (outcome: SmokeOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(outcome);
    };
  });

  const deadline = setTimeout(() => {
    void (async () => {
      // Bounded on purpose: the reason is worth one second of asking, and the
      // verdict has to come out even when nothing answers at all.
      const state = await probeQueueState(options.queue, probeMs);
      finish({ ok: false, reason: smokeTimeoutReason(deadlineMs, state) });
    })();
  }, deadlineMs);

  let poll: ReturnType<typeof setInterval> | undefined;

  void (async () => {
    // Subscribed before the job is added, deliberately: a job that finishes in
    // the milliseconds it takes to attach a listener would emit its event into
    // nothing.
    await options.events.waitUntilReady();
    const jobId = await options.enqueue();
    options.log.info({ jobId }, "smoke job enqueued, waiting for a worker");

    options.events.on("completed", ({ jobId: id }) => {
      if (id === jobId) {
        finish({ ok: true });
      }
    });
    options.events.on("failed", ({ jobId: id, failedReason }) => {
      if (id === jobId) {
        finish({ ok: false, reason: failedReason ?? "the job failed" });
      }
    });

    poll = setInterval(() => {
      void (async () => {
        const job = await options.queue.getJob(jobId);
        const state = await job?.getState();
        if (state === "completed") {
          finish({ ok: true });
        } else if (state === "failed") {
          finish({ ok: false, reason: job?.failedReason ?? "the job failed" });
        }
      })().catch((err: unknown) => {
        options.log.warn({ err }, "could not read the job state");
      });
    }, pollIntervalMs);
  })().catch((err: unknown) => {
    options.log.error({ err }, "the smoke job could not be enqueued");
    finish({ ok: false, reason: "the smoke job could not be enqueued" });
  });

  const outcome = await verdict;
  clearTimeout(deadline);
  if (poll !== undefined) {
    clearInterval(poll);
  }
  return outcome;
}
