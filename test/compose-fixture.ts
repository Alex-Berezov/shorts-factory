import { join } from "node:path";

/**
 * A correct full stack in the shape `docker compose config --format json`
 * prints it, and the files the compose rules read next to it - the fixture
 * of the rules (compose-rules.test.ts) and of the gate that feeds them
 * (check-compose.test.ts), so both hold the same stack to be clean.
 */

export type Service = Record<string, unknown>;

/** Where the fixture lies: the root of the project and its `.env`. */
export interface FixtureRoot {
  /** The build context of every image: the root of the project. */
  context: string;
  /** The project's `.env`, absolute, as Compose resolves `../.env` of a bind. */
  envFile: string;
}

/** A `.dockerignore` with the masks rule 11 asks for. */
export const CLEAN_IGNORE = ".env\n.env.*\n**/.env\n**/.env.*\n";

/** A `.env.test` pointing at the ports `cleanStack` publishes. */
export const CLEAN_TEST_ENV = [
  "# local Compose addresses",
  "DATABASE_URL=postgresql://sf:sf@localhost:5442/shorts_factory_test",
  "REDIS_URL=redis://localhost:6389/1",
  "",
].join("\n");

/** The files the rules read of a clean project at `context`. */
export function cleanFilesAt(context: string): Record<string, string> {
  return {
    [join(context, ".dockerignore")]: CLEAN_IGNORE,
    [join(context, ".env.test")]: CLEAN_TEST_ENV,
  };
}

/**
 * The build of a service's image, as Compose prints it for the stack of
 * infra/docker-compose.app.yml: the target of the service's name in the one
 * Dockerfile of the application.
 */
export function buildAt(context: string, name: string): Service {
  return {
    context,
    dockerfile: "infra/docker/app.Dockerfile",
    target: name,
  };
}

/** The resolved configuration of a correct stack, as Compose prints it. */
export function cleanStack({ context, envFile }: FixtureRoot): {
  services: Record<string, Service>;
} {
  const afterMigrate = {
    migrate: { condition: "service_completed_successfully", required: true },
    postgres: { condition: "service_healthy", required: true },
    redis: { condition: "service_healthy", required: true },
  };
  const envMount = () => ({
    type: "bind",
    source: envFile,
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
          test: ["CMD-SHELL", "redis-cli ping | grep -qx PONG"],
          start_period: "10s",
        },
        restart: "unless-stopped",
      },
      migrate: {
        build: buildAt(context, "migrate"),
        volumes: [envMount()],
        environment: { NODE_ENV: "production" },
        depends_on: { postgres: { condition: "service_healthy" } },
        init: true,
        restart: "no",
      },
      api: {
        build: buildAt(context, "api"),
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
        stop_grace_period: "15s",
        restart: "unless-stopped",
      },
      worker: {
        build: buildAt(context, "worker"),
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
        build: buildAt(context, "web"),
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
