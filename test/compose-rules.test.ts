import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { z } from "zod";
import {
  COMPOSE_SOURCES,
  DEFAULT_FILES,
  INTERPOLATED,
  OVERRIDE_FILES,
  RENDERING_PROBE,
  RENDERING_PROBE_SOURCE,
  RULE_IDS,
  TEST_STACK_BINDS,
  checkCompose,
  checkDockerignore,
  checkInterpolation,
  checkRendering,
  checkVariables,
  controlEnvOf,
  defaultComposeFile,
  durationSec,
  isComposeSource,
} from "../scripts/compose-rules.mjs";
import { fromRoot, repoRoot } from "../scripts/lib/paths.mjs";
import {
  CLEAN_APP_COMPOSE,
  CLEAN_IGNORE,
  CLEAN_INFRA_COMPOSE,
  CLEAN_ROOT_COMPOSE,
  CLEAN_TEST_ENV,
  type Service,
  buildAt,
  cleanFilesAt,
  cleanStack,
  realpathIn,
} from "./compose-fixture.js";
import {
  readRepoFile,
  readRepoJson,
  readRepoYaml,
  repoFileExists,
} from "./repo-files.js";

/**
 * The rules `pnpm check:compose` holds the full stack to, each fed a
 * configuration that breaks it - in the shape `docker compose config --format
 * json` prints, so no Docker is needed here. Next to the image tests of the
 * root project (container.test.ts): both guard how the containers of this
 * repository are started.
 */

/** The project's `.env`, absolute, as Compose resolves `../.env` of a bind. */
const PROJECT_ENV = "/srv/shorts-factory/.env";
/** The build context of every image: the root of the project. */
const CONTEXT = resolve("/srv", "shorts-factory");
/** The root `.env.test` of the project. */
const TEST_ENV_FILE = join(CONTEXT, ".env.test");
/** A reader of the files in `files` (path -> contents), null for others. */
function reader(files: Record<string, string>) {
  return (path: string): string | null => files[path] ?? null;
}

/** The files the rules read of a clean project. */
function cleanFiles(): Record<string, string> {
  return cleanFilesAt(CONTEXT);
}

/** The root Compose file of the project of `check`. */
const COMPOSE_FILE = join(CONTEXT, "compose.yaml");

/**
 * The project of `check`: its root Compose file, its `.env`, its
 * `.env.test`, `read` and `realpath` (by default one over nothing).
 */
function projectWith(
  read: (path: string) => string | null,
  realpath: (path: string) => string = realpathIn({}),
) {
  return {
    composeFile: COMPOSE_FILE,
    envFile: PROJECT_ENV,
    testEnvFile: TEST_ENV_FILE,
    read,
    realpath,
  };
}

/** The files of `cleanFiles` changed by `files` (a null removes one). */
function filesWith(
  files: Record<string, string | null>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...cleanFiles(), ...files }).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  );
}

/**
 * `checkCompose` for a project whose `.env` is `PROJECT_ENV`, with the files
 * of `cleanFiles` changed by `files` (a null removes one) and the links of
 * `links` (path -> target) on its disk.
 */
function check(
  config: unknown,
  files: Record<string, string | null> = {},
  links: Record<string, string> = {},
): string[] {
  const present = filesWith(files);
  return checkCompose(
    config,
    projectWith(reader(present), realpathIn(present, links)),
  );
}

/** Rule 11 alone, the way test/container.test.ts runs it, with `read`. */
function buildIgnores(
  config: unknown,
  read: (path: string) => string | null,
): string[] {
  return checkCompose(config, projectWith(read), ["build-ignores"]);
}

/** The build of a service's image, as Compose prints it. */
function buildOf(name: string): Service {
  return buildAt(CONTEXT, name);
}

/** The resolved configuration of a correct stack, as Compose prints it. */
function cleanConfig(): { services: Record<string, Service> } {
  return cleanStack({ context: CONTEXT, envFile: PROJECT_ENV });
}

/** A clean configuration without the service `name`. */
function without(name: string): { services: Record<string, Service> } {
  const { services } = cleanConfig();
  return {
    services: Object.fromEntries(
      Object.entries(services).filter(([other]) => other !== name),
    ),
  };
}

/** A clean configuration with one service changed by `change`. */
function broken(
  name: string,
  change: (service: Service) => void,
): { services: Record<string, Service> } {
  const config = cleanConfig();
  const service = config.services[name];
  if (service === undefined) {
    throw new Error(`no service ${name} in the fixture`);
  }
  change(service);
  return config;
}

function environmentOf(service: Service): Record<string, unknown> {
  const environment = service.environment;
  if (typeof environment !== "object" || environment === null) {
    throw new Error("service has no environment in the fixture");
  }
  return environment as Record<string, unknown>;
}

function dependsOnOf(service: Service): Record<string, unknown> {
  const dependsOn = service.depends_on;
  if (typeof dependsOn !== "object" || dependsOn === null) {
    throw new Error("service has no depends_on in the fixture");
  }
  return dependsOn as Record<string, unknown>;
}

function volumesOf(service: Service): Record<string, unknown>[] {
  const volumes = service.volumes;
  if (!Array.isArray(volumes)) {
    throw new Error("service has no volumes in the fixture");
  }
  return volumes as Record<string, unknown>[];
}

function healthcheckOf(service: Service): Record<string, unknown> {
  const healthcheck = service.healthcheck;
  if (typeof healthcheck !== "object" || healthcheck === null) {
    throw new Error("service has no healthcheck in the fixture");
  }
  return healthcheck as Record<string, unknown>;
}

/** The `.env` mount of a fixture service. */
function envMountOf(service: Service): Record<string, unknown> {
  const mount = volumesOf(service).find(
    (volume) => volume.target === "/repo/.env",
  );
  if (mount === undefined) {
    throw new Error("service has no .env mount in the fixture");
  }
  return mount;
}

