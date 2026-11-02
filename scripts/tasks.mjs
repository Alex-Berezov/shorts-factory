#!/usr/bin/env node
/**
 * Task tracker CLI — single source of truth is docs/tasks/tasks.json.
 * Renders docs/00_STATUS.md (human + agent dashboard) after every mutation.
 * `next`, `list` and `show` run on Node alone, before `pnpm install`. Every
 * other command reads the section of a task or writes the links of
 * docs/00_STATUS.md, both made by scripts/lib/tracker-doc.mjs with packages
 * of the root (markdown-it, github-slugger, gemoji): it loads that module
 * when it runs, and without the packages it says so and writes nothing.
 *
 *   node scripts/tasks.mjs next [n]            what to take next (deps satisfied)
 *   node scripts/tasks.mjs start <id>          mark in_progress
 *   node scripts/tasks.mjs done <id> [note]    mark done, append worklog, re-render
 *   node scripts/tasks.mjs block <id> <reason> mark blocked
 *   node scripts/tasks.mjs unblock <id>        back to todo
 *   node scripts/tasks.mjs todo <id>           reset to todo
 *   node scripts/tasks.mjs show <id>           task details
 *   node scripts/tasks.mjs list [epic]         table of tasks
 *   node scripts/tasks.mjs render              regenerate docs/00_STATUS.md only
 *   node scripts/tasks.mjs add <id> "<title>"  new task [--epic E?] [--est "1 д"] [--deps a,b] [--doc f.md]
 *   node scripts/tasks.mjs set <id> [--title "<title>"] [--doc f.md] [--deps a,b] [--est "1 д"]
 *                                              change the title, the document, the
 *                                              dependencies or the estimate of a task
 *
 * `--doc` is a path from docs/ (`TECH_DEBT.md`, not `docs/TECH_DEBT.md`) and
 * must name a file there; `render --check` holds every task to the same.
 * A `--doc` other than 00_STATUS.md also needs the section `### <id>. <title>`
 * in it, whose anchor is the link of docs/00_STATUS.md. `add` takes an id
 * `E<n>-<n>[A-Z...]` or `ADHOC-<yyyymmdd>-<n>`, the epic that goes with it
 * (`--epic` in any case, and only the one the id gives) and `--deps` of the
 * tracker only (scripts/lib/tracker-task.mjs); `set` refuses values the task
 * already has (deps in another order are the same), `--doc 00_STATUS.md` for
 * a task that is not of the owner, and `--deps` that name a task not in the
 * tracker or make a cycle, the task itself in them too (`--deps ""` clears
 * them). `add` and `set` take an `--est` of one line, no `|` in it.
 *
 *   node scripts/tasks.mjs --root=<dir> <command> ...
 *                                              the same on the tracker, docs/ and journal
 *                                              under <dir> (the tests of the CLI run on a copy)
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { codeOf } from "./lib/files.mjs";
import { repoRoot } from "./lib/paths.mjs";
import {
  ADHOC,
  epicOf,
  epicProblem,
  idProblem,
  missingDeps,
} from "./lib/tracker-task.mjs";

/**
 * `--root=<dir>` as the first argument: the tree whose `docs/` the CLI reads
 * and writes - the repository unless a test points it at a copy, so that a
 * case which writes, or a regression that writes where it should refuse,
 * never touches the tracker of the repository. Given anywhere else - or as
 * `--root <dir>` - it is refused before anything is read: taken as an
 * ordinary argument it would be ignored, and the command would run on the
 * tracker of the repository.
 */
const ROOT_FLAG = "--root=";
const argv = process.argv.slice(2);
const rootArg = argv[0]?.startsWith(ROOT_FLAG) ? argv.shift() : undefined;
const strayRoot = argv.find(
  (arg) => arg === "--root" || arg.startsWith(ROOT_FLAG),
);
if (strayRoot !== undefined || rootArg === ROOT_FLAG) {
  console.error(
    `error: ${strayRoot ?? rootArg} - give the tree as --root=<dir>, once, before the command`,
  );
  process.exit(1);
}
const root =
  rootArg === undefined ? repoRoot : resolve(rootArg.slice(ROOT_FLAG.length));

