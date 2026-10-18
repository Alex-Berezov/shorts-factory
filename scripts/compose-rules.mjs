/**
 * The invariants of the full Compose stack, as a pure function over the JSON
 * `docker compose config --format json` prints - so every rule is testable
 * with a hand-written configuration and no Docker at all
 * (test/compose-rules.test.ts). `check-compose.mjs` feeds it the
 * real configuration.
 *
 * 0. The stack has all its services: postgres, redis, migrate, api, worker
 *    and web. A missing one is a violation of its own, and the rules below
 *    skip it - a stack without its database must not pass because the rules
 *    about the database found nothing to read.
 * 1. Only `web` publishes a port to every interface; api, worker and migrate
 *    publish nothing (api's single password must not face the internet), and
 *    Postgres and Redis - there for the host's `pnpm dev` - bind loopback only.
 * 2. api, worker and web run with NODE_ENV=production (a missing value is
 *    validated as production anyway, but the stack must not depend on that).
 * 3. The worker gets at least 30 s to stop - its drain has a 25 s deadline -
 *    and api at least 15 s - its stop has a 10 s deadline and the log a 1 s
 *    flush after it. Docker's default 10 s would SIGKILL either mid-stop.
 * 4. api, worker, Postgres and Redis carry a healthcheck that is not switched off
 *    (`disable: true` or a `test` of `["NONE"]` would leave `service_healthy` of rule 5 waiting on a
 *    status that never comes, and the `start_period` below would mean
 *    nothing); the worker's runs
 *    src/cli/healthcheck.ts (the heartbeat rule of /system) - any other
 *    command, `true` included, says nothing about a worker that stopped
 *    beating. Redis carries one that asks `redis-cli ping` and requires the
 *    answer PONG: `redis-cli` exits 0 on an error reply too, so the
 *    `LOADING` of a Redis replaying its append-only file would count as
 *    healthy (both measured, `REDIS_HEALTHCHECK`). Both commands are
 *    compared whole, not searched for: `... || exit 0` would pass a search.
 *    Postgres and Redis give their start a `start_period` (rule 8
 *    for the Postgres command): on a fresh volume Postgres runs initdb and
 *    the init scripts first, and on a slow disk that outlasts the retries -
 *    `up` would stop on an unhealthy database that is only starting.
 * 5. migrate, api and worker start only after Postgres is healthy; api,
 *    worker and web only after `migrate` exited with 0; api and worker only
 *    after Redis is healthy (nothing else orders them after it), web only
 *    after api is healthy - the dashboard asks api for everything it shows,
 *    Redis included.
 * 6. api and worker share the `media` volume, mounted where their MEDIA_DIR
 *    points.
 * 7. api's port is pinned inside the network, and its healthcheck and web's
 *    API_INTERNAL_URL use that port - an API_PORT from `.env` would otherwise
 *    move the server away from both.
 * 8. Postgres reports ready over TCP, by a healthcheck that is on (rule 4):
 *    `pg_isready` on the local socket answers
 *    "ready" while the entrypoint still runs its init scripts with TCP closed.
 *    The command is compared whole with one form (`PG_ISREADY_OPTIONS`), not
 *    searched for a `-h`: `pg_isready` and its options alone, one `-h` with
 *    the loopback written out (one of `TCP_HOSTS`), no `-p` or the one port
 *    Postgres listens on (`PG_PORT`), a database name and no conninfo in `-d`.
 *    Nothing around it - `|| exit 0`, `; true`, a pipe, a second command - and
 *    nothing the shell fills in (`-h "$PGHOST"` may name the socket): the
 *    shell form takes plain words only, the exec form takes its arguments as
 *    they are, quotes included.
 * 9. Every long-running service (all but the one-shot `migrate`) has
 *    `restart: unless-stopped`: after a reboot or a restart of the Docker
 *    daemon only services with a policy come back, and an api or worker
 *    without its Postgres and Redis would answer 503 or crash in a loop.
 * 10. The root `.env` reaches migrate, api, worker and web as a file, read by
 *    @sf/config the way `pnpm dev` reads it - one parser on both paths. No
 *    service has an `env_file` (Compose parses it by a grammar of its own, and
 *    the two disagree on quotes, `#` and `$`); each app service bind-mounts the
 *    project's `.env` at /repo/.env (`rootEnvFilePath` of
 *    packages/config/src/paths.ts in every image), read-only, with
 *    `create_host_path: false` - on a Linux engine a missing `.env` stops the
 *    stack and creates nothing (not verified on Linux yet, docs/TECH_DEBT.md,
 *    E1-12). Docker Desktop (Windows) does not pass the option on: it creates
 *    an empty `.env` directory and `migrate` exits with EISDIR
 *    (infra/README.md). The rule reads the option from what
 *    `docker compose config` prints, and not every Compose prints it:
 *    v2.38 drops `create_host_path: false` and prints `bind: {}`, the same
 *    as for `bind: {}` written by hand, while v5 prints `{}` for
 *    `create_host_path: true`. So the gate first renders `RENDERING_PROBE`
 *    and stops (`checkRendering`) on a Compose that loses the option; CI
 *    pins the Compose it runs (.github/workflows/ci.yml).
 * 11. No `.env` enters an image: every image is built
 *    from the repository root with `COPY . .`, so the `.dockerignore` of its
 *    context is all that keeps the operator's `.env` - and any `.env.local`,
 *    `.env.production` - out of the layers. It masks `.env` and `.env.*` at
 *    the root and at any depth, and no `!` line follows the first mask: the
 *    last matching line wins, and `!**`, `!*.production` or `!apps/**` after
 *    the masks would let a `.env` back in. No `<Dockerfile>.dockerignore`
 *    lies next to a Dockerfile of the stack: BuildKit reads that file instead
 *    of the context's one, and the checked masks would not apply. A mask
 *    counts by what it masks, from a closed list (`MASK_COVERS`): `.env*`
 *    at any depth stands for all four, `.env*` at the root for the two at
 *    the root. No build has
 *    `additional_contexts` or `dockerfile_inline` - the stack has none, and
 *    the rule checks the `.dockerignore` of `build.context` only.
 * 12. `DATABASE_URL` and `REDIS_URL` of the root `.env.test` - the stack the
 *    integration tests reach - point at loopback, a host the stack guard
 *    takes (`localhost`, `127.0.0.1`, `[::1]`), and Postgres and Redis
 *    publish their port on the address of that host (`TEST_STACK_BINDS`:
 *    `localhost` and `127.0.0.1` on 127.0.0.1, `[::1]` on ::1 - a port
 *    published on the other family answers nothing there), to the port the
 *    server listens on in its container (5432, 6379), over TCP - a `/udp`
 *    port does not count, the drivers dial TCP. The file is read with
 *    `parseEnv` of `node:util`, the parser @sf/config and the stack guard
 *    read it with. The rest of each URL - the database name, the Redis
 *    database, the credentials - is the guard's: `TEST_STACK` of
 *    packages/db/test-support is held to `.env.test` by
 *    packages/db/test/stack-guard.test.ts, so Compose, `.env.test` and the
 *    guard agree. No `.env.test`, no key, no URL or a URL without a port are
 *    violations of their own.
 *
 * Each rule is a function of its own in `RULES`, named by its number above;
 * `checkCompose` runs them in that order. The JSON is read only after its
 * shape is checked (`servicesOf`): a field in a form the rules cannot read is
 * a violation of its own, with the path of the field, not a `TypeError`.
 */
