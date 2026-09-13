import {
  BudgetExceededError,
  type QueueName,
  type UsageLogger,
} from "@sf/core";
import type { BudgetGuard, Db } from "@sf/db";
import { type JobsOptions, UnrecoverableError } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { ZodError, type ZodType } from "zod";
import { DEFAULT_JOB_OPTIONS } from "./job-policy.js";

/**
 * The connections, the logger and the two things a priced job needs, passed in
 * by the runtime rather than imported: a job that opened its own connection
 * would outlive the shutdown that is supposed to close everything.
 *
 * `budget` is one guard for the whole process - it caches, and a guard per job
 * would multiply the round trips the cache exists to avoid. `createUsage`, by
 * contrast, is a factory: the row a job writes has to carry that job's id, so
 * the logger is built per run, in `process`, from the id the job came with.
 */
export interface JobRuntimeDeps {
  log: Logger;
  db: Db;
  redis: Redis;
  budget: BudgetGuard;
  /** The usage logger for one run; the id is stamped onto every row it writes. */
  createUsage(jobId?: string): UsageLogger;
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

/**
 * What a handler is given besides its payload.
 *
 * `createUsage` is gone from it on purpose: the handler gets the logger of its
 * own run (`usage`), already stamped with the job id, so there is no way to
 * write a spend row that belongs to nothing.
 */
export interface JobContext extends Omit<JobRuntimeDeps, "createUsage"> {
  job: ProcessableJob;
  /** Where a priced call reports what it cost, before the call returns. */
  usage: UsageLogger;
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

      const { createUsage, ...rest } = deps;
      const ctx: JobContext = {
        ...rest,
        job,
        log,
        usage: createUsage(job.id),
      };

      try {
        await spec.handler(payload, ctx);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          // A cap is not a transient failure: every retry would ask the same
          // guard the same question and be refused again, five times over
          // twenty minutes, while the queue behind it waits. BullMQ stops
          // retrying only for `UnrecoverableError`, so the refusal is
          // translated into one - with the code and the provider in the
          // message, which is what the DLQ record (`failedReason`) and the
          // operator reading it get to see. The original is kept as `cause`.
          const provider = err.details.provider;
          log.error(
            { err, provider, spent: err.details.spent, cap: err.details.cap },
            "job refused by the budget guard",
          );
          const refusal = new UnrecoverableError(
            `${err.code}: ${provider} ${err.message}`,
          );
          // The bullmq error takes a message and nothing else, so the original
          // is attached afterwards: `cause` is what keeps the details of the
          // refusal - provider, spent, cap - reachable for anything that
          // handles the failure in this process.
          refusal.cause = err;
          throw refusal;
        }
        throw err;
      }
    },
  };
}
