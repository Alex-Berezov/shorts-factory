import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type EnvLike, mergeEnvFile, readEnvFile } from "../src/env-file.js";
import { loadEnv } from "../src/load-env.js";
import { repoRoot } from "../src/paths.js";
import { EnvSchema } from "../src/schema.js";
import { issuePaths } from "./helpers.js";

/** What an operator types into the copy before starting anything. */
const OPERATOR_PASSWORD = "0123456789abcdef";

/**
 * The DoD case "a copy of .env.example boots the services" without creating a
 * repository `.env`: the example text goes through the whole runtime chain
 * (read file -> apply onto an empty env map -> parse) from a throwaway copy
 * in the OS temp directory.
 */
describe(".env.example", () => {
  const examplePath = join(repoRoot, ".env.example");
  let tempDir = "";
  let copyPath = "";

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sf-config-"));
    copyPath = join(tempDir, "example.env");
    writeFileSync(copyPath, readFileSync(examplePath, "utf8"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * The copy merged onto a process env map. Overrides stand for values the
   * operator exported before the copy is read, which is why they win: the
   * runtime merge only fills what the process leaves unset.
   */
  function sourceFromCopy(overrides: EnvLike = {}): EnvLike {
    const text = readEnvFile(copyPath);
    expect(text).toBeDefined();

    const target: EnvLike = { ...overrides };
    mergeEnvFile(text ?? "", target);

    return target;
  }

  /** The copy as an operator leaves it: the required secret filled in. */
  function loadFilledCopy(overrides: EnvLike = {}): ReturnType<typeof loadEnv> {
    return loadEnv(
      sourceFromCopy({ ADMIN_PASSWORD: OPERATOR_PASSWORD, ...overrides }),
    );
  }

  it("stops on the empty required secret and on nothing else", () => {
    // The template ships `ADMIN_PASSWORD=` like every other secret, so an
    // untouched copy must fail - loudly and by name, not boot with a password
    // taken from a public repository. A single issue is the D2 assertion too:
    // every other key of the template, empty optionals included, passed.
    expect(
      issuePaths(
        () => loadEnv(sourceFromCopy()),
        "expected the untouched copy to be rejected",
      ),
    ).toEqual(["ADMIN_PASSWORD"]);
  });

  it("parses as production once the password is set", () => {
    // No `NODE_ENV` in the template: an undeclared machine is production, and
    // the 16-character rule is what the copy has just satisfied.
    const env = loadFilledCopy();

    expect(env.NODE_ENV).toBe("production");
    expect(env.ADMIN_PASSWORD).toBe(OPERATOR_PASSWORD);
  });

  it("parses with a short password once development is declared", () => {
    const env = loadFilledCopy({
      NODE_ENV: "development",
      ADMIN_PASSWORD: "devlocal",
    });

    expect(env.NODE_ENV).toBe("development");
    expect(env.ADMIN_PASSWORD).toBe("devlocal");
  });

  it("reads an empty key as not set instead of failing its format check", () => {
    const env = loadFilledCopy();

    expect(env.TOKEN_ENCRYPTION_KEY).toBeUndefined();
    expect(env.YOUTUBE_API_KEY).toBeUndefined();
  });

  it("carries the documented values and defaults", () => {
    const env = loadFilledCopy();

    expect(env.YT_UNITS_DAILY_SOFT_CAP).toBe(8000);
    expect(env.API_PORT).toBe(3001);
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("documents every key the schema knows and no other", () => {
    expect(
      exampleDrift(
        readFileSync(examplePath, "utf8"),
        Object.keys(EnvSchema.shape),
      ),
    ).toEqual({ undocumented: [], unknown: [], unreadable: [] });
  });
});

describe("exampleDrift", () => {
  const schemaKeys = ["DATABASE_URL", "NODE_ENV", "GEMINI_API_KEY"];

  it("reads a key from an assignment, set or kept commented out", () => {
    expect(
      exampleDrift(
        "DATABASE_URL=postgres://x\n# NODE_ENV=development\nGEMINI_API_KEY=\r\n",
        schemaKeys,
      ),
    ).toEqual({ undocumented: [], unknown: [], unreadable: [] });
  });

  it("names a schema key the example only mentions in a note", () => {
    // The schema gained a key, the example got a note instead of a line:
    // the operator sees no variable to set, so the key is not documented.
    expect(
      exampleDrift(
        "DATABASE_URL=\n# NODE_ENV=development\n# GEMINI_API_KEY is not needed yet\n",
        schemaKeys,
      ),
    ).toEqual({
      undocumented: ["GEMINI_API_KEY"],
      unknown: [],
      unreadable: [],
    });
  });

  it("names an example key the schema does not know", () => {
    // A misspelt or retired key: the operator fills it in, nothing reads it.
    expect(
      exampleDrift(
        "DATABASE_URL=\n# NODE_ENV=development\nGEMINI_API_KEY=\nGEMINI_API_KYE=\n",
        schemaKeys,
      ),
    ).toEqual({
      undocumented: [],
      unknown: ["GEMINI_API_KYE"],
      unreadable: [],
    });
  });

  it("names a line it cannot read as an assignment instead of passing it over", () => {
    // `export KEY=` or a key in lower case documents nothing this reading can
    // see: skipped, a misspelt key there would never be reported.
    expect(
      exampleDrift(
        "DATABASE_URL=\n# NODE_ENV=x\nexport GEMINI_API_KEY=\ngemini_api_kye=\n",
        schemaKeys,
      ),
    ).toEqual({
      undocumented: ["GEMINI_API_KEY"],
      unknown: [],
      unreadable: ["export GEMINI_API_KEY=", "gemini_api_kye="],
    });
  });

  it("reads no key from prose that quotes an assignment", () => {
    expect(
      exampleDrift(
        'DATABASE_URL=\n# NODE_ENV=x\nGEMINI_API_KEY=\n# Quotes are stripped (`KEY="a b"`).\n',
        schemaKeys,
      ),
    ).toEqual({ undocumented: [], unknown: [], unreadable: [] });
  });
});

/**
 * How an env example and the schema disagree, both ways. A key kept commented
 * out (`# NODE_ENV=development`) still counts as documented: the operator sees
 * it and its value. A comment that only mentions a name (`# KEY is not needed
 * yet`) assigns nothing and documents nothing. A line that is neither blank,
 * a comment nor `KEY=` is `unreadable` - reported, not passed over (L-028).
 */
function exampleDrift(
  text: string,
  schemaKeys: readonly string[],
): { undocumented: string[]; unknown: string[]; unreadable: string[] } {
  const documented = new Set<string>();
  const unreadable: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const key = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    if (key !== undefined) {
      documented.add(key);
    } else if (line.trim() !== "" && !line.trimStart().startsWith("#")) {
      unreadable.push(line);
    }
  }
  const known = new Set(schemaKeys);

  return {
    undocumented: schemaKeys.filter((key) => !documented.has(key)),
    unknown: [...documented].filter((key) => !known.has(key)),
    unreadable,
  };
}
