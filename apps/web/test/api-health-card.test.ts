import type { SystemStatusResponse } from "@sf/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApiHealthCard } from "@/app/system/_components/api-health-card";
import type { SystemStatusResult } from "@/lib/api.server";
import { formatApiFailure } from "@/lib/format-status";

const STATUS: SystemStatusResponse = {
  build: { version: "1.4.0", commit: "abc1234" },
  uptimeSec: 3_700,
  checks: {
    db: { status: "down", reason: "timeout" },
    redis: { status: "up", reason: null },
  },
  queues: [],
  dlq: { size: 0 },
  worker: { heartbeatAt: null, stale: true },
  budget: null,
};

function render(result: SystemStatusResult): string {
  return renderToStaticMarkup(createElement(ApiHealthCard, { result }));
}

describe("ApiHealthCard", () => {
  it.each<Exclude<SystemStatusResult, { kind: "ok" }>>([
    { kind: "unreachable" },
    {
      kind: "api-failed",
      status: 503,
      code: "dependency_down",
      requestId: "req-42",
    },
    { kind: "contract", requestId: "req-43" },
    { kind: "contract" },
  ])("shows a $kind failure as unavailable, with its kind", (result) => {
    const html = render(result);
    expect(html).toContain("API health");
    expect(html).toContain(">unavailable<");
    expect(html).toContain(formatApiFailure(result));
    expect(html).not.toContain("answering");
  });

  it("prints the code and the request id of an api error", () => {
    const html = render({
      kind: "api-failed",
      status: 503,
      code: "dependency_down",
      requestId: "req-42",
    });
    expect(html).toContain("503");
    expect(html).toContain("dependency_down");
    expect(html).toContain("req-42");
  });

  it("shows an answering api with its build, uptime and dependencies", () => {
    const html = render({ kind: "ok", data: STATUS });
    expect(html).toContain(">answering<");
    expect(html).not.toContain("unavailable");
    expect(html).toContain("version 1.4.0, commit abc1234, up 1 h 1 min");
    expect(html).toMatch(/db<\/span>.*timed out.*>down</);
    expect(html).toMatch(/redis<\/span>.*>up</);
  });

  it("says unknown for a build that does not know its version", () => {
    const html = render({
      kind: "ok",
      data: { ...STATUS, build: { version: null, commit: null } },
    });
    expect(html).toContain("version unknown, commit unknown");
  });
});
