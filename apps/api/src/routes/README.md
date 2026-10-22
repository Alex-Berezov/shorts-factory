One directory per module, `<module>/index.ts` exporting
`registerRoutes(registrar: RouteRegistrar, deps: AppDeps)`; `index.ts` here
is the registry that calls them and is the only file an epic edits to add its
own. `registrar` is not the Fastify instance: it is a `RouteRegistrar` from
`src/lib/define-route.ts`, a frozen object with no key of the instance, which
`defineRoute` takes and nothing else does (docs/adr/0015-route-registrar.md).

A route declares its request and response shapes as Zod schemas, which serve
as the runtime validation and as the OpenAPI document at the same time
(`/docs`, `/openapi.json`). The schemas themselves live in `@sf/contracts`,
where web and `@sf/api-client` read the same objects; a route imports them
and adds nothing of its own shape here.

Three rules the registry cannot state on its own:

- everything is behind basic auth. The password is checked by a global hook,
  so a new route is protected the moment it is registered; publishing one is
  an explicit line in `PUBLIC_ROUTES` of `src/plugins/auth.ts`, and today that
  list holds only `/health`.
- a handler does not build error responses. It throws an `AppError` from
  `@sf/core` (or lets anything else through) and the error handler turns that
  into `ErrorBody` from `@sf/contracts` - `{ error: { code, message,
  requestId, details? } }` - with the right status; `details` is present only
  for a whitelisted subset (validation issues, a budget failure) and absent
  otherwise. The route still declares that envelope: `...errorResponses()`
  from `src/lib/define-route.ts` goes into every `schema.response` next to
  the success statuses, so the failures are in the document and the
  serializer knows their shape. Fastify picks the schema of a reply by its
  exact status, then by its class (`2xx`, `4xx`), then `default`
  (`fastify/lib/schemas.js`, `getSchemaSerializer`). With `4xx` and `5xx`
  declared, `default` is reached by a 1xx-3xx status alone - a success or a
  redirect, never a failure - so a route declares no `default` and names its
  success status instead (`test/route-shape.test.ts` refuses a `default`,
  whatever it holds). Fastify reads each key lowercased, so `4XX` and `4xx`
  are one key and the later of the two in the object wins: a class key
  declared after `...errorResponses()` replaces the envelope for that class
  (`test/route-shape.test.ts` refuses such a route). A status the route
  answers with a body of its own -
  `503` on `/health` - is wrapped in `withErrorEnvelope()` from the same
  module: an exact key wins over the wildcard for the whole status, and
  without the wrapper a failure carrying that status is serialized against
  the success shape and reaches the caller as a 500 from the framework.
  Which statuses a route answers on is not a decision of the route file:
  `/health` takes them from `HEALTH_STATUS_CODES` in `@sf/contracts`,
  because `@sf/api-client` has to read the same list to tell an answer from
  a failure.
