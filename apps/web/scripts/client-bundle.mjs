import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import SERVER_SECRET_KEYS from "@sf/config/server-secrets" with {
  type: "json",
};

/**
 * Server-only names that have no business in a browser: every secret of the
 * config schema, from the one list `@sf/config` keeps next to it.
 *
 * @type {readonly string[]}
 */
export const SECRET_NAMES = SERVER_SECRET_KEYS;

/**
 * Prefix of the plain sentinels. Short, so that the name after it fits in 32
 * bytes and the hex of the whole stays distinct for every secret.
 */
const PLAIN_SENTINEL_PREFIX = "sfbs-";

/** Length of a plain sentinel: the 64 hex digits of a 32-byte key. */
const PLAIN_SENTINEL_LENGTH = 64;

/**
 * A value no real deployment has, in a shape the config schema accepts for
 * the secret: a URL on a host of its own for `*_URL`, 64 hex digits for the
 * rest - long enough for the production password rule and the shape of
 * `TOKEN_ENCRYPTION_KEY`, and a plain string for every api key.
 *
 * @param {string} name
 * @returns {string}
 */
export function sentinelFor(name) {
  const slug = name.toLowerCase().replaceAll("_", "-");
  if (name.endsWith("_URL")) {
    return `http://sf-bundle-sentinel-${slug}:3999`;
  }
  return Buffer.from(`${PLAIN_SENTINEL_PREFIX}${slug}`, "utf8")
    .toString("hex")
    .padEnd(PLAIN_SENTINEL_LENGTH, "0");
}

/**
 * What the scan looks for when the build ran with `value`: the host alone for
 * a URL, which survives a URL that got normalised or split on its way into a
 * chunk, and the value whole otherwise.
 *
 * @param {string} value
 * @returns {string}
 */
function markerOf(value) {
  return URL.canParse(value) ? new URL(value).hostname : value;
}

/**
 * What the check builds with and then looks for. `env` replaces each secret
 * with its sentinel, so a value inlined into the output is found by it;
 * `forbid` is derived from `env`, so the two cannot disagree.
 *
 * @param {readonly string[]} names
 * @returns {{ env: Record<string, string>; forbid: string[] }}
 */
export function bundleSentinels(names) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const name of names) {
    env[name] = sentinelFor(name);
  }
  return { env, forbid: Object.values(env).map(markerOf) };
}

export const BUNDLE_SENTINELS = bundleSentinels(SECRET_NAMES);

/**
 * The parts of a Next build that reach a browser, relative to the app.
 * `required` ones must exist: a check that passes because there was nothing
 * to read would pass forever after a renamed output directory or a build that
 * never ran. The pages router output exists only when Next writes its own
 * error pages there.
 *
 * - `.next/static`: every file, served as is - chunks, css, media.
 * - `.next/server/app`, `.next/server/pages`: prerendered pages - the HTML,
 *   the RSC payload, a route handler body and the headers stored with them.
 *   The server code next to them is not read: it names the secrets by design.
 */
const BROWSER_OUTPUT = [
  {
    dir: [".next", "static"],
    required: true,
    accepts: () => true,
    missing: "no client build output",
  },
  {
    dir: [".next", "server", "app"],
    required: true,
    accepts: isPrerender,
    missing: "no prerendered app output",
  },
  {
    dir: [".next", "server", "pages"],
    required: false,
    accepts: isPrerender,
    missing: "no prerendered pages output",
  },
];

/**
 * @param {string} name
 * @returns {boolean}
 */
function isPrerender(name) {
  return [".html", ".rsc", ".body", ".meta"].some((ext) => name.endsWith(ext));
}

/**
 * Looks for markers in what a Next build serves to a browser (see
 * `BROWSER_OUTPUT`). A name or a value of a server secret found there is a
 * leak.
 *
 * @param {string} appDir directory of the app that was built
 * @param {readonly string[]} markers strings that must not appear
 * @returns {{ file: string; marker: string }[]} one entry per file and marker
 */
export function findForbidden(appDir, markers) {
  /** @type {{ file: string; marker: string }[]} */
  const findings = [];
  for (const output of BROWSER_OUTPUT) {
    const root = join(appDir, ...output.dir);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      if (output.required) {
        throw new Error(`${output.missing} at ${root}; run next build first`);
      }
      continue;
    }
    for (const file of listFiles(root, output.accepts)) {
      const text = readFileSync(file, "utf8");
      for (const marker of markers) {
        if (marker !== "" && text.includes(marker)) {
          findings.push({ file: relative(appDir, file), marker });
        }
      }
    }
  }
  return findings;
}

/**
 * Every file under a directory whose name is accepted, depth first.
 *
 * @param {string} dir
 * @param {(name: string) => boolean} accepts
 * @returns {string[]}
 */
function listFiles(dir, accepts) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path, accepts));
    } else if (entry.isFile() && accepts(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

/**
 * @typedef {{ args: string[]; cwd?: string; env?: Record<string, string | undefined> }} Step
 * @typedef {{ build: Step; scan: Step; sentinels: Record<string, string> }} BundleCheckSteps
 *   `sentinels` maps each secret to the value the build ran with, so the
 *   report of a leak names the secrets of these steps and no others.
 */

/**
 * The two steps of `pnpm check:bundle`, as arguments to node: `next build`
 * with the sentinels in place of the secrets, then the scan for the names and
 * for those sentinels. Pure, so what the build gets is tested without
 * running one.
 *
 * The caller's environment is passed through with every secret replaced: the
 * config does not overwrite variables already set, so the sentinels win over
 * any `.env`, and a real value never reaches the build.
 *
 * @param {{ appDir: string; nextBin: string; scanner: string; callerEnv: Record<string, string | undefined> }} input
 * @returns {BundleCheckSteps}
 */
export function bundleCheckSteps({ appDir, nextBin, scanner, callerEnv }) {
  return {
    build: {
      args: [nextBin, "build"],
      cwd: appDir,
      env: { ...callerEnv, ...BUNDLE_SENTINELS.env },
    },
    scan: {
      args: [
        scanner,
        "--app-dir",
        appDir,
        ...BUNDLE_SENTINELS.forbid.flatMap((value) => ["--forbid", value]),
      ],
    },
    sentinels: { ...BUNDLE_SENTINELS.env },
  };
}

/**
 * Runs the steps and gives the exit code of the check: the scan's (0 clean,
 * 1 leak, 2 nothing to check), and 2 when the build fails or the scan dies
 * without one - there is nothing to call clean. On a leak it also says which
 * secret each sentinel stands for: the scan only knows the values.
 *
 * @param {BundleCheckSteps} steps
 * @param {(step: Step) => { status: number | null }} run
 * @param {(message: string) => void} report
 * @returns {number}
 */
export function runBundleCheck(steps, run, report) {
  const build = run(steps.build);
  if (build.status !== 0) {
    report(`next build failed (${build.status}), nothing to check`);
    return 2;
  }
  const status = run(steps.scan).status ?? 2;
  if (status === 1) {
    for (const [name, value] of Object.entries(steps.sentinels)) {
      report(`sentinel of ${name}: ${markerOf(value)}`);
    }
  }
  return status;
}
