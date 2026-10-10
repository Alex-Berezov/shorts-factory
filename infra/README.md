# Infra

| File | What it is |
| --- | --- |
| `../compose.yaml` | Full stack. Includes the two files below. |
| `docker-compose.yml` | Postgres 16 + Redis 7 - the development stack on its own. |
| `docker-compose.app.yml` | `migrate`, `api`, `worker`, `web`. |
| `docker/{api,worker,web,migrate}.Dockerfile` | Images. Build context is the repository root; `migrate.Dockerfile` is the one-shot migrations + seed image. |
| `scripts/backup.sh` | `pg_dump` with a 14-day rotation. |
| `postgres/init/` | SQL run once on a fresh Postgres volume (creates the test database). |

All three Compose files share the project name `shorts-factory`, and with it
the volumes `pgdata` and `redisdata`: the development stack and the full stack
see the same data.

Production target (MVP): a single VPS running this same full stack, or
Fly.io/Railway; deployment itself comes after E1 (task E1-12).

**Do not put this stack on a server as it is.** web is published over plain
HTTP on every interface, so the admin password would cross the network in
clear text; every service, web included, receives the whole `.env` with all
provider keys; the Postgres password is `sf`. TLS in front of web, narrower
environments per service and real database credentials are the deployment
task's (E1-12, docs/TECH_DEBT.md).

## Full stack

```sh
cp .env.example .env
# set ADMIN_PASSWORD (at least 16 characters - the containers run with
# NODE_ENV=production) and whatever keys the task at hand needs
docker compose up --build
```

