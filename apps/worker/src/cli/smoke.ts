/**
 * `pnpm --filter @sf/worker smoke`: puts one `system.smoke` job on the queue
 * and waits for the running worker to finish it. The acceptance criterion of
 * E0 in one command - the job goes through Redis, runs in the other process
 * and leaves a row in `api_usage_log`.
 *
 * This process does not run the job itself: the point is to prove that the
 * worker does. Everything that decides the verdict and the exit code lives in
 * `smoke-run.ts`; here are only the connections and the stop, which is the
 * stop of every process (`createShutdownHandler`,
 * docs/adr/0012-shared-runtime-package.md): the stages in order under one
 * deadline, the log flushed before the exit.
 */

import { env } from "@sf/config";
import {
  type QueueFactory,
  buildLoggerOptions,
  createQueueRedis,
  createShutdownHandler,
  redisStage,
  stageOf,
  subscribeToSignals,
} from "@sf/runtime";
import { QueueEvents } from "bullmq";
import type { Redis } from "ioredis";
import { pino } from "pino";
import { systemSmokeJob } from "../jobs/system-smoke.js";
import { createJobQueueFactory } from "../lib/job-policy.js";
import { runSmoke, runSmokeCommand } from "./smoke-run.js";

/**
 * The connections get this long to go away; the verdict is already out. A
 * stop that does not finish in time leaves with 1, whatever the verdict was
 * (docs/DECISIONS.md, Р6 E0-12R): the line of the verdict is above it.
 */
const CLOSE_DEADLINE_MS = 5_000;

const log = pino(buildLoggerOptions(env));

// Opened by the run, after the subscription; the stages read them when the
// stop runs, and one never opened is said to be so.
let redis: Redis | undefined;
let eventsConnection: Redis | undefined;
let queues: QueueFactory | undefined;
let events: QueueEvents | undefined;

const shutdown = createShutdownHandler({
  // The event stream first, then the queues, then the clients they run on: a
  // client torn down under a `Queue` still closing leaves it without a socket.
  plan: [
    stageOf(
      "events",
      () => events,
      (opened) => opened.close(),
    ),
    stageOf(
      "queues",
      () => queues,
      (opened) => opened.close(),
    ),
    redisStage(() => redis),
    redisStage(() => eventsConnection),
  ],
  log,
  startedMessage: "shutdown started",
  // Nothing in flight here loses an attempt: a second Ctrl+C is told about.
  repeatedSigint: "log",
  timeoutMs: CLOSE_DEADLINE_MS,
});

await runSmokeCommand({
  subscribe: subscribeToSignals,
  shutdown,
  log,
  run: (interrupted, onVerdict) => {
    // Reported, not swallowed: a Redis that refuses the connection is the
    // most likely reason this command has nothing to say, and the client
    // keeps the commands queued instead of failing them (see
    // `createQueueRedis`). The logger is the whole wiring - the same one the
    // worker entry point gets, rather than a second copy of it that forgets
    // the reconnect.
    const client = createQueueRedis(env.REDIS_URL, { log });
    redis = client;
    // Its own connection: `QueueEvents` blocks on the stream, and a blocked
    // client could not add the job below.
    eventsConnection = createQueueRedis(env.REDIS_URL, { log });
    const factory = createJobQueueFactory(client, log);
    queues = factory;
    const queue = factory.get("system.smoke");
    const stream = new QueueEvents("system.smoke", {
      connection: eventsConnection,
    });
    events = stream;
    return runSmoke({
      events: stream,
      queue,
      enqueue: () =>
        systemSmokeJob.enqueue(queue, { requestedAtMs: Date.now() }),
      log,
      interrupted,
      onVerdict,
    });
  },
});
