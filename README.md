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
cp .env.example .env   # fill in keys
pnpm db:generate && pnpm db:migrate
pnpm dev
```

## Status

Scaffold only. Implementation proceeds epic by epic per `docs/20_TZ_HIGH_LEVEL.md`,
starting with E0 (foundation), then E1 (Source Radar) + E2 (Video Intelligence).
