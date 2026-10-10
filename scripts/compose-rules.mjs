/**
 * The invariants of the full Compose stack, as a pure function over the JSON
 * `docker compose config --format json` prints - so every rule is testable
 * with a hand-written configuration and no Docker at all
 * (apps/worker/test/compose-rules.test.ts). `check-compose.mjs` feeds it the
 * real configuration.
 *
 * 1. Only `web` publishes a port to every interface; api, worker and migrate
 *    publish nothing (api's single password must not face the internet), and
 *    Postgres and Redis - there for the host's `pnpm dev` - bind loopback only.
 * 2. api, worker and web run with NODE_ENV=production (a missing value is
 *    validated as production anyway, but the stack must not depend on that).
 * 3. The worker gets at least 30 s to stop - its drain has a 25 s deadline.
 * 4. api and worker carry a healthcheck; the worker's runs
 *    src/cli/healthcheck.ts (the heartbeat rule of /system) - any other
 *    command, `true` included, says nothing about a worker that stopped
 *    beating. Redis carries one that asks `redis-cli ping`. Both commands are
 *    compared whole, not searched for: `... || exit 0` would pass a search. Postgres and Redis
 *    give their start a `start_period` (rule 8 for the Postgres command): on a
 *    fresh volume Postgres runs initdb and the init scripts first, and on a
 *    slow disk that outlasts the retries - `up` would stop on an unhealthy
 *    database that is only starting.
 * 5. api, worker and web start only after `migrate` exited with 0; api and
 *    worker only after Redis is healthy (nothing else orders them after it),
 *    web only after api is healthy - the dashboard asks api for everything it
 *    shows, Redis included.
 * 6. api and worker share the `media` volume, mounted where their MEDIA_DIR
 *    points.
 * 7. api's port is pinned inside the network, and its healthcheck and web's
 *    API_INTERNAL_URL use that port - an API_PORT from `.env` would otherwise
 *    move the server away from both.
 * 8. Postgres reports ready over TCP: `pg_isready` on the local socket answers
 *    "ready" while the entrypoint still runs its init scripts with TCP closed.
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
 * 11. No `.env` enters an image (`checkBuildIgnores`): every image is built
 *    from the repository root with `COPY . .`, so the `.dockerignore` of its
 *    context is all that keeps the operator's `.env` - and any `.env.local`,
 *    `.env.production` - out of the layers. It masks `.env` and `.env.*` at
 *    the root and at any depth, and no `!` line follows the first mask: the
 *    last matching line wins, and `!**`, `!*.production` or `!apps/**` after
 *    the masks would let a `.env` back in. No `<Dockerfile>.dockerignore`
 *    lies next to a Dockerfile of the stack: BuildKit reads that file instead
 *    of the context's one, and the checked masks would not apply.
 */
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_SERVICES = ["api", "worker", "web"];
/** Published on every interface: the only way in. */
const PUBLISHED = new Set(["web"]);
/** Not published at all, not even on loopback. */
const UNPUBLISHED = new Set(["api", "worker", "migrate"]);
/** Anything else (Postgres, Redis for `pnpm dev`) may bind loopback only. */
const LOOPBACK = new Set(["127.0.0.1", "::1"]);
const MIN_WORKER_GRACE_SEC = 30;
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
/** Redis answers PONG once it accepts commands; the whole command, as above. */
const REDIS_HEALTHCHECK = ["redis-cli", "ping"];
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
const ENV_TARGET = "/repo/.env";
/** `.dockerignore` lines that keep every `.env` out of a build context. */
const ENV_MASKS = [".env", ".env.*", "**/.env", "**/.env.*"];

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
 * Violations of the rendering `RENDERING_PROBE` must survive: the
 * configuration Compose printed for it carries `create_host_path: false`.
 * Empty when it does.
 *
 * @param {{ services?: Record<string, unknown> }} config
 * @returns {string[]}
 */
export function checkRendering(config) {
  const mount = config.services?.probe?.volumes?.[0];
  if (mount?.bind?.create_host_path === false) return [];
  return [
    `this docker compose prints the probe's create_host_path: false as ${JSON.stringify(mount?.bind ?? null)} - rule 10 cannot tell the option from its absence; run the Compose CI pins (.github/workflows/ci.yml)`,
  ];
}

/**
 * `compose.yaml` of the repository the script at `scriptUrl` lives in. Through
 * `fileURLToPath`: a URL's pathname keeps `%20` for a space and the percent
 * escapes of every non-ASCII letter, so a checkout under such a path would
 * point Docker at a file that does not exist.
 *
 * @param {string} scriptUrl `import.meta.url` of a module in `scripts/`
 * @returns {string}
 */
