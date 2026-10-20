import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RENDERING_PROBE,
  RENDERING_PROBE_SOURCE,
  RULE_IDS,
  TEST_STACK_BINDS,
  checkCompose,
  checkDockerignore,
  checkRendering,
  defaultComposeFile,
  durationSec,
} from "../scripts/compose-rules.mjs";
import { repoRoot } from "../scripts/lib/paths.mjs";
import {
  CLEAN_IGNORE,
  CLEAN_TEST_ENV,
  type Service,
  buildAt,
  cleanFilesAt,
  cleanStack,
} from "./compose-fixture.js";
import { readRepoFile } from "./repo-files.js";

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
const CONTEXT = join("/srv", "shorts-factory");
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

/** The project of `check`: its `.env`, its `.env.test` and `read`. */
function projectWith(read: (path: string) => string | null) {
  return {
    envFile: PROJECT_ENV,
    testEnvFile: TEST_ENV_FILE,
    read,
  };
}

/**
 * `checkCompose` for a project whose `.env` is `PROJECT_ENV`, with the files
 * of `cleanFiles` changed by `files` (a null removes one).
 */
function check(
  config: unknown,
  files: Record<string, string | null> = {},
): string[] {
  const present = Object.fromEntries(
    Object.entries({ ...cleanFiles(), ...files }).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  );
  return checkCompose(config, projectWith(reader(present)));
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

  it.each([
    ["empty bind options (Docker Compose v2.38)", {}, "{}"],
    ["no bind options", undefined, "null"],
    [
      "the option reversed",
      { create_host_path: true },
      '{"create_host_path":true}',
    ],
  ])("stops on a rendering with %s", (_case, bind, shown) => {
    expect(checkRendering(rendered(bind))).toEqual([
      `this docker compose prints the probe's create_host_path: false as ${shown} - rule 10 cannot tell the option from its absence; run the Compose CI pins (.github/workflows/ci.yml)`,
    ]);
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

describe("durationSec", () => {
  it("reads Compose durations", () => {
    expect(durationSec("30s")).toBe(30);
    expect(durationSec("1m30s")).toBe(90);
    expect(durationSec(30e9)).toBe(30);
    expect(durationSec("")).toBeNaN();
    expect(durationSec("30")).toBeNaN();
  });
});

/**
 * The names `docker compose` looks for in its working directory when no
 * `-f` is given, in its order (the Compose specification, "Compose file").
 */
const COMPOSE_DEFAULT_NAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];

describe("defaultComposeFile", () => {
  it("is the file `docker compose` takes at the root of the repository", () => {
    // The root itself, under any path, is the case of test/paths.test.ts.
    const present = COMPOSE_DEFAULT_NAMES.filter((name) =>
      existsSync(join(repoRoot, name)),
    );

    expect(present).toHaveLength(1);
    expect(defaultComposeFile()).toBe(join(repoRoot, present[0] ?? ""));
  });
});
