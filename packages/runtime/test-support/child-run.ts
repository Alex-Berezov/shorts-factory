import { createServer } from "node:net";
import type { Readable } from "node:stream";
import { withDeadline } from "../src/deadline.js";
import { within } from "./within.js";

/**
 * A forked child process as the tests of the api and the worker run it: its
 * output, its start, its end and its stop, each wait under a deadline that
 * names the child. One copy for both apps (ADR-0011, "test-support of the
 * apps").
 */

/**
 * The part of a forked `ChildProcess` these helpers listen to - narrow enough
 * that a test can stand in for a child whose events come in a chosen order.
 */
export interface ChildLike {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

/**
 * A child that can be told to stop, and says whether it has already ended and
 * whether its IPC channel is still open (`false` for a child without one).
 */
export interface StoppableChild extends ChildLike {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly connected: boolean;
  kill(signal?: NodeJS.Signals): boolean;
}

/** How a forked child ended, with everything it said on the streams read. */
export interface ChildRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

/** A stream of the child whose text `collectOutput` keeps. */
export type ChildStream = "stdout" | "stderr";

/**
 * What a child says on the named streams (both by default), in one text as it
 * arrives. The child must be started with those streams piped.
 */
export function collectOutput(
  child: ChildLike,
  streams: readonly ChildStream[] = ["stdout", "stderr"],
): () => string {
  let output = "";
  const append = (chunk: Buffer): void => {
    output += chunk.toString();
  };
  for (const stream of streams) {
    child[stream]?.on("data", append);
  }
  return () => output;
}

/**
 * The end of a child, once its stdio is closed too - `close`, not `exit`:
 * at `exit` the pipes can still hold what the child wrote last, and that is
 * usually the reason it stopped. A child that could not be started at all
 * (`error`) is a rejection with that error.
 *
 * The rejection is observed from the moment the promise is made, so a child
 * that fails before anyone awaits its end is no unhandled rejection of the
 * test process; whoever awaits the promise still gets the error.
 */
export function endOf(
  child: ChildLike,
  output: () => string,
): Promise<ChildRun> {
  const ended = new Promise<ChildRun>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, output: output() });
    });
  });
  // An observer on a derived promise: `ended` itself still rejects.
  void ended.catch(() => undefined);
  return ended;
}

/** The bounds of a start, and the name the failures give the child. */
export interface StartLimits {
  deadlineMs: number;
  /** How much of the end of the output a failure quotes. */
  tailChars: number;
  /** The child, as a failure names it: `"the worker"`, `"the api"`. */
  name: string;
}

/**
 * Waits until the child sends `"started"` over IPC, for at most `deadlineMs`.
 * A child that ends first is the answer at once, with its code; a child that
 * could not be started (`error`) is the answer at once too, with that error
 * as the cause - neither waits for the whole deadline. A failure by the
 * deadline or by the end quotes the last `tailChars` of what the child said
 * (read at `close` for the end, for the reason `endOf` gives).
 */
export function startOf(
  child: ChildLike,
  output: () => string,
  limits: StartLimits,
): Promise<void> {
  const tail = (): string => output().slice(-limits.tailChars);
  const started = new Promise<void>((resolve, reject) => {
    child.on("message", (message: unknown) => {
      if (message === "started") {
        resolve();
      }
    });
    child.on("error", (err) => {
      reject(
        new Error(`${limits.name} could not be started: ${err.message}`, {
          cause: err,
        }),
      );
    });
    child.on("close", (code, signal) => {
      reject(
        new Error(
          `${limits.name} exited before it started (code ${code}, signal ${signal}); it said: ${tail()}`,
        ),
      );
    });
  });
  return withDeadline(() => started, limits.deadlineMs, {
    unref: false,
    error: () => new Error(`${limits.name} never started; it said: ${tail()}`),
  });
}

/** The bound of a stop, the name its failure gives the child, and the signal. */
export interface StopLimits {
  deadlineMs: number;
  name: string;
  /** `SIGTERM` when left out. */
  signal?: NodeJS.Signals;
}

/**
 * How long a child that outlived the deadline of its stop is given to close
 * once it is sent `SIGKILL`. A kill is not something a process can answer or
 * ignore, so this only bounds how long the system takes to reap it and close
 * its pipes.
 */
export const KILL_DEADLINE_MS = 5_000;

/**
 * Whether the child has closed already: it has ended, the streams it was
 * started with piped are closed too, and so is its IPC channel - what Node
 * waits for before `close`. A listener added from here on would wait for a
 * `close` that has been.
 */