describe("checkCompose", () => {
  it("passes the stack as it should be", () => {
    expect(check(cleanConfig())).toEqual([]);
  });

  describe("1. only web is published", () => {
    it.each(["api", "worker", "migrate"])("refuses a port on %s", (name) => {
      const config = broken(name, (service) => {
        service.ports = [{ host_ip: "127.0.0.1", target: 3001 }];
      });

      expect(check(config)).toContain(
        `${name}: publishes ports, it must stay inside the network`,
      );
    });

    it("refuses Postgres beyond loopback", () => {
      const config = broken("postgres", (service) => {
        service.ports = [{ target: 5432, published: "5442" }];
      });

      // Rule 12 too: the integration tests reach the port on loopback.
      expect(check(config)).toEqual([
        "postgres: publishes 5442 beyond loopback, only web may",
        "postgres: publishes no port 5442 on 127.0.0.1 - DATABASE_URL of .env.test points there (localhost)",
      ]);
    });

    it("refuses a web that publishes nothing", () => {
      const config = broken("web", (service) => {
        service.ports = undefined;
      });

      expect(check(config)).toEqual(["web: publishes no port"]);
    });
  });

  describe("2. production mode", () => {
    it.each(["api", "worker", "web"])(
      "refuses %s without NODE_ENV=production",
      (name) => {
        const config = broken(name, (service) => {
          environmentOf(service).NODE_ENV = undefined;
        });

        expect(check(config)).toContain(
          `${name}: environment.NODE_ENV is not "production"`,
        );
      },
    );
  });

  describe("3. the grace periods", () => {
    it.each(["10s", undefined, "29s", "nonsense"])(
      "refuses stop_grace_period %s",
      (grace) => {
        const config = broken("worker", (service) => {
          service.stop_grace_period = grace;
        });

        expect(check(config)).toHaveLength(1);
        expect(check(config)[0]).toMatch(
          /^worker: stop_grace_period .* is below 30s$/,
        );
      },
    );

    it("accepts a longer one in any unit", () => {
      const config = broken("worker", (service) => {
        service.stop_grace_period = "1m";
      });

      expect(check(config)).toEqual([]);
    });

    // api: a 10 s deadline and a 1 s flush - Docker's default 10 s kills it
    // with 137 before its own verdict.
    it.each(["10s", undefined, "14s", "nonsense"])(
      "refuses stop_grace_period %s for api",
      (grace) => {
        const config = broken("api", (service) => {
          service.stop_grace_period = grace;
        });

        expect(check(config)).toHaveLength(1);
        expect(check(config)[0]).toMatch(
          /^api: stop_grace_period .* is below 15s$/,
        );
      },
    );

    it("accepts 15 s and more for api", () => {
      const config = broken("api", (service) => {
        service.stop_grace_period = "1m";
      });

      expect(check(config)).toEqual([]);
    });
  });

  describe("4. healthchecks", () => {
    it.each(["api", "worker"])("refuses %s without one", (name) => {
      const config = broken(name, (service) => {
        service.healthcheck = undefined;
      });

      expect(check(config)).toContain(`${name}: has no healthcheck`);
    });

    it("refuses a disabled one", () => {
      const config = broken("worker", (service) => {
        service.healthcheck = { disable: true };
      });

      expect(check(config)).toEqual(["worker: has no healthcheck"]);
    });

    it("refuses a redis healthcheck disabled around the right command", () => {
      // The command passes `runsInShell` on its own: only the switch-off
      // check of `hasHealthcheck` can refuse this one.
      const config = broken("redis", (service) => {
        healthcheckOf(service).disable = true;
        healthcheckOf(service).test = [
          "CMD-SHELL",
          "redis-cli ping | grep -qx PONG",
        ];
      });

      expect(check(config)).toEqual([
        "redis: healthcheck is not redis-cli ping | grep -qx PONG",
      ]);
    });

    it.each(["api", "worker"])(
      "refuses %s healthcheck switched off by a bare [NONE]",
      (name) => {
        const config = broken(name, (service) => {
          healthcheckOf(service).test = ["NONE"];
        });

        // api's port rule also fires on an empty command; only the first line
        // is the subject here.
        expect(check(config)).toContain(`${name}: has no healthcheck`);
      },
    );

    it.each([
      ["api", ["NONE", "curl", "-f", "http://localhost:3001/health/live"]],
      ["worker", ["NONE", "node", "--import", "tsx", "src/cli/healthcheck.ts"]],
    ])("refuses %s healthcheck switched off by %j", (name, test) => {
      // Compose ignores what follows NONE: the service never reports healthy,
      // whatever port the words after it name (rule 7).
      const config = broken(name, (service) => {
        healthcheckOf(service).test = test;
      });

      expect(check(config)).toEqual([`${name}: has no healthcheck`]);
    });

    it.each([[["NONE"]], [["NONE", "redis-cli", "ping"]]])(
      "refuses a redis healthcheck switched off by %j",
      (test) => {
        const config = broken("redis", (service) => {
          healthcheckOf(service).test = test;
        });

        expect(check(config)).toEqual([
          "redis: healthcheck is not redis-cli ping | grep -qx PONG",
        ]);
      },
    );

    it.each([
      [["NONE"]],
      [["NONE", "pg_isready", "-h", "127.0.0.1", "-U", "sf"]],
    ])("refuses a postgres healthcheck switched off by %j", (test) => {
      const config = broken("postgres", (service) => {
        healthcheckOf(service).test = test;
      });

      expect(check(config)).toEqual([
        "postgres: has no healthcheck",
        "postgres: healthcheck is not pg_isready over TCP to its own loopback on port 5432 (-h 127.0.0.1|localhost|::1, -p 5432 or none) - the local socket answers during init",
      ]);
    });

    it.each([
      [["CMD", "true"]],
      [["CMD-SHELL", "exit 0"]],
      [["CMD", "node", "-e", "process.exit(0)"]],
      [["CMD", "node", "--import", "tsx", "src/cli/smoke.ts"]],
      [["CMD-SHELL", "node --import tsx src/cli/healthcheck.ts || exit 0"]],
      [["CMD-SHELL", "node --import tsx src/cli/healthcheck.ts || :"]],
      [["CMD-SHELL", "true # node --import tsx src/cli/healthcheck.ts"]],
      [
        [
          "CMD",
          "node",
          "--import",
          "tsx",
          "src/cli/healthcheck.ts",
          "--ignore-errors",
        ],
      ],
    ])("refuses a worker healthcheck %j", (test) => {
      const config = broken("worker", (service) => {
        healthcheckOf(service).test = test;
      });

      expect(check(config)).toEqual([
        "worker: healthcheck does not run src/cli/healthcheck.ts - any other command says nothing about its heartbeat",
      ]);
    });

    it("accepts the worker healthcheck in the shell form", () => {
      const config = broken("worker", (service) => {
        healthcheckOf(service).test = [
          "CMD-SHELL",
          "node --import tsx src/cli/healthcheck.ts",
        ];
      });

      expect(check(config)).toEqual([]);
    });

    it.each([
      ["without one", undefined],
      ["with a disabled one", { disable: true }],
      [
        "with one that asks nothing",
        { test: ["CMD", "true"], start_period: "10s" },
      ],
      [
        "whose failure is swallowed",
        {
          test: ["CMD-SHELL", "redis-cli ping || exit 0"],
          start_period: "10s",
        },
      ],
      [
        "whose failure is ignored",
        { test: ["CMD-SHELL", "redis-cli ping || :"], start_period: "10s" },
      ],
      [
        "that only mentions it",
        { test: ["CMD-SHELL", "true # redis-cli ping"], start_period: "10s" },
      ],
      // redis-cli exits 0 on an error reply: LOADING would pass these two.
      [
        "that ignores the answer",
        { test: ["CMD", "redis-cli", "ping"], start_period: "10s" },
      ],
      [
        "that ignores the answer in the shell form",
        { test: ["CMD-SHELL", "redis-cli ping"], start_period: "10s" },
      ],
      [
        "in the exec form, where | is a word",
        {
          test: ["CMD", "redis-cli", "ping", "|", "grep", "-qx", "PONG"],
          start_period: "10s",
        },
      ],
      [
        "whose comparison is swallowed",
        {
          test: ["CMD-SHELL", "redis-cli ping | grep -qx PONG || exit 0"],
          start_period: "10s",
        },
      ],
    ])("refuses redis %s", (_case, healthcheck) => {
      const config = broken("redis", (service) => {
        service.healthcheck = healthcheck;
      });

      expect(check(config)).toContain(
        "redis: healthcheck is not redis-cli ping | grep -qx PONG",
      );
    });

    it("accepts the Redis healthcheck as a string", () => {
      const config = broken("redis", (service) => {
        healthcheckOf(service).test = "redis-cli ping | grep -qx PONG";
      });

      expect(check(config)).toEqual([]);
    });

    it.each([
      ["postgres", undefined, "60"],
      ["postgres", "30s", "60"],
      ["redis", undefined, "10"],
      ["redis", "5s", "10"],
    ])("refuses %s with start_period %s", (name, period, least) => {
      const config = broken(name, (service) => {
        healthcheckOf(service).start_period = period;
      });

      expect(check(config)).toEqual([
        `${name}: healthcheck start_period ${period ?? "(none)"} is below ${least}s - a slow first start would count as unhealthy`,
      ]);
    });
  });

  describe("5. start order: after migrate, a healthy redis, a healthy api", () => {
    it.each(["api", "worker", "web"])(
      "refuses %s that does not wait for it",
      (name) => {
        const config = broken(name, (service) => {
          service.depends_on = { migrate: { condition: "service_started" } };
        });

        expect(check(config)).toContain(
          `${name}: does not wait for migrate (condition service_completed_successfully)`,
        );
      },
    );

    it.each([
      ["api", undefined],
      ["api", "service_started"],
      ["worker", undefined],
      ["worker", "service_started"],
    ])(
      "refuses %s that does not wait for a healthy redis (%s)",
      (name, condition) => {
        const config = broken(name, (service) => {
          service.depends_on = {
            migrate: { condition: "service_completed_successfully" },
            postgres: { condition: "service_healthy" },
            ...(condition === undefined ? {} : { redis: { condition } }),
          };
        });

        expect(check(config)).toEqual([
          `${name}: does not wait for a healthy redis (condition service_healthy)`,
        ]);
      },
    );

    it.each([
      ["migrate", undefined],
      ["migrate", "service_started"],
      ["api", undefined],
      ["api", "service_started"],
      ["worker", undefined],
      ["worker", "service_started"],
    ])(
      "refuses %s that does not wait for a healthy postgres (%s)",
      (name, condition) => {
        const config = broken(name, (service) => {
          const others = Object.entries(dependsOnOf(service)).filter(
            ([dependency]) => dependency !== "postgres",
          );
          service.depends_on = Object.fromEntries(
            condition === undefined
              ? others
              : [...others, ["postgres", { condition }]],
          );
        });

        expect(check(config)).toEqual([
          `${name}: does not wait for a healthy postgres (condition service_healthy)`,
        ]);
      },
    );

    it.each([undefined, "service_started"])(
      "refuses a web that does not wait for a healthy api (%s)",
      (condition) => {
        const config = broken("web", (service) => {
          service.depends_on = {
            migrate: { condition: "service_completed_successfully" },
            ...(condition === undefined ? {} : { api: { condition } }),
          };
        });

        expect(check(config)).toEqual([
          "web: does not wait for a healthy api (condition service_healthy)",
        ]);
      },
    );
  });

  describe("6. the media volume", () => {
    it.each(["api", "worker"])("refuses %s without it", (name) => {
      const config = broken(name, (service) => {
        service.volumes = volumesOf(service).filter(
          (volume) => volume.source !== "media",
        );
      });

      expect(check(config)).toEqual([
        `${name}: volume media is not mounted at its MEDIA_DIR (/data/media)`,
      ]);
    });

    it("refuses a mount somewhere MEDIA_DIR does not point", () => {
      const config = broken("worker", (service) => {
        environmentOf(service).MEDIA_DIR = "/srv/media";
      });

      expect(check(config)).toEqual([
        "worker: volume media is not mounted at its MEDIA_DIR (/srv/media)",
      ]);
    });
  });

  describe("7. api's port", () => {
    it("refuses an API_PORT left to .env", () => {
      const config = broken("api", (service) => {
        environmentOf(service).API_PORT = undefined;
      });

      expect(check(config)).toEqual([
        "api: environment.API_PORT is not pinned - a value from .env would move the server",
      ]);
    });

    it("refuses a healthcheck on another port", () => {
      const config = broken("api", (service) => {
        environmentOf(service).API_PORT = "4001";
      });

      expect(check(config)).toEqual([
        "api: healthcheck does not ask port 4001",
        "web: API_INTERNAL_URL http://api:3001 is not http://api:4001",
      ]);
    });

    it("refuses a web that looks for api elsewhere", () => {
      const config = broken("web", (service) => {
        environmentOf(service).API_INTERNAL_URL = "http://localhost:3001";
      });

      expect(check(config)).toEqual([
        "web: API_INTERNAL_URL http://localhost:3001 is not http://api:3001",
      ]);
    });
  });

  describe("8. Postgres ready over TCP", () => {
    it.each([
      ["CMD-SHELL", "pg_isready -U sf"],
      ["CMD", "pg_isready", "-h", "/var/run/postgresql", "-U", "sf"],
      ["CMD", "pg_isready", "--host=/var/run/postgresql", "-U", "sf"],
      ["CMD", "pg_isready", "-h/var/run/postgresql", "-U", "sf"],
      ["CMD", "pg_isready", "-h=/var/run/postgresql", "-U", "sf"],
      ["CMD", "pg_isready", '-h"/var/run/postgresql"', "-U", "sf"],
      ["CMD", "pg_isready", "-h", "'/var/run/postgresql'", "-U", "sf"],
      ["CMD", "pg_isready", '--host="/var/run/postgresql"', "-U", "sf"],
      ["CMD-SHELL", "pg_isready -h '/var/run/postgresql' -U sf"],
      // The shell fills these in, and PGHOST may name the socket.
      ["CMD-SHELL", 'pg_isready -h "$PGHOST" -U sf'],
      ["CMD-SHELL", "pg_isready -h $PGHOST -U sf"],
      ["CMD-SHELL", "pg_isready --host=$(hostname -i) -U sf"],
      ["CMD-SHELL", "pg_isready -h `hostname -i` -U sf"],
      // Every -h names a host, whichever one pg_isready ends up taking.
      ["CMD-SHELL", "pg_isready -h 127.0.0.1 -h /var/run/postgresql -U sf"],
      ["CMD", "pg_isready", "-h", "-U", "sf"],
      ["CMD", "true"],
      // The command is compared whole: nothing around pg_isready, no second
      // command, no -h of another program, no conninfo in -d.
      ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U sf || exit 0"],
      ["CMD-SHELL", "echo -h localhost; pg_isready -U sf"],
      ["CMD-SHELL", "pg_isready -U sf | grep -h accepting"],
      ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U sf && pg_isready -U sf"],
      ["CMD-SHELL", 'pg_isready -h 127.0.0.1 -d "host=/var/run/postgresql"'],
      [
        "CMD",
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-d",
        "host=/var/run/postgresql",
      ],
      [
        "CMD",
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-d",
        "postgresql:///sf?host=/var/run/postgresql",
      ],
      ["CMD", "sh", "-c", "pg_isready -h 127.0.0.1"],
      ["CMD", "pg_isready", "-h", "127.0.0.1", "--no-such-option"],
      ["CMD", "pg_isready", "-h", "127.0.0.1", "-U"],
      ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U sf # ready"],
      // The exec form passes its words as they are: the quotes reach
      // pg_isready, which reads a host named with them.
      ["CMD", "pg_isready", '-h"127.0.0.1"', "-U", "sf"],
      ["CMD", "pg_isready", "-h", "'127.0.0.1'", "-U", "sf"],
      // The shell form takes plain words only.
      ["CMD-SHELL", "pg_isready -h '127.0.0.1' -U sf"],
      // The healthcheck asks its own server: the loopback, on 5432.
      ["CMD", "pg_isready", "-h", "some-other-host", "-U", "sf"],
      ["CMD", "pg_isready", "--host=db.example.com", "-U", "sf"],
      ["CMD-SHELL", "pg_isready -h 10.0.0.5 -U sf"],
      ["CMD", "pg_isready", "-h", "127.0.0.1", "-p", "1", "-U", "sf"],
      ["CMD", "pg_isready", "-h", "127.0.0.1", "--port=5442", "-U", "sf"],
      ["CMD-SHELL", "pg_isready -h localhost -p5433 -U sf"],
    ])("refuses %j", (...test) => {
      const config = broken("postgres", (service) => {
        healthcheckOf(service).test = test;
      });

      expect(check(config)).toEqual([
        "postgres: healthcheck is not pg_isready over TCP to its own loopback on port 5432 (-h 127.0.0.1|localhost|::1, -p 5432 or none) - the local socket answers during init",
      ]);
    });

    it("refuses a pg_isready over TCP that is switched off", () => {
      // `service_healthy` of migrate, api and worker would wait for a status
      // a disabled healthcheck never reports.
      const config = broken("postgres", (service) => {
        healthcheckOf(service).disable = true;
      });

      expect(check(config)).toEqual([
        "postgres: has no healthcheck",
        "postgres: healthcheck is not pg_isready over TCP to its own loopback on port 5432 (-h 127.0.0.1|localhost|::1, -p 5432 or none) - the local socket answers during init",
      ]);
    });

    it.each([
      ["--host=127.0.0.1"],
      ["--host", "127.0.0.1"],
      ["-h127.0.0.1"],
      ["-h", "127.0.0.1"],
      ["-h", "localhost", "-p", "5432", "-d", "shorts_factory", "-q"],
      ["-h", "::1", "--port=5432"],
    ])("accepts a host given as %j", (...host) => {
      const config = broken("postgres", (service) => {
        healthcheckOf(service).test = [
          "CMD",
          "pg_isready",
          ...host,
          "-U",
          "sf",
        ];
      });

      expect(check(config)).toEqual([]);
    });

    it.each([
      [["CMD-SHELL", "pg_isready -h 127.0.0.1 -U sf -d shorts_factory"]],
      ["pg_isready -h 127.0.0.1 -U sf"],
    ])("accepts the shell form %j", (test) => {
      const config = broken("postgres", (service) => {
        healthcheckOf(service).test = test;
      });

      expect(check(config)).toEqual([]);
    });
  });

  describe("9. long-running services come back", () => {
    it.each(["postgres", "redis", "api", "worker", "web"])(
      "refuses %s without a restart policy",
      (name) => {
        const config = broken(name, (service) => {
          service.restart = undefined;
        });

        expect(check(config)).toEqual([
          `${name}: restart is not "unless-stopped" - it would stay down after a reboot`,
        ]);
      },
    );

    it("refuses a policy that gives up", () => {
      const config = broken("redis", (service) => {
        service.restart = "on-failure";
      });

      expect(check(config)).toEqual([
        'redis: restart is not "unless-stopped" - it would stay down after a reboot',
      ]);
    });

    it("leaves the one-shot migrate alone", () => {
      const config = broken("migrate", (service) => {
        service.restart = undefined;
      });

      expect(check(config)).toEqual([]);
    });
  });

  describe("10. .env mounted for @sf/config, never an env_file", () => {
    const readers = ["migrate", "api", "worker", "web"];

    it.each(["migrate", "api", "worker", "web", "postgres"])(
      "refuses an env_file on %s",
      (name) => {
        const config = broken(name, (service) => {
          service.env_file = [{ path: PROJECT_ENV, format: "raw" }];
        });

        expect(check(config)).toEqual([
          `${name}: has env_file - Compose would parse .env by its own grammar; mount it at /repo/.env instead`,
        ]);
      },
    );

    it.each(readers)("refuses %s without the mount", (name) => {
      const config = broken(name, (service) => {
        service.volumes = volumesOf(service).filter(
          (volume) => volume.target !== "/repo/.env",
        );
      });

      expect(check(config)).toEqual([
        `${name}: .env is not bind-mounted at /repo/.env`,
      ]);
    });

    it("refuses a volume in place of the bind", () => {
      const config = broken("api", (service) => {
        envMountOf(service).type = "volume";
      });

      expect(check(config)).toEqual([
        "api: .env is not bind-mounted at /repo/.env",
      ]);
    });

    it.each(readers)("refuses %s mounting another file", (name) => {
      const config = broken(name, (service) => {
        envMountOf(service).source = "/srv/shorts-factory/.env.example";
      });

      expect(check(config)).toEqual([
        `${name}: mounts /srv/shorts-factory/.env.example at /repo/.env, not the project's .env (${PROJECT_ENV})`,
      ]);
    });

    it.each(readers)("refuses %s with a writable mount", (name) => {
      const config = broken(name, (service) => {
        envMountOf(service).read_only = undefined;
      });

      expect(check(config)).toEqual([
        `${name}: .env at /repo/.env is not read_only`,
      ]);
    });

    it.each([
      ["without bind options", undefined],
      ["creating the host path", { create_host_path: true }],
      // Docker Compose v2.38 prints `create_host_path: false` this way too:
      // the option is not in the output, and the mount is refused with it.
      ["with empty bind options", {}],
    ])("refuses a mount %s", (_case, bind) => {
      // The short syntax `../.env:/repo/.env:ro` prints as the second one.
      const config = broken("web", (service) => {
        envMountOf(service).bind = bind;
      });

      expect(check(config)).toEqual([
        "web: .env mount lacks create_host_path: false - a missing .env would become an empty directory",
      ]);
    });
  });

  describe("0. every service of the stack is there", () => {
    it.each(["postgres", "redis", "migrate", "api", "worker", "web"])(
      "refuses a stack without %s",
      (name) => {
        const config = without(name);

        expect(check(config)).toEqual([`${name}: service is missing`]);
      },
    );
  });

  describe("11. builds bring in nothing the rule does not check", () => {
    it.each([
      ["additional_contexts", { extra: "/srv/other" }],
      ["dockerfile_inline", "FROM node:22-alpine\nCOPY . .\n"],
    ])("refuses a build with %s", (field, value) => {
      const config = broken("api", (service) => {
        service.build = { ...buildOf("api"), [field]: value };
      });

      expect(check(config)).toEqual([
        `api: build.${field} - the .env masks are checked for build.context only, and the stack has no ${field}`,
      ]);
    });

    it("refuses a stack whose context has no .dockerignore", () => {
      expect(
        check(cleanConfig(), { [join(CONTEXT, ".dockerignore")]: null }),
      ).toEqual(
        ["migrate", "api", "worker", "web"].map(
          (name) =>
            `${name}: no ${join(CONTEXT, ".dockerignore")} - every .env would enter the image`,
        ),
      );
    });
  });

  describe("12. the test stack publishes the ports of .env.test", () => {
    it("takes the hosts the stack guard takes, no more and no fewer", () => {
      // The hosts of `TEST_STACK` read as text: the root project imports no
      // package (ADR-0011), as turbo-env.test.ts reads the config schema.
      const guard = readRepoFile("packages/db/test-support/stack-guard.ts");
      const declared = /\bhosts: \[([^\]]*)\]/.exec(guard)?.[1];
      const hosts = [...(declared ?? "").matchAll(/"([^"]+)"/g)].map(
        (match) => match[1],
      );

      expect(hosts.length).toBeGreaterThan(0);
      expect([...TEST_STACK_BINDS.keys()].sort()).toEqual(hosts.sort());
    });

    it("refuses a project without .env.test", () => {
      expect(check(cleanConfig(), { [TEST_ENV_FILE]: null })).toEqual([
        `${TEST_ENV_FILE}: missing - the ports the integration tests reach cannot be checked against postgres and redis`,
      ]);
    });

    it.each([
      ["postgres", "5443", "5442", "DATABASE_URL"],
      ["redis", "6390", "6389", "REDIS_URL"],
    ])(
      "refuses %s published on %s while .env.test points at %s",
      (name, published, expected, key) => {
        const config = broken(name, (service) => {
          service.ports = [{ host_ip: "127.0.0.1", target: 1, published }];
        });

        expect(check(config)).toEqual([
          `${name}: publishes no port ${expected} on 127.0.0.1 - ${key} of .env.test points there (localhost)`,
        ]);
      },
    );

    it.each([
      ["postgres", "5442", "DATABASE_URL"],
      ["redis", "6389", "REDIS_URL"],
    ])("refuses %s publishing %s over UDP only", (name, published, key) => {
      // The drivers dial TCP: a /udp port of the same number answers nothing.
      const target = name === "postgres" ? 5432 : 6379;
      const config = broken(name, (service) => {
        service.ports = [
          { host_ip: "127.0.0.1", target, published, protocol: "udp" },
        ];
      });

      expect(check(config)).toEqual([
        `${name}: publishes no port ${published} on 127.0.0.1 - ${key} of .env.test points there (localhost)`,
      ]);
    });

    it.each(["tcp", "TCP", "Tcp"])(
      "takes a port Compose prints with protocol %s",
      (protocol) => {
        const config = broken("postgres", (service) => {
          service.ports = [
            {
              host_ip: "127.0.0.1",
              target: 5432,
              published: "5442",
              protocol,
            },
          ];
        });

        expect(check(config)).toEqual([]);
      },
    );

    it.each([null, "sctp", 6])(
      "refuses a port whose protocol is %j, not TCP",
      (protocol) => {
        const config = broken("postgres", (service) => {
          service.ports = [
            {
              host_ip: "127.0.0.1",
              target: 5432,
              published: "5442",
              protocol,
            },
          ];
        });

        expect(check(config)).toEqual([
          "postgres: publishes no port 5442 on 127.0.0.1 - DATABASE_URL of .env.test points there (localhost)",
        ]);
      },
    );

    it("refuses an address without a port", () => {
      const text = CLEAN_TEST_ENV.replace("localhost:6389", "localhost");

      expect(check(cleanConfig(), { [TEST_ENV_FILE]: text })).toEqual([
        `${TEST_ENV_FILE}: REDIS_URL names no port - write it out, the port redis publishes cannot be checked against a default`,
      ]);
    });

    it("tells a missing key from a value that is not a URL", () => {
      const missing = CLEAN_TEST_ENV.replace(/^REDIS_URL=.*$/m, "");
      const garbled = CLEAN_TEST_ENV.replace(
        /^DATABASE_URL=.*$/m,
        "DATABASE_URL=not a url",
      );

      expect(check(cleanConfig(), { [TEST_ENV_FILE]: missing })).toEqual([
        `${TEST_ENV_FILE}: no REDIS_URL - the port redis publishes cannot be checked`,
      ]);
      expect(check(cleanConfig(), { [TEST_ENV_FILE]: garbled })).toEqual([
        `${TEST_ENV_FILE}: DATABASE_URL is not a URL - the port postgres publishes cannot be checked`,
      ]);
    });

    it.each([
      ["127.0.0.1", "::1", "127.0.0.1", "127.0.0.1"],
      ["localhost", "::1", "127.0.0.1", "localhost"],
      ["[::1]", "127.0.0.1", "::1", "::1"],
    ])(
      "refuses a URL on %s with the port published on %s",
      (host, published, bind, named) => {
        const text = CLEAN_TEST_ENV.replace("localhost:5442", `${host}:5442`);
        const config = broken("postgres", (service) => {
          service.ports = [
            { host_ip: published, target: 5432, published: "5442" },
          ];
        });

        expect(check(config, { [TEST_ENV_FILE]: text })).toEqual([
          `postgres: publishes no port 5442 on ${bind} - DATABASE_URL of .env.test points there (${named})`,
        ]);
      },
    );

    it("accepts [::1] with the port published on ::1", () => {
      const text = CLEAN_TEST_ENV.replaceAll("localhost", "[::1]");
      const config = cleanConfig();
      for (const name of ["postgres", "redis"]) {
        const service = config.services[name];
        if (service === undefined) throw new Error(`no ${name} in the fixture`);
        service.ports = [
          {
            host_ip: "::1",
            target: name === "postgres" ? 5432 : 6379,
            published: name === "postgres" ? "5442" : "6389",
          },
        ];
      }

      expect(check(config, { [TEST_ENV_FILE]: text })).toEqual([]);
    });

    it.each([
      ["postgres", 6379, "5442", "5432", "DATABASE_URL"],
      ["redis", 5432, "6389", "6379", "REDIS_URL"],
    ])(
      "refuses %s publishing the port of .env.test to %s",
      (name, target, published, listens, key) => {
        const config = broken(name, (service) => {
          service.ports = [{ host_ip: "127.0.0.1", target, published }];
        });

        expect(check(config)).toEqual([
          `${name}: publishes port ${published} on 127.0.0.1 to ${target}, not to ${listens} it listens on - ${key} of .env.test would reach nothing`,
        ]);
      },
    );

    it.each([
      ["DATABASE_URL", "localhost:5442", "db.example.com:5442"],
      ["REDIS_URL", "localhost:6389", "10.0.0.5:6389"],
    ])("refuses a %s beyond loopback", (key, local, remote) => {
      const text = CLEAN_TEST_ENV.replace(local, remote);
      const host = remote.split(":")[0];

      expect(check(cleanConfig(), { [TEST_ENV_FILE]: text })).toEqual([
        `${TEST_ENV_FILE}: ${key} points at ${host}, not at localhost, 127.0.0.1 or [::1] - the test stack is the one Compose publishes on loopback`,
      ]);
    });

    it("accepts 127.0.0.1 for localhost", () => {
      const text = CLEAN_TEST_ENV.replaceAll("localhost", "127.0.0.1");

      expect(check(cleanConfig(), { [TEST_ENV_FILE]: text })).toEqual([]);
    });

    // The grammar of `parseEnv` (node:util), the one @sf/config and the
    // stack guard read the file with: what it reads, the gate reads.
    it.each([
      [
        "quoted values",
        [
          'DATABASE_URL="postgresql://sf:sf@localhost:5442/shorts_factory_test"',
          "REDIS_URL='redis://localhost:6389/1'",
        ],
      ],
      [
        "an export in front",
        [
          "export DATABASE_URL=postgresql://sf:sf@localhost:5442/shorts_factory_test",
          "export REDIS_URL=redis://localhost:6389/1",
        ],
      ],
      [
        "a comment after the value",
        [
          "DATABASE_URL=postgresql://sf:sf@localhost:5442/shorts_factory_test # test db",
          "REDIS_URL=redis://localhost:6389/1 # test redis",
        ],
      ],
    ])("reads .env.test with %s", (_case, lines) => {
      const text = `${lines.join("\n")}\n`;

      expect(check(cleanConfig(), { [TEST_ENV_FILE]: text })).toEqual([]);
    });
  });

  /**
   * One corruption per rule of the table, each turning exactly that rule
   * red: a rule added without a case here, or one that stopped firing,
   * fails this block.
   */
  describe("13. migrate stops on SIGTERM", () => {
    it.each([
      ["without init", undefined],
      ["with init: false", false],
      ['with init: "true", a string', "true"],
    ])("refuses migrate %s", (_label, init) => {
      const config = broken("migrate", (service) => {
        service.init = init;
      });

      expect(check(config)).toEqual([
        "migrate: init is not true - node as PID 1 ignores SIGTERM, and docker compose stop would end it with SIGKILL",
      ]);
    });

    it("asks it of migrate alone", () => {
      const config = broken("api", (service) => {
        service.init = undefined;
      });

      expect(check(config)).toEqual([]);
    });
  });

  /** What rule 14 says of an override at `path` in `dir`. */
  function overrideAt(dir: string, name: string): string {
    return `${join(dir, name)}: Compose merges it into the stack when run without -f from ${dir}, and the gate renders with -f - an override is not supported, change the Compose files of the stack instead`;
  }

  describe("14. no override", () => {
    const INFRA = join(CONTEXT, "infra");

    it.each(
      OVERRIDE_FILES.flatMap((name) => [
        [name, CONTEXT],
        [name, INFRA],
      ]),
    )("refuses %s in %s", (name, dir) => {
      expect(
        check(cleanConfig(), { [join(dir, name)]: "services: {}\n" }),
      ).toEqual([overrideAt(dir, name)]);
    });

    it.each([
      ...["compose.yml", "docker-compose.yml", "docker-compose.yaml"].map(
        (name) => [name, CONTEXT],
      ),
      ...["compose.yaml", "compose.yml", "docker-compose.yaml"].map((name) => [
        name,
        INFRA,
      ]),
    ])(
      "refuses %s in %s, a Compose file of a default name off the graph",
      (name, dir) => {
        const path = join(dir, name);

        expect(check(cleanConfig(), { [path]: "services: {}\n" })).toEqual([
          `${path}: Compose looks for it when run without -f from ${dir} (compose.yaml, compose.yml, docker-compose.yml, docker-compose.yaml - the first it finds is the stack), and it is not a file of the graph the gate renders - keep one Compose file of the stack in a directory`,
        ]);
      },
    );

    it("takes the files of the graph of a default name for its own", () => {
      expect(DEFAULT_FILES).toEqual([
        "compose.yaml",
        "compose.yml",
        "docker-compose.yml",
        "docker-compose.yaml",
      ]);
      expect(check(cleanConfig())).toEqual([]);
    });

    it("refuses a .env next to a file of the graph outside the root, without reading it", () => {
      const envFile = join(INFRA, ".env");
      const present = filesWith({ [envFile]: "WEB_PORT=0.0.0.0:5432\n" });
      const read = vi.fn(reader(present));

      const problems = checkCompose(
        cleanConfig(),
        projectWith(read, realpathIn(present)),
      );

      expect(problems).toEqual([
        `${envFile}: Compose reads it for the interpolation of the Compose files of ${INFRA} over --env-file, and the gate does not read .env - keep the variables in the root .env`,
      ]);
      expect(read.mock.calls.map(([path]) => path)).not.toContain(envFile);
      expect(problems.join("\n")).not.toContain("5432");
    });

    it("takes the .env of the root for the operator's", () => {
      expect(
        check(cleanConfig(), { [join(CONTEXT, ".env")]: "WEB_PORT=8080\n" }),
      ).toEqual([]);
    });

    it("throws a failure of the realpath other than a path that is not there", () => {
      const denied = Object.assign(new Error("EACCES: realpath"), {
        code: "EACCES",
      });
      const present = cleanFiles();
      const realpath = (path: string): string => {
        if (path === join(CONTEXT, OVERRIDE_FILES[0] ?? "")) throw denied;
        return realpathIn(present)(path);
      };

      expect(() =>
        checkCompose(cleanConfig(), projectWith(reader(present), realpath)),
      ).toThrow(denied);
    });
  });

  describe("15. compose sources", () => {
    const OUTSIDE = `not one of the Compose files the gate is chosen on (${COMPOSE_SOURCES.join(", ")}), so a change to it would not run the gate`;
    const APP = join(CONTEXT, "infra", "docker-compose.app.yml");

    it("refuses an include of a file outside COMPOSE_SOURCES", () => {
      const extra = join(CONTEXT, "deploy", "extra.yml");

      expect(
        check(cleanConfig(), {
          [COMPOSE_FILE]: `${CLEAN_ROOT_COMPOSE}  - deploy/extra.yml\n`,
          [extra]: "services: {}\n",
        }),
      ).toEqual([`${COMPOSE_FILE}: include[2] names ${extra} - ${OUTSIDE}`]);
    });

    it("refuses an extends of a file outside COMPOSE_SOURCES", () => {
      const base = join(CONTEXT, "deploy", "base.yml");

      expect(
        check(cleanConfig(), {
          [APP]:
            "services:\n  api:\n    extends:\n      file: ../deploy/base.yml\n      service: api\n",
          [base]: "services:\n  api:\n    image: x\n",
        }),
      ).toEqual([
        `${APP}: services.api.extends.file names ${base} - ${OUTSIDE}`,
      ]);
    });

    it("refuses a file of COMPOSE_SOURCES that is a link to a file outside", () => {
      const target = join(CONTEXT, "deploy", "evil.yml");

      expect(
        check(cleanConfig(), { [target]: "services: {}\n" }, { [APP]: target }),
      ).toEqual([
        `${COMPOSE_FILE}: include[1] names ${APP}, a link to ${target} - ${OUTSIDE}`,
      ]);
    });

    it("refuses a link outside COMPOSE_SOURCES to a file of them", () => {
      const alias = join(CONTEXT, "deploy", "app.yml");

      expect(
        check(
          cleanConfig(),
          {
            [COMPOSE_FILE]:
              "include:\n  - infra/docker-compose.yml\n  - deploy/app.yml\n",
          },
          { [alias]: APP },
        ),
      ).toEqual([`${COMPOSE_FILE}: include[1] names ${alias} - ${OUTSIDE}`]);
    });

    it("refuses a root file that is not one of COMPOSE_SOURCES", () => {
      const other = join(CONTEXT, "compose.yml");
      const present = { ...cleanFiles(), [other]: CLEAN_ROOT_COMPOSE };

      expect(
        checkCompose(cleanConfig(), {
          ...projectWith(reader(present), realpathIn(present)),
          composeFile: other,
        }),
      ).toEqual([
        // compose.yaml is a file of a default name next to it, off its graph.
        `${COMPOSE_FILE}: Compose looks for it when run without -f from ${CONTEXT} (compose.yaml, compose.yml, docker-compose.yml, docker-compose.yaml - the first it finds is the stack), and it is not a file of the graph the gate renders - keep one Compose file of the stack in a directory`,
        `${other}: the root file is ${OUTSIDE}`,
      ]);
    });

    it("gives the problems of the reader as its own", () => {
      expect(
        check(cleanConfig(), {
          [COMPOSE_FILE]: "include: infra/docker-compose.yml\n",
        }),
      ).toEqual([`${COMPOSE_FILE}: include is not a list`]);
    });

    it("reads the graph once for rules 14 and 15", () => {
      const present = cleanFiles();
      const read = vi.fn(reader(present));

      checkCompose(cleanConfig(), projectWith(read, realpathIn(present)));

      expect(
        read.mock.calls.filter(([path]) => path === COMPOSE_FILE),
      ).toHaveLength(1);
    });

    it("reads the graph again on every call, for the same project", () => {
      const extra = join(CONTEXT, "deploy", "extra.yml");
      const files: Record<string, string> = { ...cleanFiles(), [extra]: "" };
      const project = projectWith(
        (path) => files[path] ?? null,
        realpathIn(files),
      );

      expect(checkCompose(cleanConfig(), project)).toEqual([]);
      files[COMPOSE_FILE] = `${CLEAN_ROOT_COMPOSE}  - deploy/extra.yml\n`;

      expect(checkCompose(cleanConfig(), project)).toEqual([
        `${COMPOSE_FILE}: include[2] names ${extra} - ${OUTSIDE}`,
      ]);
    });

    it("opens no Compose file for a choice of rules without 14 and 15", () => {
      // Rule 11 alone, as test/container.test.ts runs it: a Compose file that
      // cannot be read answers by the rule, not by a failure of the graph (C8).
      const files = cleanFiles();
      const read = vi.fn((path: string): string | null => {
        if (path === COMPOSE_FILE) throw new Error("the graph was read");
        return files[path] ?? null;
      });
      const realpath = vi.fn(realpathIn(files));

      expect(
        checkCompose(cleanConfig(), projectWith(read, realpath), [
          "build-ignores",
        ]),
      ).toEqual([]);
      expect(read.mock.calls.map(([path]) => path)).not.toContain(COMPOSE_FILE);
      expect(realpath).toHaveBeenCalledTimes(0);
    });

    it.each([
      ["win32", []],
      [
        "linux",
        [
          // Off the graph there, infra/docker-compose.yml is one more file of
          // a default name next to it.
          `${join(CONTEXT, "infra", "docker-compose.yml")}: Compose looks for it when run without -f from ${join(CONTEXT, "infra")} (compose.yaml, compose.yml, docker-compose.yml, docker-compose.yaml - the first it finds is the stack), and it is not a file of the graph the gate renders - keep one Compose file of the stack in a directory`,
          `${COMPOSE_FILE}: include[0] names ${join(CONTEXT, "Infra", "docker-compose.yml")} - not one of the Compose files the gate is chosen on (${COMPOSE_SOURCES.join(", ")}), so a change to it would not run the gate`,
        ],
      ],
    ])(
      "compares a path written in another case the way %s opens it",
      (platform, problems) => {
        // Windows opens Infra\docker-compose.yml as infra\docker-compose.yml,
        // Linux as another file (C10).
        const written = join(CONTEXT, "Infra", "docker-compose.yml");
        const present = filesWith({
          [COMPOSE_FILE]: CLEAN_ROOT_COMPOSE.replace(
            "  - infra/docker-compose.yml",
            "  - Infra/docker-compose.yml",
          ),
        });
        const links = {
          [written]: join(CONTEXT, "infra", "docker-compose.yml"),
        };

        expect(
          checkCompose(cleanConfig(), {
            ...projectWith(reader(present), realpathIn(present, links)),
            platform,
          }),
        ).toEqual(problems);
      },
    );

    it.each([
      ["win32", 0],
      ["linux", 2],
    ])(
      "takes a file of the graph whose name on disk is in another case for its own on %s",
      (platform, count) => {
        // The disk has infra\Docker-Compose.yml; the realpath gives its case.
        const onDisk = join(CONTEXT, "infra", "Docker-Compose.yml");
        const present = filesWith({
          [join(CONTEXT, "infra", "docker-compose.yml")]: null,
          [onDisk]: CLEAN_INFRA_COMPOSE,
        });
        const links = {
          [join(CONTEXT, "infra", "docker-compose.yml")]: onDisk,
        };

        expect(
          checkCompose(cleanConfig(), {
            ...projectWith(reader(present), realpathIn(present, links)),
            platform,
          }),
        ).toHaveLength(count);
      },
    );

    it("does not open a file it names outside COMPOSE_SOURCES", () => {
      const extra = join(CONTEXT, "deploy", "extra.yml");
      const present = filesWith({
        [COMPOSE_FILE]: `${CLEAN_ROOT_COMPOSE}  - deploy/extra.yml\n`,
        [extra]: "services: {}\n",
      });
      const read = vi.fn(reader(present));

      expect(
        checkCompose(cleanConfig(), projectWith(read, realpathIn(present))),
      ).toEqual([`${COMPOSE_FILE}: include[2] names ${extra} - ${OUTSIDE}`]);
      expect(read.mock.calls.map(([path]) => path)).not.toContain(extra);
    });

    it.each(["win32", "linux"])(
      "opens on %s exactly the files of the graph it does not refuse",
      (platform) => {
        // The reader and rule 15 take one test of a Compose file (D2): a file
        // is either read or named outside, never both, never neither.
        const infra = join(CONTEXT, "infra", "docker-compose.yml");
        const written = join(CONTEXT, "Infra", "docker-compose.yml");
        const extra = join(CONTEXT, "deploy", "extra.yml");
        const present = filesWith({
          [COMPOSE_FILE]: `${CLEAN_ROOT_COMPOSE.replace(
            "  - infra/docker-compose.yml",
            "  - Infra/docker-compose.yml",
          )}  - deploy/extra.yml\n`,
          [extra]: "services: {}\n",
        });
        const read = vi.fn(reader(present));

        const problems = checkCompose(cleanConfig(), {
          ...projectWith(read, realpathIn(present, { [written]: infra })),
          platform,
        });

        const opened = read.mock.calls.map(([path]) => path);
        for (const [path, target] of [
          [written, infra],
          [extra, extra],
        ] as const) {
          const refused = problems.some((problem) =>
            problem.includes(`names ${path} - ${OUTSIDE}`),
          );
          expect({ path, refused, opened: opened.includes(target) }).toEqual({
            path,
            refused,
            opened: !refused,
          });
        }
      },
    );
  });

  describe("16. no profiles", () => {
    it("refuses a service with a profile", () => {
      const config = broken("redis", (service) => {
        service.profiles = ["debug", "x"];
      });

      expect(check(config)).toEqual([
        "redis: has profiles (debug, x) - the stack would change with the profile the operator turns on; the stack has none",
      ]);
    });
  });

  describe("17. values from the files of the graph alone", () => {
    const APP = join(CONTEXT, "infra", "docker-compose.app.yml");
    const INFRA = join(CONTEXT, "infra", "docker-compose.yml");
    const OUTSIDE_ENV =
      "Compose takes its value from .env or the shell, past the env file of the gate";
    /** The clean app Compose file with `lines` under its service api. */
    function appWith(lines: string): Record<string, string> {
      return { [APP]: `${CLEAN_APP_COMPOSE}${lines}` };
    }

    it("refuses a key of a list environment without a value", () => {
      const lines = [
        "    environment:",
        "      - NODE_ENV=production",
        "      - REDIS_URL",
        "      - EMPTY=",
        "",
      ].join("\n");

      expect(check(cleanConfig(), appWith(lines))).toEqual([
        `${APP}: services.api.environment[1] (REDIS_URL) has no value - ${OUTSIDE_ENV}`,
      ]);
    });

    it("refuses a key of a mapping environment that is null", () => {
      const lines = [
        "    environment:",
        "      NODE_ENV: production",
        "      REDIS_URL:",
        '      EMPTY: ""',
        "",
      ].join("\n");

      expect(check(cleanConfig(), appWith(lines))).toEqual([
        `${APP}: services.api.environment.REDIS_URL has no value - ${OUTSIDE_ENV}`,
      ]);
    });

    it("refuses a key without a value that a merge key brings into another file of the graph", () => {
      const text = [
        "x-env: &env",
        "  PGPASSWORD:",
        "services:",
        "  postgres:",
        "    image: postgres",
        "    environment:",
        "      <<: *env",
        "",
      ].join("\n");

      expect(check(cleanConfig(), { [INFRA]: text })).toEqual([
        `${INFRA}: services.postgres.environment.PGPASSWORD has no value - ${OUTSIDE_ENV}`,
      ]);
    });

    it("refuses a key of a list build.args without a value", () => {
      const lines = [
        "      args:",
        "        - APP_VERSION=1",
        "        - NPM_TOKEN",
        "",
      ].join("\n");

      expect(check(cleanConfig(), appWith(lines))).toEqual([
        `${APP}: services.api.build.args[1] (NPM_TOKEN) has no value - ${OUTSIDE_ENV}`,
      ]);
    });

    it("refuses a key of a mapping build.args that is null", () => {
      const lines = [
        "      args:",
        "        APP_VERSION: 1",
        "        NPM_TOKEN:",
        "",
      ].join("\n");

      expect(check(cleanConfig(), appWith(lines))).toEqual([
        `${APP}: services.api.build.args.NPM_TOKEN has no value - ${OUTSIDE_ENV}`,
      ]);
    });

    it("lets a build.args value with an empty default through", () => {
      const lines = [
        "      args:",
        "        APP_VERSION: ${APP_VERSION:-}",
        "        GIT_COMMIT: ${GIT_COMMIT:-}",
        "",
      ].join("\n");

      expect(check(cleanConfig(), appWith(lines))).toEqual([]);
    });

    it.each(
      ["configs", "secrets"].flatMap((key) =>
        [
          "file: ./app.conf",
          "environment: APP_CONF",
          "content: x",
          "external: true",
        ].map((form) => [key, form] as const),
      ),
    )("refuses top-level %s with %s", (key, form) => {
      const text = `${CLEAN_APP_COMPOSE}${key}:\n  app:\n    ${form}\n`;

      expect(check(cleanConfig(), { [APP]: text })).toEqual([
        `${APP}: ${key} - its values come from outside the files of the graph (a file, the environment, an external one), and the stack has none`,
      ]);
    });

    it("refuses a label_file of a service", () => {
      expect(
        check(cleanConfig(), appWith("    label_file: ./labels.env\n")),
      ).toEqual([
        `${APP}: services.api.label_file - Compose reads labels from a file outside the graph, and the stack has none`,
      ]);
    });
  });

  describe("each rule turns red on its own corruption", () => {
    const CORRUPTIONS: Record<
      string,
      {
        config: () => unknown;
        files?: Record<string, string | null>;
        expected: string;
      }
    > = {
      services: {
        config: () => without("redis"),
        expected: "redis: service is missing",
      },
      ports: {
        config: () =>
          broken("api", (service) => {
            service.ports = [{ host_ip: "127.0.0.1", target: 3001 }];
          }),
        expected: "api: publishes ports, it must stay inside the network",
      },
      production: {
        config: () =>
          broken("worker", (service) => {
            environmentOf(service).NODE_ENV = "development";
          }),
        expected: 'worker: environment.NODE_ENV is not "production"',
      },
      grace: {
        config: () =>
          broken("worker", (service) => {
            service.stop_grace_period = "10s";
          }),
        expected: "worker: stop_grace_period 10s is below 30s",
      },
      healthchecks: {
        config: () =>
          broken("worker", (service) => {
            service.healthcheck = undefined;
          }),
        expected: "worker: has no healthcheck",
      },
      "start-order": {
        config: () =>
          broken("web", (service) => {
            service.depends_on = {
              migrate: { condition: "service_completed_successfully" },
            };
          }),
        expected:
          "web: does not wait for a healthy api (condition service_healthy)",
      },
      media: {
        config: () =>
          broken("worker", (service) => {
            service.volumes = volumesOf(service).filter(
              (volume) => volume.source !== "media",
            );
          }),
        expected:
          "worker: volume media is not mounted at its MEDIA_DIR (/data/media)",
      },
      "api-port": {
        config: () =>
          broken("web", (service) => {
            environmentOf(service).API_INTERNAL_URL = "http://localhost:3001";
          }),
        expected:
          "web: API_INTERNAL_URL http://localhost:3001 is not http://api:3001",
      },
      "postgres-tcp": {
        config: () =>
          broken("postgres", (service) => {
            healthcheckOf(service).test = ["CMD", "true"];
          }),
        expected:
          "postgres: healthcheck is not pg_isready over TCP to its own loopback on port 5432 (-h 127.0.0.1|localhost|::1, -p 5432 or none) - the local socket answers during init",
      },
      restart: {
        config: () =>
          broken("redis", (service) => {
            service.restart = undefined;
          }),
        expected:
          'redis: restart is not "unless-stopped" - it would stay down after a reboot',
      },
      "env-mount": {
        config: () =>
          broken("web", (service) => {
            envMountOf(service).read_only = undefined;
          }),
        expected: "web: .env at /repo/.env is not read_only",
      },
      "build-ignores": {
        config: () =>
          broken("api", (service) => {
            service.build = { ...buildOf("api"), dockerfile_inline: "FROM x" };
          }),
        expected:
          "api: build.dockerfile_inline - the .env masks are checked for build.context only, and the stack has no dockerfile_inline",
      },
      "test-stack-ports": {
        config: () => cleanConfig(),
        files: {
          [TEST_ENV_FILE]: CLEAN_TEST_ENV.replace(":6389/", ":6390/"),
        },
        expected:
          "redis: publishes no port 6390 on 127.0.0.1 - REDIS_URL of .env.test points there (localhost)",
      },
      init: {
        config: () =>
          broken("migrate", (service) => {
            service.init = undefined;
          }),
        expected:
          "migrate: init is not true - node as PID 1 ignores SIGTERM, and docker compose stop would end it with SIGKILL",
      },
      "no-override": {
        config: () => cleanConfig(),
        files: { [join(CONTEXT, "compose.override.yaml")]: "services: {}\n" },
        expected: overrideAt(CONTEXT, "compose.override.yaml"),
      },
      "compose-sources": {
        config: () => cleanConfig(),
        files: {
          [COMPOSE_FILE]: `${CLEAN_ROOT_COMPOSE}  - deploy/extra.yml\n`,
          [join(CONTEXT, "deploy", "extra.yml")]: "services: {}\n",
        },
        expected: `${COMPOSE_FILE}: include[2] names ${join(CONTEXT, "deploy", "extra.yml")} - not one of the Compose files the gate is chosen on (compose.yaml, infra/docker-compose.yml, infra/docker-compose.app.yml), so a change to it would not run the gate`,
      },
      profiles: {
        config: () =>
          broken("api", (service) => {
            service.profiles = ["debug"];
          }),
        expected:
          "api: has profiles (debug) - the stack would change with the profile the operator turns on; the stack has none",
      },
      "graph-values": {
        config: () => cleanConfig(),
        files: {
          [join(CONTEXT, "infra", "docker-compose.app.yml")]:
            `${CLEAN_APP_COMPOSE}    environment: [REDIS_URL]\n`,
        },
        expected: `${join(CONTEXT, "infra", "docker-compose.app.yml")}: services.api.environment[0] (REDIS_URL) has no value - Compose takes its value from .env or the shell, past the env file of the gate`,
      },
    };

    it("has a corruption for every rule, in the order of the table", () => {
      expect(Object.keys(CORRUPTIONS)).toEqual(RULE_IDS);
    });

    it.each(RULE_IDS)("turns %s red and nothing else", (id) => {
      const corruption = CORRUPTIONS[id];
      if (corruption === undefined) throw new Error(`no corruption for ${id}`);

      expect(check(corruption.config(), corruption.files)).toEqual([
        corruption.expected,
      ]);
    });
  });
});