const TASKS_PATH = resolve(root, "docs/tasks/tasks.json");
const STATUS_PATH = resolve(root, "docs/00_STATUS.md");
const WORKLOG_PATH = resolve(root, "docs/90_WORKLOG.md");
const DOCS_DIR = resolve(root, "docs");

/** Implementation order of epics (from docs/20_TZ_HIGH_LEVEL.md, "Сводка декомпозиции"). */
const EPIC_ORDER = [
  "E0",
  "E12",
  "E1",
  "E2",
  "E3",
  "E4",
  "E5",
  "E6",
  "E7",
  "E8",
  "E9",
  "E10",
  "E11",
  "E13",
  ADHOC,
];
/** @type {Record<string, string>} */
const EPIC_NAMES = {
  E0: "Каркас проекта и инфраструктура",
  E1: "Source Radar",
  E2: "Video Intelligence / Content DNA",
  E3: "Idea Inbox",
  E4: "Research Agent",
  E5: "Script Engine",
  E6: "Production Package",
  E7: "Analytics Warehouse",
  E8: "Experiment Engine",
  E9: "Localization Layer",
  E10: "Voice Factory",
  E11: "Publishing Layer",
  E12: "Импорт ручной фазы (Phase 0)",
  E13: "Dashboard shell и /system",
  [ADHOC]: "Задачи владельца",
};
/**
 * @typedef {"todo" | "in_progress" | "blocked" | "done"} Status
 */
/**
 * One task of docs/tasks/tasks.json. The optional fields a command clears
 * are set to `undefined`, which `JSON.stringify` leaves out.
 *
 * @typedef {object} Task
 * @property {string} id
 * @property {string} epic
 * @property {string} title
 * @property {string} estimate
 * @property {number | null} [estimate_days]
 * @property {string[]} deps
 * @property {string} doc
 * @property {Status} status
 * @property {string | undefined} [started_at]
 * @property {string | undefined} [done_at]
 * @property {string | undefined} [blocked_reason]
 * @property {string} [note]
 * @property {string} [added_at]
 */
/** @type {Record<Status, string>} */
const ICON = { todo: "⬜", in_progress: "🔄", blocked: "⛔", done: "✅" };
const STATUSES = Object.keys(ICON);
/** Every command of the `switch` below, in the order of the usage above. */
const COMMANDS = [
  "next",
  "start",
  "done",
  "block",
  "unblock",
  "todo",
  "show",
  "list",
  "render",
  "add",
  "set",
];
/**
 * The commands that read no document of a task and write no status: they do
 * not load scripts/lib/tracker-doc.mjs, so they run before `pnpm install`.
 */
const ON_NODE_ALONE = ["next", "list", "show"];

// ---------- io ----------
/** @returns {Task[]} */
const load = () => JSON.parse(readFileSync(TASKS_PATH, "utf8"));
/** @param {Task[]} tasks */
const save = (tasks) =>
  writeFileSync(TASKS_PATH, `${JSON.stringify(tasks, null, 2)}\n`, "utf8");
const today = () => new Date().toISOString().slice(0, 10);
/** @type {(msg: string) => never} */
const die = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};
/** @param {string} e */
const epicIdx = (e) => {
  const i = EPIC_ORDER.indexOf(e);
  return i === -1 ? 99 : i;
};
/** @type {(a: Task, b: Task) => number} */
const byOrder = (a, b) =>
  epicIdx(a.epic) - epicIdx(b.epic) ||
  a.id.localeCompare(b.id, "en", { numeric: true });

// ---------- queries ----------
/** @type {(tasks: Task[], id: string) => Task} */
const find = (tasks, id) =>
  tasks.find((t) => t.id === id.toUpperCase()) ?? die(`unknown task ${id}`);
/** @type {(tasks: Task[], t: Task) => boolean} */
const depsDone = (tasks, t) =>
  t.deps.every((d) => tasks.find((x) => x.id === d)?.status === "done");
/** @type {(tasks: Task[]) => Task[]} */
const available = (tasks) =>
  tasks.filter((t) => t.status === "todo" && depsDone(tasks, t)).sort(byOrder);
/** @type {(tasks: Task[], t: Task) => string[]} */
const pendingDeps = (tasks, t) =>
  t.deps.filter((d) => tasks.find((x) => x.id === d)?.status !== "done");

