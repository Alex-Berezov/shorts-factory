/**
 * The id, the epic and the dependencies of a task of docs/tasks/tasks.json,
 * by one rule for the CLI that writes the file (`scripts/tasks.mjs add`) and
 * the schema of the tests that read it (`test/tracker.ts`): a value the CLI
 * writes is one the schema takes, and a value the schema refuses is refused
 * by the CLI before anything is written.
 */

/**
 * The id of a task: the epic, the number and the letters of the tasks split
 * off it (`E0-12AK`), or a task of the owner in its own words,
 * `ADHOC-<yyyymmdd>-<n>` (`.claude/commands/auto.md`). The source of a
 * pattern, in a group of its own, so that a reader looking for an id in a
 * text (`test/debt-refs.ts`) and the schema hold the same grammar.
 */
export const TASK_ID_SOURCE = "(?:E\\d+-\\d+[A-Z]*|ADHOC-\\d{8}-\\d+)";

const TASK_ID = new RegExp(`^${TASK_ID_SOURCE}$`);
const EPIC = /^(?:E\d+|ADHOC)$/;
/** The epic of the tasks of the owner, `ADHOC-<yyyymmdd>-<n>`. */
export const ADHOC = "ADHOC";

/**
 * Why `id` cannot be the id of a task, undefined if it can.
 *
 * @param {string} id
 * @returns {string | undefined}
 */
export function idProblem(id) {
  return TASK_ID.test(id)
    ? undefined
    : `id "${id}" is neither E<n>-<n>[A-Z...] nor ADHOC-<yyyymmdd>-<n>`;
}

/**
 * The epic of the task `id`, an id `idProblem` takes: the `E<n>` it starts
 * with, `ADHOC` for a task of the owner. The one rule of the epic: `add`
 * gives it by default, and `epicProblem` holds any epic given to it.
 *
 * @param {string} id
 * @returns {string}
 */
export function epicOf(id) {
  return /^E\d+(?=-)/.exec(id)?.[0] ?? ADHOC;
}

/**
 * Why `epic` cannot be the epic of the task `id`, undefined if it can: an
 * epic is `E<n>` or `ADHOC`, and it is the one `epicOf` gives the id - the
 * `E<n>` of its prefix, `ADHOC` for the `ADHOC-` ids and no other.
 *
 * @param {string} id
 * @param {string} epic
 * @returns {string | undefined}
 */
export function epicProblem(id, epic) {
  if (!EPIC.test(epic)) return `epic "${epic}" is neither E<n> nor ADHOC`;
  const own = epicOf(id);
  if (epic !== own) {
    return `epic ${epic} does not go with the id ${id}: the epic of a task is the E<n> its id starts with, ADHOC that of the ADHOC-<yyyymmdd>-<n> tasks - here ${own}`;
  }
  return undefined;
}

/**
 * The dependencies of a task that are not tasks of the tracker.
 *
 * @param {readonly string[]} deps
 * @param {ReadonlySet<string>} ids the ids of the tracker
 * @returns {string[]}
 */
export function missingDeps(deps, ids) {
  return deps.filter((dep) => !ids.has(dep));
}