/**
 * A configuration the rules cannot read is refused with the path of the
 * field, not with a `TypeError` of whichever rule reads it first.
 */
describe("the shape of the configuration", () => {
  const SHAPE = "unexpected shape of docker compose config:";

  it.each([
    ["the top level", () => [], "(top level)"],
    ["services", () => ({ services: [] }), "services"],
    ["a service", () => ({ services: { api: "x" } }), "services.api"],
    [
      "ports",
      () =>
        broken("api", (service) => {
          service.ports = {};
        }),
      "services.api.ports",
    ],
    [
      "a port",
      () =>
        broken("postgres", (service) => {
          service.ports = ["127.0.0.1:5442:5432"];
        }),
      "services.postgres.ports[0]",
    ],
    [
      "volumes",
      () =>
        broken("worker", (service) => {
          service.volumes = "media:/data/media";
        }),
      "services.worker.volumes",
    ],
    [
      "the bind of a mount",
      () =>
        broken("web", (service) => {
          envMountOf(service).bind = "create_host_path=false";
        }),
      "services.web.volumes[0].bind",
    ],
    [
      "environment",
      () =>
        broken("api", (service) => {
          service.environment = ["NODE_ENV=production"];
        }),
      "services.api.environment",
    ],
    [
      "depends_on",
      () =>
        broken("api", (service) => {
          service.depends_on = ["migrate"];
        }),
      "services.api.depends_on",
    ],
    [
      "an entry of depends_on",
      () =>
        broken("api", (service) => {
          service.depends_on = { migrate: "service_completed_successfully" };
        }),
      "services.api.depends_on.migrate",
    ],
    [
      "healthcheck",
      () =>
        broken("redis", (service) => {
          service.healthcheck = "redis-cli ping";
        }),
      "services.redis.healthcheck",
    ],
    [
      "build",
      () =>
        broken("api", (service) => {
          service.build = ".";
        }),
      "services.api.build",
    ],
    [
      "profiles",
      () =>
        broken("api", (service) => {
          service.profiles = "debug";
        }),
      "services.api.profiles",
    ],
    [
      "a profile",
      () =>
        broken("api", (service) => {
          service.profiles = [1];
        }),
      "services.api.profiles",
    ],
  ])("refuses %s in another shape", (_case, config, path) => {
    const value = config();

    expect(check(value)).toEqual([`${SHAPE} ${path}`]);
    expect(buildIgnores(value, reader(cleanFiles()))).toEqual([
      `${SHAPE} ${path}`,
    ]);
    expect(checkRendering(value)).toEqual([`${SHAPE} ${path}`]);
  });
});

