import type {
  BudgetStatus,
  DependencyCheck,
  ProbeFailureCode,
  SystemStatusResponse,
} from "@sf/contracts";

import type { SystemStatusResult } from "@/lib/api.server";

/**
 * Pure formatters of `/system`: everything the page prints that is not a
 * field copied as is. Kept apart from the components so the wording of an
 * outage is tested without rendering one.
 */

/**
 * A budget ratio as a percentage with one decimal. Rounded to a tenth rather
 * than to a whole number, so a cap at 99.6% does not read as a full one, and
 * a ratio short of 1 never rounds up to "100.0%" - 99.96% prints as 99.9%,
 * because a full cap is what the operator stops at. A ratio past 1 stays past
 * 100% - an overrun is shown, not clamped.
 */
export function formatPercent(ratio: number): string {
  const tenths = Math.round(ratio * 1000);
  const shown = ratio < 1 ? Math.min(tenths, 999) : tenths;
  return `${(shown / 10).toFixed(1)}%`;
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

const UNITS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** An amount of a cap in the measure it is counted in. */
export function formatAmount(
  value: number,
  measure: BudgetStatus["measure"],
): string {
  switch (measure) {
    case "usd":
      return USD.format(value);
    case "units":
      return `${UNITS.format(value)} units`;
  }
}

/** Whose "today" or "this month" a cap is counted in. */
export function formatPeriod(budget: BudgetStatus): string {
  const period = budget.period === "day" ? "today" : "this month";
  return `${period} in ${budget.timeZone}`;
}

/**
 * How far ahead of this clock a heartbeat may be stamped and still count as
 * fresh. The worker and web read different clocks; a stamp a second ahead is
 * ordinary drift between two synced machines, not a reason to raise alarm.
 */
const CLOCK_SKEW_TOLERANCE_MS = 2_000;

/**
 * How long ago the worker left its heartbeat, against `now` given by the
 * caller. A missing stamp is "never" - the key expires on its own, so the
 * worker is gone or never came up; an unreadable one is "unknown" rather than
 * a number nobody can trust.
 */
export function formatHeartbeatAge(
  heartbeatAt: string | null,
  now: Date,
): string {
  if (heartbeatAt === null) {
    return "never";
  }
  const at = Date.parse(heartbeatAt);
  if (Number.isNaN(at)) {
    return "unknown";
  }
  const ageMs = now.getTime() - at;
  if (ageMs < -CLOCK_SKEW_TOLERANCE_MS) {
    // A stamp well ahead of this clock says nothing about whether the worker
    // is alive; "just now" would make a dead one look fresh.
    return `${Math.ceil(-ageMs / 1000)} s in the future, clocks disagree`;
  }
  const seconds = Math.floor(Math.max(ageMs, 0) / 1000);
  if (seconds < 1) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds} s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  return `${Math.floor(minutes / 60)} h ago`;
}

/**
 * Why the API gave no status, in the words the operator acts on: the kind of
 * failure and, when the API answered at all, the request id to look up in its
 * log. Never the message of the error - it can name hosts (docs/DECISIONS.md,
 * 10.10.2026).
 */
export function formatApiFailure(
  result: Exclude<SystemStatusResult, { kind: "ok" }>,
): string {
  switch (result.kind) {
    case "unreachable":
      return "no connection to the api";
    case "api-failed":
      return `api error ${result.status} ${result.code}, request id ${result.requestId}`;
    case "contract":
      return result.requestId === undefined
        ? "answer outside the contract"
        : `answer outside the contract, request id ${result.requestId}`;
  }
}

/** What a failed probe means for the operator, one per code. */
export function formatFailureReason(reason: ProbeFailureCode): string {
  switch (reason) {
    case "timeout":
      return "timed out";
    case "unreachable":
      return "unreachable";
    case "error":
      return "error, see the api log";
  }
}

/**
 * The line a section shows instead of its data. Never a zero: "the queue is
 * empty" and "Redis did not answer" have to read differently
 * (docs/DECISIONS.md, 13.09.2026).
 */
function formatNoData(
  dependency: "db" | "redis",
  check: DependencyCheck,
): string {
  if (check.reason === null) {
    return "no data";
  }
  return `no data: ${dependency} ${formatFailureReason(check.reason)}`;
}

/** The line every section shows while the API itself did not answer. */
const API_UNAVAILABLE = "no data: api unavailable";

/** A section of the page: its data, or the line it shows instead. */
export type SectionState<T> =
  | { kind: "data"; data: T }
  | { kind: "no-data"; label: string };

/**
 * One section out of the result of `/system/status`, with the dependency it
 * is read from: the queues, the DLQ and the heartbeat live in Redis, the
 * budget in Postgres (`apps/api/src/routes/system/index.ts`).
 */
export function sectionState<T>(
  result: SystemStatusResult,
  pick: (status: SystemStatusResponse) => T | null,
  dependency: "db" | "redis",
): SectionState<T> {
  if (result.kind !== "ok") {
    return { kind: "no-data", label: API_UNAVAILABLE };
  }
  const data = pick(result.data);
  if (data === null) {
    return {
      kind: "no-data",
      label: formatNoData(dependency, result.data.checks[dependency]),
    };
  }
  return { kind: "data", data };
}

/** Uptime of the api process, to the minute past the first one. */
export function formatUptime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ${minutes % 60} min`;
  }
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}
