import { isAbsolute, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { EnvLike } from "../src/env-file.js";
import { loadEnv } from "../src/load-env.js";
import { repoRoot } from "../src/paths.js";
import { EnvSchema } from "../src/schema.js";
import { baseSource, envIssues, issuePaths } from "./helpers.js";

describe("loadEnv - empty values", () => {
  it("treats an empty optional value as not set", () => {
    const env = loadEnv(baseSource({ TOKEN_ENCRYPTION_KEY: "" }));

    expect(env.TOKEN_ENCRYPTION_KEY).toBeUndefined();
  });

  it("treats a blank value as not set", () => {
    const env = loadEnv(baseSource({ GEMINI_API_KEY: "   " }));

    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  it("falls back to the default when a defaulted field is empty", () => {
    const env = loadEnv(
      baseSource({ YT_UNITS_DAILY_SOFT_CAP: "", LOG_LEVEL: "" }),
    );

    expect(env.YT_UNITS_DAILY_SOFT_CAP).toBe(8000);
    expect(env.LOG_LEVEL).toBe("info");
  });
});

describe("loadEnv - surrounding whitespace", () => {
  it("trims the value before it reaches the config", () => {
    // A space kept inside the password is a password nobody can type from
    // what they see in the file.
    const env = loadEnv(
      baseSource({
        ADMIN_PASSWORD: "testtest ",
        DATABASE_URL: " postgres://sf:sf@localhost:5432/shorts_factory\t",
      }),
    );

    expect(env.ADMIN_PASSWORD).toBe("testtest");
    expect(env.DATABASE_URL).toBe(
      "postgres://sf:sf@localhost:5432/shorts_factory",
    );
  });

  it("counts the production password length after trimming", () => {
    // Fifteen spaces and one character are sixteen characters only for a
    // rule that measures the raw value.
    expect(
      issuePaths(() =>
        loadEnv(
          baseSource({
            NODE_ENV: "production",
            ADMIN_PASSWORD: `${" ".repeat(15)}x`,
          }),
        ),
      ),
    ).toContain("ADMIN_PASSWORD");
  });

  it("reads a blank required value as not set", () => {
    const issues = envIssues(() =>
      loadEnv(baseSource({ ADMIN_PASSWORD: "   " })),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path.join(".")).toBe("ADMIN_PASSWORD");
    expect(issues[0]?.message).toBe("Required");
  });

  it("trims a copy, leaving the source untouched", () => {
    const source = baseSource({ ADMIN_PASSWORD: "testtest " });
    const before = { ...source };

    loadEnv(source);

    expect(source).toEqual(before);
  });
});

describe("loadEnv - failures", () => {
  it("names the field on an invalid URL", () => {
    expect(
      issuePaths(() => loadEnv(baseSource({ DATABASE_URL: "nope" }))),
    ).toContain("DATABASE_URL");
  });

  it("names the field when ADMIN_PASSWORD is missing", () => {
    const source: EnvLike = {
      NODE_ENV: "development",
      DATABASE_URL: "postgres://sf:sf@localhost:5432/shorts_factory",
      REDIS_URL: "redis://localhost:6379",
    };

    expect(issuePaths(() => loadEnv(source))).toContain("ADMIN_PASSWORD");
  });
});

describe("loadEnv - purity", () => {
  it("mutates neither the source nor process.env", () => {
    const source = baseSource({ TOKEN_ENCRYPTION_KEY: "" });
    const before = { ...source };
    const processEnvBefore = { ...process.env };

    loadEnv(source);

    expect(source).toEqual(before);
    expect({ ...process.env }).toEqual(processEnvBefore);
  });
});

describe("loadEnv - defaults of the service variables", () => {
  it("fills in ports, internal URL, log level and concurrency", () => {
    const env = loadEnv(baseSource());

    expect(env.API_PORT).toBe(3001);
    expect(env.WEB_PORT).toBe(3000);
    expect(env.API_INTERNAL_URL).toBe("http://localhost:3001");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.WORKER_CONCURRENCY).toBe(5);
  });

  it("coerces the numeric variables", () => {
    const env = loadEnv(
      baseSource({ API_PORT: "4000", WORKER_CONCURRENCY: "8" }),
    );

    expect(env.API_PORT).toBe(4000);
    expect(env.WORKER_CONCURRENCY).toBe(8);
  });

  it("rejects a log level pino does not know", () => {
    expect(
      issuePaths(() => loadEnv(baseSource({ LOG_LEVEL: "verbose" }))),
    ).toContain("LOG_LEVEL");
  });
});

describe("loadEnv - port range", () => {
  it("rejects a port above the TCP range", () => {
    // Without the upper bound the value passes here and kills the process
    // later inside `listen` with ERR_SOCKET_BAD_PORT and no variable name.
    expect(
      issuePaths(() => loadEnv(baseSource({ API_PORT: "99999" }))),
    ).toContain("API_PORT");
    expect(
      issuePaths(() => loadEnv(baseSource({ WEB_PORT: "70000" }))),
    ).toContain("WEB_PORT");
  });

  it("accepts the highest valid port", () => {
    expect(loadEnv(baseSource({ API_PORT: "65535" })).API_PORT).toBe(65535);
  });
});

describe("loadEnv - worker concurrency range", () => {
  it("rejects a concurrency above what one queue should run", () => {
    // The value applies to every queue separately, so a typo (`50` for `5`)
    // multiplies by the number of handler queues one process runs.
    expect(
      issuePaths(() => loadEnv(baseSource({ WORKER_CONCURRENCY: "11" }))),
    ).toContain("WORKER_CONCURRENCY");
  });

  it("accepts the highest allowed concurrency", () => {
    expect(
      loadEnv(baseSource({ WORKER_CONCURRENCY: "10" })).WORKER_CONCURRENCY,
    ).toBe(10);
  });
});

describe("loadEnv - TOKEN_ENCRYPTION_KEY", () => {
  it("rejects 64 characters that are not hex", () => {
    // `Buffer.from(key, "hex")` stops at the first non-hex pair, so a
    // long-enough garbage string would encrypt with a truncated AES key.
    expect(
      issuePaths(() =>
        loadEnv(baseSource({ TOKEN_ENCRYPTION_KEY: "z".repeat(64) })),
      ),
    ).toContain("TOKEN_ENCRYPTION_KEY");
  });

  it("rejects a hex string of the wrong length", () => {
    expect(
      issuePaths(() =>
        loadEnv(baseSource({ TOKEN_ENCRYPTION_KEY: "ab".repeat(31) })),
      ),
    ).toContain("TOKEN_ENCRYPTION_KEY");
  });

  it("accepts 32 bytes of hex", () => {
    const key =
      "0123456789abcdefABCDEF0123456789abcdefABCDEF01234567890123456789";

    expect(
      loadEnv(baseSource({ TOKEN_ENCRYPTION_KEY: key })).TOKEN_ENCRYPTION_KEY,
    ).toBe(key);
  });
});

describe("loadEnv - undeclared environment", () => {
  const environmentKey = "NODE_ENV";

  /** Same source as `baseSource`, minus the environment declaration. */
  function undeclared(overrides: EnvLike = {}): EnvLike {
    const source = baseSource(overrides);
    source.NODE_ENV = undefined;
    return source;
  }

  it("falls back to production rather than development", () => {
    // A file copied to a server must not be able to claim development by
    // omission; unknown environment is the strict one.
    const env = loadEnv(undeclared({ ADMIN_PASSWORD: "1234567890123456" }));

    expect(env.NODE_ENV).toBe("production");
  });

  it("applies the production password rule", () => {
    expect(issuePaths(() => loadEnv(undeclared()))).toContain("ADMIN_PASSWORD");
  });

  it("keeps the fallback inside the parsed config, out of process.env", () => {
    // Mirroring the default back into `process.env.NODE_ENV` would flip every
    // library that reads it directly (and the vitest fixture that purges it).
    // The key is indexed, not dotted: assigning `undefined` to it - the fix
    // biome suggests for `delete` - would store the string "undefined".
    const shellValue = process.env[environmentKey];
    delete process.env[environmentKey];

    try {
      loadEnv(undeclared({ ADMIN_PASSWORD: "1234567890123456" }));

      expect(process.env[environmentKey]).toBeUndefined();
    } finally {
      if (shellValue === undefined) {
        delete process.env[environmentKey];
      } else {
        process.env[environmentKey] = shellValue;
      }
    }
  });
});

describe("loadEnv - MEDIA_DIR", () => {
  it("resolves a relative path against the repository root", () => {
    const env = loadEnv(baseSource({ MEDIA_DIR: "./data/media-test" }));

    expect(isAbsolute(env.MEDIA_DIR)).toBe(true);
    expect(env.MEDIA_DIR).toBe(resolve(repoRoot, "data/media-test"));
  });

  it("resolves the default the same way", () => {
    const env = loadEnv(baseSource());

    expect(env.MEDIA_DIR).toBe(resolve(repoRoot, "data/media"));
  });

  it("keeps an absolute path as is", () => {
    const absolute = resolve("/data/media");

    expect(loadEnv(baseSource({ MEDIA_DIR: absolute })).MEDIA_DIR).toBe(
      absolute,
    );
  });
});

describe("loadEnv - ADMIN_PASSWORD in production", () => {
  it("rejects a password shorter than 16 characters", () => {
    const paths = issuePaths(() =>
      loadEnv(
        baseSource({
          NODE_ENV: "production",
          ADMIN_PASSWORD: "123456789012345",
        }),
      ),
    );

    expect(paths).toContain("ADMIN_PASSWORD");
  });

  it("accepts a password of 16 characters", () => {
    const env = loadEnv(
      baseSource({
        NODE_ENV: "production",
        ADMIN_PASSWORD: "1234567890123456",
      }),
    );

    expect(env.ADMIN_PASSWORD).toBe("1234567890123456");
  });

  it("keeps the fixture password valid in test", () => {
    // `.env.test` ships an eight-character password: the production rule must
    // stay out of the way of every other environment.
    expect(() =>
      loadEnv(baseSource({ NODE_ENV: "test", ADMIN_PASSWORD: "testtest" })),
    ).not.toThrow();
  });
});

describe("EnvSchema", () => {
  it("stays a plain object schema so the vitest fixture can list its keys", () => {
    // The cross-field rule lives in `load-env.ts` on a derived schema: a
    // refinement here would drop `.shape`, and the fixture would silently
    // stop purging `process.env`.
    const keys = Object.keys(EnvSchema.shape);

    expect(keys).toContain("ADMIN_PASSWORD");
    expect(keys).toContain("GEMINI_API_KEY");
    expect(keys).toContain("API_PORT");
  });
});
