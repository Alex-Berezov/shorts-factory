# syntax=docker/dockerfile:1
# Images of the application, one target each: `api`, `worker`, `migrate`
# (the one-shot migration service of infra/docker-compose.app.yml) and `web`.
# Build context: the repository root (`docker compose build`, or
# `docker build --target api -f infra/docker/app.Dockerfile .`). The node
# image is named once (`NODE_IMAGE` below) and every stage that starts from
# an image starts from it; the stages `base` and `fetch` are written once and
# shared by every target. So the versions of node and pnpm cannot drift apart
# between the images (docs/adr/0013-single-app-dockerfile.md).
#
# No compile step for api, worker and migrate: they run their TypeScript
# sources through `tsx`, the way `pnpm dev` does, so `tsx` is a runtime
# dependency of each (E0 decision 1; docs/DECISIONS.md). Configuration is not
# baked in: `.dockerignore` keeps every `.env*` out of the context; at run
# time Compose mounts the root `.env` read-only at /repo/.env, where
# @sf/config reads it as under `pnpm dev`, and sets what differs in the
# network through `environment`. `.dockerignore` keeps the tests of the
# packages (`test/`, `test-support/`, `*.test.ts`, the vitest configs) out of
# the context as well. One piece of test tooling stays in the images:
# packages/config/vitest/ is an export of @sf/config (`./vitest/setup`), so it
# ships with the package; it throws when imported outside a vitest run, and
# the masks are not widened to it (decision R1 of E0-12J, docs/DECISIONS.md).

# The one node image of every stage (test/container.test.ts).
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS base
# pnpm comes from corepack at the version pinned by `packageManager` in the
# root package.json; the prompt would block a non-interactive build.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Dependencies by the lockfile alone, so a source change does not refetch them.
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch --frozen-lockfile

# Production dependencies of a service and of the workspace packages it uses,
# exactly as the lockfile pins them (`--frozen-lockfile`, from the store
# `pnpm fetch` filled, `--offline`). Not `pnpm deploy`: on pnpm 9 it resolves
# the copy's dependencies again from the semver ranges, so the image would get
# versions CI and `pnpm dev` never ran (docs/DECISIONS.md, 10.10.2026).
# The node_modules `pnpm fetch` left holds every package of the workspace, dev
# tools and web included; it goes first, or all of it would reach the image -
# and pnpm, asked to reuse it for a production install, stops at a purge
# prompt that a build without a terminal answers by installing nothing.
# Each install follows `COPY . .`, so a change of any source file rebuilds
# it: only `base` and `fetch` are reused across such changes (copying the
# manifests, installing, then copying the sources is in docs/TECH_DEBT.md).
FROM fetch AS api-deps
COPY . .
RUN rm -rf node_modules && pnpm install --offline --frozen-lockfile --prod --filter @sf/api...

FROM fetch AS worker-deps
COPY . .
RUN rm -rf node_modules && pnpm install --offline --frozen-lockfile --prod --filter @sf/worker...

FROM fetch AS migrate-deps
COPY . .
RUN rm -rf node_modules && pnpm install --offline --frozen-lockfile --prod --filter @sf/db...

# web and the workspace packages it builds from, dev dependencies included:
# `next build` needs them. Only the standalone output reaches the image.
FROM fetch AS web-build
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter @sf/web...
# `output: "standalone"` is switched on by this variable only (next.config.ts):
# a local `pnpm build` keeps the ordinary output.
ENV NEXT_OUTPUT_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @sf/web build

