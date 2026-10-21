#!/usr/bin/env node
'use strict';
/**
 * harness-selftest.js - самопроверка обвязки. Запускается руками, гейтом `harness-selftest`
 * (rules.sf.json: .claude/**, файлы проекта, которые читают пробы гейтов build и test:int,
 * и пути из note гейтов compose и tracker, которых нет в when и cmd самого гейта; перечень -
 * glob гейта) и установщиком install.ps1.
 *
 * Зачем: у обвязки нет ни типов, ни тестов, а сломанный хук ничего не запрещает - его отказ
 * неотличим от разрешения. Поэтому здесь не только синтаксис и разбор правил, но и живые пробы
 * замков: каждый обязан показать отказ на нарушении И пропуск на чистом входе. Проба только
 * на отказ ничего не доказывает (сторож, отвергающий всё, её пройдёт), проба только на пропуск -
 * тем более.
 *
 * Рекомендательные хуки (answer-length, remind-format) ничего не запрещают, код выхода у них
 * всегда 0. Их доказывают две стороны пробы: замечание записано / отдано на нарушении
 * и тишина (нет записи, нет вывода) на чистом входе.
 *
 * Код выхода 1, если красна хоть одна строка. Последняя строка вывода - счёт.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const L = require('./lib.js');

const HOOKS = __dirname;
const CLAUDE = path.resolve(HOOKS, '..');
const ROOT = path.resolve(CLAUDE, '..');

const ALLOWED_MODELS = new Set(['opus', 'sonnet', 'haiku', 'fable', 'inherit']);
const HOOK_FILES = [
  'lib.js', 'diff-hash.js', 'standards.js', 'commit-gate.js',
  'answer-length.js', 'report-honesty.js', 'remind-format.js',
  'gates.js', 'selftest-graph.js',
];

const results = [];
function ok(name, note) { results.push({ ok: true, name, note }); }
function fail(name, note) { results.push({ ok: false, name, note }); }
/**
 * Результат пробы, которая не гонялась: её отказ уже назван своей красной строкой. Его отдаёт
 * только graphGate.guard, и только когда строка «граф turbo: dry-JSON настоящего дерева» красная.
 */
const SKIPPED = Symbol('skipped');
function check(name, fn) {
  try {
    const r = fn();
    if (r === SKIPPED) return;
    if (r === false) fail(name, '');
    else if (typeof r === 'string') fail(name, r);
    else ok(name, typeof r === 'object' && r && r.note ? r.note : '');
  } catch (e) {
    fail(name, (e && e.message) || String(e));
  }
}

function run(cmd, args, opts) {
  return cp.spawnSync(cmd, args, Object.assign({ encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, opts || {}));
}

/**
 * Модуль графа selftest-graph.js грузится только после пробы синтаксиса (`node --check`), как
 * gates.js - после пробы require (gatesModuleSafe): синтаксическая ошибка или исключение при
 * загрузке модуля - одна красная строка и итог сразу (код 1), а не стек вместо отчёта. Без
 * модуля пробы гейтов build, test:int и harness-selftest не построить, поэтому прогон кончается.
 */
const G = loadGraphModule();
function loadGraphModule() {
  const file = path.join(HOOKS, 'selftest-graph.js');
  const name = 'selftest-graph.js загружается (node --check до require)';
  const r = run(process.execPath, ['--check', file]);
  if (r.status !== 0) {
    fail(name, String(r.stderr || (r.error && r.error.message) || 'код ' + r.status).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 3).join(' | '));
    report();
  }
  try {
    return require(file);
  } catch (e) {
    fail(name, 'require: ' + ((e && e.message) || String(e)));
    return report();
  }
}

/*
 * Состояние проб - во временной папке на весь прогон (SF_HOOK_STATE_DIR, читает только
 * lib.js:statePath()). Переменная ставится и этому процессу - сюда смотрят L.statePath()
 * в пробах, - и каждому хуку в probe(). Боевой путь считается без переопределения извне;
 * его байты (или null, если файла нет) снимаются до первой пробы, и последняя проба
 * сравнивает их с текущими. Папка убирается на выходе процесса, в том числе по Ctrl+C.
 */
delete process.env.SF_HOOK_STATE_DIR;
const LIVE_STATE = path.resolve(L.statePath());
function liveBytes() {
  try {
    return fs.readFileSync(LIVE_STATE);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}
const LIVE_BYTES = liveBytes();
/**
 * Снимок рабочего дерева до первой пробы: последняя проба сверяет с ним текущий. Файлы проб
 * живут во временных папках (withScratchTree), и любая разница - проба, которая пишет мимо них
 * или не убрала за собой. В снимке три вещи (E0-12D, B8 круга 1):
 *   - каждая запись git status (новый, изменённый, удалённый файл) с отпечатком содержимого:
 *     перезапись файла, который уже был `M` или `??`, меняет отпечаток, а не строку status;
 *   - игнорируемые записи (`!!`, по одной на каталог - node_modules/, .turbo/): новый файл
 *     под .gitignore status без --ignored не показывает;
 *   - ничего больше: новый файл внутри уже игнорируемого каталога снимок не видит (TECH_DEBT, E0-12T).
 * Правка руками или другой процесс в то же время даёт ту же красную строку - тогда перезапуск.
 * root - корень рабочего дерева (по умолчанию репозиторий; проба сверки берёт временный).
 * Возвращает Map<запись, отпечаток>; сбой git - исключение (его ловит проба, не верхний уровень).
 */
function repoSnapshot(root = ROOT) {
  const status = (extra) => {
    // core.fsmonitor=false: глобальный fsmonitor - внешняя команда, status её бы исполнил.
    const r = run('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z'].concat(extra), { cwd: root });
    if (r.error || r.status !== 0) throw new Error('git status: ' + String((r.error && r.error.message) || r.stderr || 'код ' + r.status).slice(0, 160));
    return String(r.stdout).split('\0');
  };
  const crypto = require('crypto');
  const fingerprint = (rel) => {
    try {
      const abs = path.join(root, rel);
      return fs.statSync(abs).isFile() ? crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex') : 'не файл';
    } catch (e) {
      if (e && e.code === 'ENOENT') return 'нет на диске';
      throw e;
    }
  };
  const snap = new Map();
  const tracked = status(['--untracked-files=all']);
  for (let i = 0; i < tracked.length; i++) {
    const e = tracked[i];
    if (!e) continue;
    const xy = e.slice(0, 2);
    const rel = e.slice(3);
    // у переименования и копии за записью идёт прежний путь отдельным полем -z
    if (/[RC]/.test(xy)) i++;
    snap.set(xy + ' ' + rel, fingerprint(rel));
  }
  for (const e of status(['--ignored=traditional', '--untracked-files=normal'])) {
    if (e.startsWith('!! ')) snap.set(e, '');
  }
  return snap;
}
/** Разница двух снимков repoSnapshot строками «появилось / изменилось содержимое / пропало <запись>». */
function treeDiff(before, now) {
  const diff = [];
  for (const [entry, print] of now) {
    if (!before.has(entry)) diff.push('появилось ' + entry);
    else if (before.get(entry) !== print) diff.push('изменилось содержимое ' + entry);
  }
  for (const entry of before.keys()) if (!now.has(entry)) diff.push('пропало ' + entry);
  return diff;
}
let LIVE_TREE = null;
let LIVE_TREE_ERROR = '';
try {
  LIVE_TREE = repoSnapshot();
} catch (e) {
  LIVE_TREE_ERROR = (e && e.message) || String(e);
}
const PROBE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-selftest-state-'));
process.env.SF_HOOK_STATE_DIR = PROBE_STATE_DIR;
process.on('exit', () => fs.rmSync(PROBE_STATE_DIR, { recursive: true, force: true }));
process.on('SIGINT', () => process.exit(130));

/**
 * Запуск хука с JSON на stdin (hooksDir - каталог хуков, по умолчанию боевой; extraEnv -
 * добавка к окружению). Возвращает { code, out, err }.
 */
