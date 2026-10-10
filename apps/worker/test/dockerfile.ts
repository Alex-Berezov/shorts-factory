import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The one reader of the Dockerfiles of `infra/docker` for the tests of this
 * package: which images there are, where the repository root is, and the
 * stages of a Dockerfile with their instructions.
 *
 * Enough of the Dockerfile grammar for the images of this repository: comment
 * lines (also inside a continued instruction), continuation lines, `FROM`
 * with flags (`--platform=...`) and `AS`. Not supported, and not used by the
 * images: heredocs (`RUN <<EOF`), a `FROM` image given by a build argument
 * (`FROM ${BASE}` is read as the literal text), a custom escape character
 * (`# escape=` directive).
 */

/** The repository root, with a trailing separator. */
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const DOCKER_DIR = `${ROOT}infra/docker/`;
const SUFFIX = ".Dockerfile";

/** Every image the repository has a Dockerfile for, sorted by name. */
export function imagesOf(): string[] {
  return readdirSync(DOCKER_DIR)
    .filter((name) => name.endsWith(SUFFIX))
    .map((name) => name.slice(0, -SUFFIX.length))
    .sort();
}

/** Absolute path of the Dockerfile of `image`. */
export function dockerfilePath(image: string): string {
  return `${DOCKER_DIR}${image}${SUFFIX}`;
}

export interface Stage {
  /** Lower-cased `AS` name; the index as a string for a stage without one. */
  name: string;
  instructions: string[];
}

const FROM_LINE = /^FROM\s+(?:--\S+\s+)*\S+(?:\s+AS\s+(\S+))?$/i;

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
        name: (from[1] ?? String(stages.length)).toLowerCase(),
        instructions: [],
      });
      continue;
    }
    stages.at(-1)?.instructions.push(line);
  }
  return stages;
}

/** The stages of the Dockerfile of `image`. */
export function stagesOfImage(image: string): Stage[] {
  return parseDockerfile(readFileSync(dockerfilePath(image), "utf8"));
}
