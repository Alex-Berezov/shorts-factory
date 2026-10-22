import { type ShutdownHandler, settleWithin } from "@sf/runtime";
import type { Logger } from "pino";

/**
 * What `pnpm --filter @sf/worker smoke` decides: the run (`runSmoke`) puts
 * one job on `system.smoke` and waits for the worker in the other process to
 * finish it; the command around it (`runSmokeCommand`) turns the verdict, a
 * failure of the run or a signal into the lines and the exit code the stop of
 * the process is asked for.
 *
 * Kept apart from `smoke.ts`, which only opens the connections and builds the
 * stop, so that all of it - "it timed out", "and here is why", "stopped by
 * Ctrl+C" - can be tested without a Redis to hang against.
 */

/** How long the worker is given before the run is called a failure. */
const SMOKE_DEADLINE_MS = 30_000;
/** Backstop for the event stream: the state is also polled this often. */
const SMOKE_POLL_INTERVAL_MS = 500;
/** How long the verdict waits for Redis to say whether the queue is paused. */
const SMOKE_PROBE_MS = 1_000;
/** The reason of a run the stop of the process cut short. */
const SMOKE_INTERRUPTED = "interrupted by a signal";

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
  /**
   * Aborted when the process is being stopped under the run. The run then
   * answers at once, and what fails after that - the connections the stop is
   * closing - is written at `debug`: it is the stop, not a fault of Redis.
   */
  interrupted?: AbortSignal;
  /**
   * Told the verdict the moment it is reached, before the promise of the run
   * resolves; see `SmokeCommandOptions.run`.
   */
  onVerdict?: (outcome: SmokeOutcome) => void;
}

/** What the queue answered when it was asked whether it is switched off. */
type SmokeQueueState = boolean | "unreachable";

/**
 * Whether the queue is switched off, when the answer is allowed to be "no
 * idea". `Queue.isPaused()` is a command like any other and goes through
 * BullMQ's `waitUntilReady`, which resolves on `ready` or on `end` - and a
 * client that reconnects forever reaches neither. Asked without a deadline of
 * its own, this is where the whole command used to hang: the timer had already
 * fired, and its handler waited for the same dead Redis.
 */
