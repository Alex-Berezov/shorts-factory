One directory per module, `<module>/index.ts` exporting
`registerRoutes(app, deps)`; `index.ts` here is the registry that calls them
and is the only file an epic edits to add its own.

A route declares its request and response shapes as Zod schemas, which serve
as the runtime validation and as the OpenAPI document at the same time
(`/docs`, `/openapi.json`). The schemas themselves live in `@sf/contracts`,
where web and `@sf/api-client` read the same objects; a route imports them
and adds nothing of its own shape here.

Two rules the registry cannot state on its own:

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
  from `src/lib/route-schemas.ts` goes into every `schema.response` before the
  success statuses, so the failures are in the document and the serializer
  knows their shape. A status the route answers with a body of its own - `503`
  on `/health` - is wrapped in `withErrorEnvelope()` from the same module:
  an exact key wins over the wildcard for the whole status, and without the
  wrapper a failure carrying that status is serialized against the success
  shape and reaches the caller as a 500 from the framework. Which statuses a
  route answers on is not a decision of the route file: `/health` takes them
  from `HEALTH_STATUS_CODES` in `@sf/contracts`, because `@sf/api-client` has
  to read the same list to tell an answer from a failure.
- a handler states what it returns, and states it from its own schema. The
  responses go into a local `const responses = { ...errorResponses(), [OK_STATUS]:
  SomeSchema }`, that object is what `schema.response` gets, and the route
  generic is `app.get<{ Reply: SuccessReply<typeof responses> }>`. Both halves
  are needed and neither is decoration: with the reply type left to inference
  a handler may return an error envelope in place of the answer, because the
  declared failures are responses too; and a `Reply` written out by hand
  replaces the inferred type instead of narrowing it, so a generic naming one
  contract next to a schema naming another compiles in silence (checked with
  `tsc` both ways - see the case file of E0-07). Reading the type off the
  object keeps one declaration where there would otherwise be two.
  What this does not cover: bodies sent with `reply.status(...).send(...)`
  under another status, which only the serializer checks.

E0 has `health` and `system`; the module per epic is listed in
`src/server.ts`.
