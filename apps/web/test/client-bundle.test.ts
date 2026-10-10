import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BUNDLE_SENTINELS,
  SECRET_NAMES,
  bundleCheckSteps,
  findForbidden,
  runBundleCheck,
} from "../scripts/client-bundle.mjs";

const MARKERS = [...SECRET_NAMES, ...BUNDLE_SENTINELS.forbid];
const PASSWORD_SENTINEL = sentinel("ADMIN_PASSWORD");
const GEMINI_SENTINEL = sentinel("GEMINI_API_KEY");

const CHECK = fileURLToPath(
  new URL("../scripts/check-client-bundle.mjs", import.meta.url),
);

const dirs: string[] = [];

function sentinel(name: string): string {
  const value = BUNDLE_SENTINELS.env[name];
  if (value === undefined) {
    throw new Error(`no sentinel for ${name}`);
  }
  return value;
}

/**
 * An app directory with the given files under `.next`, plus an empty
 * `.next/static` and `.next/server/app` where a test does not fill them -
 * a build always has both.
 */
function app(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-web-bundle-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".next", "static"), { recursive: true });
  mkdirSync(join(dir, ".next", "server", "app"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, ".next", name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

/** An app directory with nothing built in it. */
function emptyApp(): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-web-bundle-"));
  dirs.push(dir);
  return dir;
}

/** The check as `pnpm check:bundle` runs it: a process with its exit code. */
function runCheck(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [CHECK, ...args], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

describe("findForbidden", () => {
  it("finds nothing in clean output", () => {
    const dir = app({
      "static/chunks/a.js": "console.log('hello')",
      "static/chunks/app/system/page.js": "export default 1",
      "server/app/ideas.html": "<main>Ideas</main>",
    });
    expect(findForbidden(dir, MARKERS)).toEqual([]);
  });

  it("reports the file and the marker of a leaked value, at any depth", () => {
    const dir = app({
      "static/chunks/a.js": "clean",
      "static/chunks/app/system/page-1.js": `const p="${PASSWORD_SENTINEL}";`,
    });
    expect(findForbidden(dir, MARKERS)).toEqual([
      {
        file: join(".next", "static", "chunks", "app", "system", "page-1.js"),
        marker: PASSWORD_SENTINEL,
      },
    ]);
  });

  it("reports a leaked name", () => {
    const dir = app({ "static/chunks/b.js": "env.ADMIN_PASSWORD" });
    expect(findForbidden(dir, MARKERS)).toEqual([
      {
        file: join(".next", "static", "chunks", "b.js"),
        marker: "ADMIN_PASSWORD",
      },
    ]);
  });

  it("reads every file a browser downloads from static, not only javascript", () => {
    const dir = app({ "static/css/a.css": "/* GEMINI_API_KEY */" });
    expect(findForbidden(dir, MARKERS)).toEqual([
      {
        file: join(".next", "static", "css", "a.css"),
        marker: "GEMINI_API_KEY",
      },
    ]);
  });

  it.each([
    ["server/app/ideas.html", ["server", "app", "ideas.html"]],
    ["server/app/ideas.rsc", ["server", "app", "ideas.rsc"]],
    [
      "server/app/ideas.segments/_tree.segment.rsc",
      ["server", "app", "ideas.segments", "_tree.segment.rsc"],
    ],
    ["server/app/feed.body", ["server", "app", "feed.body"]],
    ["server/app/ideas.meta", ["server", "app", "ideas.meta"]],
    ["server/pages/404.html", ["server", "pages", "404.html"]],
  ])("reads the prerendered %s", (name, parts) => {
    const dir = app({ [name]: `<p>${GEMINI_SENTINEL}</p>` });
    expect(findForbidden(dir, MARKERS)).toEqual([
      { file: join(".next", ...parts), marker: GEMINI_SENTINEL },
    ]);
  });

  it("leaves the server code alone: it names the secrets by design", () => {
    const dir = app({
      "server/app/system/page.js": "env.ADMIN_PASSWORD",
      "server/pages/_document.js": "env.DATABASE_URL",
    });
    expect(findForbidden(dir, MARKERS)).toEqual([]);
  });

  it("refuses a directory without a build instead of passing it", () => {
    expect(() => findForbidden(emptyApp(), MARKERS)).toThrow(
      /no client build output/,
    );
  });

  it("refuses a build without its prerendered app output", () => {
    const dir = app({});
    rmSync(join(dir, ".next", "server"), { recursive: true });
    expect(() => findForbidden(dir, MARKERS)).toThrow(
      /no prerendered app output/,
    );
  });
});

describe("bundle sentinels", () => {
  it("covers every server secret of the config schema", () => {
    expect(new Set(SECRET_NAMES).size).toBe(SECRET_NAMES.length);
    expect(SECRET_NAMES).toEqual(
      expect.arrayContaining([
        "ADMIN_PASSWORD",
        "API_INTERNAL_URL",
        "DATABASE_URL",
        "REDIS_URL",
        "GOOGLE_CLIENT_SECRET",
        "YOUTUBE_API_KEY",
        "GEMINI_API_KEY",
      ]),
    );
    expect(Object.keys(BUNDLE_SENTINELS.env)).toEqual([...SECRET_NAMES]);
  });

  it("looks for each sentinel the build ran with, one marker per secret", () => {
    const values = Object.values(BUNDLE_SENTINELS.env);
    expect(BUNDLE_SENTINELS.forbid).toHaveLength(values.length);
    values.forEach((value, index) => {
      const marker = BUNDLE_SENTINELS.forbid[index] ?? "";
      expect(marker).not.toBe("");
      expect(value).toContain(marker);
    });
    expect(new Set(BUNDLE_SENTINELS.forbid).size).toBe(values.length);
  });

  it("looks for the host of a URL, which outlives a rewritten URL", () => {
    expect(BUNDLE_SENTINELS.forbid).toContain(
      new URL(sentinel("DATABASE_URL")).hostname,
    );
  });

  it("gives values the config accepts in a production build", async () => {
    // Importing the config parses `process.env` on the spot.
    for (const [name, value] of Object.entries(BUNDLE_SENTINELS.env)) {
      vi.stubEnv(name, value);
    }
    const { loadEnv } = await import("@sf/config");
    const env: Record<string, unknown> = loadEnv({
      ...BUNDLE_SENTINELS.env,
      NODE_ENV: "production",
    });
    for (const [name, value] of Object.entries(BUNDLE_SENTINELS.env)) {
      expect(env[name]).toBe(value);
    }
  });
});

describe("bundleCheckSteps", () => {
  const steps = bundleCheckSteps({
    appDir: "/repo/apps/web",
    nextBin: "/repo/node_modules/next/dist/bin/next",
    scanner: "/repo/apps/web/scripts/check-client-bundle.mjs",
    callerEnv: {
      PATH: "/usr/bin",
      ADMIN_PASSWORD: "a-real-password-from-env",
      GEMINI_API_KEY: "a-real-gemini-key",
      DATABASE_URL: "postgres://u:p@db.internal:5432/sf",
    },
  });

  it("builds the app with every secret replaced by its sentinel", () => {
    expect(steps.build.args).toEqual([
      "/repo/node_modules/next/dist/bin/next",
      "build",
    ]);
    expect(steps.build.cwd).toBe("/repo/apps/web");
    for (const name of SECRET_NAMES) {
      expect(steps.build.env?.[name]).toBe(sentinel(name));
    }
    const values = Object.values(steps.build.env ?? {});
    for (const real of [
      "a-real-password-from-env",
      "a-real-gemini-key",
      "postgres://u:p@db.internal:5432/sf",
    ]) {
      expect(values).not.toContain(real);
    }
  });

  it("passes the rest of the caller's environment through", () => {
    expect(steps.build.env?.PATH).toBe("/usr/bin");
  });

  it("hands the report the sentinel of every secret the build ran with", () => {
    for (const name of SECRET_NAMES) {
      expect(steps.sentinels[name]).toBeTruthy();
      expect(steps.sentinels[name]).toBe(steps.build.env?.[name]);
    }
    expect(Object.keys(steps.sentinels)).toHaveLength(SECRET_NAMES.length);
  });

  it("scans the built app for exactly the sentinels of the build", () => {
    expect(steps.scan.args).toEqual([
      "/repo/apps/web/scripts/check-client-bundle.mjs",
      "--app-dir",
      "/repo/apps/web",
      ...BUNDLE_SENTINELS.forbid.flatMap((value) => ["--forbid", value]),
    ]);
  });
});

describe("runBundleCheck", () => {
  const steps = bundleCheckSteps({
    appDir: "/app",
    nextBin: "next",
    scanner: "scan",
    callerEnv: {},
  });

  /** Runs the check with the given exit statuses of build and scan. */
  function check(build: number | null, scan: number | null) {
    const ran: string[] = [];
    const reported: string[] = [];
    const code = runBundleCheck(
      steps,
      (step) => {
        const isBuild = step === steps.build;
        ran.push(isBuild ? "build" : "scan");
        return { status: isBuild ? build : scan };
      },
      (message) => reported.push(message),
    );
    return { code, ran, reported };
  }

  it.each([1, null])(
    "exits 2 without scanning when the build fails (%s)",
    (status) => {
      const result = check(status, 0);
      expect(result.code).toBe(2);
      expect(result.ran).toEqual(["build"]);
      expect(result.reported).toEqual([
        `next build failed (${status}), nothing to check`,
      ]);
    },
  );

  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [null, 2],
  ])("turns the scan's exit %s into %s", (scan, code) => {
    const result = check(0, scan);
    expect(result.code).toBe(code);
    expect(result.ran).toEqual(["build", "scan"]);
  });

  it("names the secret behind each sentinel on a leak", () => {
    expect(check(0, 1).reported).toContain(
      `sentinel of GEMINI_API_KEY: ${GEMINI_SENTINEL}`,
    );
    expect(check(0, 0).reported).toEqual([]);
  });

  it("names the secrets of the steps it was given, not its own", () => {
    const reported: string[] = [];
    runBundleCheck(
      { ...steps, sentinels: { SOME_KEY: "sentinel-of-some-key" } },
      (step) => ({ status: step === steps.build ? 0 : 1 }),
      (message) => reported.push(message),
    );
    expect(reported).toEqual(["sentinel of SOME_KEY: sentinel-of-some-key"]);
  });
});

