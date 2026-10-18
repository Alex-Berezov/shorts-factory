/**
 * The part of the pino logger the code of this package writes to: the Redis
 * clients, the `Queue` factory and the stop take this one shape, so that a
 * caller hands each of them the same logger and a test the same recorder.
 * Narrower than `Logger` on purpose - a structured line at four levels is all
 * any of them writes.
 */
export interface RuntimeLogger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}
