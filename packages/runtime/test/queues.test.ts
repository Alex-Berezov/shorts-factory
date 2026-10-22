import { QUEUE_NAMES, type QueueName } from "@sf/core";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withDeadline } from "../src/deadline.js";
import { type QueueFactory, createQueueFactory } from "../src/queues.js";
import { recordingLogger } from "../test-support/recording-logger.js";

/**
 * The factory without Redis: what is asserted here is what it does with the
 * `Queue` objects it builds - the options, the listeners, when it forgets
 * one - and a fake `Queue` answers the way BullMQ's does: its `init()` takes
 * a moment and then succeeds or is refused, and every command waits for it.
 */

/** How long the fake `init()` takes; never answering at once, like a socket. */
const INIT_MS = 5;

/**
 * The fake and what it answers, hoisted with the mock: `bullmq` is imported by
 * the factory before the body of this file runs.
 */
const fakes = vi.hoisted(() => {
  class FakeQueue {
    readonly name: string;
    readonly options: Record<string, unknown>;
    readonly listeners = new Map<string, Array<(err: Error) => void>>();
    closed = false;
    /** How many times anybody asked for the verdict on `init()`. */
    waitedForReady = 0;
    /**
     * Where BullMQ keeps the job scheduler a `upsertJobScheduler` built; set
     * by a case that wants the `Queue` to have one.
     */
    _jobScheduler: { close(): Promise<void> } | undefined;
    private readonly initializing: Promise<void>;
    /** Takes the listener this `Queue` put on the client off it again. */
    private readonly stopHearing: () => void = () => {};

    constructor(name: string, options: Record<string, unknown>) {
      this.name = name;
      this.options = options;
      const refusal = state.initRefusal;
      this.initializing = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          if (refusal === undefined) {
            resolve();
          } else {
            reject(refusal);
          }
        }, state.initMs);
      });
      // What BullMQ does with an error of the client it runs on: every
      // `RedisConnection` re-emits it on its own `Queue`.
      const connection = options.connection;
      if (
        typeof connection === "object" &&
        connection !== null &&
        "on" in connection &&
        typeof connection.on === "function"
      ) {
        const hear = (err: Error): void => this.emit("error", err);
        connection.on("error", hear);
        // What BullMQ does on `close()`: the listener comes off the client.
        if ("off" in connection && typeof connection.off === "function") {
          const { off } = connection;
          this.stopHearing = () => off.call(connection, "error", hear);
        }
      }
      // What BullMQ does with a refused `init()`: an `error` event as well.
      this.initializing.catch((err: Error) => this.emit("error", err));
      state.built.push(this);
    }

    on(event: string, listener: (err: Error) => void): this {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        listener,
      ]);
      return this;
    }

    emit(event: string, err: Error): void {
      const listeners = this.listeners.get(event) ?? [];
      if (event === "error" && listeners.length === 0) {
        // What `EventEmitter` does with an error nobody listens to.
        throw err;
      }
      for (const listener of listeners) {
        listener(err);
      }
    }

    /**
     * What BullMQ's getter does (`queue.js`, `get jobScheduler`, an `async`
     * executor of a `new Promise`): the scheduler is built, and the field set,
     * only once the client of the `Queue` is there; a refused client is a
     * rejection nobody handles, and the promise handed out never settles.
     */
    get jobScheduler(): Promise<{ close(): Promise<void> }> {
      return new Promise((resolve) => {
        void (async () => {
          await this.initializing;
          this._jobScheduler ??= state.scheduler(this.name);
          resolve(this._jobScheduler);
        })();
      });
    }

    /** What BullMQ does (`queue.js`): the scheduler first, then the command. */
    async upsertJobScheduler(id: string): Promise<string> {
      await this.jobScheduler;
      return id;
    }

    /**
     * What BullMQ does (`queue-base.js`, `waitUntilReady() { return
     * this.client; }`): the very promise every command awaits, not a new one
     * that settles a tick later - the order in which the factory and a read
     * hear a refusal depends on it.
     */
    waitUntilReady(): Promise<void> {
      this.waitedForReady += 1;
      return this.initializing;
    }

    async count(): Promise<number> {
      await this.initializing;
      return state.command();
    }

    async close(): Promise<void> {
      this.closed = true;
      try {
        await state.closeOf(this.name);
      } finally {
        this.stopHearing();
      }
    }
  }

  const state: {
    /** Whether the next `Queue` built has its `init()` refused. */
    initRefusal: Error | undefined;
    /** How long the `init()` of the next `Queue` takes; `INIT_MS` normally. */
    initMs: number;
    /** What a command of a `Queue` does once `init()` is through. */
    command: () => Promise<number>;
    /** What the `close()` of the `Queue` of this name does after it is marked. */
    closeOf: (name: string) => Promise<void>;
    /** The job scheduler the getter of a `Queue` of this name builds. */
    scheduler: (name: string) => { close(): Promise<void> };
    built: FakeQueue[];
    // `INIT_MS`, which is not hoisted.
  } = {
    initRefusal: undefined,
    initMs: 5,
    command: async () => 1,
    closeOf: async () => {},
    scheduler: () => ({ close: async () => {} }),
    built: [],
  };

  return { state, FakeQueue };
});

