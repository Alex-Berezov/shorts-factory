# syntax=docker/dockerfile:1
# Image of apps/api. Build context: the repository root
# (`docker compose build api`, or `docker build -f infra/docker/api.Dockerfile .`).
#
# No compile step: the service runs its TypeScript sources through `tsx`, the
# way `pnpm dev` does, so `tsx` is a runtime dependency of the app (E0 decision
# 1; docs/DECISIONS.md). Configuration is not baked in: `.dockerignore` keeps
# every `.env*` out of the context; at run time Compose mounts the root `.env`
# read-only at /repo/.env, where @sf/config reads it as under `pnpm dev`, and
# sets what differs in the network through `environment`.

FROM node:22-alpine AS base
# pnpm comes from corepack at the version pinned by `packageManager` in the
# root package.json; the prompt would block a non-interactive build.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Dependencies by the lockfile alone, so a source change does not refetch them.
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch --frozen-lockfile

# Production dependencies of the app and of the workspace packages it uses,
# exactly as the lockfile pins them (`--frozen-lockfile`, from the store
# `pnpm fetch` filled, `--offline`). Not `pnpm deploy`: on pnpm 9 it resolves
# the copy's dependencies again from the semver ranges, so the image would get
# versions CI and `pnpm dev` never ran (docs/DECISIONS.md, 10.10.2026).
# The node_modules `pnpm fetch` left holds every package of the workspace, dev
# tools and web included; it goes first, or all of it would reach the image -
# and pnpm, asked to reuse it for a production install, stops at a purge
# prompt that a build without a terminal answers by installing nothing.
FROM fetch AS prod
COPY . .
RUN rm -rf node_modules && pnpm install --offline --frozen-lockfile --prod --filter @sf/api...

# The workspace layout as it is, so the links pnpm made into node_modules
# still point at the packages; the app runs from its own directory.
FROM node:22-alpine AS runtime
COPY --from=prod /repo/node_modules /repo/node_modules
COPY --from=prod /repo/package.json /repo/pnpm-workspace.yaml /repo/
COPY --from=prod /repo/packages /repo/packages
COPY --from=prod /repo/apps/api /repo/apps/api
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
# Exec form: node is PID 1 and receives SIGTERM from `docker stop` itself.
CMD ["node", "--import", "tsx", "src/server.ts"]
