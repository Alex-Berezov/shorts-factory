import { fileURLToPath } from "node:url";

import { SECRET_NAMES, findForbidden } from "./client-bundle.mjs";

/**
 * Fails when anything the last `next build` serves to a browser - client
 * chunks, prerendered pages - names a server secret or carries one of its
 * values.
 *
 *   node scripts/check-client-bundle.mjs --forbid <value>... [--app-dir <dir>]
 *
 * The names of the secrets are always checked. Values are required: a scan
 * for names alone cannot see a secret inlined by value, so it refuses to
 * call such a build clean. The values are the sentinels the build ran with -
 * `scripts/check-client-bundle-build.mjs` does both halves - and come from
 * the command line, never from the environment of this process.
 * Exit codes: 0 clean, 1 a marker found, 2 nothing to check or bad usage.
 */

/**
 * @param {string} message
 * @returns {never}
 */
function usage(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/**
 * @param {readonly string[]} args
 * @returns {{ values: string[]; appDir: string }}
 */
function parseArgs(args) {
  /** @type {string[]} */
  const values = [];
  let appDir = fileURLToPath(new URL("..", import.meta.url));
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      continue;
    }
    const value = args[i + 1];
    if (
      (arg !== "--forbid" && arg !== "--app-dir") ||
      value === undefined ||
      value === ""
    ) {
      usage(`unexpected argument: ${arg}`);
    }
    if (arg === "--forbid") {
      values.push(value);
    } else {
      appDir = value;
    }
    i += 1;
  }
  if (values.length === 0) {
    usage(
      "no --forbid values: build with sentinel secrets and pass them here, names alone do not show that a value stayed out",
    );
  }
  return { values, appDir };
}

const { values, appDir } = parseArgs(process.argv.slice(2));
const markers = [...SECRET_NAMES, ...values];

let findings;
try {
  findings = findForbidden(appDir, markers);
} catch (error) {
  usage(error instanceof Error ? error.message : String(error));
}

if (findings.length > 0) {
  for (const { file, marker } of findings) {
    process.stderr.write(`${file}: contains ${marker}\n`);
  }
  process.exit(1);
}
process.stdout.write(
  `browser output clean of ${markers.length} markers (${SECRET_NAMES.length} secret names and ${values.length} values)\n`,
);
