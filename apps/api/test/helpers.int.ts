import { env } from "@sf/config";
import type { Redis } from "ioredis";
import { createRedis } from "../src/lib/redis.js";
import { apiTestRedisUrl, assertApiTestStack } from "./local-stack-guard.js";

/**
 * Shared setup for the integration tests of the api.
 *
 * Everything this suite does to the stack is destructive - rows deleted from
 * `api_usage_log`, a spend fixture written into it, the heartbeat key
 * overwritten, a queue paused - so the stack is checked before anything else
 * in this module runs, and it is checked here because every integration file
 * of this app opens its connections through it. A `.env.test` naming a
 * development database, or a host reached through a tunnel, is refused rather
 * than obeyed (`local-stack-guard.ts`).
 */
assertApiTestStack(env.DATABASE_URL, env.REDIS_URL);

/** Connection for an integration file of the api; the caller closes it. */
export function openTestRedis(): Redis {
  return createRedis(apiTestRedisUrl(env.REDIS_URL));
}
