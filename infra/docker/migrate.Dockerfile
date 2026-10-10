# syntax=docker/dockerfile:1
# Image of the one-shot migration service (`migrate` in
# infra/docker-compose.app.yml): packages/db with its migrations, the
# migration runner and the seed. Build context: the repository root.
#
# Same layout as api.Dockerfile: TypeScript sources run through `tsx`, no
# compile step, no configuration in the image - Compose mounts `.env` at
# /repo/.env and sets `environment` at run time.
# The first stages are the same instructions as in the other images, so the
# build cache shares them.

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
RUN rm -rf node_modules && pnpm install --offline --frozen-lockfile --prod --filter @sf/db...

# Migrations, then the seed: the worker refuses to start without the queue
# switches the seed writes (apps/worker/src/lib/queue-switches.ts). Both steps
# are safe to repeat - the runner takes an advisory lock and skips what is
# applied, the seed merges under the operator's values - so the service runs
# on every `docker compose up`. A one-shot process: the shell form is fine,
# nothing is waiting to deliver it a signal.
FROM node:22-alpine AS runtime
COPY --from=prod /repo/node_modules /repo/node_modules
COPY --from=prod /repo/package.json /repo/pnpm-workspace.yaml /repo/
COPY --from=prod /repo/packages /repo/packages
WORKDIR /repo/packages/db
USER node
CMD node --import tsx src/cli/migrate.ts && node --import tsx src/cli/seed.ts