vi.mock("bullmq", () => ({ Queue: fakes.FakeQueue }));

const { state } = fakes;
const built = state.built;

/**
 * The client the fake queues are handed and never use. A real one rather
 * than a cast; it opens no socket - `lazyConnect` connects on the first
 * command, and no command reaches it.
 */
const connection = new Redis({ lazyConnect: true, port: 6399 });

/** The fake behind a `Queue` the factory handed out. */
function fake(queue: unknown): InstanceType<typeof fakes.FakeQueue> {
  if (!(queue instanceof fakes.FakeQueue)) {
    throw new Error("the factory built something other than the fake");
  }
  return queue;
}

/** A read through the factory, the way the status page of the api reads. */
function countOf(queue: unknown): Promise<number> {
  return fake(queue).count();
}

/** The job policy a writer passes; its content is the worker's business. */
const POLICY = { attempts: 3 };

/** Every factory a case opened, closed after it. */
const opened: QueueFactory[] = [];

/**
 * A factory closed after the case: left open, its listener and those of its
 * queues stay on the shared client, and the cases pile them up there.
 */
function open(options: Parameters<typeof createQueueFactory>[0]): QueueFactory {
  const factory = createQueueFactory(options);
  opened.push(factory);
  return factory;
}

beforeEach(() => {
  built.length = 0;
  state.initRefusal = undefined;
  state.initMs = INIT_MS;
  state.command = async () => 1;
  state.closeOf = async () => {};
  state.scheduler = () => ({ close: async () => {} });
});

/**
 * How long the clean-up waits for the factories of a case to close. A case
 * that holds the close of a `Queue` open (`finishClose`) and fails before it
 * lets go leaves a close that never ends; past this the clean-up fails with
 * that reason instead of "Hook timed out".
 */
const CLEANUP_LIMIT_MS = 2_000;

afterEach(async () => {
  vi.useRealTimers();
  // A close a case left hanging must not hold the clean-up.
  state.closeOf = async () => {};
  await withDeadline(
    () =>
      Promise.allSettled(opened.splice(0).map((factory) => factory.close())),
    CLEANUP_LIMIT_MS,
    {
      unref: false,
      error: () =>
        new Error(
          `a queue factory of this case did not close within ${CLEANUP_LIMIT_MS} ms: the case held the close of a queue open and failed before letting it go`,
        ),
    },
  );
});