/**
 * The probe the gate renders before the stack (rule 10): the option it sets
 * must come back from `docker compose config`, or rule 10 reads nothing.
 */
describe("checkRendering", () => {
  /** What a Compose printed for the probe's mount, with `bind` as given. */
  function rendered(bind: unknown): { services: Record<string, Service> } {
    return {
      services: {
        probe: {
          volumes: [
            {
              type: "bind",
              source: `/tmp/${RENDERING_PROBE_SOURCE}`,
              target: "/probe.env",
              ...(bind === undefined ? {} : { bind }),
            },
          ],
        },
      },
    };
  }

  it("sets create_host_path: false on a bind mount of the probe's source", () => {
    expect(RENDERING_PROBE).toContain(`source: ./${RENDERING_PROBE_SOURCE}`);
    expect(RENDERING_PROBE).toMatch(
      /\n {8}bind:\n {10}create_host_path: false\n/,
    );
  });

  it("passes the rendering of Docker Compose v5, which keeps the option", () => {
    expect(checkRendering(rendered({ create_host_path: false }))).toEqual([]);
  });

  const HAS_NO_OPTION = "bind has no create_host_path: false";
  it.each([
    ["empty bind options (Docker Compose v2.38)", {}, HAS_NO_OPTION],
    ["no bind options", undefined, "no bind"],
    ["the option reversed", { create_host_path: true }, HAS_NO_OPTION],
  ])("stops on a rendering with %s", (_case, bind, lost) => {
    expect(checkRendering(rendered(bind))).toEqual([
      `this docker compose prints the probe's mount with ${lost} - rule 10 cannot tell the option from its absence; run the Compose CI pins (.github/workflows/ci.yml)`,
    ]);
  });

  it("prints nothing of what Compose put in the place of the option", () => {
    // Т7 E0-12G: the gate repeats nothing docker printed.
    const problems = checkRendering(
      rendered({ create_host_path: "sk-printed-by-docker", other: 1 }),
    );

    expect(problems).toHaveLength(1);
    expect(problems.join("\n")).not.toContain("sk-printed-by-docker");
    expect(problems.join("\n")).not.toContain("other");
  });

  it("stops on a rendering without the probe", () => {
    expect(checkRendering({ services: {} })).toHaveLength(1);
    expect(checkRendering({})).toHaveLength(1);
  });
});

