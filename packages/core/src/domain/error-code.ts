/**
 * The `code` an error carries, when it is a string: the SQLSTATE of a
 * Postgres error, the `ECONNREFUSED` of a socket. One reading for every
 * package - a number or a missing field is `undefined`, never a code.
 */
export function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) {
    return undefined;
  }
  const { code } = err;
  return typeof code === "string" ? code : undefined;
}
