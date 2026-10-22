import { type ClosableRedis, closeRedis } from "./redis.js";
import { type CloseWarning, type ShutdownStage, stageOf } from "./shutdown.js";

/**
 * The client as a stage of a stop, for every process the same way. A socket
 * torn down instead of a QUIT - the client was not connected, or the QUIT was
 * refused - is still a closed client (`closeRedis`), so it is no failure of
 * the stop; but it is not a QUIT either, and the line of the stop says so,
 * with the refusal when there was one. Without this the worker wrote a
 * refused QUIT as `closed`, and the reason was lost.
 *
 * `client` is read when the stop runs: a stop that comes before the client
 * was opened has nothing to close, and says that instead of `closed`.
 *
 * It is a module of its own on top of `closeRedis` and `stageOf`, so that
 * neither the clients (`redis.ts`) nor the stop (`shutdown.ts`) knows about
 * the other.
 */
export function redisStage(
  client: () => ClosableRedis | undefined,
): ShutdownStage {
  return stageOf(
    "redis",
    client,
    async (opened): Promise<CloseWarning | undefined> => {
      const outcome = await closeRedis(opened);
      if (outcome.kind === "quit") {
        return undefined;
      }
      return outcome.err === undefined
        ? { warning: "closed by disconnect" }
        : { warning: "closed by disconnect", err: outcome.err };
    },
  );
}
