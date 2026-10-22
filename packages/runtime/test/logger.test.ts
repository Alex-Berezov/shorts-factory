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

  it("walks the chain of causes of an error once for its message and its stack", () => {
    // The same output comes out of one walk or two, so the walk is counted
    // where it starts: a `cause` that is a getter on the outermost error. A
    // walk of the chain (`causesOf`) reads it once and the `cause` field may
    // read it once more; a second walk is a third read. The bound is "at most
    // one walk", not an exact count, so writing the field without reading the
    // getter again stays green.
    const bottom = new Error("bottom");
    let reads = 0;
    const outer = new Error("outer");
    Object.defineProperty(outer, "cause", {
      enumerable: false,
      get() {
        reads += 1;
        return bottom;
      },
    });
    const { log, lines } = serviceLogger();

    log.error({ err: outer }, "counted");

    expect(lines[0]?.err).toMatchObject({ message: "outer: bottom" });
    expect(reads).toBeLessThanOrEqual(2);
  });

  it("writes a chain of causes once, each link in order, down to its depth", () => {
    // The whole `err` of one line: the outermost message and stack carry every
    // link, the links themselves carry no stack, the fields of each link come
    // in one order, and the walk ends at its depth.
    const bottom = new Error("bottom");
    const member = new Error("member");
    const third = Object.assign(new Error("third", { cause: bottom }), {
      code: "E_THIRD",
    });
    const second = new AggregateError([member], "second", { cause: third });
    const first = new Error("first", { cause: second });
    const outer = new Error("outer", { cause: first });
    let deep = new Error("link 9");
    const links = [deep];
    for (let i = 8; i >= 1; i -= 1) {
      deep = new Error(`link ${i}`, { cause: deep });
      links.unshift(deep);
    }
    const deepOuter = new Error("link 0", { cause: deep });
    const { log, lines } = serviceLogger();

    log.error({ err: outer }, "a");
    log.error({ err: deepOuter }, "b");

    const chain = [first, second, third, bottom];
    expect(lines[0]?.err).toEqual({
      type: "Error",
      message: "outer: first: second: third: bottom",
      stack: [outer, ...chain]
        .map((link) => link.stack ?? "")
        .join("\ncaused by: "),
      cause: {
        type: "Error",
        message: "first",
        cause: {
          type: "AggregateError",
          message: "second",
          cause: {
            type: "Error",
            message: "third",
            code: "E_THIRD",
            cause: { type: "Error", message: "bottom" },
          },
          errors: [{ type: "Error", message: "member", stack: member.stack }],
        },
      },
    });
    const written = lines[0]?.err as Record<string, Record<string, unknown>>;
    expect(Object.keys(written)).toEqual(["type", "message", "stack", "cause"]);
    expect(Object.keys(written.cause?.cause as object)).toEqual([
      "type",
      "message",
      "cause",
      "errors",
    ]);
    expect(
      Object.keys(
        (written.cause?.cause as Record<string, unknown>).cause as object,
      ),
    ).toEqual(["type", "message", "code", "cause"]);

    // Eight links below the outermost error and not one more.
    const written8 = links.slice(0, 8);
    let expected: Record<string, unknown> | undefined;
    for (const link of [...written8].reverse()) {
      expected = {
        type: "Error",
        message: link.message,
        ...(expected === undefined ? {} : { cause: expected }),
      };
    }
    expect(lines[1]?.err).toEqual({
      type: "Error",
      message: ["link 0", ...written8.map((link) => link.message)].join(": "),
      stack: [deepOuter, ...written8]
        .map((link) => link.stack ?? "")
        .join("\ncaused by: "),
      cause: expected,
    });
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

  it.each([
    [
      "two levels below the top",
      () => ({
        a: { b: { command: { name: "auth", args: [REDIS_PASSWORD] } } },
      }),
    ],
    [
      "inside an array",
      () => ({
        failures: [
          "first",
          { command: { name: "auth", args: [REDIS_PASSWORD] } },
        ],
      }),
    ],
    [
      "on a cause that is not an error, under a key that is not err",
      () => ({
        failure: {
          message: "refused",
          cause: { command: { name: "auth", args: [REDIS_PASSWORD] } },
        },
      }),
    ],
    [
      "on an error deep under a key that is not err",
      () => ({ job: { attempt: { lastError: ioredisError() } } }),
    ],
  ])(
    "keeps the redis password of a command %s out of the log, and its name in",
    (_where, line: () => Record<string, unknown>) => {
      // `redact` reaches one level per wildcard; a command can sit at any
      // depth of what a caller logs.
      const { log, raw } = serviceLogger();

      log.error(line(), "job failed");

      expect(raw()).not.toContain(REDIS_PASSWORD);
      expect(raw()).toContain('"name":"auth"');
      expect(raw()).toContain('"args":"[Redacted]"');
    },
  );

  it("redacts a command that is the whole object of a line", () => {
    const { log, lines, raw } = serviceLogger();

    log.info({ name: "auth", args: [REDIS_PASSWORD] }, "command");

    expect(raw()).not.toContain(REDIS_PASSWORD);
    expect(lines[0]).toMatchObject({ name: "auth", args: "[Redacted]" });
  });

  it("leaves what the caller logged as it was", () => {
    const { log } = serviceLogger();
    const command = { name: "auth", args: [REDIS_PASSWORD] };
    const error = ioredisError();
    const line = { a: { b: { command } }, list: [{ command }], error };

    log.error(line, "job failed");

    expect(command.args).toEqual([REDIS_PASSWORD]);
    expect(line.a.b.command).toBe(command);
    expect(line.list[0]?.command).toBe(command);
    expect(error).toMatchObject({
      command: { name: "auth", args: [REDIS_PASSWORD] },
    });
    expect(line.error).toBe(error);
  });

  it("redacts a command met twice in a line, and one in a cycle", () => {
    const { log, lines, raw } = serviceLogger();
    const command = { name: "auth", args: [REDIS_PASSWORD] };
    const looped: Record<string, unknown> = { command };
    looped.self = looped;

    expect(() =>
      log.error({ first: { command }, second: { command }, looped }, "x"),
    ).not.toThrow();

    expect(raw()).not.toContain(REDIS_PASSWORD);
    expect(lines[0]).toMatchObject({
      first: { command: { name: "auth", args: "[Redacted]" } },
      second: { command: { name: "auth", args: "[Redacted]" } },
      looped: { command: { args: "[Redacted]" }, self: "[Circular]" },
    });
  });

  it("writes an error under another key with its class and fields", () => {
    // Copied rather than changed, and copied as what it is: what pino writes
    // of an error that is not under `err` is its enumerable fields.
    const { log, lines } = serviceLogger();

    log.error(
      { failure: Object.assign(ioredisError(), { code: "WRONGPASS" }) },
      "x",
    );

    expect(lines[0]?.failure).toEqual({
      command: { name: "auth", args: "[Redacted]" },
      code: "WRONGPASS",
    });
  });

  it("keeps args that are not a command's", () => {
    // Only the shape of a command of ioredis: a name and a list of args.
    const { log, lines } = serviceLogger();

    log.info(
      { cli: { args: ["--dry-run"] }, call: { name: "probe", args: "x" } },
      "started",
    );

    expect(lines[0]).toMatchObject({
      cli: { args: ["--dry-run"] },
      call: { name: "probe", args: "x" },
    });
  });

  /** `{ l1: { l2: ... { l<levels>: leaf } } }`: `leaf` is `levels` levels down. */
  function nested(levels: number, leaf: unknown): Record<string, unknown> {
    let value: unknown = leaf;
    for (let level = levels; level >= 1; level -= 1) {
      value = { [`l${level}`]: value };
    }
    return value as Record<string, unknown>;
  }

  it("redacts a command at the deepest level the walk goes to, and keeps its name", () => {
    const { log, raw } = serviceLogger();

    // The command is eight levels below the object of the line, the last
    // one the walk goes into.
    log.error(nested(7, { command: { name: "auth", args: [REDIS_PASSWORD] } }));

    expect(raw()).not.toContain(REDIS_PASSWORD);
    expect(raw()).toContain('"command":{"name":"auth","args":"[Redacted]"}');
  });

  it("writes a branch past the deepest level as truncated, not as it was", () => {
    // Fail closed: what the walk did not look into may hold a password.
    const { log, lines, raw } = serviceLogger();

    log.error(nested(9, { command: { name: "auth", args: [REDIS_PASSWORD] } }));

    expect(raw()).not.toContain(REDIS_PASSWORD);
    expect(lines[0]).toMatchObject(nested(9, "[Truncated]"));
  });

  it("walks again a value met first too deep to be walked whole", () => {
    // Met first at the limit, its command was cut off; met again near the
    // top, it is written whole - not with the cut of its first answer.
    const { log, lines, raw } = serviceLogger();
    const shared = {
      inner: { command: { name: "auth", args: [REDIS_PASSWORD] } },
    };

    log.error({ deep: nested(6, shared), shallow: shared }, "x");

    expect(raw()).not.toContain(REDIS_PASSWORD);
    expect(lines[0]).toMatchObject({
      deep: nested(6, { inner: { command: "[Truncated]" } }),
      shallow: { inner: { command: { name: "auth", args: "[Redacted]" } } },
    });
  });

  it.each([
    ["under a key of the line", (held: object) => ({ job: held })],
    ["deep down", (held: object) => ({ a: { b: { held } } })],
    ["inside an array", (held: object) => ({ list: ["first", held] })],
  ])(
    "keeps the redis password of a command on an instance of a class %s out of the log",
    (_where, line) => {
      // pino writes the enumerable fields of any object, an instance of a
      // class too: a `Job`, an error class of a library.
      class Holder {
        readonly id = "job-1";
        readonly command = { name: "auth", args: [REDIS_PASSWORD] };
      }
      const { log, raw } = serviceLogger();

      log.error(line(new Holder()), "x");

      expect(raw()).not.toContain(REDIS_PASSWORD);
      expect(raw()).toContain('"id":"job-1"');
      expect(raw()).toContain('"command":{"name":"auth","args":"[Redacted]"}');
    },
  );

  it("keeps the redis password of a command that is an instance of a class out of the log", () => {
    // The `Command` of ioredis is a class.
    class Command {
      readonly name = "auth";
      readonly args = [REDIS_PASSWORD];
    }
    const { log, raw } = serviceLogger();

    log.error({ a: { b: { pending: new Command() } } }, "x");

    expect(raw()).not.toContain(REDIS_PASSWORD);
    expect(raw()).toContain('"pending":{"name":"auth","args":"[Redacted]"}');
  });

  it.each([
    [
      "one level down",
      { held: { command: { name: "auth", args: ["pw-c1"] } } },
    ],
    ["at the top", { command: { name: "auth", args: ["pw-c2"] } }],
  ])(
    "keeps the redis password of a command in the bindings of a child %s out of the log",
    (_where, bindings) => {
      // pino writes the bindings of `log.child()` through `redact` and the
      // serializers, not through `formatters.log`.
      const { log, raw } = serviceLogger();

      log.child(bindings).error("x");

      expect(raw()).not.toMatch(/pw-c\d/);
      expect(raw()).toContain('"name":"auth"');
    },
  );

  it("leaves err to its serializer and walks req and res, which have none here", () => {
    // `err` has its serializer in every logger; `req` and `res` have one
    // only on the loggers of Fastify, so a worker that logs them gets the walk.
    const { formatters } = buildLoggerOptions(envWith());
    const err = ioredisError();
    const req = { command: { name: "auth", args: [REDIS_PASSWORD] } };

    const line = formatters.log({ err, req, res: { reply: req } });

    expect(line.err).toBe(err);
    expect(line.req).toEqual({ command: { name: "auth", args: "[Redacted]" } });
    expect(line.res).toEqual({
      reply: { command: { name: "auth", args: "[Redacted]" } },
    });
  });

  it.each(["req", "res"])(
    "keeps the redis password of a command under %s out of the log of a worker",
    (key) => {
      const { log, raw } = serviceLogger();

      log.error(
        {
          [key]: {
            reply: { command: { name: "auth", args: [REDIS_PASSWORD] } },
          },
        },
        "x",
      );

      expect(raw()).not.toContain(REDIS_PASSWORD);
      expect(raw()).toContain('"name":"auth"');
    },
  );

  it("hands the request of Fastify to its serializer as it is", () => {
    // An instance of a class: the walk does not enter it, the serializer of
    // the api gets the very object.
    class Request {
      readonly method = "GET";
      readonly url = "/system/status";
    }
    const { formatters } = buildLoggerOptions(envWith());
    const req = new Request();

    expect(formatters.log({ req }).req).toBe(req);
  });

  it("names the command of an error whose args are not a list", () => {
    // The name is what an operator reads; it does not depend on the args.
    const { log, lines } = serviceLogger();
    const err = Object.assign(new Error("ERR wrong number of arguments"), {
      command: { name: "get", args: "key" },
    });

    log.error({ err }, "x");

    expect(lines[0]?.err).toMatchObject({ command: { name: "get" } });
  });

  it("copies a frozen command without throwing and without its password", () => {
    const { log, raw } = serviceLogger();
    const command = Object.freeze({ name: "auth", args: [REDIS_PASSWORD] });
    const line = Object.freeze({ held: Object.freeze({ command }) });

    expect(() => log.error({ a: line }, "x")).not.toThrow();

    expect(raw()).not.toContain(REDIS_PASSWORD);
    expect(raw()).toContain('"command":{"name":"auth","args":"[Redacted]"}');
    expect(command.args).toEqual([REDIS_PASSWORD]);
  });

  it("does not reuse a [Circular] met under an ancestor that is not one here", () => {
    // `inner` walked first under `outer` points back at it, a cycle there;
    // met again under `elsewhere` at the same depth, `outer` is no ancestor
    // of it, and is written.
    const { log, lines, raw } = serviceLogger();
    const outer: Record<string, unknown> = {
      command: { name: "auth", args: [REDIS_PASSWORD] },
    };
    const inner = { back: outer };
    outer.inner = inner;

    log.error({ outer, elsewhere: { inner } }, "x");

    expect(raw()).not.toContain(REDIS_PASSWORD);
    expect(lines[0]).toMatchObject({
      outer: { inner: { back: "[Circular]" } },
      elsewhere: {
        inner: {
          back: {
            command: { name: "auth", args: "[Redacted]" },
            inner: "[Circular]",
          },
        },
      },
    });
  });

  it("reads two fields of an instance of a class by name, not all its keys", () => {
    // A `Buffer` or a typed array has a key per byte: listing them on every
    // line is a cost for nothing.
    class Payload {
      readonly bytes = [1, 2, 3];
    }
    const listed: string[] = [];
    const payload = new Proxy(new Payload(), {
      ownKeys(target) {
        listed.push("ownKeys");
        return Reflect.ownKeys(target);
      },
    });
    const { formatters } = buildLoggerOptions(envWith());

    const line = formatters.log({ payload });

    expect(line.payload).toBe(payload);
    expect(listed).toEqual([]);
  });

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
