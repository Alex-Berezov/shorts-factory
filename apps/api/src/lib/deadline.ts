/** What a call that ran out of its deadline is reported as. */
export class DeadlineError extends Error {
  constructor(timeoutMs: number) {
    super(`deadline of ${timeoutMs}ms expired`);
    this.name = "DeadlineError";
  }
}

/**
 * Runs something under a deadline.
 *
 * The deadline is the point: a TCP connection to a machine that stopped
 * answering neither resolves nor rejects, so a call to a dependency without
 * one would hold the request open until the client gives up - and a page about
 * the state of the system has to answer during the incident that made it worth
 * opening.
 *
 * What it does not do is cancel the work: the query behind it keeps running
 * until the driver gives up on its own (docs/TECH_DEBT.md, 08.09.2026). That
 * is the reason the clients are configured to fail fast rather than to queue.
 */
export async function withDeadline<T>(
  run: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
