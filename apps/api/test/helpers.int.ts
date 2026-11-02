import { env } from "@sf/config";
import { type ProbeDb, createProbeDb } from "@sf/db";
import { testDatabaseUrl } from "@sf/db/test-support/fixture";
import type { Relay } from "@sf/db/test-support/relay";
import { suiteRedisUrl } from "@sf/db/test-support/stack-guard";
import {
  type QueueFactory,
  createQueueFactory,
  createRequestRedis,
} from "@sf/runtime";
import { silentLogger } from "@sf/runtime/test-support/recording-logger";
import { within } from "@sf/runtime/test-support/within";
import type { Redis } from "ioredis";
import {
  DEPENDENCY_TIMEOUT_MS,
  PROBE_DB_BOUNDS,
} from "../src/lib/dependency-timeout.js";

/**
 * `keepDatabase` is the `prepare` of every file of this suite: the suite does
 * not reset the database - every file cleans the rows it writes, by its own
 * job id.
 */
export { keepDatabase, useTestDb } from "@sf/db/test-support/fixture";

/**
 * Shared setup for the integration tests of the api.
 *
 * Everything this suite does to the stack is destructive - rows deleted from
 * `api_usage_log`, a spend fixture written into it, the heartbeat key
 * overwritten, a queue paused - so the stack is checked before the first file
 * of the run, by the entry check the preset gives this run
 * (`entryCheck: "migrated-stack"` in `vitest.int.config.ts`): both URLs of
 * `.env.test`, then that `@sf/db`'s integration run has migrated the
 * database (this suite does not migrate it). A file that forgets this module
 * is still behind it. The connections are opened here all the same -
 * `useTestDb` and `openTestRedis` check their URL once more - so that a
 * file written by copying another inherits the guard, not a way around it.
 *
 * The Redis database is the api's own (`suiteRedisUrl(…, "api")`): this suite
 * pauses a queue to prove the page can tell a paused queue from an idle one,
 * and that pause must not reach the queues the worker suite takes jobs from.
 * Postgres stays shared (one migrated schema), and the two suites keep apart
 * there by provider: the worker spends `gemini`, this one `youtube_data`.
 */

/**
 * A bounded database handle of the kind the api reads through
 * (`compose-app.ts`), on the test database - or on a relay in front of it,
 * whose address is derived from the same guarded URL (`openRelay`). The
 * caller closes it.
 */
export function openTestProbeDb(relay?: Relay): ProbeDb {
  return createProbeDb(relay?.url ?? testDatabaseUrl().href, PROBE_DB_BOUNDS);
}

/** Connection for an integration file of the api; the caller closes it. */
export function openTestRedis(): Redis {
  return createRequestRedis(suiteRedisUrl(env.REDIS_URL, "api"), {
    commandTimeoutMs: DEPENDENCY_TIMEOUT_MS,
  });
}

/**
 * Queues for a fixture to act on, opened the way the api itself opens them:
 * by the reader factory of `@sf/runtime`, so that opening one writes nothing
 * into `bull:<name>:meta` - the write the page is forbidden (ADR-0003) - and
 * the options of a queue are the ones the page reads with, not a copy of
 * them. The caller closes the factory; the connection stays the caller's.
 */
export function openTestQueues(connection: Redis): QueueFactory {
  return createQueueFactory({
    connection,
    log: silentLogger(),
    readOnly: true,
  });
}

/**
 * How long a test client gets to reach `ready` on the local stack. Exported
 * for the bounds that follow this one: the case that tells a refusal apart
 * from this wait, and the cases that sum the waits they make on a client.
 */
export const READY_TIMEOUT_MS = 5_000;

/** The part of an ioredis client `whenReady` reads: its status and two events. */
interface ReadyingClient {
  readonly status: string;
  once(event: "ready", listener: () => void): unknown;
  once(event: "error", listener: (err: Error) => void): unknown;
  off(event: "ready", listener: () => void): unknown;
  off(event: "error", listener: (err: Error) => void): unknown;
}

/**
 * Resolves once the client has a usable socket. A client with the offline
 * queue disabled refuses a command sent while it is still connecting, so a
 * case that needs a live command waits here first. A client that fails to
 * connect is an error with its reason, and one that never answers fails
 * after `READY_TIMEOUT_MS` - not a "Test timed out" that names nothing.
 */
export async function whenReady(redis: ReadyingClient): Promise<void> {
  if (redis.status === "ready") {
    return;
  }
  let finish = (): void => undefined;
  let answered = false;
  const ready = new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      answered = true;
      finish();
      resolve();
    };
    const onError = (err: Error): void => {
      answered = true;
      finish();
      reject(
        new Error(`the test Redis client failed to connect: ${err.message}`, {
          cause: err,
        }),
      );
    };
    finish = (): void => {
      redis.off("ready", onReady);
      redis.off("error", onError);
    };
    redis.once("ready", onReady);
    redis.once("error", onError);
  });
  try {
    await within(ready, READY_TIMEOUT_MS, "the test Redis client to be ready");
  } catch (err) {
    if (answered || !(err instanceof Error)) {
      throw err;
    }
    // The status once the wait ran out, not when it began: what the client
    // was doing at the deadline is what explains it.
    throw new Error(`${err.message} (status ${redis.status})`, { cause: err });
  } finally {
    finish();
  }
}