// ---------- the document of a task ----------
/**
 * Why scripts/lib/tracker-doc.mjs did not load, from the message of the
 * `ERR_MODULE_NOT_FOUND` of Node, with what to do: a package of the root
 * (a bare specifier, `Cannot find package 'gemoji'`) is installed by
 * `pnpm install`; a file that is not there is one of the scripts of the
 * tracker, or of a package installed only in part, and is named from the
 * root - an absolute path says where the checkout is and nothing more.
 *
 * @param {string} command
 * @param {string} message
 * @returns {string}
 */
function notLoaded(command, message) {
  const alone = `${ON_NODE_ALONE.join(", ")} run without them`;
  const missing = /^Cannot find (?:package|module) '([^']+)'/.exec(
    message,
  )?.[1];
  // A bare specifier is a package; Node names a file of a package installed
  // in part (its `main` gone) "package" too, by its absolute path.
  if (missing !== undefined && !isAbsolute(missing)) {
    return `${command} needs the package ${missing} of the root, which is not installed: run pnpm install; ${alone}`;
  }
  const named = missing === undefined ? undefined : relative(repoRoot, missing);
  const where =
    named === undefined || named.startsWith("..") || isAbsolute(named)
      ? "a module it imports"
      : named.split(sep).join("/");
  if (where.split("/").includes("node_modules")) {
    return `${command} needs the packages of the root, and ${where} of one is not there: run pnpm install; ${alone}`;
  }
  return `${command} cannot load scripts/lib/tracker-doc.mjs: ${where} is not there, and the scripts of the tracker need it - restore it from git`;
}

/**
 * scripts/lib/tracker-doc.mjs, loaded only by a command that needs it: its
 * packages are those of the root, and a module that is not there is refused
 * with what to do (`notLoaded`), not thrown.
 *
 * @param {string} command
 * @returns {Promise<typeof import("./lib/tracker-doc.mjs")>}
 */
async function importTrackerDoc(command) {
  try {
    return await import("./lib/tracker-doc.mjs");
  } catch (error) {
    if (codeOf(error) !== "ERR_MODULE_NOT_FOUND") throw error;
    const [message = ""] = String(
      error instanceof Error ? error.message : error,
    ).split("\n");
    return die(notLoaded(command, message));
  }
}

const [cmd = "next", ...args] = argv;
/** @type {typeof import("./lib/tracker-doc.mjs") | undefined} */
const loadedTrackerDoc =
  COMMANDS.includes(cmd) && !ON_NODE_ALONE.includes(cmd)
    ? await importTrackerDoc(cmd)
    : undefined;
/**
 * The module of the document of a task. A command of `ON_NODE_ALONE` that
 * asks for it is a mistake of this script, not of the tracker.
 */
const trackerDoc = () =>
  loadedTrackerDoc ??
  die(
    `${cmd} is one of ${ON_NODE_ALONE.join(", ")}, which do not load scripts/lib/tracker-doc.mjs`,
  );

// ---------- markdown helpers ----------
/** @type {(t: Task) => string} */
const link = (t) => `[${t.id}](${t.doc}#${trackerDoc().slug(t.id, t.title)})`;
/** @type {(done: number, total: number, width?: number) => string} */
const bar = (done, total, width = 20) => {
  const filled = total ? Math.round((done / total) * width) : 0;
  return `\`${"█".repeat(filled)}${"░".repeat(width - filled)}\` ${done}/${total}`;
};
/** @type {(list: Task[]) => number} */
const days = (list) => list.reduce((s, t) => s + (t.estimate_days ?? 0), 0);
/** @type {(n: number) => string} */
const fmtDays = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
/** @type {(s: unknown) => string} */
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|");

// ---------- render ----------
/**
 * Writes docs/00_STATUS.md from the tasks; with `check`, only compares.
 *
 * @param {Task[]} tasks
 * @param {{ check?: boolean }} [opts]
 */