async function probeQueueState(
  queue: SmokeQueue,
  timeoutMs: number,
): Promise<SmokeQueueState> {
  const asked = (): Promise<SmokeQueueState> =>
    queue
      .isPaused()
      .catch((): SmokeQueueState => "unreachable")
      .then((state): SmokeQueueState => state);
  // Live: the verdict of the run waits for this answer, and nothing else
  // holds the loop of the command while it does.
  return await settleWithin<SmokeQueueState, SmokeQueueState>(
    asked,
    timeoutMs,
    "unreachable",
    { unref: false },
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
function smokeTimeoutReason(
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
 * asks afterwards is bounded too, and that is the point: the connection this
 * runs on has an offline queue and no request retry limit (BullMQ's
 * requirement, `createQueueRedis`), so with the stack down both
 * `waitUntilReady` and the `add` wait for a socket that never comes.
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
  // Set as soon as the run is decided, which is earlier than `settled` once
  // the deadline fires: from then on the verdict only waits for the reason
  // (`probeQueueState`, up to `probeMs`). In that second nothing is put on
  // the queue, nothing is written as news, and the job gives no verdict
  // (`finishByJob`); the verdict is the deadline's, or a signal's.
  let over = false;
  let finish: (outcome: SmokeOutcome) => void = () => {};
  const verdict = new Promise<SmokeOutcome>((resolve) => {
    finish = (outcome: SmokeOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      over = true;
      // Before the promise resolves: the command around the run has to know
      // the verdict is in before a signal can reach it (`runSmokeCommand`).
      options.onVerdict?.(outcome);
      resolve(outcome);
    };
  });
  /**
   * What the job says - its events, the polled state - decides the run only
   * while it is not over: a job that completes while the deadline waits for
   * its reason would turn a run that missed its deadline into a pass.
   */
  const finishByJob = (outcome: SmokeOutcome): void => {
    if (!over) {
      finish(outcome);
    }
  };

  const interrupted = options.interrupted;
  const stopping = (): boolean => interrupted?.aborted === true;
  const onInterrupt = (): void => {
    finish({ ok: false, reason: SMOKE_INTERRUPTED });
  };
  if (stopping()) {
    onInterrupt();
  }
  interrupted?.addEventListener("abort", onInterrupt, { once: true });

  const deadline = setTimeout(() => {
    over = true;
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
    // A run that is already over - a signal, or the deadline, the moment it
    // fires and not only once its reason is in - ends here: nothing is put on
    // the queue after it, or a worker would do the job of a check that is
    // over.
    if (over) {
      return;
    }
    const jobId = await options.enqueue();
    // The run may have ended while the job was being added: "waiting" after
    // it would contradict the line that ends the run.
    if (over) {
      return;
    }
    options.log.info({ jobId }, "smoke job enqueued, waiting for a worker");

    options.events.on("completed", ({ jobId: id }) => {
      if (id === jobId) {
        finishByJob({ ok: true });
      }
    });
    options.events.on("failed", ({ jobId: id, failedReason }) => {
      if (id === jobId) {
        finishByJob({ ok: false, reason: failedReason ?? "the job failed" });
      }
    });

    // Armed in the same turn as the check above, so before any verdict:
    // `clearInterval` below, once the verdict is in, finds it.
    poll = setInterval(() => {
      void (async () => {
        const job = await options.queue.getJob(jobId);
        const state = await job?.getState();
        if (state === "completed") {
          finishByJob({ ok: true });
        } else if (state === "failed") {
          finishByJob({
            ok: false,
            reason: job?.failedReason ?? "the job failed",
          });
        }
      })().catch((err: unknown) => {
        // A run that is over has its reason; a read that failed after it is
        // no news about the stack.
        if (over || stopping()) {
          options.log.debug({ err }, "could not read the job state");
          return;
        }
        options.log.warn({ err }, "could not read the job state");
      });
    }, pollIntervalMs);
  })().catch((err: unknown) => {
    // After the run is over - a signal, the deadline - a refusal changes
    // nothing, and as an error it would read as the reason of a run already
    // decided.
    if (over || stopping()) {
      options.log.debug({ err }, "the smoke job could not be enqueued");
      return;
    }
    options.log.error({ err }, "the smoke job could not be enqueued");
    finish({ ok: false, reason: "the smoke job could not be enqueued" });
  });

  const outcome = await verdict;
  interrupted?.removeEventListener("abort", onInterrupt);
  clearTimeout(deadline);
  if (poll !== undefined) {
    clearInterval(poll);
  }
  return outcome;
}

/** What the command around the run is made of; see `runSmokeCommand`. */
export interface SmokeCommandOptions {
  /** Hands SIGINT and SIGTERM of the process to the handler. */
  subscribe(handler: (signal: string) => void): void;
  /** The stop of the process, which closes what `run` opened and exits. */
  shutdown: ShutdownHandler;
  /**
   * Opens the connections and runs the check (`runSmoke`); `interrupted` is
   * aborted by a signal before the verdict (`SmokeRunOptions.interrupted`),
   * and `onVerdict` is told the verdict the moment it is reached
   * (`SmokeRunOptions.onVerdict`): a signal between that and the end of the
   * `await` on the run is a signal after the verdict, not before it.
   */
  run(
    interrupted: AbortSignal,
    onVerdict: (outcome: SmokeOutcome) => void,
  ): Promise<SmokeOutcome>;
  log: Logger;
}

/**
 * The command around `runSmoke`: the stop subscribed to the signals before
 * anything is opened (docs/adr/0012-shared-runtime-package.md), the verdict
 * written before anything is closed, and the stop asked for with what the
 * exit code has to say.
 *
 * The code is 0 only for a verdict that came and said the job went through
 * (docs/DECISIONS.md, Р6 E0-12R): a run that threw, a job that did not
 * complete, and a Ctrl+C or a SIGTERM before the verdict - nothing was
 * proven - all leave with 1. A signal after a verdict that passed changes
 * nothing of it.
 *
 * A signal before the verdict is one line - the check was interrupted - and
 * the stop it starts: the run is told (`interrupted`), and what fails in it
 * while its connections are closed under it is not written as a failure of
 * the stack, nor is a verdict that comes after that.
 *
 * The verdict goes before the stop because closing talks to the same Redis
 * the run may have just failed to reach, and `quit` on a client with an
 * offline queue waits for a socket that never comes: with the order the other
 * way round a dead stack swallowed both the reason and the exit code.
 */
export async function runSmokeCommand(
  options: SmokeCommandOptions,
): Promise<void> {
  let outcome: SmokeOutcome | undefined;
  // Set once the run has ended either way - at the verdict itself when the
  // run reports it (`onVerdict`), or when it returns or throws: a signal
  // after that - during the stop of "smoke done" - interrupts nothing, and
  // the line it would write would cover the real reason above it.
  let ran = false;
  const failed = (): boolean => outcome?.ok !== true;
  const interruption = new AbortController();
  const onVerdict = (verdict: SmokeOutcome): void => {
    // A verdict after a signal is the run answering the interruption.
    if (ran || interruption.signal.aborted) {
      return;
    }
    outcome = verdict;
    ran = true;
  };
  options.subscribe((signal) => {
    if (!ran && !interruption.signal.aborted) {
      options.log.warn({ signal }, "smoke check interrupted, nothing proven");
      interruption.abort();
    }
    void options.shutdown(signal, { failed: failed() });
  });

  try {
    outcome = await options.run(interruption.signal, onVerdict);
  } catch (err) {
    if (interruption.signal.aborted) {
      options.log.debug({ err }, "smoke run failed");
    } else {
      options.log.error({ err }, "smoke run failed");
    }
  } finally {
    ran = true;
  }
  if (interruption.signal.aborted) {
    // The stop of the signal is on its way and leaves with 1; this run has
    // nothing left to say, and a second stop would only say it is running.
    return;
  }

  if (outcome?.ok === true) {
    options.log.info("smoke job completed");
  } else if (outcome !== undefined) {
    options.log.error({ reason: outcome.reason }, "smoke job did not complete");
  }

  await options.shutdown("smoke done", { failed: failed() });
}
