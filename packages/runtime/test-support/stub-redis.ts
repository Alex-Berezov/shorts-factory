import type { ClosableRedis } from "../src/redis.js";

/**
 * A client a shutdown can be run against without a Redis: it answers a QUIT,
 * or refuses it with `refusal`, and records how it was asked to go away - the
 * one stub of `closeRedis` and `redisStage` in the tests of this package.
 */
export function stubClient(
  status: string,
  refusal?: Error,
): ClosableRedis & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    status,
    quit: async () => {
      calls.push("quit");
      if (refusal !== undefined) {
        throw refusal;
      }
      return "OK";
    },
    disconnect: () => {
      calls.push("disconnect");
    },
  };
}
