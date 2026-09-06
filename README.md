# AI Shorts Factory

Internal-first application that turns YouTube trend discovery into a repeatable
multilingual Shorts production system. See the product blueprint in
`docs/01_ARCHITECTURE.md` and the engineering documents:

- `docs/10_SYSTEM_DESIGN.md` — system design, tech stack, data model, queues.
- `docs/20_TZ_HIGH_LEVEL.md` — high-level spec (epics E0–E13) to be decomposed.

## How this project is built

Development is run by a team of Claude Code agents (planner, PM, tech lead, worker, seven
reviewers) under a hook-based quality harness in `.claude/`. The owner types `/auto`, reads an
eight-line report and decides whether to launch the next task. See `docs/60_HARNESS.md`
(design) and `docs/61_HOW_TO_WORK.md` (owner cheat sheet).

## Where are we now

`docs/00_STATUS.md` — generated dashboard (current epic, task in progress, next
tasks). Update statuses only via `node scripts/tasks.mjs <cmd>`.

## Stack

TypeScript strict / Node 22 / pnpm + Turborepo / Next.js 15 / Fastify 5 /
BullMQ + Redis / PostgreSQL 16 + Drizzle / Gemini API / googleapis / Vitest / Biome.

## Layout

```text
apps/web      Next.js dashboard (Inbox, Radar, Analytics, Experiments, System)
apps/api      Fastify REST API + Google OAuth + media serving
apps/worker   BullMQ workers (sync, snapshots, scoring, analysis, ingest)
packages/core        domain types, Zod schemas (Content DNA), pure scoring
packages/db          Drizzle schema + migrations (Postgres)
packages/config      typed env + budget/quota limits
packages/integrations/{youtube,gemini,tts}
infra         docker-compose (postgres, redis)
docs          project documentation (RU engineering docs + original EN blueprint)
```

## Getting started

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d
cp .env.example .env   # set ADMIN_PASSWORD, fill in keys, uncomment NODE_ENV=development for local work
pnpm db:generate && pnpm db:migrate
pnpm dev
```

## Environment

`.env` is read once, from the repository root, by `@sf/config`, and only fills variables
the process itself leaves unset (empty or blank counts as unset, so the unfilled optional
keys of the template are simply "not configured"). A fresh copy of `.env.example` stops on
one error - `ADMIN_PASSWORD` is required and the template ships it empty. Node code imports
`@sf/config`, Next server code imports `@sf/config/server`
(see `docs/adr/0001-config-server-entry.md`).

Setting a variable in your shell does **not** change anything under `pnpm dev`, `pnpm build`
or `pnpm test`: those go through turbo in strict env mode, which forwards only the variables
declared in `turbo.json` (none are today, not even `NODE_ENV`). Edit `.env`, or run the app
directly (`pnpm --filter @sf/api exec tsx src/server.ts`) when you need a one-off value.

`NODE_ENV` is unset in `.env.example` on purpose: an undeclared environment is validated as
production, so the length rule for `ADMIN_PASSWORD` (at least 16 characters) applies on every
machine that does not declare its environment, including one that copied the template without
reading this file. `development` and `test` are opt-in - uncomment `NODE_ENV=development` in
your `.env` for local work, and 8 characters are enough there.

`API_PORT`, `API_INTERNAL_URL` and `GOOGLE_OAUTH_REDIRECT_URL` repeat the same api port -
change them together, nothing cross-checks them.

Surrounding whitespace is not part of a value: every variable is trimmed before it is
validated, and quoting does not preserve it (`ADMIN_PASSWORD="secret "` parses to `secret `
and is then trimmed to `secret`). A value made of spaces only counts as not set.
An unquoted value ends at the first `#`, with or without a space before it
(`ADMIN_PASSWORD=Qw9#Lm2` parses to `Qw9`), so quote any value containing `#`.

| Variable | Purpose | Default | Required |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` / `test` / `production` | `production` | no |
| `DATABASE_URL` | Postgres connection URL | — | yes |
| `REDIS_URL` | Redis connection URL (BullMQ) | — | yes |
| `MEDIA_DIR` | media root; relative values resolve against the repository root | `./data/media` | no |
| `ADMIN_PASSWORD` | basic auth password; empty in the template, at least 16 characters unless `NODE_ENV` is `development` or `test` | — | yes |
| `TOKEN_ENCRYPTION_KEY` | 32-byte hex key for the stored Google refresh token | — | before Google OAuth |
| `API_PORT` | Fastify listen port | `3001` | no |
| `WEB_PORT` | Next.js listen port; not wired yet, the `dev` script still hardcodes 3000 (E0-10) | `3000` | no |
| `API_INTERNAL_URL` | api base URL used by web server components | `http://localhost:3001` | no |
| `LOG_LEVEL` | pino level: `fatal`…`trace`; not wired yet, no logger reads it (E0-06) | `info` | no |
| `WORKER_CONCURRENCY` | BullMQ jobs per queue, not per process: the worker runs one `Worker` per queue, so the process holds up to this many jobs times the number of queues; not wired yet, no worker reads it (E0-08) | `5` | no |
| `GOOGLE_CLIENT_ID` | Google OAuth client | — | before Google OAuth |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client | — | before Google OAuth |
| `GOOGLE_OAUTH_REDIRECT_URL` | OAuth callback URL | — | before Google OAuth |
| `YOUTUBE_API_KEY` | public YouTube Data API reads | — | before E1 |
| `YT_UNITS_DAILY_SOFT_CAP` | daily YouTube quota soft cap, units | `8000` | no |
| `GEMINI_API_KEY` | Gemini API key | — | before E2 |
| `GEMINI_DAILY_BUDGET_USD` | daily Gemini budget, USD | `5` | no |
| `ELEVENLABS_API_KEY` / `OPENAI_API_KEY` / `CARTESIA_API_KEY` | TTS providers | — | before E9 |
| `TTS_MONTHLY_BUDGET_USD` | monthly TTS budget, USD | `50` | no |

## Status

Scaffold only. Implementation proceeds epic by epic per `docs/20_TZ_HIGH_LEVEL.md`,
starting with E0 (foundation), then E1 (Source Radar) + E2 (Video Intelligence).
