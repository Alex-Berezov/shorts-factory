# AI Shorts Factory

Internal-first application that turns YouTube trend discovery into a repeatable
multilingual Shorts production system. See the product blueprint in
`docs/01_ARCHITECTURE.md` and the engineering documents:

- `docs/10_SYSTEM_DESIGN.md` — system design, tech stack, data model, queues.
- `docs/20_TZ_HIGH_LEVEL.md` — high-level spec (epics E0–E13); each epic is decomposed into
  tasks in `docs/3x_E?_TASKS.md`.
- `docs/40_DEV_GUIDE.md` — developer guide (RU): adding a route, a job, a table; tests and gates.
- `docs/adr/` — architecture decision records (index in `docs/adr/README.md`).

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
packages/core        domain types, Zod schemas (Content DNA), job ids, queue registry, pure scoring
packages/db          Drizzle schema + migrations (Postgres), repositories, usage logging, budget guard
packages/config      typed env + budget/quota limits
packages/contracts   Zod schemas of API requests and responses, shared by api and web
packages/api-client  typed server-side fetch client of the API (used by web)
packages/integrations/{youtube,gemini,tts}
infra         Compose files, Dockerfiles, backup script, Postgres init
scripts       repository gates (compose, no search.list, image probe) and the task tracker
compose.yaml  full stack: `docker compose up --build` from the root (includes infra/ files)
docs          project documentation (RU engineering docs + original EN blueprint)
```

## Getting started

**Prerequisites:** Node 22 (`engines` in `package.json`); pnpm 9.12 through corepack
(`packageManager` pins the version); Docker with Compose - on Windows, Docker Desktop with the
WSL2 backend.

**Windows only:** keep the checkout path at most about 100 characters (`C:\src\shorts-factory`,
not a folder deep inside `AppData`). The deepest files under `node_modules/.pnpm` add some 150
characters, and past the 260-character limit of Windows Node fails to load `drizzle-orm`
(`ERR_REQUIRE_CYCLE_MODULE`, `@sf/db` tests red). Linux and macOS have no such limit.

Every `package.json` script is cross-platform: the commands below run the same in bash and in
PowerShell unless two variants are shown. All of them run from the repository root.

1. **Install the dependencies.**

   ```bash
   corepack enable
   pnpm install --frozen-lockfile
   ```

2. **Create `.env`** from the template.

   ```bash
   cp .env.example .env
   ```

   ```powershell
   Copy-Item .env.example .env
   ```

   Then edit two lines: set `ADMIN_PASSWORD` (letters and digits are the safe choice - see
   [Environment](#environment) for `#` and `$`) and uncomment `NODE_ENV=development`, which
   accepts a password of 8 characters and turns on the readable log (the full stack of step 8
   needs 16 characters - see `ADMIN_PASSWORD` in [Environment](#environment)). Provider keys may stay
   empty: nothing in E0 calls a provider.

3. **Start Postgres and Redis.**

   ```bash
   docker compose -f infra/docker-compose.yml up -d --wait
   ```

   Postgres listens on `localhost:5442` (database `shorts_factory`, plus `shorts_factory_test`
   for the integration tests, created on a fresh volume), Redis on `localhost:6389`.

4. **Create the schema and the default settings.**

   ```bash
   pnpm db:migrate
   pnpm db:seed
   ```

   Each prints one line and exits 0: `migrations: applied 1, 1 in total` (or
   `migrations: nothing to apply, 1 already applied`) and `app settings seeded`. `db:seed`
   writes the default `app_setting` rows merged under the stored ones: missing rows and keys are added, your values win, an idle run leaves
   `updated_at` alone. The worker refuses to start on a database that was never seeded.

5. **Run the three services.**

   ```bash
   pnpm dev
   ```

   One turbo process starts api on `http://localhost:3001` (`tsx watch`), the worker (no file
   watcher - see [Worker](#worker)) and web on `http://localhost:3000` (`next dev`; the port
   is fixed in `apps/web/package.json`, so stop anything else on 3000 first - the `web`
   container of the full stack, for one: `docker compose stop web`). Open
   `http://localhost:3000/system`: the browser asks for credentials - any user name, the
   password is `ADMIN_PASSWORD`. The page shows api, database and Redis, the queues, the
   worker heartbeat and the budget, and refreshes itself every 15 seconds.

   **Warning: under `pnpm dev` the api listens on all interfaces** (`0.0.0.0:3001`, unlike the
   full stack, where it is not published), and the admin password is the only protection. Use a
   password as strong as for production, or run `pnpm dev` only on a network you trust.

   **The Worker card reads stale for up to a minute after the worker starts.** That is the
   normal start, not a fault: the heartbeat is a cron job that fires once a minute
   (`*/1 * * * *`, `apps/worker/src/schedules.ts`), and until its first tick there is no stamp
   to show.

6. **Run the smoke job** - in a second terminal, with `pnpm dev` running.

   ```bash
   pnpm --filter @sf/worker smoke
   ```

   It puts one `system.smoke` job on the queue, waits for the worker to finish it, logs
   `smoke job completed` and exits 0 (see [Worker](#worker) for what it says when it cannot).
   What to look at afterwards: `api_usage_log` holds one more row with `provider = 'system'`:

   ```bash
   docker compose -f infra/docker-compose.yml exec postgres psql -U sf -d shorts_factory -c "select count(*) from api_usage_log where provider = 'system'"
   ```

   On `/system` the `system.smoke` row shows the queue drained - nothing waiting, active or
   failed; the page has no column for completed jobs. The usage row does not appear in the
   budget section either: `system` is our own bookkeeping (`units: 0`) and has no cap to
   report against.

7. **Run the tests.**

   ```bash
   pnpm test
   ```

   Unit tests, no infrastructure needed. The integration tests need the Postgres and Redis of
   step 3 (they use the database `shorts_factory_test` and, on the Redis of `.env.test`,
   database 1 for the worker suite and database 2 for the api suite -
   `apps/api/test/local-stack-guard.ts`; never the development data, which lives in
   database 0) and the schema of the test database - the same command CI runs, once and
   again after every new migration:

   ```bash
   cd packages/db
   node --env-file=../../.env.test --import tsx src/cli/migrate.ts
   cd ../..
   pnpm test:int
   ```

   (`cd` rather than `pnpm --filter @sf/db exec`: under `pnpm exec` node reports
   `../../.env.test: not found` unless the command follows a `--`, and PowerShell drops that
   `--` before pnpm sees it.) The test database needs no seed: the integration tests write the
   settings they rely on themselves.

   Without the stack `pnpm test:int` fails rather than skipping. `pnpm lint`,
   `pnpm typecheck` and `pnpm build` complete the set. Until E0-01A/E0-02A land, the commit
   lock does not run `test`, `test:int` or `build`: run them by hand. Which gates
   `node .claude/hooks/gates.js` picks, and how to run the rest, is described once, in
   `docs/40_DEV_GUIDE.md`, section «Тесты и гейты» (the guide is in Russian).

8. **The full stack in containers** - one command from the root, after stopping `pnpm dev`
   (web needs port 3000):

   ```bash
   docker compose up --build
   ```

   It reuses the Postgres and Redis of step 3 and their data, migrates and seeds on its own,
   and publishes only web, on `WEB_PORT` (3000). Details, including the same minute of a stale
   Worker card after `up`, are in `infra/README.md`.

The full stack in containers (`docker compose up --build` from the root) is described in
`infra/README.md`. `pnpm check:compose` checks its invariants (only web published, api port,
`NODE_ENV`, healthchecks, restart policies, the root `.env` mounted read-only at `/repo/.env`, `.env` masks in the `.dockerignore` of every built image, ...) through
`docker compose config` (the `.dockerignore` masks are read from disk by `checkBuildIgnores`, `scripts/compose-rules.mjs`): it needs the Docker CLI, not a running daemon, and never reads `.env`.
Tested with Docker Compose v5.5.1 (Docker Desktop); no minimum version has been established.

Postgres and Redis run with `restart: unless-stopped`: once started, they come back with Docker
Desktop and keep ports 5442 and 6389 until `docker compose -f infra/docker-compose.yml stop`.

Compose publishes Postgres on `localhost:5442` and Redis on `localhost:6389` - deliberately
not the default ports, so the stack starts next to another project's Postgres or Redis;
`.env.example` and `.env.test` already point there.

**If your `.env` predates this change, edit it:** the host ports moved from 5432/6379 to
5442/6389, so `DATABASE_URL` must end in `localhost:5442/shorts_factory` and `REDIS_URL` in
`localhost:6389`. Nothing cross-checks them: left at 5432, `pnpm db:migrate` goes to whatever
Postgres happens to own that port - most likely another project's, where it either fails
authentication or creates our 21 tables in a foreign database.

`pnpm db:migrate` and `pnpm db:seed` are entry points of `@sf/db`: they read `DATABASE_URL`
through `@sf/config` (so the root `.env` is enough) and print one line per step. Changing the
schema in `packages/db/src/schema/**` is followed by `pnpm db:generate --name <epic>`, which
writes the next `migrations/NNNN_<epic>.sql` (`0001_radar` and so on, per §5 of the system
design). The `--name` is not optional in practice: without it drizzle-kit invents a random
name, and renaming the file afterwards breaks the runner, which looks migrations up by the
name recorded in `migrations/meta/_journal.json`. An applied migration file is never edited.

## API

`pnpm --filter @sf/api dev` starts Fastify on `API_PORT` (3001 by default). Nothing but
`/health` is public: the rest of the API is behind basic auth with `ADMIN_PASSWORD`, the user
name is not checked (send `admin`), and that includes `/docs` and `/openapi.json`.

| Route | Auth | What it answers |
| --- | --- | --- |
| `GET /health` | no | `{"status":"ok"}` with 200, `{"status":"degraded"}` with 503 when Postgres or Redis does not answer. Nothing about the build - it is the one route an outsider could reach |
| `GET /system/status` | yes | build fingerprint (`APP_VERSION`, `GIT_COMMIT`, `null` when unset), uptime and the per-dependency checks |
| `GET /docs` | yes | Swagger UI over the same Zod schemas |
| `GET /openapi.json` | yes | the OpenAPI document itself |

Every failure comes back in one shape - `{"error":{"code","message","requestId","details"?}}` -
and `requestId` matches the `x-request-id` header of the response (send your own header to
correlate a call end to end). A domain error keeps its status and its `code` in both ranges,
so "the provider is down, try later" stays apart from "we have a bug"; the text of one travels
only in the 4xx range, and a 5xx says the status class and nothing else. Nothing of an
unexpected error reaches the body: it is logged and answered with `INTERNAL_ERROR`. That shape
is guaranteed for everything that reached the router; a request Node's own HTTP parser rejects
before Fastify sees it (400, 408, 431) is answered by the runtime itself, with no `requestId`.

Running it without a repository `.env` - the variables of the process win over the file:

```bash
DATABASE_URL=postgres://sf:sf@localhost:5442/shorts_factory REDIS_URL=redis://localhost:6389 ADMIN_PASSWORD=<at least 8 characters> NODE_ENV=development pnpm --filter @sf/api exec tsx src/server.ts

curl -i localhost:3001/health
curl -i -u admin:<password> localhost:3001/system/status
```

`NODE_ENV=development` is what turns on the readable `pino-pretty` log; every other
environment logs JSON, because `pino-pretty` is a devDependency and is not in the image.
SIGINT and SIGTERM close Fastify, then the database and Redis, and the process exits on its
own; a second signal does not start a second pass.

## Worker

`pnpm --filter @sf/worker dev` runs the BullMQ worker - `node --import tsx src/index.ts`, one
process, no file watcher. That is deliberate: a watcher restarts the process the moment a file
is saved, and a job worker restarted mid-job loses the job it was holding (with E2 that is a
paid call already made). It also owns the signal: `tsx watch` forwards Ctrl+C to the child with
`child.kill()` and follows with SIGKILL five seconds later, while the worker's own drain is
given twenty-five, so the very thing the graceful stop exists for would never finish. Restart
it by hand after a change - Ctrl+C, then the same command; the stop waits for the jobs in
flight and says so in the log (`shutdown started, draining active jobs`, then
`shutdown complete`).

`pnpm --filter @sf/worker smoke` puts one `system.smoke` job on the queue and waits for that
worker to finish it: it is the end-to-end check of the pipeline (Redis, the worker, a row in
`api_usage_log`). With the stack down it gives up on its own after a thirty-second deadline -
plus up to a second to ask the queue why and up to five more to close its own connections, so
the command itself can take closer to forty seconds - and says which of three things happened:
no worker is serving the queue, the queue is switched off (the job is still waiting, see
`app_setting "queues.enabled"`), or Redis could not even be asked because it is down.

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
validated. A value made of spaces only counts as not set.

`.env` is read by one parser on both paths: `@sf/config` reads it with Node's `util.parseEnv`
under `pnpm dev` and in the containers of the full stack, which get the file mounted read-only
(see `infra/README.md`). Quotes are allowed and stripped (`ADMIN_PASSWORD="Qw9#Lm2"` is
`Qw9#Lm2`); an unquoted value ends at the first `#` (`ADMIN_PASSWORD=Qw9#Lm2` is `Qw9`) -
quote a value that contains one.

| Variable | Purpose | Default | Required |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` / `test` / `production` | `production` | no |
| `DATABASE_URL` | Postgres connection URL | — | yes |
| `REDIS_URL` | Redis connection URL (BullMQ) | — | yes |
| `MEDIA_DIR` | media root; relative values resolve against the repository root | `./data/media` | no |
| `ADMIN_PASSWORD` | basic auth password; empty in the template, at least 16 characters unless `NODE_ENV` is `development` or `test` | — | yes |
| `TOKEN_ENCRYPTION_KEY` | 32-byte hex key for the stored Google refresh token | — | before Google OAuth |
| `APP_VERSION` | build version reported by `/system/status`; unset reads as `null` there | — | no |
| `GIT_COMMIT` | build commit, same place, same rule; any build label up to 64 characters of `A-Z a-z 0-9 . + : _ -` (a short sha, `abc1234-dirty`, `unknown`). Anything else - a space, a quote, a slash, 65 characters - reads as unset rather than stopping the service: the field is only printed by `/system/status` | — | no |
| `API_PORT` | Fastify listen port | `3001` | no |
| `WEB_PORT` | Next.js listen port; not wired yet, the `dev` script still hardcodes 3000 (`apps/web/package.json`). In the full stack it is the host port of web: `${WEB_PORT:-3000}:3000` | `3000` | no |
| `API_INTERNAL_URL` | api base URL used by web server components | `http://localhost:3001` | no |
| `LOG_LEVEL` | pino level: `fatal`…`trace` | `info` | no |
| `WORKER_CONCURRENCY` | BullMQ jobs per queue, not per process: the worker runs one `Worker` per queue that has a processor, so the process holds up to this many jobs times the number of such queues. At most 10 - a larger value stops the start; the paid fan-out queues are capped at 2 whatever this says (`apps/worker/src/lib/job-policy.ts`) | `5` | no |
| `GOOGLE_CLIENT_ID` | Google OAuth client | — | before Google OAuth |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client | — | before Google OAuth |
| `GOOGLE_OAUTH_REDIRECT_URL` | OAuth callback URL | — | before Google OAuth |
| `YOUTUBE_API_KEY` | public YouTube Data API reads | — | before E1 |
| `YT_UNITS_DAILY_SOFT_CAP` | daily YouTube quota soft cap, units. At most 10000 - the daily quota of the Data API itself: a larger value (`20000` "to be safe") is refused by the env validation (`too_big`, `maximum: 10000`) and no service starts | `8000` | no |
| `GEMINI_API_KEY` | Gemini API key | — | before E2 |
| `GEMINI_DAILY_BUDGET_USD` | daily Gemini budget, USD | `5` | no |
| `ELEVENLABS_API_KEY` / `OPENAI_API_KEY` / `CARTESIA_API_KEY` | TTS providers | — | before E9 |
| `TTS_MONTHLY_BUDGET_USD` | monthly TTS budget, USD | `50` | no |

## Status

E0 (foundation) is done: monorepo, Compose stack, api/worker/web skeletons with auth,
cost accounting and the budget guard, CI - acceptance in `docs/30_E0_TASKS.md`, «Приёмка».
Implementation proceeds epic by epic per `docs/20_TZ_HIGH_LEVEL.md`; the current and next
tasks are in `docs/00_STATUS.md`.
Open follow-ups of E0: E0-01A, E0-02A, E0-11A, E0-12A-D. Tests and the build are not run by the
commit lock until E0-01A/E0-02A land (run them by hand, see Getting started step 7).