/**
 * Rule 11: the `.dockerignore` of every build context masks every `.env`,
 * nothing after the masks lets one back in, and no `<Dockerfile>.dockerignore`
 * replaces it.
 */
describe("checkDockerignore", () => {
  const MASKS = [".env", ".env.*", "**/.env", "**/.env.*"];
  const FILE = "/srv/shorts-factory/.dockerignore";

  function ignore(...lines: string[]): string {
    return `# comment\n${lines.join("\r\n")}\n`;
  }

  it("passes the masks, with negations before them", () => {
    expect(checkDockerignore(ignore("!keep", ...MASKS, "docs"), FILE)).toEqual(
      [],
    );
  });

  it("reads a leading slash the way Docker does", () => {
    expect(
      checkDockerignore(ignore(...MASKS.map((mask) => `/${mask}`)), FILE),
    ).toEqual([]);
  });

  it.each(MASKS)("refuses a file without %s", (mask) => {
    const lines = MASKS.filter((line) => line !== mask);

    expect(checkDockerignore(ignore(...lines), FILE)).toEqual([
      `${FILE}: lacks ${mask} - that .env file would enter the image`,
    ]);
  });

  it.each(["!**", "!*.production", "!**/*.local", "!apps/**", "!.env.example"])(
    "refuses %s after the masks",
    (negation) => {
      expect(
        checkDockerignore(ignore(...MASKS, "docs", negation), FILE),
      ).toEqual([
        `${FILE}: ${negation} follows the .env masks - the last matching line wins, and it may let a .env back in`,
      ]);
    },
  );

  it.each([[["**/.env*"]], [[".env*", "**/.env", "**/.env.*"]]])(
    "passes the masks written as %j",
    (lines) => {
      expect(checkDockerignore(ignore(...lines), FILE)).toEqual([]);
    },
  );

  it("counts .env* at the root for the two root masks only", () => {
    expect(checkDockerignore(ignore(".env*"), FILE)).toEqual([
      `${FILE}: lacks **/.env - that .env file would enter the image`,
      `${FILE}: lacks **/.env.* - that .env file would enter the image`,
    ]);
  });

  it("counts a spelling outside its list for nothing", () => {
    expect(checkDockerignore(ignore("*.env", "**/*.env*"), FILE)).toEqual(
      MASKS.map(
        (mask) =>
          `${FILE}: lacks ${mask} - that .env file would enter the image`,
      ),
    );
  });

  it("refuses a negation after a mask in another spelling", () => {
    expect(checkDockerignore(ignore("**/.env*", "!keep"), FILE)).toEqual([
      `${FILE}: !keep follows the .env masks - the last matching line wins, and it may let a .env back in`,
    ]);
  });

  it("refuses a negation between the masks", () => {
    expect(
      checkDockerignore(ignore(".env", "!**", ...MASKS.slice(1)), FILE),
    ).toEqual([
      `${FILE}: !** follows the .env masks - the last matching line wins, and it may let a .env back in`,
    ]);
  });
});

