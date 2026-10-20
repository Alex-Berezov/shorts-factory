import { env, rejectedBuildLabels } from "@sf/config";
import { buildLoggerOptions } from "@sf/runtime";
import { pino } from "pino";
import { composeApp, composeOrFail } from "./compose-app.js";

/**
 * REST API entry point: reads the configuration, builds the logger before
 * anything that can fail asynchronously, and owns the socket.
 * The connections and the application are assembled in `compose-app.ts`.
 * Which modules exist is not listed here - the registry in
 * `src/routes/index.ts` is the map, and a copy of it in this docblock would be
 * a guide that stops being true the first time someone adds a module to the
 * registry alone.
 */
const log = pino(buildLoggerOptions(env));

// The signals are subscribed by `composeApp`, before it opens anything.
const composed = composeOrFail(
  () => composeApp(env, { log, rejectedBuildLabels }),
  log,
  () => {
    // Nothing was opened, so nothing holds the loop: the process leaves
    // once the line is out, with this code.
    process.exitCode = 1;
  },
);

if (composed !== undefined) {
  const { app, shutdown } = composed;

  // A port that is taken is a start that failed: the connections are already
  // open, and they are closed by the same stop as on a signal, with the exit
  // code of a failure.
  app.listen({ port: env.API_PORT, host: "0.0.0.0" }).catch((err: unknown) => {
    log.error({ err }, "failed to start the api");
    void shutdown("listen failure", { failed: true });
  });
}