import { isAbsolute, join } from "node:path";
import { parseEnv } from "node:util";
import { repoRoot } from "./lib/paths.mjs";

/**
 * What the rules read of a published port, as Compose prints it.
 *
 * @typedef {object} ComposePort
 * @property {unknown} [host_ip]
 * @property {unknown} [published]
 * @property {unknown} [target]
 * @property {unknown} [protocol]
 */

/**
 * What the rules read of a mount.
 *
 * @typedef {object} ComposeVolume
 * @property {unknown} [type]
 * @property {unknown} [source]
 * @property {unknown} [target]
 * @property {unknown} [read_only]
 * @property {{ create_host_path?: unknown }} [bind]
 */

/**
 * What the rules read of a healthcheck; `test` and `start_period` come in
 * more than one form and are told apart where they are read.
 *
 * @typedef {object} ComposeHealthcheck
 * @property {unknown} [disable]
 * @property {unknown} [test]
 * @property {unknown} [start_period]
 */

/**
 * What the rules read of a service, in the shape `servicesOf` checks. Values
 * whose form the rules check themselves stay `unknown`.
 *
 * @typedef {object} ComposeService
 * @property {ComposePort[]} [ports]
 * @property {Record<string, unknown>} [environment]
 * @property {Record<string, { condition?: unknown }>} [depends_on]
 * @property {ComposeHealthcheck} [healthcheck]
 * @property {ComposeVolume[]} [volumes]
 * @property {unknown} [stop_grace_period]
 * @property {unknown} [restart]
 * @property {unknown} [env_file]
 * @property {Record<string, unknown>} [build]
 */

/**
 * What the rules know of the project besides its configuration.
 *
 * @typedef {object} Project
 * @property {string} envFile absolute path of the project's `.env`, as
 *   Compose resolves a bind source
 * @property {string} testEnvFile absolute path of the root `.env.test`
 * @property {(path: string) => string | null} read contents of a file, null
 *   if there is none (`readIfFile` of scripts/lib/files.mjs)
 */

/**
 * One rule of the header: its id and the violations it finds, one line each.
 *
 * @typedef {object} Rule
 * @property {string} id
 * @property {(services: Record<string, ComposeService>, project: Project) => string[]} check
 */

/** The services of the stack (rule 0). */
const REQUIRED_SERVICES = [
  "postgres",
  "redis",
  "migrate",
  "api",
  "worker",
  "web",
];
const APP_SERVICES = ["api", "worker", "web"];
/** Services that talk to Postgres and start only once it is healthy. */
const POSTGRES_CLIENTS = ["migrate", "api", "worker"];
/** Published on every interface: the only way in. */
const PUBLISHED = new Set(["web"]);
/** Not published at all, not even on loopback. */
const UNPUBLISHED = new Set(["api", "worker", "migrate"]);
/** Anything else (Postgres, Redis for `pnpm dev`) may bind loopback only. */
const LOOPBACK = new Set(["127.0.0.1", "::1"]);
/**
 * The least `stop_grace_period` of a service whose stop has a deadline of
 * its own: the deadline (SHUTDOWN_TIMEOUT_MS of apps/worker/src/bootstrap.ts,
 * 25 s; of apps/api/src/compose-app.ts, 10 s), the flush of the log before the
 * exit (FLUSH_TIMEOUT_MS of packages/runtime/src/shutdown.ts, 1 s) and room
 * for the process to leave. Below it the exit code and the last lines of the
 * stop are Docker's SIGKILL, not the service's.
 */
