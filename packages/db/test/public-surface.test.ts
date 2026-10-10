import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The public surface of `@sf/db` is declared once, in `exports`: the package
 * root and the test guard the app fixtures share. The entry points under
 * `src/cli/` read the whole configuration and connect the moment they load, so
 * they must not be importable by name from anywhere - not from web code, not
 * from another package.
 *
 * Resolution is asked of Node itself, from a real consumer of the package
 * (`apps/worker` depends on `@sf/db`), and only resolved - `import.meta.resolve`
 * never loads the module, so a regression here reports a path instead of
 * running a migration.
 */

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const consumerDir = resolve(packageDir, "../../apps/worker");

/** What Node answers for `specifier` from the consumer: a URL or `ERR <code>`. */
function resolveFromConsumer(specifier: string): string {
  return execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "try { console.log(import.meta.resolve(process.argv[1])) } catch (e) { console.log(`ERR ${e.code}`) }",
      specifier,
    ],
    { cwd: consumerDir, encoding: "utf8" },
  ).trim();
}

function urlOf(relativePath: string): string {
  return pathToFileURL(resolve(packageDir, relativePath)).href;
}

describe("@sf/db exports", () => {
  it("resolves the package root to the re-export module", () => {
    expect(resolveFromConsumer("@sf/db")).toBe(urlOf("src/index.ts"));
  });

  it("resolves the shared local-host guard the app fixtures import", () => {
    expect(resolveFromConsumer("@sf/db/test/local-host-guard.js")).toBe(
      urlOf("test/local-host-guard.ts"),
    );
  });

  it.each([
    "@sf/db/src/cli/migrate.ts",
    "@sf/db/src/cli/migrate.js",
    "@sf/db/src/cli/seed.ts",
    "@sf/db/src/migrate.ts",
  ])("refuses the deep import %s", (specifier) => {
    expect(resolveFromConsumer(specifier)).toBe(
      "ERR ERR_PACKAGE_PATH_NOT_EXPORTED",
    );
  });
});

describe("@sf/db root module", () => {
  it("re-exports the migration runner and the seed", async () => {
    const surface = await import("../src/index.js");

    expect(typeof surface.runMigrations).toBe("function");
    expect(typeof surface.seedAppSettings).toBe("function");
  });

  /**
   * The lock and the session-level runner are for the entry point next to
   * them (`src/cli/migrate.ts`); nothing outside `@sf/db` has a use for them,
   * and a lock taken anywhere but `migrateDb` would serialise nothing.
   */
  it.each([
    "MIGRATION_LOCK_KEY",
    "migrateDb",
    "MIGRATION_LOCK_WAIT_MS",
    "migrationLockTimeoutMessage",
  ])("keeps %s to the migration runner", async (name) => {
    const surface: Record<string, unknown> = await import("../src/index.js");

    expect(surface).not.toHaveProperty(name);
  });
});
