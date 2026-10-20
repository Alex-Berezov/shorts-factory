import type { FastifyInstance } from "fastify";

// The augmentation holds for every file the tsconfig of the app includes, so
// a reader or writer of the flags (`request-log.ts`, `plugins/auth.ts`) needs
// no import of this module for them; the one import is of
// `decorateRequestState`, in `app.ts`.
declare module "fastify" {
  interface FastifyRequest {
    /**
     * Whether the caller gave the admin password: set to `true` by the auth
     * hook (`plugins/auth.ts`) and nowhere else. `false` on a public route and
     * on a rejected password, `undefined` on a request the router built for
     * one of its own failures (`frameworkErrors`): that request is made on the
     * server-wide context and carries none of the decorators. Read as
     * `=== true`, so the absent value is never mistaken for one of the two.
     */
    authenticated: boolean | undefined;
    /**
     * Whether a line about the failure of this request is already written -
     * a rejection, an error, the default handler taking over from ours, a
     * response that broke on its way out. Every later line about the same
     * request but the ones about a second failure stays silent: one request,
     * one line (docs/DECISIONS.md, Д1 E0-11A; the request log,
     * `lib/request-log.ts`). `undefined` on a request of `frameworkErrors`,
     * as above; read as `=== true`.
     */
    failureLogged: boolean | undefined;
  }
}

/**
 * Puts the state above on every request of the instance. One call, in
 * `buildApp`, before any plugin that reads or sets it is registered.
 */
export function decorateRequestState(app: FastifyInstance): void {
  app.decorateRequest("authenticated", false);
  app.decorateRequest("failureLogged", false);
}
