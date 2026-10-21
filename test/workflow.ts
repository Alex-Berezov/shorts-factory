import { z } from "zod";
import { parseRepoYaml, readRepoFile } from "./repo-files.js";

/**
 * The workflow of CI (`.github/workflows/ci.yml`) as the tests of the root
 * project read it: parsed fail-closed (decision R2 of E0-12N) - an error or a
 * warning of the parser, a second document, or a key of the shape below in
 * another shape (`on`, `jobs`, `steps` not a map or a list) throws rather than
 * leaving a part of the file unread - and its expressions evaluated for an
 * event the way Actions does. What CI must keep is `test/ci-config.test.ts`.
 */

let text: string | undefined;

/**
 * The text of ci.yml, read on the first case that asks rather than when a
 * file of tests is collected: a file that cannot be read is then a red case
 * with its reason.
 */
export function ciWorkflowText(): string {
  text ??= readRepoFile(".github/workflows/ci.yml").replace(/\r\n/g, "\n");
  return text;
}

/** The keys of a step the tests read; the others are kept. */
const StepSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    uses: z.string().optional(),
    run: z.string().optional(),
    if: z.union([z.string(), z.boolean()]).optional(),
    with: z.record(z.unknown()).optional(),
    env: z.record(z.unknown()).optional(),
    "working-directory": z.string().optional(),
    "timeout-minutes": z.number().optional(),
  })
  .passthrough();
export type Step = z.infer<typeof StepSchema>;

const ServiceSchema = z
  .object({
    image: z.string(),
    env: z.record(z.unknown()).optional(),
    ports: z.array(z.string()).optional(),
    options: z.string().optional(),
  })
  .passthrough();

const JobSchema = z
  .object({
    if: z.union([z.string(), z.boolean()]).optional(),
    "timeout-minutes": z.number().optional(),
    services: z.record(ServiceSchema).optional(),
    strategy: z
      .object({ matrix: z.record(z.unknown()).optional() })
      .passthrough()
      .optional(),
    env: z.record(z.unknown()).optional(),
    steps: z.array(StepSchema),
  })
  .passthrough();

/**
 * The workflow by the keys the tests read. `on` is a map of events: the list
 * form (`on: [push]`) is a workflow Actions takes, but not one these rules
 * were written for, so it is refused rather than read as having no event.
 */
const WorkflowSchema = z
  .object({
    on: z.record(z.unknown()),
    permissions: z.unknown(),
    concurrency: z
      .object({
        group: z.string(),
        "cancel-in-progress": z.union([z.string(), z.boolean()]),
      })
      .passthrough()
      .optional(),
    env: z.record(z.unknown()).optional(),
    jobs: z.record(JobSchema),
  })
  .passthrough();
export type Workflow = z.infer<typeof WorkflowSchema>;

/** A text of ci.yml, parsed; a shape the rules do not know throws with the path of the key. */
export function parseWorkflow(text: string): Workflow {
  const parsed = WorkflowSchema.safeParse(parseRepoYaml(text, "ci.yml"));
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(
      `ci.yml has a shape the rules do not read: ${issues.join("; ")}`,
    );
  }
  return parsed.data;
}

/** A job of a text of ci.yml. */
export function jobIn(text: string, name: string): z.infer<typeof JobSchema> {
  const job = parseWorkflow(text).jobs[name];
  if (job === undefined) throw new Error(`ci.yml has no job ${name}`);
  return job;
}

/** The steps of a job of `text`, in order. */
export const stepsIn = (text: string, job: string): Step[] =>
  jobIn(text, job).steps;

export interface Event {
  name: "push" | "pull_request";
  number: number | null;
  sha: string;
}

export type Value = string | number | boolean | null;

/** Truthiness of a value of an expression of Actions. */
function truthy(value: Value): boolean {
  return !(
    value === null ||
    value === false ||
    value === "" ||
    value === 0 ||
    Number.isNaN(value)
  );
}