const MIN_GRACE_SEC = { worker: 30, api: 15 };
/**
 * The worker's healthcheck: the heartbeat check, run by node - the whole
 * command, so nothing around it (`|| exit 0`, `; true`, a `#` comment) can
 * turn its failure into a success.
 */
const WORKER_HEALTHCHECK = [
  "node",
  "--import",
  "tsx",
  "src/cli/healthcheck.ts",
];
/**
 * Redis answers PONG once it accepts commands, and `redis-cli` exits 0 on an
 * error reply as well - measured on redis:7-alpine for
 * `ERR wrong number of arguments` and for the `LOADING` of a Redis loading
 * its append-only file (`DEBUG LOADAOF`), tasks/2026-10-18-E0-12C.md - so the
 * answer is compared, in the shell form - the exec form cannot pipe. The
 * whole command, as above.
 */
const REDIS_HEALTHCHECK = "redis-cli ping | grep -qx PONG";
/**
 * Least `start_period` of the databases' healthchecks, in seconds: Postgres
 * runs initdb and the init scripts on a fresh volume (about 50 s seen on a slow
 * disk), Redis replays its append-only file.
 */
const MIN_START_PERIOD_SEC = { postgres: 60, redis: 10 };
const MEDIA_VOLUME = "media";
/** Runs once per `up` and exits; every other service must keep running. */
const ONE_SHOT = new Set(["migrate"]);
const RESTART_POLICY = "unless-stopped";
/** Services that read the root `.env`. */
const ENV_READERS = ["migrate", "api", "worker", "web"];
/** Where @sf/config looks for `.env` inside every image. */
export const ENV_TARGET = "/repo/.env";
/** `.dockerignore` masks that keep every `.env` out of a build context. */
const ENV_MASKS = [".env", ".env.*", "**/.env", "**/.env.*"];
/**
 * Each `.dockerignore` line that masks `.env` files, with the masks of
 * `ENV_MASKS` it stands for. A closed list, not a glob engine: a line not
 * here counts for nothing, so an unknown spelling is a false red, never a
 * false green.
 *
 * @type {Map<string, string[]>}
 */
const MASK_COVERS = new Map([
  [".env", [".env"]],
  [".env.*", [".env.*"]],
  ["**/.env", ["**/.env"]],
  ["**/.env.*", ["**/.env.*"]],
  [".env*", [".env", ".env.*"]],
  ["**/.env*", ENV_MASKS],
]);
/** Build options that bring files the rule does not check into a build. */
const UNCHECKED_BUILD_INPUTS = ["additional_contexts", "dockerfile_inline"];
/**
 * The test stack: each service, the `.env.test` key with its address and the
 * port the server listens on in its container.
 */
const TEST_STACK_URLS = {
  postgres: { key: "DATABASE_URL", target: "5432" },
  redis: { key: "REDIS_URL", target: "6379" },
};
/**
 * Each host a URL of `.env.test` may name - the hosts the stack guard takes
 * (`TEST_STACK.hosts` of packages/db/test-support/stack-guard.ts, an IPv6
 * address without its brackets) - with the loopback address its port must be
 * published on: the same family, since a port on 127.0.0.1 answers nothing
 * on ::1 and the other way round. test/compose-rules.test.ts holds its keys
 * equal to `TEST_STACK.hosts`.
 *
 * @type {Map<string, string>}
 */
export const TEST_STACK_BINDS = new Map([
  ["localhost", "127.0.0.1"],
  ["127.0.0.1", "127.0.0.1"],
  ["::1", "::1"],
]);
/**
 * A Compose file with one bind mount that sets `create_host_path: false`:
 * the Compose that renders the stack must keep the option in its output, or
 * rule 10 cannot tell a mount with it from one without it. Its source is
 * `RENDERING_PROBE_SOURCE` next to the file.
 */
export const RENDERING_PROBE_SOURCE = "probe.env";
export const RENDERING_PROBE = `services:
  probe:
    image: probe
    volumes:
      - type: bind
        source: ./${RENDERING_PROBE_SOURCE}
        target: /probe.env
        bind:
          create_host_path: false
`;

/**
 * Whether `value` is a JSON object (not an array, not null).
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fields of a service that hold an object when present. */
const OBJECT_FIELDS = ["environment", "depends_on", "healthcheck", "build"];
/** Fields of a service that hold a list of objects when present. */
const LIST_FIELDS = ["ports", "volumes"];

/**
 * The path of the first field of `service` the rules cannot read in the form
 * it has (`services.api.ports`), null when they can read every one: a service
 * is an object, `ports`/`volumes` lists of objects, `environment`,
 * `depends_on` (and each of its entries), `healthcheck`, `build` and the
 * `bind` of a mount objects. Fields the rules do not read are not looked at.
 *
 * @param {unknown} service
 * @param {string} path where `service` lies in the configuration
 * @returns {string | null}
 */
function shapeIssue(service, path) {
  if (!isRecord(service)) return path;
  for (const field of OBJECT_FIELDS) {
    const value = service[field];
    if (value !== undefined && !isRecord(value)) return `${path}.${field}`;
  }
  const dependsOn = service.depends_on;
  for (const [name, entry] of Object.entries(
    isRecord(dependsOn) ? dependsOn : {},
  )) {
    if (!isRecord(entry)) return `${path}.depends_on.${name}`;
  }
  for (const field of LIST_FIELDS) {
    const value = service[field];
    if (value === undefined) continue;
    if (!Array.isArray(value)) return `${path}.${field}`;
    for (const [index, item] of value.entries()) {
      if (!isRecord(item)) return `${path}.${field}[${index}]`;
      if (item.bind !== undefined && !isRecord(item.bind)) {
        return `${path}.${field}[${index}].bind`;
      }
    }
  }
  return null;
}