describe("rule 11 alone (checkCompose, build-ignores)", () => {
  const ROOT_IGNORE = join(CONTEXT, ".dockerignore");

  /** Every service of the stack, from an image; `names` built. */
  function built(...names: string[]): { services: Record<string, Service> } {
    const services: Record<string, Service> = Object.fromEntries(
      Object.keys(cleanConfig().services).map((name) => [
        name,
        { image: `${name}:test` },
      ]),
    );
    for (const name of names) {
      services[name] = {
        build: {
          context: CONTEXT,
          dockerfile: "infra/docker/app.Dockerfile",
          target: name,
        },
      };
    }
    return { services };
  }

  it("runs that rule only, and refuses an id the table does not have", () => {
    const read = reader({ [ROOT_IGNORE]: CLEAN_IGNORE });

    expect(check(built("api"))).not.toEqual([]);
    expect(buildIgnores(built("api"), read)).toEqual([]);
    expect(() =>
      checkCompose(built("api"), projectWith(read), ["build-ignore"]),
    ).toThrow("checkCompose: no rule build-ignore");
  });

  it("reports a service the stack lost, whichever rules are chosen", () => {
    // Rule 11 passes over a service that is not there: without rule 0 a
    // part of the stack that lost an image would answer clean.
    const { services } = built("api", "worker");
    const { worker: _lost, ...rest } = services;
    const read = reader({ [ROOT_IGNORE]: CLEAN_IGNORE });

    expect(buildIgnores({ services: rest }, read)).toEqual([
      "worker: service is missing",
    ]);
  });

  it("refuses an empty choice of rules, which would check nothing", () => {
    expect(() =>
      checkCompose(built("api"), projectWith(reader({})), []),
    ).toThrow("checkCompose: no rule chosen");
  });

  it("passes a context whose .dockerignore masks every .env", () => {
    expect(
      buildIgnores(
        built("api", "worker"),
        reader({ [ROOT_IGNORE]: CLEAN_IGNORE }),
      ),
    ).toEqual([]);
  });

  it("reports a shared .dockerignore once", () => {
    expect(
      buildIgnores(
        built("api", "worker", "web"),
        reader({ [ROOT_IGNORE]: `${CLEAN_IGNORE}!**\n` }),
      ),
    ).toEqual([
      `${ROOT_IGNORE}: !** follows the .env masks - the last matching line wins, and it may let a .env back in`,
    ]);
  });

  it("refuses a context without a .dockerignore", () => {
    expect(buildIgnores(built("api"), reader({}))).toEqual([
      `api: no ${ROOT_IGNORE} - every .env would enter the image`,
    ]);
  });

  it("refuses a Dockerfile with its own .dockerignore once, naming every service built from it", () => {
    // The stack as it is: all four images are targets of one Dockerfile.
    const own = join(CONTEXT, "infra/docker/app.Dockerfile.dockerignore");

    expect(
      buildIgnores(
        cleanConfig(),
        reader({ [ROOT_IGNORE]: CLEAN_IGNORE, [own]: CLEAN_IGNORE }),
      ),
    ).toEqual([
      `migrate, api, worker, web: ${own} exists - BuildKit reads it instead of ${ROOT_IGNORE}, and the .env masks are not checked there`,
    ]);
  });

  it("reports the own .dockerignore of each Dockerfile on its own", () => {
    const config = cleanConfig();
    config.services.web = {
      build: { context: CONTEXT, dockerfile: "infra/docker/web.Dockerfile" },
    };
    const own = (file: string) =>
      join(CONTEXT, `infra/docker/${file}.dockerignore`);

    expect(
      buildIgnores(
        config,
        reader({
          [ROOT_IGNORE]: CLEAN_IGNORE,
          [own("app.Dockerfile")]: CLEAN_IGNORE,
          [own("web.Dockerfile")]: CLEAN_IGNORE,
        }),
      ),
    ).toEqual([
      `migrate, api, worker: ${own("app.Dockerfile")} exists - BuildKit reads it instead of ${ROOT_IGNORE}, and the .env masks are not checked there`,
      `web: ${own("web.Dockerfile")} exists - BuildKit reads it instead of ${ROOT_IGNORE}, and the .env masks are not checked there`,
    ]);
  });

  it("builds the four images of the stack from the targets of one Dockerfile", () => {
    const builds = Object.entries(cleanConfig().services).flatMap(
      ([name, service]) =>
        service.build === undefined ? [] : [[name, service.build]],
    );

    expect(builds).toEqual(
      ["migrate", "api", "worker", "web"].map((name) => [
        name,
        {
          context: CONTEXT,
          dockerfile: "infra/docker/app.Dockerfile",
          target: name,
        },
      ]),
    );
  });

  it("finds the .dockerignore of a Dockerfile given by an absolute path", () => {
    const dockerfile = join("/opt", "images", "Dockerfile");
    const config = built();
    config.services.api = { build: { context: CONTEXT, dockerfile } };

    expect(
      buildIgnores(
        config,
        reader({
          [ROOT_IGNORE]: CLEAN_IGNORE,
          [`${dockerfile}.dockerignore`]: "",
        }),
      ),
    ).toEqual([
      `api: ${dockerfile}.dockerignore exists - BuildKit reads it instead of ${ROOT_IGNORE}, and the .env masks are not checked there`,
    ]);
  });
});

