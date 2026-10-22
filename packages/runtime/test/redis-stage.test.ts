import { describe, expect, it } from "vitest";
import { redisStage } from "../src/redis-stage.js";
import { NOT_OPENED } from "../src/shutdown.js";
import { stubClient } from "../test-support/stub-redis.js";

describe("redisStage", () => {
  it("answers nothing of its own after a QUIT", async () => {
    const client = stubClient("ready");

    await expect(redisStage(() => client).close()).resolves.toBeUndefined();
  });

  it("answers a warning with the refusal when the QUIT was refused", async () => {
    // The worker wrote this as `closed`, and the refusal was lost.
    const refusal = new Error("Connection is closed.");
    const client = stubClient("ready", refusal);

    await expect(redisStage(() => client).close()).resolves.toEqual({
      warning: "closed by disconnect",
      err: refusal,
    });
  });

  it("answers a warning without an error for a client that was not connected", async () => {
    const client = stubClient("reconnecting");

    await expect(redisStage(() => client).close()).resolves.toEqual({
      warning: "closed by disconnect",
    });
  });

  it("says there was nothing to close before the client was opened", async () => {
    const stage = redisStage(() => undefined);

    expect(stage.name).toBe("redis");
    await expect(stage.close()).resolves.toBe(NOT_OPENED);
  });
});
