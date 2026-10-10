/** Types of `probe-image.mjs` for the TypeScript tests that import it. */

export interface ImageCheck {
  file?: string;
  pkg?: string;
  from?: string;
}

/** What one probe run returned, as `spawnSync` reports it. */
export interface ProbeRun {
  status: number | null;
  stderr: string | null;
  signal?: string | null;
  error?: Error;
}

export interface ProbeDeps {
  /** Runs one check list against an image tag; docker by default. */
  run?: (tag: string, checks: ImageCheck[]) => ProbeRun;
  /** Reads the manifest of a package directory of the repository. */
  read?: (dir: string) => unknown;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** What each image starts from, by image name. */
export const PROBES: Record<string, ImageCheck[]>;

/** The package directory each image runs from, for its workspace links. */
export const WORKSPACE_OF: Record<string, string>;

/** The check that cannot pass: the control run must fail on it. */
export const CONTROL: { pkg: string };

/** The program the image runs under `node -e`; the checks arrive as JSON in argv[1]. */
export const CONTAINER_SCRIPT: string;

/** One file check per `workspace:` dependency of a manifest. */
export function workspaceChecks(manifest: unknown): ImageCheck[];

/** Every check of an image: its table and its workspace links. */
export function checksOf(
  image: string,
  read?: (dir: string) => unknown,
): ImageCheck[];

/** The `docker run` arguments of one probe of an image tag. */
export function dockerArgs(tag: string, checks: ImageCheck[]): string[];

/** The probe; returns the exit code (0 ok, 1 image lacks something, 2 could not run). */
export function main(argv: string[], deps?: ProbeDeps): number;

/** Whether the module at `metaUrl` is the script node started (`entry` is argv[1]); compares by realpath. */
export function isEntry(
  metaUrl: string,
  entry: string | undefined,
  resolve?: (path: string) => string,
): boolean;
