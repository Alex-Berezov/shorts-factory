import {
  type BudgetStatus,
  ProbeFailureCodeSchema,
  type SystemStatusResponse,
} from "@sf/contracts";
import { describe, expect, it } from "vitest";

import type { SystemStatusResult } from "@/lib/api.server";
import {
  formatAmount,
  formatApiFailure,
  formatFailureReason,
  formatHeartbeatAge,
  formatPercent,
  formatPeriod,
  formatUptime,
  sectionState,
} from "@/lib/format-status";

const NOW = new Date("2026-10-10T12:00:00.000Z");

const STATUS: SystemStatusResponse = {
  build: { version: "0.0.1", commit: "abc1234" },
  uptimeSec: 90,
  checks: {
    db: { status: "down", reason: "unreachable" },
    redis: { status: "up", reason: null },
  },
  queues: [],
  dlq: { size: 3 },
  worker: { heartbeatAt: "2026-10-10T11:59:50.000Z", stale: false },
  budget: null,
};

function budget(overrides: Partial<BudgetStatus>): BudgetStatus {
  return {
    key: "youtube_data_units_day",
    measure: "units",
    period: "day",
    timeZone: "America/Los_Angeles",
    spent: 0,
    cap: 10_000,
    ratio: 0,
    warn: false,
    exceeded: false,
    ...overrides,
  };
}

describe("formatPercent", () => {
  it("prints the ratio as a percentage with one decimal", () => {
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(0.83)).toBe("83.0%");
    expect(formatPercent(0.996)).toBe("99.6%");
  });

  it("keeps an overrun past 100%", () => {
    expect(formatPercent(1.25)).toBe("125.0%");
  });

  it("does not round a cap short of full up to 100%", () => {
    expect(formatPercent(0.9995)).toBe("99.9%");
    expect(formatPercent(0.99999)).toBe("99.9%");
    expect(formatPercent(0.9994)).toBe("99.9%");
    expect(formatPercent(1)).toBe("100.0%");
    expect(formatPercent(1.00001)).toBe("100.0%");
  });
});

describe("formatAmount", () => {
  it("prints dollars with cents and small costs to four places", () => {
    expect(formatAmount(1.5, "usd")).toBe("$1.50");
    expect(formatAmount(0.0042, "usd")).toBe("$0.0042");
  });

  it("prints quota units as a whole number", () => {
    expect(formatAmount(10_000, "units")).toBe("10,000 units");
    expect(formatAmount(0, "units")).toBe("0 units");
  });
});

describe("formatPeriod", () => {
  it("says whose today or month a cap is counted in", () => {
    expect(formatPeriod(budget({}))).toBe("today in America/Los_Angeles");
    expect(formatPeriod(budget({ period: "month", timeZone: "UTC" }))).toBe(
      "this month in UTC",
    );
  });
});

describe("formatHeartbeatAge", () => {
  it("says never when there is no stamp", () => {
    expect(formatHeartbeatAge(null, NOW)).toBe("never");
  });

  it("says unknown for a stamp that does not parse", () => {
    expect(formatHeartbeatAge("not a date", NOW)).toBe("unknown");
  });

  it("measures the age against the given now", () => {
    expect(formatHeartbeatAge("2026-10-10T12:00:00.000Z", NOW)).toBe(
      "just now",
    );
    expect(formatHeartbeatAge("2026-10-10T11:59:59.500Z", NOW)).toBe(
      "just now",
    );
    expect(formatHeartbeatAge("2026-10-10T11:59:48.000Z", NOW)).toBe(
      "12 s ago",
    );
    expect(formatHeartbeatAge("2026-10-10T11:55:00.000Z", NOW)).toBe(
      "5 min ago",
    );
    expect(formatHeartbeatAge("2026-10-10T09:00:00.000Z", NOW)).toBe("3 h ago");
  });
});

describe("formatHeartbeatAge at the edges", () => {
  it("does not call a stamp well ahead of the clock fresh", () => {
    expect(formatHeartbeatAge("2026-10-10T12:00:05.000Z", NOW)).toBe(
      "5 s in the future, clocks disagree",
    );
    expect(formatHeartbeatAge("2026-10-10T12:00:02.001Z", NOW)).toBe(
      "3 s in the future, clocks disagree",
    );
  });

  it("takes a stamp up to two seconds ahead as ordinary clock drift", () => {
    expect(formatHeartbeatAge("2026-10-10T12:00:00.001Z", NOW)).toBe(
      "just now",
    );
    expect(formatHeartbeatAge("2026-10-10T12:00:01.500Z", NOW)).toBe(
      "just now",
    );
    expect(formatHeartbeatAge("2026-10-10T12:00:02.000Z", NOW)).toBe(
      "just now",
    );
  });

  it("switches units exactly at a minute and an hour", () => {
    expect(formatHeartbeatAge("2026-10-10T11:59:59.000Z", NOW)).toBe("1 s ago");
    expect(formatHeartbeatAge("2026-10-10T11:59:01.000Z", NOW)).toBe(
      "59 s ago",
    );
    expect(formatHeartbeatAge("2026-10-10T11:59:00.000Z", NOW)).toBe(
      "1 min ago",
    );
    expect(formatHeartbeatAge("2026-10-10T11:00:01.000Z", NOW)).toBe(
      "59 min ago",
    );
    expect(formatHeartbeatAge("2026-10-10T11:00:00.000Z", NOW)).toBe("1 h ago");
  });
});

