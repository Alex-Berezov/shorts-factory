import { createRequire } from "node:module";
import { z } from "zod";
import { readRepoJson } from "./repo-files.js";

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

const RulesSchema = z.object({ gates: z.array(GateSchema) });

const ChoiceSchema = z.array(z.object({ run: z.boolean() }).passthrough());

/** A gate as rules.sf.json has it. */
export type Gate = z.infer<typeof GateSchema>;

/**
 * The gate `id` of rules.sf.json (or of `rules`, given); throws when there is
 * none. Call it inside a case, not on the collection of a file.
 */
export function gateOf(
  id: string,
  rules: unknown = readRepoJson(".claude/hooks/rules.sf.json"),
): Gate {
  const { gates } = RulesSchema.parse(rules);
  const gate = gates.find((one) => one.id === id);
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
