import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkBuildIgnores,
  checkCompose,
  checkDockerignore,
  defaultComposeFile,
  durationSec,
} from "../../../scripts/compose-rules.mjs";

/**
 * The rules `pnpm check:compose` holds the full stack to, each fed a
 * configuration that breaks it - in the shape `docker compose config --format
 * json` prints, so no Docker is needed here. Next to the worker's image test:
 * both guard how the containers of this repository are started.
 */

type Service = Record<string, unknown>;

/** The project's `.env`, absolute, as Compose resolves `../.env` of a bind. */
const PROJECT_ENV = "/srv/shorts-factory/.env";

/** `checkCompose` for a project whose `.env` is `PROJECT_ENV`. */
function check(config: { services?: Record<string, unknown> }): string[] {
  return checkCompose(config, { envFile: PROJECT_ENV });
}

/** The resolved configuration of a correct stack, as Compose prints it. */
function cleanConfig(): { services: Record<string, Service> } {
  const afterMigrate = {
    migrate: { condition: "service_completed_successfully", required: true },
    postgres: { condition: "service_healthy", required: true },
    redis: { condition: "service_healthy", required: true },
  };
  const envMount = () => ({
    type: "bind",
    source: PROJECT_ENV,
    target: "/repo/.env",
    read_only: true,
    bind: { create_host_path: false },
  });
  const media = () => [
    envMount(),
    { type: "volume", source: "media", target: "/data/media" },
  ];
  return {
    services: {
      postgres: {
        ports: [{ host_ip: "127.0.0.1", target: 5432, published: "5442" }],
        healthcheck: {
          test: ["CMD", "pg_isready", "-h", "127.0.0.1", "-U", "sf"],
          start_period: "1m0s",
        },
        restart: "unless-stopped",
      },
      redis: {
        ports: [{ host_ip: "127.0.0.1", target: 6379, published: "6389" }],
        healthcheck: {
          test: ["CMD", "redis-cli", "ping"],
          start_period: "10s",
        },
        restart: "unless-stopped",
      },
      migrate: {
        volumes: [envMount()],
        environment: { NODE_ENV: "production" },
        depends_on: { postgres: { condition: "service_healthy" } },
        restart: "no",
      },
      api: {
        environment: {
          NODE_ENV: "production",
          MEDIA_DIR: "/data/media",
          API_PORT: "3001",
        },
        depends_on: afterMigrate,
        healthcheck: {
          test: [
            "CMD",
            "wget",
            "-q",
            "-O",
            "/dev/null",
            "http://127.0.0.1:3001/health",
          ],
        },
        volumes: media(),
        restart: "unless-stopped",
      },
      worker: {
        environment: { NODE_ENV: "production", MEDIA_DIR: "/data/media" },
        depends_on: afterMigrate,
        healthcheck: {
          test: ["CMD", "node", "--import", "tsx", "src/cli/healthcheck.ts"],
        },
        volumes: media(),
        stop_grace_period: "30s",
        restart: "unless-stopped",
      },
      web: {
        volumes: [envMount()],
        ports: [{ target: 3000, published: "3000" }],
        environment: {
          NODE_ENV: "production",
          API_INTERNAL_URL: "http://api:3001",
        },
        depends_on: {
          api: { condition: "service_healthy" },
          migrate: { condition: "service_completed_successfully" },
        },
        restart: "unless-stopped",
      },
    },
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

      expect(check(config)).toEqual([
        "postgres: publishes 5442 beyond loopback, only web may",
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

  describe("3. the worker's grace period", () => {
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
    ])("refuses redis %s", (_case, healthcheck) => {
      const config = broken("redis", (service) => {
        service.healthcheck = healthcheck;
      });

      expect(check(config)).toContain(
        "redis: healthcheck is not redis-cli ping",
      );
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
            ...(condition === undefined ? {} : { redis: { condition } }),
          };
        });

        expect(check(config)).toEqual([
          `${name}: does not wait for a healthy redis (condition service_healthy)`,
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
      ["CMD", "true"],
    ])("refuses %j", (...test) => {
      const config = broken("postgres", (service) => {
        healthcheckOf(service).test = test;
      });

      expect(check(config)).toEqual([
        "postgres: healthcheck is not pg_isready over TCP (-h) - the local socket answers during init",
      ]);
    });

    it.each([
      ["--host=127.0.0.1"],
      ["--host", "127.0.0.1"],
      ["-h127.0.0.1"],
      ["-h", "127.0.0.1"],
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

  it("refuses a negation between the masks", () => {
    expect(
      checkDockerignore(ignore(".env", "!**", ...MASKS.slice(1)), FILE),
    ).toEqual([
      `${FILE}: !** follows the .env masks - the last matching line wins, and it may let a .env back in`,
    ]);
  });
});

describe("checkBuildIgnores", () => {
  const CONTEXT = join("/srv", "shorts-factory");
  const ROOT_IGNORE = join(CONTEXT, ".dockerignore");
  const CLEAN_IGNORE = ".env\n.env.*\n**/.env\n**/.env.*\n";

  function built(...names: string[]): { services: Record<string, Service> } {
    const services: Record<string, Service> = {
      postgres: { image: "postgres:16" },
    };
    for (const name of names) {
      services[name] = {
        build: {
          context: CONTEXT,
          dockerfile: `infra/docker/${name}.Dockerfile`,
          target: "runtime",
        },
      };
    }
    return { services };
  }

  function reader(files: Record<string, string>) {
    return (path: string): string | null => files[path] ?? null;
  }

  it("passes a context whose .dockerignore masks every .env", () => {
    expect(
      checkBuildIgnores(
        built("api", "worker"),
        reader({ [ROOT_IGNORE]: CLEAN_IGNORE }),
      ),
    ).toEqual([]);
  });

  it("reports a shared .dockerignore once", () => {
    expect(
      checkBuildIgnores(
        built("api", "worker", "web"),
        reader({ [ROOT_IGNORE]: `${CLEAN_IGNORE}!**\n` }),
      ),
    ).toEqual([
      `${ROOT_IGNORE}: !** follows the .env masks - the last matching line wins, and it may let a .env back in`,
    ]);
  });

  it("refuses a context without a .dockerignore", () => {
    expect(checkBuildIgnores(built("api"), reader({}))).toEqual([
      `api: no ${ROOT_IGNORE} - every .env would enter the image`,
    ]);
  });

  it("refuses a Dockerfile with its own .dockerignore", () => {
    const own = join(CONTEXT, "infra/docker/worker.Dockerfile.dockerignore");

    expect(
      checkBuildIgnores(
        built("api", "worker"),
        reader({ [ROOT_IGNORE]: CLEAN_IGNORE, [own]: CLEAN_IGNORE }),
      ),
    ).toEqual([
      `worker: ${own} exists - BuildKit reads it instead of ${ROOT_IGNORE}, and the .env masks are not checked there`,
    ]);
  });

  it("finds the .dockerignore of a Dockerfile given by an absolute path", () => {
    const dockerfile = join("/opt", "images", "Dockerfile");
    const config = {
      services: {
        api: { build: { context: CONTEXT, dockerfile } },
      },
    };

    expect(
      checkBuildIgnores(
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

describe("defaultComposeFile", () => {
  it.each(["checkout", "with space", "с кириллицей"])(
    "finds compose.yaml of a checkout under a path %s",
    (folder) => {
      const root = join(process.cwd(), folder);
      const script = pathToFileURL(join(root, "scripts", "check-compose.mjs"));

      expect(defaultComposeFile(script.href)).toBe(join(root, "compose.yaml"));
    },
  );
});
