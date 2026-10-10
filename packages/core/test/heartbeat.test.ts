import { describe, expect, it } from "vitest";
import { readHeartbeat } from "../src/domain/heartbeat.js";
import { WORKER_HEARTBEAT_TTL_SEC } from "../src/domain/redis-keys.js";

/**
 * The one rule both readers of the worker's stamp apply - the status page and
 * the container healthcheck. Every edge below is a case where the two would
 * otherwise be free to disagree.
 */
const NOW = new Date("2026-10-10T12:00:00.000Z");

function stampAgo(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1_000).toISOString();
}

describe("readHeartbeat", () => {
  it("calls a missing stamp stale", () => {
    expect(readHeartbeat(null, NOW)).toEqual({
      heartbeatAt: null,
      stale: true,
    });
  });

  it("calls a stamp that is not a date stale, without echoing it", () => {
    expect(readHeartbeat("not-a-date", NOW)).toEqual({
      heartbeatAt: null,
      stale: true,
    });
  });

  it("calls a fresh stamp alive and reports it as ISO", () => {
    expect(readHeartbeat(stampAgo(30), NOW)).toEqual({
      heartbeatAt: stampAgo(30),
      stale: false,
    });
  });

  it("normalises a stamp written in another valid date format", () => {
    expect(readHeartbeat("2026-10-10T11:59:30Z", NOW)).toEqual({
      heartbeatAt: "2026-10-10T11:59:30.000Z",
      stale: false,
    });
  });

  it("still calls a stamp exactly one TTL old alive", () => {
    expect(readHeartbeat(stampAgo(WORKER_HEARTBEAT_TTL_SEC), NOW).stale).toBe(
      false,
    );
  });

  it("calls a stamp older than the TTL stale but keeps its time", () => {
    const stamp = stampAgo(WORKER_HEARTBEAT_TTL_SEC + 1);

    expect(readHeartbeat(stamp, NOW)).toEqual({
      heartbeatAt: stamp,
      stale: true,
    });
  });

  /**
   * The status page never judged a stamp by how far ahead it is, and the api
   * on the host reads a worker in a container whose clock may drift: a live
   * worker must not turn stale because its clock runs a few minutes fast.
   */
  it.each([5, 6, 600])(
    "calls a stamp %i s ahead of the clock alive and keeps its time",
    (aheadSec) => {
      const stamp = stampAgo(-aheadSec);

      expect(readHeartbeat(stamp, NOW)).toEqual({
        heartbeatAt: stamp,
        stale: false,
      });
    },
  );
});
