import { unitTestConfig } from "./vitest.preset.js";

/**
 * The test project of the repository itself (`pnpm test:repo`): tests in
 * `test/` at the root, about what belongs to no package - the vitest preset,
 * root scripts, CI. Not named `vitest.config.*`, so that a bare `vitest`
 * started at the root does not pick it up and collect the tests of every
 * package as well; `.mts`, because the root package is CommonJS (its hooks are) and
 * this config is loaded as an ES module.
 */
export default unitTestConfig();
