import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";

/**
 * The manifest of a package, as the tests of the apps read it: the one reader
 * of a `package.json` for them - the scripts of an app (`./dev-command.ts`),
 * the dependencies of the worker (`apps/worker/test/healthcheck-imports.test.ts`)
 * (ADR-0011, "test-support of the apps").
 */

/**
 * The manifest in `packageDir`, read through `schema`. A manifest that is no
 * JSON, or that does not have the shape of `schema`, is refused with the path
 * of the file.
 */
export function readPackageManifest<S extends z.ZodTypeAny>(
  packageDir: string,
  schema: S,
): z.output<S> {
  const file = join(packageDir, "package.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not a readable JSON manifest`, {
      cause: error,
    });
  }
  const parsed = schema.safeParse(manifest);
  if (!parsed.success) {
    throw new Error(
      `${file} is not a manifest of the shape the test reads: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
