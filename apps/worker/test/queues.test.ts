import { QUEUE_NAMES, isQueueName } from "@sf/core";
import { describe, expect, it } from "vitest";
import { JOB_PROCESSORS } from "../src/jobs/index.js";
import { SCHEDULES } from "../src/schedules.js";

/**
 * The worker has no queue list of its own: names come from the registry in
 * `@sf/core`, which `@sf/db` also seeds into `app_setting.queues.enabled`.
 * The canary used to compare the length of that list with a number the entry
 * point printed, which a name swapped for another passes unnoticed
 * (docs/TECH_DEBT.md, 06.09.2026) - so it compares composition instead.
 */
describe("worker processor registry", () => {
  it("registers every processor under a name of the shared registry", () => {
    for (const [name, processor] of Object.entries(JOB_PROCESSORS)) {
      expect(isQueueName(name)).toBe(true);
      // A processor filed under the wrong key would run jobs of one queue
      // while reporting itself as another - and enqueue into a third.
      expect(processor?.queue).toBe(name);
    }
  });

  it("runs the two operational jobs of E0 and nothing else yet", () => {
    // Every other queue of the registry waits for the epic that fills it in;
    // a worker with no handler would take the job and drop it silently.
    expect(Object.keys(JOB_PROCESSORS).sort()).toEqual([
      "system.heartbeat",
      "system.smoke",
    ]);
  });

  it("leaves system.dlq without a processor", () => {
    // Records there are read by an operator (E13-02), not consumed.
    expect(QUEUE_NAMES).toContain("system.dlq");
    expect(JOB_PROCESSORS["system.dlq"]).toBeUndefined();
  });

  it("schedules only queues this worker can run", () => {
    for (const schedule of SCHEDULES) {
      expect(JOB_PROCESSORS[schedule.queue]?.queue).toBe(schedule.queue);
    }
  });
});
