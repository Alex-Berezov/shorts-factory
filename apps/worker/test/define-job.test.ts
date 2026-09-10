import { UnrecoverableError } from "bullmq";
import { type Logger, pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type JobRuntimeDeps,
  type ProcessableJob,
  defineJob,
} from "../src/lib/define-job.js";
import { recordingLogger } from "./recording-logger.js";

const PayloadSchema = z.object({ videoId: z.string().min(1) }).strict();

const job = defineJob({
  queue: "intel.analyze-video",
  payloadSchema: PayloadSchema,
  jobIdFrom: (payload) => `intel.analyze/${payload.videoId}`,
  handler: async () => {},
});

/** A queue that records what it was asked to add. */
function fakeQueue() {
  return { add: vi.fn(async () => ({ id: "1" })) };
}

/** The connections a processor is run with; nothing here touches them. */
function deps(log: Logger = pino({ level: "silent" })): JobRuntimeDeps {
  // `db` and `redis` are only carried through to the handler, and the handlers
  // under test never call them.
  return { log, db: {}, redis: {} } as unknown as JobRuntimeDeps;
}

function fakeJob(data: unknown): ProcessableJob {
  return {
    id: "intel.analyze/abc",
    name: "intel.analyze-video",
    data,
    attemptsMade: 0,
    timestamp: 1,
  };
}

describe("defineJob enqueue", () => {
  it("adds the job with the shared retry policy and the derived id", async () => {
    const queue = fakeQueue();

    const id = await job.enqueue(queue, { videoId: "abc" });

    expect(id).toBe("intel.analyze/abc");
    expect(queue.add).toHaveBeenCalledTimes(1);
    // The defaults are the point of the helper: a job added without them
    // retries once and disappears, and nobody notices until production.
    expect(queue.add).toHaveBeenCalledWith(
      "intel.analyze-video",
      { videoId: "abc" },
      {
        attempts: 5,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 1_000 },
        jobId: "intel.analyze/abc",
      },
    );
  });

  it("refuses a payload that does not match the schema, at the caller", async () => {
    const queue = fakeQueue();

    await expect(job.enqueue(queue, { videoId: "" })).rejects.toThrow(
      z.ZodError,
    );
    expect(queue.add).toHaveBeenCalledTimes(0);
  });
});

describe("defineJob process", () => {
  it("hands the parsed payload to the handler", async () => {
    const seen: string[] = [];
    const definition = defineJob({
      queue: "system.smoke",
      payloadSchema: PayloadSchema,
      jobIdFrom: (payload) => `system.smoke/${payload.videoId}`,
      handler: async (payload) => {
        seen.push(payload.videoId);
      },
    });

    await definition.process(fakeJob({ videoId: "abc" }), deps());

    expect(seen).toEqual(["abc"]);
  });

  it("refuses data that no longer matches the schema, without retrying", async () => {
    // The data has been in Redis between attempts and may come from an older
    // version of this code. Five more attempts cannot make it parse, so the
    // job goes to the DLQ now instead of in twenty minutes.
    const handler = vi.fn(async () => {});
    const definition = defineJob({
      queue: "system.smoke",
      payloadSchema: PayloadSchema,
      jobIdFrom: () => "system.smoke/x",
      handler,
    });

    await expect(
      definition.process(fakeJob({ videoId: 42 }), deps()),
    ).rejects.toThrow(UnrecoverableError);
    expect(handler).toHaveBeenCalledTimes(0);
  });
});

describe("defineJob logging", () => {
  it("says where the payload was wrong, never what was in it", async () => {
    // Zod puts the rejected value itself into the issue of a literal, an enum
    // or a union (`received`), and a payload of a later epic carries channel
    // ids, tokens and experiment keys next to the field that failed. The log
    // of this process goes to the container output verbatim.
    const { log, lines } = recordingLogger();
    const strict = defineJob({
      queue: "tts.generate",
      payloadSchema: z.object({ voice: z.literal("alloy") }).strict(),
      jobIdFrom: () => "tts.generate/1",
      handler: async () => {},
    });

    await expect(
      strict.process(fakeJob({ voice: "ya29.a0-secret-token" }), deps(log)),
    ).rejects.toThrow(/payload does not match the schema/);

    const written = JSON.stringify(lines);
    expect(written).not.toContain("ya29.a0-secret-token");
    // What a reader actually needs: which field, and what was wrong with it.
    expect(written).toContain("voice");
    expect(written).toContain("invalid_literal");
  });
});
