import type { SystemStatusResponse } from "@sf/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SystemStatusResult } from "@/lib/api.server";

// The page is an async server component: it is awaited as a function and
// its tree rendered to markup. `AutoRefresh` needs the router of a running
// app, so it is replaced by a marker - what is checked is that the page
// mounts it. The interval is not 15 s here, so a caption that prints a
// literal instead of the constant reads differently.
const api = vi.hoisted(() => ({
  result: { kind: "unreachable" } as SystemStatusResult,
}));
vi.mock("@/lib/api.server", () => ({
  loadSystemStatus: async () => api.result,
}));
vi.mock("@/app/system/auto-refresh", () => ({
  AutoRefresh: () => createElement("i", { "data-auto-refresh": "" }),
}));
vi.mock("@/lib/auto-refresh", () => ({ REFRESH_INTERVAL_MS: 7_000 }));

const page = await import("@/app/system/page");

const NOW = new Date("2026-10-10T12:00:00.000Z");

/** Every section readable, with each badge the operator acts on raised. */
const HEALTHY: SystemStatusResponse = {
  build: { version: "1.4.0", commit: "abc1234" },
  uptimeSec: 3_700,
  checks: {
    db: { status: "up", reason: null },
    redis: { status: "up", reason: null },
  },
  queues: [
    {
      name: "radar.sync-channels",
      waiting: 4,
      active: 1,
      failed: 0,
      delayed: 2,
      paused: true,
    },
    {
      name: "radar.snapshot",
      waiting: 0,
      active: 0,
      failed: 3,
      delayed: 0,
      paused: false,
    },
  ],
  dlq: { size: 5 },
  worker: { heartbeatAt: "2026-10-10T11:59:30.000Z", stale: false },
  budget: [
    {
      key: "youtube_data_units_day",
      measure: "units",
      period: "day",
      timeZone: "America/Los_Angeles",
      spent: 1_234,
      cap: 10_000,
      ratio: 0.1234,
      warn: false,
      exceeded: false,
    },
    {
      key: "gemini_usd_day",
      measure: "usd",
      period: "day",
      timeZone: "UTC",
      spent: 4.5,
      cap: 5,
      ratio: 0.9,
      warn: true,
      exceeded: false,
    },
    {
      key: "tts_usd_month",
      measure: "usd",
      period: "month",
      timeZone: "UTC",
      spent: 31,
      cap: 30,
      ratio: 1.0333,
      warn: true,
      exceeded: true,
    },
  ],
};

async function render(): Promise<string> {
  return renderToStaticMarkup(await page.default());
}

/** Text of every badge on the page, with the variant it is drawn in. */
function badges(html: string): string[] {
  const found = html.matchAll(
    /<span class="[^"]*rounded-full[^"]*bg-(\w+)[^"]*">([^<]*)<\/span>/g,
  );
  return [...found].map(([, variant, text]) => `${variant}:${text}`);
}

/** What the operator reads: the markup without tags, spaces collapsed. */
function text(html: string): string {
  return html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function count(html: string, phrase: string): number {
  return text(html).split(phrase).length - 1;
}

describe("/system page", () => {
  beforeEach(() => {
    api.result = { kind: "unreachable" };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mounts the auto refresh", async () => {
    expect(await render()).toContain("data-auto-refresh");
  });

  it("prints the interval the refresh runs on", async () => {
    expect(await render()).toContain("refreshes every 7 s");
  });

  it("renders on every request", () => {
    expect(page.dynamic).toBe("force-dynamic");
  });

  it("draws an outage of the api instead of failing", async () => {
    const html = await render();
    expect(html).toContain("no connection to the api");
    expect(html).toContain("no data: api unavailable");
  });

  describe("with every section readable", () => {
    beforeEach(() => {
      api.result = { kind: "ok", data: HEALTHY };
    });

    it("raises the badge of each state the operator acts on", async () => {
      expect(badges(await render())).toEqual([
        "secondary:answering",
        "secondary:up",
        "secondary:up",
        "secondary:alive",
        "warning:needs a look",
        "warning:paused",
        "warning:warn",
        "destructive:exceeded",
      ]);
    });

    it("dates the heartbeat against the time of the request", async () => {
      expect(text(await render())).toContain(
        "last beat 30 s ago (2026-10-10T11:59:30.000Z)",
      );
    });

    it("prints the dead letter count", async () => {
      expect(await render()).toContain(">5</p>");
    });

    it("prints each queue with its counters", async () => {
      const shown = text(await render());
      expect(shown).toContain("radar.sync-channels 4 1 0 2 paused");
      expect(shown).toContain("radar.snapshot 0 0 3 0");
      expect(shown).not.toContain("no data");
    });

    it("prints what was spent against each cap", async () => {
      const shown = text(await render());
      expect(shown).toContain(
        "youtube_data_units_day today in America/Los_Angeles 1,234 units / 10,000 units 12.3%",
      );
      expect(shown).toContain(
        "gemini_usd_day today in UTC $4.50 / $5.00 90.0% warn",
      );
      expect(shown).toContain(
        "tts_usd_month this month in UTC $31.00 / $30.00 103.3% exceeded",
      );
    });
  });

  it("draws a stale worker in red", async () => {
    api.result = {
      kind: "ok",
      data: {
        ...HEALTHY,
        worker: { heartbeatAt: "2026-10-10T11:50:00.000Z", stale: true },
      },
    };
    const html = await render();
    expect(badges(html)).toContain("destructive:stale");
    expect(badges(html)).not.toContain("secondary:alive");
    expect(text(html)).toContain("last beat 10 min ago");
  });

  it("says a worker that never beat has never beaten", async () => {
    api.result = {
      kind: "ok",
      data: { ...HEALTHY, worker: { heartbeatAt: null, stale: true } },
    };
    const shown = text(await render());
    expect(shown).toContain("last beat never");
    expect(shown).not.toContain("last beat never (");
  });

  it("draws empty lists as data, not as a missing section", async () => {
    api.result = {
      kind: "ok",
      data: { ...HEALTHY, queues: [], budget: [], dlq: { size: 0 } },
    };
    const html = await render();
    const shown = text(html);
    expect(shown).not.toContain("no data");
    expect(shown).toContain("Queue Waiting Active Failed Delayed State");
    expect(shown).toContain("Cap Period Spent / cap Used State");
    expect(html).toContain(">0</p>");
    expect(badges(html)).toEqual([
      "secondary:answering",
      "secondary:up",
      "secondary:up",
      "secondary:alive",
    ]);
  });

  it("blames redis for the sections read from it", async () => {
    api.result = {
      kind: "ok",
      data: {
        ...HEALTHY,
        checks: {
          db: { status: "up", reason: null },
          redis: { status: "down", reason: "timeout" },
        },
        queues: null,
        dlq: null,
        worker: null,
      },
    };
    const html = await render();
    // Worker, DLQ and queues; the budget lives in Postgres and is readable.
    expect(count(html, "no data: redis timed out")).toBe(3);
    expect(html).toContain("tts_usd_month");
  });

  it("blames postgres for the budget", async () => {
    api.result = {
      kind: "ok",
      data: {
        ...HEALTHY,
        checks: {
          db: { status: "down", reason: "unreachable" },
          redis: { status: "up", reason: null },
        },
        budget: null,
      },
    };
    const html = await render();
    expect(count(html, "no data: db unreachable")).toBe(1);
    expect(html).not.toContain("no data: redis");
    expect(badges(html)).toContain("secondary:alive");
  });
});
