import { env, rejectedBuildLabels } from "@sf/config";
import { pino } from "pino";
import { composeApp } from "./compose-app.js";
import { buildLoggerOptions } from "./lib/logger.js";

/**
 * REST API entry point: reads the configuration, builds the logger before
 * anything that can fail asynchronously, and owns the socket and the signals.
 * The connections and the application are assembled in `compose-app.ts`.
 * Which modules exist is not listed here - the registry in
 * `src/routes/index.ts` is the map, and a copy of it in this docblock would be
 * a guide that stops being true the first time someone adds a module to the
 * registry alone.
 */
const log = pino(buildLoggerOptions(env));

const { app, shutdown } = composeApp(env, {
  log,
  rejectedBuildLabels: rejectedBuildLabels(),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

app.listen({ port: env.API_PORT, host: "0.0.0.0" }).catch((err: unknown) => {
  app.log.error({ err }, "failed to start the api");
  process.exit(1);
});
