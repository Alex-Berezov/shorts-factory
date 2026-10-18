import { join, relative } from "node:path";
import { repoRoot } from "../scripts/lib/paths.mjs";
import { readRepoFile, repoFilesUnder } from "./repo-files.js";

/**
 * The one reader of the Dockerfiles of `infra/docker` for the root project:
 * which images there are and the stages of a Dockerfile with their
 * instructions. Nothing else in the repository parses a Dockerfile.
 */

const DOCKER_DIR = join(repoRoot, "infra", "docker");
const SUFFIX = ".Dockerfile";

/**
 * Every image the repository has a Dockerfile for, sorted by name: the
 * Dockerfiles at the top of `infra/docker` among the files the hash covers
 * (`repoFilesUnder`), so an ignored one is not an image.
 */
export function imagesOf(): string[] {
  const dir = "infra/docker/";
  return repoFilesUnder(dir)
    .map((path) => path.slice(dir.length))
    .filter((name) => !name.includes("/") && name.endsWith(SUFFIX))
    .map((name) => name.slice(0, -SUFFIX.length))
    .sort();
}

/** Absolute path of the Dockerfile of `image`. */
export function dockerfilePath(image: string): string {
  return join(DOCKER_DIR, `${image}${SUFFIX}`);
}

export interface Stage {
  /** Lower-cased `AS` name; the index as a string for a stage without one. */
  name: string;
  instructions: string[];
}

const FROM_LINE = /^FROM\s+(?:--\S+\s+)*\S+(?:\s+AS\s+(\S+))?$/i;

/**
 * The stages of a Dockerfile, each with its instructions as logical lines,
 * in order.
 *
 * Grammar read: comment lines (a line whose first non-blank character is
 * `#`, also inside a continued instruction - Docker drops them there too);
 * continuation lines (a `\` at the end of a line, blanks after it allowed),
 * joined with a space into one instruction; blank lines; `FROM` with flags
 * (`--platform=...`) and an optional `AS name`. Instructions before the first
 * `FROM` (`ARG`) belong to no stage and are dropped.
 *
 * Not supported, and not used by the images of this repository: heredocs
 * (`RUN <<EOF`), a `FROM` image given by a build argument (`FROM ${BASE}` is
 * read as the literal text), a custom escape character (`# escape=`
 * directive), a parser directive other than as a comment line.
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
  return parseDockerfile(
    readRepoFile(relative(repoRoot, dockerfilePath(image))),
  );
}
