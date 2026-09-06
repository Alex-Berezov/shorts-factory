import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EnvSchema } from "../src/schema.js";
import { assertVitestRun, loadTestEnv } from "./load-test-env.js";

/**
 * Side-effect module: purges every `EnvSchema` key from `process.env` and
 * loads the fixture; only for vitest `setupFiles`, the `VITEST` gate throws
 * elsewhere.
 */
assertVitestRun(process.env);

const envTestPath = fileURLToPath(
  new URL("../../../.env.test", import.meta.url),
);
const fixtureText = readFileSync(envTestPath, "utf8");
loadTestEnv(fixtureText, process.env, Object.keys(EnvSchema.shape));
