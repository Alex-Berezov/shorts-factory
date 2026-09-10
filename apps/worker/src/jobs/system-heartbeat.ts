import {
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_SEC,
  intervalSlot,
  jobIds,
} from "@sf/core";
import { z } from "zod";
import { type JobDefinition, defineJob } from "../lib/define-job.js";

/**
 * Liveness stamp of the worker: an ISO timestamp in Redis with a TTL of three
 * ticks, read by `/system/status` (E0-09) and by the container healthcheck
 * (E0-11). The TTL is what makes it an answer rather than a leftover - a
 * worker that died leaves a key that expires on its own, so "the stamp is
 * missing" and "the worker is down" are the same thing.
 *
 * Fired by the scheduler declared in `src/schedules.ts`, once a minute.
 */
export const HEARTBEAT_INTERVAL_MIN = 1;

const HeartbeatPayloadSchema = z.object({}).strict();
type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>;

/**
 * The job with its clock in the open.
 *
 * This job carries no payload - the scheduler fires it, and there is nothing
 * to say - so the minute it belongs to is the only thing its id can be made
 * of, and that minute comes from a clock. Reading `new Date()` inside
 * `jobIdFrom` would put that clock out of reach: two calls a millisecond apart
 * across a minute boundary would give two ids for the same tick, and no test
 * could tell the difference from a bug. The clock is therefore part of the
 * definition, injected here, defaulted to the process one below.
 */
export function createSystemHeartbeatJob(
  now: () => Date = () => new Date(),
): JobDefinition<HeartbeatPayload> {
  return defineJob({
    queue: "system.heartbeat",
    payloadSchema: HeartbeatPayloadSchema,
    jobIdFrom: () =>
      jobIds.systemHeartbeat(intervalSlot(now(), HEARTBEAT_INTERVAL_MIN)),
    handler: async (_payload, ctx) => {
      const stamp = now().toISOString();
      await ctx.redis.set(
        WORKER_HEARTBEAT_KEY,
        stamp,
        "EX",
        WORKER_HEARTBEAT_TTL_SEC,
      );
      ctx.log.debug({ stamp }, "heartbeat written");
    },
  });
}

export const systemHeartbeatJob = createSystemHeartbeatJob();
