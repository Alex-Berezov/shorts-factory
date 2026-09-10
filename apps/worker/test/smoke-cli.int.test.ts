import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `pnpm --filter @sf/worker smoke` against a Redis that is not there.
 *
 * The one thing a fake queue cannot reproduce: the client the command really
 * uses keeps retrying forever and queues commands offline (BullMQ's
 * requirement, `src/lib/redis.ts`), so every promise in this path - the
 * `waitUntilReady`, the `add`, the `isPaused` behind the verdict, the `quit`
 * behind the exit - can be one that never settles. This run proves the command
 * still ends by itself, says which of the two things is wrong and leaves with
 * a code a script can read.
 *
 * No Compose needed, and it is in the integration suite anyway: it costs the
 * full deadline of the command, which `pnpm test` should not.
 */
const CLI = fileURLToPath(new URL("../src/cli/smoke.ts", import.meta.url));
/** A port nothing listens on; connecting is refused rather than hanging. */
const DEAD_REDIS = "redis://127.0.0.1:1";
/** The command's own deadline is 30 s, plus the probe and the closing. */
const RUN_TIMEOUT_MS = 90_000;

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

async function runSmokeCli(): Promise<Run> {
  const child = fork(CLI, [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, REDIS_URL: DEAD_REDIS },
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  return await new Promise<Run>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({ code, signal, output });
    });
  });
}

describe("smoke cli against a dead redis", () => {
  it(
    "ends on its own, names the reason and exits non-zero",
    async () => {
      const run = await runSmokeCli();

      // Nothing outside killed it: it decided to stop.
      expect(run.signal).toBeNull();
      expect(run.code).toBe(1);
      expect(run.output).toContain("smoke job did not complete");
      expect(run.output).toContain("could not even be asked");
    },
    RUN_TIMEOUT_MS,
  );
});
