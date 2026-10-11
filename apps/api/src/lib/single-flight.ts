/**
 * Collapses concurrent calls into one: while a call is in flight, every
 * caller gets that same promise; once it settles, the next call starts a new
 * one.
 *
 * What it bounds is the pile-up behind a dependency that hangs. Callers put
 * their own deadline on what they get (`withDeadline` in `lib/deadline.ts`),
 * so a request gives up on time either way - but without this every request
 * that gave up would leave one more call behind it, still waiting on the same
 * silent socket. With it there is one call in flight at most, however often
 * and however far apart the dependency is asked about.
 *
 * The call is held until it settles, with no lifetime of its own: a lifetime
 * shorter than the gap between polls is no sharing at all, and any lifetime
 * is one more hanging call per lifetime. A call that hangs is therefore
 * joined for as long as it hangs - every caller gives up on its own deadline
 * and reports the dependency as down - so whoever wraps a call in this owns
 * the bound on how long it can hang (the `commandTimeout` of the Redis client
 * in `lib/redis.ts`; for a database query, see `lib/health.ts`).
 *
 * Nothing is kept after the call settles: the next caller after a success or
 * a failure asks the dependency again.
 */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let current: Promise<T> | undefined;
  return () => {
    if (current !== undefined) {
      return current;
    }
    // `async` so that a `run` that throws before returning its promise is a
    // rejection shared like any other, not an exception out of the caller.
    current = (async () => run())().finally(() => {
      current = undefined;
    });
    return current;
  };
}
