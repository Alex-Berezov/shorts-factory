import { withDeadline } from "../src/deadline.js";

/**
 * `work` under a deadline, for a test that waits on something which may never
 * answer - a child that should start, a queue whose verdict should come, a
 * server that should be ready. The one wait of the tests of the api, the
 * worker and this package, on the deadline primitive of the runtime rather
 * than a timer of its own beside it.
 *
 * A miss rejects with an error naming what was waited on and for how long
 * (`"<what>: no answer within <ms> ms"`), so a red case says which wait hung.
 * A failure of the work itself comes through as it is. The timer is cleared
 * either way, and it holds the process open (`unref: false`): a deadline of a
 * test has to fire even when nothing else keeps the loop alive.
 */
export function within<T>(
  work: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  return withDeadline(() => work, ms, {
    unref: false,
    error: () => new Error(`${what}: no answer within ${ms} ms`),
  });
}