function render(tasks, opts = {}) {
  const doneT = tasks.filter((t) => t.status === "done");
  const inProg = tasks.filter((t) => t.status === "in_progress").sort(byOrder);
  const blocked = tasks.filter((t) => t.status === "blocked").sort(byOrder);
  const next = available(tasks).slice(0, 5);
  const epics = EPIC_ORDER.filter((e) => tasks.some((t) => t.epic === e));
  const currentEpic =
    epics.find((e) => tasks.some((t) => t.epic === e && t.status !== "done")) ??
    null;

  const L = [];
  L.push("# Статус проекта — где мы сейчас");
  L.push("");
  L.push(
    `_Сгенерировано \`node scripts/tasks.mjs render\` ${today()}. **Не редактировать руками** — источник: \`docs/tasks/tasks.json\`. Спецификация задач — в документах \`docs/3x_Ex_TASKS.md\`; журнал — \`docs/90_WORKLOG.md\`._`,
  );
  L.push("");
  L.push("## Сводка");
  L.push("");
  L.push(
    `- **Прогресс:** ${bar(doneT.length, tasks.length, 30)} задач, ${fmtDays(days(doneT))} / ${fmtDays(days(tasks))} оценочных дней.`,
  );
  L.push(
    `- **Текущий эпик:** ${currentEpic ? `${currentEpic} — ${EPIC_NAMES[currentEpic]}` : "все эпики завершены 🎉"}`,
  );
  L.push(
    `- **В работе:** ${inProg.length ? inProg.map((t) => `${link(t)} ${t.title}`).join("; ") : "ничего — возьмите задачу из «Следующие»"}`,
  );
  L.push(
    `- **Заблокировано:** ${blocked.length ? blocked.map((t) => `${link(t)} (${t.blocked_reason ?? "?"})`).join("; ") : "нет"}`,
  );
  L.push("");
  L.push("## Сейчас в работе");
  L.push("");
  if (inProg.length) {
    L.push("| Задача | Название | Оценка | Начата |");
    L.push("|---|---|---|---|");
    for (const t of inProg)
      L.push(
        `| ${link(t)} | ${cell(t.title)} | ${cell(t.estimate)} | ${t.started_at ?? ""} |`,
      );
  } else L.push("_Нет задач в работе._");
  L.push("");
  L.push("## Следующие (зависимости выполнены, в порядке приоритета)");
  L.push("");
  const [first] = next;
  if (first !== undefined) {
    L.push("| Задача | Название | Оценка | Эпик |");
    L.push("|---|---|---|---|");
    for (const t of next)
      L.push(
        `| ${link(t)} | ${cell(t.title)} | ${cell(t.estimate)} | ${t.epic} |`,
      );
    L.push("");
    L.push(`Взять в работу: \`node scripts/tasks.mjs start ${first.id}\``);
  } else
    L.push("_Нет доступных задач: всё либо сделано, либо ждёт зависимостей._");
  L.push("");
  if (blocked.length) {
    L.push("## Заблокировано");
    L.push("");
    L.push("| Задача | Название | Причина |");
    L.push("|---|---|---|");
    for (const t of blocked)
      L.push(`| ${link(t)} | ${cell(t.title)} | ${cell(t.blocked_reason)} |`);
    L.push("");
  }
  L.push("## Прогресс по эпикам");
  L.push("");
  L.push("| | Эпик | Задачи | Дни (сделано / всего) | Документ |");
  L.push("|---|---|---|---|---|");
  for (const e of epics) {
    const all = tasks.filter((t) => t.epic === e);
    const d = all.filter((t) => t.status === "done");
    // Every epic listed has a task, so `doc` is that of its first one.
    const doc = all[0]?.doc ?? "";
    const st =
      d.length === all.length
        ? "✅"
        : all.some((t) => t.status !== "todo")
          ? "🔄"
          : "⬜";
    L.push(
      `| ${st} | **${e}** ${EPIC_NAMES[e]} | ${bar(d.length, all.length, 12)} | ${fmtDays(days(d))} / ${fmtDays(days(all))} | [${doc}](${doc}) |`,
    );
  }
  L.push("");
  L.push(
    "Легенда статусов: ⬜ не начато · 🔄 в работе / эпик начат · ⛔ заблокировано · ✅ сделано.",
  );
  L.push("");
  L.push("## Все задачи");
  L.push("");
  for (const e of epics) {
    const all = tasks.filter((t) => t.epic === e).sort(byOrder);
    L.push(`### ${e}. ${EPIC_NAMES[e]}`);
    L.push("");
    L.push("| | Задача | Название | Оценка | Зависимости | Начата | Готова |");
    L.push("|---|---|---|---|---|---|---|");
    for (const t of all) {
      const deps = t.deps.length
        ? t.deps
            .map(
              (d) =>
                `${ICON[tasks.find((x) => x.id === d)?.status ?? "todo"]}${d}`,
            )
            .join(" ")
        : "—";
      L.push(
        `| ${ICON[t.status]} | ${link(t)} | ${cell(t.title)} | ${cell(t.estimate)} | ${deps} | ${t.started_at ?? ""} | ${t.done_at ?? ""} |`,
      );
    }
    L.push("");
  }
  L.push("## Как пользоваться");
  L.push("");
  L.push("```bash");
  L.push("node scripts/tasks.mjs next          # что брать следующим");
  L.push("node scripts/tasks.mjs start E0-01   # взять в работу");
  L.push(
    'node scripts/tasks.mjs done E0-01 "коротко что сделано"   # закрыть (+ запись в WORKLOG, перерисовка статуса)',
  );
  L.push(
    'node scripts/tasks.mjs block E0-05 "ждём ключ Gemini"     # заблокировать',
  );
  L.push("node scripts/tasks.mjs show E0-01    # детали и зависимости");
  L.push("```");
  L.push("");
  const out = `${L.join("\n")}\n`;
  if (opts.check) {
    // --check: is docs/00_STATUS.md in sync with tasks.json? The generation-date line is ignored.
    /** @type {(t: string) => string} */
    const strip = (t) =>
      t
        .split("\n")
        .filter((l) => !l.startsWith("_Сгенерировано"))
        .join("\n");
    let cur = "";
    try {
      cur = readFileSync(STATUS_PATH, "utf8");
    } catch {
      cur = "";
    }
    const broken = trackerDoc().badDocs(tasks, DOCS_DIR);
    if (broken.length) {
      console.error(
        [
          "docs/tasks/tasks.json names documents that are not there:",
          ...broken.map((line) => `  ${line}`),
          "fix with `node scripts/tasks.mjs set <id> --doc <file in docs/>`",
        ].join("\n"),
      );
      process.exit(1);
    }
    const misplaced = trackerDoc().badSections(tasks, DOCS_DIR);
    if (misplaced.length) {
      console.error(
        [
          "docs/tasks/tasks.json names tasks whose section is not where docs/00_STATUS.md links:",
          ...misplaced.map((line) => `  ${line}`),
          "each line ends with the fix: the title of the section to give, or the section to write",
        ].join("\n"),
      );
      process.exit(1);
    }
    if (strip(cur) !== strip(out)) {
      console.error(
        "docs/00_STATUS.md is stale: run `node scripts/tasks.mjs render`",
      );
      process.exit(1);
    }
    console.log("tracker: docs/00_STATUS.md is in sync with tasks.json");
    return;
  }
  writeFileSync(STATUS_PATH, out, "utf8");
}

