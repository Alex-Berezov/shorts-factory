import { type QueueName, jobIds } from "@sf/core";
import { type JobsOptions, UnrecoverableError } from "bullmq";
import type { Logger } from "pino";
import type { EnqueueTarget, ProcessableJob } from "./define-job.js";

/**
 * Dead letter queue (decision 4 of E0): a job that has spent its attempts is
 * copied into `system.dlq` and stays there until an operator looks at it
 * (E13-02 shows the records and retries them). The copy is a copy - the
 * original `failed` record stays in its own queue for as long as
 * `removeOnFail` keeps it, so nothing is moved out from under an operator who
 * is already looking at it.
 */

/**
 * The part of `Job` the DLQ reads: what a processor sees, plus what only a
 * failure has. Extended rather than restated, so that a field added to a job
 * arrives here too instead of quietly meaning two different things.
 */
export interface FailedJob extends ProcessableJob {
  opts: { attempts?: number | undefined };
  failedReason?: string | undefined;
  stacktrace?: string[] | null;
}

/** What a DLQ record carries. Fields, not a parsable id: E13-02 reads these. */
export interface DlqRecord {
  queue: QueueName;
  jobId: string | null;
  name: string;
  data: unknown;
  failedReason: string;
  stacktrace: string[];
  attemptsMade: number;
  /** ISO timestamp of the moment the copy was made. */
  failedAt: string;
}

/** `UnrecoverableError` survives a structured clone as a name, not a class. */
function isUnrecoverable(err: unknown): boolean {
  return (
    err instanceof UnrecoverableError ||
    (err instanceof Error && err.name === "UnrecoverableError")
  );
}

/**
 * Whether this failure was the last one. BullMQ emits `failed` after every
 * attempt, so without this check a job that is merely going to be retried
 * would land in the DLQ four times before it even succeeds.
 *
 * Two ways to be final: the attempts are spent, or the handler said the input
 * is beyond repair (`UnrecoverableError` - BullMQ stops retrying at once, so
 * `attemptsMade` is still below the limit and the first check misses it).
 */
export function isFinalFailure(job: FailedJob, err: unknown): boolean {
  if (isUnrecoverable(err)) {
    return true;
  }
  // A job added before `attempts` had a default runs exactly once.
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

/** The record as it is stored, without the queue-side ids. */
export function toDlqRecord(
  queue: QueueName,
  job: FailedJob,
  err: unknown,
  failedAt: Date,
): DlqRecord {
  const reason =
    job.failedReason ?? (err instanceof Error ? err.message : String(err));
  return {
    queue,
    jobId: job.id ?? null,
    name: job.name,
    data: job.data,
    failedReason: reason,
    stacktrace: job.stacktrace ?? [],
    attemptsMade: job.attemptsMade,
    failedAt: failedAt.toISOString(),
  };
}

export interface DlqOptions {
  /** The queue whose failures are being watched. */
  queue: QueueName;
  /** The `system.dlq` queue the copy is added to. */
  dlq: EnqueueTarget;
  log: Logger;
  /** Seam for tests; the clock is the process one in production. */
  now?: () => Date;
}

/**
 * The `failed` listener for one queue.
 *
 * It returns a promise that never rejects, and that is the whole point. The
 * event is asynchronous: an `await queue.add(...)` inside a listener whose
 * rejection nobody catches becomes an unhandled rejection, and Node 22 ends
 * the process over it - together with every job this worker is running. A
 * Redis that is down while a job fails is exactly the moment that happens.
 *
 * `job` is optional in the event signature (BullMQ has the id but not the
 * record when the job has already been evicted); there is nothing to copy
 * then, so it is logged and dropped.
 */
export function createFailedHandler(
  options: DlqOptions,
): (job: FailedJob | undefined, err: unknown) => Promise<void> {
  const now = options.now ?? (() => new Date());

  return async (job: FailedJob | undefined, err: unknown): Promise<void> => {
    if (job === undefined) {
      options.log.error(
        { queue: options.queue, err },
        "job failed and its record is gone; nothing to copy to the dlq",
      );
      return;
    }

    if (!isFinalFailure(job, err)) {
      options.log.warn(
        {
          queue: options.queue,
          jobId: job.id ?? null,
          attemptsMade: job.attemptsMade,
          attempts: job.opts.attempts ?? 1,
          err,
        },
        "job failed, will retry",
      );
      return;
    }

    const record = toDlqRecord(options.queue, job, err, now());

    try {
      const opts: JobsOptions = { attempts: 1, removeOnFail: false };
      if (job.id !== undefined) {
        // Deterministic, so that a second `failed` for the same instance -
        // a worker restarted while the job was dying - leaves one record.
        opts.jobId = jobIds.dlqEntry(options.queue, job.id, job.timestamp);
      }
      await options.dlq.add("system.dlq", record, opts);
      options.log.error(
        { queue: options.queue, jobId: record.jobId, err },
        "job failed for good, copied to the dlq",
      );
    } catch (dlqErr) {
      // The failure of the failure handler. Logged and swallowed: the job is
      // already failed in its own queue, and throwing here would take the
      // process down with the jobs that are still running.
      options.log.error(
        { queue: options.queue, jobId: record.jobId, err: dlqErr },
        "failed to copy a job to the dlq",
      );
    }
  };
}

/**
 * The `failed` listener as the runtime uses it, plus the way to wait for what
 * it started.
 *
 * A listener cannot be awaited: BullMQ emits `failed` and moves on, and
 * `worker.close()` waits for the handlers of jobs, not for the listeners of
 * events. So a job that spends its last attempt as the process is stopping
 * has its copy still travelling to Redis when the shutdown closes the queues
 * and the connection - and the record E13-02 exists to show is lost, silently,
 * because the write is refused into the `catch` above. `drain()` is what the
 * shutdown waits on instead.
 */
export interface DlqWriter {
  /** The listener itself; it never throws and never rejects. */
  onFailed(job: FailedJob | undefined, err: unknown): void;
  /** Resolves once every copy started so far has been written or refused. */
  drain(): Promise<void>;
}

export function createDlqWriter(options: DlqOptions): DlqWriter {
  const handle = createFailedHandler(options);
  const inFlight = new Set<Promise<void>>();

  return {
    onFailed(job: FailedJob | undefined, err: unknown): void {
      const write = handle(job, err);
      inFlight.add(write);
      void write.finally(() => {
        inFlight.delete(write);
      });
    },

    async drain(): Promise<void> {
      // A loop rather than one `Promise.all`: a `failed` event that arrives
      // while the first batch is settling adds to the set behind it.
      while (inFlight.size > 0) {
        await Promise.all([...inFlight]);
      }
    },
  };
}
