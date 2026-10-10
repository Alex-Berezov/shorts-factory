/**
 * Public surface of `@sf/db`: re-exports only. Importing this module has no
 * side effects - no connection, no environment parsing (D3).
 */
export {
  type BudgetCache,
  type BudgetCheck,
  type BudgetGuard,
  type BudgetGuardOptions,
  type BudgetLimits,
  type BudgetLogger,
  createBudgetGuard,
} from "./budget.js";
export { closeDb, createDb, type Db } from "./client.js";
export { pingDb } from "./health.js";
export { runMigrations } from "./migrate.js";
export {
  type ApiUsageInsert,
  apiUsageLogRepo,
  type UsageAggregate,
  type UsagePeriodOptions,
  type UsageQuerier,
} from "./repos/api-usage-log.js";
export {
  createUsageLogger,
  type UsageLoggerOptions,
  toUsageRow,
} from "./usage-logger.js";
export { appSettingRepo } from "./repos/app-setting.js";
export { seedAppSettings } from "./seed.js";
export * as schema from "./schema/index.js";
