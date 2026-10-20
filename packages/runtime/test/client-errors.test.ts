import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { markClientErrors } from "../src/client-errors.js";

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
});
