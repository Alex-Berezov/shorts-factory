/**
 * How the worker process is started - by `pnpm dev`, by the container image
 * (infra/docker/worker.Dockerfile) and by the signal fixture of
 * `entry-point.int.test.ts`. One literal for all three checks: node itself as
 * the process that receives the signal, with `tsx` as a loader rather than as
 * a parent (docs/DECISIONS.md, 10.09.2026).
 */
export const DEV_COMMAND = "node --import tsx src/index.ts";
