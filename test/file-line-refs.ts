/**
 * A decision record outlives the line numbers of the files it points at: a
 * reference `file:line` into the repository reads as the place of a decision
 * and, after the next edit of that file, points at a line about something
 * else. The records in `docs/adr/` name a symbol instead - a script, a key, a
 * function, a step - and this is the lock on that.
 *
 * A reference is a path followed by `:<line>` (or a range) whose path is a
 * file of the repository: the whole path from the root
 * (`apps/api/package.json:7`, `turbo.json:12`), or its tail from any directory
 * (`src/cli/migrate.ts:12`, from the root of `@sf/db`), with or without a
 * leading `./` or `../` (`./apps/api/package.json:7`). The files of the
 * repository are the list git gives, so a new top directory needs no edit
 * here. A file of a library (`fastify.js:134`, `lib/handle-request.js:35`), a
 * host and port (`localhost:5432`) and a url are not files of the repository
 * and pass.
 */
const PATH_AND_LINE =
  /(?<![\w./@:-])((?:[\w.@-]+\/)*[\w.@-]+):\d+(?:-\d+)?(?![\w/])/g;

/** The `file:line` references into the repository in `text`; `files` - its files from the root. */
export function fileLineRefs(text: string, files: readonly string[]): string[] {
  const known = new Set(files);
  const isRepoFile = (written: string): boolean => {
    // `./x` and `../x` name the same file as `x` from wherever the reader is.
    const path = written.replace(/^(?:\.\.?\/)+/, "");
    return known.has(path) || files.some((file) => file.endsWith(`/${path}`));
  };
  return Array.from(text.matchAll(PATH_AND_LINE))
    .filter((match) => match[1] !== undefined && isRepoFile(match[1]))
    .map((match) => match[0]);
}
