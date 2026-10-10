/** Types of `compose-rules.mjs` for the TypeScript tests that import it. */

/** `compose.yaml` of the repository the script at `scriptUrl` lives in. */
export function defaultComposeFile(scriptUrl: string): string;

/** Seconds of a Compose duration; NaN if unreadable. */
export function durationSec(value: unknown): number;

/** Every violation of the stack's invariants, one line each; empty when clean. */
export function checkCompose(
  config: { services?: Record<string, unknown> },
  project: { envFile: string },
): string[];

/** Violations of the `.env` masks in the text of one `.dockerignore`. */
export function checkDockerignore(text: string, file: string): string[];

/** Violations of the `.env` masks for every image the stack builds. */
export function checkBuildIgnores(
  config: { services?: Record<string, unknown> },
  read: (path: string) => string | null,
): string[];
