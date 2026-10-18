import { type Env, loadEnv } from "@sf/config";
import { AppError } from "@sf/core";
import { describe, expect, it } from "vitest";
import { LOGGED_DETAILS, buildLoggerOptions } from "../src/logger.js";
import { recordingLogger } from "../test-support/recording-logger.js";

/** A parsed config, built the way the services build it - no hand-made object. */
function envWith(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://sf:sf@localhost:5442/shorts_factory_test",
    REDIS_URL: "redis://localhost:6389/1",
    ADMIN_PASSWORD: "testtest",
    ...overrides,
  });
}

/** A recorder on the options the services build their logger from. */
function serviceLogger() {
  const { transport: _unused, ...options } = buildLoggerOptions(envWith());
  return recordingLogger(options);
}

const REDIS_PASSWORD = "sup3r-s3cret";

/** An error the way ioredis emits it: the command it failed on comes along. */
function ioredisError(): Error {
  return Object.assign(new Error("WRONGPASS invalid username-password pair"), {
    command: { name: "auth", args: [REDIS_PASSWORD] },
  });
}

describe("buildLoggerOptions", () => {
  it("takes the level from the config", () => {
    expect(buildLoggerOptions(envWith({ LOG_LEVEL: "debug" })).level).toBe(
      "debug",
    );
  });

  it("pretty-prints only in development", () => {
    expect(
      buildLoggerOptions(envWith({ NODE_ENV: "development" })).transport,
    ).toMatchObject({ target: "pino-pretty" });
  });

  it("stays on json elsewhere, where pino-pretty is not installed", () => {
    // `pino-pretty` is a devDependency: a production image that asked for the
    // transport would fail to start rather than log badly.
    expect(
      buildLoggerOptions(envWith({ NODE_ENV: "test" })).transport,
    ).toBeUndefined();
    expect(
      buildLoggerOptions(
        envWith({ NODE_ENV: "production", ADMIN_PASSWORD: "0123456789abcdef" }),
      ).transport,
    ).toBeUndefined();
  });
});

