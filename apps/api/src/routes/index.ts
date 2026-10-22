import type { AppDeps } from "../deps.js";
import type { RouteRegistrar } from "../lib/define-route.js";
import { registerRoutes as registerHealthRoutes } from "./health/index.js";
import { registerRoutes as registerSystemRoutes } from "./system/index.js";

/**
 * Every route of the service, in one place. A module is a directory with an
 * `index.ts` exporting `registerRoutes(registrar, deps)`; adding an epic means
 * adding a directory and a line here, and nothing else. `registrar` is a
 * `RouteRegistrar`, not the instance: a module registers its routes with
 * `defineRoute` and has nothing else to call (docs/adr/0015-route-registrar.md).
 */
export function registerRoutes(registrar: RouteRegistrar, deps: AppDeps): void {
  registerHealthRoutes(registrar, deps);
  registerSystemRoutes(registrar, deps);
}