describe("formatApiFailure", () => {
  it("says there was no connection, with nothing more to look up", () => {
    expect(formatApiFailure({ kind: "unreachable" })).toBe(
      "no connection to the api",
    );
  });

  it("gives the status, the code and the request id of an api error", () => {
    expect(
      formatApiFailure({
        kind: "api-failed",
        status: 503,
        code: "UNAVAILABLE",
        requestId: "req-7",
      }),
    ).toBe("api error 503 UNAVAILABLE, request id req-7");
  });

  it("gives the request id of an answer off the contract when there is one", () => {
    expect(formatApiFailure({ kind: "contract", requestId: "req-8" })).toBe(
      "answer outside the contract, request id req-8",
    );
    expect(formatApiFailure({ kind: "contract" })).toBe(
      "answer outside the contract",
    );
  });
});

describe("formatFailureReason", () => {
  it("has a distinct line for every probe failure code", () => {
    const lines = ProbeFailureCodeSchema.options.map(formatFailureReason);
    expect(lines).toEqual([
      "timed out",
      "unreachable",
      "error, see the api log",
    ]);
    expect(new Set(lines).size).toBe(ProbeFailureCodeSchema.options.length);
  });
});

describe("formatUptime", () => {
  it("grows from seconds to days", () => {
    expect(formatUptime(42)).toBe("42 s");
    expect(formatUptime(90)).toBe("1 min");
    expect(formatUptime(3 * 3600 + 7 * 60)).toBe("3 h 7 min");
    expect(formatUptime(2 * 86_400 + 5 * 3600)).toBe("2 d 5 h");
  });

  it("switches units exactly at a minute, an hour and a day", () => {
    expect(formatUptime(0)).toBe("0 s");
    expect(formatUptime(59)).toBe("59 s");
    expect(formatUptime(60)).toBe("1 min");
    expect(formatUptime(3599)).toBe("59 min");
    expect(formatUptime(3600)).toBe("1 h 0 min");
    expect(formatUptime(86_399)).toBe("23 h 59 min");
    expect(formatUptime(86_400)).toBe("1 d 0 h");
  });
});

describe("sectionState", () => {
  const ok: SystemStatusResult = { kind: "ok", data: STATUS };

  it("hands over a section that was read, including an empty one", () => {
    expect(sectionState(ok, (s) => s.dlq, "redis")).toEqual({
      kind: "data",
      data: { size: 3 },
    });
    expect(sectionState(ok, (s) => s.queues, "redis")).toEqual({
      kind: "data",
      data: [],
    });
  });

  it("explains a missing section by its dependency, not with a zero", () => {
    expect(sectionState(ok, (s) => s.budget, "db")).toEqual({
      kind: "no-data",
      label: "no data: db unreachable",
    });
  });

  it("names the dependency and why it failed", () => {
    const redisDown: SystemStatusResult = {
      kind: "ok",
      data: {
        ...STATUS,
        checks: {
          ...STATUS.checks,
          redis: { status: "down", reason: "timeout" },
        },
        dlq: null,
      },
    };
    expect(sectionState(redisDown, (s) => s.dlq, "redis")).toEqual({
      kind: "no-data",
      label: "no data: redis timed out",
    });
  });

  it("still says no data when the dependency gives no reason", () => {
    expect(sectionState(ok, (s) => s.budget, "redis")).toEqual({
      kind: "no-data",
      label: "no data",
    });
  });

  it("says the api is unavailable for every kind of failure", () => {
    const failures: SystemStatusResult[] = [
      { kind: "unreachable" },
      { kind: "contract" },
      { kind: "api-failed", status: 500, code: "INTERNAL", requestId: "r" },
    ];
    for (const result of failures) {
      expect(sectionState(result, (s) => s.dlq, "redis")).toEqual({
        kind: "no-data",
        label: "no data: api unavailable",
      });
    }
  });
});