describe("the logger of a service", () => {
  it("keeps the redis password out of the log, and the command name in", () => {
    // ioredis hangs the command on the error it emits; the client of every
    // process logs the whole error on purpose.
    const { log, lines, raw } = serviceLogger();

    log.error({ err: ioredisError() }, "redis client error");

    expect(raw()).not.toContain(REDIS_PASSWORD);
    expect(raw()).toContain("WRONGPASS");
    expect(lines[0]?.err).toMatchObject({ command: { name: "auth" } });
  });

  it("keeps the password of a redis error under another key out of the log", () => {
    const { log, raw } = serviceLogger();

    log.error({ queue: "system.smoke", failure: ioredisError() }, "job failed");

    expect(raw()).not.toContain(REDIS_PASSWORD);
  });

  it.each([
    ["the first link", (inner: Error) => new Error("outer", { cause: inner })],
    [
      "the second link",
      (inner: Error) =>
        new Error("outer", { cause: new Error("middle", { cause: inner }) }),
    ],
    [
      "an enumerable cause",
      (inner: Error) => Object.assign(new Error("outer"), { cause: inner }),
    ],
  ])(
    "keeps the redis password out of a cause on %s",
    (_where, wrap: (inner: Error) => Error) => {
      // `throw new Error(msg, { cause })` around a failed command: a wildcard
      // of `redact` reaches one level, a cause can be any number deep.
      const { log, lines, raw } = serviceLogger();

      log.error({ err: wrap(ioredisError()) }, "start failed");

      expect(raw()).not.toContain(REDIS_PASSWORD);
      expect(raw()).toContain('"command":{"name":"auth"}');
      expect(lines).toHaveLength(1);
    },
  );

  it("writes neither the url nor the body of a refused http call", () => {
    // What an http client throws: the request it made, key in the url, and
    // the answer it got, whole.
    const refused = Object.assign(new Error("Request failed with 403"), {
      code: "ERR_BAD_REQUEST",
      config: { url: "https://example.test/v3/videos?key=AIza-leaked-key" },
      response: { status: 403, data: { owner: "private-channel-data" } },
    });
    const { log, lines, raw } = serviceLogger();

    log.error({ err: new Error("sync failed", { cause: refused }) }, "x");
    log.error({ err: refused }, "y");

    expect(raw()).not.toContain("AIza-leaked-key");
    expect(raw()).not.toContain("private-channel-data");
    expect(lines[1]?.err).toMatchObject({ code: "ERR_BAD_REQUEST" });
  });

  it("writes neither the query nor the parameters of a postgres error", () => {
    // postgres-js puts both on the error it raises at the `debug` level of
    // the driver; the values are user data once the app stores any.
    const refused = Object.assign(new Error("duplicate key value"), {
      name: "PostgresError",
      code: "23505",
      query: "insert into secrets values ($1)",
      parameters: ["user-private-value"],
    });
    const { log, lines, raw } = serviceLogger();

    log.error({ err: refused }, "query failed");
    log.error({ err: new Error("write failed", { cause: refused }) }, "x");

    expect(raw()).not.toContain("user-private-value");
    expect(raw()).not.toContain("insert into secrets");
    expect(lines[0]?.err).toMatchObject({ code: "23505" });
  });

  it("writes the code and the stack of an AppError, and none of its details", () => {
    // The worker and the command line tools hand their errors over as they
    // are: the details are whatever the thrower put there.
    const thrown = new AppError("YT_UNAVAILABLE", "upstream refused", 503, {
      url: "https://example.test/?key=AIza-leaked-key",
    });
    const { log, lines, raw } = serviceLogger();

    log.error({ err: thrown }, "job failed");
    log.error({ err: new Error("sync failed", { cause: thrown }) }, "x");

    expect(lines[0]?.err).toMatchObject({
      type: "AppError",
      code: "YT_UNAVAILABLE",
      httpStatus: 503,
      stack: expect.stringContaining("upstream refused"),
    });
    expect(lines[0]?.err).not.toHaveProperty("details");
    expect(lines[1]?.err).toMatchObject({
      cause: { type: "AppError", code: "YT_UNAVAILABLE" },
    });
    expect(raw()).not.toContain("AIza-leaked-key");
  });

  it("writes the details an error carries for the log, and only those", () => {
    // What `loggableError` (apps/api) hands the logger: the details a caller
    // was shown, or a marker, under a key of their own.
    const thrown = new AppError("YT_UNAVAILABLE", "upstream refused", 503, {
      url: "https://example.test/?key=AIza-leaked-key",
    });
    Object.defineProperty(thrown, LOGGED_DETAILS, { value: "[omitted]" });
    const { log, lines, raw } = serviceLogger();

    log.error({ err: thrown }, "request failed");

    expect(lines[0]?.err).toMatchObject({ details: "[omitted]" });
    expect(raw()).not.toContain("AIza-leaked-key");
  });

  it("writes the status Fastify puts on its own errors", () => {
    // A body of a type the route does not take: 415, not 500.
    const refused = Object.assign(new Error("Unsupported Media Type"), {
      code: "FST_ERR_CTP_INVALID_MEDIA_TYPE",
      statusCode: 415,
    });
    const { log, lines } = serviceLogger();

    log.error({ err: refused }, "request failed");

    expect(lines[0]?.err).toMatchObject({
      code: "FST_ERR_CTP_INVALID_MEDIA_TYPE",
      statusCode: 415,
    });
  });

  it("writes no details of an error that is not an AppError", () => {
    const foreign = Object.assign(new Error("refused"), {
      details: { token: "foreign-token" },
    });
    const { log, raw } = serviceLogger();

    log.error({ err: foreign }, "x");

    expect(raw()).not.toContain("foreign-token");
  });

  it("writes the members of an AggregateError through the same rule", () => {
    const { log, lines, raw } = serviceLogger();

    log.error(
      { err: new AggregateError([ioredisError(), new Error("second")], "all") },
      "x",
    );

    expect(raw()).not.toContain(REDIS_PASSWORD);
    expect(lines[0]?.err).toMatchObject({
      errors: [{ command: { name: "auth" } }, { message: "second" }],
    });
  });

  it("writes an error whose causes go round in a circle", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    Object.defineProperty(first, "cause", { value: second });
    const { log, lines } = serviceLogger();

    log.error({ err: first }, "circular");

    expect(lines).toHaveLength(1);
    expect(lines[0]?.msg).toBe("circular");
    // Each error once: the walk ends where the circle closes.
    expect(lines[0]?.err).toMatchObject({
      message: "first: second",
      cause: { message: "second" },
    });
    expect(lines[0]?.err).not.toHaveProperty("cause.cause");
  });

  it("keeps the redis password out of a cause that is a plain object", () => {
    // Not an error - no class, no stack - but the command rides on it all
    // the same.
    const { log, lines, raw } = serviceLogger();

    log.error(
      {
        err: new Error("start failed", {
          cause: {
            message: "refused",
            command: { name: "auth", args: [REDIS_PASSWORD] },
          },
        }),
      },
      "x",
    );

    expect(raw()).not.toContain(REDIS_PASSWORD);
    expect(lines[0]?.err).toMatchObject({
      cause: { message: "refused", command: { name: "auth" } },
    });
  });

  it("writes the stack of an error whose stack the outermost one does not carry", () => {
    // The outermost stack carries the links of its own chain; the cause of a
    // member of an AggregateError and a link past a wrapper with no message
    // are not among them, and without their own stack the place they were
    // thrown at is gone.
    const member = new Error("member", {
      cause: new Error("under the member"),
    });
    const wrapped = new Error("outer", {
      cause: { code: "WRAPPED", cause: new Error("under the wrapper") },
    });
    const chained = new Error("outer", { cause: new Error("in the chain") });
    const { log, lines } = serviceLogger();

    log.error({ err: new AggregateError([member], "all") }, "a");
    log.error({ err: wrapped }, "b");
    log.error({ err: chained }, "c");

    expect(lines[0]?.err).toMatchObject({
      errors: [
        {
          stack: expect.stringContaining("member"),
          cause: { stack: expect.stringContaining("under the member") },
        },
      ],
    });
    expect(lines[1]?.err).toMatchObject({
      cause: {
        code: "WRAPPED",
        cause: { stack: expect.stringContaining("under the wrapper") },
      },
    });
    // Already in the outermost stack: not written twice.
    expect(lines[2]?.err).toMatchObject({
      stack: expect.stringContaining("caused by: Error: in the chain"),
    });
    expect(lines[2]?.err).not.toHaveProperty("cause.stack");
  });

  it("writes a cause and members that are not objects as they are", () => {
    // `new Error(msg, { cause: "ECONNRESET" })` names its reason in a string.
    const { log, lines } = serviceLogger();

    log.error(
      { err: new Error("read failed", { cause: "ECONNRESET by the peer" }) },
      "a",
    );
    log.error(
      {
        err: new AggregateError(
          ["first refused", 42, new Error("third")],
          "all",
        ),
      },
      "b",
    );

    expect(lines[0]?.err).toMatchObject({ cause: "ECONNRESET by the peer" });
    expect(lines[1]?.err).toMatchObject({
      errors: ["first refused", 42, { message: "third" }],
    });
  });

  it("stops at its depth on a chain of causes that goes on and on", () => {
    // Not a cycle - every link is new - so only the bound ends the walk.
    let chain = new Error("the bottom: sup3r-deep-s3cret");
    for (let i = 0; i < 12; i += 1) {
      chain = new Error(`link ${i}`, { cause: chain });
    }
    const { log, lines, raw } = serviceLogger();

    log.error({ err: chain }, "deep");

    expect(lines).toHaveLength(1);
    expect(raw()).toContain("link 11");
    expect(raw()).not.toContain("sup3r-deep-s3cret");
  });

  it.each([
    ["a string", "plain text thrown"],
    ["null", null],
    ["undefined", undefined],
    [
      "a plain object with a command",
      { message: "not an error", command: { name: "auth", args: ["pw-1"] } },
    ],
    ["a cause that is null", Object.assign(new Error("x"), { cause: null })],
    [
      "a cause that is a symbol",
      Object.assign(new Error("x"), { cause: Symbol("pw-2") }),
    ],
    [
      "errors that are not an array",
      Object.assign(new Error("x"), { errors: { first: "pw-3" } }),
    ],
  ])(
    "writes %s under err without throwing and without a secret",
    (_what, err) => {
      const { log, lines, raw } = serviceLogger();

      expect(() => log.error({ err }, "odd")).not.toThrow();

      expect(lines).toHaveLength(1);
      expect(lines[0]?.msg).toBe("odd");
      for (const secret of ["pw-1", "pw-2", "pw-3"]) {
        expect(raw()).not.toContain(secret);
      }
    },
  );

  it("redacts the credentials a caller sends", () => {
    // Basic auth puts the only secret of the api into `authorization`; one
    // plugin logging the headers would write it to disk in plain base64.
    const { log, lines, raw } = serviceLogger();

    log.info(
      {
        req: { headers: { authorization: "Basic c2VjcmV0", cookie: "sid=1" } },
        res: { headers: { "set-cookie": "sid=2" } },
      },
      "dumped",
    );

    expect(lines[0]).toMatchObject({
      req: { headers: { authorization: "[Redacted]", cookie: "[Redacted]" } },
      res: { headers: { "set-cookie": "[Redacted]" } },
    });
    expect(raw()).not.toContain("c2VjcmV0");
  });
});