/**
 * The services of a configuration in the shape the rules read, or the
 * violation that names the first field in another shape (and no services).
 * The one place the JSON of `docker compose config` is read for that shape:
 * every field is optional, and each rule reads a field it needs as missing
 * when it is.
 *
 * @param {unknown} config
 * @returns {{ services: Record<string, ComposeService>, problems: string[] }}
 */
function servicesOf(config) {
  /** @type {string[]} */
  const problems = [];
  /** @param {string} path */
  const unexpected = (path) => {
    problems.push(`unexpected shape of docker compose config: ${path}`);
    return { services: {}, problems };
  };
  if (!isRecord(config)) return unexpected("(top level)");
  const listed = config.services ?? {};
  if (!isRecord(listed)) return unexpected("services");
  /** @type {Record<string, ComposeService>} */
  const services = {};
  for (const [name, service] of Object.entries(listed)) {
    const issue = shapeIssue(service, `services.${name}`);
    if (issue !== null) return unexpected(issue);
    // Every field the rules read has the form ComposeService gives it.
    services[name] = /** @type {ComposeService} */ (service);
  }
  return { services, problems };
}

/**
 * Violations of the rendering `RENDERING_PROBE` must survive: the
 * configuration Compose printed for it carries `create_host_path: false`.
 * Empty when it does.
 *
 * @param {unknown} config
 * @returns {string[]}
 */
export function checkRendering(config) {
  const { services, problems } = servicesOf(config);
  if (problems.length > 0) return problems;
  const mount = services.probe?.volumes?.[0];
  if (mount?.bind?.create_host_path === false) return [];
  return [
    `this docker compose prints the probe's create_host_path: false as ${JSON.stringify(mount?.bind ?? null)} - rule 10 cannot tell the option from its absence; run the Compose CI pins (.github/workflows/ci.yml)`,
  ];
}

/**
 * `compose.yaml` at the root of this repository (`scripts/lib/paths.mjs`).
 *
 * @returns {string}
 */
export function defaultComposeFile() {
  return join(repoRoot, "compose.yaml");
}

/**
 * Seconds of a Compose duration ("30s", "1m30s", "1500ms"); NaN if unreadable.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function durationSec(value) {
  if (typeof value === "number") return value / 1e9; // nanoseconds in JSON
  if (typeof value !== "string") return Number.NaN;
  /** @type {Record<string, number>} */
  const units = { h: 3600, m: 60, s: 1, ms: 0.001, us: 1e-6, ns: 1e-9 };
  let total = 0;
  let rest = value.trim();
  if (rest === "") return Number.NaN;
  while (rest !== "") {
    const part = /^(\d+(?:\.\d+)?)(h|ms|m|s|us|ns)/.exec(rest);
    const unit = part === null ? undefined : units[part[2] ?? ""];
    if (part === null || unit === undefined) return Number.NaN;
    total += Number(part[1]) * unit;
    rest = rest.slice(part[0].length);
  }
  return total;
}

/**
 * The command of a healthcheck as one string, whatever form it was written in.
 *
 * @param {unknown} test
 * @returns {string}
 */
function healthcheckCommand(test) {
  if (typeof test === "string") return test;
  if (Array.isArray(test)) return test.map(String).join(" ");
  return "";
}

/**
 * Whether a healthcheck runs exactly `argv`: the exec form
 * (`["CMD", ...argv]`) or the shell form with nothing but those words
 * (`["CMD-SHELL", "a b"]`, or the string Compose turns into it).
 *
 * @param {unknown} test
 * @param {string[]} argv
 * @returns {boolean}
 */
function runsExactly(test, argv) {
  const shell = argv.join(" ");
  if (typeof test === "string") return test === shell;
  if (!Array.isArray(test)) return false;
  if (test[0] === "CMD") {
    return (
      test.length === argv.length + 1 &&
      argv.every((word, index) => test[index + 1] === word)
    );
  }
  return test[0] === "CMD-SHELL" && test.length === 2 && test[1] === shell;
}

/**
 * Whether a healthcheck runs exactly the shell `command`: `["CMD-SHELL",
 * command]`, or the string Compose turns into it. The exec form never
 * matches - it would pass `|` to the program as a word.
 *
 * @param {unknown} test
 * @param {string} command
 * @returns {boolean}
 */
function runsInShell(test, command) {
  if (typeof test === "string") return test === command;
  return (
    Array.isArray(test) &&
    test.length === 2 &&
    test[0] === "CMD-SHELL" &&
    test[1] === command
  );
}

/**
 * Whether a service carries a healthcheck that is not switched off. Compose
 * switches one off two ways: `disable: true`, and a `test` whose first word
 * is `NONE` (`["NONE"]`, what is after it ignored) - both render as they are
 * written.
 *
 * @param {ComposeService | undefined} service
 * @returns {boolean}
 */
function hasHealthcheck(service) {
  const check = service?.healthcheck;
  return (
    check !== undefined &&
    check.disable !== true &&
    !(Array.isArray(check.test) && check.test[0] === "NONE") &&
    healthcheckCommand(check.test) !== ""
  );
}

/**
 * Whether `service` waits for `dependency` to reach `condition`.
 *
 * @param {ComposeService} service
 * @param {string} dependency
 * @param {string} condition
 * @returns {boolean}
 */
function waitsFor(service, dependency, condition) {
  return service.depends_on?.[dependency]?.condition === condition;
}

/**
 * Rule 0: the stack has all its services.
 *
 * @param {Record<string, ComposeService>} services
 * @returns {string[]}
 */
