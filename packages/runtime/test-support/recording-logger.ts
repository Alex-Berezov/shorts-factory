import { type Logger, type LoggerOptions, pino } from "pino";

/**
 * A real pino logger whose lines a test can read - the one capture of the
 * tests of the api, the worker and this package.
 *
 * Real, and not an object with `info`/`warn`/`error` on it, because that is
 * what the code takes: Fastify derives its request loggers from the instance
 * with `child()`, the modules of the worker log through `pino.Logger`, and a
 * hand-written subset would neither show what the serializers do to a line
 * nor let a `child()` or a `fatal()` go noticed until it runs. A test asserts
 * on what came out - the parsed lines for the fields, the raw text for what
 * must not be anywhere in it.
 */
export interface LoggedLine {
  /** By name: `50` in an assertion says nothing to the next reader. */
  level: string;
  msg: string;
  [field: string]: unknown;
}

export interface Recorder {
  log: Logger;
  /** Every line written so far, parsed; emptied by `clear`. */
  lines: LoggedLine[];
  /** The levels of the lines, in order; the usual thing a case asserts. */
  levels(): string[];
  /** A copy of the lines as they are now, for a case that keeps them. */
  entries(): LoggedLine[];
  /** Everything written, as one string. */
  raw(): string;
  /** Forgets what was written so far; the next case starts from nothing. */
  clear(): void;
}

/**
 * A recorder at `trace`, or on the options the caller passes - the service's
 * own (`buildLoggerOptions` without its transport) when a case is about what
 * the service's logger does to a line. The level is written by name either
 * way; everything else about the line is what those options make of it.
 */
export function recordingLogger(
  options: LoggerOptions = { level: "trace" },
): Recorder {
  const lines: LoggedLine[] = [];
  const written: string[] = [];
  const log = pino(
    {
      ...options,
      formatters: {
        ...options.formatters,
        level: (label: string) => ({ level: label }),
      },
    },
    {
      write: (line: string): void => {
        written.push(line);
        lines.push(JSON.parse(line) as LoggedLine);
      },
    },
  );
  return {
    log,
    lines,
    levels: () => lines.map((line) => line.level),
    entries: () => [...lines],
    raw: () => written.join(""),
    clear: () => {
      lines.length = 0;
      written.length = 0;
    },
  };
}

/** A logger that writes nothing, for the cases that assert something else. */
export function silentLogger(): Logger {
  return pino({ level: "silent" });
}
