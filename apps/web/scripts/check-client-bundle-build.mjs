import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { bundleCheckSteps, runBundleCheck } from "./client-bundle.mjs";

/**
 * The whole client bundle check in one command: `next build` with sentinel
 * values in place of every server secret, then the scan of what the build
 * serves to a browser for their names and for those values.
 *
 *   pnpm --filter @sf/web check:bundle
 *
 * What each step gets and how the exit code is chosen live in
 * `bundleCheckSteps` and `runBundleCheck`; this file only runs them.
 *
 * `process.env` is passed through whole to the child build, not read here:
 * `next build` loads its config the usual way, through `@sf/config`.
 */

const steps = bundleCheckSteps({
  appDir: fileURLToPath(new URL("..", import.meta.url)),
  nextBin: createRequire(import.meta.url).resolve("next/dist/bin/next"),
  scanner: fileURLToPath(new URL("./check-client-bundle.mjs", import.meta.url)),
  callerEnv: process.env,
});

process.exit(
  runBundleCheck(
    steps,
    (step) =>
      spawnSync(process.execPath, step.args, {
        cwd: step.cwd,
        env: step.env,
        stdio: "inherit",
      }),
    (message) => process.stderr.write(`${message}\n`),
  ),
);