/** @param {string} line */
function worklog(line) {
  if (!existsSync(WORKLOG_PATH))
    writeFileSync(
      WORKLOG_PATH,
      "# Журнал работ\n\n_Добавляется автоматически командой `tasks.mjs done`. Новые записи — сверху не гарантируется: читать снизу вверх._\n\n",
      "utf8",
    );
  appendFileSync(WORKLOG_PATH, `${line}\n`, "utf8");
}

// ---------- commands ----------
const tasks = load();
/**
 * A word shaped as a flag (`--doc`, `--epc`): a value or an argument that is
 * one is a flag given where a value was due. A value that only starts with
 * `--` (`--- draft`) is not one.
 * @type {(value: string) => boolean}
 */
const isFlag = (value) => /^--[a-z][a-z-]*$/.test(value);
/** @type {(name: string) => string | undefined} */
const opt = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || isFlag(value)) {
    die(`${name} needs a value`);
  }
  return value;
};
/**
 * A positional argument is not a flag: `add E0-1 --epic E0` would take
 * `--epic` for the title.
 * @type {(value: string | undefined, what: string) => string}
 */
const positional = (value, what) => {
  if (value === undefined) return die(`${what} required`);
  if (isFlag(value)) die(`${what} required, got the flag ${value}`);
  return value;
};
/**
 * The section `### <id>. <title>` the doc of a task must hold: the check of
 * `render --check`, made before anything is written; the reason names the
 * fix `command` can make.
 * @type {(task: Task, command: "add" | "set") => void}
 */
