One directory per module, `<module>/index.ts` exporting
`registerRoutes(app, deps)`; `index.ts` here is the registry that calls them
and is the only file an epic edits to add its own.

A route declares its request and response shapes as Zod schemas, which serve
as the runtime validation and as the OpenAPI document at the same time
(`/docs`, `/openapi.json`). The schemas live next to the route until E0-07
moves them into `@sf/contracts`, where web reads the same objects.

Two rules the registry cannot state on its own:

- everything is behind basic auth. The password is checked by a global hook,
  so a new route is protected the moment it is registered; publishing one is
  an explicit line in `PUBLIC_ROUTES` of `src/plugins/auth.ts`, and today that
  list holds only `/health`.
- a handler does not build error responses. It throws an `AppError` from
  `@sf/core` (or lets anything else through) and the error handler turns that
  into `{ error: { code, message, requestId, details? } }` with the right
  status; `details` is present only for a whitelisted subset (validation
  issues, a budget failure) and absent otherwise.

E0 has `health` and `system`; the module per epic is listed in
`src/server.ts`.
