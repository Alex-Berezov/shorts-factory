import type { AppInstance } from "../app.js";
import type { AppDeps } from "../deps.js";
import { registerRoutes as registerHealthRoutes } from "./health/index.js";
import { registerRoutes as registerSystemRoutes } from "./system/index.js";

/**
 * Every route of the service, in one place. A module is a directory with an
 * `index.ts` exporting `registerRoutes(app, deps)`; adding an epic means
 * adding a directory and a line here, and nothing else.
 */
export function registerRoutes(app: AppInstance, deps: AppDeps): void {
  registerHealthRoutes(app, deps);
  registerSystemRoutes(app, deps);
}
