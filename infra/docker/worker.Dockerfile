# syntax=docker/dockerfile:1
# Image of apps/worker. Build context: the repository root. The one-shot
# migration service has an image of its own: migrate.Dockerfile.
#
# Same layout as api.Dockerfile: TypeScript sources run through `tsx`, no
# compile step, no configuration in the image - Compose mounts `.env` at
# /repo/.env and sets `environment` at run time.

FROM node:22-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch --frozen-lockfile

# Production dependencies only, as the lockfile pins them - not `pnpm deploy`
# (api.Dockerfile says why).
FROM fetch AS prod
COPY . .
RUN rm -rf node_modules && pnpm install --offline --frozen-lockfile --prod --filter @sf/worker...

FROM node:22-alpine AS runtime
COPY --from=prod /repo/node_modules /repo/node_modules
COPY --from=prod /repo/package.json /repo/pnpm-workspace.yaml /repo/
COPY --from=prod /repo/packages /repo/packages
COPY --from=prod /repo/apps/worker /repo/apps/worker
WORKDIR /repo/apps/worker
RUN mkdir -p /data/media && chown node:node /data/media
USER node
# Exactly the command of `pnpm dev` (docs/DECISIONS.md, 10.09.2026): node is
# PID 1 and gets SIGTERM itself, the drain of src/lib/shutdown.ts runs. No
# package manager, no `tsx` CLI and no shell in front of it - each of them
# takes the signal for itself (apps/worker/test/container.test.ts).
CMD ["node", "--import", "tsx", "src/index.ts"]