/** A value as a number, the way Actions coerces the sides of a comparison. */
function numberOf(value: Value): number {
  if (value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  return value.trim() === "" ? 0 : Number(value);
}

/** `==` of Actions: strings without their case, other types as numbers. */
function equal(left: Value, right: Value): boolean {
  if (typeof left === "string" && typeof right === "string") {
    return left.toLowerCase() === right.toLowerCase();
  }
  if (typeof left === typeof right && typeof left !== "string") {
    return left === right;
  }
  return numberOf(left) === numberOf(right);
}

/** The tokens of an expression: literals, contexts, operators and brackets. */
const TOKEN =
  /\s*(?:('(?:[^']|'')*')|(-?\d+(?:\.\d+)?)|([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)|(==|!=|&&|\|\||\(|\)))/y;

/**
 * Evaluates an expression of the workflow for one event: the operators the
 * workflow uses (`==`, `!=`, `&&`, `||`, brackets) on string and number
 * literals, `null`, `true`, `false` and the contexts of `Event`, with the
 * semantics of Actions (`&&`/`||` give a side, not a boolean). Any other
 * token, a context the table does not have and a malformed expression
 * throw; a context the event does not have is null, as in Actions.
 */
export function evaluateOne(expression: string, event: Event): Value {
  const contexts: Record<string, Value> = {
    "github.event_name": event.name,
    "github.event.pull_request.number": event.number,
    "github.sha": event.sha,
  };
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < expression.length) {
    if (/^\s*$/.test(expression.slice(TOKEN.lastIndex))) break;
    const at = TOKEN.lastIndex;
    const match = TOKEN.exec(expression);
    if (match === null) {
      throw new Error(`unknown token at "${expression.slice(at)}"`);
    }
    tokens.push(match[0].trim());
  }
  let position = 0;
  const peek = (): string | undefined => tokens[position];
  const take = (): string => {
    const token = tokens[position];
    if (token === undefined) throw new Error(`"${expression}" ends early`);
    position += 1;
    return token;
  };
  const primary = (): Value => {
    const token = take();
    if (token === "(") {
      const value = or();
      if (take() !== ")")
        throw new Error(`"${expression}": no closing bracket`);
      return value;
    }
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (/^-?\d/.test(token)) return Number(token);
    if (token === "null") return null;
    if (token === "true") return true;
    if (token === "false") return false;
    if (/^[A-Za-z_]/.test(token)) {
      if (!Object.hasOwn(contexts, token)) {
        throw new Error(`unknown context ${token}`);
      }
      return contexts[token] ?? null;
    }
    throw new Error(`"${expression}": unexpected ${token}`);
  };
  const comparison = (): Value => {
    const left = primary();
    const operator = peek();
    if (operator !== "==" && operator !== "!=") return left;
    take();
    const same = equal(left, primary());
    return operator === "==" ? same : !same;
  };
  const and = (): Value => {
    let value = comparison();
    while (peek() === "&&") {
      take();
      const right = comparison();
      value = truthy(value) ? right : value;
    }
    return value;
  };
  const or = (): Value => {
    let value = and();
    while (peek() === "||") {
      take();
      const right = and();
      value = truthy(value) ? value : right;
    }
    return value;
  };
  const value = or();
  if (position !== tokens.length) {
    throw new Error(`"${expression}": unexpected ${tokens[position]}`);
  }
  return value;
}

/**
 * A value of the workflow for one event: a lone `${{ }}` - the whole value,
 * with no `}}` inside - keeps the type of its result; a string with several
 * (`${{ a }}-${{ b }}`) or with text around one is formatted like Actions
 * does (null as an empty string).
 */
export function evaluate(value: string, event: Event): Value {
  const lone = /^\$\{\{\s*((?:(?!\}\}).)*?)\s*\}\}$/.exec(value);
  if (lone?.[1] !== undefined) return evaluateOne(lone[1], event);
  return value.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression: string) =>
    String(evaluateOne(expression, event) ?? ""),
  );
}

/** A push of the commit `sha`. */
export const push = (sha: string): Event => ({
  name: "push",
  number: null,
  sha,
});

/** A pull request `number` at the commit `sha`. */
export const pullRequest = (number: number, sha: string): Event => ({
  name: "pull_request",
  number,
  sha,
});