function probe(hook, input, cwd, hooksDir, extraEnv) {
  const env = Object.assign({}, process.env, { SF_HOOK_STATE_DIR: PROBE_STATE_DIR }, extraEnv || {});
  const r = run(process.execPath, [path.join(hooksDir || HOOKS, hook)], { input: JSON.stringify(input), cwd: cwd || ROOT, env });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

/** Строка, которую L.guard пишет в stderr при CLAUDE_HOOK_DEBUG, поймав исключение хука. */
const HOOK_ERROR = 'hook error:';

/**
 * Пробы standards.js не пишут в боевые src (E0-12D, TECH_DEBT: прерванный прогон оставлял
 * zz_selftest_* под git add -A). Дерево пробы - временная папка с копией .claude/hooks
 * (*.js и *.json байт в байт, repos.json тот же: репозиторий sf - корень копии) и файлами
 * пробы по их путям от корня репозитория, так что glob правил и rules.sf.json те же, что
 * у боевого хука. Папка убирается в finally, в том числе после красной строки.
 *   tree.write(rel, body) - пишет файл пробы и отдаёт абсолютный путь;
 *   tree.standards(rel)   - запуск копии standards.js на этом файле ({ code, out, err }).
 * Хук идёт с CLAUDE_HOOK_DEBUG: исключение внутри L.guard без failClosed даёт код 0 и пустой
 * stdout - ровно как пропуск, - и отличить их можно только по строке HOOK_ERROR в stderr.
 */
function withScratchTree(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-selftest-tree-'));
  try {
    const hooks = path.join(dir, '.claude', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    for (const f of fs.readdirSync(HOOKS)) {
      if (/\.(?:js|json)$/.test(f)) fs.copyFileSync(path.join(HOOKS, f), path.join(hooks, f));
    }
    const abs = (rel) => path.join(dir, ...rel.split('/'));
    return fn({
      write: (rel, body) => {
        fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
        fs.writeFileSync(abs(rel), body);
        return abs(rel);
      },
      standards: (rel) => probe('standards.js', { tool_input: { file_path: abs(rel) } }, dir, hooks, { CLAUDE_HOOK_DEBUG: '1' }),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function frontmatter(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

// ------------------------------------------------------------------ 1. синтаксис хуков
for (const f of HOOK_FILES) {
  check('синтаксис ' + f, () => {
    const p = path.join(HOOKS, f);
    if (!fs.existsSync(p)) return 'файла нет';
    const r = run(process.execPath, ['--check', p]);
    return r.status === 0 ? true : String(r.stderr).split('\n')[0];
  });
}

// ------------------------------------------------------------------ 2. правила и репозитории
let common = null;
let repoRules = null;
check('repos.json разбирается и путь существует', () => {
  const j = readJson(path.join(HOOKS, 'repos.json'));
  if (!Array.isArray(j.repos) || !j.repos.length) return 'нет списка repos';
  for (const r of j.repos) {
    const p = path.resolve(HOOKS, r.path);
    if (!fs.existsSync(path.join(p, '.git'))) return r.name + ': по пути ' + p + ' нет .git';
  }
  return { note: j.repos.map((r) => r.name).join(', ') };
});
check('rules.common.json разбирается', () => { common = readJson(path.join(HOOKS, 'rules.common.json')); return true; });
check('rules.sf.json разбирается', () => { repoRules = readJson(path.join(HOOKS, 'rules.sf.json')); return true; });

function compileAll(list, label) {
  let n = 0;
  for (const st of list || []) {
    for (const key of ['pattern', 'skipIf', 'absentInFile', 'nearby']) {
      if (typeof st[key] === 'string') { new RegExp(st[key], st.flags || ''); n++; }
    }
  }
  return { note: label + ': ' + n + ' регулярок' };
}
check('регулярки standards компилируются', () => compileAll([].concat((common && common.standards) || [], (repoRules && repoRules.standards) || []), 'standards'));
check('регулярки commitGate.weakenings компилируются', () => compileAll((common && common.commitGate && common.commitGate.weakenings) || [], 'weakenings'));
check('глобы правил компилируются', () => {
  const globs = [].concat(
    (common && common.commitGate && common.commitGate.forbiddenPaths) || [],
    (common && common.afterReviewAllowed) || [],
  );
  for (const st of (repoRules && repoRules.standards) || []) globs.push.apply(globs, st.files || []);
  for (const g of globs) L.matchGlob(g, 'x/y.ts');
  return { note: globs.length + ' глобов' };
});
check('у каждого гейта есть id, cmd и when', () => {
  const gates = (repoRules && repoRules.gates) || [];
  if (!gates.length) return 'гейтов нет';
  for (const g of gates) {
    if (!g.id || !g.cmd) return 'гейт без id или cmd';
    const w = String(g.when || 'always');
    if (!(w === 'always' || w === 'never' || w.startsWith('glob:'))) return g.id + ': непонятный when ' + w;
  }
  return { note: gates.map((g) => g.id).join(', ') };
});
/**
 * gates.js - модуль для проб и скрипт для человека: main() под require.main === module.
 * Проба грузит его require в отдельном процессе, где всё, что main() сделал бы при загрузке,
 * безопасно и видно: argv - полный прогон (без --list), список изменённых файлов подменён
 * (L.allChanged - один репозиторий с одним гейтом always), каждый запуск child_process
 * (spawn, spawnSync, exec, execSync, execFile, execFileSync, fork - с shell и без) подменён
 * счётчиком с пустым ответом, process.exit - записью кода. Без стража main() дошёл бы до
 * конца: «прогнал» бы гейт, поставил бы отметку lastGates (markGates - только после
 * настоящего полного прогона, поэтому --list её не проверял бы) и вызвал бы process.exit.
 * Ждём код 0, пустой stderr, в stdout ровно строку итога пробы, ноль запусков, ни одного
 * process.exit и ни одной отметки в состоянии пробы (своя временная папка,
 * SF_HOOK_STATE_DIR). Каждое - своя причина отказа. Положительный контроль: настоящий
 * markGates из diff-hash.js в другой временной папке с тем же SF_HOOK_STATE_DIR ставит
 * отметку, и та же проверка состояния её видит - иначе проба смотрела бы не туда и молчала.
 * Пока проба не зелёная, gateProbe не грузит gates.js в этот процесс: без стража require
 * отсюда прогнал бы все гейты.
 */
const CHILD_PROCESS_LAUNCHERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
/** Отметка lastGates в состоянии хуков, записанном в dir (SF_HOOK_STATE_DIR). */
function lastGatesIn(dir) {
  const st = path.join(dir, '.qa-state');
  return fs.existsSync(st) && Boolean(JSON.parse(fs.readFileSync(st, 'utf8')).lastGates);
}
let gatesModuleSafe = false;
check('gates.js: require не запускает гейты, не пишет отметку и не выходит из процесса', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-selftest-require-'));
  const control = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-selftest-mark-'));
  const file = path.join(HOOKS, 'gates.js');
  try {
    const mark = run(process.execPath, ['-e', 'require(' + JSON.stringify(path.join(HOOKS, 'diff-hash.js')) + ').markGates(0);'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { SF_HOOK_STATE_DIR: control }),
    });
    if (mark.status !== 0 || !lastGatesIn(control)) {
      return 'проверка состояния не видит отметку настоящего markGates (код ' + mark.status + ' ' + String(mark.stderr || '').slice(0, 120) + ') - проба ниже смотрела бы не туда';
    }
    const code = [
      "const cp = require('child_process');",
      "const { EventEmitter } = require('events');",
      'const launched = {};',
      'for (const name of ' + JSON.stringify(CHILD_PROCESS_LAUNCHERS) + ') {',
      '  cp[name] = function () {',
      '    launched[name] = (launched[name] || 0) + 1;',
      "    if (name === 'spawnSync') return { pid: 0, output: [null, '', ''], stdout: '', stderr: '', status: 0, signal: null };",
      "    if (name.endsWith('Sync')) return '';",
      '    const child = new EventEmitter();',
      '    child.stdout = new EventEmitter();',
      '    child.stderr = new EventEmitter();',
      '    child.kill = () => true;',
      '    return child;',
      '  };',
      '}',
      'const L = require(' + JSON.stringify(path.join(HOOKS, 'lib.js')) + ');',
      "L.allChanged = () => [{ repo: { name: 'probe', path: process.cwd() }, rules: { gates: [{ id: 'probe', cmd: 'probe', when: 'always' }] }, files: ['probe.txt'] }];",
      'let exited = null;',
      'const exit = process.exit;',
      'process.exit = (c) => { exited = c === undefined ? 0 : c; };',
      'process.argv = [process.execPath, ' + JSON.stringify(file) + '];',
      'const g = require(' + JSON.stringify(file) + ');',
      'process.exit = exit;',
      "process.stdout.write('probe ' + JSON.stringify({ launched, exited, selectGates: typeof g.selectGates }));",
    ].join('\n');
    const env = Object.assign({}, process.env, { SF_HOOK_STATE_DIR: dir });
    const r = run(process.execPath, ['-e', code], { cwd: ROOT, env });
    const out = String(r.stdout || '');
    if (r.status !== 0) return 'require gates.js: код ' + r.status + ' ' + String(r.stderr || out).slice(0, 160);
    const m = /(?:^|\n)probe (\{.*\})$/.exec(out);
    if (!m) return 'require gates.js не дошёл до итога пробы: ' + JSON.stringify(out.slice(0, 160));
    const seen = JSON.parse(m[1]);
    const why = [];
    if (out !== 'probe ' + m[1]) why.push('main() печатал при загрузке: ' + JSON.stringify(out.slice(0, 80)));
    const calls = Object.keys(seen.launched).map((name) => name + ' x' + seen.launched[name]);
    if (calls.length) why.push('запуски child_process: ' + calls.join(', '));
    if (seen.exited !== null) why.push('вызван process.exit(' + seen.exited + ')');
    if (lastGatesIn(dir)) why.push('поставлена отметка lastGates');
    if (seen.selectGates !== 'function') why.push('selectGates не экспортирован: ' + seen.selectGates);
    if (String(r.stderr || '')) why.push('stderr: ' + String(r.stderr).slice(0, 120));
    if (why.length) return 'require gates.js: ' + why.join('; ');
    gatesModuleSafe = true;
    return true;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(control, { recursive: true, force: true });
  }
});

/**
 * Выбирает ли selectGates из самого gates.js (экспорт модуля, а не повтор функции, L-008:
 * правка обработки when там обязана краснеть здесь) гейт gate на одном изменённом файле file
 * при полном прогоне (без --only). Вызов selectGates в пробах - только здесь: gateProbe и
 * пробы отказа на изменённом when зовут selects. gates.js не прошёл пробу require выше -
 * исключение (красная строка check).
 */
function selects(gate, file) {
  if (!gatesModuleSafe) throw new Error('gates.js не прошёл пробу require - selectGates не загружается');
  const { selectGates } = require('./gates.js');
  if (typeof selectGates !== 'function') throw new Error('gates.js не экспортирует функцию selectGates');
  const picked = selectGates([gate], [file], null);
  return Boolean(picked && picked[0] && picked[0].run);
}

/**
 * Гейт id из rules.sf.json и runs(file) - selects на нём. Нет гейта - исключение (красная
 * строка check).
 */
const gateProbes = new Map();
function gateProbe(id) {
  if (gateProbes.has(id)) return gateProbes.get(id);
  const gate = ((repoRules && repoRules.gates) || []).find((g) => g.id === id);
  if (!gate) throw new Error('гейта ' + id + ' нет в правилах');
  const runs = (file) => selects(gate, file);
  const res = { gate, runs };
  gateProbes.set(id, res);
  return res;
}

/** Пути файлов, названные в note гейта; шаблоны с * и каталоги (`scripts/lib/**`) - нет. */
function notePaths(gate) {
  const note = String(gate.note || '');
  const named = note.match(/(?<![\w./*-])(?:test|scripts|apps|packages|infra|docs)\/[\w./-]*\.(?:ts|mjs|js|json|ya?ml|md)\b/g) || [];
  return [...new Set(named)];
}

/** Гейты, чьи пути из note сверяются с диском (notePathsOnDisk). */
const NOTE_CHECKED_GATES = ['compose', 'tracker'];

/**
 * Боевые формы роута: пробы S13/S14 читают эти файлы как пропуск, поэтому каждый из них
 * выбирает гейт harness-selftest (сверка - в его пробе выбора ниже).
 */
const ROUTE_FORMS = ['apps/api/src/routes/health/index.ts', 'apps/api/src/routes/system/index.ts'];

/**
 * Пути файлов, названные в note гейта (`test/x.test.ts`, `scripts/x.mjs`, ...), есть на
 * диске: note - то, что читает человек о гейте, и опечатка в нём переживала бы
 * selftest (L-021). Шаблоны с * и каталоги (`scripts/lib/**`) не сверяются.
 */
function notePathsOnDisk(gate) {
  const files = notePaths(gate);
  if (!files.length) return 'в note гейта ' + gate.id + ' не найдено ни одного пути файла';
  const missing = files.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  return missing.length ? 'в note гейта ' + gate.id + ' нет на диске: ' + missing.join(', ') : { note: files.length + ' путей' };
}

/**
 * Общий каркас пробы гейта по glob (L-008): решение принимает настоящий selectGates,
 * своей копии разбора when нет. Выбор, пропуск и дополнительные проверки - отдельные
 * строки: отказ одной не скрывает состояние другой.
 *   spec.runWhat / spec.skipWhat - хвосты названий строк выбора и пропуска;
 *   spec.mustRun / spec.mustSkip - файлы, на которых гейт обязан выбираться / пропускаться;
 *   spec.extra - [{ name, fn({ gate, runs }, spec), graph }]: fn получает пробу гейта (gateProbe)
 *     и тот же spec вторым аргументом; результат fn - как у check; graph - fn читает граф
 *     turbo настоящего дерева (LIVE_GRAPH) и без него не гоняется.
 * id - идентификатор гейта в правилах; spec - описание пробы выше.
 */
function checkGateSelection(id, spec) {
  check('гейт ' + id + ': gates.js выбирает его на ' + spec.runWhat, () => {
    const { runs } = gateProbe(id);
    const missed = spec.mustRun.filter((f) => !runs(f));
    if (missed.length) return 'gates.js не выбирает его на ' + missed.join(', ');
    return { note: spec.mustRun.length + ' выбор' };
  });
  check('гейт ' + id + ': gates.js пропускает его на ' + spec.skipWhat, () => {
    const { runs } = gateProbe(id);
    const stray = spec.mustSkip.filter((f) => runs(f));
    if (stray.length) return 'gates.js выбирает его на постороннем ' + stray.join(', ');
    return { note: spec.mustSkip.length + ' пропуск' };
  });
  // gates.js берёт изменённые файлы из git (L.changedFiles: diff и ls-files --exclude-standard):
  // файл из .gitignore туда не попадает никогда, и выбор на нём - обещание без покрытия (E0-12K, B1).
  check('гейт ' + id + ': каждый файл выбора git показывает (не в .gitignore)', () =>
    checkIgnoreVerdict(run('git', ['check-ignore', '--', ...spec.mustRun], { cwd: ROOT }), spec.mustRun.length));
  // x.graph - проба графа turbo настоящего дерева: без графа она не гоняется (graphGate)
  for (const x of spec.extra || []) {
    const name = 'гейт ' + id + ': ' + x.name;
    const fn = () => x.fn(gateProbe(id), spec);
    check(name, x.graph ? LIVE_GRAPH.guard(name, fn) : fn);
  }
}

/**
 * Вердикт пробы «каждый файл выбора git показывает» по результату `git check-ignore`
 * (spawnSync): результат - как у check. Отказ называется целиком: git не запустился -
 * его ошибка; упал - код (или сигнал по имени) и весь stderr.
 * r - результат run; count - число файлов выбора.
 */
function checkIgnoreVerdict(r, count) {
  if (r.error) return 'git check-ignore не запустился: ' + r.error.message;
  if (r.status === 1) return { note: count + ' видны git' };
  if (r.status !== 0) {
    const ended = r.status === null ? 'сигнал ' + r.signal : 'код ' + r.status;
    return 'git check-ignore: ' + ended + ': ' + (String(r.stderr || '').trim() || 'stderr пуст');
  }
  const ignored = String(r.stdout || '').split(/\r?\n/).filter(Boolean);
  return 'в .gitignore, gates.js их не увидит: ' + ignored.join(', ');
}

// Ветка «убит сигналом» пробы git check-ignore на живом git не случается: прогоняется
// здесь на готовом результате, сигнал называется по имени (E0-12K, D7).
check('проба git check-ignore: git, убитый сигналом, назван по сигналу', () => {
  const got = checkIgnoreVerdict({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' }, 1);
  const want = 'git check-ignore: сигнал SIGKILL: stderr пуст';
  return got === want || 'ожидалось «' + want + '», получено ' + JSON.stringify(got);
});

// Гейт по glob, ошибка в шаблоне, в его разборе или в пути скрипта не краснеет,
// а молча выключает гейт (E0-11).
checkGateSelection('compose', {
  runWhat: 'файлах Compose',
  skipWhat: 'посторонних',
  mustRun: [
    // Граф стека: compose.yaml и два файла, которые он включает
    // (COMPOSE_SOURCES из scripts/compose-rules.mjs, правило 15). Правило 13
    // (`init: true` у migrate, E0-12J) на infra/docker-compose.app.yml держит
    // только гейт compose; container.test.ts файл читает, но `init: true`
    // не проверяет.
    'compose.yaml',
    'infra/docker-compose.yml',
    'infra/docker-compose.app.yml',
    // Четыре имени override, которые compose-go без -f подмешивает, в корне и
    // в infra/ (правило 14): гейт ищет каждое, и появление файла его запускает.
    'compose.override.yml',
    'compose.override.yaml',
    'docker-compose.override.yml',
    'docker-compose.override.yaml',
    'infra/compose.override.yml',
    'infra/compose.override.yaml',
    'infra/docker-compose.override.yml',
    'infra/docker-compose.override.yaml',
    // Прочие имена, которые Compose ищет без -f рядом с файлами графа
    // (правило 14, DEFAULT_FILES): infra/compose.yaml стал бы стеком
    // `cd infra && docker compose up`. infra/.env, который правило 14 тоже ищет,
    // здесь нет: он в .gitignore, и gates.js его изменения не видит
    // (E0-12K, B1).
    'compose.yml',
    'docker-compose.yml',
    'docker-compose.yaml',
    'infra/compose.yaml',
    'infra/compose.yml',
    'infra/docker-compose.yaml',
    'scripts/check-compose.mjs',
    'scripts/compose-rules.mjs',
    // Читатель графа и манифест, который закрепляет пин yaml, которым тот
    // разбирает файлы (E0-12K).
    'scripts/lib/compose-graph.mjs',
    'package.json',
    // Гейт находит compose.yaml через корень из scripts/lib и читает через
    // scripts/lib/files.mjs (E0-12F) и scripts/lib/json.mjs.
    'scripts/lib/paths.mjs',
    'scripts/lib/files.mjs',
    'scripts/lib/json.mjs',
    '.dockerignore',
    'infra/docker/app.Dockerfile.dockerignore',
    // Правило 12 читает порты тестового стека из корневого .env.test
    // (E0-12C).
    '.env.test',
  ],
  // Манифесты приложений check-compose не читает: выбор на них обещал бы
  // проверку, которой нет (E0-11, круг 7-2).
  // when - ровно файлы, которые гейт читает (E0-12K): из scripts/lib только
  // files.mjs, json.mjs, paths.mjs и compose-graph.mjs; только корневой .env.test.
  mustSkip: [
    'apps/web/src/app/page.tsx',
    'apps/api/package.json',
    'apps/worker/package.json',
    'apps/web/package.json',
    'apps/api/src/package.json',
    'x.dockerignore',
    'docs/30_E0_TASKS.md',
    'README.md',
    'scripts/tasks.mjs',
    'xinfra/a.yml',
    'scripts/lib.mjs',
    'scripts/library/a.mjs',
    'apps/web/scripts/lib/a.mjs',
    'scripts/lib/manifest.mjs',
    'apps/api/.env.test',
    '.env.example',
    // Корневые скрипты и помощники, которые гейт не импортирует (E0-12C, Q16).
    'scripts/probe-image.mjs',
    'scripts/check-no-search-list.mjs',
    'scripts/lib/tasks.mjs',
    'scripts/lib/index.mjs',
    // Не Compose-файл по имени или не под маской.
    'deploy/compose.yaml',
    'deploy/docker-compose.yml',
    'docker-compose.yml.bak',
    'apps/api/docker-compose.override.yml',
    // Вне графа и не читаются гейтом (E0-12K): файл вне графа не входит в стек,
    // а его включение - нарушение правила 15. Сам app.Dockerfile гейт не
    // читает - правило 11 ищет только .dockerignore рядом с ним.
    'infra/README.md',
    'infra/scripts/backup.sh',
    'infra/postgres/init/01-test-db.sql',
    'infra/docker/app.Dockerfile',
    'infra/docker-compose.yml.bak',
    'infra/deploy/extra.yaml',
    'infra/docker-compose.prod.yml',
    'docker-compose.prod.yaml',
    // Правило 11 читает .dockerignore только рядом с Dockerfile, который
    // называют сборки (test/compose-rules.test.ts держит when по сборкам).
    'infra/docker/other.Dockerfile.dockerignore',
  ],
  extra: [
    {
      name: 'его скрипт на месте',
      fn: ({ gate }) => {
        const m = /^node\s+(\S+)/.exec(String(gate.cmd || ''));
        if (!m) return 'cmd гейта compose не node <скрипт>: ' + gate.cmd;
        if (!fs.existsSync(path.join(ROOT, m[1]))) return 'скрипта ' + m[1] + ' нет на диске';
        return true;
      },
    },
    { name: 'пути файлов в его note на диске', fn: ({ gate }) => notePathsOnDisk(gate) },
    {
      // Проба отказа (E0-12J, F15/G1; E0-12K): when без маски infra/docker-compose.app.yml
      // не выбирает гейт на этом файле, и проба выбора выше на нём краснеет. Правило 13
      // (`init: true` у migrate) на infra/docker-compose.app.yml держит только гейт;
      // маски when берутся по одной, и файл обязан оставаться в mustRun.
      // app.Dockerfile в стек пробы не входит: гейт его не читает.
      name: 'when без infra/docker-compose.app.yml не выбирает его на файле стека приложения (проба отказа)',
      fn: ({ gate }, spec) => {
        const file = 'infra/docker-compose.app.yml';
        if (!spec.mustRun.includes(file)) return 'mustRun гейта не держит ' + file + ' - проба выбора на нём не краснеет';
        const when = String(gate.when || '');
        // Маска снимается по тексту, а не разбором синтаксиса when: синтаксис - дело
        // только gates.js и lib.js (E0-12K, B4).
        if (when.split(file).length !== 2) return 'в when гейта маска ' + file + ' не ровно одна - проба отказа не построена: ' + when;
        const narrowed = { ...gate, when: when.replace(file, file + '.off') };
        const runsNarrowed = (f) => selects(narrowed, f);
        if (!runsNarrowed('infra/docker-compose.yml')) return 'суженный when не выбирает гейт и на infra/docker-compose.yml - сужение сломало when, проба ничего не доказывает';
        if (runsNarrowed(file)) return 'суженный when всё ещё выбирает гейт на ' + file + ' - проба выбора не краснеет';
        return { note: 'отказ на ' + file };
      },
    },
    {
      // Каждый файл mustRun выбирается своей маской, а не более широкой: ни один его
      // сосед - то же имя с суффиксом, с префиксом, на каталог ниже - гейт не выбирает.
      // Более широкая маска (infra/**, infra/docker/*.dockerignore, **/compose.yaml)
      // краснит пробу на первом же файле, который покрывает (E0-12K, P2).
      name: 'каждый файл выбора выбирает его своей маской, соседи - нет',
      fn: ({ runs }, spec) => {
        const neighbours = (f) => {
          const at = f.lastIndexOf('/') + 1;
          return [f + '.bak', f.slice(0, at) + 'x-' + f.slice(at), 'x/' + f];
        };
        const stray = spec.mustRun
          .flatMap(neighbours)
          .filter((f) => !spec.mustRun.includes(f) && runs(f));
        if (stray.length) return 'when шире файлов, которые гейт читает: выбирает его на ' + stray.join(', ');
        return { note: spec.mustRun.length * 3 + ' соседей' };
      },
    },
  ],
});

// Скрипт трекера берёт корень из scripts/lib/paths.mjs: правка любого из них
// может сломать render --check так же, как правка tasks.json (E0-12F).
checkGateSelection('tracker', {
  runWhat: 'трекере и его скрипте',
  skipWhat: 'посторонних',
  mustRun: ['docs/tasks/tasks.json', 'docs/00_STATUS.md', 'scripts/tasks.mjs', 'scripts/lib/paths.mjs'],
  mustSkip: ['docs/30_E0_TASKS.md', 'scripts/check-compose.mjs', 'scripts/lib.mjs', 'apps/web/scripts/lib/a.mjs', 'tasks/2026-10-18-E0-12F.md', 'README.md'],
  extra: [{ name: 'пути файлов в его note на диске', fn: ({ gate }) => notePathsOnDisk(gate) }],
});

/**
 * Граф задач turbo (selftest-graph.js, E0-12L, решение техлида Р1 21.10.2026): один dry-JSON
 * на прогон для проб build, test:int и harness-selftest. Своего разбора pnpm-workspace.yaml
 * и next.config.* нет: корни, их зависимости и файлы, которые хеширует каждая задача, даёт turbo.
 */
const GRAPH_SCRIPTS = ['build', 'test:int'];

/**
 * Снимок графа настоящего дерева для проб снимается один раз: snap - { dry, ws, patterns, tracked }
 * (dry-JSON, манифесты пакетов dry, шаблоны pnpm-workspace.yaml, tracked - файлы из git ls-files,
 * которые есть на диске, trackedFiles) - один снимок на прогон по построению. Его отказ (нет
 * turbo, код, не JSON, манифест не читается, сбой git ls-files или stat файла...) - одна красная строка
 * «граф turbo: dry-JSON настоящего дерева» с перечнем проб, которые без графа не гонялись, а не
 * каскад одинаковых красных строк. guard(name, fn) - обёртка пробы графа: при отказе fn не
 * зовётся, строка пробы не пишется (SKIPPED), name уходит в перечень. getSnap - источник снимка
 * (liveSnap или подмена в кейсе).
 */
function graphGate(getSnap) {
  const state = { snap: null, error: null, blocked: [] };
  try {
    state.snap = getSnap();
  } catch (e) {
    state.error = (e && e.message) || String(e);
  }
  state.guard = (name, fn) => (...args) => {
    if (state.error === null) return fn(...args);
    state.blocked.push(name);
    return SKIPPED;
  };
  return state;
}

/** Строка пробы графа state (graphGate): отказ снимка с перечнем проб, которые не гонялись. */
function graphVerdict(state) {
  if (state.error !== null) return state.error + '; пробы графа не гонялись (' + state.blocked.length + '): ' + state.blocked.join('; ');
  return { note: state.snap.dry.tasks.length + ' задач' };
}

// Ветки отказа selftest-graph.js - на синтетическом dry и подменённом результате spawn, без
// turbo: каждый кейс ждёт точный текст отказа, и ветка, заменённая на пропуск (`return []`,
// `continue`), краснит свой кейс (E0-12L, L-020). Кейсы spawn идут на стаб-корне FIXTURE со
// своими turbo и @turbo/<os>-<arch>, а не на node_modules репозитория: свежий клон без
// pnpm install краснит одну строку «dry-JSON настоящего дерева», а не каждый кейс.
{
  const refusedWith = (name, fn, want) => check('граф turbo: ' + name, () => {
    try {
      fn();
    } catch (e) {
      const got = (e && e.message) || String(e);
      return got === want || 'ожидалось «' + want + '», получено «' + got + '»';
    }
    return 'отказа нет, ожидалось «' + want + '»';
  });
  const what = 'turbo run build --dry=json';
  const withTempRoot = (files, fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-selftest-turbo-'));
    try {
      for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), body);
      }
      return fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  // стаб-корень: обёртка turbo и бинари двух платформ (linux-64 без расширения, windows-64 - .exe)
  const FIXTURE = {
    'node_modules/turbo/package.json': '{"name":"turbo"}',
    'node_modules/@turbo/linux-64/package.json': '{"name":"@turbo/linux-64"}',
    'node_modules/@turbo/linux-64/bin/turbo': '',
    'node_modules/@turbo/windows-64/package.json': '{"name":"@turbo/windows-64"}',
    'node_modules/@turbo/windows-64/bin/turbo.exe': '',
  };
  const onFixture = (opts) => withTempRoot(FIXTURE, (root) => G.turboDry(['build'], Object.assign({ root, platform: 'linux', arch: 'x64' }, opts)));
  const spawned = (result) => () => onFixture({ spawn: () => result });
  // dry-JSON, который разбирается: ветка кода/сигнала, снятая целиком, даёт «отказа нет», а не
  // отказ соседней ветки (L-020)
  const EMPTY_DRY = '{"tasks":[],"globalCacheInputs":{"files":{}}}';
  refusedWith('нет пакета turbo - отказ «сначала pnpm install»', () => withTempRoot({}, (root) => G.turboDry(['build'], { root, platform: 'linux', arch: 'x64' })),
    what + ': нет turbo - сначала pnpm install');
  refusedWith('нет пакета платформы - отказ с его именем', () => withTempRoot({ 'node_modules/turbo/package.json': '{"name":"turbo"}' }, (root) => G.turboDry(['build'], { root, platform: 'win32', arch: 'x64' })),
    what + ': нет @turbo/windows-64 - сначала pnpm install');
  // require.resolve поднимается по предкам корня: turbo из node_modules каталога выше корня
  // (глобальный, соседний клон) - чужой, отказ «нет turbo», как и без пакета
  const onRepoBelow = (files) => withTempRoot(Object.assign({ 'repo/package.json': '{}' }, files), (dir) => G.turboDry(['build'], {
    root: path.join(dir, 'repo'), platform: 'linux', arch: 'x64', spawn: () => ({ pid: 4242, status: 0, signal: null, stdout: EMPTY_DRY, stderr: '' }),
  }));
  refusedWith('turbo только в node_modules выше корня - отказ «нет turbo»', () => onRepoBelow(FIXTURE), what + ': нет turbo - сначала pnpm install');
  refusedWith('пакет платформы только в node_modules выше корня - отказ с его именем', () => onRepoBelow({
    'repo/node_modules/turbo/package.json': '{"name":"turbo"}',
    'node_modules/@turbo/linux-64/package.json': '{"name":"@turbo/linux-64"}',
    'node_modules/@turbo/linux-64/bin/turbo': '',
  }), what + ': нет @turbo/linux-64 - сначала pnpm install');
  // underNodeModules: иная ошибка realpath, чем ENOENT, - не «сначала pnpm install», а причина с кодом
  check('граф turbo: underNodeModules - ошибка realpath node_modules не ENOENT (EACCES) пробрасывается с кодом', () => {
    const denied = (p) => {
      throw Object.assign(new Error('EACCES: permission denied, realpath ' + JSON.stringify(path.basename(p))), { code: 'EACCES' });
    };
    try {
      G.underNodeModules(path.join(ROOT, 'node_modules', 'turbo', 'package.json'), ROOT, { realpath: denied });
    } catch (e) {
      const got = (e && e.code) + ': ' + ((e && e.message) || String(e));
      const want = 'EACCES: EACCES: permission denied, realpath "node_modules"';
      return got === want || 'ожидалось «' + want + '», получено «' + got + '»';
    }
    return 'исключения нет, ожидалось EACCES';
  });
  // node_modules корня - ссылка на каталог (junction на Windows): путь модуля и через ссылку, и
  // реальный - под node_modules корня; без realpath одного из концов путь «вне» и отказ ложный
  check('граф turbo: underNodeModules - node_modules корня ссылкой на каталог, путь модуля через ссылку и реальный - под ним', () => withTempRoot({
    'store/turbo/package.json': '{"name":"turbo"}',
    'repo/package.json': '{}',
  }, (dir) => {
    const repo = path.join(dir, 'repo');
    fs.symlinkSync(path.join(dir, 'store'), path.join(repo, 'node_modules'), 'junction');
    const got = JSON.stringify([
      G.underNodeModules(path.join(repo, 'node_modules', 'turbo', 'package.json'), repo),
      G.underNodeModules(path.join(dir, 'store', 'turbo', 'package.json'), repo),
    ]);
    return got === JSON.stringify([true, true]) || 'ожидалось [true,true] (через ссылку, реальный), получено ' + got;
  }));
  refusedWith('платформа без пакета turbo - отказ', () => onFixture({ platform: 'freebsd', arch: 'ia32' }),
    what + ': нет пакета turbo для платформы freebsd-ia32 (пакеты @turbo/<os>-<arch>: windows, darwin, linux x 64, arm64)');
  refusedWith('turbo не запустился - отказ с ошибкой запуска', spawned({ error: new Error('spawn EACCES'), pid: 0 }), what + ' не запустился: spawn EACCES');
  refusedWith('turbo прерван после запуска (ENOBUFS) - отказ «прерван», не «не запустился»',
    spawned({ error: Object.assign(new Error('spawnSync turbo ENOBUFS'), { code: 'ENOBUFS' }), pid: 4242, status: null, signal: 'SIGKILL', stdout: '', stderr: '' }),
    what + ': прерван после запуска: spawnSync turbo ENOBUFS');
  refusedWith('turbo не ответил за предел - отказ с пределом', spawned({ error: Object.assign(new Error('spawnSync turbo ETIMEDOUT'), { code: 'ETIMEDOUT' }), pid: 4242, status: null, signal: 'SIGKILL', stdout: '', stderr: '' }),
    what + ': не ответил за ' + G.TURBO_TIMEOUT_MS / 1000 + ' с - процесс убит');
  refusedWith('turbo вышел с кодом 1 - отказ с кодом и stderr', spawned({ pid: 4242, status: 1, signal: null, stdout: EMPTY_DRY, stderr: 'x  Missing tasks in project\n' }), what + ': код 1: x  Missing tasks in project');
  refusedWith('turbo убит сигналом - отказ с именем сигнала', spawned({ pid: 4242, status: null, signal: 'SIGTERM', stdout: EMPTY_DRY, stderr: '' }), what + ': сигнал SIGTERM: stderr пуст');
  const notJson = '• turbo 2.10.12';
  let parseError = '';
  try {
    JSON.parse(notJson);
  } catch (e) {
    parseError = e.message;
  }
  refusedWith('stdout turbo не JSON - отказ с причиной разбора', spawned({ pid: 4242, status: 0, signal: null, stdout: notJson, stderr: '' }), what + ': stdout не JSON (' + parseError + '): "• turbo 2.10.12"');
  refusedWith('в dry-JSON нет tasks - отказ', spawned({ pid: 4242, status: 0, signal: null, stdout: '{"packages":[]}', stderr: '' }), what + ': в выводе нет массива tasks - форма dry-JSON turbo неизвестна');
  // что получает spawn: бинарь платформы (не обёртка bin/turbo через node), аргументы, предел,
  // сигнал предела и окружение без TURBO_* оболочки
  const spawnSeen = (platform) => withTempRoot(FIXTURE, (root) => {
    let seen = null;
    const had = Object.prototype.hasOwnProperty.call(process.env, 'TURBO_FORCE');
    const prev = process.env.TURBO_FORCE;
    process.env.TURBO_FORCE = '1';
    try {
      G.turboDry(['build'], { root, platform, arch: 'x64', spawn: (cmd, args, opts) => { seen = { cmd, args, opts }; return { pid: 4242, status: 0, signal: null, stdout: EMPTY_DRY, stderr: '' }; } });
    } finally {
      if (had) process.env.TURBO_FORCE = prev;
      else delete process.env.TURBO_FORCE;
    }
    const bins = { linux: 'node_modules/@turbo/linux-64/bin/turbo', win32: 'node_modules/@turbo/windows-64/bin/turbo.exe' };
    return { seen, bin: fs.realpathSync(path.join(root, bins[platform])) };
  });
  for (const platform of ['linux', 'win32']) {
    check('граф turbo: ' + platform + ' - spawn зовёт бинарь пакета платформы напрямую', () => {
      const { seen, bin } = spawnSeen(platform);
      if (!seen) return 'spawn не вызван';
      if (seen.cmd !== bin) return 'spawn зовёт ' + seen.cmd + ', ожидался бинарь ' + bin;
      return JSON.stringify(seen.args) === JSON.stringify(['run', 'build', '--dry=json']) || 'аргументы spawn: ' + JSON.stringify(seen.args);
    });
  }
  check('граф turbo: turbo зовётся с пределом TURBO_TIMEOUT_MS', () => {
    const { seen } = spawnSeen('linux');
    return seen.opts.timeout === G.TURBO_TIMEOUT_MS || 'предел spawn: ' + seen.opts.timeout + ', ожидался ' + G.TURBO_TIMEOUT_MS;
  });
  check('граф turbo: по пределу turbo убивается SIGKILL', () => {
    const { seen } = spawnSeen('linux');
    return seen.opts.killSignal === 'SIGKILL' || 'сигнал предела spawn: ' + seen.opts.killSignal + ', ожидался SIGKILL';
  });
  check('граф turbo: turbo зовётся без TURBO_* оболочки, с выключенной телеметрией', () => {
    const { seen } = spawnSeen('linux');
    const leaked = Object.keys(seen.opts.env || {}).filter((k) => /^TURBO_/i.test(k) && k !== 'TURBO_TELEMETRY_DISABLED');
    if (leaked.length) return 'в окружение turbo ушли ' + leaked.join(', ');
    return seen.opts.env.TURBO_TELEMETRY_DISABLED === '1' || 'телеметрия turbo не выключена';
  });
  check('граф turbo: turboEnv снимает TURBO_* в любом регистре и выключает телеметрию, исходное окружение не правит', () => {
    const env = { PATH: 'p', TURBO_FORCE: '1', turbo_env_mode: 'loose', TURBO_TELEMETRY_DISABLED: '0' };
    const got = JSON.stringify(G.turboEnv(env));
    const want = JSON.stringify({ PATH: 'p', TURBO_TELEMETRY_DISABLED: '1' });
    if (env.TURBO_FORCE !== '1') return 'turboEnv правит исходное окружение';
    return got === want || 'ожидалось ' + want + ', получено ' + got;
  });

  // dry из двух пакетов и постороннего: a#build (next build) зависит от b#build, c#build вне графа
  const task = (id, extra) => Object.assign({
    taskId: id,
    directory: 'packages\\' + id.slice(4, id.indexOf('#')),
    command: G.NONEXISTENT,
    dependencies: [],
    inputs: { 'src/index.ts': 'h' },
    resolvedTaskDefinition: { inputs: [] },
  }, extra);
  const sample = () => ({
    globalCacheInputs: { files: { 'tsconfig.base.json': 'h', '.gitattributes': 'h' } },
    tasks: [
      task('@sf/a#build', { command: 'next build', dependencies: ['@sf/b#build'], inputs: { 'src/page.tsx': 'h', '../../vitest.preset.ts': 'h' } }),
      task('@sf/b#build'),
      task('@sf/c#build'),
    ],
  });
  const withTask = (id, patch) => {
    const dry = sample();
    dry.tasks = dry.tasks.map((t) => (t.taskId === id ? patch(Object.assign({}, t)) : t));
    return dry;
  };
  const withInput = (input) => G.taskGraph(withTask('@sf/b#build', (t) => Object.assign(t, { inputs: { [input]: 'h' } })), 'build');
  check('граф turbo: граф - замыкание dependencies от корней, посторонний пакет вне графа, входы от корня', () => {
    const g = G.taskGraph(sample(), 'build');
    const got = JSON.stringify(g.nodes.map((n) => [n.name, n.pkg, n.root, n.reads.map((r) => r.file + ' (' + r.why + ')')]));
    const want = JSON.stringify([
      ['@sf/a#build', '@sf/a', true, ['packages/a/src/page.tsx (корень @sf/a#build)', 'vitest.preset.ts (корень @sf/a#build)']],
      ['@sf/b#build', '@sf/b', false, ['packages/b/src/index.ts (узел @sf/b#build графа @sf/a#build)']],
    ]);
    return got === want || 'ожидалось ' + want + ', получено ' + got;
  });
  refusedWith('зависимость вне dry-JSON - отказ', () => G.taskGraph(withTask('@sf/b#build', (t) => Object.assign(t, { dependencies: ['@sf/x#build'] })), 'build'),
    'зависимость @sf/x#build задачи @sf/b#build вне dry-JSON - граф неполон');
  refusedWith('вход вне корня репозитория - отказ', () => withInput('../../../x.ts'), 'вход ../../../x.ts задачи @sf/b#build вне корня репозитория');
  refusedWith('вход ровно в родителя корня (..) - отказ', () => withInput('../../..'), 'вход ../../.. задачи @sf/b#build вне корня репозитория');
  refusedWith('абсолютный вход задачи пакета - отказ', () => withInput('/etc/x'), 'вход /etc/x задачи @sf/b#build - абсолютный путь, вне корня репозитория');
  refusedWith('вход с буквой диска - отказ', () => withInput('C:\\x.ts'), 'вход C:\\x.ts задачи @sf/b#build - абсолютный путь, вне корня репозитория');
  refusedWith('globalCacheInputs вне корня - отказ', () => G.globalReads({ tasks: [], globalCacheInputs: { files: { '../x.json': 'h' } } }),
    'вход ../x.json задачи globalCacheInputs вне корня репозитория');
  for (const field of ['directory', 'command', 'dependencies', 'inputs']) {
    refusedWith('у задачи нет ' + field + ' - отказ', () => G.taskGraph(withTask('@sf/c#build', (t) => { delete t[field]; return t; }), 'build'),
      'у задачи @sf/c#build нет ' + field + ' - форма dry-JSON turbo неизвестна');
  }
  refusedWith('у задачи нет resolvedTaskDefinition - отказ', () => G.taskGraph(withTask('@sf/c#build', (t) => { delete t.resolvedTaskDefinition; return t; }), 'build'),
    'у задачи @sf/c#build нет resolvedTaskDefinition.inputs - форма dry-JSON turbo неизвестна');
  refusedWith('resolvedTaskDefinition без inputs - отказ', () => G.taskGraph(withTask('@sf/c#build', (t) => Object.assign(t, { resolvedTaskDefinition: { cache: true } })), 'build'),
    'у задачи @sf/c#build нет resolvedTaskDefinition.inputs - форма dry-JSON turbo неизвестна');
  refusedWith('dependencies не массив строк - отказ', () => G.taskGraph(withTask('@sf/c#build', (t) => Object.assign(t, { dependencies: [1] })), 'build'),
    'у задачи @sf/c#build нет dependencies - форма dry-JSON turbo неизвестна');
  refusedWith('inputs - массив, а не объект - отказ', () => G.taskGraph(withTask('@sf/c#build', (t) => Object.assign(t, { inputs: ['src/index.ts'] })), 'build'),
    'у задачи @sf/c#build нет inputs - форма dry-JSON turbo неизвестна');
  refusedWith('задача без taskId - отказ', () => G.taskGraph(withTask('@sf/c#build', (t) => { delete t.taskId; return t; }), 'build'),
    'задача dry-JSON без taskId - форма dry-JSON turbo неизвестна');
  refusedWith('нет корней - отказ', () => G.taskGraph(withTask('@sf/a#build', (t) => Object.assign(t, { command: G.NONEXISTENT })), 'build'),
    'в dry-JSON нет задачи build с командой - ни у одного пакета нет scripts.build');
  // В2: inputs узла графа в turbo.json - ровно DECLARED_INPUTS его скрипта
  refusedWith('inputs узла графа сужены в turbo.json (src/**) - отказ с taskId и перечнем',
    () => G.taskGraph(G.stubNode(sample(), 'build', { resolvedTaskDefinition: { inputs: ['src/**'] } }), 'build'),
    'inputs задачи ' + G.stubTaskId('build') + ' в turbo.json: ["src/**"], ожидалось [] (DECLARED_INPUTS: build без inputs: turbo хеширует все файлы пакета, видимые git, - их и читает next build)');
  refusedWith('inputs test:int - $TURBO_ROOT$ разрешён от каталога задачи, иное - отказ',
    () => G.taskGraph(withTask('@sf/a#build', (t) => Object.assign(t, { taskId: '@sf/a#test:int', command: 'vitest run', dependencies: [], resolvedTaskDefinition: { inputs: ['../vitest.preset.ts'] } })), 'test:int'),
    'inputs задачи @sf/a#test:int в turbo.json: ["../vitest.preset.ts"], ожидалось ["../../vitest.preset.ts"] (DECLARED_INPUTS: файлы пакета и корневой vitest.preset.ts, который вызывает каждый vitest.int.config.ts (ADR-0011))');
  refusedWith('скрипт узла без ожидания inputs - отказ', () => G.taskGraph(withTask('@sf/a#build', (t) => Object.assign(t, { taskId: '@sf/a#lint', dependencies: [] })), 'lint'),
    'у задачи @sf/a#lint нет ожидания inputs в DECLARED_INPUTS selftest-graph.js');
  // В1: граф turbo не уже манифестов (workspace:-зависимости от корней)
  const manifests = (deps) => Object.fromEntries(Object.entries(deps).map(([name, d]) => [name, { dir: 'packages/' + name.slice(4), pkg: { name, dependencies: d.dependencies, devDependencies: d.devDependencies } }]));
  check('граф turbo: manifestGap - workspace:-зависимости корней (и dev), которых нет в графе, по алфавиту', () => {
    const ws = manifests({
      '@sf/a': { dependencies: { '@sf/b': 'workspace:*', zod: '3.0.0' }, devDependencies: { '@sf/d': 'workspace:^' } },
      '@sf/b': { dependencies: { '@sf/c': 'workspace:*' } },
      '@sf/c': {},
      '@sf/d': {},
    });
    const got = JSON.stringify([G.manifestGap(G.taskGraph(sample(), 'build'), ws), G.manifestGap(G.taskGraph(G.stubCut(sample(), '@sf/b#build'), 'build'), ws)]);
    const want = JSON.stringify([['@sf/c', '@sf/d'], ['@sf/b', '@sf/c', '@sf/d']]);
    return got === want || 'ожидалось ' + want + ', получено ' + got;
  });
  // turbo 2.10.12 строит ребро по optionalDependencies и не строит по peerDependencies (замер dry-JSON)
  check('граф turbo: manifestGap - workspace:-пакет только в optionalDependencies без ребра краснеет с именем, только в peerDependencies - нет', () => {
    const cut = G.taskGraph(G.stubCut(sample(), '@sf/b#build'), 'build');
    const only = (field) => ({
      '@sf/a': { dir: 'packages/a', pkg: { name: '@sf/a', [field]: { '@sf/b': 'workspace:*' } } },
      '@sf/b': { dir: 'packages/b', pkg: { name: '@sf/b' } },
    });
    const got = JSON.stringify([G.manifestGap(cut, only('optionalDependencies')), G.manifestGap(cut, only('peerDependencies'))]);
    const want = JSON.stringify([['@sf/b'], []]);
    return got === want || 'ожидалось ' + want + ' (optional, peer), получено ' + got;
  });
  check('граф turbo: детектор разницы с манифестами - на графе из одних корней отказ, на графе с узлом молчит', () => {
    const ws = manifests({ '@sf/a': { dependencies: { '@sf/b': 'workspace:*' } }, '@sf/b': {} });
    const lone = withTask('@sf/a#build', (t) => Object.assign(t, { dependencies: [] }));
    const got = manifestGapBlind(lone, 'build', G.taskGraph(lone, 'build'), ws);
    const want = 'у графа turbo run build нет узлов кроме корней - детектор разницы с манифестами не построить';
    if (got !== want) return 'ожидалось «' + want + '», получено ' + JSON.stringify(got);
    const ok2 = manifestGapBlind(sample(), 'build', G.taskGraph(sample(), 'build'), ws);
    return ok2 === null || 'на графе с узлом: ' + JSON.stringify(ok2);
  });
  // В2, $TURBO_DEFAULT$: файлы пакета, видимые git, - во входах узла
  check('граф turbo: inputsGap - файл пакета, видимый git, вне входов узла; вложенный пакет и чужой каталог не считаются', () => {
    const dry = sample();
    dry.tasks.push(task('@sf/n#build', { directory: 'packages\\b\\nested' }));
    const tracked = ['packages/a/src/page.tsx', 'packages/b/src/index.ts', 'packages/b/README.md', 'packages/b/nested/x.ts', 'packages/c/src/index.ts', 'vitest.preset.ts'];
    const got = JSON.stringify([G.inputsGap(G.taskGraph(dry, 'build'), tracked, dry),
      ((cut) => G.inputsGap(G.taskGraph(cut, 'build'), tracked, cut))(G.stubWithoutInput(dry, '@sf/a#build', 'packages/a/src/page.tsx'))]);
    const want = JSON.stringify([['@sf/b#build: packages/b/README.md'], ['@sf/a#build: packages/a/src/page.tsx', '@sf/b#build: packages/b/README.md']]);
    return got === want || 'ожидалось ' + want + ', получено ' + got;
  });
  check('граф turbo: inputsGap - больше пяти файлов: пять и «и ещё N»', () => {
    const tracked = Array.from({ length: 7 }, (_, i) => 'packages/b/f' + i + '.ts');
    const got = G.inputsGap(G.taskGraph(sample(), 'build'), tracked, sample());
    const want = ['@sf/b#build: ' + tracked.slice(0, 5).join(', ') + ' и ещё 2'];
    return JSON.stringify(got) === JSON.stringify(want) || 'получено ' + JSON.stringify(got);
  });
  // корневая задача: turbo пишет directory '' - каталог узла и каталоги пакетов dry - оба '.'
  // (packageDir), файл корня вне входов виден, файлы пакетов под корнем - не его
  check('граф turbo: inputsGap - корневая задача (directory \'\'): каталог \'.\', файлы пакетов под корнем не её', () => {
    const dry = {
      globalCacheInputs: { files: {} },
      tasks: [
        task('//#build', { directory: '', command: 'tsc -b', dependencies: ['@sf/b#build'], inputs: { 'a.ts': 'h' } }),
        task('@sf/b#build'),
      ],
    };
    const graph = G.taskGraph(dry, 'build');
    const dirs = JSON.stringify([graph.nodes.map((n) => n.dir), Array.from(G.dryPackages(dry).values())]);
    if (dirs !== JSON.stringify([['.', 'packages/b'], ['.', 'packages/b']])) return 'каталоги узлов и пакетов dry: ' + dirs;
    const got = JSON.stringify(G.inputsGap(graph, ['a.ts', 'README.md', 'packages/b/src/index.ts', 'packages/b/x.ts'], dry));
    const want = JSON.stringify(['//#build: README.md', '@sf/b#build: packages/b/x.ts']);
    return got === want || 'ожидалось ' + want + ', получено ' + got;
  });
  refusedWith('стаб без входа: входа нет - отказ', () => G.stubWithoutInput(sample(), '@sf/b#build', 'packages/b/none.ts'),
    'стаб: у задачи @sf/b#build нет входа packages/b/none.ts');
  check('граф turbo: детектор входов - на графе без файла пакета во входах отказ, на графе с ним молчит', () => {
    const bare = withTask('@sf/a#build', (t) => Object.assign(t, { dependencies: [], inputs: { '../../vitest.preset.ts': 'h' } }));
    const got = inputsGapBlind(bare, 'build', G.taskGraph(bare, 'build'), []);
    const want = 'у графа turbo run build ни у одного узла нет отслеживаемого входа своего пакета - детектор входов не построить';
    if (got !== want) return 'ожидалось «' + want + '», получено ' + JSON.stringify(got);
    const ok2 = inputsGapBlind(sample(), 'build', G.taskGraph(sample(), 'build'), ['packages/a/src/page.tsx', 'packages/b/src/index.ts']);
    return ok2 === null || 'на графе с файлом пакета: ' + JSON.stringify(ok2);
  });
  // вход для среза берётся только из tracked: неотслеживаемый файл (`??`) turbo хеширует, а
  // inputsGap его не сверяет - срез такого входа дал бы ложное «проба не замечает»
  check('граф turbo: детектор входов режет только отслеживаемый вход; входы узлов не в tracked - отказ «нет отслеживаемого входа»', () => {
    const skip = inputsGapBlind(sample(), 'build', G.taskGraph(sample(), 'build'), ['packages/b/src/index.ts']);
    if (skip !== null) return 'вход packages/a/src/page.tsx вне tracked взят для среза: ' + JSON.stringify(skip);
    const none = inputsGapBlind(sample(), 'build', G.taskGraph(sample(), 'build'), []);
    const want = 'у графа turbo run build ни у одного узла нет отслеживаемого входа своего пакета - детектор входов не построить';
    return none === want || 'входы узлов вне tracked: ожидалось «' + want + '», получено ' + JSON.stringify(none);
  });
  refusedWith('manifestGap: workspace:-зависимость вне пакетов dry - отказ',
    () => G.manifestGap(G.taskGraph(sample(), 'build'), manifests({ '@sf/a': { devDependencies: { '@sf/x': 'workspace:*' } }, '@sf/b': {} })),
    'workspace:-зависимость @sf/x пакета @sf/a (devDependencies) вне пакетов dry-JSON');
  refusedWith('нет globalCacheInputs.files - отказ', () => G.globalReads({ tasks: [] }),
    'в dry-JSON нет globalCacheInputs.files - форма dry-JSON turbo неизвестна');
  check('граф turbo: globalCacheInputs - в чтениях, кроме названных в HASHED_NOT_READ с причиной', () => {
    const g = G.globalReads(sample());
    const got = JSON.stringify([g.reads.map((r) => r.file), g.skipped.map((r) => r.file)]);
    const want = JSON.stringify([['tsconfig.base.json'], ['.gitattributes']]);
    if (got !== want) return 'ожидалось ' + want + ', получено ' + got;
    return g.skipped.every((r) => r.why) || 'у исключения нет причины';
  });
  check('граф turbo: graphSources - корень без ./, у пакета package.json и turbo.json, новый пакет по шаблону (и без пакетов), без повторов', () => {
    const dry = {
      globalCacheInputs: { files: {} },
      tasks: [
        task('//#lint', { directory: '.', command: 'biome check', inputs: {} }),
        task('@sf/a#build', { directory: 'apps\\a', inputs: {} }),
        task('@sf/a#test', { directory: 'apps\\a', inputs: {} }),
      ],
    };
    const got = JSON.stringify(G.graphSources(dry, ['apps/*', './tools/**/', '!apps/x']).map((x) => x.file));
    const want = JSON.stringify(['package.json', 'pnpm-workspace.yaml', 'turbo.json', 'apps/a/package.json', 'apps/a/turbo.json',
      'apps/' + G.NEW_SIBLING + '/package.json', 'apps/' + G.NEW_SIBLING + '/turbo.json', 'tools/' + G.NEW_SIBLING + '/package.json', 'tools/' + G.NEW_SIBLING + '/turbo.json']);
    return got === want || 'ожидалось ' + want + ', получено ' + got;
  });
  refusedWith('graphSources: шаблон с ? [ ] { } - отказ', () => G.graphSources(sample(), ['apps/{a,b}']),
    'шаблон apps/{a,b} pnpm-workspace.yaml не разбирается пробой (знаки ? [ ] { }) - разбери руками');
  check('граф turbo: workspacePatterns - список packages pnpm-workspace.yaml', () => {
    const got = JSON.stringify(G.workspacePatterns('packages:\n  - "apps/*"\n  - \'tools/*\'\n'));
    return got === JSON.stringify(['apps/*', 'tools/*']) || 'получено ' + got;
  });
  refusedWith('workspacePatterns: нет списка строк packages - отказ', () => G.workspacePatterns('packages:\n  - 1\n'),
    'в pnpm-workspace.yaml нет списка строк packages - шаблоны пакетов workspace неизвестны');
  check('граф turbo: rootTasks - задачи script с командой, без отказа на пустом списке', () => {
    const got = JSON.stringify([G.rootTasks(sample(), 'build'), G.rootTasks(sample(), 'test:int')]);
    const want = JSON.stringify([[{ name: '@sf/a#build', command: 'next build' }], []]);
    return got === want || 'ожидалось ' + want + ', получено ' + got;
  });
  refusedWith('стаб команды задачи вне dry-JSON - отказ', () => G.stubCommand(sample(), '@sf/x#build', 'x'),
    'стаб: задачи @sf/x#build нет в dry-JSON');
  refusedWith('стаб без рёбер к задаче вне dry-JSON - отказ', () => G.stubCut(sample(), '@sf/x#build'),
    'стаб: задачи @sf/x#build нет в dry-JSON');
  refusedWith('стаб глобального входа без globalCacheInputs.files - отказ', () => G.stubGlobal({ tasks: [] }),
    'в dry-JSON нет globalCacheInputs.files - форма dry-JSON turbo неизвестна');
  check('граф turbo: стабы (узел, команда, рёбра, глобальный вход) меняют свою часть, снимок не правят', () => {
    const dry = sample();
    const before = JSON.stringify(dry);
    const node = G.stubNode(dry, 'build');
    const cmd = G.stubCommand(dry, '@sf/a#build', 'next build || true');
    const cut = G.stubCut(dry, '@sf/b#build');
    const glob = G.stubGlobal(dry);
    if (JSON.stringify(dry) !== before) return 'стаб правит исходный dry';
    const stubNodeOf = G.taskGraph(node, 'build').nodes.find((n) => n.name === G.stubTaskId('build'));
    if (!stubNodeOf) return 'узла стаба нет в графе';
    if (stubNodeOf.dir !== G.STUB_DIR || stubNodeOf.pkg !== G.STUB_PACKAGE) return 'стаб-узел не в STUB_DIR или не STUB_PACKAGE';
    if (G.rootTasks(cmd, 'build')[0].command !== 'next build || true') return 'стаб команды не сменил команду';
    if (G.taskGraph(cut, 'build').nodes.some((n) => n.name === '@sf/b#build')) return 'стаб без рёбер оставил узел в графе';
    return G.globalReads(glob).reads.some((r) => r.file === G.STUB_GLOBAL) || 'стаб глобального входа не добавил STUB_GLOBAL';
  });
  check('граф turbo: файлы стабов - в STUB_DIR', () => {
    const stray = G.STUB_FILES.concat(G.STUB_PATTERN).filter((f) => !f.startsWith(G.STUB_DIR + '/'));
    return !stray.length || 'файлы стабов вне STUB_DIR: ' + stray.join(', ');
  });
  check('граф turbo: отказ снимка - одна строка, пробы графа не гоняются и названы в ней', () => {
    let called = 0;
    const g = graphGate(() => { throw new Error('boom'); });
    const r = g.guard('проба x', () => { called++; return true; })();
    if (r !== SKIPPED || called) return 'проба графа гонялась без графа (результат ' + String(r) + ', вызовов ' + called + ')';
    const v = graphVerdict(g);
    return v === 'boom; пробы графа не гонялись (1): проба x' || 'строка отказа: ' + JSON.stringify(v);
  });
  check('граф turbo: с графом пробы графа гоняются как есть', () => {
    const g = graphGate(() => ({ dry: { tasks: [] } }));
    const r = g.guard('проба x', (a) => a + 1)(1);
    if (r !== 2 || g.blocked.length) return 'проба с графом: результат ' + r + ', не гонялись ' + g.blocked.length;
    const v = graphVerdict(g);
    return (typeof v === 'object' && v.note === '0 задач') || 'строка графа: ' + JSON.stringify(v);
  });
  check('граф turbo: check не пишет строку пробы, которая вернула SKIPPED', () => {
    const before = results.length;
    check('граф turbo: проба SKIPPED', () => SKIPPED);
    const stray = results.splice(before);
    return !stray.length || 'check записал строку пробы, которая не гонялась: ' + stray.map((x) => (x.ok ? 'ok ' : 'FAIL ') + x.name).join(', ');
  });
  check('граф turbo: rootsRefusal - отказ корней называет перечень и как его расширить', () => {
    const dry = G.stubCommand(G.stubNode(sample(), 'build', { command: 'next build' }), '@sf/a#build', 'next build || true');
    const got = rootsRefusal(dry, 'build', { roots: ['@sf/a#build'], command: 'next build' }, 'build');
    const want = 'корни turbo run build не ровно @sf/a#build с командой next build: лишний корень ' + G.stubTaskId('build') + ', @sf/a#build: "next build || true"' +
      ' - перечень корней - roots пробы корней гейта build (harness-selftest.js, checkGateSelection(\'build\')); новый пакет дописывается туда вместе с glob гейта build';
    return got === want || 'ожидалось «' + want + '», получено ' + JSON.stringify(got);
  });
  // trackedFiles (снимок liveSnap): сбой git - отказ, а не пустой список, с которым inputsGap
  // молча слепнет; файл, которого нет на диске, выпадает, файл, который не читается, - отказ
  const lsFiles = (stdout) => () => ({ pid: 4242, status: 0, signal: null, stdout, stderr: '' });
  const NO_GIT = 'sf-selftest-no-git';
  refusedWith('git ls-files не запустился - отказ с ошибкой запуска', () => trackedFiles({ git: NO_GIT }),
    'git ls-files не запустился: spawnSync ' + NO_GIT + ' ENOENT');
  refusedWith('git ls-files убит сигналом - отказ с именем сигнала', () => trackedFiles({ spawn: () => ({ pid: 4242, status: null, signal: 'SIGKILL', stdout: '', stderr: '' }) }),
    'git ls-files: сигнал SIGKILL: ');
  check('граф turbo: trackedFiles - файла нет на диске - не в списке, есть - в списке', () => {
    const got = JSON.stringify(trackedFiles({ spawn: lsFiles('package.json\0sf-selftest-gone.ts\0') }));
    return got === JSON.stringify(['package.json']) || 'получено ' + got;
  });
  refusedWith('trackedFiles: файл не читается (EACCES) - отказ, а не молча выпавший файл', () => trackedFiles({
    spawn: lsFiles('package.json\0sf-selftest-locked.ts\0'),
    stat: (p) => {
      if (path.basename(p) === 'sf-selftest-locked.ts') throw Object.assign(new Error('EACCES: permission denied, stat sf-selftest-locked.ts'), { code: 'EACCES' });
      return fs.statSync(p);
    },
  }), 'EACCES: permission denied, stat sf-selftest-locked.ts');
  check('граф turbo: trackedFiles - родитель пути стал файлом (ENOTDIR) - файла нет, а не отказ', () => {
    let got;
    try {
      got = JSON.stringify(trackedFiles({
        spawn: lsFiles('package.json\0package.json/sf-selftest-child.ts\0'),
        stat: (p) => {
          if (path.basename(p) === 'sf-selftest-child.ts') throw Object.assign(new Error('ENOTDIR: not a directory, stat sf-selftest-child.ts'), { code: 'ENOTDIR' });
          return fs.statSync(p);
        },
      }));
    } catch (e) {
      return 'отказ: ' + ((e && e.message) || String(e));
    }
    return got === JSON.stringify(['package.json']) || 'получено ' + got;
  });
  check('граф turbo: trackedFiles - отслеживаемый путь стал каталогом - не в списке', () => {
    const got = JSON.stringify(trackedFiles({ spawn: lsFiles('package.json\0.claude\0') }));
    return got === JSON.stringify(['package.json']) || 'получено ' + got;
  });
}

/**
 * Файлы, которые git видит в дереве (`git ls-files -z`, пути от корня) и которые есть на диске:
 * удалённый в рабочем дереве файл turbo не хеширует. Для G.inputsGap; git зовёт только
 * самопроверка, модуль графа получает список параметром. git не запустился или упал - исключение.
 * Наличие на диске - stat обычного файла: ENOENT и ENOTDIR (родитель стал файлом) - файла нет,
 * путь стал каталогом - файла нет, иная ошибка (EACCES) - исключение, а не молча выпавший файл.
 * opts - подмена для кейсов: git (имя команды), spawn (вместо run), stat (вместо fs.statSync).
 */
function trackedFiles(opts) {
  const o = opts || {};
  const spawn = o.spawn || run;
  const stat = o.stat || fs.statSync;
  const r = spawn(o.git || 'git', ['-c', 'core.fsmonitor=false', 'ls-files', '-z'], { cwd: ROOT });
  if (r.error) throw new Error('git ls-files не запустился: ' + r.error.message);
  if (r.status !== 0) throw new Error('git ls-files: ' + (r.status === null ? 'сигнал ' + r.signal : 'код ' + r.status) + ': ' + String(r.stderr || '').trim());
  const isFile = (f) => {
    try {
      return stat(path.join(ROOT, f)).isFile();
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return false;
      throw e;
    }
  };
  return r.stdout.split('\0').filter((f) => f && isFile(f));
}

/**
 * Снимок настоящего дерева для LIVE_GRAPH: dry-JSON, манифесты пакетов dry, шаблоны workspace и
 * файлы, видимые git.
 */
function liveSnap() {
  const dry = G.turboDry(GRAPH_SCRIPTS);
  return {
    dry,
    ws: dryManifests(dry),
    patterns: G.workspacePatterns(fs.readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8')),
    tracked: trackedFiles(),
  };
}

/** Граф настоящего дерева (graphGate): один снимок на прогон. */
const LIVE_GRAPH = graphGate(liveSnap);

/**
 * Манифесты пакетов dry: { имя: { dir, pkg } } - workspace:-зависимости для G.manifestGap (граф
 * turbo не уже манифестов) и exports для moduleReads (`@sf/<пакет>/<подпуть>`) в чтениях
 * конфигов int-тестов. Читаются один раз за прогон, в снимке liveSnap. Разбор конфигов ниже (stripJsComments, stringArrayAt,
 * vitestConfigOf, moduleReads, intProbeReads) - остаток ручного разбора до E0-12T (vitest/node
 * и test/imports.ts, решение Р0 техлида 21.10.2026).
 */
function dryManifests(dry) {
  const ws = {};
  for (const [name, dir] of G.dryPackages(dry)) ws[name] = { dir, pkg: readJson(path.join(ROOT, dir, 'package.json')) };
  return ws;
}

/** Исходник без комментариев // и блочных; строки (', ", `) копируются как есть. */
function stripJsComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 1;
      out += ' ';
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Строки массива по ключу key (`key: ["a", 'b']`) в исходнике конфига без комментариев -
 * setupFiles конфига vitest. Ключа нет, ключ встречается больше одного раза или значение не
 * массив строковых литералов (переменная, spread, вызов, одна строка) - исключение:
 * молчаливый [] или первое из двух вхождений спрятали бы то, что читает гейт.
 */
function stringArrayAt(src, key, file) {
  const code = stripJsComments(src);
  const hits = code.match(new RegExp('\\b' + key + '\\b', 'g')) || [];
  if (!hits.length) throw new Error(key + ' в ' + file + ' нет - разбери руками');
  if (hits.length > 1) throw new Error(key + ' в ' + file + ' встречается ' + hits.length + ' раза - разбери руками');
  const m = new RegExp('\\b' + key + '\\s*:\\s*\\[([^\\]]*)\\]').exec(code);
  const STR = /"[^"]*"|'[^']*'|`[^`$]*`/g;
  if (!m || m[1].replace(STR, '').replace(/[\s,]/g, '') !== '') {
    throw new Error(key + ' в ' + file + ' не массив строковых литералов - разбери руками');
  }
  return (m[1].match(STR) || []).map((s) => s.slice(1, -1));
}

/**
 * Файл конфига vitest из команды задачи: значение `--config <файл>` / `--config=<файл>`.
 * Флага нет - исключение: без него vitest берёт vitest.config.*, и проба сверяла бы не тот
 * конфиг, которым гоняется скрипт.
 */
function vitestConfigOf(command, owner) {
  const m = /(?:^|\s)--config(?:=|\s+)(\S+)/.exec(String(command || ''));
  if (!m) throw new Error('команда ' + owner + ' не называет конфиг через --config: ' + JSON.stringify(command) + ' - разбери руками');
  return m[1];
}

/** Чтение файлов пробой (путь от корня): диск или диск с наложенными стаб-файлами. */
const DISK = {
  exists: (rel) => fs.existsSync(path.join(ROOT, rel)),
  read: (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8'),
};
function overlaySource(files) {
  return {
    exists: (rel) => Object.prototype.hasOwnProperty.call(files, rel) || DISK.exists(rel),
    read: (rel) => (Object.prototype.hasOwnProperty.call(files, rel) ? files[rel] : DISK.read(rel)),
  };
}

/**
 * Файлы, которые читает модуль spec, импортированный из каталога fromDir (пути от корня):
 * для `./…` и `../…` - файл от fromDir (спецификатор `.js` - его `.ts` на диске, как в исходниках
 * workspace), для `@sf/<пакет>/<подпуть>` - package.json пакета и файл из exports['./<подпуть>'].
 * Последний элемент - сам модуль. Пакета нет среди пакетов dry, нет строки exports, иная форма
 * спецификатора или файла нет - исключение. who - кто импортирует (в тексте отказа).
 */
function moduleReads(spec, fromDir, ws, src, who) {
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const rel = path.posix.normalize(fromDir + '/' + spec);
    if (src.exists(rel)) return [rel];
    const ts = rel.replace(/\.js$/, '.ts');
    if (ts !== rel && src.exists(ts)) return [ts];
    throw new Error(who + ': файла ' + rel + ' нет на диске');
  }
  const m = /^(@sf\/[\w-]+)\/(.+)$/.exec(spec);
  if (!m) throw new Error(who + ': спецификатор ' + spec + ' не разбирается пробой - разбери руками');
  const dep = ws[m[1]];
  if (!dep) throw new Error(who + ': ' + m[1] + ' нет среди пакетов dry-JSON turbo');
  const target = dep.pkg.exports && dep.pkg.exports['./' + m[2]];
  if (typeof target !== 'string') throw new Error(who + ': у ' + m[1] + ' нет строки exports["./' + m[2] + '"]');
  const rel = path.posix.normalize(dep.dir + '/' + target);
  if (!src.exists(rel)) throw new Error(who + ': файла ' + rel + ' (' + spec + ') нет на диске');
  return [dep.dir + '/package.json', rel];
}

/**
 * Всё, что читает проба test:int сверх входов графа turbo, - и что читают сами int-тесты:
 * конфиг из --config команды корня графа, модули его setupFiles (`./` - от каталога конфига),
 * модуль, из которого setup импортирует testEnvFilePath, и сама фикстура - файл в корне
 * из `join(repoRoot, "<файл>")`. Setup без импорта testEnvFilePath, иная форма
 * testEnvFilePath, нет файла - исключение. ws - dryManifests; roots - корни taskGraph
 * ({ name, dir, command }). Возвращает [{ file, why }] без повторов.
 */
function intProbeReads(ws, roots, src) {
  const out = new Map();
  const add = (file, why) => { if (!out.has(file)) out.set(file, why); };
  const IMPORT = /\bimport\s*\{([^}]*)\}\s*from\s*(["'])([^"']+)\2/g;
  for (const root of roots) {
    const cfg = path.posix.normalize(root.dir + '/' + vitestConfigOf(root.command, root.name));
    if (!src.exists(cfg)) throw new Error('конфига ' + cfg + ' (--config ' + root.name + ') нет на диске');
    add(cfg, '--config ' + root.name);
    for (const spec of stringArrayAt(src.read(cfg), 'setupFiles', cfg)) {
      const files = moduleReads(spec, path.posix.dirname(cfg), ws, src, 'setupFiles ' + root.name);
      const setup = files[files.length - 1];
      for (const f of files) add(f, 'setupFiles ' + root.name);
      const imports = Array.from(stripJsComments(src.read(setup)).matchAll(IMPORT))
        .filter((m) => m[1].split(',').some((n) => n.trim().split(/\s+/)[0] === 'testEnvFilePath'));
      if (imports.length !== 1) throw new Error('setup ' + setup + ' не берёт testEnvFilePath одним импортом - разбери руками');
      const mod = moduleReads(imports[0][3], path.posix.dirname(setup), ws, src, 'setup ' + setup);
      const pathsFile = mod[mod.length - 1];
      for (const f of mod) add(f, 'testEnvFilePath для ' + setup);
      const p = /\bexport\s+const\s+testEnvFilePath\s*=\s*join\(\s*repoRoot\s*,\s*(["'])([^"'/\\]+)\1\s*\)/.exec(stripJsComments(src.read(pathsFile)));
      if (!p) throw new Error('testEnvFilePath в ' + pathsFile + ' не join(repoRoot, "<файл в корне>") - разбери руками');
      if (!src.exists(p[2])) throw new Error('фикстуры ' + p[2] + ' (testEnvFilePath в ' + pathsFile + ') нет в корне');
      add(p[2], 'фикстура testEnvFilePath, ' + setup);
    }
  }
  return Array.from(out, ([file, why]) => ({ file, why }));
}

// Чтения пробы test:int на настоящем дереве - один раз за прогон: их сверяют и проба
// test:int, и проба harness-selftest.
let liveIntReadsMemo = null;
function liveIntReads() {
  if (!liveIntReadsMemo) liveIntReadsMemo = intProbeReads(LIVE_GRAPH.snap.ws, G.taskGraph(LIVE_GRAPH.snap.dry, 'test:int').roots, DISK);
  return liveIntReadsMemo;
}

/**
 * Стаб для детектора intProbeReads на G.stubNode: задача test:int с командой в STUB_DIR (вне glob
 * гейта) с ребром от первого корня графа; её конфиг берёт setup из стаб-пакета G.STUB_PACKAGE
 * (exports), setup импортирует testEnvFilePath из соседнего модуля. Возвращает
 * { dry, ws, src, expect, files } - expect: setup-файл, который детектор обязан назвать; files -
 * стаб-файлы (их glob гейта покрывать не должен). Снимок dry и манифесты ws не правятся.
 */
function intProbeStub(dry, ws) {
  const stub = G.stubNode(dry, 'test:int', { command: 'vitest run --config vitest.selftest.config.ts' });
  const name = G.STUB_PACKAGE;
  const stubWs = Object.assign({}, ws, { [name]: { dir: G.STUB_DIR, pkg: { name, exports: { './vitest/selftest-setup': './vitest/selftest-setup.ts' } } } });
  const setup = G.STUB_DIR + '/vitest/selftest-setup.ts';
  const files = {
    [G.STUB_DIR + '/vitest.selftest.config.ts']: 'export default { test: { setupFiles: ["' + name + '/vitest/selftest-setup"] } };',
    [setup]: 'import { testEnvFilePath } from "./selftest-paths.js";\n',
    [G.STUB_DIR + '/vitest/selftest-paths.ts']: 'export const testEnvFilePath = join(repoRoot, ".env.test");\n',
  };
  return { dry: stub, ws: stubWs, src: overlaySource(files), expect: setup, files: Object.keys(files) };
}

/**
 * Чтения графа гейта, который гоняет turbo run <script>: входы каждого узла taskGraph,
 * globalCacheInputs (без HASHED_NOT_READ) и extra ([{ file, why }] сверх графа) - outsideGlob
 * по пробе гейта runs. Возвращает { graph, outside }.
 */
function graphOutside(runs, dry, script, extra) {
  const graph = G.taskGraph(dry, script);
  const reads = graph.nodes.flatMap((n) => n.reads).concat(G.globalReads(dry).reads, extra);
  return { graph, outside: G.outsideGlob(runs, reads) };
}

/**
 * Стаб-файлы под glob гейта: детектор на них не построить, и «проба не замечает» свалило бы вину
 * на пробу. Сверяются все файлы стабов модуля (G.STUB_FILES: стаб-пакет, его turbo.json, пакет
 * стаб-шаблона, глобальный вход) и extra (файлы стаба пробы сверх модуля). Строка отказа с именем
 * STUB_DIR и файлами под glob или null. runs - проба гейта.
 */
function stubUnderGlob(runs, gateId, extra) {
  const under = G.STUB_FILES.concat(extra || []).filter((f) => runs(f));
  return under.length ? 'стаб-каталог ' + G.STUB_DIR + ' под glob ' + gateId + ' (' + under.join(', ') + ') - детектор не построить, смени STUB_DIR в selftest-graph.js' : null;
}

/**
 * Детектор разницы графа с манифестами (G.manifestGap) не слепой: граф script без рёбер к первому
 * некорневому узлу graph (G.stubCut) обязан назвать его пакет. У графа нет некорневых узлов -
 * детектор не построить, это отказ, а не пропуск. Строка отказа или null.
 */
function manifestGapBlind(dry, script, graph, ws) {
  const cut = graph.nodes.find((n) => !n.root);
  if (!cut) return 'у графа turbo run ' + script + ' нет узлов кроме корней - детектор разницы с манифестами не построить';
  if (G.manifestGap(G.taskGraph(G.stubCut(dry, cut.name), script), ws).includes(cut.pkg)) return null;
  return 'проба не замечает граф без ' + cut.name + ' (стаб без рёбер к узлу): ' + cut.pkg + ' не назван разницей с манифестами';
}

/**
 * Детектор G.inputsGap не слепой: граф без одного файла пакета во входах первого узла, у которого
 * такой вход есть и он среди tracked (G.stubWithoutInput), обязан назвать этот файл. Вход только
 * из tracked: turbo хеширует и неотслеживаемые файлы, а inputsGap сверяет лишь tracked - срез
 * нового `??`-файла дал бы ложное «проба не замечает». Строка отказа или null.
 */
function inputsGapBlind(dry, script, graph, tracked) {
  const seen = new Set(tracked);
  const own = (n) => n.reads.map((r) => r.file).filter((f) => f.startsWith(n.dir + '/') && seen.has(f));
  const node = graph.nodes.find((n) => own(n).length);
  if (!node) return 'у графа turbo run ' + script + ' ни у одного узла нет отслеживаемого входа своего пакета - детектор входов не построить';
  const file = own(node)[0];
  const stub = G.stubWithoutInput(dry, node.name, file);
  if (G.inputsGap(G.taskGraph(stub, script), tracked, stub).includes(node.name + ': ' + file)) return null;
  return 'проба не замечает вход ' + file + ', снятый у ' + node.name + ' (стаб без входа)';
}

/**
 * Проба графа гейта, который гоняет turbo run <script> (extra-строка checkGateSelection с
 * graph): каждый файл, который хеширует задача графа (узлы - замыкание от корней),
 * globalCacheInputs и чтения opts.liveExtra() (сверх графа, на настоящем дереве) обязаны
 * выбирать гейт; граф не уже манифестов (G.manifestGap). Детекторы не слепые: стаб-узел в
 * STUB_DIR (G.stubNode) обязан дать отказ со своим package.json, стаб глобального входа - со
 * своим файлом, граф без рёбер к первому некорневому узлу (G.stubCut) - разницу с манифестами
 * с его пакетом; при opts.extraStub - и стаб opts.extraStub(dry, ws), чтения которого считает
 * opts.extraReads (его expect обязан попасть в отказ). opts.label - кто читает, с глаголом
 * (в тексте отказа).
 */
function checkTurboGraph(script, opts) {
  return ({ gate, runs }) => {
    const { dry, ws, tracked } = LIVE_GRAPH.snap;
    const extra = opts.liveExtra ? opts.liveExtra() : [];
    const real = graphOutside(runs, dry, script, extra);
    if (real.outside.length) return G.refusal(opts.label, gate.id, real.outside);
    const gap = G.manifestGap(real.graph, ws);
    if (gap.length) {
      return 'граф turbo run ' + script + ' уже манифестов: ' + gap.join(', ') + ' (workspace:-зависимости корней вне графа) - проверь dependsOn задачи ' + script + ' в turbo.json';
    }
    const unhashed = G.inputsGap(real.graph, tracked, dry);
    if (unhashed.length) {
      return 'входы графа turbo run ' + script + ' не покрывают файлы пакетов, видимые git: ' + unhashed.join('; ') + ' - inputs в turbo.json без $TURBO_DEFAULT$?';
    }
    const inputsBlind = inputsGapBlind(dry, script, real.graph, tracked);
    if (inputsBlind) return inputsBlind;
    const s = opts.extraStub ? opts.extraStub(dry, ws) : null;
    const under = stubUnderGlob(runs, gate.id, s ? s.files : []);
    if (under) return under;
    const want = G.STUB_DIR + '/package.json ';
    const stub = graphOutside(runs, G.stubNode(dry, script, { inputs: { 'package.json': 'stub' } }), script, extra);
    if (!stub.outside.some((b) => b.startsWith(want))) return 'проба не замечает узел ' + G.STUB_DIR + ' вне glob ' + gate.id + ' на стабе';
    // globalCacheInputs сверяются наравне со входами задач: посторонний глобальный вход - отказ
    if (!graphOutside(runs, G.stubGlobal(dry), script, extra).outside.some((b) => b.startsWith(G.STUB_GLOBAL + ' '))) {
      return 'проба не замечает глобальный вход ' + G.STUB_GLOBAL + ' вне glob ' + gate.id + ' на стабе';
    }
    const gapBlind = manifestGapBlind(dry, script, real.graph, ws);
    if (gapBlind) return gapBlind;
    if (s) {
      const stubExtra = opts.extraReads(s.ws, G.taskGraph(s.dry, script).roots, s.src);
      if (!graphOutside(runs, s.dry, script, stubExtra).outside.some((b) => b.startsWith(s.expect + ' '))) {
        return 'проба не замечает ' + s.expect + ' вне glob ' + gate.id + ' на стабе extraReads';
      }
    }
    const files = real.graph.nodes.reduce((n, x) => n + x.reads.length, 0);
    const skipped = G.globalReads(dry).skipped.map((r) => r.file);
    return {
      note: script + ': корни ' + real.graph.roots.map((r) => r.name).join(', ') + '; узлов ' + real.graph.nodes.length + ', файлов ' + files +
        (extra.length ? ' и ' + extra.length + ' файлов конфигов' : '') + (skipped.length ? '; не сверяются (HASHED_NOT_READ): ' + skipped.join(', ') : ''),
    };
  };
}

/**
 * Расхождения корней графа script с want ({ roots, command }): корни - ровно want.roots
 * (пропавший скрипт пакета сужает граф молча, лишний корень - новый пакет мимо перечня), команда
 * каждого - ровно want.command (`next build || true` и `; exit 0` - ослабленная сборка, не
 * она). Строки отказа; пусто - совпадает.
 */
function rootsVerdict(dry, script, want) {
  const roots = G.rootTasks(dry, script);
  const names = roots.map((r) => r.name);
  return [
    ...want.roots.filter((n) => !names.includes(n)).map((n) => 'нет корня ' + n),
    ...names.filter((n) => !want.roots.includes(n)).map((n) => 'лишний корень ' + n),
    ...roots.filter((r) => r.command !== want.command).map((r) => r.name + ': ' + JSON.stringify(r.command)),
  ];
}

/**
 * Текст отказа пробы корней гейта gateId (rootsVerdict) или null: называет, где перечень корней
 * и что новый пакет дописывается в него вместе с glob гейта - иначе законное расширение
 * оператор чинил бы ослаблением пробы.
 */
function rootsRefusal(dry, script, want, gateId) {
  const bad = rootsVerdict(dry, script, want);
  if (!bad.length) return null;
  return 'корни turbo run ' + script + ' не ровно ' + want.roots.join(', ') + ' с командой ' + want.command + ': ' + bad.join(', ') +
    ' - перечень корней - roots пробы корней гейта ' + gateId + ' (harness-selftest.js, checkGateSelection(\'' + gateId + '\')); новый пакет дописывается туда вместе с glob гейта ' + gateId;
}

/**
 * Проба корней графа script (extra-строка checkGateSelection с graph): корни - ровно
 * want.roots, команда каждого - ровно want.command. Детекторы не слепые: на стабах первого
 * корня с командой want.command + ` || true` и без команды и на лишнем стаб-корне с верной
 * командой - каждый обязан дать свою строку отказа.
 */
function checkRootCommands(script, want) {
  return ({ gate }) => {
    const dry = LIVE_GRAPH.snap.dry;
    const refused = rootsRefusal(dry, script, want, gate.id);
    if (refused) return refused;
    const first = want.roots[0];
    const detectors = [
      [G.stubCommand(dry, first, want.command + ' || true'), first + ': ' + JSON.stringify(want.command + ' || true')],
      [G.stubCommand(dry, first, G.NONEXISTENT), 'нет корня ' + first],
      [G.stubNode(dry, script, { command: want.command }), 'лишний корень ' + G.stubTaskId(script)],
    ];
    const blind = detectors.filter(([stub, line]) => !rootsVerdict(stub, script, want).includes(line)).map(([, line]) => line);
    if (blind.length) return 'проба не замечает на стабе: ' + blind.join('; ');
    return { note: want.roots.join(', ') + ': ' + want.command };
  };
}

/**
 * Скрипт корневого package.json (pkg) script - ровно expected: результат как у check. Точное
 * равенство: лишний флаг (--dry, --filter, --passWithNoTests) выключил бы проверку при зелёном гейте.
 */
function rootScriptVerdict(pkg, script, expected) {
  const actual = pkg.scripts && pkg.scripts[script];
  return actual === expected || G.scriptKey(script) + ' в корневом package.json не ' + expected + ': ' + JSON.stringify(actual);
}

/**
 * Две строки «скрипт корня = ровно expected»: на настоящем package.json и проба отказа -
 * тот же скрипт с лишним флагом обязан краснеть. label - начало названия строки.
 */
function checkRootScriptLines(label, script, expected) {
  check(label + ': ' + G.scriptKey(script) + ' = ' + expected + ' в корневом package.json', () =>
    rootScriptVerdict(readJson(path.join(ROOT, 'package.json')), script, expected));
  check(label + ': ' + G.scriptKey(script) + ' с лишним флагом краснеет (проба отказа)', () => {
    const r = rootScriptVerdict({ scripts: { [script]: expected + ' --passWithNoTests' } }, script, expected);
    return typeof r === 'string' || 'скрипт с лишним флагом принят за ' + expected;
  });
}

/**
 * extra-строка гейта, который гоняет корневой скрипт: cmd гейта - ровно `pnpm <script>`,
 * scripts[script] корневого package.json - ровно expected (rootScriptVerdict).
 */
function rootScriptExtra(script, expected) {
  return {
    name: 'cmd pnpm ' + script + ' и ' + G.scriptKey(script) + ' = ' + expected + ' в корневом package.json',
    fn: ({ gate }) => {
      if (gate.cmd !== 'pnpm ' + script) return 'cmd гейта ' + gate.id + ' не pnpm ' + script + ': ' + gate.cmd;
      return rootScriptVerdict(readJson(path.join(ROOT, 'package.json')), script, expected);
    },
  };
}

// Сборка web (next build, ADR-0005) читает только apps/web и его пакеты; glob гейта
// build сужен до них и корневых конфигов (E0-01A, docs/DECISIONS.md 11.10.2026).
// Граф сборки берётся у turbo (E0-12L): каждый файл каждого узла графа выбирает гейт.
checkGateSelection('build', {
  runWhat: 'apps/web, пакетах web и корневых конфигах',
  skipWhat: 'api, worker, db, integrations, вложенных конфигах и docs',
  mustRun: [
    'apps/web/src/app/page.tsx',
    'apps/web/package.json',
    'apps/web/next.config.ts',
    'apps/web/tsconfig.json',
    'packages/api-client/src/index.ts',
    'packages/config/src/server.ts',
    'packages/contracts/package.json',
    'packages/core/src/index.ts',
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    'turbo.json',
    'tsconfig.base.json',
  ],
  mustSkip: [
    'apps/api/src/server.ts',
    'apps/api/package.json',
    'apps/worker/src/index.ts',
    'packages/db/src/index.ts',
    'packages/db/migrations/meta/_journal.json',
    'packages/integrations/youtube/src/index.ts',
    'apps/web-admin/x.ts',
    'scripts/tsconfig.json',
    'docs/package.json',
    'docs/30_E0_TASKS.md',
    'docs/tasks/tasks.json',
    'docs/apps/web/x.ts',
    'README.md',
    '.claude/hooks/rules.sf.json',
    'compose.yaml',
    'infra/docker-compose.yml',
    'scripts/tasks.mjs',
    'xapps/a.ts',
  ],
  extra: [
    rootScriptExtra('build', 'turbo run build'),
    {
      name: 'каждый файл графа turbo run build (узлы от корней, globalCacheInputs) под glob',
      graph: true,
      fn: checkTurboGraph('build', { label: 'сборка читает' }),
    },
    {
      name: 'корни turbo run build - ровно @sf/web#build, команда - ровно next build (ADR-0005)',
      graph: true,
      fn: checkRootCommands('build', { roots: ['@sf/web#build'], command: 'next build' }),
    },
  ],
});

/** Проба графа test:int: сверх графа - конфиги int-тестов (intProbeReads) и их стаб. */
const INT_GRAPH_OPTS = {
  label: 'int-тесты читают',
  liveExtra: liveIntReads,
  extraReads: intProbeReads,
  extraStub: intProbeStub,
};

// Стаб-каталог под glob гейта - отказ с именем STUB_DIR, а не «проба не замечает» (вина не
// на пробе): проба графа на glob, который выбирает всё, на glob, который выбирает только
// глобальный стаб-вход, и на glob test:int, который выбирает setup int-стаба.
{
  const name = 'граф turbo: стаб-каталог под glob гейта - отказ с именем STUB_DIR';
  check(name, LIVE_GRAPH.guard(name, () => {
    const gate = { id: 'build-all' };
    const fileUnder = (files) => 'стаб-каталог ' + G.STUB_DIR + ' под glob build-all (' + files.join(', ') + ') - детектор не построить, смени STUB_DIR в selftest-graph.js';
    const all = checkTurboGraph('build', { label: 'сборка читает' })({ gate, runs: () => true });
    if (all !== fileUnder(G.STUB_FILES)) return 'glob на всё: ожидалось «' + fileUnder(G.STUB_FILES) + '», получено ' + JSON.stringify(all);
    const runs = (f) => f === G.STUB_GLOBAL || gateProbe('build').runs(f);
    const global = checkTurboGraph('build', { label: 'сборка читает' })({ gate, runs });
    if (global !== fileUnder([G.STUB_GLOBAL])) return 'glob со STUB_GLOBAL: ожидалось «' + fileUnder([G.STUB_GLOBAL]) + '», получено ' + JSON.stringify(global);
    const setup = intProbeStub(LIVE_GRAPH.snap.dry, LIVE_GRAPH.snap.ws).expect;
    const intRuns = (f) => f === setup || gateProbe('test:int').runs(f);
    const int = checkTurboGraph('test:int', INT_GRAPH_OPTS)({ gate, runs: intRuns });
    return int === fileUnder([setup]) || 'glob test:int с setup int-стаба: ожидалось «' + fileUnder([setup]) + '», получено ' + JSON.stringify(int);
  }));
}

/**
 * Пробы гейта с when always: правило сверяется прямо, а выбор - на файле вне glob всех
 * остальных гейтов (на одном файле always от glob иначе не отличить). Каждая сверка - с пробой
 * отказа: тот же гейт с when glob обязан её краснить (E0-12L; TECH_DEBT, строка 17.10.2026 E0-12A
 * «красная проба when в typecheck, inline-чеки»).
 */
function checkAlwaysGate(id) {
  // файл вне glob всех остальных гейтов: выбор на нём даёт только when always
  const OUTSIDE_ALL = 'docs/30_E0_TASKS.md';
  const narrowed = (gate) => Object.assign({}, gate, { when: 'glob:{apps/**}' });
  const whenAlways = (gate) => gate.when === 'always' || 'when гейта ' + gate.id + ' не always: ' + gate.when;
  check('гейт ' + id + ': when always', () => whenAlways(gateProbe(id).gate));
  check('гейт ' + id + ': сверка when always краснеет на when glob (проба отказа)', () =>
    typeof whenAlways(narrowed(gateProbe(id).gate)) === 'string' || 'when glob:{apps/**} принят за always');
  check('гейт ' + id + ': gates.js выбирает его на файле вне всех glob (' + OUTSIDE_ALL + ')', () =>
    gateProbe(id).runs(OUTSIDE_ALL) || 'gates.js не выбирает его на ' + OUTSIDE_ALL);
  check('гейт ' + id + ': с when glob gates.js на ' + OUTSIDE_ALL + ' его не выбирает (проба отказа)', () =>
    !selects(narrowed(gateProbe(id).gate), OUTSIDE_ALL) || 'gates.js выбирает гейт с when glob:{apps/**} на ' + OUTSIDE_ALL + ' - проба выбора не краснеет');
}

/**
 * Пробы гейта id с when always (checkAlwaysGate), который гоняет корневой скрипт id: cmd гейта -
 * ровно `pnpm <id>`, scripts[id] корневого package.json - ровно expected, scripts[repoScript] -
 * ровно repoExpected (checkRootScriptLines, с пробой отказа).
 */
function checkAlwaysScriptGate(id, expected, repoScript, repoExpected) {
  checkAlwaysGate(id);
  const cmd = rootScriptExtra(id, expected);
  check('гейт ' + id + ': ' + cmd.name, () => cmd.fn(gateProbe(id)));
  checkRootScriptLines('гейт ' + id, repoScript, repoExpected);
}

// Юнит-тесты читают и не-исходники (rules.sf.json, ci.yml, infra/docker/**), поэтому гейт test
// always (E0-02A, L-014). cmd гейта - pnpm test, поэтому test:repo сверяется как скрипт,
// точным равенством: echo или --passWithNoTests выключили бы корневые тесты (замок «копий нет»
// пресета) при зелёном гейте.
checkAlwaysScriptGate('test', 'turbo run test test:repo', 'test:repo', 'vitest run --config vitest.repo.config.mts');

// Гейт typecheck гоняет и пакеты, и корневой проект (tsconfig.json корня: test/, vitest.preset.ts,
// vitest.repo.config.mts - ADR-0011): выпавший typecheck:repo оставил бы корневые тесты без tsc.
checkAlwaysScriptGate('typecheck', 'turbo run typecheck typecheck:repo', 'typecheck:repo', 'tsc -p tsconfig.json');

// Int-тесты api, worker, db читают свои пакеты, их зависимости, @sf/config/vitest/setup,
// корневой vitest.preset.ts (ADR-0011) и корневой .env.test; glob гейта test:int - по факту чтения (docs/DECISIONS.md 11.10.2026, E0-02A, вопрос «Селектор гейта test:int: буква эпика, glob по графу зависимостей или always»).
// Граф пакетов и корни - у turbo (E0-12L), конфиги int-тестов - intProbeReads.
checkGateSelection('test:int', {
  runWhat: 'int-пакетах, их зависимостях, .env.test и корневых конфигах',
  skipWhat: 'web, api-client, вложенных конфигах и docs',
  mustRun: [
    'apps/api/src/index.ts',
    'apps/api/package.json',
    'apps/worker/src/index.ts',
    'apps/worker/package.json',
    'apps/worker/test/helpers.int.ts',
    'packages/db/src/index.ts',
    'packages/db/package.json',
    'packages/config/src/index.ts',
    'packages/config/package.json',
    'packages/core/src/index.ts',
    'packages/core/package.json',
    'packages/contracts/src/index.ts',
    'packages/contracts/package.json',
    'packages/integrations/youtube/src/index.ts',
    'packages/integrations/gemini/package.json',
    'packages/integrations/tts/src/index.ts',
    '.env.test',
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    'turbo.json',
    'tsconfig.base.json',
    'vitest.preset.ts',
  ],
  mustSkip: [
    'apps/web/src/app/page.tsx',
    'apps/web/package.json',
    'packages/api-client/src/index.ts',
    'docs/vitest.preset.ts',
    'vitest.repo.config.mts',
    'docs/30_E0_TASKS.md',
    'README.md',
    '.claude/hooks/rules.sf.json',
    'infra/docker-compose.yml',
    'scripts/tasks.mjs',
    'scripts/tsconfig.json',
    'apps/web/.env.test',
    'xapps/a.ts',
    'docs/apps/api/x.ts',
  ],
  extra: [
    rootScriptExtra('test:int', 'turbo run test:int --concurrency=1'),
    {
      name: 'каждый файл графа turbo run test:int (узлы от корней, globalCacheInputs), конфиги --config, setupFiles и фикстура testEnvFilePath под glob',
      graph: true,
      fn: checkTurboGraph('test:int', INT_GRAPH_OPTS),
    },
    {
      // состав корней зафиксирован перечнем: пропавший scripts['test:int'] у api, worker или db
      // сузил бы граф и glob молча; новый int-пакет дописывается сюда вместе с glob гейта
      name: 'корни turbo run test:int - ровно api, db, worker, команда каждого - ровно vitest run --config vitest.int.config.ts',
      graph: true,
      fn: checkRootCommands('test:int', {
        roots: ['@sf/api#test:int', '@sf/db#test:int', '@sf/worker#test:int'],
        command: 'vitest run --config vitest.int.config.ts',
      }),
    },
  ],
});

// Пробы графа build и test:int читают не только .claude/**, но и файлы проекта: то, из чего
// turbo строит граф (корневые package.json, pnpm-workspace.yaml, turbo.json; package.json и
// turbo.json каждого пакета и нового пакета по каждому шаблону pnpm-workspace.yaml -
// graphSources), и то, что проба test:int читает сверх графа (конфиги int-тестов, setup,
// фикстура). Гейт
// самопроверки обязан выбираться на каждом из них, иначе устаревший glob build или test:int
// уйдёт молча (docs/DECISIONS.md, 11.10.2026, E0-02A; E0-12L, 21.10.2026). Входы задач turbo
// (исходники пакетов) пробы не читают - их сверяет сам turbo, а пробы build/test:int сверяют
// их с glob этих гейтов. next.config.* ни одна проба не читает (граф сборки - у turbo), на нём
// самопроверка не выбирается.
// Боевые формы роута (ROUTE_FORMS) читают пробы S13/S14 - их сверка здесь же (E0-12D).
checkGateSelection('harness-selftest', {
  runWhat: '.claude/**, файлах, из которых turbo строит граф, файлах, которые читает проба test:int, и путях из note вне when',
  skipWhat: 'исходниках, lockfile, next.config.*, docs и путях из when и cmd гейтов-владельцев note',
  mustRun: [
    '.claude/hooks/gates.js',
    '.claude/hooks/rules.sf.json',
    '.claude/hooks/selftest-graph.js',
    '.claude/agents/worker.md',
    'package.json',
    'apps/web/package.json',
    'apps/api/package.json',
    'packages/core/package.json',
    'packages/integrations/youtube/package.json',
    'pnpm-workspace.yaml',
    'turbo.json',
    'packages/db/turbo.json',
    'apps/api/turbo.json',
    'apps/web/turbo.json',
    'apps/' + G.NEW_SIBLING + '/package.json',
    'packages/integrations/' + G.NEW_SIBLING + '/turbo.json',
    'apps/api/vitest.int.config.ts',
    'apps/worker/vitest.int.config.ts',
    'packages/db/vitest.int.config.ts',
    'packages/config/src/paths.ts',
    'packages/config/vitest/setup.ts',
    '.env.test',
    'test/container.test.ts',
  ],
  mustSkip: [
    'apps/web/next.config.ts',
    'apps/web/next.config.mjs',
    'packages/core/next.config.js',
    'docs/00_STATUS.md',
    'scripts/tasks.mjs',
    'scripts/compose-rules.mjs',
    'scripts/lib/paths.mjs',
    'scripts/lib/files.mjs',
    'apps/api/.env.test',
    'apps/api/vitest.config.ts',
    'packages/config/src/index.ts',
    'xapps/api/vitest.int.config.ts',
    'docs/apps/api/vitest.int.config.ts',
    'apps/web/src/app/page.tsx',
    'packages/core/src/index.ts',
    'pnpm-lock.yaml',
    'apps/api/src/server.ts',
    'apps/api/src/routes/index.ts',
    'apps/api/src/routes/README.md',
    'docs/30_E0_TASKS.md',
    'README.md',
    'scripts/check-no-search-list.mjs',
    'test/turbo-inputs.test.ts',
    'xapps/web/package.json',
    'docs/apps/web/package.json',
    'docs/turbo.json',
    'xapps/api/turbo.json',
    'docs/apps/api/turbo.json',
  ],
  extra: [
    {
      // notePathsOnDisk сверяет эти пути с диском: переименование такого файла должно
      // выбирать самопроверку локально, а не краснеть только в CI (E0-12F). Путь из when
      // или cmd гейта-владельца note самопроверку не выбирает (решение техлида к кругу 3).
      name: 'его выбирает каждый путь из note гейтов ' + NOTE_CHECKED_GATES.join(' и ') + ' вне их when и cmd',
      fn: ({ runs }) => {
        const named = NOTE_CHECKED_GATES.flatMap((id) => {
          const owner = gateProbe(id);
          return notePaths(owner.gate).filter((f) => !owner.runs(f) && !String(owner.gate.cmd || '').includes(f));
        });
        if (!named.length) return 'в note гейтов ' + NOTE_CHECKED_GATES.join(' и ') + ' нет ни одного пути вне их when и cmd';
        const stray = named.filter((f) => !runs(f));
        if (stray.length) return 'пути из note вне glob harness-selftest: ' + stray.join(', ');
        return { note: named.length + ' путей' };
      },
    },
    {
      name: 'его выбирает каждая боевая форма роута, которую читают пробы S13/S14',
      fn: ({ runs }) => {
        const stray = ROUTE_FORMS.filter((f) => !runs(f));
        if (stray.length) return 'пробы S13/S14 читают вне glob harness-selftest: ' + stray.join(', ');
        return { note: ROUTE_FORMS.length + ' файла' };
      },
    },
    {
      // Файл графа вне glob (пакет по шаблону tools/* в pnpm-workspace.yaml, turbo.json пакета)
      // меняет граф turbo, и без этой сверки его правка самопроверку не запускала бы (E0-12L;
      // TECH_DEBT, строки 11.10.2026 E0-01A «when harness-selftest знает только apps/**, packages/**»
      // и 11.10.2026 E0-02A «workspacePackages: шаблоны вне apps/, packages/»). Новый пакет по каждому шаблону workspace (graphSources) - и по шаблону без
      // единого пакета - требует glob на шаблон каталога, а не на перечень сегодняшних пакетов.
      // Детектор: стаб-пакет и стаб-шаблон G.STUB_PATTERN дают свои G.STUB_SOURCES.
      name: 'его выбирает каждый файл, из которого turbo строит граф (корневые package.json, pnpm-workspace.yaml, turbo.json; package.json и turbo.json каждого пакета dry и нового пакета по каждому шаблону workspace)',
      graph: true,
      fn: ({ gate, runs }) => {
        const { dry, patterns } = LIVE_GRAPH.snap;
        const sources = G.graphSources(dry, patterns);
        const bad = G.outsideGlob(runs, sources);
        if (bad.length) return G.refusal('граф turbo читает', gate.id, bad);
        const under = stubUnderGlob(runs, gate.id);
        if (under) return under;
        const stub = G.outsideGlob(runs, G.graphSources(G.stubNode(dry, 'build'), patterns.concat(G.STUB_PATTERN)));
        const blind = G.STUB_SOURCES.filter((f) => !stub.some((b) => b.startsWith(f + ' ')));
        if (blind.length) return 'проба не замечает ' + blind.join(', ') + ' вне glob ' + gate.id + ' на стабе';
        return { note: sources.length + ' файлов' };
      },
    },
    {
      // файлы берутся тем же liveIntReads, что и в пробе test:int: конфиг из --config с любым
      // именем, setup-модули, модуль testEnvFilePath, фикстура
      name: 'его выбирает каждый файл, который читает проба test:int сверх графа turbo',
      graph: true,
      fn: ({ gate, runs }) => {
        const reads = liveIntReads();
        const bad = G.outsideGlob(runs, reads);
        if (bad.length) return G.refusal('проба test:int читает', gate.id, bad);
        return { note: reads.length + ' файлов' };
      },
    },
  ],
});

// Последняя строка графа: отказ снимка (dry-JSON, манифесты, шаблоны workspace, tracked - git ls-files
// с файлами на диске; сбой git ls-files или stat файла - тоже здесь) называется здесь один раз,
// с перечнем проб графа, которые без него не гонялись (graphGate).
check('граф turbo: dry-JSON настоящего дерева (turbo run ' + GRAPH_SCRIPTS.join(' ') + ' --dry=json)', () => graphVerdict(LIVE_GRAPH));

// ------------------------------------------------------------------ 3. шапки агентов и команд
for (const kind of ['agents', 'commands']) {
  const dir = path.join(CLAUDE, kind);
  check('шапки ' + kind, () => {
    if (!fs.existsSync(dir)) return 'папки нет';
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    if (!files.length) return 'пусто';
    const bad = [];
    for (const f of files) {
      const fm = frontmatter(path.join(dir, f));
      if (!fm) { bad.push(f + ': нет фронтматтера'); continue; }
      if (!fm.description) bad.push(f + ': нет description');
      if (!fm.model) bad.push(f + ': нет model');
      else if (!ALLOWED_MODELS.has(fm.model)) bad.push(f + ': model ' + fm.model + ' вне ' + Array.from(ALLOWED_MODELS).join('/'));
      if (kind === 'agents' && !fm.name) bad.push(f + ': нет name');
    }
    return bad.length ? bad.join('; ') : { note: files.length + ' файлов' };
  });
}

// ------------------------------------------------------------------ 3a. скрипты PowerShell
check('install.ps1 / otkat.ps1 начинаются с UTF-8 BOM', () => {
  // Windows PowerShell 5.1 читает .ps1 без BOM в системной кодировке и ломается на кириллице
  // в строках; поймано владельцем при первом запуске установщика 05.09.2026.
  const bad = [];
  for (const f of ['install.ps1', 'otkat.ps1']) {
    const p = path.join(CLAUDE, f);
    if (!fs.existsSync(p)) { bad.push(f + ': нет файла'); continue; }
    const b = fs.readFileSync(p);
    if (!(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)) bad.push(f + ': без BOM');
  }
  return bad.length ? bad.join('; ') : true;
});

// ------------------------------------------------------------------ 4. settings.json
check('settings.json: все хуки существуют на диске', () => {
  const s = readJson(path.join(CLAUDE, 'settings.json'));
  const missing = [];
  let n = 0;
  for (const ev of Object.keys(s.hooks || {})) {
    for (const group of s.hooks[ev]) {
      for (const h of group.hooks || []) {
        const m = /\.claude\/hooks\/([A-Za-z0-9_.-]+\.js)/.exec(h.command || '');
        if (!m) { missing.push(ev + ': команда без пути к хуку'); continue; }
        n++;
        if (!fs.existsSync(path.join(HOOKS, m[1]))) missing.push(ev + ': ' + m[1]);
      }
    }
  }
  return missing.length ? missing.join('; ') : { note: n + ' регистраций' };
});

// ------------------------------------------------------------------ 5. живые пробы замков
const CWD = ROOT;
check('снятых замков нет: protect-files, scope, diff-boundaries, qa-lock не зарегистрированы', () => {
  // Решение владельца 06.09.2026: агент правит любые файлы и закрывает ход без счётчика правок.
  // Проба на пропуск - чтобы снятый замок не вернулся молча через settings.json или забытый файл.
  const s = readJson(path.join(CLAUDE, 'settings.json'));
  const text = JSON.stringify(s.hooks || {});
  const back = ['protect-files.js', 'scope.js', 'diff-boundaries.js', 'qa-lock.js'].filter((h) => text.includes(h) || fs.existsSync(path.join(HOOKS, h)));
  return back.length ? 'вернулись: ' + back.join(', ') : true;
});
check('commit-gate: отказ на --no-verify', () => {
  const r = probe('commit-gate.js', { tool_input: { command: 'git commit --no-verify -m "feat: x"' } }, CWD);
  return /deny/.test(r.out) && /no-verify/.test(r.out) ? true : 'нет отказа: ' + (r.out || r.err).slice(0, 120);
});
check('commit-gate: отказ на неконвенциональное сообщение', () => {
  const r = probe('commit-gate.js', { tool_input: { command: 'git commit -m "поправил всё"' } }, CWD);
  return /deny/.test(r.out) && /conventional/.test(r.out) ? true : 'нет отказа: ' + (r.out || r.err).slice(0, 120);
});
check('commit-gate: отказ на push --force', () => {
  const r = probe('commit-gate.js', { tool_input: { command: 'git push --force origin main' } }, CWD);
  return /deny/.test(r.out) && /истори/.test(r.out) ? true : 'нет отказа';
});
check('commit-gate: bash -c обёртка не обходит замок', () => {
  const r = probe('commit-gate.js', { tool_input: { command: 'bash -c "git commit -n -m \'feat: x\'"' } }, CWD);
  return /deny/.test(r.out) ? true : 'обёртка прошла';
});
/**
 * Временный репозиторий пробы не берёт из настроек машины ничего, что исполняет код, - как в
 * пробе сверки дерева: init без шаблонов (`--template=`), коммит с core.hooksPath на пустой
 * каталог. Иначе глобальный pre-commit красит пробу или исполняется в ней.
 */
check('commit-gate: isBootstrap - true без коммитов, false после первого', () => {
  const { isBootstrap } = require('./commit-gate.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-boot-'));
  const noHooks = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-boot-nohooks-'));
  const env = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@x', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@x' });
  const git = (args) => {
    const r = run('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + noHooks].concat(args), { cwd: tmp, env });
    if (r.error || r.status !== 0) throw new Error('git ' + args[0] + ': ' + String((r.error && r.error.message) || r.stderr).slice(0, 160));
  };
  try {
    git(['init', '-q', '--template=', '-b', 'main']);
    if (!isBootstrap(tmp)) return 'репозиторий без коммитов не опознан как bootstrap';
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'a');
    git(['add', 'a.txt']);
    git(['commit', '-q', '-m', 'chore: init']);
    if (isBootstrap(tmp)) return 'репозиторий с коммитом всё ещё bootstrap';
    return true;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(noHooks, { recursive: true, force: true });
  }
});
check('commit-gate: пропуск не-git команды', () => {
  const r = probe('commit-gate.js', { tool_input: { command: 'pnpm typecheck && ls -la' } }, CWD);
  return r.code === 0 && !r.out ? true : 'неожиданный ответ: ' + (r.out || r.err).slice(0, 120);
});
/** Каталоги репозитория, в которых живут файлы пробы: правило по glob пути, которого нет, ничего не сторожит. */
function missingDirs(rels) {
  const gone = rels.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  return gone.length ? 'нет ' + gone.join(', ') : '';
}

check('standards: замечание на any и console в новом файле, тишина на чистом', () => {
  const gone = missingDirs(['packages/core/src']);
  if (gone) return gone;
  return withScratchTree((tree) => {
    tree.write('packages/core/src/zz_selftest_bad.ts', 'export const x: any = 1;\nconsole.log(x);\n');
    tree.write('packages/core/src/zz_selftest_good.ts', 'export const y: number = 1;\n');
    const r1 = tree.standards('packages/core/src/zz_selftest_bad.ts');
    const r2 = tree.standards('packages/core/src/zz_selftest_good.ts');
    if (r1.code !== 2 || !/S01/.test(r1.err) || !/S03/.test(r1.err)) return 'any/console не пойманы: код ' + r1.code + ' ' + r1.err.slice(0, 160);
    if (r2.code !== 0 || r2.err) return 'чистый файл получил замечание: ' + r2.err.slice(0, 120);
    return true;
  });
});
/**
 * @sf/runtime (E0-12B, ADR-0012) - код процессов api и worker: console и process.env в его src
 * ловятся так же, как в apps; тесты пакета не ловятся (L-008: отказ и пропуск на боевом пути).
 * Крах standards.js - красный на обеих сторонах, как в standardsCases: код вне 0/2 или HOOK_ERROR.
 */
check('standards: console и process.env в packages/runtime/src пойманы, в его test - нет', () => {
  const gone = missingDirs(['packages/runtime/src', 'packages/runtime/test']);
  if (gone) return gone;
  const body = 'export const u = process.env.SF_X;\nconsole.log(u);\n';
  return withScratchTree((tree) => {
    tree.write('packages/runtime/src/zz_selftest_bad.ts', body);
    tree.write('packages/runtime/test/zz_selftest.test.ts', body);
    const r1 = tree.standards('packages/runtime/src/zz_selftest_bad.ts');
    const r2 = tree.standards('packages/runtime/test/zz_selftest.test.ts');
    if (r1.err.includes(HOOK_ERROR)) return 'src: standards.js упал внутри guard - ' + r1.err.slice(0, 160);
    if (r1.code !== 2 || !/S03/.test(r1.err) || !/S05/.test(r1.err)) return 'console/process.env в src не пойманы: код ' + r1.code + ' ' + r1.err.slice(0, 160);
    if (r2.code !== 0 && r2.code !== 2) return 'тест пакета: standards.js упал, код ' + r2.code + ' ' + r2.err.slice(0, 160);
    if (r2.err.includes(HOOK_ERROR)) return 'тест пакета: standards.js упал внутри guard - ' + r2.err.slice(0, 160);
    if (/S03|S05/.test(r2.err)) return 'тест пакета получил S03/S05: ' + r2.err.slice(0, 160);
    return true;
  });
});

/**
 * Отказ и пропуск одного правила standards на файле rel дерева пробы (L-008). refused / allowed -
 * тексты файлов целиком; отказ - код 2 и [id] в замечаниях, пропуск - код 0 или 2 и ни одного [id].
 * Крах standards.js - красный, а не пропуск: и код вне 0/2, и исключение, пойманное L.guard
 * (код 0, в stderr HOOK_ERROR - см. withScratchTree). Засчитывается
 * только своё правило (L-020): соседнее правило на том же тексте строку не красит и не зеленит.
 */
function standardsCases(id, rel, refused, allowed) {
  const tag = '[' + id + ']';
  return withScratchTree((tree) => {
    for (const body of refused) {
      tree.write(rel, body);
      const r = tree.standards(rel);
      if (r.err.includes(HOOK_ERROR)) return id + ' на запрещённом: standards.js упал внутри guard - ' + r.err.slice(0, 160);
      if (r.code !== 2 || !r.err.includes(tag)) return 'не пойман ' + id + ': ' + JSON.stringify(body.slice(0, 120)) + ' - код ' + r.code + ' ' + r.err.slice(0, 160);
    }
    for (const body of allowed) {
      tree.write(rel, body);
      const r = tree.standards(rel);
      if (r.code !== 0 && r.code !== 2) return id + ' на разрешённом: standards.js упал, код ' + r.code + ' ' + r.err.slice(0, 160);
      if (r.err.includes(HOOK_ERROR)) return id + ' на разрешённом: standards.js упал внутри guard - ' + r.err.slice(0, 160);
      if (r.err.includes(tag)) return id + ' на разрешённом: ' + JSON.stringify(body.slice(0, 120)) + ' - ' + r.err.slice(0, 160);
    }
    return { note: refused.length + ' отказ, ' + allowed.length + ' пропуск' };
  });
}

check('standards: серверные пакеты в apps/web/src (корень, подпуть, побочный импорт) пойманы S11, вход web - нет', () => {
  const gone = missingDirs(['apps/web/src/lib']);
  if (gone) return gone;
  const file = (line) => line + '\nexport const x = 1;\n';
  return standardsCases('S11', 'apps/web/src/lib/zz_selftest_s11.ts', [
    'import { withDeadline } from "@sf/runtime";',
    "import { createProbeRedis } from '@sf/runtime/redis';",
    'import { createDb } from "@sf/db";',
    'import { withFixture } from "@sf/db/test-support/fixture";',
    'import type { Env } from "@sf/config";',
    'import { loadRedisUrl } from "@sf/config/redis-url";',
    'import { REPO_ROOT } from "@sf/config/paths";',
    'import { createClient } from "@sf/youtube";',
    'import "@sf/db";',
    "import '@sf/config/redis-url';",
    'export { createDb } from "@sf/db";',
  ].map(file), [
    'import { env } from "@sf/config/server";',
    'import { createServerClient } from "@sf/api-client/server";',
    'import { BuildInfoSchema } from "@sf/contracts";',
    'import "server-only";',
  ].map(file));
});

/**
 * Форма роута (E0-12D, Р6): роут модуля routes регистрируется только defineRoute из
 * src/lib/route-schemas.ts. Обе боевые формы - сами файлы health и system из репозитория -
 * пропуск S13 и S14. Отказ S13 - прямой вызов любым из восьми методов, .route( и
 * withTypeProvider на любом получателе (app, server, child, fastify, this, instance, app?.,
 * цепочка с .get( на своей строке), с ( и с <; пропуск - defineRoute, Promise.all, строки
 * комментария. Отказ S14 - defineRoute в файле без ...errorResponses() в коде: без спреда,
 * спред только в комментарии (//, блочный, строка JSDoc, хвост строки); пропуск - ключ response:
 * в файле без defineRoute (лог, тело ответа). Точные статусы 4xx/5xx правило не видит - их
 * проверяет apps/api/test/route-shape.test.ts.
 */
function routeFile(lines) {
  return 'export function registerRoutes(app: AppInstance): void {\n' + lines.map((l) => '  ' + l + '\n').join('') + '}\n';
}
const ROUTE_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'];
const DEFINED_ROUTE = [
  'const responses = { ...errorResponses(), [OK_STATUS]: X };',
  'defineRoute(app, { method: "GET", url: "/x", responses, schema: { tags: ["x"] } }, handler);',
];
check('standards: S13 ловит регистрацию роута мимо defineRoute на любом получателе, боевые роуты - нет', () => {
  const gone = missingDirs(ROUTE_FORMS);
  if (gone) return gone;
  return standardsCases('S13', 'apps/api/src/routes/zz_selftest/index.ts', ROUTE_METHODS.map((m) =>
    routeFile(['app.' + m + '("/x", { schema: { response: responses } }, handler);']),
  ).concat(ROUTE_METHODS.map((m) =>
    routeFile(['app.' + m + '<{ Reply: SuccessReply<typeof responses> }>("/x", handler);']),
  )).concat([
    routeFile(['server.get("/x", handler);']),
    routeFile(['child.post<{ Body: B }>("/x", handler);']),
    routeFile(['fastify.put("/x", handler);']),
    routeFile(['this.delete("/x", handler);']),
    routeFile(['app?.get("/x", handler);']),
    routeFile(['app', '  .get("/x", handler);']),
    routeFile(['app.route({ method: "GET", url: "/x", handler });']),
    routeFile(['instance.route<G>({ method: "GET", url: "/x", handler });']),
    routeFile(['app.withTypeProvider<ZodTypeProvider>().get("/x", handler);']),
    routeFile(['const typed = app.withTypeProvider<ZodTypeProvider>();']),
  ]), ROUTE_FORMS.map((rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')).concat([
    routeFile(DEFINED_ROUTE),
    routeFile(DEFINED_ROUTE.concat(['const [a, b] = await Promise.all([one(), two()]);', 'const all = await Promise.all ([one()]);'])),
    routeFile(['// app.get("/x", handler);', '/**', ' * app.route({}) and app.withTypeProvider()', ' */', 'const x = 1;']),
  ]));
});
check('standards: S14 ловит defineRoute без ...errorResponses() в коде файла, боевые роуты - нет', () => {
  const gone = missingDirs(ROUTE_FORMS);
  if (gone) return gone;
  const route = DEFINED_ROUTE[1];
  return standardsCases('S14', 'apps/api/src/routes/zz_selftest/index.ts', [
    routeFile(['const responses = { [OK_STATUS]: X };', route]),
    routeFile(['const failures = errorResponses();', 'const responses = { ...failures, [OK_STATUS]: X };', route]),
    routeFile(['// const responses = { ...errorResponses(), [OK_STATUS]: X };', 'const responses = { [OK_STATUS]: X };', route]),
    routeFile(['/* ...errorResponses() */', 'const responses = { [OK_STATUS]: X };', route]),
    routeFile(['/**', ' * ...errorResponses() goes first', ' */', 'const responses = { [OK_STATUS]: X };', route]),
    routeFile(['const responses = { [OK_STATUS]: X }; // no ...errorResponses() here', route]),
  ], ROUTE_FORMS.map((rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')).concat([
    routeFile(DEFINED_ROUTE),
    routeFile(['request.log.info({ response: answer }, "answered");', 'const body = { response: x, ok: true };', 'reply.send({ response });']),
  ]));
});

/**
 * Направление зависимостей по импортам (E0-12D, §6, ADR-0007): contracts -> core, api-client ->
 * contracts. Формы - from, побочный import, export … from, import("…"), require("…"), в том
 * числе после строкового литерала в той же строке; граница имени - с обеих сторон: пакет, имя
 * которого лишь начинается с разрешённого (@sf/core-x), - отказ, подпуть разрешённого
 * (@sf/core/sub) - пропуск; импорт пакетом самого себя (@sf/contracts/health в contracts,
 * @sf/api-client/server в api-client) - не ребро, пропуск, как в test/dependency-direction.ts,
 * а пакет с тем же началом имени (@sf/contracts-x) - отказ. Текст импорта внутри строкового литерала - не импорт, пропуск.
 * vi.mock, require.resolve, from на другой строке и манифесты проверяет
 * test/dependency-direction.test.ts.
 */
check('standards: S15 ловит @sf/* кроме @sf/core в packages/contracts, @sf/core и самоимпорт - нет', () => {
  const gone = missingDirs(['packages/contracts/src']);
  if (gone) return gone;
  const file = (line) => line + '\nexport const x = 1;\n';
  return standardsCases('S15', 'packages/contracts/src/zz_selftest_s15.ts', [
    'import { env } from "@sf/config";',
    'import type { Env } from "@sf/config/server";',
    'export * from "@sf/db";',
    "import '@sf/runtime';",
    'export { createClient } from "@sf/youtube";',
    'import { createApiClient } from "@sf/api-client";',
    'import { x } from "@sf/core-x";',
    'import { x } from "@sf/corex";',
    'import { x } from "@sf/contracts-x";',
    'import { x } from "@sf/contractsx";',
    'const m = await import("@sf/config");',
    'const db = require("@sf/db");',
    'const n = "a"; const m = await import("@sf/db");',
    "const k = 'it' + \"s\"; export * from '@sf/runtime';",
  ].map(file), [
    'import { AppError } from "@sf/core";',
    "const s = \"import { x } from '@sf/db'\";",
    'const t = `export * from "@sf/config"`;',
    "import type { QueueName } from '@sf/core';",
    'import { QUEUE_NAMES } from "@sf/core/queues";',
    'const m = await import("@sf/core");',
    'import { HEALTH_STATUS_CODES } from "@sf/contracts/health";',
    'export * from "@sf/contracts";',
    'import { z } from "zod";',
    '// import { env } from "@sf/config";',
  ].map(file));
});
check('standards: S16 ловит @sf/* кроме @sf/contracts в packages/api-client, @sf/contracts и самоимпорт - нет', () => {
  const gone = missingDirs(['packages/api-client/src']);
  if (gone) return gone;
  const file = (line) => line + '\nexport const x = 1;\n';
  return standardsCases('S16', 'packages/api-client/src/zz_selftest_s16.ts', [
    'import { QUEUE_NAMES } from "@sf/core";',
    'import { env } from "@sf/config";',
    'import "@sf/config/server";',
    'export * from "@sf/db";',
    "export type { AppError } from '@sf/core';",
    'import { x } from "@sf/contracts-x";',
    'import { x } from "@sf/api-client-x";',
    'import { x } from "@sf/api-clientx";',
    'const m = await import("@sf/core");',
    'const env = require("@sf/config");',
    'const n = "a"; const m = await import("@sf/core");',
  ].map(file), [
    'import { ErrorBodySchema } from "@sf/contracts";',
    "const s = \"import { x } from '@sf/core'\";",
    "const t = `require('@sf/config')`;",
    "export type { ErrorBody } from '@sf/contracts';",
    'import { HEALTH_STATUS_CODES } from "@sf/contracts/health";',
    'const m = await import("@sf/contracts");',
    'import { createServerClient } from "@sf/api-client/server";',
    "export type { ApiClient } from '@sf/api-client';",
    'import "server-only";',
    ' * import { QUEUE_NAMES } from "@sf/core";',
  ].map(file));
});
/**
 * Пробы Stop- и UserPromptSubmit-хуков. Состояние - L.statePath(), то есть временная папка
 * прогона (SF_HOOK_STATE_DIR); помощник кладёт туда стартовое состояние пробы, а транскрипт -
 * в свою временную папку, которую убирает после пробы.
 */
function withProbeState(seed, fn) {
  const statePath = L.statePath();
  if (path.resolve(statePath) === path.resolve(LIVE_STATE)) return 'проба смотрит в боевой .qa-state: ' + statePath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-selftest-tr-'));
  const transcript = path.join(dir, 'transcript.jsonl');
  const state = () => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) { return {}; } };
  try {
    fs.writeFileSync(statePath, JSON.stringify(seed));
    return fn({
      transcript,
      state,
      exists: () => fs.existsSync(statePath),
      removeState: () => fs.rmSync(statePath, { force: true }),
      setState: (obj) => fs.writeFileSync(statePath, JSON.stringify(obj)),
      /** Замечание сессии без снятия: takeLengthNote над свежей копией состояния. */
      note: (sid) => L.takeLengthNote(state(), sid).text,
      /** Состаривает mtime файла состояния; mtime() после хука покажет, была ли запись. */
      settle: () => { const past = new Date(Date.now() - 60000); fs.utimesSync(statePath, past, past); return fs.statSync(statePath).mtimeMs; },
      mtime: () => fs.statSync(statePath).mtimeMs,
      say: (text, userTurns) => fs.writeFileSync(transcript, mkTranscript(text, userTurns || 1)),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Транскрипт jsonl: userTurns ходов пользователя, затем ответ ассистента text. */
function mkTranscript(text, userTurns) {
  let out = '';
  for (let i = 0; i < userTurns; i++) {
    out += JSON.stringify({ type: 'user', message: { role: 'user', content: 'ход ' + i } }) + '\n';
  }
  return out + JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';
}

/** Стартовое состояние с замечаниями [[sessionId, text, at], ...] - через операции lib.js. */
function seedWith(notes, extra) {
  const s = Object.assign({}, SEED, extra || {});
  for (const [sid, text, at] of notes) L.putLengthNote(s, sid, text, at);
  return s;
}

const LONG_ANSWER = Array.from({ length: 30 }, (_, i) => 'Строка рассуждений номер ' + i + ' про то, как шла работа и что было прочитано.').join('\n');
const PROSE_ANSWER = ['Задача: ' + 'длинное рассуждение о ходе работы без единого перевода строки, '.repeat(12), 'Дальше: ' + 'ещё один абзац пересказа того, что было прочитано и сделано, '.repeat(12)].join('\n');
const SHORT_ANSWER = 'Задача: E0-01 закрыта\nПроверки: gates ok\nДальше: /clear, затем /auto';
const SEED = { edits: 0, strayFiles: [], lastGates: { sentinel: 'selftest' } };
const kept = (st) => st.lastGates && st.lastGates.sentinel === 'selftest';
const NOTE_S1 = 'Прошлый ответ вышел длиннее порога: свой S1.\n';
const NOTE_S2 = 'Прошлый ответ вышел длиннее порога: свой S2.\n';
const lines = (n) => Array.from({ length: n }, (_, i) => 'Строка ' + i).join('\n');

check('answer-length: простыня не переписывается, замечание своей сессии уходит в следующий ход дословно', () =>
  withProbeState(SEED, (p) => {
    p.say(LONG_ANSWER);
    const r1 = probe('answer-length.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
    if (r1.code !== 0) return 'простыня возвращена на переписывание (код ' + r1.code + ')';
    const n = p.note('S1');
    if (!/непустых строк/.test(n)) return 'замечание о простыне не записано: ' + JSON.stringify(p.state()).slice(0, 160);
    if (!/нет задачи - в чат только суть/.test(n)) return 'в замечании нет ветки «нет задачи»: ' + JSON.stringify(n);
    if (!kept(p.state())) return 'answer-length потерял прочие поля состояния';
    const r2 = probe('remind-format.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
    if (r2.code !== 0 || r2.out !== n) return 'выдано не записанное замечание: ' + JSON.stringify(r2.out.slice(0, 80));
    if (p.note('S1') !== '') return 'замечание не снято после выдачи';
    if (!kept(p.state())) return 'remind-format потерял прочие поля состояния';
    return true;
  }));
check('answer-length: много прозы в малом числе строк даёт замечание', () =>
  withProbeState(SEED, (p) => {
    p.say(PROSE_ANSWER);
    const r = probe('answer-length.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
    if (r.code !== 0) return 'код ' + r.code;
    return /знаков прозы/.test(p.note('S1')) ? true : 'проза сверх порога прошла без замечания';
  }));
check('answer-length: граница порога - ровно maxLines строк без замечания, на одну больше - замечание', () =>
  withProbeState(SEED, (p) => {
    const max = Number(common && common.answerFormat && common.answerFormat.maxLines);
    if (!(max > 0)) return 'в rules.common.json нет answerFormat.maxLines';
    p.say(lines(max));
    probe('answer-length.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
    if (p.note('S1') !== '') return max + ' строк при пороге ' + max + ' дали замечание';
    p.say(lines(max + 1));
    probe('answer-length.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
    return p.note('S1').includes((max + 1) + ' непустых строк при ' + max) ? true : (max + 1) + ' строк прошли без замечания';
  }));
check('answer-length: короткий ответ снимает своё замечание, без перемен состояние не пишется', () =>
  withProbeState(seedWith([['S1', NOTE_S1, 1]]), (p) => {
    p.say(SHORT_ANSWER);
    probe('answer-length.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
    if (p.note('S1') !== '') return 'устаревшее замечание не снято коротким ответом';
    if (!kept(p.state())) return 'снятие замечания потеряло прочие поля состояния';
    const t0 = p.settle();
    probe('answer-length.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
    if (p.mtime() !== t0) return 'короткий ответ без замечания записал состояние';
    p.removeState();
    probe('answer-length.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
    if (p.exists()) return 'короткий ответ без состояния создал файл состояния';
    p.setState(SEED);
    p.say(LONG_ANSWER);
    probe('answer-length.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
    if (p.note('S1') === '') return 'простыня не дала замечания';
    const t1 = p.settle();
    probe('answer-length.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
    if (p.mtime() !== t1) return 'то же замечание записало состояние заново';
    return true;
  }));
check('answer-length: заход после отказа другого Stop-хука (stop_hook_active) меряется', () =>
  withProbeState(SEED, (p) => {
    p.say(LONG_ANSWER);
    probe('answer-length.js', { session_id: 'S1', stop_hook_active: true, transcript_path: p.transcript }, CWD);
    if (!/длиннее порога/.test(p.note('S1'))) return 'переписанная простыня не измерена';
    p.say(SHORT_ANSWER);
    probe('answer-length.js', { session_id: 'S1', stop_hook_active: true, transcript_path: p.transcript }, CWD);
    return p.note('S1') === '' ? true : 'замечание описывает уже заменённый ответ';
  }));
check('answer-length: две сессии не стирают замечания друг друга', () =>
  withProbeState(SEED, (p) => {
    p.say(LONG_ANSWER);
    probe('answer-length.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
    probe('answer-length.js', { session_id: 'S2', transcript_path: p.transcript }, CWD);
    if (p.note('S1') === '' || p.note('S2') === '') return 'вторая сессия стёрла замечание первой: ' + JSON.stringify(p.state()).slice(0, 160);
    p.say(SHORT_ANSWER);
    probe('answer-length.js', { session_id: 'S2', transcript_path: p.transcript }, CWD);
    if (p.note('S2') !== '') return 'короткий ответ не снял своё замечание';
    return p.note('S1') !== '' ? true : 'короткий ответ S2 снял замечание S1';
  }));
check('answer-length: ответ без текста снимает своё замечание, чужое остаётся', () =>
  withProbeState(seedWith([['S1', NOTE_S1, 1], ['S2', NOTE_S2, 2]]), (p) => {
    p.say('');
    const r = probe('answer-length.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
    if (r.code !== 0) return 'код ' + r.code;
    if (p.note('S1') !== '') return 'пустой ответ не снял своё замечание';
    return p.note('S2') === NOTE_S2 ? true : 'пустой ответ S1 тронул замечание S2';
  }));
check('answer-length: кап карты замечаний вытесняет старейшее', () =>
  withProbeState(seedWith(Array.from({ length: L.LENGTH_NOTES_CAP }, (_, i) => ['A' + i, 'старое ' + i + '\n', 1000 + i])), (p) => {
    p.say(LONG_ANSWER);
    probe('answer-length.js', { session_id: 'S9', transcript_path: p.transcript }, CWD);
    if (p.note('S9') === '') return 'новое замечание не записано';
    if (p.note('A0') !== '') return 'старейшее замечание не вытеснено: ' + Object.keys(p.state().lengthNotes || {}).join(',');
    for (let i = 1; i < L.LENGTH_NOTES_CAP; i++) if (p.note('A' + i) === '') return 'вытеснено не старейшее: A' + i;
    return true;
  }));
check('answer-length и remind-format: без session_id не пишут и не отдают', () =>
  withProbeState(seedWith([['S1', NOTE_S1, 1]]), (p) => {
    p.say(LONG_ANSWER);
    const t0 = p.settle();
    probe('answer-length.js', { transcript_path: p.transcript }, CWD);
    if (p.mtime() !== t0) return 'answer-length без session_id записал состояние';
    const r = probe('remind-format.js', { transcript_path: p.transcript }, CWD);
    if (r.code !== 0 || r.out) return 'remind-format без session_id выдал: ' + JSON.stringify(r.out.slice(0, 80));
    if (p.mtime() !== t0) return 'remind-format без session_id записал состояние';
    return p.note('S1') === NOTE_S1 ? true : 'замечание S1 потеряно';
  }));
check('answer-length и remind-format: session_id не по форме (__proto__, ../x) не пишут и не отдают', () =>
  withProbeState(seedWith([['S1', NOTE_S1, 1]]), (p) => {
    p.say(LONG_ANSWER);
    const t0 = p.settle();
    for (const sid of ['__proto__', 'constructor', '../x', 'x'.repeat(129)]) {
      const r1 = probe('answer-length.js', { session_id: sid, transcript_path: p.transcript }, CWD);
      if (r1.code !== 0) return 'answer-length на ' + sid.slice(0, 20) + ': код ' + r1.code;
      if (p.mtime() !== t0) return 'answer-length с session_id ' + sid.slice(0, 20) + ' записал состояние';
      const r2 = probe('remind-format.js', { session_id: sid, transcript_path: p.transcript }, CWD);
      if (r2.code !== 0 || r2.out) return 'remind-format с session_id ' + sid.slice(0, 20) + ' выдал: ' + JSON.stringify(r2.out.slice(0, 80));
      if (p.mtime() !== t0) return 'remind-format с session_id ' + sid.slice(0, 20) + ' записал состояние';
    }
    const ok1 = probe('answer-length.js', { session_id: 'Ab_9-z', transcript_path: p.transcript }, CWD);
    if (ok1.code !== 0 || p.note('Ab_9-z') === '') return 'номер сессии по форме не принят';
    return p.note('S1') === NOTE_S1 ? true : 'замечание S1 потеряно';
  }));
check('answer-length: граница по прозе - ровно maxProse знаков без замечания, на один больше - замечание', () =>
  withProbeState(SEED, (p) => {
    const max = Number(common && common.answerFormat && common.answerFormat.maxProse);
    if (!(max > 0)) return 'в rules.common.json нет answerFormat.maxProse';
    const prose = (n) => 'x'.repeat(n);
    if (L.proseLength(prose(max)) !== max) return 'проба собрала не ' + max + ' знаков прозы';
    p.say(prose(max));
    probe('answer-length.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
    if (p.note('S1') !== '') return max + ' знаков при пороге ' + max + ' дали замечание';
    p.say(prose(max + 1));
    probe('answer-length.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
    return p.note('S1').includes((max + 1) + ' знаков прозы при ' + max) ? true : (max + 1) + ' знаков прошли без замечания';
  }));
check('answer-length: без transcript_path не падает и снимает своё замечание, чужое остаётся', () =>
  withProbeState(seedWith([['S1', NOTE_S1, 1], ['S2', NOTE_S2, 2]]), (p) => {
    const r = probe('answer-length.js', { session_id: 'S1' }, CWD);
    if (r.code !== 0 || r.err) return 'код ' + r.code + ' ' + r.err.slice(0, 120);
    if (p.note('S1') !== '') return 'без транскрипта своё замечание не снято';
    if (p.note('S2') !== NOTE_S2) return 'без транскрипта тронуто чужое замечание';
    return kept(p.state()) ? true : 'потеряны прочие поля состояния';
  }));
check('answer-length: на диске замечание лежит как lengthNotes.<sessionId>.text', () =>
  withProbeState(SEED, (p) => {
    p.say(LONG_ANSWER);
    probe('answer-length.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
    const raw = JSON.parse(fs.readFileSync(L.statePath(), 'utf8'));
    const held = raw.lengthNotes && raw.lengthNotes.S1;
    if (!held || typeof held.text !== 'string' || !/непустых строк/.test(held.text)) return 'на диске нет lengthNotes.S1.text: ' + JSON.stringify(raw).slice(0, 160);
    if (typeof held.at !== 'number') return 'у lengthNotes.S1 нет числового at';
    return Object.keys(raw.lengthNotes).join(',') === 'S1' ? true : 'лишние ключи: ' + Object.keys(raw.lengthNotes).join(',');
  }));
check('writeState: запись заменяет файл целиком через rename, *.tmp не остаётся', () =>
  withProbeState(SEED, (p) => {
    const sp = L.statePath();
    const dir = path.dirname(sp);
    const tmpLeft = () => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-selftest-link-')), 'old');
    try {
      fs.linkSync(sp, link);
      const before = fs.readFileSync(link, 'utf8');
      L.writeState(Object.assign({}, SEED, { edits: 7 }));
      if (JSON.parse(fs.readFileSync(sp, 'utf8')).edits !== 7) return 'новое состояние не разбирается или не записано';
      if (fs.readFileSync(link, 'utf8') !== before) return 'файл переписан на месте, а не заменён rename';
      if (tmpLeft().length) return 'остался временный файл: ' + tmpLeft().join(',');
      p.removeState();
      fs.mkdirSync(sp);
      try {
        L.writeState(SEED);
        if (tmpLeft().length) return 'неудачная запись оставила временный файл: ' + tmpLeft().join(',');
      } finally {
        fs.rmSync(sp, { recursive: true, force: true });
      }
      return true;
    } finally {
      fs.rmSync(path.dirname(link), { recursive: true, force: true });
    }
  }));
check('writeState: rename падает EPERM - три попытки, затем запись напрямую, *.tmp нет', () =>
  withProbeState(SEED, () => {
    const sp = L.statePath();
    const dir = path.dirname(sp);
    const real = fs.renameSync;
    let calls = 0;
    fs.renameSync = function renameEperm() {
      calls++;
      const e = new Error('EPERM: operation not permitted, rename');
      e.code = 'EPERM';
      throw e;
    };
    try {
      L.writeState(Object.assign({}, SEED, { edits: 9 }));
    } finally {
      fs.renameSync = real;
    }
    if (calls !== 3) return 'попыток rename: ' + calls + ', ждали 3';
    const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
    if (st.edits !== 9) return 'после трёх EPERM состояние не обновлено: ' + JSON.stringify(st).slice(0, 120);
    const left = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    return left.length ? 'остался временный файл: ' + left.join(',') : true;
  }));
const SEED_QA = Object.assign({}, SEED, { lastQa: { sentinel: 'selftest' } });
const keptQa = (st) => kept(st) && st.lastQa && st.lastQa.sentinel === 'selftest';
check('answer-length и remind-format: испорченные lengthNotes (массив, строка, null, text числом) - код 0, lastQa/lastGates на месте', () =>
  withProbeState(SEED_QA, (p) => {
    const cases = [['массив', []], ['строка', 'x'], ['null', null], ['text числом', { S1: { text: 5, at: 1 } }]];
    for (const [label, notes] of cases) {
      p.setState(Object.assign({}, SEED_QA, { lengthNotes: notes }));
      p.say(SHORT_ANSWER, 1);
      const r1 = probe('remind-format.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
      if (r1.code !== 0 || r1.err || r1.out) return 'remind-format на lengthNotes ' + label + ': код ' + r1.code + ' ' + (r1.out || r1.err).slice(0, 120);
      if (!keptQa(p.state())) return 'remind-format на lengthNotes ' + label + ' потерял lastQa/lastGates';
      p.say(LONG_ANSWER);
      const r2 = probe('answer-length.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
      if (r2.code !== 0 || r2.err) return 'answer-length на lengthNotes ' + label + ': код ' + r2.code + ' ' + r2.err.slice(0, 120);
      if (!/непустых строк/.test(p.note('S1'))) return 'answer-length на lengthNotes ' + label + ' не записал замечание';
      if (!keptQa(p.state())) return 'answer-length на lengthNotes ' + label + ' потерял lastQa/lastGates';
    }
    return true;
  }));
check('readState: файл null, массив, строка, обрыв JSON - дефолт и хук пишет замечание; иная ошибка чтения пробрасывается без записи', () =>
  withProbeState(SEED, (p) => {
    const sp = L.statePath();
    for (const [label, body] of [['null', 'null'], ['массив', '[]'], ['строка', '"x"'], ['обрыв JSON', '{"edits":']]) {
      fs.writeFileSync(sp, body);
      const st = L.readState();
      if (!st || typeof st !== 'object' || Array.isArray(st) || st.edits !== 0) return 'readState на файле ' + label + ' отдал ' + JSON.stringify(st);
      fs.writeFileSync(sp, body);
      p.say(LONG_ANSWER);
      const r = probe('answer-length.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
      if (r.code !== 0 || r.err) return 'answer-length на файле ' + label + ': код ' + r.code + ' ' + r.err.slice(0, 120);
      if (!/непустых строк/.test(p.note('S1'))) return 'answer-length на файле ' + label + ' не записал замечание';
    }
    p.removeState();
    fs.mkdirSync(sp);
    try {
      let thrown = null;
      try {
        L.readState();
      } catch (e) {
        thrown = e;
      }
      if (!thrown) return 'readState на каталоге вместо файла отдал дефолт, а не ошибку';
      for (const hook of ['answer-length.js', 'remind-format.js']) {
        const r = probe(hook, { session_id: 'S1', transcript_path: p.transcript }, CWD);
        if (r.code !== 0) return hook + ' на ошибке чтения состояния: код ' + r.code;
      }
      if (!fs.statSync(sp).isDirectory() || fs.readdirSync(sp).length) return 'на ошибке чтения состояние записано';
      const left = fs.readdirSync(path.dirname(sp)).filter((f) => f.endsWith('.tmp'));
      return left.length ? 'на ошибке чтения остался временный файл: ' + left.join(',') : true;
    } finally {
      fs.rmSync(sp, { recursive: true, force: true });
    }
  }));
check('statePath: пустой SF_HOOK_STATE_DIR - боевой путь', () => {
  const was = process.env.SF_HOOK_STATE_DIR;
  try {
    process.env.SF_HOOK_STATE_DIR = '';
    const p = path.resolve(L.statePath());
    if (p !== path.resolve(L.STATE_DIR, '.qa-state')) return 'пустая переменная дала путь ' + p;
    return p === LIVE_STATE ? true : 'путь ' + p + ' не совпал с боевым ' + LIVE_STATE;
  } finally {
    process.env.SF_HOOK_STATE_DIR = was;
  }
});
check('remind-format: отдаёт только своё замечание, чужое остаётся', () =>
  withProbeState(seedWith([['S1', NOTE_S1, 1], ['S2', NOTE_S2, 2]]), (p) => {
    p.say(SHORT_ANSWER);
    const r1 = probe('remind-format.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
    if (r1.code !== 0 || r1.out !== NOTE_S1) return 'выдано не своё замечание: ' + JSON.stringify(r1.out.slice(0, 80));
    if (p.note('S1') !== '') return 'своё замечание не снято после выдачи';
    if (p.note('S2') !== NOTE_S2) return 'выдача S1 сняла замечание S2';
    const t0 = p.settle();
    const r2 = probe('remind-format.js', { session_id: 'NEW', transcript_path: p.transcript }, CWD);
    if (r2.out) return 'новой сессии отдано чужое: ' + JSON.stringify(r2.out.slice(0, 80));
    if (p.mtime() !== t0) return 'сессия без замечания записала состояние';
    if (p.note('S2') !== NOTE_S2) return 'новая сессия сняла чужое замечание';
    return kept(p.state()) ? true : 'remind-format потерял прочие поля состояния';
  }));
check('remind-format: session_id ../x при посеянном замечании - stdout пуст, состояние не пишется', () =>
  withProbeState(seedWith([['../x', NOTE_S1, 1], ['S2', NOTE_S2, 2]]), (p) => {
    p.say(SHORT_ANSWER, 1);
    const t0 = p.settle();
    const r = probe('remind-format.js', { session_id: '../x', transcript_path: p.transcript }, CWD);
    if (r.code !== 0 || r.out) return 'remind-format с session_id ../x выдал: ' + JSON.stringify(r.out.slice(0, 80));
    if (p.mtime() !== t0) return 'remind-format с session_id ../x записал состояние';
    return p.note('S2') === NOTE_S2 ? true : 'замечание S2 потеряно';
  }));
check('remind-format: короткая сессия без замечания - тишина, длинная - замечание и памятка', () =>
  withProbeState(SEED, (p) => {
    p.say(SHORT_ANSWER, 1);
    const r1 = probe('remind-format.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
    if (r1.code !== 0 || r1.out) return 'короткая сессия без замечания получила текст: ' + r1.out.slice(0, 80);
    p.setState(seedWith([['S1', NOTE_S1, 1]]));
    p.say(SHORT_ANSWER, 8);
    const r2 = probe('remind-format.js', { session_id: 'S1', transcript_path: p.transcript }, CWD);
    if (!r2.out.startsWith(NOTE_S1)) return 'на длинной сессии замечание не отдано дословно';
    if (!/Формат ответа держи такой/.test(r2.out.slice(NOTE_S1.length))) return 'на длинной сессии нет памятки';
    return true;
  }));
check('report-honesty: «зелено» без прогона отбивается', () =>
  withProbeState({ edits: 0, strayFiles: [] }, (p) => {
    p.say('Сделано. Все проверки зелёные.\nЗадача: E0-01 закрыта\nОбвязка: не менялась');
    const r = probe('report-honesty.js', { transcript_path: p.transcript }, CWD);
    return r.code === 2 && /зелён|зелен/.test(r.err) ? true : 'неподтверждённое «зелено» прошло (код ' + r.code + ')';
  }));
check('gates.js --list отрабатывает', () => {
  const r = run(process.execPath, [path.join(HOOKS, 'gates.js'), '--list', '--repo=sf'], { cwd: ROOT });
  return r.status === 0 && /lint/.test(String(r.stdout)) ? true : 'код ' + r.status + ': ' + String(r.stderr || r.stdout).slice(0, 160);
});

/**
 * Сверка дерева в последней пробе ловит то, ради чего снимок такой (E0-12D, B8 круга 1):
 * перезапись файла, который уже `M`, и новый файл под .gitignore. Проверяется на временном
 * репозитории теми же repoSnapshot и treeDiff: без изменений разницы нет, после перезаписи
 * `M`-файла и записи в игнорируемый каталог - обе записи названы. Временный репозиторий не
 * берёт ничего из настроек машины, что исполняет код: init без шаблонов (`--template=`, иначе
 * init.templateDir кладёт свои хуки), коммит с core.hooksPath на пустой каталог (иначе
 * глобальный pre-commit красит пробу или исполняется в ней).
 */
check('сверка дерева ловит перезапись M-файла и новый игнорируемый каталог, без изменений - тишина', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-selftest-git-'));
  const noHooks = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-selftest-nohooks-'));
  try {
    const git = (args) => {
      const r = run('git', ['-c', 'user.name=selftest', '-c', 'user.email=selftest@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=' + noHooks].concat(args), { cwd: dir });
      if (r.error || r.status !== 0) throw new Error('git ' + args[0] + ': ' + String((r.error && r.error.message) || r.stderr).slice(0, 160));
    };
    git(['init', '-q', '--template=']);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'coverage/\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'probe']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    const before = repoSnapshot(dir);
    const still = treeDiff(before, repoSnapshot(dir));
    if (still.length) return 'разница без изменений: ' + still.join(', ');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'three\n');
    fs.mkdirSync(path.join(dir, 'coverage'));
    fs.writeFileSync(path.join(dir, 'coverage', 'x.txt'), 'x\n');
    const diff = treeDiff(before, repoSnapshot(dir));
    const missed = ['изменилось содержимое  M a.txt', 'появилось !! coverage/'].filter((line) => !diff.includes(line));
    return missed.length ? 'сверка не видит: ' + missed.join(', ') + ' (видит: ' + (diff.join(', ') || 'ничего') + ')' : { note: diff.length + ' записи' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(noHooks, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ боевое состояние
check('боевой .qa-state после проб байт в байт прежний', () => {
  const now = liveBytes();
  const same = LIVE_BYTES === null ? now === null : now !== null && LIVE_BYTES.equals(now);
  if (same) return true;
  return 'боевой ' + LIVE_STATE + ' изменился за прогон: ' +
    (LIVE_BYTES === null ? 'не было' : LIVE_BYTES.length + ' байт') + ' -> ' + (now === null ? 'нет' : now.length + ' байт');
});
check('пробы не оставили файлов в репозитории: записи git status, их содержимое и игнорируемые записи до и после прогона те же', () => {
  if (!LIVE_TREE) return 'снимок дерева до проб не снят: ' + LIVE_TREE_ERROR;
  const now = repoSnapshot();
  const diff = treeDiff(LIVE_TREE, now);
  if (!diff.length) return { note: now.size + ' записей' };
  return 'за прогон: ' + diff.join(', ').slice(0, 300) + ' (если файлы в это время правили руками или другим процессом - перезапусти)';
});

// ------------------------------------------------------------------ итог
report();

/** Строки results и счёт; код выхода 1, если красна хоть одна (зовёт и loadGraphModule). */
function report() {
  let red = 0;
  for (const r of results) {
    if (!r.ok) red++;
    console.log((r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.note ? '  - ' + r.note : ''));
  }
  console.log(red ? 'Самопроверка обвязки: КРАСНАЯ, ' + red + ' из ' + results.length : 'Самопроверка обвязки: зелёная, ' + results.length + ' проверок');
  process.exit(red ? 1 : 0);
}
