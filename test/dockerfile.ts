import { readRepoFile } from "./repo-files.js";

/**
 * The one reader of the Dockerfile of the application for the root project:
 * which images there are - the targets of `infra/docker/app.Dockerfile` - and
 * the stages each of them is built from, with their instructions. Nothing
 * else in the repository parses a Dockerfile.
 */

/** The Dockerfile every image of the application is a target of, from the root. */
export const APP_DOCKERFILE = "infra/docker/app.Dockerfile";

export interface Stage {
  /** Lower-cased `AS` name; the index as a string for a stage without one. */
  name: string;
  /** Whether the stage has an `AS` name. */
  named: boolean;
  /** What the stage starts `FROM`, lower-cased: an image or an earlier stage. */
  from: string;
  instructions: string[];
}

const FROM_LINE = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?$/i;
const COPY_FROM = /^COPY\s(?:.*\s)?--from=(\S+)/i;
const RUN_MOUNT = /\s--mount=(\S+)/gi;

/**
 * The stages of a Dockerfile, each with its instructions as logical lines,
 * in order.
 *
 * Grammar read: comment lines (a line whose first non-blank character is
 * `#`, also inside a continued instruction - Docker drops them there too);
 * continuation lines (a `\` at the end of a line, blanks after it allowed),
 * joined with a space into one instruction; blank lines; `FROM` with flags
 * (`--platform=...`) and an optional `AS name`. Instructions before the first
 * `FROM` (`ARG`) belong to no stage and are dropped. A `FROM` image given by
 * a build argument (`FROM ${NODE_IMAGE}`) is read as the literal text,
 * lower-cased: it is never the name of a stage.
 *
 * Not supported, and not used by the images of this repository: heredocs
 * (`RUN <<EOF`), a custom escape character (`# escape=` directive), a parser
 * directive other than as a comment line.
 */
export function parseDockerfile(text: string): Stage[] {
  const logical = text
    .split(/\r?\n/)
    // Docker drops a comment line even inside a continued instruction.
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    .replace(/\\[ \t]*\r?\n/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const stages: Stage[] = [];
  for (const line of logical) {
    const from = FROM_LINE.exec(line);
    if (from !== null) {
      stages.push({
        name: (from[2] ?? String(stages.length)).toLowerCase(),
        named: from[2] !== undefined,
        from: (from[1] ?? "").toLowerCase(),
        instructions: [],
      });
      continue;
    }
    stages.at(-1)?.instructions.push(line);
  }
  return stages;
}

/**
 * What the instruction `line` takes from, as written: the `--from=` of a
 * `COPY`, and the `from=` of each `--mount=` of a `RUN`
 * (`RUN --mount=type=bind,from=<stage>,target=/x ...`).
 */
function sourcesOf(line: string): string[] {
  const copied = COPY_FROM.exec(line)?.[1];
  if (copied !== undefined) return [copied];
  if (!/^RUN\s/i.test(line)) return [];
  return Array.from(line.matchAll(RUN_MOUNT), (match) => match[1] ?? "")
    .flatMap((mount) => mount.split(","))
    .filter((option) => /^from=/i.test(option))
    .map((option) => option.slice("from=".length));
}

/**
 * The earlier stages `stage` takes from: the one it starts `FROM` and those
 * its `COPY --from=` and `RUN --mount=...,from=` name - by name, or by index
 * (`--from=0`), as Docker reads a number. An image (`node:22-alpine`) is not
 * a stage and is left out. What could be a stage and is none throws instead
 * of being taken for an image: an index no stage has, and a name without a
 * `/`, `:` or `.` - the form of a stage name, so most likely a misspelt one;
 * an image is named with its tag, registry or path.
 */
function referencesOf(stage: Stage, stages: Stage[]): string[] {
  const names = new Set(stages.map(({ name }) => name));
  const sources = stage.instructions.flatMap(sourcesOf).map((source) => {
    if (!/^\d+$/.test(source)) {
      const name = source.toLowerCase();
      if (!names.has(name) && !/[/:.]/.test(name)) {
        throw new Error(
          `stage ${stage.name} takes from ${source}, which is no stage; an image needs its tag, registry or path`,
        );
      }
      return name;
    }
    const indexed = stages[Number(source)];
    if (indexed === undefined) {
      throw new Error(
        `stage ${stage.name} takes from stage ${source}, which is not there`,
      );
    }
    return indexed.name;
  });
  return [stage.from, ...sources].filter((name) => names.has(name));
}

/**
 * The targets of a Dockerfile, sorted: the stages no `FROM <stage>`, no
 * `COPY --from=<stage>` and no `RUN --mount=...,from=<stage>` refers to -
 * what is built is what nothing else is built from.
 *
 * A file without stages, and a target without an `AS` name, throw: neither
 * can be a target Compose or CI names.
 */
export function targetsOf(stages: Stage[]): string[] {
  const used = new Set(stages.flatMap((stage) => referencesOf(stage, stages)));
  const leaves = stages.filter(({ name }) => !used.has(name));
  if (leaves.length === 0) throw new Error("the Dockerfile has no stage");
  for (const leaf of leaves) {
    if (!leaf.named) {
      throw new Error(`stage ${leaf.name} is a target without an AS name`);
    }
  }
  return leaves.map(({ name }) => name).sort();
}

/**
 * The stages `target` is built from - the target and every stage it reaches
 * through `FROM <stage>`, `COPY --from=` and `RUN --mount=...,from=`, in the
 * order of the file. An unknown target throws.
 */
export function stagesOfTarget(stages: Stage[], target: string): Stage[] {
  const byName = new Map(stages.map((stage) => [stage.name, stage]));
  if (!byName.has(target)) throw new Error(`no target "${target}"`);
  const reached = new Set<string>();
  const pending = [target];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (reached.has(name)) continue;
    reached.add(name);
    const stage = byName.get(name);
    if (stage !== undefined) pending.push(...referencesOf(stage, stages));
  }
  return stages.filter(({ name }) => reached.has(name));
}

/** The stages of the application's Dockerfile. */
function appStages(): Stage[] {
  return parseDockerfile(readRepoFile(APP_DOCKERFILE));
}

/** Every image of the application: the targets of its Dockerfile, sorted. */
export function imagesOf(): string[] {
  return targetsOf(appStages());
}

/** The stages the image `target` is built from, in the order of the file. */
export function stagesOfImage(target: string): Stage[] {
  return stagesOfTarget(appStages(), target);
}