const checkSection = (task, command) => {
  const problem = trackerDoc().sectionProblem(task, DOCS_DIR, command);
  if (problem !== undefined) die(problem);
};
/** @type {(doc: string) => void} */
const checkDoc = (doc) => {
  const problem = trackerDoc().docProblem(doc, DOCS_DIR);
  if (problem !== undefined) die(problem);
};
/**
 * A value a row of docs/00_STATUS.md and a line of the journal take as it is
 * is one line with text in it; `what` names it in the refusal.
 * @type {(value: string, what: string) => void}
 */
const checkLine = (value, what) => {
  if (value.trim() === "") die(`${what} is empty`);
  if (/[\r\n]/.test(value)) {
    die(
      `${what} has a line break: a row of docs/00_STATUS.md and a line of the journal take it on one line`,
    );
  }
};
/** @type {(title: string) => void} */
const checkTitle = (title) => checkLine(title, "title");
/**
 * An estimate is one line, as a title is: the cell of docs/00_STATUS.md
 * escapes a `|` in either. One rule for `add` and `set`.
 * @type {(estimate: string) => void}
 */
const checkEstimate = (estimate) => checkLine(estimate, "--est");
/**
 * The estimate as given (`1 д`, `0.5-1 д`) and the days the status sums: the
 * largest number in it, none for an estimate without one (`?`). One rule for
 * `add` and `set`.
 * @type {(estimate: string) => { estimate: string, estimate_days: number | null }}
 */
const estimateOf = (estimate) => {
  const nums = [...estimate.matchAll(/\d+(?:\.\d+)?/g)].map((m) =>
    Number(m[0]),
  );
  return { estimate, estimate_days: nums.length ? Math.max(...nums) : null };
};
/**
 * The ids of `--deps a,b`, upper case, each once, in the order given; `""`
 * is none.
 * @type {(value: string) => string[]}
 */
const depsOf = (value) => [
  ...new Set(
    value
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  ),
];
/**
 * Whether two lists of deps name the same tasks: the order is no change.
 * @type {(a: readonly string[], b: readonly string[]) => boolean}
 */
const sameDeps = (a, b) =>
  new Set(a).size === new Set(b).size && a.every((id) => b.includes(id));
/** @type {(deps: string[]) => void} */
const checkDeps = (deps) => {
  const missing = missingDeps(deps, new Set(tasks.map((t) => t.id)));
  if (missing.length) {
    die(
      `--deps names tasks that are not in the tracker: ${missing.join(", ")}`,
    );
  }
};
/**
 * A cycle of the deps of the tracker with `task` as it would be that runs
 * through `task`, the ids along it and the first again at the end
 * (`E0-01 → E0-02 → E0-01`); `[]` for none. A task of a cycle waits for
 * itself: `next` never offers it, and nothing says why. The walk starts at
 * `task` and goes along deps from it; a cycle of others that it reaches (the
 * tracker had it, a merge) is not its cycle and refuses nothing. A task
 * depending on itself is a cycle of one.
 * @type {(task: Task) => string[]}
 */
const cycleWith = (task) => {
  /** @type {Map<string, readonly string[]>} */
  const deps = new Map(tasks.map((t) => [t.id, t.deps]));
  deps.set(task.id, task.deps);
  /** @type {Set<string>} */
  const done = new Set();
  /** @type {string[]} */
  const path = [];
  /** @type {(id: string) => string[]} */
  const walk = (id) => {
    if (done.has(id)) return [];
    const at = path.indexOf(id);
    if (at !== -1) return at === 0 ? [...path, id] : [];
    path.push(id);
    for (const dep of deps.get(id) ?? []) {
      const cycle = walk(dep);
      if (cycle.length) return cycle;
    }
    path.pop();
    done.add(id);
    return [];
  };
  return walk(task.id);
};
/** @type {(task: Task) => void} */
const checkCycle = (task) => {
  const cycle = cycleWith(task);
  if (cycle.length) {
    die(
      `--deps makes a cycle of dependencies, ${cycle.join(" → ")}: no task of it can start`,
    );
  }
};