function hasClosed(child: StoppableChild): boolean {
  const ended = child.exitCode !== null || child.signalCode !== null;
  return (
    ended &&
    !child.connected &&
    [child.stdout, child.stderr].every(
      (stream) => stream === null || stream.closed,
    )
  );
}

/**
 * Sends the child its signal and waits for its `close`, for at most
 * `deadlineMs`: a child that does not answer the signal is a failure naming
 * it, not a test that hangs.
 *
 * A child that has ended already is sent nothing, and its `close` is still
 * awaited for at most `deadlineMs`: until then its pipes can hold what it
 * said last. One that has closed already is left be.
 *
 * A child that outlives the deadline is not left running: it is sent
 * `SIGKILL` and its `close` is awaited for at most `KILL_DEADLINE_MS`, so it
 * no longer holds its port, its connections or the IPC channel that keeps
 * the test process open. The failure is the missed stop either way - the
 * kill only cleans up after it. A stop that was `SIGKILL` already is not
 * followed by a second one: the miss is thrown at once, so the stop lasts
 * `deadlineMs` at most, and any other stop `deadlineMs + KILL_DEADLINE_MS`.
 */
export async function stopped(
  child: StoppableChild,
  limits: StopLimits,
): Promise<void> {
  if (hasClosed(child)) {
    return;
  }
  const closed = new Promise<void>((resolve) => {
    child.on("close", () => {
      resolve();
    });
  });
  if (child.exitCode !== null || child.signalCode !== null) {
    await within(
      closed,
      limits.deadlineMs,
      `the close of ${limits.name}, which had ended`,
    );
    return;
  }
  const signal = limits.signal ?? "SIGTERM";
  child.kill(signal);
  try {
    await within(
      closed,
      limits.deadlineMs,
      `the stop of ${limits.name} by ${signal}`,
    );
  } catch (missed) {
    if (signal !== "SIGKILL") {
      child.kill("SIGKILL");
      await within(
        closed,
        KILL_DEADLINE_MS,
        `the kill of ${limits.name}`,
      ).catch(() => undefined);
    }
    throw missed;
  }
}

/**
 * Kills a child after a failure and waits for its close, for at most
 * `KILL_DEADLINE_MS`: a child left running would keep its connections, and
 * its IPC channel would keep the test process open. The failure explains the
 * red; a kill that fails on top of it must not replace it, so its own failure
 * is dropped - the caller throws the one it has.
 */
export async function killed(
  child: StoppableChild,
  name: string,
): Promise<void> {
  await stopped(child, {
    deadlineMs: KILL_DEADLINE_MS,
    name,
    signal: "SIGKILL",
  }).catch(() => undefined);
}

/**
 * The end of a child (`ended`, from `endOf`), for at most `deadlineMs`. A
 * child that misses it is `killed` before the miss is thrown, so the whole
 * wait lasts `deadlineMs + KILL_DEADLINE_MS` at most. An `ended` rejected
 * with an `error` of the child does not lead to `killed`: its error is thrown
 * at once, with no signal and no wait for a `close`. Of the errors of a live
 * child Node raises two - a failed `kill` (the process is gone already) and a
 * send with no callback (`signalled` always passes one) - so skipping
 * `killed` leaves no process behind.
 */
export async function endWithin(
  child: StoppableChild,
  ended: Promise<ChildRun>,
  deadlineMs: number,
  name: string,
): Promise<ChildRun> {
  let childFailed = false;
  try {
    return await within(
      ended.catch((err: unknown) => {
        childFailed = true;
        throw err;
      }),
      deadlineMs,
      `the end of ${name}`,
    );
  } catch (err) {
    if (!childFailed) {
      await killed(child, name);
    }
    throw err;
  }
}

/** A child spoken to over IPC: whether its channel is open, and a send. */
export interface MessagingChild {
  readonly connected: boolean;
  send(message: string, callback: (err: Error | null) => void): boolean;
}

/**
 * Asks the child to raise its signal itself (`"signal"` over IPC): a parent
 * cannot deliver one on Windows. A child whose channel has closed - it has
 * left already - is sent nothing. Any refusal of the send means the channel
 * has closed or is closing under it: its error goes to the callback, where it
 * is dropped, rather than to the `error` of the child. A signal that never
 * arrived shows as a missed end in `endWithin`, not as an error of the send.
 */
export function signalled(child: MessagingChild): Promise<void> {
  if (!child.connected) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    child.send("signal", () => {
      resolve();
    });
  });
}

/** A port nothing listens on right now. */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  if (address === null || typeof address === "string") {
    throw new Error("the port probe is not listening on a tcp port");
  }
  return address.port;
}
