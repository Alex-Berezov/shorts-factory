/**
 * The guard that stands in front of the `DROP SCHEMA` of `resetTestDatabase`.
 *
 * It lives on its own and imports nothing - no database, no parsed
 * environment - so that `pnpm test` checks it on every run. Inside the
 * integration fixture it would only be exercised with Compose up, and the
 * `test:int` gate is not on yet: removing the guard would then reach a commit
 * green.
 */

/** The reset only ever runs against a database on this machine. */
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];

/**
 * Refuses a `DATABASE_URL` pointing anywhere but this machine. A remote host
 * can hold a database named `shorts_factory_test` too (CI, a future VPS), and
 * the name alone would let the reset drop schemas there.
 */
export function assertLocalHost(url: string): void {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (!LOCAL_HOSTS.includes(host)) {
    throw new Error(
      `refusing to reset a database on host "${host}": integration tests only run against a local Postgres`,
    );
  }
}