switch (cmd) {
  case "render":
    if (args.includes("--check")) {
      render(tasks, { check: true });
      break;
    }
    render(tasks);
    console.log(`rendered ${STATUS_PATH}`);
    break;

  case "next": {
    const n = Number(args[0] ?? 5);
    const inProg = tasks.filter((t) => t.status === "in_progress");
    if (inProg.length) {
      console.log("In progress:");
      for (const t of inProg)
        console.log(
          `  🔄 ${t.id}  ${t.title}  (${t.estimate})  → docs/${t.doc}`,
        );
    }
    const av = available(tasks).slice(0, n);
    console.log(
      av.length ? "Next available (deps done):" : "Nothing available.",
    );
    for (const t of av)
      console.log(`  ⬜ ${t.id}  ${t.title}  (${t.estimate})  → docs/${t.doc}`);
    break;
  }

  case "list": {
    const epic = args[0]?.toUpperCase();
    const rows = tasks.filter((t) => !epic || t.epic === epic).sort(byOrder);
    for (const t of rows)
      console.log(
        `${ICON[t.status]} ${t.id.padEnd(7)} ${t.title}  (${t.estimate})`,
      );
    const d = rows.filter((t) => t.status === "done").length;
    console.log(`\n${d}/${rows.length} done`);
    break;
  }

  case "show": {
    const t = find(tasks, args[0] ?? die("task id required"));
    console.log(JSON.stringify(t, null, 2));
    const pend = pendingDeps(tasks, t);
    console.log(
      pend.length ? `pending deps: ${pend.join(", ")}` : "all deps done",
    );
    break;
  }

  case "start": {
    const t = find(tasks, args[0] ?? die("task id required"));
    const pend = pendingDeps(tasks, t);
    if (pend.length && !args.includes("--force"))
      die(`deps not done: ${pend.join(", ")} (use --force to override)`);
    if (t.status === "done") die(`${t.id} already done`);
    t.status = "in_progress";
    t.started_at ??= today();
    t.blocked_reason = undefined;
    save(tasks);
    render(tasks);
    // A task of the default document has no section: its title is the spec.
    console.log(
      t.doc === trackerDoc().DEFAULT_DOC
        ? `🔄 ${t.id} started — spec: the title, no section of its own`
        : `🔄 ${t.id} started — spec: docs/${t.doc} (### ${t.id})`,
    );
    break;
  }

  case "done": {
    const t = find(tasks, args[0] ?? die("task id required"));
    const note = args.slice(1).join(" ").trim();
    t.status = "done";
    t.started_at ??= today();
    t.done_at = today();
    if (note) t.note = note;
    t.blocked_reason = undefined;
    save(tasks);
    worklog(
      `- ${today()} ✅ **${t.id}** ${t.title}${note ? ` — ${note}` : ""}`,
    );
    render(tasks);
    const nxt = available(tasks).slice(0, 3);
    console.log(`✅ ${t.id} done.`);
    if (nxt.length) console.log(`next: ${nxt.map((x) => x.id).join(", ")}`);
    break;
  }

  case "block": {
    const t = find(tasks, args[0] ?? die("task id required"));
    const reason = args.slice(1).join(" ").trim() || die("reason required");
    t.status = "blocked";
    t.blocked_reason = reason;
    save(tasks);
    worklog(`- ${today()} ⛔ **${t.id}** blocked — ${reason}`);
    render(tasks);
    console.log(`⛔ ${t.id} blocked: ${reason}`);
    break;
  }

  case "add": {
    // add <id> "<title>" [--epic E?] [--est "1 д"] [--deps E0-01,E0-02] [--doc file.md]
    const id = positional(args[0], "task id").toUpperCase();
    const title = positional(args[1], "title");
    checkTitle(title);
    const doc = opt("--doc") ?? trackerDoc().DEFAULT_DOC;
    // Before anything else: a doc the readers cannot open is refused even
    // for a task that turns out to exist.
    checkDoc(doc);
    if (tasks.some((t) => t.id === id)) die(`${id} already exists`);
    const epic = opt("--epic")?.toUpperCase() ?? epicOf(id);
    const est = opt("--est");
    if (est !== undefined) checkEstimate(est);
    /** @type {Task} */
    const added = {
      id,
      epic,
      title,
      ...estimateOf(est ?? "?"),
      deps: depsOf(opt("--deps") ?? ""),
      doc,
      status: "todo",
      added_at: today(),
    };
    // What the schema of the tests refuses is refused here, by the same
    // rule, before it is written.
    const idWrong = idProblem(id) ?? epicProblem(id, epic);
    if (idWrong !== undefined) die(idWrong);
    checkDeps(added.deps);
    checkCycle(added);
    // The section is written before the task: the tracker never names one
    // that is not there.
    checkSection(added, "add");
    tasks.push(added);
    save(tasks);
    worklog(`- ${today()} ➕ **${id}** ${title} (добавлена в трекер)`);
    render(tasks);
    console.log(`➕ ${id} added (epic ${epic})`);
    break;
  }

  case "set": {
    // set <id> [--title "..."] [--doc file.md] [--deps a,b] [--est "1 д"]
    const title = opt("--title");
    const doc = opt("--doc");
    const depsArg = opt("--deps");
    const deps = depsArg === undefined ? undefined : depsOf(depsArg);
    const est = opt("--est");
    if (
      title === undefined &&
      doc === undefined &&
      deps === undefined &&
      est === undefined
    )
      die("nothing to set: give --title, --doc, --deps and/or --est");
    if (title !== undefined) checkTitle(title);
    if (est !== undefined) checkEstimate(est);
    // The values first, the task second: a bad value is refused whatever
    // the id.
    if (doc !== undefined) checkDoc(doc);
    if (deps !== undefined) checkDeps(deps);
    const t = find(tasks, positional(args[0], "task id"));
    const { DEFAULT_DOC } = trackerDoc();
    // The default document holds no section: a task of an epic sent there
    // would only drop the check of its section.
    if (doc === DEFAULT_DOC && epicOf(t.id) !== ADHOC) {
      die(
        `--doc ${DEFAULT_DOC} is for a task of the owner (ADHOC-<yyyymmdd>-<n>) only: ${t.id} keeps a document with its section`,
      );
    }
    if (deps !== undefined) checkCycle({ ...t, deps });
    // A value the task already has is no change: the journal records only
    // what the tracker no longer holds. Deps are a set: another order is
    // none.
    const newTitle = title !== t.title ? title : undefined;
    const newDoc = doc !== t.doc ? doc : undefined;
    const newDeps =
      deps !== undefined && !sameDeps(deps, t.deps) ? deps : undefined;
    const newEst = est !== t.estimate ? est : undefined;
    if (
      newTitle === undefined &&
      newDoc === undefined &&
      newDeps === undefined &&
      newEst === undefined
    ) {
      die(`nothing to change: ${t.id} already has the values given`);
    }
    // The task as it would be: refused here, nothing is written. A doc it
    // keeps is held to a file first - one gone from disk is named, not thrown.
    const candidate = { ...t, title: title ?? t.title, doc: doc ?? t.doc };
    if (doc === undefined) checkDoc(t.doc);
    checkSection(candidate, "set");
    /** @type {string[]} */
    const changed = [];
    if (newTitle !== undefined) {
      changed.push(`заголовок «${t.title}» → «${newTitle}»`);
      t.title = newTitle;
    }
    if (newDoc !== undefined) {
      changed.push(`doc docs/${t.doc} → docs/${newDoc}`);
      t.doc = newDoc;
    }
    if (newDeps !== undefined) {
      changed.push(
        `зависимости «${t.deps.join(", ") || "—"}» → «${newDeps.join(", ") || "—"}»`,
      );
      t.deps = newDeps;
    }
    if (newEst !== undefined) {
      changed.push(`оценка «${t.estimate}» → «${newEst}»`);
      Object.assign(t, estimateOf(newEst));
    }
    save(tasks);
    worklog(
      `- ${today()} ✎ **${t.id}** ${t.title} (изменена в трекере: ${changed.join(", ")})`,
    );
    render(tasks);
    console.log(`✎ ${t.id}: ${t.title} → docs/${t.doc}`);
    break;
  }

  case "unblock":
  case "todo": {
    const t = find(tasks, args[0] ?? die("task id required"));
    t.status = "todo";
    t.blocked_reason = undefined;
    if (cmd === "todo") {
      t.started_at = undefined;
      t.done_at = undefined;
    }
    save(tasks);
    render(tasks);
    console.log(`⬜ ${t.id} → todo`);
    break;
  }

  default:
    die(
      `unknown command ${cmd}. Valid: ${COMMANDS.join(", ")}; statuses: ${STATUSES.join(", ")}`,
    );
}
