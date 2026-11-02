import { createRequire } from "node:module";
import { z } from "zod";
import { readRules } from "./repo-files.js";

/**
 * A gate of .claude/hooks/rules.sf.json and whether the hook chooses it on a
 * change of a file, for the tests that hold the `when` of a gate to the files
 * its script reads (L-018). The choice is asked of `selectGates` of
 * .claude/hooks/gates.js - the function that chooses the gates - so no
 * reading of the syntax of `when` lives in a test (B4, E0-12K).
 */

/**
 * Only what the choice reads: a case that needs more of a gate (`cmd`,
 * `timeoutSec`) parses it there, so a gate of another shape fails that case,
 * not every file that asks for a gate.
 */
const GateSchema = z.object({ id: z.string(), when: z.string() }).passthrough();

const ChoiceSchema = z.array(z.object({ run: z.boolean() }).passthrough());

/** A gate as rules.sf.json has it. */
export type Gate = z.infer<typeof GateSchema>;

/**
 * The gate `id` among `gates` - by default the gates of rules.sf.json, as
 * `readRules` of test/repo-files.ts reads the file; throws when there is
 * none. Call it inside a case, not on the collection of a file.
 */
export function gateOf(
  id: string,
  gates: readonly unknown[] = readRules().gates,
): Gate {
  const gate = z
    .array(GateSchema)
    .parse(gates)
    .find((one) => one.id === id);
  if (gate === undefined) throw new Error(`no ${id} gate`);
  return gate;
}

/** `selectGates` of gates.js, a CommonJS module of the hooks. */
function selectGates(): (...args: unknown[]) => unknown {
  const hooks: unknown = createRequire(import.meta.url)(
    "../.claude/hooks/gates.js",
  );
  if (
    typeof hooks !== "object" ||
    hooks === null ||
    !("selectGates" in hooks) ||
    typeof hooks.selectGates !== "function"
  ) {
    throw new Error(".claude/hooks/gates.js exports no selectGates");
  }
  const select = hooks.selectGates;
  return (...args) => Reflect.apply(select, undefined, args);
}

/** Whether gates.js chooses `gate` on a change of `file` alone. */
export function chosenOn(gate: Gate, file: string): boolean {
  const choices = ChoiceSchema.parse(selectGates()([gate], [file], null));
  return choices[0]?.run === true;
}
