import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** How an injected failure looks to the child, beyond its code. */
export interface Injected {
  /** The path is removed before the error is thrown, as a deleted file is. */
  remove?: boolean;
  /** `process.platform` the child sees. */
  platform?: NodeJS.Platform;
  /**
   * The function that fails, `readFileSync` by default: one of `node:fs`, or
   * `spawnSync` of `node:child_process`.
   */
  call?: "readFileSync" | "statSync" | "spawnSync";
}

/**
 * Node flags (`--import`) that make one builtin function of a child throw an
 * error with `code` for every call whose first argument - a path, a
 * command - ends in `target`; every other call goes through as it is. The
 * error carries that argument as `path`, as an error of node does. The
 * module doing it is written into `dir` as `<name>.preload.mjs`, and it
 * replaces the function before the child imports anything else
 * (`syncBuiltinESMExports`), so a named import of the function sees the
 * replacement too.
 *
 * The one program of this kind for the tests of the root project: the gate
 * against the search call (`check-no-search-list.test.ts`) and the reading of
 * a listing (`scripts-files.test.ts`) inject through it.
 */
export function failingCall(
  dir: string,
  name: string,
  code: string,
  target: string,
  { remove = false, platform, call = "readFileSync" }: Injected = {},
): string[] {
  const module = join(dir, `${name}.preload.mjs`);
  const builtin = call === "spawnSync" ? "node:child_process" : "node:fs";
  writeFileSync(
    module,
    [
      'import fs from "node:fs";',
      `import target from ${JSON.stringify(builtin)};`,
      'import { syncBuiltinESMExports } from "node:module";',
      platform === undefined
        ? ""
        : `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });`,
      `const real = target.${call};`,
      // rmSync lists a directory through fs itself: no failure while it runs.
      "let removing = false;",
      `target.${call} = (path, ...rest) => {`,
      `  if (!removing && String(path).endsWith(${JSON.stringify(target)})) {`,
      remove
        ? "    removing = true; fs.rmSync(path, { recursive: true, force: true }); removing = false;"
        : "",
      `    throw Object.assign(new Error(\`${code}: injected, \${path}\`), { code: ${JSON.stringify(code)}, path: String(path) });`,
      "  }",
      "  return real(path, ...rest);",
      "};",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
  );
  return ["--import", pathToFileURL(module).href];
}