From the repository root. Starts Postgres and Redis, runs `migrate` (migrations,
then the seed of `app_setting`) and exits, then starts api, worker and web.
Open `http://localhost:3000` - the browser asks for the admin password;
`/system` shows api, database, Redis and the worker heartbeat (the first beat
comes within a minute of the worker's start).

**The Worker card on `/system` reads stale for up to a minute after `up`.**
That is the normal start, not a fault to look for in the logs: the heartbeat
is a cron job that fires once a minute (`*/1 * * * *`,
`apps/worker/src/schedules.ts`), and until its first tick there is no stamp to
show. The worker container reports `healthy` by the same stamp, so
`docker compose up --wait` returns at the first probe after that beat has been written.
The worker healthcheck (`infra/docker-compose.app.yml`) probes every 30 s (`interval`),
treats `retries: 3` consecutive failures as `unhealthy` and has `start_period: 90s`. Docker
does not count failed probes inside the start period (a successful one still marks the
container `healthy` at once), so probes at about 30 s and 60 s that find no stamp yet are
harmless. Counting starts after the 90 s: three failed probes in a row put the container to
`unhealthy` no earlier than about 150-180 s after the start. The first beat comes within 60 s
of the worker's start, so a normal start is `healthy` at the probe after it. `unhealthy` in
the first two minutes is therefore not a fault; one that stays past three minutes is (the
stamp is not being written: look at the worker log).

- Only web is published (`WEB_PORT` from `.env`, 3000 by default, all
  interfaces). api is reachable inside the Compose network only
  (`http://api:3001`; `API_PORT` from `.env` is for `pnpm dev` - the
  container pins 3001, which its healthcheck and web's `API_INTERNAL_URL`
  use), Postgres and Redis on loopback (`127.0.0.1:5442`, `127.0.0.1:6389`)
  for `pnpm dev` and the tests.
- `.env` is mounted read-only at `/repo/.env` in migrate, api, worker and web,
  and `@sf/config` reads it there with the same `util.parseEnv` as under
  `pnpm dev`: a value means the same on both paths. Quotes are allowed and
  stripped; an unquoted value ends at the first `#` - quote a value that
  contains one. `docker-compose.app.yml` sets what differs inside the
  network in `environment` - `DATABASE_URL`, `REDIS_URL`, `API_INTERNAL_URL`,
  `MEDIA_DIR=/data/media`, `NODE_ENV=production` - and that wins: the file
  only fills keys the process leaves unset. Every app service gets the whole
  file, web included. No `.env` ends up in an image: `.dockerignore` keeps
  every `.env*` out of the build context.
- On a Linux host the containers run as uid 1000 (`node`): `.env` must be
  readable by it - `chmod 600` by another user makes `migrate` stop with
  `EACCES`.
- Without a `.env` the stack does not start. On a Linux engine nothing is
  created (`create_host_path: false`; not verified on Linux yet). On Docker
  Desktop for Windows Docker does not pass the option on and creates an empty directory named `.env` in the checkout, and
  `migrate` exits 1 with `EISDIR`. Remove that directory before
  `cp .env.example .env`, or `cp` puts the file inside it.
- Compose itself reads the same root `.env` once more, as its interpolation
  file (for `${WEB_PORT:-3000}` and the `APP_VERSION`/`GIT_COMMIT` build
  args), by its own grammar. Nothing it interpolates reaches a container
  except through `docker-compose.app.yml`; the one such path is the two build
  args below, which end up in the api image's `ENV`. Compose reports what it
  does not understand, value included:
  - a `$` followed by a name inside an unquoted or double-quoted value is a
    variable to Compose: `pa$sword` prints
    `The "sword" variable is not set. Defaulting to a blank string.` on every
    `docker compose` command run from the checkout (`up`, `config`, `ps`,
    `exec` alike) - a piece of the secret in the terminal, in CI logs and
    in every log file a scheduled command appends its stderr to. Single
    quotes (`ADMIN_PASSWORD='pa$sword'`) stop it, and `@sf/config` strips
    them like any other quotes. `scripts/backup.sh` does not read `.env` at
    all (below); give any other command you schedule
    `--env-file .env.example` the same way;
  - a `${` without its `}` stops Compose before it builds anything, and the
    error prints the whole value: `failed to read .../.env: Invalid template:
    "<the value>"`;
  - to keep Compose out of `.env` altogether, give it the template as its
    interpolation file: `docker compose --env-file .env.example up --build`.
    The containers still read `.env`; `WEB_PORT` then comes from
    `.env.example`.
- Build fingerprint on `/system` (api image only; build args are declared in
  `docker-compose.app.yml` and `api.Dockerfile`):
  `APP_VERSION=1.2.0 GIT_COMMIT=$(git rev-parse --short HEAD) docker compose up --build`
  on the command line, or literal values in the root `.env` (`APP_VERSION=1.2.0`,
  `GIT_COMMIT=abc1234`; the file is not a shell, so `$(...)` is not run there).
  `--build` bakes the value in. With `--env-file .env.example` Compose does not
  read the root `.env`, so only the shell reaches the build args and an
  unset one bakes in an empty value.
  - An image built without a value carries them empty, so the api container
    takes them from the mounted `.env` when it is started again, with no
    rebuild (`mergeEnvFile` in `packages/config/src/env-file.ts` fills only keys the
    process leaves unset). Not verified on Linux: there an
    editor that replaces the file (`sed -i`) may leave the container the old
    one until `docker compose down && up`.
  - An image built with a non-empty value keeps it: editing `.env` changes
    nothing until the next `--build`.
  - A value that is not a valid label (spaces, a slash, over 64 characters) is
    read as unset (`packages/config/src/schema.ts`). If it was baked in,
    the `.env` value does not override it either, and `/system/status`
    answers `null`.
- Health: api - `GET /health` inside the container; worker - a fresh heartbeat
  stamp in Redis (`apps/worker/src/cli/healthcheck.ts`, the rule `/system`
  uses). `docker compose ps` shows both.
- The worker gets 30 s to stop (`stop_grace_period`): its drain has a 25 s
  deadline.
- Uploaded and generated media live in the `media` volume, mounted at
  `/data/media` in api and worker.

### migrate

A one-shot service: `node --import tsx src/cli/migrate.ts && node --import tsx src/cli/seed.ts`
from `packages/db`. It runs on every `docker compose up` and is safe to repeat:
the runner holds a Postgres advisory lock while it migrates (a concurrent
`pnpm db:migrate` waits instead of failing - for at most 120 s, then it stops
with "another migration runner has held the migration lock ..."; look for the
stuck session in `pg_stat_activity`) and skips what is applied; the seed
merges defaults under the stored values. Its log is one line per step:

```
migrations: applied 1, 1 in total        # or: nothing to apply, 1 already applied
app settings seeded
```

api, worker and web start only after it exited with 0. If it failed:
`docker compose logs migrate`.

### Stopping

- `docker compose down` - removes the containers; data stays in the volumes.
- `docker compose down -v` - **also deletes the volumes**: the database, Redis
  and media are gone. The development stack uses the same volumes.

`pnpm check:compose` checks the invariants of these files (only web
published, api's port, production mode, the worker's grace period,
healthchecks (the worker's runs `src/cli/healthcheck.ts`, Redis's asks
`redis-cli ping`; Postgres and Redis have a `start_period`), start after
`migrate` (api and worker after a healthy Redis, web after a healthy api),
the media volume, Postgres ready over TCP, `restart: unless-stopped` on every service but `migrate`, no
`env_file` and the read-only `.env` mount in every app service, and the
`.dockerignore` of every build context: it masks `.env`, `.env.*`,
`**/.env`, `**/.env.*`, no `!` line follows the first mask, and no
`<Dockerfile>.dockerignore` replaces it; `scripts/compose-rules.mjs`). It
needs the Docker CLI, not a running daemon, and reads no `.env`; the gates
run it when a Compose file or `.dockerignore` changes.

## Development

```sh
docker compose -f infra/docker-compose.yml up -d   # Postgres + Redis only
pnpm db:migrate && pnpm db:seed
pnpm dev                                           # api, worker, web on the host
```

Stop the full stack first if it is running: web in a container and `pnpm dev`
both want port 3000.

Postgres and Redis have `restart: unless-stopped` (the full stack's api and
worker need them back after a reboot), so once started they come back with
Docker Desktop or the Docker daemon and keep `127.0.0.1:5442` and
`127.0.0.1:6389` taken until `docker compose -f infra/docker-compose.yml stop`
(or `down`); a stopped service stays stopped across restarts.

## Backups

`scripts/backup.sh` dumps `shorts_factory` from the running `postgres` service
(`pg_dump --format=custom`, through `docker compose exec`, so the host needs no
Postgres client) into `BACKUP_DIR` as `shorts_factory-<UTC timestamp>.dump`, and
keeps the last `KEEP_DAYS` nightly dumps: it deletes its own dumps older than
`KEEP_DAYS` minus half a day, so a run that took a few minutes longer than the
one two weeks ago does not keep one dump more. A failed dump leaves no partial
file, exits non-zero and rotates nothing.

| Variable | Default |
| --- | --- |
| `BACKUP_DIR` | `$HOME/backups/shorts-factory` |
| `KEEP_DAYS` | `14` |
| `SF_COMPOSE_FILE` | `compose.yaml` of the checkout the script is in |

Not `COMPOSE_FILE`: Compose reads that one itself. Dumps are created
readable by their owner only.

Daily at 03:15 on the VPS, from the crontab of the user who runs the stack - a
member of the `docker` group, not root (`crontab -e` as that user; the
repository checked out at `/opt/shorts-factory`). Every path in the line and
in the defaults is that user's own, so the job can write its dump and its log:

```cron
15 3 * * * /opt/shorts-factory/infra/scripts/backup.sh >> "$HOME/sf-backup.log" 2>&1
```

`sf-backup.log` is kept and grows every night, so nothing of `.env` may reach
it: the script calls Compose with `--env-file` on the checkout's
`.env.example`, and Compose does not read the root `.env` for that call (the
running `postgres` needs none of it) - no `variable is not set` with a piece
of a password in the log.

Cron runs the line with `sh` and sets `HOME`; the dumps land in
`~/backups/shorts-factory`. To keep them elsewhere, give that user a directory
of its own first and set it in the line:
`15 3 * * * BACKUP_DIR=/srv/sf-backups /opt/shorts-factory/infra/scripts/backup.sh >> "$HOME/sf-backup.log" 2>&1`.
A directory the user cannot write is reported (`backup: cannot write to ...`,
exit 1) before anything is dumped. Read the log after the first night.

Restore. The dump goes into a new, empty database next to the current one,
and the two swap names only after the restore went through; what was written
after the dump is lost. **On the production database a restore is the owner's
decision**, not an operator routine - take a fresh dump first.

```sh
docker compose stop api worker web
docker compose exec -T postgres createdb -U sf shorts_factory_restore
docker compose exec -T postgres pg_restore -U sf -d shorts_factory_restore --single-transaction --exit-on-error < ~/backups/shorts-factory/shorts_factory-<stamp>.dump
docker compose exec -T postgres psql -U sf -d postgres -v ON_ERROR_STOP=1 -c 'ALTER DATABASE shorts_factory RENAME TO shorts_factory_before_restore; ALTER DATABASE shorts_factory_restore RENAME TO shorts_factory'
docker compose up -d
```

- Into an empty database, not over the current one: `pg_restore --clean` drops
  only the objects that are in the dump. A dump taken before a migration does
  not know the tables that migration created, they stay, and the journal goes
  back to the dump's - the next `migrate` then fails on "already exists". In
  an empty database the dump brings its own schema and journal, and `up -d`
  runs `migrate`, which applies the migrations the dump predates. A dump
  newer than the code (taken from a later release) is not restorable this way.
- `--single-transaction --exit-on-error`: the first error rolls the restore
  back. Nothing else has changed at that point - drop the half-made database
  (`docker compose exec -T postgres dropdb -U sf shorts_factory_restore`) and
  `docker compose up -d` brings the old one back.
- The rename is one statement batch: both names change or neither does. It
  needs every connection to both databases closed - hence the `stop` first.
- Once the restored stack is checked, drop the old database:
  `docker compose exec -T postgres dropdb -U sf shorts_factory_before_restore`.
- Redis is not part of the dump: queued jobs may point at rows the restore
  took away (docs/TECH_DEBT.md).

Check a dump without restoring it:
`docker compose exec -T postgres pg_restore --list < <file>.dump`.