- a handler states what it returns, and states it from its own schema. A
  route is registered with `defineRoute(registrar, { method, url, responses,
  schema, ...options }, handler)` from `src/lib/define-route.ts` and with
  nothing else: the registrar has no `get`, `route`, `withTypeProvider`,
  `register`, `addHook`, `decorate` or `set*`, so none of them compiles, and
  a cast finds nothing behind it at run time either.
  The responses go into a local
  `const responses = { ...errorResponses(), [OK_STATUS]: SomeSchema }`;
  the helper puts that object
  into `schema.response` and types the reply of the handler as the body at
  `OK_STATUS` of that same object, so both come from one object. The route
  writes no reply type of its own: the type the helper reads off `responses`
  is internal to `src/lib/define-route.ts` and is not exported. Both are
  needed and neither is decoration: with the reply type left to inference a
  handler may return an error envelope in place of the answer, because the
  declared failures are responses too; and a `Reply` written out by hand
  replaces the inferred type instead of narrowing it, so a generic naming one
  contract next to a schema naming another compiles in silence (checked with
  `tsc` both ways - see the case file of E0-07). `schema` takes the summary,
  the tags and the request shapes (`params`, `body`, `querystring`, typed for
  the handler through the zod provider), not `response`: a second place for
  the responses does not compile. Hooks and the other route options
  (`onRequest`, `preHandler`, `bodyLimit`, `config`) go next to `schema`;
  headers set on the answers of the route go in `replyHeaders`
  (`cache-control: no-store` on `/health`), which `defineRoute` sets in a
  hook of its own that hands the body back untouched - on every answer that
  passes the `onSend` of the route: the handler's, its hooks', the app's
  error handler's and, measured, Fastify's default handler's when the app's
  throws; not on a 404 of an unknown url. Only the names and values of
  `REPLY_HEADERS` in `src/lib/define-route.ts` are allowed (today
  `cache-control: no-store`): in `replyHeaders`, a header of the body
  (`content-*`, `transfer-encoding`), `set-cookie`, the request id, or a
  value off the list (`public, max-age=...`, a line break, an empty one) does
  not compile and is thrown on at run time, and the table grows by a new ADR.
  That holds for the option alone: `reply.header`, `reply.removeHeader`,
  `reply.type` and `reply.serializer` in the handler and in the hooks a
  route may have (`onRequest`, `preValidation`, `preHandler`, `onError`)
  stay open - review holds them (docs/TECH_DEBT.md, open -> E0-12V).
  The options the error envelope rests on (`errorHandler`,
  `serializerCompiler`, `validatorCompiler`, `schemaErrorFormatter`,
  `attachValidation`) belong to the app, and the hooks that get the body and
  may hand back another (`onSend`, `preSerialization`) are not the route's:
  written in the definition, one does not compile, and one that gets past
  the type (a spread, a cast) makes `defineRoute` throw before the route is
  registered.
  A handler and a hook of the route still see the whole instance as
  `request.server`, `reply.server` and `this`, typed without a cast. Once
  the app is ready Fastify refuses a route, a hook, a plugin, a decoration,
  an error handler and the compilers added there - measured under `inject`
  in `test/instance-after-ready.test.ts` by the code of each refusal and the
  trace left on the context; and `test/route-modules.test.ts` refuses the
  names themselves in any source file of this directory, read off its
  syntax tree: `this` anywhere, and the word `server` in any position - a
  name (`request.server`, `({ server } = request)`, `const server = ...`,
  `deps.config.server` too) or a string (`request["server"]`,
  `Reflect.get(request, "server")`). A key computed at run time
  (`request[key]`, `Object.values(request)`, `Object.entries(request)`,
  `for ... in`) is beyond that reading, and nothing holds
  `request.server.close()` or `.inject()` from a handler (docs/TECH_DEBT.md,
  open -> E0-12V).
  What this does not cover: bodies sent with `reply.status(...).send(...)`
  under another status, which only the serializer checks.

Four locks hold the shape above. The type of the registrar refuses any
registration past the helper: every way around it - the eight methods with
or without a generic, `.route(`, `withTypeProvider`, brackets,
destructuring, `.call`/`.bind`, `register`, `addHook`, `decorate`, the `set*`
handlers and compilers - is
a `@ts-expect-error` in `apps/api/test/define-route.test.ts`, next to the
types of the helper under `tsc` (a handler returning the error envelope and
a `schema` with a `response` of its own do not compile) and the run-time
cases of the registrar. The rule S14 of `.claude/hooks/rules.sf.json`
refuses `defineRoute(` in a file without `...errorResponses()` in its code,
a mention in a comment not counting.
`apps/api/test/route-shape.test.ts` checks every registered route in
`pnpm test`, those the app puts straight on its root included: its
`config` is the one `defineRoute` registered it with (`isDefinedRoute`), so
code outside `src/routes` handed the instance - a function of `src/lib`, a
plugin, `app.ts` - cannot register a route past the helper either, the
routes of the documentation aside; the wildcards and every exact status
from 400 to 599 carry the error envelope, and `OK_STATUS` is there; its
list of the routes of the registry is exact, so a new module adds its route
to it. `apps/api/test/route-modules.test.ts` reads every module of this
directory for `this` and `server` (above).

E0 has `health` and `system`; the module per epic is listed in
`src/routes/index.ts`.
