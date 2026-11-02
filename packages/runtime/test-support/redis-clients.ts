/**
 * The clients of a Redis as `CLIENT LIST` names them, for the integration
 * tests of the api and the worker that find a connection of their own among
 * them (ADR-0011, "test-support of the apps").
 */

/** A client of `CLIENT LIST`, by the fields the tests read. */
export interface ListedClient {
  id: number;
  db: string;
  /** What the client said it is (`CLIENT SETINFO LIB-NAME`); "" when it said nothing. */
  lib: string;
  /** The name the client gave itself (`CLIENT SETNAME`); "" when it has none. */
  name: string;
}

/**
 * `id`, `db`, `lib-name` and `name` of each client `CLIENT LIST` names. A
 * line without an `id` or a `db` it can read is thrown with the line: a
 * client that became `NaN` would fall out of every window of ids without a
 * word (L-028).
 */
export function clientsOf(list: string): ListedClient[] {
  return list
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const id = /(?:^|\s)id=(\d+)(?=\s|$)/.exec(line)?.[1];
      const db = /(?:^|\s)db=(\d+)(?=\s|$)/.exec(line)?.[1];
      if (id === undefined || db === undefined) {
        throw new Error(
          `CLIENT LIST gave a line without an id or a db to read: ${JSON.stringify(line)}`,
        );
      }
      return {
        id: Number(id),
        db,
        lib: /(?:^|\s)lib-name=(\S*)/.exec(line)?.[1] ?? "",
        name: /(?:^|\s)name=(\S*)/.exec(line)?.[1] ?? "",
      };
    });
}