function rule0Services(services) {
  return REQUIRED_SERVICES.filter((name) => services[name] === undefined).map(
    (name) => `${name}: service is missing`,
  );
}

/**
 * Rule 1: only web is published, the databases on loopback only.
 *
 * @param {Record<string, ComposeService>} services
 * @returns {string[]}
 */
function rule1Ports(services) {
  /** @type {string[]} */
  const problems = [];
  for (const [name, service] of Object.entries(services)) {
    if (PUBLISHED.has(name)) continue;
    const ports = service.ports ?? [];
    if (UNPUBLISHED.has(name) && ports.length > 0) {
      problems.push(
        `${name}: publishes ports, it must stay inside the network`,
      );
      continue;
    }
    for (const port of ports) {
      if (!LOOPBACK.has(String(port.host_ip ?? ""))) {
        problems.push(
          `${name}: publishes ${port.published ?? port.target} beyond loopback, only web may`,
        );
      }
    }
  }
  for (const name of PUBLISHED) {
    const service = services[name];
    if (service !== undefined && (service.ports ?? []).length === 0) {
      problems.push(`${name}: publishes no port`);
    }
  }
  return problems;
}

/**
 * Rule 2: the app services run in production mode.
 *
 * @param {Record<string, ComposeService>} services
 * @returns {string[]}
 */
function rule2Production(services) {
  /** @type {string[]} */
  const problems = [];
  for (const name of APP_SERVICES) {
    const service = services[name];
    if (service === undefined) continue;
    if (service.environment?.NODE_ENV !== "production") {
      problems.push(`${name}: environment.NODE_ENV is not "production"`);
    }
  }
  return problems;
}

/**
 * Rule 3: grace periods of the services that stop against a deadline.
 *
 * @param {Record<string, ComposeService>} services
 * @returns {string[]}
 */
function rule3Grace(services) {
  /** @type {string[]} */
  const problems = [];
  for (const [name, least] of Object.entries(MIN_GRACE_SEC)) {
    const service = services[name];
    if (service === undefined) continue;
    const grace = durationSec(service.stop_grace_period);
    if (!(grace >= least)) {
      problems.push(
        `${name}: stop_grace_period ${service.stop_grace_period ?? "(default 10s)"} is below ${least}s`,
      );
    }
  }
  return problems;
}

/**
 * Rule 4: healthchecks of api, worker, Postgres and Redis, each switched on;
 * start period of both databases.
 *
 * @param {Record<string, ComposeService>} services
 * @returns {string[]}
 */
function rule4Healthchecks(services) {
  /** @type {string[]} */
  const problems = [];
  for (const name of ["api", "worker", "postgres"]) {
    const service = services[name];
    if (service === undefined) continue;
    if (!hasHealthcheck(service)) {
      problems.push(`${name}: has no healthcheck`);
    } else if (
      name === "worker" &&
      !runsExactly(service.healthcheck?.test, WORKER_HEALTHCHECK)
    ) {
      problems.push(
        "worker: healthcheck does not run src/cli/healthcheck.ts - any other command says nothing about its heartbeat",
      );
    }
  }
  const redis = services.redis;
  if (
    redis !== undefined &&
    (!hasHealthcheck(redis) ||
      !runsInShell(redis.healthcheck?.test, REDIS_HEALTHCHECK))
  ) {
    problems.push(`redis: healthcheck is not ${REDIS_HEALTHCHECK}`);
  }
  for (const [name, least] of Object.entries(MIN_START_PERIOD_SEC)) {
    const service = services[name];
    if (service === undefined) continue;
    const period = durationSec(service.healthcheck?.start_period);
    if (!(period >= least)) {
      problems.push(
        `${name}: healthcheck start_period ${service.healthcheck?.start_period ?? "(none)"} is below ${least}s - a slow first start would count as unhealthy`,
      );
    }
  }
  return problems;
}

/**
 * Rule 5: start order - after a healthy Postgres, after migrate, a healthy
 * Redis, a healthy api.
 *
 * @param {Record<string, ComposeService>} services
 * @returns {string[]}
 */
function rule5StartOrder(services) {
  /** @type {string[]} */
  const problems = [];
  for (const name of POSTGRES_CLIENTS) {
    const service = services[name];
    if (service === undefined) continue;
    if (!waitsFor(service, "postgres", "service_healthy")) {
      problems.push(
        `${name}: does not wait for a healthy postgres (condition service_healthy)`,
      );
    }
  }
  for (const name of APP_SERVICES) {
    const service = services[name];
    if (service === undefined) continue;
    if (!waitsFor(service, "migrate", "service_completed_successfully")) {
      problems.push(
        `${name}: does not wait for migrate (condition service_completed_successfully)`,
      );
    }
    if (name === "web") {
      if (!waitsFor(service, "api", "service_healthy")) {
        problems.push(
          "web: does not wait for a healthy api (condition service_healthy)",
        );
      }
    } else if (!waitsFor(service, "redis", "service_healthy")) {
      problems.push(
        `${name}: does not wait for a healthy redis (condition service_healthy)`,
      );
    }
  }
  return problems;
}

/**
 * Rule 6: api and worker mount the media volume at their MEDIA_DIR.
 *
 * @param {Record<string, ComposeService>} services
 * @returns {string[]}
 */
