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

  /**
   * The writer only ever produces `toISOString()`; any other form means
   * something else wrote under the key, and a lenient parse would read junk
   * like "99999" as a worker alive until the year 99999.
   */
  it.each([
    "99999",
    "2026-10-10",
    "Sat Oct 10 2026 12:00:00 GMT+0000",
    "2026-10-10T11:59:30Z",
    "2026-02-30T00:00:00.000Z",
    // `toISOString()` writes these for years outside 0000-9999; the writer
    // never does, and both round-trip, so only the form keeps them out.
    "+275760-09-13T00:00:00.000Z",
    "-000001-01-01T00:00:00.000Z",
    // Parsed by `Date.parse`, but not what `toISOString()` writes.
    "2026-10-10t11:59:30.000z",
    "2026-10-10t11:59:30.000Z",
    "2026-10-09T24:00:00.000Z",
  ])("refuses a stamp not in the writer's ISO form: %s", (stamp) => {
    expect(readHeartbeat(stamp, NOW)).toEqual({
      heartbeatAt: null,
      stale: true,
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
   * The api on the host reads a worker in a container whose clock may drift:
   * drift within the TTL is alive, a stamp further ahead is a jumped clock.
   */
  it.each([5, 6, WORKER_HEARTBEAT_TTL_SEC])(
    "calls a stamp %i s ahead of the clock alive and keeps its time",
    (aheadSec) => {
      const stamp = stampAgo(-aheadSec);

      expect(readHeartbeat(stamp, NOW)).toEqual({
        heartbeatAt: stamp,
        stale: false,
      });
    },
  );

  it.each([WORKER_HEARTBEAT_TTL_SEC + 1, 600])(
    "calls a stamp %i s ahead of the clock stale but keeps its time",
    (aheadSec) => {
      const stamp = stampAgo(-aheadSec);

      expect(readHeartbeat(stamp, NOW)).toEqual({
        heartbeatAt: stamp,
        stale: true,
      });
    },
  );
});
