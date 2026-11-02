import { z } from "zod";
import {
  epicProblem,
  idProblem,
  missingDeps,
} from "../scripts/lib/tracker-task.mjs";
import { readRepoJson } from "./repo-files.js";

/**
 * The shape of docs/tasks/tasks.json for the tests of the root project, one
 * schema for every reader: `scripts/tasks.mjs` writes the file without one
 * (`tasks.mjs` loads the packages of the root for the commands that need
 * them, and zod is none of those), and a hand edit or a merge can still
 * leave a misspelt field, a status the CLI does not know, a duplicate id or
 * a dependency on a task that is not there - each of them passes the CLI and
 * breaks a reader later. The id, the epic and the dependencies are held to the rule `add`
 * holds them to (`scripts/lib/tracker-task.mjs`), so the CLI writes nothing
 * the schema refuses.
 */

/** The statuses of a task; the CLI has the same keys in `ICON`. */
export const STATUSES = ["todo", "in_progress", "blocked", "done"] as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const TaskSchema = z
  .object({
    id: z.string(),
    epic: z.string(),
    title: z
      .string()
      .refine((title) => title.trim() !== "" && !/[\r\n]/.test(title), {
        message: "title is empty or has a line break",
      }),
    estimate: z.string(),
    estimate_days: z.number().nullable(),
    deps: z.array(z.string()),
    doc: z.string().min(1),
    status: z.enum(STATUSES),
    started_at: z.string().regex(DAY).optional(),
    done_at: z.string().regex(DAY).optional(),
    added_at: z.string().regex(DAY).optional(),
    blocked_reason: z.string().min(1).optional(),
    note: z.string().optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    const id = idProblem(entry.id);
    if (id !== undefined) {
      context.addIssue({ code: "custom", path: ["id"], message: id });
      return;
    }
    const epic = epicProblem(entry.id, entry.epic);
    if (epic !== undefined) {
      context.addIssue({ code: "custom", path: ["epic"], message: epic });
    }
  });

/**
 * The tracker: tasks of the schema, ids unique, every dependency a task of
 * it, a blocked task with its reason and a done one with its day.
 */
export const TrackerSchema = z
  .array(TaskSchema)
  .superRefine((tasks, context) => {
    const ids = new Set<string>();
    for (const [index, entry] of tasks.entries()) {
      if (ids.has(entry.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `duplicate id ${entry.id}`,
        });
      }
      ids.add(entry.id);
    }
    for (const [index, entry] of tasks.entries()) {
      for (const dep of missingDeps(entry.deps, ids)) {
        context.addIssue({
          code: "custom",
          path: [index, "deps"],
          message: `${entry.id} depends on ${dep}, which is not in the tracker`,
        });
      }
      if (entry.status === "blocked" && entry.blocked_reason === undefined) {
        context.addIssue({
          code: "custom",
          path: [index, "blocked_reason"],
          message: `${entry.id} is blocked with no blocked_reason`,
        });
      }
      if (entry.status === "done" && entry.done_at === undefined) {
        context.addIssue({
          code: "custom",
          path: [index, "done_at"],
          message: `${entry.id} is done with no done_at`,
        });
      }
    }
  });

export type Task = z.infer<typeof TaskSchema>;

/**
 * A task that passes the schema, for the made-up trackers of the tests:
 * `E0-01` of docs/30_E0_TASKS.md, to do, titled `Task <id>`, with `over`
 * laid on it.
 */
export function taskEntry(over: Partial<Task> = {}): Task {
  const id = over.id ?? "E0-01";
  return {
    id,
    epic: "E0",
    title: `Task ${id}`,
    estimate: "1 д",
    estimate_days: 1,
    deps: [],
    doc: "30_E0_TASKS.md",
    status: "todo",
    ...over,
  };
}

/** docs/tasks/tasks.json of the repository, held to `TrackerSchema`. */
export function readTracker(): Task[] {
  return TrackerSchema.parse(readRepoJson("docs/tasks/tasks.json"));
}
