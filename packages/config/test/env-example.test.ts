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

  it("documents every key the schema knows", () => {
    const text = readFileSync(examplePath, "utf8");
    const documented = new Set(
      text
        .split("\n")
        // A key kept commented out (`# NODE_ENV=development`) still counts as
        // documented: the operator sees it and its default.
        .map((line) => line.replace(/^#\s*/, "").split("=")[0]?.trim() ?? "")
        .filter((key) => key !== ""),
    );

    expect(
      [...Object.keys(EnvSchema.shape)].filter((key) => !documented.has(key)),
    ).toEqual([]);
  });
});