/**
 * The interpolation of the Compose files, without `.env` (docs/adr/0014):
 * what `config --variables` names, and where a control value lands.
 */
describe("checkVariables", () => {
  /** What `--variables` prints for the stack of this repository. */
  function stackVariables(): Record<string, Record<string, unknown>> {
    return {
      APP_VERSION: {
        Name: "APP_VERSION",
        DefaultValue: "",
        PresenceValue: "",
        Required: false,
      },
      GIT_COMMIT: {
        Name: "GIT_COMMIT",
        DefaultValue: "",
        PresenceValue: "",
        Required: false,
      },
      WEB_PORT: {
        Name: "WEB_PORT",
        DefaultValue: "3000",
        PresenceValue: "",
        Required: false,
      },
    };
  }

  it("passes the variables of the stack", () => {
    expect(checkVariables(stackVariables())).toEqual({
      names: ["APP_VERSION", "GIT_COMMIT", "WEB_PORT"],
      problems: [],
    });
  });

  it("refuses a variable INTERPOLATED does not list, by its name", () => {
    const variables = {
      ...stackVariables(),
      PG_PORT: { Name: "PG_PORT", DefaultValue: "5442", Required: false },
    };

    expect(checkVariables(variables).problems).toEqual([
      "interpolation: PG_PORT - the gate has no control value for it and cannot see where it lands; add it to INTERPOLATED of scripts/compose-rules.mjs with the fields it may reach",
    ]);
  });

  it.each([
    ["true", true],
    ["missing", undefined],
  ])("refuses a variable whose Required is %s", (_case, required) => {
    const variables = stackVariables();
    variables.WEB_PORT = { ...variables.WEB_PORT, Required: required };

    expect(checkVariables(variables).problems).toEqual([
      "interpolation: WEB_PORT is required - the stack does not come up without it, and the gate renders with an empty env file",
    ]);
  });

  it("refuses a default that is the control value", () => {
    const variables = stackVariables();
    variables.WEB_PORT = {
      ...variables.WEB_PORT,
      DefaultValue: INTERPOLATED.get("WEB_PORT")?.control,
    };

    expect(checkVariables(variables).problems).toEqual([
      "interpolation: WEB_PORT defaults to its control value - the control render would not see where it lands",
    ]);
  });

  it.each([
    ["the top level", [], "(top level)"],
    ["a variable", { WEB_PORT: "3000" }, "WEB_PORT"],
  ])("refuses %s in another shape", (_case, variables, path) => {
    expect(checkVariables(variables).problems).toEqual([
      `unexpected shape of docker compose config --variables: ${path}`,
    ]);
  });

  it("gives the control render a value for each variable it knows", () => {
    expect(controlEnvOf([...Object.keys(stackVariables()), "OTHER"])).toBe(
      [
        `APP_VERSION=${INTERPOLATED.get("APP_VERSION")?.control}`,
        `GIT_COMMIT=${INTERPOLATED.get("GIT_COMMIT")?.control}`,
        `WEB_PORT=${INTERPOLATED.get("WEB_PORT")?.control}`,
        "",
      ].join("\n"),
    );
  });

  it("controls WEB_PORT with an address and a range of ports, none of them its default", () => {
    // `.env` may give WEB_PORT an address (`0.0.0.0:3000`) and a range
    // (`3000-3010`): Compose puts the first into host_ip, the second into
    // published (measured on Compose 5.5.1), so the control value has both.
    const control = INTERPOLATED.get("WEB_PORT")?.control ?? "";
    const [, host = "", from = "", to = ""] =
      /^([\d.]+):(\d+)-(\d+)$/.exec(control) ?? [];

    expect(host).not.toBe("");
    expect(host).not.toBe("127.0.0.1");
    // The pieces Compose splits it into, each a field may hold alone.
    expect(INTERPOLATED.get("WEB_PORT")?.parts).toEqual([
      host,
      `${from}-${to}`,
    ]);
    expect(Number(from)).toBeLessThan(Number(to));
    expect(Number(to)).toBeLessThan(65536);
    expect([from, to]).not.toContain("3000");
  });
});

