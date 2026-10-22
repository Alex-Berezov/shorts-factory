import { env } from "@sf/config";
import { buildLoggerOptions } from "@sf/runtime";
import { pino } from "pino";
import { bootstrap } from "../../src/bootstrap.js";
import { relaySignals } from "./relay-signal.js";

/**
 * The bootstrap of the worker with a start that fails and a connection whose
 * close never ends, run as a child process: the stop the failed start begins
 * lasts until its deadline, which is the window an operator presses Ctrl+C
 * in. Everything else - the subscription, the logger of the entry point, the
 * texts of the stop, the flush and the exit code - is the production path.
 *
 * The signal is raised in the child (`relaySignals`): a parent cannot
 * deliver one on Windows.
 */
relaySignals();

await bootstrap({
  log: pino(buildLoggerOptions(env)),
  start: async () => {
    throw new Error("the start failed on purpose");
  },
  connections: [{ name: "redis", close: () => new Promise<void>(() => {}) }],
});
