import { unlinkSync } from "node:fs";

/**
 * Takes a link (a junction on Windows, a symlink elsewhere) off without
 * touching its target. A link that is not there is fine; any other failure
 * (EPERM, EBUSY) is thrown, so a recursive remove of the directory that holds
 * the link never runs while the link may still stand.
 */
export function dropLink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