export function defaultComposeFile(scriptUrl) {
  return join(dirname(dirname(fileURLToPath(scriptUrl))), "compose.yaml");
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
  const units = { h: 3600, m: 60, s: 1, ms: 0.001, us: 1e-6, ns: 1e-9 };
  let total = 0;
  let rest = value.trim();
  if (rest === "") return Number.NaN;
  while (rest !== "") {
    const part = /^(\d+(?:\.\d+)?)(h|ms|m|s|us|ns)/.exec(rest);
    if (part === null) return Number.NaN;
    total += Number(part[1]) * units[part[2]];
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
 * Whether a service carries a healthcheck that is not switched off.
 *
 * @param {{ healthcheck?: { disable?: boolean, test?: unknown } } | undefined} service
 * @returns {boolean}
 */
function hasHealthcheck(service) {
  const check = service?.healthcheck;
  return (
    check !== undefined &&
    check.disable !== true &&
    healthcheckCommand(check.test) !== ""
  );
}

/**
 * Whether `service` waits for `dependency` to reach `condition`.
 *
 * @param {{ depends_on?: Record<string, { condition?: string }> }} service
 * @param {string} dependency
 * @param {string} condition
 * @returns {boolean}
 */
function waitsFor(service, dependency, condition) {
  return service.depends_on?.[dependency]?.condition === condition;
}

/**
 * Every violation of the rules above, one line each; empty when clean.
 *
 * @param {{ services?: Record<string, unknown> }} config
 * @param {{ envFile: string }} project `envFile`: absolute path of the
 *   project's `.env`, as Compose resolves a bind source
 * @returns {string[]}
 */
export function checkCompose(config, project) {
  const services = config.services ?? {};
  const problems = [];

  // 1. ports
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
      if (!LOOPBACK.has(port.host_ip)) {
        problems.push(
          `${name}: publishes ${port.published ?? port.target} beyond loopback, only web may`,
        );
      }
    }
  }
  for (const name of PUBLISHED) {
    if ((services[name]?.ports ?? []).length === 0) {
      problems.push(`${name}: publishes no port`);
    }
  }

  // 2, 5. production mode, start after migrate
  for (const name of APP_SERVICES) {
    const service = services[name];
    if (service === undefined) {
      problems.push(`${name}: service is missing`);
      continue;
    }
    if (service.environment?.NODE_ENV !== "production") {
      problems.push(`${name}: environment.NODE_ENV is not "production"`);
    }
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

  // 4, 6. healthcheck, media volume
  for (const name of ["api", "worker"]) {
    const service = services[name];
    if (service === undefined) continue;
    if (!hasHealthcheck(service)) {
      problems.push(`${name}: has no healthcheck`);
    } else if (
      name === "worker" &&
      !runsExactly(service.healthcheck.test, WORKER_HEALTHCHECK)
    ) {
      problems.push(
        "worker: healthcheck does not run src/cli/healthcheck.ts - any other command says nothing about its heartbeat",
      );
    }
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

  // 4. Redis healthcheck; start period of both databases
  const redis = services.redis;
  if (
    redis !== undefined &&
    (!hasHealthcheck(redis) ||
      !runsExactly(redis.healthcheck.test, REDIS_HEALTHCHECK))
  ) {
    problems.push("redis: healthcheck is not redis-cli ping");
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

  // 3. worker grace period
  const worker = services.worker;
  if (worker !== undefined) {
    const grace = durationSec(worker.stop_grace_period);
    if (!(grace >= MIN_WORKER_GRACE_SEC)) {
      problems.push(
        `worker: stop_grace_period ${worker.stop_grace_period ?? "(default 10s)"} is below ${MIN_WORKER_GRACE_SEC}s`,
      );
    }
  }

  // 7. api port: pinned, and the same in its healthcheck and in web's address
  const api = services.api;
  if (api !== undefined) {
    const port = api.environment?.API_PORT;
    if (typeof port !== "string" || !/^\d+$/.test(port)) {
      problems.push(
        "api: environment.API_PORT is not pinned - a value from .env would move the server",
      );
    } else {
      if (!healthcheckCommand(api.healthcheck?.test).includes(`:${port}/`)) {
        problems.push(`api: healthcheck does not ask port ${port}`);
      }
      const internal = services.web?.environment?.API_INTERNAL_URL;
      let target = null;
      try {
        target = new URL(String(internal));
      } catch {
        target = null;
      }
      if (
        target === null ||
        target.hostname !== "api" ||
        target.port !== port
      ) {
        problems.push(
          `web: API_INTERNAL_URL ${internal ?? "(unset)"} is not http://api:${port}`,
        );
      }
    }
  }

  // 8. Postgres ready over TCP
  const postgres = services.postgres;
  if (postgres !== undefined) {
    const command = healthcheckCommand(postgres.healthcheck?.test);
    // A host, not a socket directory: `-h /var/run/postgresql` is the socket.
    // The short option takes its value attached or after spaces
    // (`-h127.0.0.1`, `-h 127.0.0.1`), the long one after `=` or spaces. A
    // host never starts with `=`, so `--host=/var/...` cannot pass with the
    // `=` taken for the first letter of a host.
    const overTcp = /(^|\s)(-h\s*|--host(=|\s+))[^/\s=-]/.test(command);
    if (!/\bpg_isready\b/.test(command) || !overTcp) {
      problems.push(
        "postgres: healthcheck is not pg_isready over TCP (-h) - the local socket answers during init",
      );
    }
  }

  // 9. restart policy of long-running services
  for (const [name, service] of Object.entries(services)) {
    if (ONE_SHOT.has(name)) continue;
    if (service.restart !== RESTART_POLICY) {
      problems.push(
        `${name}: restart is not "${RESTART_POLICY}" - it would stay down after a reboot`,
      );
    }
  }

  // 10. .env mounted and read by @sf/config, never passed as env_file
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
  const problems = [];
  for (const mask of ENV_MASKS) {
    if (!lines.includes(mask)) {
      problems.push(
        `${file}: lacks ${mask} - that .env file would enter the image`,
      );
    }
  }
  const firstMask = lines.findIndex((line) => ENV_MASKS.includes(line));
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

/**
 * Violations of rule 11 for every image the stack builds, one line each;
 * empty when clean. Reads files through `read`, so the rule is testable
 * without a disk.
 *
 * @param {{ services?: Record<string, unknown> }} config
 * @param {(path: string) => string | null} read contents of a file, null if
 *   there is none
 * @returns {string[]}
 */
export function checkBuildIgnores(config, read) {
  const problems = new Set();
  for (const [name, service] of Object.entries(config.services ?? {})) {
    const build = service.build;
    if (build === undefined) continue;
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
