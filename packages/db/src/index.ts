/**
 * Public surface of `@sf/db`: re-exports only. Importing this module has no
 * side effects - no connection, no environment parsing (D3).
 *
 * Only what a consumer outside the package imports. The migration runner and
 * the seed are not here: their callers are the entry points of `src/cli/`
 * and the test support of this package, which take them from `src/`; the
 * first consumer outside (a migration command of the api, E13) brings the
 * re-export back with a test of its own (E0-12B, Р5).
 */
export {
  type BudgetCache,
  type BudgetCheck,
  type BudgetGuard,
  type BudgetGuardOptions,
  type BudgetLimits,
  type BudgetLogger,
  countBudgetChecks,
  createBudgetGuard,
} from "./budget.js";
export { closeDb, createDb, type Db } from "./client.js";
export { pingDb } from "./health.js";
export {
  createProbeDb,
  ProbeClosedError,
  type ProbeDb,
  type ProbeDbOptions,
  ProbeLimitError,
} from "./probe.js";
export {
  type ApiUsageInsert,
  apiUsageLogRepo,
  type UsageAggregate,
  type UsagePeriodOptions,
  type UsageQuerier,
  type ZonedUsageAggregate,
} from "./repos/api-usage-log.js";
export {
  createUsageLogger,
  type UsageLoggerOptions,
  toUsageRow,
} from "./usage-logger.js";
export { appSettingRepo } from "./repos/app-setting.js";
export * as schema from "./schema/index.js";