describe("createQueueFactory", () => {
  it("builds one queue per name and hands the same one out again", () => {
    const factory = open({
      connection,
      log: recordingLogger().log,
      readOnly: false,
      defaultJobOptions: POLICY,
    });

    expect(factory.get("system.smoke")).toBe(factory.get("system.smoke"));
    expect(built).toHaveLength(1);
  });

  it("refuses a name that is not in the registry", () => {
    const factory = open({
      connection,
      log: recordingLogger().log,
      readOnly: false,
      defaultJobOptions: POLICY,
    });

    // A name read from stored data: the type cannot vouch for it.
    const stored: string = "system.renamed";
    expect(() => factory.get(stored as QueueName)).toThrow(
      /not in QUEUE_NAMES/,
    );
  });

  it("passes the job policy of the caller and opens a reader read-only", () => {
    const writer = open({
      connection,
      log: recordingLogger().log,
      readOnly: false,
      defaultJobOptions: POLICY,
    });
    const reader = open({
      connection,
      log: recordingLogger().log,
      readOnly: true,
    });

    expect(fake(writer.get("system.smoke")).options).toMatchObject({
      defaultJobOptions: { attempts: 3 },
    });
    expect(fake(writer.get("system.smoke")).options).not.toHaveProperty(
      "skipMetasUpdate",
    );
    expect(fake(reader.get("system.smoke")).options).toMatchObject({
      skipMetasUpdate: true,
      skipWaitingForReady: true,
    });
  });

  it("opens no writer without the job policy and no reader with one", () => {
    // A writer without attempts, backoff and the bounds of the kept records
    // would add jobs that fail once and stay forever; the type says so
    // before a process starts. Only the compiler runs these calls (`tsc` of
    // the package includes the tests): never called, they open nothing on
    // the client the other cases share.
    const typeOnly = (): void => {
      // @ts-expect-error a writer must carry the policy of the jobs
      createQueueFactory({
        connection,
        log: recordingLogger().log,
        readOnly: false,
      });
      // @ts-expect-error a reader adds no jobs, so it has no policy to pass
      createQueueFactory({
        connection,
        log: recordingLogger().log,
        readOnly: true,
        defaultJobOptions: POLICY,
      });
    };
    const listening = connection.listenerCount("error");

    expect(typeOnly).toBeTypeOf("function");
    expect(connection.listenerCount("error")).toBe(listening);
  });

  it("survives an error of a queue instead of taking the process down", () => {
    // The worker had no listener here: an outage was an unhandled
    // `EventEmitter` error in a process running jobs.
    const factory = open({
      connection,
      log: recordingLogger().log,
      readOnly: false,
      defaultJobOptions: POLICY,
    });

    const queue = fake(factory.get("system.smoke"));

    expect(() => queue.emit("error", new Error("boom"))).not.toThrow();
  });

  it("writes an error of a queue that is not a connection failure", async () => {
    const { log, lines } = recordingLogger();
    const factory = open({
      connection,
      log,
      readOnly: false,
      defaultJobOptions: POLICY,
    });
    const queue = fake(factory.get("system.smoke"));

    queue.emit("error", new Error("Missing key for job 42"));

    // Written once the `init()` of the queue has answered: the error is not
    // its refusal.
    await vi.waitFor(() => {
      expect(lines).toHaveLength(1);
    });
    expect(lines).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "queue error",
        queue: "system.smoke",
        err: expect.objectContaining({ message: "Missing key for job 42" }),
      }),
    ]);
  });

  it.each([
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
      code: "ECONNREFUSED",
    }),
    // A resolver that did not answer: Docker's DNS before the service is up.
    Object.assign(new Error("getaddrinfo EAI_AGAIN redis"), {
      code: "EAI_AGAIN",
      syscall: "getaddrinfo",
    }),
    new Error("Connection is closed."),
    new Error("Stream isn't writeable and enableOfflineQueue options is false"),
  ])("stays silent on a connection failure: $message", async (err) => {
    // The client writes its own failure; a line per queue on top would be 29
    // error lines per pass while Redis is down.
    vi.useFakeTimers();
    const { log, lines } = recordingLogger();
    const factory = open({ connection, log, readOnly: true });

    fake(factory.get("system.smoke")).emit("error", err);
    // The listener writes only once the `init()` of the queue has answered;
    // a verdict not waited for would leave nothing to assert on.
    await vi.runAllTimersAsync();

    expect(lines).toEqual([]);
  });

  /**
   * BullMQ hands every error of the shared client to every `Queue` on it. A
   * refusal that is not a connection failure - a wrong password, a name the
   * resolver of Docker cannot answer yet - must still be one line per event:
   * the client's own, at the level that fades.
   */
  it.each([
    Object.assign(
      new Error(
        "WRONGPASS invalid username-password pair or user is disabled.",
      ),
      { name: "ReplyError" },
    ),
    Object.assign(new Error("NOAUTH Authentication required."), {
      name: "ReplyError",
    }),
  ])(
    "writes one error line, not one per queue, for an error of the client: $message",
    async (err) => {
      vi.useFakeTimers();
      const { log, lines } = recordingLogger();
      const client = new Redis({ lazyConnect: true, port: 6399 });
      // The line the client writes of its own (`createRedisHealthListeners`
      // of the factories of the clients); the factory of the queues must add
      // none.
      client.on("error", (clientErr: Error) => {
        log.error({ err: clientErr }, "redis client error");
      });
      const factory = open({
        connection: client,
        log,
        readOnly: true,
      });
      for (const name of QUEUE_NAMES.slice(0, 3)) {
        factory.get(name);
      }

      client.emit("error", err);
      // As above: the lines of the queues, if any, come after their verdict.
      await vi.runAllTimersAsync();

      expect(lines.filter((line) => line.level === "error")).toEqual([
        expect.objectContaining({ msg: "redis client error" }),
      ]);
      expect(lines.map((line) => line.msg)).not.toContain("queue error");
    },
  );

  it("writes no line per queue for an init refused by Redis itself", async () => {
    // Not a connection failure and not an error of the client: the user of
    // the client may not run INFO. BullMQ emits the refusal on every `Queue`;
    // the read that was refused is the one that reports it.
    vi.useFakeTimers();
    const { log, lines } = recordingLogger();
    const factory = open({ connection, log, readOnly: true });
    state.initRefusal = Object.assign(
      new Error("NOPERM User sf has no permissions to run the 'info' command"),
      { name: "ReplyError" },
    );

    const reads = QUEUE_NAMES.slice(0, 3).map((name) =>
      factory.use(name, countOf).then(
        () => "answered",
        (err: unknown) => (err instanceof Error ? err.message : "refused"),
      ),
    );
    await vi.advanceTimersByTimeAsync(INIT_MS + 100);

    expect(await Promise.all(reads)).toEqual([
      expect.stringMatching(/^NOPERM/),
      expect.stringMatching(/^NOPERM/),
      expect.stringMatching(/^NOPERM/),
    ]);
    expect(lines.map((line) => line.msg)).not.toContain("queue error");
  });

  it("throws a queue whose init was refused away, so the next read builds a new one", async () => {
    vi.useFakeTimers();
    const factory = open({
      connection,
      log: recordingLogger().log,
      readOnly: true,
    });
    state.initRefusal = new Error("Connection is closed.");

    const first = factory.use("system.smoke", countOf);
    const failed = expect(first).rejects.toThrow("Connection is closed.");
    await vi.advanceTimersByTimeAsync(INIT_MS);
    await failed;

    // Redis is back; the read must not inherit the broken object.
    state.initRefusal = undefined;
    const second = factory.use("system.smoke", countOf);
    await vi.advanceTimersByTimeAsync(INIT_MS);

    await expect(second).resolves.toBe(1);
    expect(built).toHaveLength(2);
    expect(built[0]?.closed).toBe(true);
    expect(built[1]?.closed).toBe(false);
  });

  it("hands a read that retries from its own refusal a new queue, not the refused one", async () => {
    // The retry runs in the handler of the refusal, on the same turn: the
    // factory has to have forgotten the `Queue` by then, or the retry gets
    // the broken object back.
    vi.useFakeTimers();
    const factory = open({
      connection,
      log: recordingLogger().log,
      readOnly: true,
    });
    state.initRefusal = new Error("Connection is closed.");

    const retried = factory.use("system.smoke", countOf).then(
      () => undefined,
      () => factory.get("system.smoke"),
    );
    await vi.advanceTimersByTimeAsync(INIT_MS);

    const again = await retried;
    expect(built).toHaveLength(2);
    expect(again).toBe(built[1]);
    expect(again).not.toBe(built[0]);
  });

  it("keeps a queue whose read failed after its init succeeded", async () => {
    vi.useFakeTimers();
    const factory = open({
      connection,
      log: recordingLogger().log,
      readOnly: true,
    });
    const ready = factory.use("system.smoke", countOf);
    await vi.advanceTimersByTimeAsync(INIT_MS);
    await expect(ready).resolves.toBe(1);

    // Redis went away after the queue got ready: the command is refused,
    // the `Queue` is fine and serves the next read once Redis is back.
    state.command = async () => {
      throw new Error(
        "Stream isn't writeable and enableOfflineQueue options is false",
      );
    };
    await expect(factory.use("system.smoke", countOf)).rejects.toThrow(
      /Stream isn't writeable/,
    );
    state.command = async () => 2;

    // The clock moves as far as a new `init()` would need, so that a factory
    // that did build a new `Queue` answers too - and is caught by the count.
    const next = factory.use("system.smoke", countOf);
    await vi.advanceTimersByTimeAsync(INIT_MS);
    await expect(next).resolves.toBe(2);
    expect(built).toHaveLength(1);
    expect(built[0]?.closed).toBe(false);
  });

  it("keeps a queue whose init is still running when its read fails", async () => {
    // A read refused before it got to a command, on a `Queue` still
    // connecting: no verdict on `init()` within the bound, so no reason to
    // throw it away and build another on the next pass.
    vi.useFakeTimers();
    state.initMs = 60_000;
    const factory = open({
      connection,
      log: recordingLogger().log,
      readOnly: true,
    });

    const failing = factory.use("system.smoke", async () => {
      throw new Error("Connection is closed.");
    });
    const failed = expect(failing).rejects.toThrow("Connection is closed.");
    await vi.advanceTimersByTimeAsync(1_000);
    await failed;

    expect(built).toHaveLength(1);
    expect(built[0]?.closed).toBe(false);
    expect(factory.get("system.smoke")).toBe(built[0]);
  });

  it("lets a read that is already running finish before it closes", async () => {
    const factory = open({
      connection,
      log: recordingLogger().log,
      readOnly: true,
    });
    let release = (): void => {};
    state.command = () =>
      new Promise<number>((resolve) => {
        release = () => resolve(7);
      });

    const pending = factory.use("system.smoke", countOf);
    // Let the read reach its command before the close begins.
    await new Promise((resolve) => setTimeout(resolve, INIT_MS * 2));
    const closing = factory.close();
    expect(built[0]?.closed).toBe(false);
    release();

    await expect(pending).resolves.toBe(7);
    await closing;
    expect(built[0]?.closed).toBe(true);
  });

  it("stops waiting for a read that never answers and closes anyway", async () => {
    vi.useFakeTimers();
    const factory = open({
      connection,
      log: recordingLogger().log,
      readOnly: true,
      drainTimeoutMs: 20,
    });
    state.command = () => new Promise<number>(() => {});
    void factory.use("system.smoke", countOf).catch(() => {});
    await vi.advanceTimersByTimeAsync(INIT_MS);

    const closing = factory.close();
    await vi.advanceTimersByTimeAsync(20);
    await closing;

    expect(built[0]?.closed).toBe(true);
  });

  it("waits for every queue when one of them refuses to close, then says so", async () => {
    // A close that gave up at the first refusal handed the client to the
    // next stage - which tears it down - while the other queues were still
    // closing on it.
    const client = new Redis({ lazyConnect: true, port: 6399 });
    const factory = open({
      connection: client,
      log: recordingLogger().log,
      readOnly: true,
    });
    const [refusing, slow] = QUEUE_NAMES;
    if (refusing === undefined || slow === undefined) {
      throw new Error("the registry has fewer than two queues");
    }
    let finishSlow = (): void => {};
    let slowDone = false;
    state.closeOf = async (name) => {
      if (name === refusing) {
        throw new Error("the queue refused to close");
      }
      if (name === slow) {
        await new Promise<void>((resolve) => {
          finishSlow = resolve;
        });
        slowDone = true;
      }
    };
    factory.get(refusing);
    factory.get(slow);
    // The fake queues listen on the client too, until their close is over;
    // the factory's own goes once every one of them is.
    const listening = client.listenerCount("error");

    let settled = false;
    const closing = factory.close().finally(() => {
      settled = true;
    });
    const verdict = expect(closing).rejects.toMatchObject({
      message: "1 of 2 queues failed to close",
      errors: [
        expect.objectContaining({ message: "the queue refused to close" }),
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    finishSlow();
    await verdict;
    expect(slowDone).toBe(true);
    // Its own and those of both queues, the refusing one included.
    expect(client.listenerCount("error")).toBe(listening - 3);
  });

  it("waits for a queue it threw away before it lets go of the client", async () => {
    // `forget()` does not wait for the close it starts - the failed read
    // answers at once - but the stage after `close()` tears the client down,
    // and a `Queue` still closing on it would lose its socket mid-close and
    // have its errors written as "queue error".
    vi.useFakeTimers();
    const client = new Redis({ lazyConnect: true, port: 6399 });
    const factory = open({
      connection: client,
      log: recordingLogger().log,
      readOnly: true,
    });
    state.initRefusal = new Error("Connection is closed.");
    let finishClose = (): void => {};
    state.closeOf = () =>
      new Promise<void>((resolve) => {
        finishClose = resolve;
      });
    const failed = expect(factory.use("system.smoke", countOf)).rejects.toThrow(
      "Connection is closed.",
    );
    await vi.advanceTimersByTimeAsync(INIT_MS);
    await failed;
    // Thrown away and closing: the read did not wait for it.
    expect(built[0]?.closed).toBe(true);
    const listening = client.listenerCount("error");

    let settled = false;
    const closing = factory.close().finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    expect(client.listenerCount("error")).toBe(listening);

    finishClose();
    await closing;
    expect(client.listenerCount("error")).toBe(0);
  });

  it("refuses a queue asked for after the close", async () => {
    const factory = open({
      connection,
      log: recordingLogger().log,
      readOnly: false,
      defaultJobOptions: POLICY,
    });
    await factory.close();

    expect(() => factory.get("system.smoke")).toThrow(
      /after the queue factory was closed/,
    );
  });
});

describe("the verdict on init()", () => {
  it("asks for it once per queue, however many errors the queue hears", async () => {
    // A Redis that is down leaves `init()` pending for as long as it is down;
    // a handler per error on that promise piled up for the life of the
    // process.
    vi.useFakeTimers();
    state.initMs = 60_000;
    const factory = open({
      connection,
      log: recordingLogger().log,
      readOnly: false,
      defaultJobOptions: POLICY,
    });
    const queue = fake(factory.get("system.smoke"));

    for (let index = 0; index < 20; index += 1) {
      queue.emit("error", new Error(`Missing key for job ${index}`));
    }
    await vi.advanceTimersByTimeAsync(1_000);

    expect(queue.waitedForReady).toBe(1);
  });

  it("writes an error a moment after it came when the verdict is not in yet", async () => {
    vi.useFakeTimers();
    state.initMs = 60_000;
    const { log, lines } = recordingLogger();
    const factory = open({ connection, log, readOnly: true });
    const queue = fake(factory.get("system.smoke"));

    queue.emit("error", new Error("Missing key for job 42"));
    expect(lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(lines.map((line) => line.msg)).toEqual(["queue error"]);
  });

  it("writes an error of a ready queue at once", async () => {
    vi.useFakeTimers();
    const { log, lines } = recordingLogger();
    const factory = open({ connection, log, readOnly: true });
    const queue = fake(factory.get("system.smoke"));
    await vi.advanceTimersByTimeAsync(INIT_MS);

    queue.emit("error", new Error("Missing key for job 42"));

    expect(lines.map((line) => line.msg)).toEqual(["queue error"]);
  });

  it("forgets a writer whose init Redis refused, with no read, and says so once per queue", async () => {
    // The worker adds jobs through its queues and never reads them: a
    // permission the user of the client lacks broke them for good, and
    // nothing said so.
    vi.useFakeTimers();
    const { log, lines } = recordingLogger();
    const factory = open({
      connection,
      log,
      readOnly: false,
      defaultJobOptions: POLICY,
    });
    state.initRefusal = Object.assign(
      new Error("NOPERM User sf has no permissions to run the 'info' command"),
      { name: "ReplyError" },
    );
    const names = QUEUE_NAMES.slice(0, 3);
    const first = names.map((name) => factory.get(name));
    await vi.advanceTimersByTimeAsync(INIT_MS + 100);

    expect(lines.map((line) => [line.level, line.msg, line.queue])).toEqual(
      names.map((name) => ["error", "queue init refused", name]),
    );
    expect(lines[0]?.err).toMatchObject({
      message: expect.stringMatching(/^NOPERM/),
    });
    expect(first.map((queue) => fake(queue).closed)).toEqual([
      true,
      true,
      true,
    ]);

    // Redis is fixed; the next write must not get the broken object.
    state.initRefusal = undefined;
    const next = names.map((name) => factory.get(name));
    expect(next.every((queue, index) => queue !== first[index])).toBe(true);
  });

  it("says nothing of a name refused again, and still speaks of another name", async () => {
    // The switch resync of the worker asks for every name on each pass: a
    // permission still missing would be a line per queue per pass
    // (docs/DECISIONS.md, Р1 E0-12R, clarification 1).
    vi.useFakeTimers();
    const { log, lines } = recordingLogger();
    const factory = open({
      connection,
      log,
      readOnly: false,
      defaultJobOptions: POLICY,
    });
    state.initRefusal = Object.assign(
      new Error("NOPERM User sf has no permissions to run the 'info' command"),
      { name: "ReplyError" },
    );

    const first = factory.get("system.smoke");
    await vi.advanceTimersByTimeAsync(INIT_MS + 100);
    // The next passes: a new `Queue` each, refused the same way.
    const second = factory.get("system.smoke");
    await vi.advanceTimersByTimeAsync(INIT_MS + 100);
    factory.get("system.smoke");
    await vi.advanceTimersByTimeAsync(INIT_MS + 100);
    factory.get("system.heartbeat");
    await vi.advanceTimersByTimeAsync(INIT_MS + 100);

    expect(lines.map((line) => [line.level, line.msg, line.queue])).toEqual([
      ["error", "queue init refused", "system.smoke"],
      ["error", "queue init refused", "system.heartbeat"],
    ]);
    // Silence is not keeping: every refused `Queue` is still thrown away.
    expect(second).not.toBe(first);
    expect(built.map((queue) => queue.closed)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it.each([
    ["a connection failure", new Error("Connection is closed.")],
    [
      "a refused password",
      Object.assign(new Error("WRONGPASS invalid username-password pair"), {
        name: "ReplyError",
      }),
    ],
  ])(
    "forgets a writer whose init was refused by %s, without a line of its own",
    async (_what, refusal) => {
      // The client reports both; a line per queue on top would be a line per
      // queue per pass.
      vi.useFakeTimers();
      const { log, lines } = recordingLogger();
      const factory = open({
        connection,
        log,
        readOnly: false,
        defaultJobOptions: POLICY,
      });
      state.initRefusal = refusal;
      const first = factory.get("system.smoke");
      await vi.advanceTimersByTimeAsync(INIT_MS + 100);

      expect(lines).toEqual([]);
      state.initRefusal = undefined;
      expect(factory.get("system.smoke")).not.toBe(first);
    },
  );

  it.each([
    ["a connection failure", () => new Error("Connection is closed.")],
    [
      "a refused password",
      () =>
        Object.assign(new Error("WRONGPASS invalid username-password pair"), {
          name: "ReplyError",
        }),
    ],
  ])(
    "writes no line for %s heard while the verdict is not in, nor when it comes",
    async (_what, refusal) => {
      // The refusal reaches the listener ahead of the verdict, from the
      // client or from BullMQ; on a Redis that is down that is every queue.
      vi.useFakeTimers();
      const { log, lines } = recordingLogger();
      const factory = open({
        connection,
        log,
        readOnly: false,
        defaultJobOptions: POLICY,
      });
      const err = refusal();
      state.initRefusal = err;
      const queue = fake(factory.get("system.smoke"));

      queue.emit("error", err);
      await vi.advanceTimersByTimeAsync(INIT_MS + 1_000);

      expect(lines).toEqual([]);
    },
  );

  it("forgets a reader whose init Redis refused, without a line", async () => {
    // Every read of it is refused with the reason and reports it.
    vi.useFakeTimers();
    const { log, lines } = recordingLogger();
    const factory = open({ connection, log, readOnly: true });
    state.initRefusal = Object.assign(new Error("NOPERM no permissions"), {
      name: "ReplyError",
    });
    const first = factory.get("system.smoke");
    await vi.advanceTimersByTimeAsync(INIT_MS + 100);

    expect(lines).toEqual([]);
    state.initRefusal = undefined;
    expect(factory.get("system.smoke")).not.toBe(first);
  });
});

describe("the close of the factory", () => {
  it("is one close for two callers, with one mark taken off", async () => {
    const client = new Redis({ lazyConnect: true, port: 6399 });
    const factory = open({
      connection: client,
      log: recordingLogger().log,
      readOnly: true,
    });
    const takenOff = vi.spyOn(client, "off");
    factory.get("system.smoke");
    // A listener on the client that belongs to somebody else.
    const other = (): void => {};
    client.on("error", other);

    const first = factory.close();
    const second = factory.close();
    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(client.listeners("error")).toEqual([other]);
    expect(built.filter((queue) => queue.closed)).toHaveLength(1);
    // Taken off once each - the listener of the queue and the mark - and not
    // a second time by a second pass.
    expect(
      takenOff.mock.calls.filter(([event]) => event === "error"),
    ).toHaveLength(2);
  });

  it("hands a second caller the refusal of the first", async () => {
    const factory = open({
      connection,
      log: recordingLogger().log,
      readOnly: true,
    });
    state.closeOf = async () => {
      throw new Error("the queue refused to close");
    };
    factory.get("system.smoke");

    const first = factory.close();
    const second = factory.close();
    const [verdict, again] = await Promise.allSettled([first, second]);

    expect(verdict).toMatchObject({
      status: "rejected",
      reason: { message: "1 of 1 queues failed to close" },
    });
    expect(again).toEqual(verdict);
  });

  it("stops waiting for a queue it threw away whose close never ends", async () => {
    vi.useFakeTimers();
    const factory = open({
      connection,
      log: recordingLogger().log,
      readOnly: true,
      drainTimeoutMs: 20,
    });
    state.initRefusal = new Error("Connection is closed.");
    // A close that hangs for real: nothing ever resolves it.
    state.closeOf = () => new Promise<void>(() => {});
    factory.get("system.smoke");
    await vi.advanceTimersByTimeAsync(INIT_MS);
    expect(built[0]?.closed).toBe(true);

    let settled = false;
    const closing = factory.close().finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(19);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;

    expect(settled).toBe(true);
  });

  it("writes no queue error that comes due after the close", async () => {
    // The error came while `init()` had no verdict; the line would be
    // written once the verdict was read, by which time the process is
    // stopping.
    vi.useFakeTimers();
    state.initMs = 60_000;
    const { log, lines } = recordingLogger();
    const factory = open({ connection, log, readOnly: true });
    const queue = fake(factory.get("system.smoke"));

    queue.emit("error", new Error("Missing key for job 42"));
    await factory.close();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(lines).toEqual([]);
  });

  it("closes the job scheduler of a queue before the queue", async () => {
    // BullMQ closes the `Repeat` of a queue and not its `JobScheduler`,
    // whose listeners stay on the shared client.
    const order: string[] = [];
    const factory = open({
      connection,
      log: recordingLogger().log,
      readOnly: false,
      defaultJobOptions: POLICY,
    });
    const scheduled = fake(factory.get("system.heartbeat"));
    scheduled._jobScheduler = {
      close: async () => {
        order.push("scheduler");
      },
    };
    factory.get("system.smoke");
    state.closeOf = async (name) => {
      order.push(name);
    };

    await factory.close();

    // The queues close side by side; the scheduler goes ahead of its own.
    expect([...order].sort()).toEqual([
      "scheduler",
      "system.heartbeat",
      "system.smoke",
    ]);
    expect(order.indexOf("scheduler")).toBeLessThan(
      order.indexOf("system.heartbeat"),
    );
  });

  it("closes the job scheduler of a queue it threw away", async () => {
    vi.useFakeTimers();
    const factory = open({
      connection,
      log: recordingLogger().log,
      readOnly: false,
      defaultJobOptions: POLICY,
    });
    let schedulerClosed = false;
    state.initRefusal = new Error("Connection is closed.");
    const refused = fake(factory.get("system.heartbeat"));
    refused._jobScheduler = {
      close: async () => {
        schedulerClosed = true;
      },
    };
    await vi.advanceTimersByTimeAsync(INIT_MS);

    expect(refused.closed).toBe(true);
    expect(schedulerClosed).toBe(true);
  });

  it("closes the queue even when its job scheduler refuses to", async () => {
    const factory = open({
      connection,
      log: recordingLogger().log,
      readOnly: false,
      defaultJobOptions: POLICY,
    });
    const scheduled = fake(factory.get("system.heartbeat"));
    scheduled._jobScheduler = {
      close: async () => {
        throw new Error("the scheduler refused to close");
      },
    };

    await expect(factory.close()).rejects.toThrow(
      "1 of 1 queues failed to close",
    );
    expect(scheduled.closed).toBe(true);
  });

  it("closes a job scheduler that comes after the close began", async () => {
    // A call of the schedules asked for the scheduler while the client was
    // not there yet; the close found no field, and the scheduler came later.
    vi.useFakeTimers();
    let schedulerClosed = false;
    state.scheduler = () => ({
      close: async () => {
        schedulerClosed = true;
      },
    });
    const factory = open({
      connection,
      log: recordingLogger().log,
      readOnly: false,
      defaultJobOptions: POLICY,
    });
    const asked = factory.get("system.heartbeat").jobScheduler;

    await factory.close();
    expect(schedulerClosed).toBe(false);
    await vi.advanceTimersByTimeAsync(INIT_MS);
    await asked;

    expect(schedulerClosed).toBe(true);
  });

  it("refuses a schedule on a queue whose init was refused, with no rejection left unhandled", async () => {
    // BullMQ's getter awaits the client inside an `async` executor: without
    // the factory waiting for `init()` first, the refusal escapes as an
    // unhandled rejection and the upsert never answers.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const refusal = new Error("NOPERM no permissions");
      state.initRefusal = refusal;
      const factory = open({
        connection,
        log: recordingLogger().log,
        readOnly: false,
        defaultJobOptions: POLICY,
      });
      const upserting = factory
        .get("system.heartbeat")
        .upsertJobScheduler("heartbeat", { every: 60_000 });

      const verdict = await withDeadline(
        () =>
          upserting.then(
            () => "scheduled",
            (err: unknown) => err,
          ),
        INIT_MS + 200,
        { unref: false, error: () => new Error("the upsert never answered") },
      ).catch((err: unknown) => err);
      // An unhandled rejection is reported once the microtasks are through.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(verdict).toBe(refusal);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("reports the refusal of the job scheduler and of the queue when both refuse", async () => {
    const factory = open({
      connection,
      log: recordingLogger().log,
      readOnly: false,
      defaultJobOptions: POLICY,
    });
    const scheduled = fake(factory.get("system.heartbeat"));
    scheduled._jobScheduler = {
      close: async () => {
        throw new Error("the scheduler refused to close");
      },
    };
    state.closeOf = async () => {
      throw new Error("the queue refused to close");
    };

    const verdict = await factory.close().then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(verdict).toBeInstanceOf(AggregateError);
    const [refusal] = verdict instanceof AggregateError ? verdict.errors : [];
    expect(refusal).toBeInstanceOf(AggregateError);
    expect(
      refusal instanceof AggregateError
        ? refusal.errors.map((err: unknown) =>
            err instanceof Error ? err.message : err,
          )
        : [],
    ).toEqual(["the scheduler refused to close", "the queue refused to close"]);
  });

  it("waits for a queue whose init is refused while it closes, before it lets go of the client", async () => {
    // The verdict comes during the close: the factory does not forget a
    // `Queue` that is no longer in its cache, and closes it as one of its own.
    vi.useFakeTimers();
    const client = new Redis({ lazyConnect: true, port: 6399 });
    const factory = open({
      connection: client,
      log: recordingLogger().log,
      readOnly: false,
      defaultJobOptions: POLICY,
    });
    state.initRefusal = new Error("NOPERM no permissions");
    let finishClose = (): void => {};
    state.closeOf = () =>
      new Promise<void>((resolve) => {
        finishClose = resolve;
      });
    factory.get("system.smoke");

    let settled = false;
    const closing = factory.close().finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(INIT_MS + 1_000);
    expect(settled).toBe(false);
    expect(client.listenerCount("error")).toBeGreaterThan(0);

    finishClose();
    await closing;
    expect(client.listenerCount("error")).toBe(0);
  });
});
