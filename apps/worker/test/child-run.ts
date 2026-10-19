import type { Readable } from "node:stream";

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
 */
export function endOf(
  child: ChildLike,
  output: () => string,
): Promise<ChildRun> {
  return new Promise<ChildRun>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, output: output() });
    });
  });
}

/**
 * Waits until the child sends `"started"` over IPC. A child that ends first
 * is the answer at once, with its code and the last `tailChars` of what it
 * said (read at `close`, for the reason `endOf` gives); a child that could not
 * be started (`error`) is the answer at once too, with that error as the
 * cause - neither waits for the whole deadline.
 */
export function startOf(
  child: ChildLike,
  output: () => string,
  limits: { deadlineMs: number; tailChars: number },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the worker never started; it said: ${output()}`));
    }, limits.deadlineMs);
    child.on("message", (message: unknown) => {
      if (message === "started") {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(`the worker could not be started: ${err.message}`, {
          cause: err,
        }),
      );
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `the worker exited before it started (code ${code}, signal ${signal}); it said: ${output().slice(-limits.tailChars)}`,
        ),
      );
    });
  });
}
