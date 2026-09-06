import { readFileSync } from "node:fs";
import { overrideEnvFile } from "../src/env-file.js";
import { testEnvFilePath } from "../src/paths.js";
import { EnvSchema } from "../src/schema.js";
import { assertVitestRun } from "./assert-vitest-run.js";

/**
 * Side-effect module: purges every `EnvSchema` key from `process.env` and
 * loads the fixture; only for vitest `setupFiles`, the `VITEST` gate throws
 * elsewhere.
 */
assertVitestRun(process.env);

const fixtureText = readFileSync(testEnvFilePath, "utf8");
overrideEnvFile(fixtureText, process.env, Object.keys(EnvSchema.shape));
