/**
 * What every long-running process of the system is made of: the logger
 * options, the Redis clients, the `Queue` factory, the stop and the deadline
 * under all of them (docs/adr/0012-shared-runtime-package.md). Policy stays
 * with the apps - the job options of the worker, the deadline of a request of
 * the api, the order of a stop.
 *
 * Only what an app imports is here. The option types of these functions are
 * reachable through `Parameters<typeof ...>` and stay in their modules until
 * an app has to name one.
 */
export { connectionFailure, errorCode } from "./connection-failure.js";
export { DeadlineError, settleWithin, withDeadline } from "./deadline.js";
export type { RuntimeLogger } from "./runtime-logger.js";
export { LOGGED_DETAILS, buildLoggerOptions } from "./logger.js";
export { type QueueFactory, createQueueFactory } from "./queues.js";
export {
  type ClosableRedis,
  closeRedis,
  createQueueRedis,
  createRequestRedis,
  redisStage,
} from "./redis.js";
export {
  type RepeatedSigint,
  SIGINT_REPEAT_WINDOW_MS,
  type ShutdownHandler,
  type ShutdownStage,
  createShutdownHandler,
  stageOf,
  subscribeToSignals,
} from "./shutdown.js";
