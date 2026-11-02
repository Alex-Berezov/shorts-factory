import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Package directories in the temp directory for the cases that read a
 * manifest (`readPackageManifest`, `manifestScripts`): one per call, removed
 * by the `afterEach` of the file (`removePackageDirs`).
 */
const made: string[] = [];

/** A package directory whose manifest is `text`. */
export function packageWith(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-package-fixture-"));
  made.push(dir);
  writeFileSync(join(dir, "package.json"), text);
  return dir;
}

/** Removes every directory `packageWith` has made so far. */
export function removePackageDirs(): void {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
