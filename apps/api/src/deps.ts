import type { BuildInfo, HealthReport } from "@sf/contracts";

/**
 * How the application is wired, and only that: what the routes answer is
 * declared in `@sf/contracts`, where web reads the same objects, and the
 * shapes this module used to hold moved there in E0-07.
 *
 * `HealthProbes` is an interface rather than the concrete implementation from
 * `lib/health.ts`, so `buildApp` - and with it every route test - stays free
 * of a database handle and a Redis socket.
 */
export interface HealthProbes {
  check(): Promise<HealthReport>;
}

/**
 * Everything `buildApp` receives from its caller. Owning connections is
 * `server.ts`'s job: this object only carries what the routes read, which is
 * why `db` and `queues` are not here - E0-09 and E1 add them as narrow
 * interfaces the same way.
 */
export interface AppDeps {
  health: HealthProbes;
  buildInfo: BuildInfo;
}
