/**
 * The walk that keeps the password of a Redis command out of a line of the
 * log, wherever in the line the command sits.
 *
 * ioredis attaches the command it was running to the error it emits
 * (`err.command = { name, args }`), and a failed `auth` carries the password
 * in `args`. A path of pino's `redact` reaches one level per wildcard; a
 * caller may log the command under any key, inside an array, on a `cause`
 * that is a plain object, any number of levels down. This walk is not a list
 * of places: it looks at the shape (docs/DECISIONS.md, Р5 E0-12R).
 */

/** What a redacted value is written as - the word `redact` writes. */
const REDACTED = "[Redacted]";

/**
 * What a branch past `MAX_WALK_DEPTH` is written as. Not the branch itself:
 * the walk did not look into it, and a command down there would be written
 * with its password.
 */
const TRUNCATED = "[Truncated]";

/** What a value met again inside itself is written as - pino's word for it. */
const CIRCULAR = "[Circular]";

/** How many levels below the object of a line the walk goes. */
const MAX_WALK_DEPTH = 8;

/** A command of ioredis, the one shape the walk redacts. */
interface RedisCommand {
  name: string;
  args: unknown[];
}

export function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** A property of an object read by key, without assuming its type. */
export function field(source: object, key: string | symbol): unknown {
  return (source as Record<string | symbol, unknown>)[key];
}

/** Whether `value` is a command of ioredis: `{ name: string, args: [] }`. */
function isRedisCommand(value: unknown): value is RedisCommand {
  return (
    isObject(value) &&
    typeof field(value, "name") === "string" &&
    Array.isArray(field(value, "args"))
  );
}

/**
 * Whether the walk goes into every key of `value`: a plain object, an array
 * or an error - the shapes a line of the log is made of. Any other instance
 * (a stream, a socket, a `Buffer`, a `Date`, the request of Fastify) is not
 * entered; see `keysOf`.
 */
function isWalked(value: object): boolean {
  if (Array.isArray(value) || value instanceof Error) {
    return true;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The two keys of an instance of a class the walk looks at. */
const INSTANCE_KEYS = ["args", "command"] as const;

/**
 * The keys of `value` the walk looks at. An instance of a class is not
 * entered (docs/DECISIONS.md, Р5 E0-12R): of it only its own enumerable
 * `args`, when the instance is a command itself (the `Command` of ioredis is
 * a class), and its own enumerable `command` - a command hung on a `Job` or
 * on an error class of a library - are read, by name, and nothing else of it.
 * A command under any other field of such an instance is written by pino as
 * it is; that is the price of not walking every socket and every buffer a
 * line carries (docs/TECH_DEBT.md, 22.10.2026).
 */
function keysOf(value: object): readonly string[] {
  if (isWalked(value)) {
    return Object.keys(value);
  }
  return INSTANCE_KEYS.filter((key) =>
    Object.prototype.propertyIsEnumerable.call(value, key),
  );
}

/**
 * A copy of `source` that differs from it in what `changes` holds, with the
 * same prototype and the same descriptors otherwise - an error copied keeps
 * its class and the non-enumerable fields pino does not write anyway. The
 * changed keys are new descriptors of the copy, not a redefinition on it, so
 * a frozen source is copied the same way: the copy is a new object, and the
 * source keeps what it had.
 */
function copyWith(source: object, changes: Map<string, unknown>): object {
  if (Array.isArray(source)) {
    return source.map((item: unknown, index) =>
      changes.has(String(index)) ? changes.get(String(index)) : item,
    );
  }
  const descriptors: PropertyDescriptorMap =
    Object.getOwnPropertyDescriptors(source);
  for (const [key, value] of changes) {
    descriptors[key] = {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    };
  }
  const copy: object = Object.create(
    Object.getPrototypeOf(source),
    descriptors,
  );
  return copy;
}

/** What one walk over a line carries from value to value. */
interface RedactWalk {
  /**
   * What a value became, and at which depth: a value met again no deeper
   * than that is answered with it. Met again shallower, it is walked anew -
   * its first answer may be cut short by the depth it was met at. An answer
   * with a `[Circular]` in it is not kept: it names a value that was an
   * ancestor where it was walked, and need not be one where it is met again.
   */
  done: Map<object, { depth: number; result: unknown }>;
  /** The values being walked right now: one met again among them is a cycle. */
  active: Set<object>;
  /** How many times the walk has answered `[Circular]` so far. */
  circular: number;
}

/** `value` with every command in it redacted; see `redactCommandArgs`. */
function walk(
  value: unknown,
  depth: number,
  state: RedactWalk,
  skip: ReadonlySet<string>,
): unknown {
  if (!isObject(value)) {
    return value;
  }
  if (state.active.has(value)) {
    state.circular += 1;
    return CIRCULAR;
  }
  const keys = keysOf(value);
  if (keys.length === 0) {
    return value;
  }
  if (depth > MAX_WALK_DEPTH) {
    return TRUNCATED;
  }
  const known = state.done.get(value);
  if (known !== undefined && known.depth <= depth) {
    return known.result;
  }
  const circularBefore = state.circular;
  state.active.add(value);
  const command = isRedisCommand(value);
  const changes = new Map<string, unknown>();
  for (const key of keys) {
    if (skip.has(key)) {
      continue;
    }
    const current = field(value, key);
    const next =
      command && key === "args"
        ? REDACTED
        : walk(current, depth + 1, state, NOTHING_SKIPPED);
    if (next !== current) {
      changes.set(key, next);
    }
  }
  state.active.delete(value);
  const result = changes.size === 0 ? value : copyWith(value, changes);
  if (state.circular === circularBefore) {
    state.done.set(value, { depth, result });
  }
  return result;
}

const NOTHING_SKIPPED: ReadonlySet<string> = new Set();

/**
 * The object of a line with the `args` of every command of ioredis in it
 * replaced by `[Redacted]`; the `name` of a command stays.
 *
 * `skip` names the keys of the object itself that are left to a rule of
 * their own - a serializer - and are not walked.
 *
 * Copy on write: what the caller logged is never changed, and a branch with
 * no command in it is the very object it was. Only the enumerable own keys
 * of a plain object, an array or an error are walked - those are all pino
 * writes of an object that is not under a serializer; an instance of any
 * other class is not entered (`keysOf`). A value met again inside itself - a
 * cycle - is `[Circular]`, so that the copy cannot lead back to the original.
 * Past `MAX_WALK_DEPTH` levels a branch is `[Truncated]`, not the branch as
 * it was: the depth fails closed.
 */
export function redactCommandArgs(
  line: Record<string, unknown>,
  skip: ReadonlySet<string> = NOTHING_SKIPPED,
): Record<string, unknown> {
  // Most lines carry nothing but words and numbers: no state for them.
  if (!Object.values(line).some(isObject)) {
    return line;
  }
  const result = walk(
    line,
    0,
    { done: new Map(), active: new Set(), circular: 0 },
    skip,
  );
  return result as Record<string, unknown>;
}
