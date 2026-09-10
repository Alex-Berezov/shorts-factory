import type { QueueName } from "@sf/core";
import type { Db } from "@sf/db";
import { type JobsOptions, UnrecoverableError } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { ZodError, type ZodType } from "zod";
import { DEFAULT_JOB_OPTIONS } from "./job-policy.js";

/**
 * The connections and the logger a processor is run with. Passed in by the
 * runtime rather than imported: a job that opened its own connection would
 * outlive the shutdown that is supposed to close everything.
 *
 * There is no `usage` here yet - `ctx.usage` and the budget guard arrive with
 * E0-09 and get their own field, not a corner of this one.
 */
export interface JobRuntimeDeps {
  log: Logger;
  db: Db;
  redis: Redis;
}

/**
 * The part of `Job` a processor reads. Structural, and a real BullMQ `Job`
 * satisfies it: a handler needs the id for the usage row and the attempt
 * number for the log, and a test needs to be able to build one. An epic that
 * needs more of the job (progress, children) widens this interface.
 */
export interface ProcessableJob {
  id?: string | undefined;
  name: string;
  data: unknown;
  attemptsMade: number;
  /** When this instance of the id was created, in milliseconds. */
  timestamp: number;
}

/** What a handler is given besides its payload. */
export interface JobContext extends JobRuntimeDeps {
  job: ProcessableJob;
}

/** One priced job: the payload it takes and what it does with it. */
export interface JobSpec<TPayload> {
  queue: QueueName;
  payloadSchema: ZodType<TPayload>;
  /**
   * Deterministic id, always through a builder of `@sf/core` (decision 5):
   * the same payload gives the same id, and BullMQ drops the repeat.
   *
   * A job whose identity is a moment in time rather than its payload - the
   * heartbeat, whose payload is empty - takes its clock as a parameter of the
   * definition instead of reading it here (`jobs/system-heartbeat.ts`), so
   * that "the same tick" is something a caller and a test can pin down.
   */
  jobIdFrom(payload: TPayload): string;
  handler(payload: TPayload, ctx: JobContext): Promise<void>;
  /** Overrides of the shared retry policy; rarely needed. */
  opts?: JobsOptions;
}

/**
 * The part of `Queue` an enqueue uses. Structural so that a unit test can pass
 * a fake and see the options a real queue would have received.
 */
export interface EnqueueTarget {
  add(
    name: string,
    data: unknown,
    opts?: JobsOptions,
  ): Promise<{ id?: string | undefined }>;
}

/**
 * A job as the runtime sees it: which queue it belongs to and how to run one.
 * The payload type is gone on purpose - the registry in `src/jobs/index.ts`
 * holds jobs of different shapes, and a `Job` coming out of Redis carries
 * `unknown` data anyway.
 */
export interface QueueProcessor {
  readonly queue: QueueName;
  process(job: ProcessableJob, deps: JobRuntimeDeps): Promise<void>;
}

/** A job with its payload type still visible, for the code that enqueues it. */
export interface JobDefinition<TPayload> extends QueueProcessor {
  readonly payloadSchema: ZodType<TPayload>;
  /** Validates, derives the id and adds the job; returns the id used. */
  enqueue(queue: EnqueueTarget, payload: TPayload): Promise<string>;
}

/**
 * Everything a job in this repository has in common: a validated payload, a
 * deterministic id, the shared retry policy and a logger that names the job.
 *
 * The payload is validated twice, and that is not a belt-and-braces habit:
 * `enqueue` validates so that a bad call fails at the caller, where the stack
 * still says who made it, and `process` validates because the data it reads
 * has been sitting in Redis between attempts and may have been written by an
 * older version of this code - or by hand. A payload that does not parse in
 * the handler is refused as `UnrecoverableError`: five more attempts cannot
 * make it valid, and the job belongs in the DLQ now rather than in twenty
 * minutes.
 */
export function defineJob<TPayload>(
  spec: JobSpec<TPayload>,
): JobDefinition<TPayload> {
  const options: JobsOptions = { ...DEFAULT_JOB_OPTIONS, ...spec.opts };

  return {
    queue: spec.queue,
    payloadSchema: spec.payloadSchema,

    async enqueue(queue: EnqueueTarget, payload: TPayload): Promise<string> {
      const data = spec.payloadSchema.parse(payload);
      const jobId = spec.jobIdFrom(data);
      await queue.add(spec.queue, data, { ...options, jobId });
      return jobId;
    },

    async process(job: ProcessableJob, deps: JobRuntimeDeps): Promise<void> {
      const log = deps.log.child({
        queue: spec.queue,
        jobId: job.id ?? null,
        attempt: job.attemptsMade + 1,
      });

      let payload: TPayload;
      try {
        payload = spec.payloadSchema.parse(job.data);
      } catch (err) {
        if (err instanceof ZodError) {
          // Where and what, never the value: for `z.literal`, `z.enum` and
          // unions zod puts the rejected value itself into the issue
          // (`received`), and a payload of a future epic carries channel ids
          // and experiment keys next to the field that failed.
          const issues = err.issues.map((issue) => ({
            path: issue.path.join("."),
            code: issue.code,
          }));
          log.error({ issues }, "job payload rejected by its schema");
          throw new UnrecoverableError(
            `${spec.queue}: payload does not match the schema (${err.issues.length} issue(s))`,
          );
        }
        throw err;
      }

      await spec.handler(payload, { ...deps, job, log });
    },
  };
}
