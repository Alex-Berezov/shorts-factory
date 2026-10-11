import { type Logger, type LoggerOptions, pino } from "pino";

/**
 * A real pino logger whose lines a test can read - the one capture of the
 * api tests, in the shape of `apps/worker/test/recording-logger.ts`.
 *
 * Real, and not an object with `info`/`warn`/`error` on it, because that is
 * what the code takes: Fastify derives its request loggers from the instance
 * with `child()`, and a hand-written subset would not show what its
 * serializers do to a line. A test asserts on what came out - the parsed
 * entries for the fields, the raw text for what must not be anywhere in it.
 *
 * The levels stay numeric (`30`, `40`, `50`): that is what the service writes
 * (`buildLoggerOptions` keeps pino's default), and a test about the log of the
 * service reads the same line an operator does.
 */
export interface Recorder {
  log: Logger;
  /** The lines as written, one JSON document each. */
  lines: string[];
  /** Every line, parsed. */
  entries(): Record<string, unknown>[];
  /** Everything written, as one string. */
  raw(): string;
  /** Forgets what was written so far; the next case starts from nothing. */
  clear(): void;
}

/**
 * A recorder at `trace`, or on the options the caller passes - the service's
 * own (`buildLoggerOptions` without its transport) when a case is about what
 * the service's logger does to a line.
 */
export function recordingLogger(
  options: LoggerOptions = { level: "trace" },
): Recorder {
  const lines: string[] = [];
  const log = pino(options, {
    write: (line: string): void => {
      lines.push(line);
    },
  });
  return {
    log,
    lines,
    entries: () =>
      lines.map((line): Record<string, unknown> => JSON.parse(line)),
    raw: () => lines.join(""),
    clear: () => {
      lines.length = 0;
    },
  };
}
