/**
 * The guard that stands in front of every destructive step of an integration
 * run - the `DROP SCHEMA` of `resetTestDatabase` here, and the deletes and
 * `obliterate` of the worker fixture (`apps/worker/test/local-stack-guard.ts`,
 * which imports this one rather than keeping a second copy).
 *
 * It lives on its own and imports nothing - no database, no parsed
 * environment - so that `pnpm test` checks it on every run. Inside the
 * integration fixture it would only be exercised with Compose up, and the
 * `test:int` gate is not on yet: removing the guard would then reach a commit
 * green.
 */

/** Integration tests only ever touch a service on this machine. */
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];

/**
 * Refuses a connection URL pointing anywhere but this machine. A remote host
 * can hold a database named `shorts_factory_test` - or a Redis with a database
 * 1 - too (CI, a future VPS), and the name alone would let the reset drop
 * schemas there, or a test wipe queues that hold real jobs.
 */
export function assertLocalHost(url: string): void {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (!LOCAL_HOSTS.includes(host)) {
    throw new Error(
      `refusing to touch data on host "${host}": integration tests only run against services on this machine`,
    );
  }
}
