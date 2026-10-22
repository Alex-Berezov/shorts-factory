import { describe, expect, it } from "vitest";
import { authFailure, connectionFailure } from "../src/connection-failure.js";

/** An error of a socket the way Node raises it: a message and a `code`. */
function socketError(code: string): Error {
  return Object.assign(new Error(`connect ${code} 127.0.0.1:6379`), { code });
}

describe("connectionFailure", () => {
  it.each([
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "EPIPE",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
  ])("calls a socket that failed with %s unreachable", (code) => {
    expect(connectionFailure(socketError(code))).toBe("unreachable");
  });

  it("calls a resolver that did not answer unreachable, not a refusal", () => {
    // The name of the Redis service inside Docker while its DNS is not up:
    // nobody there yet, the same as a refused connect.
    const notYet = Object.assign(new Error("getaddrinfo EAI_AGAIN redis"), {
      code: "EAI_AGAIN",
      syscall: "getaddrinfo",
    });

    expect(connectionFailure(notYet)).toBe("unreachable");
  });

  it("calls a spent retry budget of ioredis unreachable", () => {
    const flushed = new Error(
      'Reached the max retries per request limit (which is 1). Refer to "maxRetriesPerRequest" option for details.',
    );
    flushed.name = "MaxRetriesPerRequestError";

    expect(connectionFailure(flushed)).toBe("unreachable");
  });

  it.each([
    "Connection is closed.",
    "Stream isn't writeable and enableOfflineQueue options is false",
  ])("calls the ioredis refusal %j unreachable", (message) => {
    expect(connectionFailure(new Error(message))).toBe("unreachable");
  });

  it("calls a command the client gave up waiting for a timeout", () => {
    expect(connectionFailure(new Error("Command timed out"))).toBe("timeout");
  });

  it.each([
    ["a refusal of the server", new Error("WRONGPASS invalid password")],
    ["a code of another driver", socketError("CONNECTION_CLOSED")],
    [
      "a message that only contains a known one",
      new Error("x Connection is closed."),
    ],
    ["something that is not an error", "ECONNREFUSED"],
    ["nothing", undefined],
  ])("does not classify %s", (_what, err) => {
    expect(connectionFailure(err)).toBeUndefined();
  });
});

/**
 * A refusal of the server the way ioredis raises it: a `ReplyError` (of
 * `redis-errors`, whose `name` is its class) with the reply as the message.
 * Built by hand because ioredis types its re-export of the class as `any`.
 */
function reply(message: string): Error {
  return Object.assign(new Error(message), { name: "ReplyError" });
}

describe("authFailure", () => {
  it.each([
    "WRONGPASS invalid username-password pair or user is disabled.",
    "NOAUTH Authentication required.",
  ])("calls the reply %j a refusal of the credentials", (message) => {
    const refused = reply(message);

    expect(authFailure(refused)).toBe(true);
    // The server answered: no connection failure, whatever else it is.
    expect(connectionFailure(refused)).toBeUndefined();
  });

  it.each([
    ["another reply of the server", reply("ERR unknown command")],
    [
      "a refused permission",
      reply("NOPERM User sf has no permissions to run 'info'"),
    ],
    ["a reply whose code only starts like one", reply("WRONGPASSWORD invalid")],
    ["the word further into the reply", reply("ERR WRONGPASS invalid")],
    [
      "the same text on an error that is not a reply",
      new Error("WRONGPASS invalid username-password pair"),
    ],
    ["something that is not an error", "WRONGPASS"],
    ["nothing", undefined],
  ])("does not call %s a refusal of the credentials", (_what, err) => {
    expect(authFailure(err)).toBe(false);
    expect(connectionFailure(err)).toBeUndefined();
  });
});