function rule6Media(services) {
  /** @type {string[]} */
  const problems = [];
  for (const name of ["api", "worker"]) {
    const service = services[name];
    if (service === undefined) continue;
    const mediaDir = service.environment?.MEDIA_DIR;
    const mounted =
      typeof mediaDir === "string" &&
      (service.volumes ?? []).some(
        (volume) =>
          volume.type === "volume" &&
          volume.source === MEDIA_VOLUME &&
          volume.target === mediaDir,
      );
    if (!mounted) {
      problems.push(
        `${name}: volume ${MEDIA_VOLUME} is not mounted at its MEDIA_DIR (${mediaDir ?? "unset"})`,
      );
    }
  }
  return problems;
}

/**
 * Rule 7: api's port is pinned, and the same in its healthcheck and in
 * web's address.
 *
 * @param {Record<string, ComposeService>} services
 * @returns {string[]}
 */
function rule7ApiPort(services) {
  const api = services.api;
  if (api === undefined) return [];
  const port = api.environment?.API_PORT;
  if (typeof port !== "string" || !/^\d+$/.test(port)) {
    return [
      "api: environment.API_PORT is not pinned - a value from .env would move the server",
    ];
  }
  /** @type {string[]} */
  const problems = [];
  if (!healthcheckCommand(api.healthcheck?.test).includes(`:${port}/`)) {
    problems.push(`api: healthcheck does not ask port ${port}`);
  }
  const web = services.web;
  if (web === undefined) return problems;
  const internal = web.environment?.API_INTERNAL_URL;
  let target = null;
  try {
    target = new URL(String(internal));
  } catch {
    target = null;
  }
  if (target === null || target.hostname !== "api" || target.port !== port) {
    problems.push(
      `web: API_INTERNAL_URL ${internal ?? "(unset)"} is not http://api:${port}`,
    );
  }
  return problems;
}

/**
 * The host `pg_isready` dials over TCP: the container's own loopback, written
 * out (`TCP_HOSTS`) - the healthcheck asks the server it
 * belongs to, not another host. A socket directory (`/var/run/...`) is not
 * one, and neither is a value the shell fills in (`$PGHOST`, `$(...)`, a
 * backtick) or a quoted word of the exec form, where the quotes reach
 * `pg_isready` as they are.
 */
const TCP_HOSTS = ["127.0.0.1", "localhost", "::1"];
const TCP_HOST = new RegExp(
  `^(?:${TCP_HOSTS.map((host) => host.replaceAll(".", "\\.")).join("|")})$`,
);
/**
 * The port `pg_isready` may name: the one Postgres listens on in its
 * container (`TEST_STACK_URLS.postgres.target`); any other asks a server that
 * is not there.
 */
const PG_PORT = new RegExp(`^${TEST_STACK_URLS.postgres.target}$`);
/**
 * The options of `pg_isready` the healthcheck may give, each with the form
 * of its value (null for a flag). `--host`/`-h` is the one that must be
 * there; `-d` takes a database name - a conninfo (`host=...`) or a URI there
 * would name the host again, the socket included.
 *
 * @type {Map<string, RegExp | null>}
 */
const PG_ISREADY_OPTIONS = new Map([
  ["-h", TCP_HOST],
  ["--host", TCP_HOST],
  ["-p", PG_PORT],
  ["--port", PG_PORT],
  ["-U", /^[A-Za-z0-9_.-]+$/],
  ["--username", /^[A-Za-z0-9_.-]+$/],
  ["-d", /^[A-Za-z0-9_-]+$/],
  ["--dbname", /^[A-Za-z0-9_-]+$/],
  ["-t", /^\d+$/],
  ["--timeout", /^\d+$/],
  ["-q", null],
  ["--quiet", null],
]);
/**
 * A shell command of plain words only: no quotes, `$`, backticks, `|`, `&`,
 * `;`, redirections, `#` or line breaks - nothing that makes the shell run
 * anything but the words written.
 */
const PLAIN_WORDS = /^[A-Za-z0-9_.:=/@ -]*$/;

/**
 * The words a healthcheck runs, as the program gets them: the exec form
 * (`["CMD", ...]`) as it is, the shell form (`["CMD-SHELL", "..."]` or the
 * string Compose turns into it) split on spaces when it holds plain words
 * only; null for anything else.
 *
 * @param {unknown} test
 * @returns {string[] | null}
 */
function healthcheckWords(test) {
  if (Array.isArray(test) && test[0] === "CMD") {
    const words = test.slice(1);
    return words.every((word) => typeof word === "string") ? words : null;
  }
  const shell =
    typeof test === "string"
      ? test
      : Array.isArray(test) &&
          test.length === 2 &&
          test[0] === "CMD-SHELL" &&
          typeof test[1] === "string"
        ? test[1]
        : null;
  if (shell === null || !PLAIN_WORDS.test(shell)) return null;
  return shell.split(" ").filter((word) => word !== "");
}

/**
 * Whether `words` are `pg_isready` with options of `PG_ISREADY_OPTIONS`
 * alone and exactly one host. A short option takes its value attached or as
 * the next word (`-h127.0.0.1`, `-h 127.0.0.1`), a long one after `=` or as
 * the next word.
 *
 * @param {string[]} words
 * @returns {boolean}
 */
function isReadyOverTcp(words) {
  if (words[0] !== "pg_isready") return false;
  let hosts = 0;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    const long = /^(--[a-z]+)=(.*)$/.exec(word);
    const short = /^(-[a-zA-Z])(.+)$/.exec(word);
    /** @type {string} */
    let option = word;
    /** @type {string | undefined} */
    let value;
    if (long !== null) {
      option = long[1] ?? "";
      value = long[2] ?? "";
    } else if (short !== null && !word.startsWith("--")) {
      option = short[1] ?? "";
      value = short[2] ?? "";
    }
    if (!PG_ISREADY_OPTIONS.has(option)) return false;
    const form = PG_ISREADY_OPTIONS.get(option) ?? null;
    if (form === null) {
      if (value !== undefined) return false;
      continue;
    }
    if (value === undefined) {
      index += 1;
      value = words[index];
    }
    if (value === undefined || !form.test(value)) return false;
    if (option === "-h" || option === "--host") hosts += 1;
  }
  return hosts === 1;
}

