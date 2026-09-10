import type { QueueName } from "@sf/core";
import type { QueueProcessor } from "../lib/define-job.js";
import { systemHeartbeatJob } from "./system-heartbeat.js";
import { systemSmokeJob } from "./system-smoke.js";

/**
 * Which queues this process actually runs. Partial by design: the registry in
 * `@sf/core` lists every queue the system will have, and a `Worker` is started
 * only for the ones with an entry here.
 *
 * The alternative - a worker per name - would have a queue of a future epic
 * looking healthy while the job it received was quietly discarded by a handler
 * that does not exist yet. A queue with no entry simply accumulates, which is
 * what an operator expects from a feature that is not built.
 *
 * `system.dlq` is deliberately absent: the records there are read by an
 * operator (E13-02), not by a processor.
 *
 * Each epic adds its own line here next to the file it fills in
 * (`src/jobs/*.ts`, currently placeholders).
 */
export const JOB_PROCESSORS: Partial<Record<QueueName, QueueProcessor>> = {
  "system.heartbeat": systemHeartbeatJob,
  "system.smoke": systemSmokeJob,
};

export { systemHeartbeatJob, systemSmokeJob };
