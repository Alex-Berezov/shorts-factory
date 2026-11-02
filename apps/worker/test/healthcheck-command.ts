import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dirname, join } from "node:path/posix";
import { repoRoot } from "@sf/config/paths";
import {
  type DevCommandParts,
  devCommandParts,
} from "@sf/runtime/test-support/dev-command";
import { parseAllDocuments } from "yaml";

/**
 * The healthcheck command of the worker as the Compose files of the
 * repository give it (`compose.yaml` -> `include` -> service `worker` ->
 * `healthcheck.test`), taken apart for `fork`: the flags of node and the
 * script (`DevCommandParts` of the runtime). The integration test of the
 * healthcheck runs the CLI with these, so a change of the flags in Compose
 * changes what the test runs, with no second copy of them to forget. The flags
 * are not locked here: a harmless change of them passes. What locks them is the
 * `compose` gate (`node scripts/check-compose.mjs`, rule 4,
 * `WORKER_HEALTHCHECK` of `scripts/compose-rules.mjs`, which compares the
 * argv whole; `test/compose-rules.test.ts` holds the rule itself on a
 * fixture). Here a command of any other shape is refused rather than guessed
 * at; the script is whatever Compose names.
 */

/** The entry file the Compose files are read from, relative to the repository root. */
const COMPOSE_ENTRY = "compose.yaml";
/** The most aliases a value expands, as the parser counts them. */
const MAX_ALIAS_COUNT = 100;

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The one document of a YAML text, built into plain values; anything else
 * (no document, several, an error or a warning of the parser, aliases past
 * the limit) throws with the file and the code of the fault, never with a
 * value read in part. `<<` is expanded, as Compose does.
 */
function parseYaml(file: string, text: string): unknown {
  const [doc, ...more] = parseAllDocuments(text, { merge: true });
  if (doc === undefined) {
    throw new Error(`${file}: the file has no YAML document`);
  }
  if (more.length > 0) {
    throw new Error(`${file}: ${more.length + 1} YAML documents, expected one`);
  }
  const notes = [...doc.errors, ...doc.warnings];
  if (notes.length > 0) {
    const where = notes
      .map((note) => `${note.code} at line ${note.linePos?.[0].line ?? "?"}`)
      .join(", ");
    throw new Error(`${file}: YAML fault - ${where}`);
  }
  try {
    return doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${file}: YAML value cannot be built - ${reason}`, {
      cause,
    });
  }
}

/** The files `compose.yaml` pulls in with `include`, as paths from the root. */
function includedFiles(entry: string, document: unknown): string[] {
  if (!isMapping(document)) {
    throw new Error(`${entry}: the document is not a mapping`);
  }
  const include = document.include;
  if (include === undefined || include === null) return [];
  if (!Array.isArray(include)) {
    throw new Error(`${entry}: include form is not a list of paths`);
  }
  return include.map((item: unknown) => {
    if (typeof item !== "string") {
      throw new Error(`${entry}: include form is not a plain path`);
    }
    return join(dirname(entry), item);
  });
}

/** The `healthcheck.test` of the worker service, as the array it must be. */
function testOf(file: string, worker: unknown): string[] {
  if (!isMapping(worker) || !isMapping(worker.healthcheck)) {
    throw new Error(`${file}: service worker has no healthcheck`);
  }
  const { healthcheck } = worker;
  if (healthcheck.disable === true) {
    throw new Error(`${file}: the healthcheck of the worker is disabled`);
  }
  const test = healthcheck.test;
  if (!Array.isArray(test)) {
    const kind =
      test === undefined
        ? "missing"
        : test === null
          ? "null"
          : `a ${typeof test}`;
    throw new Error(
      `${file}: healthcheck.test is not an array of strings (it is ${kind})`,
    );
  }
  const bad = test.findIndex((item: unknown) => typeof item !== "string");
  if (bad !== -1) {
    // Only the position: a value of the command may carry a secret.
    throw new Error(
      `${file}: healthcheck.test is not an array of strings (element ${bad} is not a string)`,
    );
  }
  return test as string[];
}

/**
 * The healthcheck command of the worker in the Compose file `entry` and the
 * files it includes. `read` gives the text of a file by its path from the
 * root of the repository. Fail-closed: a service in none or in two files, a
 * healthcheck that is not `["CMD", "node", ...flags, script]` throws with the
 * reason. The script is returned as Compose names it.
 */
export function workerHealthcheckOf(
  read: (path: string) => string,
  entry: string,
): DevCommandParts {
  const entryDocument = parseYaml(entry, read(entry));
  const files = [entry, ...includedFiles(entry, entryDocument)];
  const workers: { file: string; worker: unknown }[] = [];
  for (const file of files) {
    const document =
      file === entry ? entryDocument : parseYaml(file, read(file));
    const services = isMapping(document) ? document.services : undefined;
    if (isMapping(services) && "worker" in services) {
      workers.push({ file, worker: services.worker });
    }
  }
  const [found, ...rest] = workers;
  if (found === undefined) {
    throw new Error(`${entry}: no service worker in the Compose files`);
  }
  if (rest.length > 0) {
    throw new Error(
      `${entry}: service worker is in ${workers.length} Compose files, expected one`,
    );
  }
  const test = testOf(found.file, found.worker);
  const [form, ...command] = test;
  if (form !== "CMD") {
    throw new Error(`${found.file}: healthcheck.test is not in the CMD form`);
  }
  // `devCommandParts` takes one string; an element with a space in it would
  // be split into two flags by the join, so it is refused here, by position.
  const badElement = command.findIndex(
    (part) => part === "" || /\s/.test(part),
  );
  if (badElement !== -1) {
    throw new Error(
      `${found.file}: healthcheck.test element ${badElement + 1} is empty or holds a space`,
    );
  }
  let parts: DevCommandParts;
  try {
    parts = devCommandParts(command.join(" "));
  } catch {
    // The runtime's reason names the whole command, which may carry a secret,
    // so it is neither in the text nor in `cause`.
    throw new Error(
      `${found.file}: healthcheck.test is not a node command with a script`,
    );
  }
  return parts;
}

/** The healthcheck command of the worker in the Compose files of this checkout. */
export function workerHealthcheckOfRepo(): DevCommandParts {
  return workerHealthcheckOf(
    (path) => readFileSync(resolve(repoRoot, path), "utf8"),
    COMPOSE_ENTRY,
  );
}