/**
 * Rule 8: Postgres reports ready over TCP.
 *
 * @param {Record<string, ComposeService>} services
 * @returns {string[]}
 */
function rule8PostgresTcp(services) {
  const postgres = services.postgres;
  if (postgres === undefined) return [];
  const words = healthcheckWords(postgres.healthcheck?.test);
  if (!hasHealthcheck(postgres) || words === null || !isReadyOverTcp(words)) {
    return [
      `postgres: healthcheck is not pg_isready over TCP to its own loopback on port ${TEST_STACK_URLS.postgres.target} (-h ${TCP_HOSTS.join("|")}, -p ${TEST_STACK_URLS.postgres.target} or none) - the local socket answers during init`,
    ];
  }
  return [];
}

/**
 * Rule 9: the restart policy of long-running services.
 *
 * @param {Record<string, ComposeService>} services
 * @returns {string[]}
 */
function rule9Restart(services) {
  /** @type {string[]} */
  const problems = [];
  for (const [name, service] of Object.entries(services)) {
    if (ONE_SHOT.has(name)) continue;
    if (service.restart !== RESTART_POLICY) {
      problems.push(
        `${name}: restart is not "${RESTART_POLICY}" - it would stay down after a reboot`,
      );
    }
  }
  return problems;
}

/**
 * Rule 10: `.env` mounted and read by @sf/config, never passed as env_file.
 *
 * @param {Record<string, ComposeService>} services
 * @param {Project} project
 * @returns {string[]}
 */
function rule10EnvMount(services, project) {
  /** @type {string[]} */
  const problems = [];
  for (const [name, service] of Object.entries(services)) {
    if (service.env_file !== undefined) {
      problems.push(
        `${name}: has env_file - Compose would parse .env by its own grammar; mount it at ${ENV_TARGET} instead`,
      );
    }
  }
  for (const name of ENV_READERS) {
    const service = services[name];
    if (service === undefined) continue;
    const mount = (service.volumes ?? []).find(
      (volume) => volume.target === ENV_TARGET,
    );
    if (mount === undefined || mount.type !== "bind") {
      problems.push(`${name}: .env is not bind-mounted at ${ENV_TARGET}`);
      continue;
    }
    if (mount.source !== project.envFile) {
      problems.push(
        `${name}: mounts ${mount.source} at ${ENV_TARGET}, not the project's .env (${project.envFile})`,
      );
    }
    if (mount.read_only !== true) {
      problems.push(`${name}: .env at ${ENV_TARGET} is not read_only`);
    }
    if (mount.bind?.create_host_path !== false) {
      problems.push(
        `${name}: .env mount lacks create_host_path: false - a missing .env would become an empty directory`,
      );
    }
  }
  return problems;
}

/**
 * Rule 11: no `.env` enters an image the stack builds, by the files
 * `project.read` returns.
 *
 * @param {Record<string, ComposeService>} services
 * @param {Project} project
 * @returns {string[]}
 */
function rule11BuildIgnores(services, { read }) {
  /** @type {Set<string>} */
  const problems = new Set();
  for (const [name, service] of Object.entries(services)) {
    const build = service.build;
    if (build === undefined) continue;
    for (const field of UNCHECKED_BUILD_INPUTS) {
      if (build[field] !== undefined) {
        problems.add(
          `${name}: build.${field} - the .env masks are checked for build.context only, and the stack has no ${field}`,
        );
      }
    }
    const context = String(build.context ?? ".");
    const dockerfile = String(build.dockerfile ?? "Dockerfile");
    const dockerfilePath = isAbsolute(dockerfile)
      ? dockerfile
      : join(context, dockerfile);
    const contextIgnore = join(context, ".dockerignore");
    const ownIgnore = `${dockerfilePath}.dockerignore`;
    if (read(ownIgnore) !== null) {
      problems.add(
        `${name}: ${ownIgnore} exists - BuildKit reads it instead of ${contextIgnore}, and the .env masks are not checked there`,
      );
      continue;
    }
    const text = read(contextIgnore);
    if (text === null) {
      problems.add(
        `${name}: no ${contextIgnore} - every .env would enter the image`,
      );
      continue;
    }
    for (const problem of checkDockerignore(text, contextIgnore)) {
      problems.add(problem);
    }
  }
  return [...problems];
}

/**
 * The host (an IPv6 address without its brackets) and the port of a URL, or
 * what keeps them from being read: the URL does not parse, or names no port.
 *
 * @param {string} value
 * @returns {{ host: string, port: string } | "not a URL" | "no port"}
 */
function addressOf(value) {
  /** @type {URL} */
  let url;
  try {
    url = new URL(value);
  } catch {
    return "not a URL";
  }
  if (url.port === "") return "no port";
  return { host: url.hostname.replace(/^\[(.*)\]$/, "$1"), port: url.port };
}

/**
 * Whether a published port is a TCP one: no `protocol` (Compose's default),
 * or `tcp` in any case. Anything else - `udp`, `sctp`, a `null` - is not.
 *
 * @param {unknown} protocol
 * @returns {boolean}
 */
