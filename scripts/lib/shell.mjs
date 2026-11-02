/**
 * A command a script prints for the operator to paste into a shell: the fix
 * of a refusal (`tracker-doc.mjs`), the command a gate ran
 * (`scripts/check-compose.mjs`). One rule of quoting for all of them.
 */

/**
 * One argument as a shell takes it back: as it is when it holds only letters,
 * digits, `_`, `.`, `/`, `:` and `-`, otherwise in single quotes, inside
 * which neither a POSIX shell nor PowerShell expands `$`, a backquote or a
 * backslash - so a Windows path, with its backslashes, is always quoted. A
 * single quote inside is written the POSIX way (`'\''`), which PowerShell
 * does not take: a caller that prints one says so (`commandOf` of
 * `scripts/check-compose.mjs`) or leaves it to the POSIX shell its scripts
 * run in (docs/TECH_DEBT.md § E0-12AM).
 *
 * @param {string} arg
 * @returns {string}
 */
export function shellArg(arg) {
  return /^[\w./:-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}
