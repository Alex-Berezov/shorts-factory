import { BudgetExceededError } from "@sf/core";
import type { BudgetCheck, BudgetGuard } from "@sf/db";
import { UnrecoverableError } from "bullmq";
import { type Logger, pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type JobRuntimeDeps,
  type ProcessableJob,
  defineJob,
} from "../src/lib/define-job.js";
import { recordingUsage, unusedBudget, unusedConnections } from "./job-deps.js";
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
function deps(
  log: Logger = pino({ level: "silent" }),
  overrides: Partial<JobRuntimeDeps> = {},
): JobRuntimeDeps {
  return {
    log,
    // Carried through to the handler and never called by the handlers here.
    ...unusedConnections(),
    budget: unusedBudget(),
    createUsage: recordingUsage().createUsage,
    ...overrides,
  };
}

/** A budget answer a guard may hand back; the numbers are not the point here. */
const ROOM_LEFT: BudgetCheck = {
  scope: {
    key: "gemini_usd_day",
    measure: "usd",
    period: "day",
    providers: ["gemini"],
    timeZone: "UTC",
  },
  spent: 1,
  cap: 5,
  ratio: 0.2,
  warn: false,
  exceeded: false,
};

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

describe("defineJob context", () => {
  it("gives the handler a usage logger stamped with its own job", async () => {
    // The row a job writes has to carry that job: a spend row that belongs to
    // nothing cannot be traced back to what it paid for.
    const usage = recordingUsage();
    const definition = defineJob({
      queue: "system.smoke",
      payloadSchema: PayloadSchema,
      jobIdFrom: () => "system.smoke/x",
      handler: async (_payload, ctx) => {
        await ctx.usage({ provider: "system", operation: "smoke", units: 0 });
      },
    });

    await definition.process(
      fakeJob({ videoId: "abc" }),
      deps(undefined, { createUsage: usage.createUsage }),
    );

    expect(usage.entries).toEqual([
      {
        jobId: "intel.analyze/abc",
        entry: { provider: "system", operation: "smoke", units: 0 },
      },
    ]);
  });

  /**
   * The fixture holds a job to the same contract the real logger does
   * (`createUsageLogger` parses before it writes). A spend row the database
   * would refuse - here a cost below zero - must fail the test that produced
   * it, not be recorded as if it had been written.
   */
  it("refuses a spend row the real logger would refuse", async () => {
    const usage = recordingUsage();
    const definition = defineJob({
      queue: "intel.analyze-video",
      payloadSchema: PayloadSchema,
      jobIdFrom: () => "intel.analyze/x",
      handler: async (_payload, ctx) => {
        await ctx.usage({
          provider: "gemini",
          operation: "generate",
          costUsd: -1,
        });
      },
    });

    await expect(
      definition.process(
        fakeJob({ videoId: "abc" }),
        deps(undefined, { createUsage: usage.createUsage }),
      ),
    ).rejects.toThrow();
    expect(usage.entries).toEqual([]);
  });

  it("gives the handler the budget guard of the process", async () => {
    const guard: BudgetGuard = {
      check: async () => ROOM_LEFT,
      assert: vi.fn(async () => ROOM_LEFT),
    };
    let asked: BudgetCheck | undefined;
    const definition = defineJob({
      queue: "intel.analyze-video",
      payloadSchema: PayloadSchema,
      jobIdFrom: () => "intel.analyze/x",
      handler: async (_payload, ctx) => {
        asked = await ctx.budget.assert("gemini");
      },
    });

    await definition.process(
      fakeJob({ videoId: "abc" }),
      deps(undefined, { budget: guard }),
    );

    expect(guard.assert).toHaveBeenCalledTimes(1);
    expect(guard.assert).toHaveBeenCalledWith("gemini");
    expect(asked).toBe(ROOM_LEFT);
  });
});

describe("defineJob budget refusal", () => {
  const refusing = defineJob({
    queue: "intel.analyze-video",
    payloadSchema: PayloadSchema,
    jobIdFrom: () => "intel.analyze/x",
    handler: async (_payload, ctx) => {
      await ctx.budget.assert("gemini");
    },
  });

  function overBudget(): BudgetGuard {
    const exceeded = new BudgetExceededError("gemini_usd_day: cap reached", {
      provider: "gemini",
      spent: 6,
      cap: 5,
    });
    return {
      check: async () => ({ ...ROOM_LEFT, spent: 6, exceeded: true }),
      assert: async () => {
        throw exceeded;
      },
    };
  }

  it("turns a cap refusal into a failure that is not retried", async () => {
    // BullMQ stops retrying only for `UnrecoverableError`. Left as it is, a
    // refusal would be retried five times over twenty minutes, asking the same
    // guard the same question - and the queue behind it would wait for it.
    const error = await refusing
      .process(
        fakeJob({ videoId: "abc" }),
        deps(undefined, { budget: overBudget() }),
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UnrecoverableError);
    // What the DLQ record and the operator reading it get to see.
    expect((error as Error).message).toContain("BUDGET_EXCEEDED");
    expect((error as Error).message).toContain("gemini");
    // The refusal itself is kept, so anything handling the failure in this
    // process still has the provider, the spend and the cap.
    expect((error as Error).cause).toBeInstanceOf(BudgetExceededError);
  });

  it("says who refused the job and how far past the cap it is", async () => {
    const { log, lines } = recordingLogger();

    await expect(
      refusing.process(
        fakeJob({ videoId: "abc" }),
        deps(log, { budget: overBudget() }),
      ),
    ).rejects.toThrow(UnrecoverableError);

    const written = JSON.stringify(lines);
    expect(written).toContain("gemini");
    expect(written).toContain("refused by the budget guard");
  });

  it("leaves every other failure to the retry policy", async () => {
    // Only a cap is final: a provider that is down, a socket that dropped -
    // those are exactly what the five attempts exist for.
    const definition = defineJob({
      queue: "intel.analyze-video",
      payloadSchema: PayloadSchema,
      jobIdFrom: () => "intel.analyze/x",
      handler: async () => {
        throw new Error("upstream is unreachable");
      },
    });

    const error = await definition
      .process(fakeJob({ videoId: "abc" }), deps())
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
  });
});
