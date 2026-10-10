# syntax=docker/dockerfile:1
# Image of apps/web: the Next standalone server. Build context: the repository
# root.
#
# The build needs no configuration: `next build` imports nothing that parses
# the environment (the same build runs in CI without `.env`), and a secret
# passed as a build arg would stay in the image history. `.dockerignore` keeps
# every `.env*` out of the context. The running server reads the root `.env`
# Compose mounts read-only at /repo/.env - the path @sf/config resolved at
# build time under WORKDIR /repo, which the bundle keeps (`file:///repo/...`) -
# and the variables Compose sets in `environment`.

FROM node:22-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch --frozen-lockfile

FROM fetch AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile
# `output: "standalone"` is switched on by this variable only (next.config.ts):
# a local `pnpm build` keeps the ordinary output.
ENV NEXT_OUTPUT_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @sf/web build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# The standalone tree mirrors the repository from the tracing root, so the
# server sits under apps/web; static assets are not part of the trace.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
ENV HOSTNAME=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