function isTcp(protocol) {
  if (protocol === undefined) return true;
  return typeof protocol === "string" && protocol.toLowerCase() === "tcp";
}

/**
 * Rule 12: the test stack publishes the ports of `.env.test` on the loopback
 * address of their host, to the ports its servers listen on.
 *
 * @param {Record<string, ComposeService>} services
 * @param {Project} project
 * @returns {string[]}
 */
function rule12TestStackPorts(services, project) {
  const text = project.read(project.testEnvFile);
  if (text === null) {
    return [
      `${project.testEnvFile}: missing - the ports the integration tests reach cannot be checked against postgres and redis`,
    ];
  }
  const values = parseEnv(text);
  /** @type {string[]} */
  const problems = [];
  for (const [name, { key, target }] of Object.entries(TEST_STACK_URLS)) {
    const service = services[name];
    if (service === undefined) continue;
    const value = values[key];
    if (value === undefined) {
      problems.push(
        `${project.testEnvFile}: no ${key} - the port ${name} publishes cannot be checked`,
      );
      continue;
    }
    const address = addressOf(value);
    if (typeof address === "string") {
      problems.push(
        address === "no port"
          ? `${project.testEnvFile}: ${key} names no port - write it out, the port ${name} publishes cannot be checked against a default`
          : `${project.testEnvFile}: ${key} is not a URL - the port ${name} publishes cannot be checked`,
      );
      continue;
    }
    const bind = TEST_STACK_BINDS.get(address.host);
    if (bind === undefined) {
      problems.push(
        `${project.testEnvFile}: ${key} points at ${address.host}, not at localhost, 127.0.0.1 or [::1] - the test stack is the one Compose publishes on loopback`,
      );
      continue;
    }
    const published = (service.ports ?? []).find(
      (entry) =>
        isTcp(entry.protocol) &&
        String(entry.host_ip ?? "") === bind &&
        String(entry.published) === address.port,
    );
    if (published === undefined) {
      problems.push(
        `${name}: publishes no port ${address.port} on ${bind} - ${key} of .env.test points there (${address.host})`,
      );
    } else if (String(published.target) !== target) {
      problems.push(
        `${name}: publishes port ${address.port} on ${bind} to ${String(published.target ?? "(none)")}, not to ${target} it listens on - ${key} of .env.test would reach nothing`,
      );
    }
  }
  return problems;
}

/**
 * The rules of the header, in its order.
 *
 * @type {Rule[]}
 */
const RULES = [
  { id: "services", check: rule0Services },
  { id: "ports", check: rule1Ports },
  { id: "production", check: rule2Production },
  { id: "grace", check: rule3Grace },
  { id: "healthchecks", check: rule4Healthchecks },
  { id: "start-order", check: rule5StartOrder },
  { id: "media", check: rule6Media },
  { id: "api-port", check: rule7ApiPort },
  { id: "postgres-tcp", check: rule8PostgresTcp },
  { id: "restart", check: rule9Restart },
  { id: "env-mount", check: rule10EnvMount },
  { id: "build-ignores", check: rule11BuildIgnores },
  { id: "test-stack-ports", check: rule12TestStackPorts },
];

/** The id of every rule `checkCompose` runs, in its order. */
export const RULE_IDS = RULES.map((rule) => rule.id);

/**
 * Every violation of the rules above, one line each; empty when clean. A
 * configuration in a shape the rules cannot read gives that violation alone.
 * `only` runs the rules of those ids, in the order of the table - the way
 * the tests of the root project hold a part of the stack to its rule (rule 11
 * on the Dockerfiles of this repository, test/container.test.ts); the gate
 * runs them all. Rule 0 runs with every choice: the other rules pass over a
 * service that is not there, so a part of the stack that lost one would
 * answer clean. An empty `only` is refused like an unknown id: it
 * would answer clean having checked nothing.
 *
 * @param {unknown} config
 * @param {Project} project
 * @param {readonly string[]} [only]
 * @returns {string[]}
 */
export function checkCompose(config, project, only = RULE_IDS) {
  if (only.length === 0) throw new Error("checkCompose: no rule chosen");
  const unknown = only.filter((id) => !RULE_IDS.includes(id));
  if (unknown.length > 0) {
    throw new Error(`checkCompose: no rule ${unknown.join(", ")}`);
  }
  const { services, problems } = servicesOf(config);
  if (problems.length > 0) return problems;
  return RULES.filter(
    (rule) => rule.check === rule0Services || only.includes(rule.id),
  ).flatMap((rule) => rule.check(services, project));
}

/**
 * Violations of rule 11 in the text of one `.dockerignore`; empty when clean.
 *
 * @param {string} text contents of the file
 * @param {string} file its path, for the messages
 * @returns {string[]}
 */
export function checkDockerignore(text, file) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    // Docker drops a leading slash: `/.env` is `.env`.
    .map((line) => line.replace(/^(!?)\/+/, "$1"));
  /** @type {string[]} */
  const problems = [];
  for (const mask of ENV_MASKS) {
    if (!lines.some((line) => MASK_COVERS.get(line)?.includes(mask))) {
      problems.push(
        `${file}: lacks ${mask} - that .env file would enter the image`,
      );
    }
  }
  const firstMask = lines.findIndex((line) => MASK_COVERS.has(line));
  if (firstMask >= 0) {
    for (const line of lines.slice(firstMask + 1)) {
      if (line.startsWith("!")) {
        problems.push(
          `${file}: ${line} follows the .env masks - the last matching line wins, and it may let a .env back in`,
        );
      }
    }
  }
  return problems;
}