describe("checkInterpolation", () => {
  const WEB_PORT = INTERPOLATED.get("WEB_PORT")?.control ?? "";
  const APP_VERSION = INTERPOLATED.get("APP_VERSION")?.control ?? "";
  /** The fields WEB_PORT may land in, as the violations name them. */
  const WEB_PORT_FIELDS =
    "services.web.ports[*].host_ip, services.web.ports[*].published";
  /**
   * How Compose renders `${WEB_PORT}:<target>` with the control value: the
   * address in host_ip, the range in published (measured on Compose 5.5.1).
   */
  function controlPort(target: number): Record<string, unknown> {
    const [host, ports] = WEB_PORT.split(":");
    return { host_ip: host, target, published: ports };
  }

  /** A clean stack with the service `name` changed by `change`. */
  function changed(
    name: string,
    change: (service: Service) => void,
  ): { services: Record<string, Service> } {
    return broken(name, change);
  }

  it("passes two renders that do not differ", () => {
    expect(checkInterpolation(cleanConfig(), cleanConfig())).toEqual([]);
  });

  it("passes WEB_PORT in the published port of web", () => {
    const probed = changed("web", (service) => {
      service.ports = [{ target: 3000, published: WEB_PORT }];
    });

    expect(checkInterpolation(cleanConfig(), probed)).toEqual([]);
  });

  it("passes WEB_PORT in the address and the range of the port of web", () => {
    const probed = changed("web", (service) => {
      service.ports = [controlPort(3000)];
    });

    expect(checkInterpolation(cleanConfig(), probed)).toEqual([]);
  });

  it("refuses the address and the range of WEB_PORT in the port of postgres", () => {
    const probed = changed("postgres", (service) => {
      service.ports = [controlPort(5432)];
    });

    expect(checkInterpolation(cleanConfig(), probed)).toEqual([
      `interpolation: services.postgres.ports[0].host_ip takes WEB_PORT - it may land only in ${WEB_PORT_FIELDS}`,
      `interpolation: services.postgres.ports[0].published takes WEB_PORT - it may land only in ${WEB_PORT_FIELDS}`,
    ]);
  });

  it("takes a part of a control value only whole, not a piece of a part", () => {
    const probed = changed("postgres", (service) => {
      service.ports = [{ host_ip: "127.0.0.1", target: 5432, published: "3" }];
    });

    expect(checkInterpolation(cleanConfig(), probed)).toEqual([
      "interpolation: services.postgres.ports[0].published changes with the variables of the stack and holds none of their control values - only the fields of INTERPOLATED may take a value from .env",
    ]);
  });

  it("takes no piece of a control value its entry does not declare a part", () => {
    // A control with `:` that Compose does not split - a URL - gives no
    // fragment between its `:` to a field (C9, E0-12K).
    const allowed = new Map([
      [
        "DATABASE_URL",
        {
          control: "postgres://gate-control:1/db",
          parts: [],
          fields: ["services.api.environment.DATABASE_URL"],
        },
      ],
    ]);
    const probed = changed("api", (service) => {
      service.environment = { ...environmentOf(service), PGHOST: "postgres" };
    });

    expect(checkInterpolation(cleanConfig(), probed, allowed)).toEqual([
      "interpolation: services.api.environment.PGHOST changes with the variables of the stack and holds none of their control values - only the fields of INTERPOLATED may take a value from .env",
    ]);
  });

  /**
   * KNOWN GAP, accepted by decision (ОВ1, ADR-0014): not the behaviour the
   * gate wants, the hole it is known to have. The tech lead took it as the
   * residue of a form made on purpose (Открытый вопрос 1, E0-12K) and
   * ADR-0014 writes it in «Последствия»: `--variables` gives one default per
   * variable, so a second use of it whose default is the control value
   * renders the same in both renders and is not seen. The case pins the gap
   * where the ADR writes it: a gate that comes to see it turns this red, and
   * the ADR is changed with it.
   */
  it("known gap accepted by decision (ОВ1, ADR-0014): does not see a second use of a variable whose default is its control value", () => {
    // `${WEB_PORT:-3000}:3000` in web and
    // `${WEB_PORT:-<control>}:5432` in postgres: --variables names the first
    // default only, and postgres renders the control value either way.
    const variables = {
      WEB_PORT: {
        Name: "WEB_PORT",
        DefaultValue: "3000",
        PresenceValue: "",
        Required: false,
      },
    };
    const same = changed("postgres", (service) => {
      service.ports = [controlPort(5432)];
    });

    expect(checkVariables(variables).problems).toEqual([]);
    expect(checkInterpolation(same, structuredClone(same))).toEqual([]);
  });

  it("passes a build arg in its own field", () => {
    const base = changed("api", (service) => {
      service.build = { ...buildOf("api"), args: { APP_VERSION: "" } };
    });
    const probed = changed("api", (service) => {
      service.build = { ...buildOf("api"), args: { APP_VERSION } };
    });

    expect(checkInterpolation(base, probed)).toEqual([]);
  });

  it.each([
    [
      "the published port of postgres",
      "postgres",
      (service: Service) => {
        service.ports = [
          { host_ip: "127.0.0.1", target: 5432, published: WEB_PORT },
        ];
      },
      "services.postgres.ports[0].published",
    ],
    [
      "a healthcheck",
      "postgres",
      (service: Service) => {
        service.healthcheck = {
          test: ["CMD", "pg_isready", "-h", "127.0.0.1", "-U", WEB_PORT],
          start_period: "1m0s",
        };
      },
      "services.postgres.healthcheck.test[5]",
    ],
    [
      "the environment of a service",
      "api",
      (service: Service) => {
        service.environment = { ...environmentOf(service), API_PORT: WEB_PORT };
      },
      "services.api.environment.API_PORT",
    ],
  ])("refuses WEB_PORT in %s", (_case, name, change, path) => {
    expect(checkInterpolation(cleanConfig(), changed(name, change))).toEqual([
      `interpolation: ${path} takes WEB_PORT - it may land only in ${WEB_PORT_FIELDS}`,
    ]);
  });

  it("refuses a build arg in the field of another", () => {
    const probed = changed("api", (service) => {
      service.build = { ...buildOf("api"), args: { GIT_COMMIT: APP_VERSION } };
    });

    expect(checkInterpolation(cleanConfig(), probed)).toEqual([
      "interpolation: services.api.build.args.GIT_COMMIT takes APP_VERSION - it may land only in services.*.build.args.APP_VERSION",
    ]);
  });

  it("refuses a field that changes without a control value in it", () => {
    const probed = changed("web", (service) => {
      service.restart = "always";
    });

    expect(checkInterpolation(cleanConfig(), probed)).toEqual([
      "interpolation: services.web.restart changes with the variables of the stack and holds none of their control values - only the fields of INTERPOLATED may take a value from .env",
    ]);
  });

  it("refuses an empty object that the control render drops", () => {
    const base = { services: { api: { image: "x", environment: {} } } };
    const probed = { services: { api: { image: "x" } } };

    expect(checkInterpolation(base, probed)).toEqual([
      "interpolation: services.api.environment changes with the variables of the stack and holds none of their control values - only the fields of INTERPOLATED may take a value from .env",
    ]);
  });

  it("does not read a key with dots and brackets as a path of other keys", () => {
    const base = { services: { web: { "ports[0].published": "3000" } } };
    const probed = { services: { web: { "ports[0].published": WEB_PORT } } };

    expect(checkInterpolation(base, probed)).toEqual([
      `interpolation: services.web["ports[0].published"] takes WEB_PORT - it may land only in ${WEB_PORT_FIELDS}`,
    ]);
  });
});

/**
 * The files of rules 11, 14 and 15 are the files the `when` of the gate names
 * (.claude/hooks/rules.sf.json): a Compose file of the graph outside `when`
 * would change the stack without choosing the gate (S7, E0-12C). Whether
 * `when` chooses the gate on a file is asked of `selectGates` of
 * .claude/hooks/gates.js - the function that chooses the gates - so no
 * reading of the syntax of `when` lives here (B4, E0-12K).
 */
describe("COMPOSE_SOURCES and the when of the compose gate", () => {
  const GateSchema = z.object({
    gates: z.array(
      z.object({ id: z.string(), when: z.string() }).passthrough(),
    ),
  });
  const ChoiceSchema = z.array(z.object({ run: z.boolean() }).passthrough());

  /** The compose gate as rules.sf.json has it. */
  function composeGate(): z.infer<typeof GateSchema>["gates"][number] {
    const { gates } = GateSchema.parse(
      readRepoJson(".claude/hooks/rules.sf.json"),
    );
    const gate = gates.find((one) => one.id === "compose");
    if (gate === undefined) throw new Error("no compose gate");
    return gate;
  }

  /** `selectGates` of gates.js, a CommonJS module of the hooks. */
  function selectGates(): (...args: unknown[]) => unknown {
    const hooks: unknown = createRequire(import.meta.url)(
      "../.claude/hooks/gates.js",
    );
    if (
      typeof hooks !== "object" ||
      hooks === null ||
      !("selectGates" in hooks) ||
      typeof hooks.selectGates !== "function"
    ) {
      throw new Error(".claude/hooks/gates.js exports no selectGates");
    }
    const select = hooks.selectGates;
    return (...args) => Reflect.apply(select, undefined, args);
  }

  /** Whether gates.js chooses the compose gate on a change of `file` alone. */
  function chosen(file: string): boolean {
    const choices = ChoiceSchema.parse(
      selectGates()([composeGate()], [file], null),
    );
    return choices[0]?.run === true;
  }

  const BuildSchema = z.union([
    z.string(),
    z
      .object({
        context: z.string().optional(),
        dockerfile: z.string().optional(),
      })
      .passthrough(),
  ]);
  const ComposeFileSchema = z
    .object({
      services: z
        .record(z.object({ build: BuildSchema.optional() }).passthrough())
        .optional(),
    })
    .passthrough();

  /**
   * The `.dockerignore` files rule 11 reads for the builds of the Compose
   * files of the stack, from the root: the one of each build context and the
   * one next to each Dockerfile (`<Dockerfile>.dockerignore`), with the paths
   * of each build resolved the way Compose resolves them - the context
   * against the directory of its file, the Dockerfile against the context.
   */
  function buildIgnores(): string[] {
    const found = new Set<string>();
    for (const source of COMPOSE_SOURCES) {
      const { services = {} } = ComposeFileSchema.parse(
        readRepoYaml(source, { merge: true }),
      );
      for (const { build } of Object.values(services)) {
        if (build === undefined) continue;
        const { context = ".", dockerfile = "Dockerfile" } =
          typeof build === "string" ? { context: build } : build;
        const dir = resolve(repoRoot, dirname(source), context);
        found.add(fromRoot(repoRoot, join(dir, ".dockerignore")));
        found.add(
          fromRoot(repoRoot, `${resolve(dir, dockerfile)}.dockerignore`),
        );
      }
    }
    return [...found];
  }

  it("is chosen on every file of COMPOSE_SOURCES", () => {
    expect(COMPOSE_SOURCES.filter((file) => !chosen(file))).toEqual([]);
  });

  it("is chosen on every override name and every default name at the root and in infra/", () => {
    const names = [...OVERRIDE_FILES, ...DEFAULT_FILES];
    const files = [...names, ...names.map((name) => `infra/${name}`)];

    expect(files.filter((file) => !chosen(file))).toEqual([]);
  });

  it("is chosen on no other Compose file at the root and in infra/", () => {
    const others = ["compose.prod.yml", "docker-compose.prod.yaml", "x.yaml"];
    const files = [
      ...others,
      ...others.map((name) => `infra/${name}`),
      "infra/deploy/extra.yaml",
    ];

    expect(files.filter(chosen)).toEqual([]);
  });

  it("is chosen on the .dockerignore rule 11 reads for each build of the stack", () => {
    const ignores = buildIgnores();

    expect(ignores).toEqual([
      ".dockerignore",
      "infra/docker/app.Dockerfile.dockerignore",
    ]);
    expect(ignores.filter((file) => !chosen(file))).toEqual([]);
  });

  it("takes the files of the stack for COMPOSE_SOURCES, and nothing else", () => {
    expect(COMPOSE_SOURCES.every((file) => isComposeSource(file))).toBe(true);
    expect(isComposeSource("infra/compose.yaml")).toBe(false);
    expect(isComposeSource("infra\\docker-compose.yml")).toBe(false);
  });

  it("takes a file of COMPOSE_SOURCES in another case on Windows only", () => {
    expect(isComposeSource("Infra/Docker-Compose.yml", "win32")).toBe(true);
    expect(isComposeSource("Infra/Docker-Compose.yml", "linux")).toBe(false);
  });

  it("is chosen on package.json, which pins the yaml the reader parses with", () => {
    const { devDependencies } = z
      .object({ devDependencies: z.record(z.string()) })
      .parse(readRepoJson("package.json"));

    expect(chosen("package.json")).toBe(true);
    expect(devDependencies.yaml).toBe("2.9.0");
  });
});

describe("durationSec", () => {
  it("reads Compose durations", () => {
    expect(durationSec("30s")).toBe(30);
    expect(durationSec("1m30s")).toBe(90);
    expect(durationSec(30e9)).toBe(30);
    expect(durationSec("")).toBeNaN();
    expect(durationSec("30")).toBeNaN();
  });
});

describe("defaultComposeFile", () => {
  it("is the file `docker compose` takes at the root of the repository", () => {
    // The root itself, under any path, is the case of test/paths.test.ts.
    // DEFAULT_FILES is held to compose-go by the case of rule 14.
    const present = DEFAULT_FILES.filter((name) => repoFileExists(name));

    expect(present).toHaveLength(1);
    expect(defaultComposeFile()).toBe(join(repoRoot, present[0] ?? ""));
  });
});
