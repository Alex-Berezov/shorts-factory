import { type Logger, pino } from "pino";

/**
 * A real pino logger whose lines a test can read.
 *
 * Real, and not an object with `info`/`warn`/`error` on it, because that is
 * what the code takes: the modules of this app log through `pino.Logger`, and
 * a hand-written subset would let a `child()` or a `fatal()` go unnoticed
 * until it runs. What a test asserts is what came out - the level, the message
 * and the fields - which is also what an operator sees.
 */
export interface LoggedLine {
  level: string;
  msg: string;
  [field: string]: unknown;
}

export interface Recorder {
  log: Logger;
  lines: LoggedLine[];
  /** The messages of one level, in order; the usual thing a case asserts. */
  levels(): string[];
}

export function recordingLogger(): Recorder {
  const lines: LoggedLine[] = [];
  const log = pino(
    {
      level: "trace",
      // Levels by name: `50` in an assertion says nothing to the next reader.
      formatters: { level: (label: string) => ({ level: label }) },
    },
    {
      write: (line: string) => {
        lines.push(JSON.parse(line) as LoggedLine);
      },
    },
  );
  return { log, lines, levels: () => lines.map((line) => line.level) };
}

/** A logger that writes nothing, for the cases that assert something else. */
export function silentLogger(): Logger {
  return pino({ level: "silent" });
}
