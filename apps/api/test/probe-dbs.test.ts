import { type Db, type ProbeDb, createProbeDb } from "@sf/db";
import { recordingLogger } from "@sf/runtime/test-support/recording-logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROBE_QUERY_LIMIT_MS } from "../src/lib/dependency-timeout.js";
import { DB_CLOSE_TIMEOUT_SEC, openProbeDbs } from "../src/lib/probe-dbs.js";

/**
 * The real factory behind a spy: a case that needs a handle whose close it
 * controls replaces it for one call, every other case opens real handles.
 */
vi.mock("@sf/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sf/db")>();
  return { ...actual, createProbeDb: vi.fn(actual.createProbeDb) };
});

/** Nothing listens on port 1, and no case asks the database anything. */
const CLOSED_DATABASE_URL = "postgres://sf:sf@127.0.0.1:1/shorts_factory_none";

afterEach(async () => {
  const actual = await vi.importActual<typeof import("@sf/db")>("@sf/db");
  vi.mocked(createProbeDb).mockReset().mockImplementation(actual.createProbeDb);
});

/** A handle whose close settles when the case says so. */
function heldHandle(): {
  handle: ProbeDb;
  close: ReturnType<typeof vi.fn>;
  settle: { resolve: () => void; reject: (err: unknown) => void };
} {
  const settle = { resolve: () => {}, reject: (_err: unknown) => {} };
  const closing = new Promise<void>((resolve, reject) => {
    settle.resolve = resolve;
    settle.reject = reject;
  });
  const close = vi.fn(() => closing);
  const handle: ProbeDb = {
    run: async () => {
      throw new Error("no case runs work on a held handle");
    },
    close,
  };
  return { handle, close, settle };
}

describe("openProbeDbs", () => {
  /**
   * A handle per probe: on one connection a read of the budget stuck behind a
   * silent socket would queue the ping of `/health` behind it, and the limit
   * that destroys the one must leave the other alone. The destruction is
   * written - the one line that tells a Postgres gone silent from a slow one.
   */
  it("gives each probe a handle of its own and writes when a limit destroys one", async () => {
    const { log, lines } = recordingLogger();
    const dbs = openProbeDbs(CLOSED_DATABASE_URL, log);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      expect(dbs.health).not.toBe(dbs.budget);
      const budgetClients: Db[] = [];
      await dbs.budget.run(async (db) => {
        budgetClients.push(db);
      });

      const stuck = dbs.health.run(() => new Promise<never>(() => {}));
      stuck.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(PROBE_QUERY_LIMIT_MS);

      expect(lines).toEqual([
        expect.objectContaining({
          level: "warn",
          msg: "database probe connection destroyed at its limit",
          probe: "health",
          limitMs: PROBE_QUERY_LIMIT_MS,
        }),
      ]);
      await dbs.budget.run(async (db) => {
        budgetClients.push(db);
      });
      expect(budgetClients[1]).toBe(budgetClients[0]);
    } finally {
      vi.useRealTimers();
      await dbs.close();
    }
  });

  /**
   * The stop of the `db` stage answers once every handle is closed: a handle
   * whose close fails is the answer, but not before the other one is done -
   * a stop that reported its code at the first failure would leave sockets
   * being torn down behind it.
   */
  it("waits for every handle when the close of the first one fails", async () => {
    const health = heldHandle();
    const budget = heldHandle();
    vi.mocked(createProbeDb)
      .mockReturnValueOnce(health.handle)
      .mockReturnValueOnce(budget.handle);
    const dbs = openProbeDbs(CLOSED_DATABASE_URL, recordingLogger().log);
    let outcome: unknown;
    const closing = dbs.close().then(
      () => "closed",
      (err: unknown) => err,
    );
    void closing.then((value) => {
      outcome = value;
    });

    const failure = new Error("end failed");
    health.settle.reject(failure);
    await new Promise((done) => setImmediate(done));
    expect(outcome).toBeUndefined();

    budget.settle.resolve();
    await expect(closing).resolves.toBe(failure);
    expect(health.close).toHaveBeenCalledTimes(1);
    expect(health.close).toHaveBeenCalledWith({
      timeoutSec: DB_CLOSE_TIMEOUT_SEC,
    });
    expect(budget.close).toHaveBeenCalledTimes(1);
    expect(budget.close).toHaveBeenCalledWith({
      timeoutSec: DB_CLOSE_TIMEOUT_SEC,
    });
  });

  /**
   * The stop answers with the first failure; the second one would be lost
   * behind it, so only the others are written, with the probe they belong to.
   */
  it("writes the failures of close beyond the first and answers with the first", async () => {
    const health = heldHandle();
    const budget = heldHandle();
    vi.mocked(createProbeDb)
      .mockReturnValueOnce(health.handle)
      .mockReturnValueOnce(budget.handle);
    const { log, lines } = recordingLogger();
    const dbs = openProbeDbs(CLOSED_DATABASE_URL, log);
    const healthFailure = new Error("health end failed");
    const budgetFailure = new Error("budget end failed");

    const closing = dbs.close();
    const answer = closing.then(
      () => "closed",
      (err: unknown) => err,
    );
    health.settle.reject(healthFailure);
    budget.settle.reject(budgetFailure);

    await expect(answer).resolves.toBe(healthFailure);
    expect(health.close).toHaveBeenCalledTimes(1);
    expect(budget.close).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([
      expect.objectContaining({
        level: "warn",
        probe: "budget",
        msg: "database probe handle failed to close",
        err: expect.objectContaining({ message: budgetFailure.message }),
      }),
    ]);
  });

  /**
   * A start that fails on the second handle has no stop to close the first:
   * it is closed on the spot with the bound of the stage, and the failure of
   * the open is what the start answers with.
   */
  it("closes the handle already opened when opening the next one fails", () => {
    const health = heldHandle();
    const failure = new RangeError("bad bounds");
    vi.mocked(createProbeDb)
      .mockReturnValueOnce(health.handle)
      .mockImplementationOnce(() => {
        throw failure;
      });

    expect(() =>
      openProbeDbs(CLOSED_DATABASE_URL, recordingLogger().log),
    ).toThrow(failure);
    expect(health.close).toHaveBeenCalledTimes(1);
    expect(health.close).toHaveBeenCalledWith({
      timeoutSec: DB_CLOSE_TIMEOUT_SEC,
    });
    health.settle.resolve();
  });

  /**
   * The close of the first handle has no one to answer to when the start is
   * already failing, so its failure goes to the log and the start fails with
   * its own error.
   */
  it("writes a failed close of the handle opened before a failed open", async () => {
    const health = heldHandle();
    const failure = new RangeError("bad bounds");
    vi.mocked(createProbeDb)
      .mockReturnValueOnce(health.handle)
      .mockImplementationOnce(() => {
        throw failure;
      });
    const { log, lines } = recordingLogger();

    expect(() => openProbeDbs(CLOSED_DATABASE_URL, log)).toThrow(failure);
    const closeFailure = new Error("end failed");
    health.settle.reject(closeFailure);
    await new Promise((done) => setImmediate(done));

    expect(lines).toEqual([
      expect.objectContaining({
        level: "warn",
        probe: "health",
        msg: "database probe handle failed to close after the start failed",
        err: expect.objectContaining({ message: closeFailure.message }),
      }),
    ]);
  });
});
