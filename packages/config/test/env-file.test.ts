import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EnvLike,
  VITEST_MARKER,
  bootstrapEnv,
  mergeEnvFile,
  overrideEnvFile,
  readEnvFile,
} from "../src/env-file.js";
import { rootEnvFilePath } from "../src/paths.js";

describe("readEnvFile", () => {
  it("returns undefined for a missing file", () => {
    const missing = join(dirname(rootEnvFilePath), "no-such-file.env");

    expect(readEnvFile(missing)).toBeUndefined();
  });

  it("rethrows failures other than a missing file", () => {
    // A directory is not a missing file: staying silent here would boot the
    // app on defaults while the operator believes the config was applied.
    expect(() => readEnvFile(dirname(rootEnvFilePath))).toThrow();
  });
});

describe("mergeEnvFile", () => {
  it("keeps values already set in the target", () => {
    const target: EnvLike = { DATABASE_URL: "from-shell" };

    mergeEnvFile("DATABASE_URL=from-file\nREDIS_URL=from-file\n", target);

    expect(target.DATABASE_URL).toBe("from-shell");
    expect(target.REDIS_URL).toBe("from-file");
  });

  it("treats an empty process value as not set and takes the file value", () => {
    // `KEY=${KEY}` in compose with no host variable, or an exported but empty
    // shell variable: the process defines the key with nothing in it. If the
    // merge counted that as a value, the real one from the file would be
    // shadowed and then dropped by `normalizeValues` - the config would end up
    // unset with no error anywhere.
    const target: EnvLike = { GEMINI_API_KEY: "", TOKEN_ENCRYPTION_KEY: "   " };

    mergeEnvFile("GEMINI_API_KEY=real-key\nTOKEN_ENCRYPTION_KEY=abc\n", target);

    expect(target.GEMINI_API_KEY).toBe("real-key");
    expect(target.TOKEN_ENCRYPTION_KEY).toBe("abc");
  });

  it("does not fill a key with an empty file value", () => {
    const target: EnvLike = {};

    mergeEnvFile("GEMINI_API_KEY=\n", target);

    expect(target.GEMINI_API_KEY).toBeUndefined();
  });
});

describe("overrideEnvFile", () => {
  it("purges the given keys and applies the file", () => {
    const target: EnvLike = {
      GEMINI_API_KEY: "real",
      DATABASE_URL: "from-shell",
      PATH: "x",
    };

    overrideEnvFile("DATABASE_URL=from-file\n", target, [
      "GEMINI_API_KEY",
      "DATABASE_URL",
    ]);

    expect(target.GEMINI_API_KEY).toBeUndefined();
    expect(target.DATABASE_URL).toBe("from-file");
    expect(target.PATH).toBe("x");
  });
});

describe("bootstrapEnv", () => {
  let tempDir = "";
  let filePath = "";

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sf-bootstrap-"));
    filePath = join(tempDir, "sample.env");
    writeFileSync(
      filePath,
      "DATABASE_URL=from-file\nGEMINI_API_KEY=file-key\n",
    );
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("skips the file entirely under vitest", () => {
    // The fixture purges schema keys from `process.env`; a developer's local
    // `.env` refilling them here would send unit tests to paid APIs with live
    // credentials - the defect E0-02 closed.
    const target: EnvLike = { VITEST: VITEST_MARKER };

    bootstrapEnv(target, filePath);

    expect(target.DATABASE_URL).toBeUndefined();
    expect(target.GEMINI_API_KEY).toBeUndefined();
  });

  it("fills only what the process leaves unset", () => {
    const target: EnvLike = { DATABASE_URL: "from-shell" };

    bootstrapEnv(target, filePath);

    expect(target.DATABASE_URL).toBe("from-shell");
    expect(target.GEMINI_API_KEY).toBe("file-key");
  });

  it("is a no-op when the file does not exist", () => {
    const target: EnvLike = {};

    bootstrapEnv(target, join(tempDir, "no-such-file.env"));

    expect(Object.keys(target)).toEqual([]);
  });

  it("defaults to the repository root file", () => {
    // Vitest and turbo both run tasks from the package directory, so a
    // cwd-based lookup would miss the root file entirely. The expectation is
    // derived from this test module, independently of `process.cwd()`.
    const rootFromTest = fileURLToPath(new URL("../../../", import.meta.url));

    expect(rootEnvFilePath).toBe(resolve(rootFromTest, ".env"));
    expect(existsSync(join(rootFromTest, "pnpm-workspace.yaml"))).toBe(true);
  });
});