# The tsx targets keep the workspace layout as it is, so the links pnpm made
# into node_modules still point at the packages, and the service runs from
# its own directory. `tsconfig.base.json` comes along: the `tsconfig.json` of
# each package extends it, and tsx reads the options from there.
FROM ${NODE_IMAGE} AS api
COPY --from=api-deps /repo/node_modules /repo/node_modules
COPY --from=api-deps /repo/package.json /repo/pnpm-workspace.yaml /repo/
COPY --from=api-deps /repo/tsconfig.base.json /repo/
COPY --from=api-deps /repo/packages /repo/packages
COPY --from=api-deps /repo/apps/api /repo/apps/api
WORKDIR /repo/apps/api
# The media volume is mounted here; created up front so that the volume
# Docker initialises from it belongs to the unprivileged user.
RUN mkdir -p /data/media && chown node:node /data/media
USER node
# Build fingerprint reported by /system/status. Filled in by the build
# (`APP_VERSION`/`GIT_COMMIT` build args); empty means "not set" (`@sf/config`).
ARG APP_VERSION=""
ARG GIT_COMMIT=""
ENV APP_VERSION=$APP_VERSION GIT_COMMIT=$GIT_COMMIT
EXPOSE 3001
# Exec form: node is PID 1 and receives SIGTERM from `docker stop` itself. It
# stops because the api installs its own handler (`subscribeToSignals` of
# packages/runtime/src/shutdown.ts, wired in apps/api/src/compose-app.ts):
# node as PID 1 without one would ignore the signal.
CMD ["node", "--import", "tsx", "src/server.ts"]

FROM ${NODE_IMAGE} AS worker
COPY --from=worker-deps /repo/node_modules /repo/node_modules
COPY --from=worker-deps /repo/package.json /repo/pnpm-workspace.yaml /repo/
COPY --from=worker-deps /repo/tsconfig.base.json /repo/
COPY --from=worker-deps /repo/packages /repo/packages
COPY --from=worker-deps /repo/apps/worker /repo/apps/worker
WORKDIR /repo/apps/worker
RUN mkdir -p /data/media && chown node:node /data/media
USER node
# Exactly the command of `pnpm dev` (docs/DECISIONS.md, 10.09.2026): node is
# PID 1 and gets SIGTERM itself, and the drain of the worker runs - the stop
# of packages/runtime/src/shutdown.ts with the 25 s deadline
# (SHUTDOWN_TIMEOUT_MS in apps/worker/src/bootstrap.ts). No
# package manager, no `tsx` CLI and no shell in front of it - each of them
# takes the signal for itself (test/container.test.ts).
CMD ["node", "--import", "tsx", "src/index.ts"]

# packages/db with its migrations, the migration runner and the seed.
FROM ${NODE_IMAGE} AS migrate
COPY --from=migrate-deps /repo/node_modules /repo/node_modules
COPY --from=migrate-deps /repo/package.json /repo/pnpm-workspace.yaml /repo/
COPY --from=migrate-deps /repo/tsconfig.base.json /repo/
COPY --from=migrate-deps /repo/packages /repo/packages
WORKDIR /repo/packages/db
USER node
# Migrations, then the seed, in one process on one connection: the worker
# refuses to start without the queue switches the seed writes
# (apps/worker/src/lib/queue-switches.ts), and the seed does not run after a
# failed migration. Both steps are safe to repeat - the runner takes an
# advisory lock and skips what is applied, the seed merges under the
# operator's values - so the service runs on every `docker compose up`. Exec
# form: no shell between the engine and node. That alone does not stop it on
# SIGTERM: node as PID 1 without a handler ignores the signal, and the engine
# ends it with SIGKILL (137) once its grace period is over. What stops it is
# Docker's init (tini): Compose runs `migrate` with `init: true` (rule 13 of
# scripts/compose-rules.mjs, docs/adr/0013-single-app-dockerfile.md), and a
# `docker run` of this image by hand needs `--init` for the same reason.
CMD ["node", "--import", "tsx", "src/cli/migrate-and-seed.ts"]

# The Next standalone server. The build needs no configuration: `next build`
# imports nothing that parses the environment (the same build runs in CI
# without `.env`), and a secret passed as a build arg would stay in the image
# history. The running server reads the root `.env` Compose mounts read-only
# at /repo/.env - the path @sf/config resolved at build time under WORKDIR
# /repo, which the bundle keeps (`file:///repo/...`) - and the variables
# Compose sets in `environment`.
FROM ${NODE_IMAGE} AS web
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# The standalone tree mirrors the repository from the tracing root, so the
# server sits under apps/web; static assets are not part of the trace.
COPY --from=web-build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
ENV HOSTNAME=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