describe("check-client-bundle CLI", () => {
  const forbid = BUNDLE_SENTINELS.forbid.flatMap((value) => [
    "--forbid",
    value,
  ]);

  it("passes clean output with exit 0", () => {
    const dir = app({ "static/chunks/a.js": "console.log('hello')" });
    const result = runCheck(["--app-dir", dir, ...forbid]);
    const count = SECRET_NAMES.length;
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `browser output clean of ${count * 2} markers (${count} secret names and ${count} values)`,
    );
  });

  it.each([...SECRET_NAMES])(
    "fails a chunk naming %s with exit 1, whatever values were passed",
    (name) => {
      const dir = app({ "static/chunks/a.js": `env.${name}` });
      const result = runCheck(["--app-dir", dir, "--forbid", "unrelated"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `${join(".next", "static", "chunks", "a.js")}: contains ${name}`,
      );
    },
  );

  it("fails a page carrying a value given with --forbid, with exit 1", () => {
    const url = sentinel("API_INTERNAL_URL");
    const dir = app({ "server/app/radar.html": `<a href="${url}/x">` });
    const result = runCheck(["--app-dir", dir, ...forbid]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`contains ${new URL(url).hostname}`);
  });

  it("refuses to call a build clean without values, with exit 2", () => {
    const dir = app({ "static/chunks/a.js": "console.log('hello')" });
    const result = runCheck(["--app-dir", dir]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no --forbid values");
    expect(result.stdout).toBe("");
  });

  it("exits 2 when there is no build to read", () => {
    const result = runCheck(["--app-dir", emptyApp(), ...forbid]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no client build output");
  });

  it("exits 2 on an argument it does not know", () => {
    const dir = app({ "static/chunks/a.js": "clean" });
    const result = runCheck(["--app-dir", dir, ...forbid, "--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unexpected argument: --bogus");
  });
});
