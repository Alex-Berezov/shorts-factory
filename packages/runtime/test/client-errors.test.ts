import { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTION_FAILURE_LOG_WINDOW_MS,
  markClientErrors,
  workerErrorPolicy,
} from "../src/client-errors.js";

/** A refusal of the server the way ioredis raises it (`ReplyError`). */
function reply(message: string): Error {
  return Object.assign(new Error(message), { name: "ReplyError" });
}

/** A connection failure, the way ioredis emits a refused connect. */
function refused(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6379"), {
    code: "ECONNREFUSED",
  });
}

/**
 * The mark every listener built on a shared client tells a copy of the
 * client's own error by. A client that never connects: what is asserted is
 * what the mark does with the events it hears, not a socket.
 */
describe("markClientErrors", () => {
  const clients: Redis[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.disconnect();
    }
  });

  function idleClient(): Redis {
    const client = new Redis({ lazyConnect: true, port: 6399 });
    // An `error` with no listener would throw out of `emit`; the mark is not
    // meant to be the only listener a client has.
    client.on("error", () => {});
    clients.push(client);
    return client;
  }

  it("knows an error the client emitted, and only that one", () => {
    const client = idleClient();
    const marks = markClientErrors(client);
    const emitted = new Error("WRONGPASS invalid username-password pair");
    const own = new Error("WRONGPASS invalid username-password pair");

    client.emit("error", emitted);

    expect(marks.has(emitted)).toBe(true);
    // Same text, a different object: an error of a `Queue` or a `Worker`
    // that merely reads the same.
    expect(marks.has(own)).toBe(false);
    expect(marks.has("WRONGPASS")).toBe(false);
    expect(marks.has(null)).toBe(false);
  });

  it("takes its listener off the client when disposed, and marks nothing after", () => {
    const client = idleClient();
    const before = client.listenerCount("error");
    const marks = markClientErrors(client);

    expect(client.listenerCount("error")).toBe(before + 1);
    marks.dispose();
    expect(client.listenerCount("error")).toBe(before);

    const late = new Error("after dispose");
    client.emit("error", late);
    expect(marks.has(late)).toBe(false);
  });

  it("listens ahead of anything built on the client after it", () => {
    // The order is the whole mechanism: a listener added later hears the
    // error already marked.
    const client = idleClient();
    const marks = markClientErrors(client);
    const heard: boolean[] = [];
    client.on("error", (err: Error) => {
      heard.push(marks.has(err));
    });

    client.emit("error", new Error("ENOTFOUND redis"));

    expect(heard).toEqual([true]);
  });

  it("leaves a queue listener an error of its own, and nothing the client writes", () => {
    const client = idleClient();
    const marks = markClientErrors(client);
    const emitted = new Error("WRONGPASS invalid username-password pair");
    client.emit("error", emitted);
    const refused = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });

    expect(marks.writtenByClient(emitted)).toBe(true);
    // Unmarked, but a connection failure: the client reports it.
    expect(marks.writtenByClient(refused)).toBe(true);
    expect(marks.writtenByClient(new Error("NOPERM no permissions"))).toBe(
      false,
    );
  });

  it("leaves a queue listener nothing to write for a refused password, marked or not", () => {
    // The refusal a `Queue` hears may be an object of its own (a duplicate
    // connection); the shared client says it once already.
    const marks = markClientErrors(idleClient());

    expect(
      marks.writtenByClient(reply("WRONGPASS invalid username-password pair")),
    ).toBe(true);
    expect(
      marks.writtenByClient(reply("NOAUTH Authentication required.")),
    ).toBe(true);
    expect(marks.writtenByClient(reply("NOPERM no permissions"))).toBe(false);
  });
});

/**
 * The rule of the `error` listener of a `Worker`, without BullMQ: the errors
 * are handed in the way the listener hears them.
 */
describe("workerErrorPolicy", () => {
  /** A mark that knows exactly the objects given to it. */
  function marksOf(...marked: unknown[]) {
    return { has: (err: unknown) => marked.includes(err) };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes nothing for an error of the shared client", () => {
    const shared = new Error("Missing lock for job 7");
    const policy = workerErrorPolicy(marksOf(shared));

    expect(policy.shouldWrite(shared)).toBe(false);
  });

  it("writes nothing for a refused password, however many copies hear it", () => {
    // Every blocking copy of the client is refused on every reconnect; the
    // shared client says it once.
    const policy = workerErrorPolicy(marksOf());

    expect(policy.shouldWrite(reply("WRONGPASS invalid password"))).toBe(false);
    expect(policy.shouldWrite(reply("NOAUTH Authentication required."))).toBe(
      false,
    );
  });

  it("writes an error of the worker itself, every time", () => {
    const policy = workerErrorPolicy(marksOf());

    expect(policy.shouldWrite(new Error("Missing lock for job 7"))).toBe(true);
    expect(policy.shouldWrite(new Error("Missing lock for job 7"))).toBe(true);
    expect(policy.shouldWrite(reply("NOPERM no permissions"))).toBe(true);
  });

  it("writes an unmarked connection failure once, and again after ready", () => {
    const policy = workerErrorPolicy(marksOf());

    expect(policy.shouldWrite(refused())).toBe(true);
    expect(policy.shouldWrite(refused())).toBe(false);

    policy.onReady();
    expect(policy.shouldWrite(refused())).toBe(true);
    expect(policy.shouldWrite(refused())).toBe(false);
  });

  it("writes an unmarked connection failure again once the window has passed", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const policy = workerErrorPolicy(marksOf());

    expect(policy.shouldWrite(refused())).toBe(true);
    vi.advanceTimersByTime(CONNECTION_FAILURE_LOG_WINDOW_MS - 1);
    expect(policy.shouldWrite(refused())).toBe(false);
    vi.advanceTimersByTime(1);
    expect(policy.shouldWrite(refused())).toBe(true);
    // And the window starts again from that line.
    vi.advanceTimersByTime(CONNECTION_FAILURE_LOG_WINDOW_MS - 1);
    expect(policy.shouldWrite(refused())).toBe(false);
  });

  it("keeps the window by the monotonic clock when the wall clock is set back", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    const policy = workerErrorPolicy(marksOf());

    expect(policy.shouldWrite(refused())).toBe(true);
    vi.setSystemTime(Date.now() - 60 * 60 * 1000);
    vi.advanceTimersByTime(CONNECTION_FAILURE_LOG_WINDOW_MS);
    expect(policy.shouldWrite(refused())).toBe(true);
  });

  it("takes a window of its own when given one", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const policy = workerErrorPolicy(marksOf(), { windowMs: 10 });

    expect(policy.shouldWrite(refused())).toBe(true);
    vi.advanceTimersByTime(10);
    expect(policy.shouldWrite(refused())).toBe(true);
  });

  it("keeps a window per instance", () => {
    // One per `Worker`: the line of one worker does not silence another.
    const marks = marksOf();
    const first = workerErrorPolicy(marks);
    const second = workerErrorPolicy(marks);

    expect(first.shouldWrite(refused())).toBe(true);
    expect(second.shouldWrite(refused())).toBe(true);
  });
});
