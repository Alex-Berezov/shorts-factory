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
  'gates.js', 'selftest-graph.js', 'selftest-vitest.mjs', 'selftest-temp.js',
];

const results = [];
function ok(name, note) { results.push({ ok: true, name, note }); }
function fail(name, note) { results.push({ ok: false, name, note }); }
/**
 * Результат пробы, которая не гонялась: её отказ уже назван своей красной строкой. Его отдаёт
 * только snapshotGate.guard, и только когда строка «граф turbo: dry-JSON настоящего дерева» красная.
 */
const SKIPPED = Symbol('skipped');
/**
 * Исключение пробы, которой нужен ленивый снимок (snapshotGate с lazy: take), а он не снят: проба
 * не гонялась, её имя уходит в перечень снимка (state.blocked), строки нет - отказ называет одна
 * строка снимка.
 */
class GateBlocked extends Error {
  constructor(state) {
    super('снимок не снят: ' + state.error);
    this.state = state;
  }
}
/** Итог пробы name: { ok, name, note } или null - проба не гонялась (SKIPPED, GateBlocked). */
function outcome(name, fn) {
  try {
    const r = fn();
    if (r === SKIPPED) return null;
    if (r === false) return { ok: false, name, note: '' };
    if (typeof r === 'string') return { ok: false, name, note: r };
    return { ok: true, name, note: typeof r === 'object' && r && r.note ? r.note : '' };
  } catch (e) {
    if (e instanceof GateBlocked) {
      e.state.blocked.push(name);
      return null;
    }
    return { ok: false, name, note: (e && e.message) || String(e) };
  }
}
function check(name, fn) {
  const r = outcome(name, fn);
  if (r) results.push(r);
}

/**
 * Место под выборку всего дерева у близнеца trackedFiles - LISTING_MAX_BUFFER из
 * scripts/lib/files.mjs (сверяет проба «близнец trackedFiles»).
 */
const LISTING_MAX_BUFFER = 64 * 1024 * 1024;

function run(cmd, args, opts) {
  return cp.spawnSync(cmd, args, Object.assign({ encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, opts || {}));
}

/**
 * Реестр временных каталогов прогона (E0-12T, TECH_DEBT 19.10.2026 E0-12D «каталоги sf-selftest-* в
 * %TEMP%»): модуль selftest-temp.js, его же берёт дочерний node пробы обработчика exit.
 */
const { makeTempRegistry } = require('./selftest-temp.js');
const TEMP = makeTempRegistry({ fs, os, path, isNotFile: L.isNotFile });
const tempDir = TEMP.tempDir;
const dropTemp = TEMP.dropTemp;
/**
 * Дочерние процессы, запущенные без ожидания (startVitest): выход прогона до их ответа (report()
 * внутри пробы, Ctrl+C) снимает их SIGKILL до снятия каталогов реестра - иначе на Windows каталог с
 * открытыми ими файлами stdout/stderr не снимается (EBUSY) и остаётся в %TEMP%. children - набор
 * (по умолчанию LIVE_CHILDREN; кейс берёт свой).
 */
const LIVE_CHILDREN = new Set();
function killLiveChildren(children = LIVE_CHILDREN) {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch (_) {
      // выход процесса: ребёнок уже вышел или не запускался
    }
  }
  children.clear();
}
// report()/process.exit внутри пробы и Ctrl+C (SIGINT -> exit(130)) минуют finally проб: каталоги
// реестра снимает выход процесса. Убитый снаружи процесс (TerminateProcess, SIGKILL) обработчиков
// не зовёт - так остались каталоги пачки 19.10.2026 (файл дела E0-12T, шаг 11).
// обработчик exit получает код выхода первым аргументом - набор ему не передаётся
function killLiveChildrenOnExit() {
  killLiveChildren();
}
process.on('exit', killLiveChildrenOnExit);
process.on('exit', TEMP.dropAll);
process.on('SIGINT', () => process.exit(130));

/**
 * Снятие каталога, чей сбой не подменяет итог пробы и не роняет прогон до report(): EBUSY/EPERM
 * на Windows (каталог держит только что вышедший дочерний процесс) - запись в DROP_FAILURES, её
 * называет проба «временные каталоги прогона сняты» в конце, каталог остаётся в реестре (live) и
 * снимается ещё раз обработчиком exit. opts - как у dropTemp. true - снят.
 */
const DROP_FAILURES = [];
function releaseTemp(dir, opts) {
  try {
    dropTemp(dir, opts);
    return true;
  } catch (e) {
    DROP_FAILURES.push(dir + ': ' + ((e && e.message) || String(e)));
    return false;
  }
}

/**
 * Пути p нет: lstat отвечает ENOENT или ENOTDIR (L.isNotFile). Иная ошибка (EACCES, EPERM) -
 * исключение, а не «нет»: existsSync глотает любую ошибку, и недоступный файл сошёл бы за
 * отсутствующий (L-027, L-028). lstat - подмена для кейса.
 */
function absent(p, lstat = fs.lstatSync) {
  try {
    lstat(p);
    return false;
  } catch (e) {
    if (L.isNotFile(e)) return true;
    throw e;
  }
}

/** Пустой каталог хуков git на весь прогон: core.hooksPath временных репозиториев проб. */
let noHooks = null;
function noHooksDir() {
  if (!noHooks) noHooks = tempDir('nohooks');
  return noHooks;
}

/** Имя программы git в помощнике git(); имя в кавычках в другом месте или вызов мимо помощника - красный (кейс ниже). */
const GIT_BIN = 'git';
/**
 * Все вызовы git проб selftest (E0-12T, TECH_DEBT 19.10.2026 E0-12D круг 6 «изоляция git в пробах», решение техлида Р6): всегда
 * `-c core.fsmonitor=false` - глобальный fsmonitor - внешняя команда, git исполнил бы её в пробе;
 * opts.isolated - временный репозиторий пробы с коммитом: `-c core.hooksPath=<пустой каталог
 * прогона>` и `-c commit.gpgsign=false` (глобальный pre-commit и подпись машины в пробе не
 * исполняются). opts.cwd, opts.env, opts.maxBuffer - в spawn; opts.spawn и opts.bin - подмена
 * для кейсов. Результат - как у run. Боевые хуки (commit-gate, diff-hash, gates.js) и
 * isolatedGitEnv тестов этим помощником не покрыты (TECH_DEBT, Р6).
 */
function git(args, opts) {
  const o = opts || {};
  const pre = ['-c', 'core.fsmonitor=false'];
  if (o.isolated) pre.push('-c', 'core.hooksPath=' + noHooksDir(), '-c', 'commit.gpgsign=false');
  const spawnOpts = {};
  for (const key of ['cwd', 'env', 'maxBuffer']) if (o[key] !== undefined) spawnOpts[key] = o[key];
  return (o.spawn || run)(o.bin || GIT_BIN, pre.concat(args), spawnOpts);
}
/**
 * git(args, opts), чей сбой - исключение с подкомандой и stderr: временные репозитории проб.
 * Подкоманда - первый аргумент, который не пара `-c <ключ=значение>` (замечание ревью C13 E0-12T:
 * `-c user.name=…` впереди съедал имя шага).
 */
function gitStrict(args, opts) {
  const r = git(args, opts);
  if (r.error || r.status !== 0) {
    const sub = args.find((a, i) => a !== '-c' && args[i - 1] !== '-c');
    throw new Error('git ' + String(sub) + ': ' + String((r.error && r.error.message) || r.stderr).slice(0, 160));
  }
  return r;
}

// ------------------------------------------------------------------ 1. синтаксис хуков
/**
 * Проба синтаксиса (`node --check`) - один раз на файл за прогон: её результат берёт и загрузчик
 * модуля графа (SYNTAX_OK), второго `node --check` нет.
 */
const SYNTAX_OK = new Map();
for (const f of HOOK_FILES) {
  check('синтаксис ' + f, () => {
    const p = path.join(HOOKS, f);
    if (!fs.existsSync(p)) return 'файла нет';
    const r = run(process.execPath, ['--check', p]);
    SYNTAX_OK.set(f, r.status === 0);
    return r.status === 0 ? true : String(r.stderr).split('\n')[0];
  });
}

/** Строки текста text, на которых re находит совпадение: номера с 1. */
function linesMatching(text, re) {
  return text.split(/\r?\n/).map((line, i) => (re.test(line) ? i + 1 : 0)).filter(Boolean);
}
/**
 * Модули самопроверки без exit процесса: selftest-vitest.mjs выходит, когда цикл событий опустел
 * (решение техлида Р3 E0-12T: vite снимает свой `<конфиг>.timestamp-*.mjs` неожидаемым unlink, и
 * ранний выход оставил бы файл в дереве); selftest-temp.js процессом не распоряжается (решение
 * техлида B4 E0-12T). Сверка по тексту без комментариев не строится, поэтому запрещено само имя
 * вызова в любом месте файла (сканер linesMatching); сторона отказа - текст со вставленным вызовом.
 */
const EXIT_CALL = /\bprocess\s*\.\s*(?:exit|reallyExit|abort)\b/;
const NO_EXIT_FILES = ['selftest-vitest.mjs', 'selftest-temp.js'];
check('selftest-vitest.mjs и selftest-temp.js не выходят через exit процесса (Р3, B4), вызов exit в тексте - отказ', () => {
  const bad = [];
  for (const f of NO_EXIT_FILES) {
    for (const n of linesMatching(fs.readFileSync(path.join(HOOKS, f), 'utf8'), EXIT_CALL)) bad.push(f + ':' + n);
  }
  if (bad.length) return 'exit процесса: ' + bad.join(', ');
  return linesMatching('const a = 1;\nprocess' + '.exit(0);\n', EXIT_CALL).join() === '2' || 'вызов exit в тексте не пойман - сверка слепа';
});

/**
 * Модуль графа selftest-graph.js грузится после пробы синтаксиса (её результат - SYNTAX_OK), как
 * gates.js - после пробы require (gatesModuleSafe). Синтаксическая ошибка - красная строка синтаксиса,
 * исключение при загрузке - одна строка здесь; в обоих случаях G = null: пробы графа не гоняются
 * (строка «граф turbo: dry-JSON настоящего дерева» называет их), остальные пробы идут.
 */
const G = loadGraphModule();
function loadGraphModule() {
  if (SYNTAX_OK.get('selftest-graph.js') !== true) return null;
  try {
    return require(path.join(HOOKS, 'selftest-graph.js'));
  } catch (e) {
    fail('selftest-graph.js загружается require', (e && e.message) || String(e));
    return null;
  }
}

/** Ключ скрипта в тексте отказа: из модуля графа, без модуля - имя скрипта как есть. */
function scriptKey(script) {
  return G ? G.scriptKey(script) : script;
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
    if (L.isGone(e)) return null;
    throw e;
  }
}
const LIVE_BYTES = liveBytes();
/**
 * Снимок рабочего дерева до первой пробы: последняя проба сверяет с ним текущий. Файлы проб
 * живут во временных каталогах (tempDir, withScratchTree), и любая разница - проба, которая пишет
 * мимо них или не убрала за собой. В снимке (E0-12D, B8 круга 1; E0-12T, решение техлида Р4 E0-12L):
 *   - каждая запись git status (новый, изменённый, удалённый файл) с отпечатком содержимого:
 *     перезапись файла, который уже был `M` или `??`, меняет отпечаток, а не строку status;
 *   - каждый игнорируемый файл (`!!` поштучно: `--ignored=traditional --untracked-files=all`) с
 *     отпечатком размер+mtime: новый или переписанный файл внутри уже игнорируемого каталога
 *     (`coverage/`, `.turbo/`, `vitest.int.config.ts.timestamp-*.mjs` рядом с конфигом - Р3
 *     E0-12T) виден; исключений нет: turbo dry в `.turbo/` не пишет (замер E0-12T, шаг 0);
 *   - `node_modules` - кроме: их файлы не перечисляются (pathspec exclude с маской node_modules,
 *     десятки тысяч файлов), каталоги - по одному (`git ls-files --others --ignored --directory`), как
 *     прежде. Условие: проба не пишет в node_modules - новый файл внутри них снимок не видит.
 * Правка руками или другой процесс в то же время (IDE, turbo daemon) даёт ту же красную строку -
 * тогда перезапуск; пути, которые пишет сессия во время фонового прогона (.qa-state, файлы дела),
 * treeDiff не сравнивает - именованный перечень TREE_NOT_COMPARED (ОВ2 E0-12T).
 * root - корень рабочего дерева (по умолчанию репозиторий; проба сверки берёт временный).
 * Возвращает Map<запись, отпечаток>; сбой git - исключение (его ловит проба, не верхний уровень).
 */
function repoSnapshot(root = ROOT) {
  const listing = (args) => {
    const r = git(args, { cwd: root, maxBuffer: LISTING_MAX_BUFFER });
    if (r.error || r.status !== 0) throw new Error('git ' + args[0] + ': ' + String((r.error && r.error.message) || r.stderr || 'код ' + r.status).slice(0, 160));
    return String(r.stdout).split('\0');
  };
  const fingerprint = (rel, ignored) => snapshotPrint(path.join(root, rel), ignored);
  const snap = new Map();
  const status = listing(['status', '--porcelain=v1', '-z', '--ignored=traditional', '--untracked-files=all', '--', '.', ':(exclude,glob)**/node_modules/**']);
  for (let i = 0; i < status.length; i++) {
    const e = status[i];
    if (!e) continue;
    const xy = e.slice(0, 2);
    const rel = e.slice(3);
    // у переименования и копии за записью идёт прежний путь отдельным полем -z
    if (/[RC]/.test(xy)) i++;
    snap.set(xy + ' ' + rel, fingerprint(rel, xy === '!!'));
  }
  // игнорируемые каталоги целиком (--directory); отбор node_modules - регэксп ниже: прежний pathspec
  // `**/node_modules/` с --directory пропускал и .turbo/, dist/ (замер Fix 2 E0-12T: 28 записей, из них
  // 13 node_modules - те же 13, что без него), фильтром он не был (замечание ревью C14 E0-12T)
  for (const dir of listing(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])) {
    if (/(?:^|\/)node_modules\/$/.test(dir)) snap.set('!! ' + dir, '');
  }
  return snap;
}
/**
 * Отпечаток записи снимка repoSnapshot по абсолютному пути abs. Игнорируемая (ignored) - размер и
 * mtime самой записи (lstat: ссылку не проходит). Прочие - sha1 содержимого цели (stat и чтение идут
 * по ссылке: правка цели отслеживаемой или новой ссылки на файл видна, замечание ревью C11 E0-12T),
 * каталог и ссылка на каталог - «не файл»; записи (или цели ссылки) нет - «нет на диске». io -
 * подмена для кейса: { lstat, stat, read }.
 */
function snapshotPrint(abs, ignored, io) {
  const o = io || { lstat: fs.lstatSync, stat: fs.statSync, read: fs.readFileSync };
  try {
    if (ignored) {
      const st = o.lstat(abs);
      return st.size + ' ' + st.mtimeMs;
    }
    return o.stat(abs).isFile() ? require('crypto').createHash('sha1').update(o.read(abs)).digest('hex') : 'не файл';
  } catch (e) {
    if (L.isGone(e)) return 'нет на диске';
    throw e;
  }
}
/**
 * Пути, которые сверка дерева не сравнивает (ОВ2 техлида E0-12T), по образцу HASHED_NOT_READ: их
 * пишут не пробы, а сессия, пока gates.js гоняет selftest в фоне. Запись - точный путь (path),
 * префикс (prefix) или пара префикс+суффикс со средней частью без «/» (prefix и suffix); у каждой
 * причина. Ни glob, ни regex: новая запись - новая строка здесь, с причиной и кейсом в пробе сверки.
 */
const TREE_NOT_COMPARED = [
  { path: '.claude/.qa-state', why: 'боевое состояние хуков сессии: пишут Stop- и PostToolUse-хуки во время фонового прогона; пробы сверяет строка «боевой .qa-state байт в байт»' },
  { prefix: '.claude/.qa-state.', suffix: '.tmp', why: 'временный файл атомарной записи .qa-state (lib.js: <путь>.<pid>.tmp) тех же хуков сессии' },
  { prefix: 'tasks/', why: 'файлы дела: их пишет оркестратор и агенты, пока идут гейты; пробы в tasks/ не пишут' },
];
/** Путь rel (от корня) под записью TREE_NOT_COMPARED: точное равенство, префикс, префикс+суффикс. */
function treeNotCompared(rel) {
  return TREE_NOT_COMPARED.some((x) => {
    if (x.path !== undefined) return rel === x.path;
    if (!rel.startsWith(x.prefix)) return false;
    if (x.suffix === undefined) return true;
    const middle = rel.slice(x.prefix.length, rel.length - x.suffix.length);
    return rel.length > x.prefix.length + x.suffix.length && rel.endsWith(x.suffix) && !middle.includes('/');
  });
}
/**
 * Разница двух снимков repoSnapshot строками «появилось / изменилось содержимое / пропало <запись>»;
 * записи с путём под TREE_NOT_COMPARED не называются.
 */
function treeDiff(before, now) {
  const diff = [];
  const counted = (entry) => !treeNotCompared(entry.slice(3));
  for (const [entry, print] of now) {
    if (!counted(entry)) continue;
    if (!before.has(entry)) diff.push('появилось ' + entry);
    else if (before.get(entry) !== print) diff.push('изменилось содержимое ' + entry);
  }
  for (const entry of before.keys()) if (counted(entry) && !now.has(entry)) diff.push('пропало ' + entry);
  return diff;
}
let LIVE_TREE = null;
let LIVE_TREE_ERROR = '';
try {
  LIVE_TREE = repoSnapshot();
} catch (e) {
  LIVE_TREE_ERROR = (e && e.message) || String(e);
}
// каталог состояния проб живёт до выхода процесса: его снимает обработчик exit реестра (TEMP.dropAll)
const PROBE_STATE_DIR = tempDir('state');
process.env.SF_HOOK_STATE_DIR = PROBE_STATE_DIR;

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
 * zz_selftest_* под git add -A). Дерево пробы - временный каталог (tempDir) с полной копией
 * .claude/hooks (copyHooksTo: каждый файл и подкаталог байт в байт, repos.json тот же:
 * репозиторий sf - корень копии) и файлами пробы по их путям от корня репозитория, так что glob
 * правил и rules.sf.json те же, что у боевого хука. Каталог снимается в finally (dropTemp), в
 * том числе после красной строки.
 *   tree.dir              - корень дерева (пробе, которой нужен git в нём);
 *   tree.write(rel, body) - пишет файл пробы и отдаёт абсолютный путь;
 *   tree.standards(rel)   - запуск копии standards.js на этом файле ({ code, out, err }).
 * Хук идёт с CLAUDE_HOOK_DEBUG: исключение внутри L.guard без failClosed даёт код 0 и пустой
 * stdout - ровно как пропуск, - и отличить их можно только по строке HOOK_ERROR в stderr.
 */
/**
 * Полная копия каталога хуков from (по умолчанию боевой) в <dir>/.claude/hooks - одна для дерева
 * standards и дерева gates.js (E0-12T, TECH_DEBT 19.10.2026 E0-12D круг 3, `withScratchTree`): хук с иным расширением или в
 * подкаталоге в пробу попадает (кейс полноты копии ниже).
 */
function copyHooksTo(dir, from = HOOKS) {
  const hooks = path.join(dir, '.claude', 'hooks');
  fs.mkdirSync(path.dirname(hooks), { recursive: true });
  fs.cpSync(from, hooks, { recursive: true });
  return hooks;
}
function withScratchTree(fn) {
  const dir = tempDir('tree');
  try {
    const hooks = copyHooksTo(dir);
    const abs = (rel) => path.join(dir, ...rel.split('/'));
    return fn({
      dir,
      write: (rel, body) => {
        fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
        fs.writeFileSync(abs(rel), body);
        return abs(rel);
      },
      standards: (rel) => probe('standards.js', { tool_input: { file_path: abs(rel) } }, dir, hooks, { CLAUDE_HOOK_DEBUG: '1' }),
    });
  } finally {
    releaseTemp(dir);
  }
}

/** Файлы каталога dir рекурсивно, пути от него с `/`, по алфавиту. */
function filesUnder(dir) {
  const out = [];
  const walk = (sub) => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? sub + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk('');
  return out.sort();
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
 * У гейта пробы есть timeoutSec (без него runGate ответил бы «нет предела», не дойдя до cp.spawn),
 * подменённый spawn сразу «завершает» команду, а итог пробы печатается на beforeExit - когда цикл
 * событий опустел: main() асинхронный, и без стража его запуск, отметка и process.exit идут после
 * await, позже синхронного конца require (E0-12M, C8).
 * Ждём код 0, пустой stderr, в stdout ровно строку итога пробы, ноль запусков, ни одного
 * process.exit и ни одной отметки в состоянии пробы (своя временная папка,
 * SF_HOOK_STATE_DIR). Каждое - своя причина отказа. Положительный контроль: настоящий
 * markGates из diff-hash.js в другой временной папке с тем же SF_HOOK_STATE_DIR ставит
 * отметку, и та же проверка состояния её видит - иначе проба смотрела бы не туда и молчала.
 * Пока проба не зелёная, gateProbe не грузит gates.js в этот процесс: без стража require
 * отсюда прогнал бы все гейты.
 */
const CHILD_PROCESS_LAUNCHERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
/** Отметка lastGates в состоянии хуков, записанном в dir (SF_HOOK_STATE_DIR); null - отметки нет. */
function lastGatesIn(dir) {
  const st = path.join(dir, '.qa-state');
  if (!fs.existsSync(st)) return null;
  return JSON.parse(fs.readFileSync(st, 'utf8')).lastGates || null;
}
let gatesModuleSafe = false;
check('gates.js: require не запускает гейты, не пишет отметку и не выходит из процесса', () => {
  const dir = tempDir('require');
  const control = tempDir('mark');
  const file = path.join(HOOKS, 'gates.js');
  try {
    const mark = run(process.execPath, ['-e', 'require(' + JSON.stringify(path.join(HOOKS, 'diff-hash.js')) + ').markGates(0);'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { SF_HOOK_STATE_DIR: control }),
    });
    if (mark.status !== 0 || lastGatesIn(control) === null) {
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
      // pid не задан: снятие группы по нему (process.kill(-pid)) бросает, а не бьёт по группе 0
      '    const child = new EventEmitter();',
      '    child.pid = undefined;',
      '    child.stdout = new EventEmitter();',
      '    child.stderr = new EventEmitter();',
      '    child.stdout.destroy = () => {};',
      '    child.stderr.destroy = () => {};',
      '    child.kill = () => true;',
      // команда «отработала» сразу: main() без стража дошёл бы до сводки, markGates и process.exit
      "    setImmediate(() => { child.emit('exit', 0, null); child.emit('close', 0, null); });",
      '    return child;',
      '  };',
      '}',
      'const L = require(' + JSON.stringify(path.join(HOOKS, 'lib.js')) + ');',
      // у гейта есть предел: без него runGate ответил бы «нет предела», не дойдя до cp.spawn
      "L.allChanged = () => [{ repo: { name: 'probe', path: process.cwd() }, rules: { gates: [{ id: 'probe', cmd: 'probe', when: 'always', timeoutSec: 30 }] }, files: ['probe.txt'] }];",
      'let exited = null;',
      'const exit = process.exit;',
      'process.exit = (c) => { if (exited === null) exited = c === undefined ? 0 : c; };',
      'process.argv = [process.execPath, ' + JSON.stringify(file) + '];',
      'const g = require(' + JSON.stringify(file) + ');',
      // main() асинхронный: снимок - когда цикл событий опустел, то есть после всего, что main()
      // успел бы сделать без стража (запуск, отметка, process.exit после await)
      'let done = false;',
      "process.on('beforeExit', () => {",
      '  if (done) return;',
      '  done = true;',
      "  process.stdout.write('probe ' + JSON.stringify({ launched, exited, selectGates: typeof g.selectGates, runGate: typeof g.runGate }));",
      '  exit.call(process, 0);',
      '});',
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
    if (lastGatesIn(dir) !== null) why.push('поставлена отметка lastGates');
    if (seen.selectGates !== 'function') why.push('selectGates не экспортирован: ' + seen.selectGates);
    if (seen.runGate !== 'function') why.push('runGate не экспортирован: ' + seen.runGate);
    if (String(r.stderr || '')) why.push('stderr: ' + String(r.stderr).slice(0, 120));
    if (why.length) return 'require gates.js: ' + why.join('; ');
    gatesModuleSafe = true;
    return true;
  } finally {
    releaseTemp(dir);
    releaseTemp(control);
  }
});

/** Модуль gates.js для проб - только после зелёной пробы require выше; один загрузчик на все пробы. */
function gatesModule() {
  if (!gatesModuleSafe) throw new Error('gates.js не прошёл пробу require - модуль не загружается');
  return require('./gates.js');
}

// Предел гейта принимает сам gates.js (gateTimeoutSec - экспорт, не повтор предиката, L-008):
// строка, дробь, ноль, отрицательное, null, NaN и больше потолка - «нет предела»; потолок ниже
// предела таймера Node (2^31-1 мс), иначе огромный timeoutSec снимал бы гейт через 1 мс (E0-12M).
check('gates.js gateTimeoutSec: целое от 1 до потолка - предел; 0, -1, "60", 1.5, null, NaN, потолок+1, 1e12 - нет предела', () => {
  const { gateTimeoutSec, limits } = gatesModule();
  const max = limits && limits.MAX_TIMEOUT_SEC;
  if (!Number.isInteger(max) || max < 1) return 'gates.js не экспортирует limits.MAX_TIMEOUT_SEC: ' + JSON.stringify(max);
  if (max * 1000 > 2147483647) return 'потолок ' + max + ' с больше предела таймера Node (2^31-1 мс)';
  const why = [];
  for (const t of [1, 60, max]) if (gateTimeoutSec({ timeoutSec: t }) !== t) why.push(t + ' не принят');
  for (const t of [0, -1, '60', 1.5, null, undefined, Number.NaN, Number.POSITIVE_INFINITY, max + 1, 1e12]) {
    if (gateTimeoutSec({ timeoutSec: t }) !== null) why.push(JSON.stringify(t === undefined ? 'undefined' : t) + ' принят');
  }
  return why.length ? why.join('; ') : { note: 'потолок ' + max + ' с' };
});

// Без поля gates.js гейт не запускает и красит (E0-12M, решение техлида Р7): забытое поле
// краснеет здесь, а не на первом прогоне в /auto. Значение сверяет тот же gateTimeoutSec.
// Нижняя граница боевых правил - RULES_MIN_TIMEOUT_SEC (Р7: «не меньше 60 с», 60_HARNESS, «Гейты»):
// gates.js принимает и 1 с (на этом стоят пробы runGate), а гейт rules.sf.json с пределом 5 с
// снимался бы на первом холодном прогоне. Вторую половину правила (x3 от худшего замера) проба
// проверить не может - замер живёт в файле дела задачи, причина числа - в note гейта.
const RULES_MIN_TIMEOUT_SEC = 60;
check('у каждого гейта rules.sf.json есть timeoutSec, который принимает gates.js, не меньше ' + RULES_MIN_TIMEOUT_SEC + ' с', () => {
  const { gateTimeoutSec } = gatesModule();
  const gates = (repoRules && repoRules.gates) || [];
  if (!gates.length) return 'гейтов нет';
  const bad = gates.filter((g) => gateTimeoutSec(g) === null);
  if (bad.length) return 'нет предела timeoutSec: ' + bad.map((g) => g.id + '=' + JSON.stringify(g.timeoutSec)).join(', ');
  const low = gates.filter((g) => g.timeoutSec < RULES_MIN_TIMEOUT_SEC);
  if (low.length) return 'timeoutSec меньше ' + RULES_MIN_TIMEOUT_SEC + ' с: ' + low.map((g) => g.id + '=' + g.timeoutSec).join(', ');
  return { note: gates.map((g) => g.id + ' ' + g.timeoutSec + ' с').join(', ') };
});

// Названный в --only гейт идёт при любом when: glob без совпавших файлов прежде давал exit 0,
// не запустив проверку (E0-12M, TECH_DEBT 11.10.2026 E0-01A).
check('gates.js selectGates: --only гонит названный glob-гейт без совпавших файлов, остальные - нет', () => {
  const { selectGates } = gatesModule();
  const glob = { id: 'probe-glob', cmd: 'x', when: 'glob:a/**' };
  const never = { id: 'probe-never', cmd: 'x', when: 'never' };
  const other = { id: 'probe-other', cmd: 'x', when: 'always' };
  const picked = selectGates([glob, never, other], ['b.txt'], ['probe-glob', 'probe-never']);
  const why = [];
  for (const x of picked.slice(0, 2)) {
    if (!x.run || x.reason !== 'выбран через --only') why.push(x.gate.id + ' в --only: ' + JSON.stringify({ run: x.run, reason: x.reason }));
  }
  if (picked[2].run || picked[2].reason !== 'не выбран через --only') why.push('probe-other вне --only: ' + JSON.stringify({ run: picked[2].run, reason: picked[2].reason }));
  const full = selectGates([glob], ['b.txt'], null);
  if (full[0].run) why.push('без --only glob-гейт выбран на постороннем b.txt');
  return why.length ? why.join('; ') : { note: '2 выбора, 2 пропуска' };
});

/**
 * Дочерний процесс проб запуска гейтов (gateRunCases): исходник функции уходит в `node -e`
 * целиком, поэтому всё нужное - внутри. Все случаи идут параллельно: время пробы - самый долгий
 * случай, а не сумма. cfg.gates - случаи runGate ({ gate, capMs }), cfg.cli - запуски gates.js
 * из командной строки в дереве пробы ({ args, env, capMs }), cfg.watch - внуки ({ pid, hb }):
 * внук пишет свой PID в файл при старте и каждые 100 мс - отметку в файл hb. Жив ли внук после
 * возврата, решает отметка: сдвинулась за cfg.watchMs - жив. Ни зомби на POSIX (он не пишет), ни
 * PID, доставшийся другому процессу на Windows, такой ответ не подделают. Живой внук добивается
 * здесь же по PID (только живой - иначе PID мог бы быть чужим). Каждый случай ограничен capMs:
 * зависший runGate - { hung }, а не зависшая самопроверка.
 */
function gateRunner(cfg) {
  const cp = require('child_process');
  const fs = require('fs');
  const { runGate } = require(cfg.gatesFile);
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch (_) {
      return null;
    }
  };
  const brief = (text) => ({
    len: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    replaced: text.indexOf('�') !== -1,
    head: text.slice(0, 300),
    tail: text.slice(-700),
    cut: (/\.\.\. срезано \d+ байт[^\n]*/.exec(text) || [''])[0],
  });
  const gateCase = async (k) => {
    const c = cfg.gates[k];
    const t = Date.now();
    let cap;
    const r = await Promise.race([runGate(c.gate, cfg.dir), new Promise((res) => { cap = setTimeout(() => res(null), c.capMs); })]);
    clearTimeout(cap);
    return r ? Object.assign({ code: r.code, ms: Date.now() - t, remnant: r.remnant, manual: r.manual }, brief(r.text)) : { hung: true, ms: Date.now() - t };
  };
  const cliCase = (k) =>
    new Promise((resolve) => {
      const c = cfg.cli[k];
      const t = Date.now();
      // stdinOpen: gates.js получает пайп stdin, который проба не закрывает до его выхода
      const child = cp.spawn(process.execPath, ['-r', cfg.preload, cfg.cliGates].concat(c.args), {
        cwd: cfg.dir,
        env: Object.assign({}, process.env, c.env),
        stdio: [c.stdinOpen ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      let err = '';
      let hung = false;
      child.stdout.on('data', (b) => { out += b; });
      child.stderr.on('data', (b) => { err += b; });
      const cap = setTimeout(() => { hung = true; child.kill('SIGKILL'); }, c.capMs);
      child.on('close', (code, signal) => {
        clearTimeout(cap);
        if (child.stdin) child.stdin.destroy();
        resolve({ code, signal, hung, ms: Date.now() - t, out: out.slice(-6000), err: err.slice(-1500) });
      });
    });
  (async () => {
    const res = { gates: {}, cli: {}, watch: {} };
    await Promise.all(
      Object.keys(cfg.gates).map(async (k) => { res.gates[k] = await gateCase(k); }).concat(
        Object.keys(cfg.cli).map(async (k) => { res.cli[k] = await cliCase(k); }),
      ),
    );
    const before = {};
    for (const k of Object.keys(cfg.watch)) before[k] = read(cfg.watch[k].hb);
    await pause(cfg.watchMs);
    for (const k of Object.keys(cfg.watch)) {
      const now = read(cfg.watch[k].hb);
      const pid = Number(read(cfg.watch[k].pid)) || null;
      const alive = now !== null && now !== before[k];
      res.watch[k] = { started: pid !== null, pid, alive };
      if (alive) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (_) {
          // уже вышел - добивать нечего
        }
      }
    }
    process.stdout.write('probe ' + JSON.stringify(res));
    process.exit(0);
  })();
}

/**
 * Пробы запуска гейтов (E0-12M, решения техлида Р7, Р8): один дочерний node
 * (gateRunner) на все случаи, каждый случай - своя строка check. Команды - файлы во временной
 * папке, путь в двойных кавычках: одна строка cmd годится и для cmd.exe, и для sh.
 * runGate (gates.js из боевого каталога, тот же require, что у selectGates):
 *   sleep - сон 30 с при timeoutSec 1: код не 0, «снят по пределу», вернулся за предел + запас;
 *   tree - ребёнок порождает внука со stdio: 'inherit' (внук держит пайп вывода): после возврата
 *     внук мёртв; снятие одной оболочки (на Windows - cmd.exe) оставило бы его живым;
 *   orphan - ребёнок порождает такого же внука и сразу выходит с кодом 0: гейт возвращает код 1,
 *     не «снят по пределу», и называет остаток; POSIX - внук снят, Windows - назван «не снят»;
 *   pass - быстрая команда при timeoutSec 30: код 0, её вывод, без слова «предел»;
 *   noLimit - гейт без timeoutSec: красный «нет предела timeoutSec», маркер-файл команды не создан;
 *   flood - 5 МиБ кириллицы: вывод не больше головы и хвоста gates.js, обе границы на месте, срез
 *     назван, срез головы и хвоста приходится на середину символа - U+FFFD в тексте нет;
 *   split - символ UTF-8 разрезан между двумя кусками stdout, между ними кусок stderr: символ цел.
 * gates.js из командной строки - копия .claude/hooks во временном дереве пробы (git init), правила -
 * гейты пробы, второй репозиторий other со своим гейтом; предзагрузка (`node -r`) подменяет
 * L.allChanged (чистое дерево или один файл в sf), считает снятия групп (process.kill(-pid)) и
 * вызовы taskkill (SF_PROBE_SPY), по SF_PROBE_KILL_FAIL делает их отказом, по SF_PROBE_SIGNAL_ON
 * шлёт процессу сигнал SF_PROBE_SIGNAL (process.emit - на Windows внешний SIGTERM обработчик не
 * зовёт), когда внук записал PID, с задержкой SF_PROBE_SIGNAL_DELAY:
 *   full - полный прогон: гейт за предел, быстрый и болтливый; код 1 (его даёт только снятый
 *     гейт), в сводке «СНЯТ ПО ПРЕДЕЛУ», подпись файла вывода говорит о срезе, lastGates - код 1;
 *   onlyNoLimit - --only=<гейт без предела>: код 1, в сводке «нет предела», команда не запускалась;
 *   onlyClean - чистое дерево, --only=<glob-гейт>: гейт идёт, код 0, прогон частичный, отметки нет;
 *   onlyTypo - чистое дерево, --only=<опечатка>: код 1, ни одного запуска, отметки нет;
 *   onlyEmpty - --only= без id: код 1, ни одного запуска;
 *   onlyElsewhere - изменения в sf, --only=<гейт only в other>: код 1, не «неизвестный id»;
 *   onlyElsewhereRepo - то же с --repo=sf: подсказки --repo нет;
 *   onlyCleanOther, onlyCleanBoth - чистое дерево: гейт only в other идёт в other, не в sf; гейт
 *     обоих репозиториев - в обоих; onlyCleanMixed - p-pass,o-only: p-pass в sf, o-only в other;
 *   stdin - у gates.js открытый пайп stdin, гейт читает stdin до конца: конец ввода сразу, ok;
 *   SIGINT, SIGTERM, SIGHUP - --only=<гейт с внуком>, сигнал, как только внук стартовал:
 *     код 130/143/129, внук мёртв, отметки нет;
 *   afterExit - оболочка вышла (detached-внук держит вывод), SIGTERM в окне ожидания вывода: код
 *     143, снятие группы на POSIX - ровно одно (в ветке exit), taskkill на Windows - ни одного;
 *   killFail - снятие по пределу отказало, вывод открыт: код 1, оба факта, в сводке «СНЯТЬ РУКАМИ»;
 *   killFailClosed - снятие отказало, а команда вышла сама в окне ожидания: «СНЯТЬ РУКАМИ», отказ и
 *     закрытие названы, не «снят»;
 *   killNoop - снятие ответило успехом, ничего не сняв (SF_PROBE_KILL_NOOP): «СНЯТЬ РУКАМИ», не «снят».
 * Результат и ошибка запоминаются: строки одного прогона не гоняют дочерний node заново.
 */
let gateRunResult = null;
function gateRunCases() {
  if (!gateRunResult) {
    try {
      gateRunResult = { value: buildGateRunCases() };
    } catch (e) {
      gateRunResult = { error: e };
    }
  }
  if (gateRunResult.error) throw gateRunResult.error;
  return gateRunResult.value;
}
const PROBE_SIGNALS = [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]];
function buildGateRunCases() {
  const { limits } = gatesModule();
  // без умолчания: снятый экспорт - красная строка, а не молча 2 с
  const grace = limits && limits.KILL_GRACE_MS;
  if (!Number.isInteger(grace) || grace <= 0) throw new Error('gates.js не экспортирует limits.KILL_GRACE_MS: ' + JSON.stringify(grace));
  const dir = tempDir('rungate');
  try {
    const put = (rel, text) => {
      const p = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
      return p;
    };
    const q = (p) => '"' + p + '"';
    const cmd = (...args) => [process.execPath].concat(args).map(q).join(' ');
    const sleep = put('bin/sleep.js', 'setTimeout(() => {}, 30000);\n');
    const gc = put('bin/gc.js', [
      "const fs = require('fs');",
      'const [pidFile, hbFile] = process.argv.slice(2);',
      'fs.writeFileSync(pidFile, String(process.pid));',
      'const beat = () => fs.writeFileSync(hbFile, Date.now() + " " + Math.random());',
      'beat();',
      'setInterval(beat, 100);',
      'setTimeout(() => process.exit(0), 30000);',
    ].join('\n'));
    // tree: внук держит вывод, ребёнок спит; orphan: внук держит вывод, ребёнок выходит с кодом 3,
    // как только внук записал свой PID (внук точно был, когда оболочка вышла). На Windows libuv
    // снимает не-detached детей node вместе с ним (job object), поэтому переживает ребёнка там
    // только detached-внук; на POSIX внук остаётся в группе гейта. orphanAway - внук detached на
    // обеих системах (POSIX - своя сессия): снятие группы при выходе оболочки его не достаёт.
    const spawnGc = (opts) => "const c = require('child_process').spawn(process.execPath, process.argv.slice(2), { stdio: 'inherit'" + opts + ' });';
    const tree = put('bin/tree.js', spawnGc('') + '\nsetTimeout(() => {}, 30000);\n');
    const exitOnGc = (code) => "const up = setInterval(() => { if (require('fs').existsSync(process.argv[3])) { clearInterval(up); process.exit(" + code + '); } }, 20);';
    // orphan выходит с 0: зелёный код оболочки при живом остатке - ровно тот случай, где гейт обязан быть красным
    const orphan = put('bin/orphan.js', [spawnGc(", detached: process.platform === 'win32'"), 'c.unref();', exitOnGc(0)].join('\n'));
    const orphanAway = put('bin/orphan-away.js', [spawnGc(', detached: true'), 'c.unref();', exitOnGc(3)].join('\n'));
    const pass = put('bin/pass.js', "console.log('ok');\n");
    // короткий красный: одна строка и код 3 - файл вывода пишется и ему (needsLog), не только длинному
    const failShort = put('bin/fail-short.js', "console.log('short-red-line');\nprocess.exit(3);\n");
    // красный без вывода: файла нет - пустой ничего не объясняет; длинный зелёный (больше
    // FULL_LIMIT строк, меньше предела памяти) - файл есть: его середина на экране срезана
    const failSilent = put('bin/fail-silent.js', 'process.exit(3);\n');
    const longGreen = put('bin/long-green.js', "for (let i = 0; i < 260; i++) console.log('long-green-line-' + i);\n");
    // граница FULL_LIMIT (200): ровно 200 строк - целиком на экране и без файла, 201 - срез и файл
    const linesGreen = (n) => put('bin/green-' + n + '.js', 'for (let i = 0; i < ' + n + "; i++) console.log('edge-line-' + i);\n");
    const green200 = linesGreen(200);
    const green201 = linesGreen(201);
    // читает stdin до конца и выходит 0: без stdin (ignore) конец ввода приходит сразу, с открытым
    // пайпом gates.js (inherit) или своим пайпом (pipe) - никогда, гейт висел бы до предела
    const stdinRead = put('bin/stdin-read.js', "process.stdin.resume();\nprocess.stdin.on('end', () => { console.log('stdin-end'); process.exit(0); });\n");
    // выходит сам через 1,5 с - после предела 1 с, но в окне ожидания вывода
    const slow = put('bin/slow.js', 'setTimeout(() => {}, 1500);\n');
    // голова - 11 байт, строка - 511 «ж» и перевод строки (1023 байта): граница головы (1 МиБ) и
    // начало хвоста (последний МиБ) приходятся на второй байт символа
    const flood = put('bin/flood.js', "process.stdout.write('HEAD-START\\n' + ('ж'.repeat(511) + '\\n').repeat(5 * 1024) + 'TAIL-END!\\n');\n");
    const split = put('bin/split.js', [
      "const b = Buffer.from('ПРИВЕТ-ЮНИКОД\\n', 'utf8');",
      'process.stdout.write(b.subarray(0, 1));',
      "setTimeout(() => { process.stderr.write('E\\n'); setTimeout(() => process.stdout.write(b.subarray(1)), 100); }, 100);",
    ].join('\n'));
    // больше 200 строк и больше предела памяти: gates.js пишет файл вывода и срезает середину
    const floodCli = put('bin/flood-cli.js', "process.stdout.write(('y'.repeat(15) + '\\n').repeat(160 * 1024));\n");
    const marker = path.join(dir, 'marker-rungate');
    const cliMarker = path.join(dir, 'marker-cli');
    const mark = (m) => put('bin/mark-' + path.basename(m) + '.js', 'require("fs").writeFileSync(' + JSON.stringify(m) + ', "ran");\n');
    const watch = {};
    const watchKeys = ['tree', 'orphan', 'afterExit', 'stuck', 'noop'].concat(PROBE_SIGNALS.map(([s]) => s));
    for (const k of watchKeys) watch[k] = { pid: path.join(dir, 'gc-' + k + '.pid'), hb: path.join(dir, 'gc-' + k + '.hb') };
    const withGc = (file, k) => cmd(file, gc, watch[k].pid, watch[k].hb);
    const cap = (sec) => sec * 1000 + grace + 20000;
    const gates = {
      sleep: { gate: { id: 'probe-sleep', cmd: cmd(sleep), timeoutSec: 1 }, capMs: cap(1) },
      tree: { gate: { id: 'probe-tree', cmd: withGc(tree, 'tree'), timeoutSec: 5 }, capMs: cap(5) },
      orphan: { gate: { id: 'probe-orphan', cmd: withGc(orphan, 'orphan'), timeoutSec: 30 }, capMs: cap(0) },
      pass: { gate: { id: 'probe-pass', cmd: cmd(pass), timeoutSec: 30 }, capMs: cap(0) },
      noLimit: { gate: { id: 'probe-nolimit', cmd: cmd(mark(marker)) }, capMs: cap(0) },
      flood: { gate: { id: 'probe-flood', cmd: cmd(flood), timeoutSec: 30 }, capMs: cap(0) },
      split: { gate: { id: 'probe-split', cmd: cmd(split), timeoutSec: 30 }, capMs: cap(0) },
    };
    // дерево пробы для gates.js из командной строки: копия хуков, свои правила, свой git,
    // второй репозиторий other (каталог и правила - гейт o-only)
    const hooks = copyHooksTo(dir);
    fs.mkdirSync(path.join(dir, 'other'), { recursive: true });
    fs.writeFileSync(path.join(hooks, 'repos.json'), JSON.stringify({ repos: [{ name: 'sf', path: '../..' }, { name: 'other', path: '../../other' }] }));
    fs.writeFileSync(path.join(hooks, 'rules.other.json'), JSON.stringify({
      gates: [
        { id: 'o-only', cmd: cmd(pass), when: 'always', timeoutSec: 30 },
        { id: 'p-both', cmd: cmd(pass), when: 'never', timeoutSec: 30 },
      ],
    }));
    fs.writeFileSync(path.join(hooks, 'rules.sf.json'), JSON.stringify({
      gates: [
        { id: 'p-hang', cmd: cmd(sleep), when: 'always', timeoutSec: 1 },
        { id: 'p-nolimit', cmd: cmd(mark(cliMarker)), when: 'never' },
        { id: 'p-pass', cmd: cmd(pass), when: 'always', timeoutSec: 30 },
        { id: 'p-flood', cmd: cmd(floodCli), when: 'always', timeoutSec: 30 },
        { id: 'p-glob', cmd: cmd(pass), when: 'glob:a/**', timeoutSec: 30 },
        { id: 'p-orphan', cmd: withGc(orphanAway, 'afterExit'), when: 'never', timeoutSec: 30 },
        { id: 'p-stuck', cmd: cmd(gc, watch.stuck.pid, watch.stuck.hb), when: 'never', timeoutSec: 1 },
        { id: 'p-slow', cmd: cmd(slow), when: 'never', timeoutSec: 1 },
        { id: 'p-noop', cmd: cmd(gc, watch.noop.pid, watch.noop.hb), when: 'never', timeoutSec: 1 },
        { id: 'p-stdin', cmd: cmd(stdinRead), when: 'never', timeoutSec: 3 },
        { id: 'p-both', cmd: cmd(pass), when: 'never', timeoutSec: 30 },
        { id: 'p-fail-short', cmd: cmd(failShort), when: 'never', timeoutSec: 30 },
        { id: 'p-fail-silent', cmd: cmd(failSilent), when: 'never', timeoutSec: 30 },
        { id: 'p-long-green', cmd: cmd(longGreen), when: 'never', timeoutSec: 30 },
        { id: 'p-green-200', cmd: cmd(green200), when: 'never', timeoutSec: 30 },
        { id: 'p-green-201', cmd: cmd(green201), when: 'never', timeoutSec: 30 },
      ].concat(PROBE_SIGNALS.map(([s]) => ({ id: 'p-tree-' + s, cmd: withGc(tree, s), when: 'never', timeoutSec: 30 }))),
    }));
    const init = git(['init', '-q', '--template='], { cwd: dir });
    if (init.error || init.status !== 0) throw new Error('git init дерева пробы: ' + String((init.error && init.error.message) || init.stderr).slice(0, 160));
    const preload = put('pre.js', [
      "const fs = require('fs');",
      "const cp = require('child_process');",
      'const L = require(' + JSON.stringify(path.join(hooks, 'lib.js')) + ');',
      "const one = process.env.SF_PROBE_CHANGED === 'one';",
      "L.allChanged = () => { if (!one) return []; const repo = L.knownRepos()[0]; return [{ repo, rules: L.rulesFor(repo), files: ['b.txt'] }]; };",
      'const spy = { groupKills: 0, taskkills: 0, logWrites: [], logDirReads: 0, logUnlinks: 0 };',
      'const spyFile = process.env.SF_PROBE_SPY;',
      "if (spyFile) process.on('exit', () => fs.writeFileSync(spyFile, JSON.stringify(spy)));",
      "const failKill = process.env.SF_PROBE_KILL_FAIL === '1';",
      // SF_PROBE_KILL_NOOP: снятие отвечает успехом, ничего не сняв (taskkill 0, сигнал группе «ушёл»)
      "const noopKill = process.env.SF_PROBE_KILL_NOOP === '1';",
      'const kill = process.kill;',
      'process.kill = function (pid) {',
      "  if (typeof pid === 'number' && pid < 0) {",
      '    spy.groupKills++;',
      "    if (failKill) throw Object.assign(new Error('kill EPERM (проба)'), { code: 'EPERM' });",
      '    if (noopKill) return true;',
      '  }',
      '  return kill.apply(process, arguments);',
      '};',
      'const spawnSync = cp.spawnSync;',
      'cp.spawnSync = function (file) {',
      "  if (String(file).toLowerCase().endsWith('taskkill.exe')) {",
      '    spy.taskkills++;',
      "    if (failKill) return { pid: 0, status: null, signal: null, error: Object.assign(new Error('taskkill ENOENT (проба)'), { code: 'ENOENT' }) };",
      '    if (noopKill) return { pid: 0, status: 0, signal: null };',
      '  }',
      '  return spawnSync.apply(cp, arguments);',
      '};',
      // SF_PROBE_LOG_EXISTING: файл вывода с именем, которое запишет этот прогон (тот же pid), уже
      // лежит - от прошлого прогона, доставшегося pid; saveLog обязан записать свой поверх, а не отказать
      "if (process.env.SF_PROBE_LOG_EXISTING === '1') {",
      "  const d = require('path').join(require('os').tmpdir(), 'sf-gates');",
      '  fs.mkdirSync(d, { recursive: true });',
      "  fs.writeFileSync(require('path').join(d, 'gates-sf-p-fail-short-' + process.pid + '.log'), 'stale-log-of-another-run', { mode: 0o644 });",
      '}',
      // запись файла вывода гейта (saveLog): режим и флаг файла - в шпиона; SF_PROBE_LOG_FAIL - сбой записи
      "const failLog = process.env.SF_PROBE_LOG_FAIL === '1';",
      'const writeFileSync = fs.writeFileSync;',
      'fs.writeFileSync = function (file, data, options) {',
      '  if (/[\\\\/]gates-[^\\\\/]*\\.log$/.test(String(file))) {',
      "    const o = options && typeof options === 'object' ? options : {};",
      "    spy.logWrites.push({ name: require('path').basename(String(file)), mode: o.mode === undefined ? null : o.mode, flag: o.flag === undefined ? null : o.flag });",
      "    if (failLog) throw Object.assign(new Error('EACCES (проба)'), { code: 'EACCES' });",
      '  }',
      '  return writeFileSync.apply(fs, arguments);',
      '};',
      // чистка файлов вывода (pruneLogs): чтения каталога sf-gates и удаления - в шпиона;
      // SF_PROBE_PRUNE_FAIL=readdir|unlink - сбой чтения каталога или удаления старого файла
      'const pruneFail = process.env.SF_PROBE_PRUNE_FAIL;',
      'const readdirSync = fs.readdirSync;',
      'fs.readdirSync = function (dir) {',
      "  if (/[\\\\/]sf-gates[\\\\/]?$/.test(String(dir))) {",
      '    spy.logDirReads++;',
      "    if (pruneFail === 'readdir') throw Object.assign(new Error('EACCES (проба)'), { code: 'EACCES' });",
      '  }',
      '  return readdirSync.apply(fs, arguments);',
      '};',
      'const unlinkSync = fs.unlinkSync;',
      'fs.unlinkSync = function (file) {',
      "  if (/[\\\\/]sf-gates[\\\\/]gates-[^\\\\/]*\\.log$/.test(String(file))) {",
      '    spy.logUnlinks++;',
      "    if (pruneFail === 'unlink') throw Object.assign(new Error('EBUSY (проба)'), { code: 'EBUSY' });",
      '  }',
      '  return unlinkSync.apply(fs, arguments);',
      '};',
      'const pidFile = process.env.SF_PROBE_SIGNAL_ON;',
      'if (pidFile) {',
      '  const t = setInterval(() => {',
      '    if (!fs.existsSync(pidFile)) return;',
      '    clearInterval(t);',
      '    setTimeout(() => process.emit(process.env.SF_PROBE_SIGNAL), Number(process.env.SF_PROBE_SIGNAL_DELAY) || 0);',
      '  }, 50);',
      '  t.unref();',
      '}',
    ].join('\n'));
    const state = {};
    const spies = {};
    const cli = {};
    // TEMP/TMP/TMPDIR - в дерево пробы: файлы вывода гейтов (saveLog, каталог sf-gates) уходят вместе с ним
    const tmp = path.join(dir, 'tmp');
    const logDir = path.join(tmp, 'sf-gates');
    fs.mkdirSync(logDir, { recursive: true });
    // старые файлы вывода: gates.js удаляет свои старше недели в своём каталоге при первой записи
    // прогона, а свежий свой, чужой файл каталога и файл TEMP с именем, как у файла вывода, не трогает
    const aged = (where, name, days) => {
      const p = path.join(where, name);
      fs.writeFileSync(p, 'old');
      const t = (Date.now() - days * 24 * 3600 * 1000) / 1000;
      fs.utimesSync(p, t, t);
    };
    aged(logDir, 'gates-sf-p-old-1.log', 8);
    aged(logDir, 'gates-sf-p-recent-1.log', 1);
    aged(logDir, 'gates-notes.txt', 8);
    aged(tmp, 'gates-other-tool-1.log', 8);
    // свои TEMP у проб сбоя чистки: сбой чтения каталога и сбой удаления старого файла
    const tmpPrune = { readdir: path.join(dir, 'tmp-readdir'), unlink: path.join(dir, 'tmp-unlink') };
    for (const k of Object.keys(tmpPrune)) fs.mkdirSync(path.join(tmpPrune[k], 'sf-gates'), { recursive: true });
    aged(path.join(tmpPrune.unlink, 'sf-gates'), 'gates-sf-p-old-2.log', 8);
    // свой TEMP у пробы файла, оставшегося с тем же pid: его файл вывода не смешивается с общими
    const tmpExisting = path.join(dir, 'tmp-existing');
    const cliCase = (k, args, env, stdinOpen) => {
      state[k] = tempDir('state-' + k, dir);
      spies[k] = path.join(dir, 'spy-' + k + '.json');
      cli[k] = { args, env: Object.assign({ SF_HOOK_STATE_DIR: state[k], SF_PROBE_SPY: spies[k], TEMP: tmp, TMP: tmp, TMPDIR: tmp }, env), capMs: 40000, stdinOpen: Boolean(stdinOpen) };
    };
    cliCase('full', [], { SF_PROBE_CHANGED: 'one' });
    cliCase('onlyNoLimit', ['--only=p-nolimit'], { SF_PROBE_CHANGED: 'one' });
    cliCase('onlyClean', ['--only=p-glob'], { SF_PROBE_CHANGED: 'none' });
    cliCase('onlyTypo', ['--only=p-glbo'], { SF_PROBE_CHANGED: 'none' });
    cliCase('onlyEmpty', ['--only='], { SF_PROBE_CHANGED: 'one' });
    cliCase('onlyElsewhere', ['--only=o-only'], { SF_PROBE_CHANGED: 'one' });
    cliCase('onlyElsewhereRepo', ['--repo=sf', '--only=o-only'], { SF_PROBE_CHANGED: 'none' });
    cliCase('onlyCleanOther', ['--only=o-only'], { SF_PROBE_CHANGED: 'none' });
    cliCase('onlyCleanBoth', ['--only=p-both'], { SF_PROBE_CHANGED: 'none' });
    cliCase('onlyCleanMixed', ['--only=p-pass,o-only'], { SF_PROBE_CHANGED: 'none' });
    cliCase('stdin', ['--only=p-stdin'], { SF_PROBE_CHANGED: 'none' }, true);
    cliCase('failShort', ['--only=p-fail-short'], { SF_PROBE_CHANGED: 'none' });
    cliCase('failShortNoLog', ['--only=p-fail-short'], { SF_PROBE_CHANGED: 'none', SF_PROBE_LOG_FAIL: '1' });
    cliCase('failSilent', ['--only=p-fail-silent'], { SF_PROBE_CHANGED: 'none' });
    cliCase('longGreen', ['--only=p-long-green'], { SF_PROBE_CHANGED: 'none' });
    cliCase('green200', ['--only=p-green-200'], { SF_PROBE_CHANGED: 'none' });
    cliCase('green201', ['--only=p-green-201'], { SF_PROBE_CHANGED: 'none' });
    // сбой записи файла у срезанного вывода: на экране срез строк; у болтливого - ещё и срез памяти
    cliCase('longGreenNoLog', ['--only=p-long-green'], { SF_PROBE_CHANGED: 'none', SF_PROBE_LOG_FAIL: '1' });
    cliCase('floodNoLog', ['--only=p-flood'], { SF_PROBE_CHANGED: 'none', SF_PROBE_LOG_FAIL: '1' });
    cliCase('existingLog', ['--only=p-fail-short'], { SF_PROBE_CHANGED: 'none', SF_PROBE_LOG_EXISTING: '1', TEMP: tmpExisting, TMP: tmpExisting, TMPDIR: tmpExisting });
    for (const k of Object.keys(tmpPrune)) {
      const t = tmpPrune[k];
      cliCase('prune-' + k, ['--only=p-fail-short'], { SF_PROBE_CHANGED: 'none', SF_PROBE_PRUNE_FAIL: k, TEMP: t, TMP: t, TMPDIR: t });
    }
    for (const [s] of PROBE_SIGNALS) {
      cliCase(s, ['--only=p-tree-' + s], { SF_PROBE_CHANGED: 'none', SF_PROBE_SIGNAL_ON: watch[s].pid, SF_PROBE_SIGNAL: s });
    }
    // сигнал - через 400 мс после PID внука: оболочка уже вышла, вывод держит внук (окно 2 с)
    cliCase('afterExit', ['--only=p-orphan'], { SF_PROBE_CHANGED: 'none', SF_PROBE_SIGNAL_ON: watch.afterExit.pid, SF_PROBE_SIGNAL: 'SIGTERM', SF_PROBE_SIGNAL_DELAY: '400' });
    cliCase('killFail', ['--only=p-stuck'], { SF_PROBE_CHANGED: 'none', SF_PROBE_KILL_FAIL: '1' });
    cliCase('killFailClosed', ['--only=p-slow'], { SF_PROBE_CHANGED: 'none', SF_PROBE_KILL_FAIL: '1' });
    cliCase('killNoop', ['--only=p-noop'], { SF_PROBE_CHANGED: 'none', SF_PROBE_KILL_NOOP: '1' });
    const cfg = { gatesFile: path.join(HOOKS, 'gates.js'), cliGates: path.join(hooks, 'gates.js'), preload, dir, gates, cli, watch, watchMs: 1500 };
    const code = '(' + gateRunner.toString() + ')(' + JSON.stringify(cfg) + ');';
    const r = run(process.execPath, ['-e', code], { cwd: dir, timeout: 120000, killSignal: 'SIGKILL' });
    const m = /(?:^|\n)probe (\{.*\})$/.exec(String(r.stdout || ''));
    if (!m) throw new Error('проба запуска гейтов не дошла до итога (код ' + r.status + '): ' + String(r.stderr || r.stdout || (r.error && r.error.message)).slice(0, 200));
    const res = JSON.parse(m[1]);
    res.markerWritten = fs.existsSync(marker);
    res.cliMarkerWritten = fs.existsSync(cliMarker);
    res.lastGates = {};
    res.spy = {};
    for (const k of Object.keys(state)) {
      const g = lastGatesIn(state[k]);
      res.lastGates[k] = g ? g.code : null;
      res.spy[k] = fs.existsSync(spies[k]) ? JSON.parse(fs.readFileSync(spies[k], 'utf8')) : null;
    }
    res.grace = grace;
    // файлы вывода гейтов (saveLog) в каталоге sf-gates TEMP дерева пробы - до его удаления
    res.logs = fs.readdirSync(logDir).filter((f) => /^gates-/.test(f)).map((f) => ({ name: f, text: fs.readFileSync(path.join(logDir, f), 'utf8') }));
    res.tmpNames = fs.readdirSync(tmp);
    res.logDirNames = fs.readdirSync(logDir);
    res.logStats = res.logs.map((l) => ({ name: l.name, mode: fs.statSync(path.join(logDir, l.name)).mode }));
    res.pruneLogNames = {};
    for (const k of Object.keys(tmpPrune)) res.pruneLogNames[k] = fs.readdirSync(path.join(tmpPrune[k], 'sf-gates'));
    const existingDir = path.join(tmpExisting, 'sf-gates');
    res.existingLogs = fs.existsSync(existingDir) ? fs.readdirSync(existingDir).map((f) => ({ name: f, text: fs.readFileSync(path.join(existingDir, f), 'utf8') })) : [];
    return res;
  } finally {
    // папку держит не снятый процесс - его отказ назван строкой пробы; каталог остаётся в
    // реестре: его снимет выход процесса, а не снятый назовёт проба «каталоги прогона»
    releaseTemp(dir);
  }
}
/** Случай пробы runGate словами для строки отказа. */
function runGateSeen(x) {
  if (x.hung) return 'runGate не вернулся за ' + (x.ms / 1000).toFixed(1) + ' с';
  return 'код ' + x.code + ', ' + (x.ms / 1000).toFixed(1) + ' с, вывод ' + JSON.stringify(String(x.tail).slice(-200));
}
/** Запуск gates.js из командной строки словами для строки отказа. */
function cliSeen(x) {
  if (x.hung) return 'gates.js не вышел за ' + (x.ms / 1000).toFixed(1) + ' с';
  return 'код ' + x.code + (x.signal ? ' (' + x.signal + ')' : '') + ', stdout …' + JSON.stringify(x.out.slice(-300)) + (x.err ? ', stderr ' + JSON.stringify(x.err.slice(-200)) : '');
}
check('gates.js runGate: команда дольше timeoutSec снята по пределу (код не 0, «снят по пределу», вернулся за предел + запас)', () => {
  const all = gateRunCases();
  const x = all.gates.sleep;
  if (x.hung || x.code === 0 || !/снят по пределу 1 с/.test(x.tail) || x.ms >= 1000 + all.grace + 8000) return runGateSeen(x);
  return { note: (x.ms / 1000).toFixed(1) + ' с' };
});
check('gates.js runGate: снято всё дерево - внук, держащий вывод, мёртв после возврата', () => {
  const all = gateRunCases();
  const x = all.gates.tree;
  const w = all.watch.tree;
  if (x.hung || x.code === 0 || !/снят по пределу/.test(x.tail)) return runGateSeen(x);
  if (!w.started) return 'внук не стартовал до предела (нет файла PID) - проба ничего не доказывает; ' + runGateSeen(x);
  if (w.alive) return 'внук ' + w.pid + ' жив после возврата runGate - снята только оболочка, не дерево; ' + runGateSeen(x);
  return { note: 'внук ' + w.pid + ' снят, ' + (x.ms / 1000).toFixed(1) + ' с' };
});
// Оболочка вышла с 0, а остаток жил: код 0 только при закрывшемся самом выводе без снятия (D2/D3),
// поэтому здесь код 1 на обеих системах, код оболочки - в тексте
check('gates.js runGate: оболочка вышла с 0, внук держит вывод - код 1, без «снят по пределу», остаток назван (POSIX - снят)', () => {
  const all = gateRunCases();
  const x = all.gates.orphan;
  const w = all.watch.orphan;
  if (x.hung || x.code !== 1 || /снят по пределу/.test(x.tail) || x.ms >= all.grace + 8000) return runGateSeen(x);
  if (!w.started) return 'внук не стартовал до выхода оболочки (нет файла PID) - проба ничего не доказывает; ' + runGateSeen(x);
  if (process.platform === 'win32') {
    if (!x.remnant) return 'остаток не помечен (remnant) - сводка не скажет «ОСТАТОК ЖИВ»; ' + runGateSeen(x);
    if (!/вышла с кодом 0, а вывод держал оставшийся от неё процесс[^\n]*на Windows он не снят[^\n]*снять руками/.test(x.tail)) return 'остаток не назван: ' + runGateSeen(x);
    return { note: 'Windows: остаток назван, внук ' + (w.alive ? 'жив (снят пробой)' : 'мёртв') + ', ' + (x.ms / 1000).toFixed(1) + ' с' };
  }
  if (w.alive) return 'внук ' + w.pid + ' жив после выхода оболочки - остаток группы не снят; ' + runGateSeen(x);
  if (!/вышла с кодом 0, оставшиеся процессы её группы сняты/.test(x.tail)) return 'снятие остатка не названо: ' + runGateSeen(x);
  return { note: 'внук снят, ' + (x.ms / 1000).toFixed(1) + ' с' };
});
check('gates.js runGate: команда в пределе - её код 0 и вывод, без слова «предел»', () => {
  const x = gateRunCases().gates.pass;
  if (x.hung || x.code !== 0 || !/\bok\b/.test(x.tail) || /предел/.test(x.tail)) return runGateSeen(x);
  return true;
});
check('gates.js runGate: гейт без timeoutSec красный «нет предела timeoutSec», команда не запускалась', () => {
  const all = gateRunCases();
  const x = all.gates.noLimit;
  if (x.hung || x.code === 0 || !/нет предела timeoutSec/.test(x.tail)) return runGateSeen(x);
  if (all.markerWritten) return 'команда гейта без предела запускалась (маркер-файл создан)';
  return true;
});
check('gates.js runGate: болтливый гейт - вывод не больше головы и хвоста, обе границы на месте, срез назван и не режет символ', () => {
  const { limits } = gatesModule();
  const x = gateRunCases().gates.flood;
  if (x.hung || x.code !== 0) return runGateSeen(x);
  const max = limits.OUTPUT_HEAD_BYTES + limits.OUTPUT_TAIL_BYTES + 400;
  const why = [];
  if (x.bytes > max) why.push('текст ' + x.bytes + ' байт больше предела ' + max);
  if (!x.head.startsWith('HEAD-START')) why.push('нет головы вывода');
  if (!/TAIL-END!\s*$/.test(x.tail)) why.push('нет хвоста вывода');
  if (!x.cut) why.push('срез не назван в выводе');
  if (x.replaced) why.push('в тексте U+FFFD - срез головы или хвоста разрезал символ UTF-8');
  return why.length ? why.join('; ') : { note: x.bytes + ' байт; ' + x.cut.slice(0, 60) };
});
check('gates.js runGate: символ UTF-8, разрезанный между кусками stdout с куском stderr между ними, цел', () => {
  const x = gateRunCases().gates.split;
  if (x.hung || x.code !== 0) return runGateSeen(x);
  if (x.replaced || x.tail.indexOf('ПРИВЕТ-ЮНИКОД') === -1) return 'символ испорчен: ' + JSON.stringify(x.tail);
  return true;
});
check('gates.js из командной строки: --only на чистом дереве гонит названный glob-гейт, код 0, прогон частичный', () => {
  const all = gateRunCases();
  const x = all.cli.onlyClean;
  const why = [];
  if (x.hung || x.code !== 0) why.push(cliSeen(x));
  if (!/p-glob .* - выбран через --only/.test(x.out)) why.push('нет выбора p-glob через --only');
  if (!/--- sf \/ p-glob: ok/.test(x.out)) why.push('p-glob не прогнан');
  if (!/Прогон был частичным/.test(x.out)) why.push('нет строки о частичном прогоне');
  if (all.lastGates.onlyClean !== null) why.push('частичный прогон поставил lastGates ' + all.lastGates.onlyClean);
  return why.length ? why.join('; ') : true;
});
check('gates.js из командной строки: неизвестный id в --only - код 1, ничего не запускалось', () => {
  const all = gateRunCases();
  const x = all.cli.onlyTypo;
  const why = [];
  if (x.hung || x.code !== 1) why.push(cliSeen(x));
  if (!/Неизвестные id в --only: p-glbo/.test(x.out)) why.push('опечатка не названа');
  if (/^=== /m.test(x.out)) why.push('гейт запускался');
  if (all.lastGates.onlyTypo !== null) why.push('поставлена отметка lastGates ' + all.lastGates.onlyTypo);
  return why.length ? why.join('; ') : true;
});
check('gates.js из командной строки: пустой --only= - код 1, ничего не запускалось', () => {
  const all = gateRunCases();
  const x = all.cli.onlyEmpty;
  const why = [];
  if (x.hung || x.code !== 1) why.push(cliSeen(x));
  if (!/--only без единого id/.test(x.out)) why.push('пустой --only не назван');
  if (/^=== /m.test(x.out)) why.push('гейт запускался');
  if (all.lastGates.onlyEmpty !== null) why.push('поставлена отметка lastGates ' + all.lastGates.onlyEmpty);
  return why.length ? why.join('; ') : true;
});
check('gates.js из командной строки: id гейта другого репозитория в --only - не опечатка, код 1 с подсказкой --repo, ничего не запускалось', () => {
  const all = gateRunCases();
  const x = all.cli.onlyElsewhere;
  const why = [];
  if (x.hung || x.code !== 1) why.push(cliSeen(x));
  if (/Неизвестные id/.test(x.out)) why.push('гейт другого репозитория назван опечаткой');
  if (!/только в репозиториях, куда этот прогон не идёт: o-only - other/.test(x.out)) why.push('репозиторий гейта не назван');
  if (!/назови репозиторий: --repo=<имя>/.test(x.out)) why.push('без --repo нет подсказки --repo');
  if (/^=== /m.test(x.out)) why.push('гейт запускался');
  return why.length ? why.join('; ') : true;
});
check('gates.js из командной строки: --repo назвал репозиторий без гейта из --only - код 1, подсказка --repo не повторяет переданный флаг', () => {
  const x = gateRunCases().cli.onlyElsewhereRepo;
  const why = [];
  if (x.hung || x.code !== 1) why.push(cliSeen(x));
  if (!/только в репозиториях, куда этот прогон не идёт: o-only - other/.test(x.out)) why.push('репозиторий гейта не назван');
  if (/--repo=<имя>/.test(x.out)) why.push('подсказка --repo при переданном --repo');
  if (/^=== /m.test(x.out)) why.push('гейт запускался');
  return why.length ? why.join('; ') : true;
});
// На чистом дереве --only гонит гейт там, где он объявлен (В2, вариант C): позиция репозитория
// в repos.json не участвует - other второй, и его гейт идёт в other, а sf не трогается
check('gates.js из командной строки: --only на чистом дереве гонит гейт в репозитории, где он объявлен (не первом в repos.json)', () => {
  const x = gateRunCases().cli.onlyCleanOther;
  const why = [];
  if (x.hung || x.code !== 0) why.push(cliSeen(x));
  if (!/--- other \/ o-only: ok/.test(x.out)) why.push('o-only не прогнан в other');
  if (/^=== sf \//m.test(x.out) || /^sf: будет запущено/m.test(x.out)) why.push('прогон тронул sf');
  if (!/там, где они объявлены: other \(/.test(x.out)) why.push('репозиторий прогона не назван');
  return why.length ? why.join('; ') : true;
});
check('gates.js из командной строки: --only на чистом дереве с id, объявленным в двух репозиториях, гонит его в обоих', () => {
  const x = gateRunCases().cli.onlyCleanBoth;
  const why = [];
  if (x.hung || x.code !== 0) why.push(cliSeen(x));
  if (!/--- sf \/ p-both: ok/.test(x.out)) why.push('p-both не прогнан в sf');
  if (!/--- other \/ p-both: ok/.test(x.out)) why.push('p-both не прогнан в other');
  return why.length ? why.join('; ') : true;
});
check('gates.js из командной строки: --only=p-pass,o-only на чистом дереве гонит p-pass в sf и o-only в other', () => {
  const x = gateRunCases().cli.onlyCleanMixed;
  const why = [];
  if (x.hung || x.code !== 0) why.push(cliSeen(x));
  if (!/--- sf \/ p-pass: ok/.test(x.out)) why.push('p-pass не прогнан в sf');
  if (!/--- other \/ o-only: ok/.test(x.out)) why.push('o-only не прогнан в other');
  return why.length ? why.join('; ') : true;
});
check('gates.js из командной строки: снятый по пределу гейт - «СНЯТ ПО ПРЕДЕЛУ» в итоге и сводке, код 1, lastGates не зелёный', () => {
  const all = gateRunCases();
  const x = all.cli.full;
  const why = [];
  if (x.hung || x.code !== 1) why.push(cliSeen(x));
  if (!/--- sf \/ p-hang: СНЯТ ПО ПРЕДЕЛУ 1 с/.test(x.out)) why.push('нет итога «СНЯТ ПО ПРЕДЕЛУ» гейта p-hang');
  if (!/p-hang\s+.*\s+СНЯТ ПО ПРЕДЕЛУ 1 с \(/.test(x.out)) why.push('нет «СНЯТ ПО ПРЕДЕЛУ» в сводке');
  if (!/p-pass\s+.*\s+ok \(/.test(x.out)) why.push('быстрый гейт не ok в сводке');
  if (all.lastGates.full !== 1) why.push('lastGates полного прогона - ' + all.lastGates.full + ', ждали 1');
  return why.length ? why.join('; ') : true;
});
/** Вывод одного гейта прогона: от «=== repo / id:» до конца строки «--- repo / id:», '' - если гейта нет. */
function gateSection(out, repo, id) {
  const start = out.indexOf('=== ' + repo + ' / ' + id + ': ');
  if (start < 0) return '';
  const end = out.indexOf('--- ' + repo + ' / ' + id + ': ', start);
  if (end < 0) return out.slice(start);
  const eol = out.indexOf('\n', end);
  return eol < 0 ? out.slice(start) : out.slice(start, eol);
}
check('gates.js из командной строки: файл вывода болтливого гейта подписан как срезанный, не «Полный вывод»', () => {
  const x = gateRunCases().cli.full;
  if (x.hung) return cliSeen(x);
  // красный p-hang того же прогона подписан «Полный вывод» по праву - смотрим только p-flood
  const flood = gateSection(x.out, 'sf', 'p-flood');
  const why = [];
  if (!flood) why.push('нет вывода гейта p-flood');
  if (/Полный вывод: /.test(flood)) why.push('срезанный вывод подписан «Полный вывод»');
  if (!/Вывод в файле - первые и последние байты, середина \(\d+ байт\) срезана пределом памяти gates\.js: /.test(flood)) why.push('нет подписи о срезе');
  return why.length ? why.join('; ') + '; ' + cliSeen(x) : true;
});
check('gates.js из командной строки: короткий красный гейт - полный вывод в файле, путь напечатан под выводом', () => {
  const all = gateRunCases();
  const x = all.cli.failShort;
  const why = [];
  if (x.hung || x.code !== 1) why.push(cliSeen(x));
  const printed = /Полный вывод: (.+)/.exec(gateSection(x.out, 'sf', 'p-fail-short'));
  const log = all.logs.find((l) => /^gates-sf-p-fail-short-\d+\.log$/.test(l.name));
  if (!log) why.push('файла gates-sf-p-fail-short-<pid>.log нет; файлы: ' + JSON.stringify(all.logs.map((l) => l.name)));
  else if (!/short-red-line/.test(log.text)) why.push('в файле нет вывода гейта: ' + JSON.stringify(log.text.slice(0, 120)));
  if (!printed) why.push('путь файла не напечатан под выводом гейта');
  else if (log && path.basename(printed[1].trim()) !== log.name) why.push('напечатан не тот путь: ' + printed[1].trim());
  return why.length ? why.join('; ') : true;
});
check('gates.js из командной строки: короткий зелёный гейт файла вывода не оставляет и пути не печатает', () => {
  const all = gateRunCases();
  const x = all.cli.onlyClean;
  const glob = gateSection(x.out, 'sf', 'p-glob');
  const why = [];
  if (x.hung || x.code !== 0) why.push(cliSeen(x));
  if (!glob) why.push('гейт p-glob не прогнан');
  if (/Полный вывод: /.test(glob)) why.push('у зелёного гейта напечатан путь файла');
  const left = all.logs.filter((l) => /^gates-sf-p-glob-/.test(l.name)).map((l) => l.name);
  if (left.length) why.push('зелёный гейт оставил файл: ' + JSON.stringify(left));
  return why.length ? why.join('; ') : true;
});
check('gates.js из командной строки: длинный зелёный гейт - файл вывода есть и путь напечатан (исключение из «зелёный лог не пишет»: экранный вывод срезан)', () => {
  const all = gateRunCases();
  const x = all.cli.longGreen;
  const section = gateSection(x.out, 'sf', 'p-long-green');
  const why = [];
  if (x.hung || x.code !== 0) why.push(cliSeen(x));
  if (!/\.\.\. срезано \d+ строк \.\.\./.test(section)) why.push('экранный вывод не срезан - проба не о длинном гейте');
  const printed = /Полный вывод: (.+)/.exec(section);
  const log = all.logs.find((l) => /^gates-sf-p-long-green-\d+\.log$/.test(l.name));
  if (!log) why.push('файла gates-sf-p-long-green-<pid>.log нет');
  else if (!/long-green-line-130/.test(log.text)) why.push('в файле нет середины вывода');
  if (!printed) why.push('путь файла не напечатан');
  return why.length ? why.join('; ') : true;
});
check('gates.js из командной строки: граница FULL_LIMIT - 200 строк зелёного гейта целиком и без файла, 201 - срез и файл вывода', () => {
  const all = gateRunCases();
  const why = [];
  const at = gateSection(all.cli.green200.out, 'sf', 'p-green-200');
  const past = gateSection(all.cli.green201.out, 'sf', 'p-green-201');
  if (all.cli.green200.hung || all.cli.green200.code !== 0) why.push('200: ' + cliSeen(all.cli.green200));
  if (all.cli.green201.hung || all.cli.green201.code !== 0) why.push('201: ' + cliSeen(all.cli.green201));
  if (/\.\.\. срезано /.test(at) || !/edge-line-100\b/.test(at)) why.push('200 строк срезаны на экране');
  if (/Полный вывод: |Вывод в файле/.test(at)) why.push('у 200 строк напечатан путь файла');
  const left = all.logs.filter((l) => /^gates-sf-p-green-200-/.test(l.name)).map((l) => l.name);
  if (left.length) why.push('200 строк оставили файл: ' + JSON.stringify(left));
  if (!/\.\.\. срезано 101 строк \.\.\./.test(past)) why.push('201 строка не срезана на экране до 40 + 60');
  if (!/Полный вывод: /.test(past)) why.push('у 201 строки не напечатан путь файла');
  if (!all.logs.some((l) => /^gates-sf-p-green-201-\d+\.log$/.test(l.name) && /edge-line-100\b/.test(l.text))) why.push('у 201 строки нет файла с серединой');
  return why.length ? why.join('; ') : true;
});
check('gates.js из командной строки: файл вывода с тем же pid от прошлого прогона заменён файлом этого прогона', () => {
  const all = gateRunCases();
  const x = all.cli.existingLog;
  const section = gateSection(x.out, 'sf', 'p-fail-short');
  const why = [];
  if (x.hung || x.code !== 1) why.push(cliSeen(x));
  const logs = all.existingLogs || [];
  if (!logs.length) why.push('файла вывода нет - проба не о файле с тем же pid');
  for (const l of logs) {
    if (/stale-log-of-another-run/.test(l.text)) why.push('в файле ' + l.name + ' остался вывод прошлого прогона');
    else if (!/short-red-line/.test(l.text)) why.push('в файле ' + l.name + ' нет вывода гейта');
  }
  if (/Файл вывода не записан/.test(section)) why.push('запись отказана: ' + (/Файл вывода не записан[^\n]*/.exec(section) || [''])[0]);
  if (!/Полный вывод: /.test(section)) why.push('путь файла не напечатан');
  return why.length ? why.join('; ') : true;
});
check('gates.js из командной строки: сбой записи файла у срезанного вывода говорит, что потеряно, а не «выше - всё»', () => {
  const all = gateRunCases();
  const why = [];
  const long = gateSection(all.cli.longGreenNoLog.out, 'sf', 'p-long-green');
  const flood = gateSection(all.cli.floodNoLog.out, 'sf', 'p-flood');
  if (all.cli.longGreenNoLog.hung || all.cli.longGreenNoLog.code !== 0) why.push('длинный: ' + cliSeen(all.cli.longGreenNoLog));
  if (all.cli.floodNoLog.hung || all.cli.floodNoLog.code !== 0) why.push('болтливый: ' + cliSeen(all.cli.floodNoLog));
  if (!/Файл вывода не записан \(EACCES\): вывод выше неполон, потеряны срезанные на экране 160 строк середины\./.test(long)) {
    why.push('длинный: потеря среза экрана не названа: ' + JSON.stringify((/Файл вывода[^\n]*/.exec(long) || [''])[0]));
  }
  if (!/Файл вывода не записан \(EACCES\): вывод выше неполон, потеряны срезанные на экране \d+ строк середины и середина \(\d+ байт\), срезанная пределом памяти gates\.js\./.test(flood)) {
    why.push('болтливый: потеря среза памяти не названа: ' + JSON.stringify((/Файл вывода[^\n]*/.exec(flood) || [''])[0]));
  }
  if (/всё, что есть|весь вывод/.test(long + flood)) why.push('срезанный вывод назван полным');
  return why.length ? why.join('; ') : true;
});
check('gates.js из командной строки: красный гейт без вывода файла не оставляет и пути не печатает', () => {
  const all = gateRunCases();
  const x = all.cli.failSilent;
  const section = gateSection(x.out, 'sf', 'p-fail-silent');
  const why = [];
  if (x.hung || x.code !== 1) why.push(cliSeen(x));
  if (!/\(команда ничего не вывела\)/.test(section)) why.push('нет строки «команда ничего не вывела»');
  if (/Полный вывод: |Вывод в файле/.test(section)) why.push('напечатан путь файла пустого вывода');
  const left = all.logs.filter((l) => /^gates-sf-p-fail-silent-/.test(l.name)).map((l) => l.name);
  if (left.length) why.push('оставлен файл пустого вывода: ' + JSON.stringify(left));
  return why.length ? why.join('; ') : true;
});
check('gates.js из командной строки: сбой записи файла вывода назван, пути нет, вердикт гейта прежний', () => {
  const all = gateRunCases();
  const x = all.cli.failShortNoLog;
  const section = gateSection(x.out, 'sf', 'p-fail-short');
  const spy = all.spy.failShortNoLog;
  const why = [];
  if (x.hung || x.code !== 1) why.push(cliSeen(x));
  if (!spy || !spy.logWrites.length) why.push('запись файла вывода не пробовалась - проба не о сбое записи');
  if (!/Файл вывода не записан \(EACCES\): выше - весь вывод этого гейта\./.test(section)) why.push('сбой записи не назван или не сказано, что вывод выше целый');
  if (/Полный вывод: |Вывод в файле/.test(section)) why.push('напечатан путь файла, которого нет');
  if (!/short-red-line/.test(section)) why.push('вывод гейта не напечатан');
  if (!/ПАДАЕТ/.test(section)) why.push('вердикт гейта не «ПАДАЕТ»');
  return why.length ? why.join('; ') : true;
});
check('gates.js из командной строки: файл вывода пишется только владельцу (mode 0o600) и создаётся заново (flag wx)', () => {
  const all = gateRunCases();
  const spy = all.spy.failShort;
  const writes = spy ? spy.logWrites : [];
  const why = [];
  if (!writes.length) why.push('запись файла вывода не замечена');
  const loose = writes.filter((w) => w.mode !== 0o600);
  if (loose.length) why.push('режим файла не 0o600: ' + JSON.stringify(loose));
  // без wx запись в файл, оставшийся от прошлого прогона с тем же pid, сохранила бы его права
  const reused = writes.filter((w) => w.flag !== 'wx');
  if (reused.length) why.push('файл не создаётся заново (flag не wx): ' + JSON.stringify(reused));
  if (process.platform !== 'win32') {
    const log = all.logStats && all.logStats.find((l) => /^gates-sf-p-fail-short-\d+\.log$/.test(l.name));
    if (log && (log.mode & 0o077) !== 0) why.push('файл на диске доступен не только владельцу: ' + log.mode.toString(8));
  }
  return why.length ? why.join('; ') : true;
});
check('gates.js из командной строки: файлы вывода старше недели удалены, свежий, чужой файл каталога и файл TEMP с тем же именем на месте', () => {
  const all = gateRunCases();
  const names = all.logDirNames || [];
  const why = [];
  if (names.includes('gates-sf-p-old-1.log')) why.push('файл вывода старше недели не удалён');
  if (!names.includes('gates-sf-p-recent-1.log')) why.push('удалён файл вывода моложе недели');
  if (!names.includes('gates-notes.txt')) why.push('удалён чужой файл каталога sf-gates');
  if (!(all.tmpNames || []).includes('gates-other-tool-1.log')) why.push('удалён чужой файл TEMP вне каталога sf-gates');
  return why.length ? why.join('; ') : true;
});
check('gates.js из командной строки: каталог файлов вывода читается для чистки один раз за прогон, не на каждый файл', () => {
  const all = gateRunCases();
  const spy = all.spy.full;
  const why = [];
  const written = spy ? spy.logWrites.length : 0;
  if (written < 2) why.push('полный прогон записал ' + written + ' файл(а) вывода - проба не о нескольких записях');
  if (!spy || spy.logDirReads !== 1) why.push('чтений каталога sf-gates: ' + (spy ? spy.logDirReads : 'нет шпиона'));
  return why.length ? why.join('; ') : true;
});
check('gates.js из командной строки: сбой чистки (чтение каталога, удаление старого файла) гейт не роняет - вердикт прежний, файл вывода записан', () => {
  const all = gateRunCases();
  const why = [];
  for (const k of ['readdir', 'unlink']) {
    const x = all.cli['prune-' + k];
    const spy = all.spy['prune-' + k];
    const section = gateSection(x.out, 'sf', 'p-fail-short');
    const names = (all.pruneLogNames && all.pruneLogNames[k]) || [];
    if (x.hung || x.code !== 1) why.push(k + ': ' + cliSeen(x));
    if (k === 'readdir' && !(spy && spy.logDirReads > 0)) why.push('readdir: чтение каталога не пробовалось - проба не о сбое');
    if (k === 'unlink' && !(spy && spy.logUnlinks > 0)) why.push('unlink: удаление старого файла не пробовалось - проба не о сбое');
    if (!/ПАДАЕТ/.test(section)) why.push(k + ': вердикт гейта не «ПАДАЕТ»');
    if (!/Полный вывод: /.test(section)) why.push(k + ': путь файла вывода не напечатан');
    if (!names.some((n) => /^gates-sf-p-fail-short-\d+\.log$/.test(n))) why.push(k + ': файла вывода нет: ' + JSON.stringify(names));
    if (k === 'unlink' && !names.includes('gates-sf-p-old-2.log')) why.push('unlink: старый файл пропал, хотя удаление отказало');
  }
  return why.length ? why.join('; ') : true;
});
check('gates.js из командной строки: гейт без предела - «ПАДАЕТ, нет предела timeoutSec» в сводке, код 1, команда не запускалась', () => {
  const all = gateRunCases();
  const x = all.cli.onlyNoLimit;
  const why = [];
  if (x.hung || x.code !== 1) why.push(cliSeen(x));
  if (!/p-nolimit\s+.*\s+ПАДАЕТ, нет предела timeoutSec \(/.test(x.out)) why.push('нет «ПАДАЕТ, нет предела timeoutSec» в сводке');
  if (all.cliMarkerWritten) why.push('команда гейта без предела запускалась');
  if (all.lastGates.onlyNoLimit !== null) why.push('частичный прогон поставил lastGates ' + all.lastGates.onlyNoLimit);
  return why.length ? why.join('; ') : true;
});
for (const [signal, exitCode] of PROBE_SIGNALS) {
  check('gates.js из командной строки: ' + signal + ' снимает дерево идущего гейта, код ' + exitCode + ', отметки нет', () => {
    const all = gateRunCases();
    const x = all.cli[signal];
    const w = all.watch[signal];
    const why = [];
    if (x.hung || x.code !== exitCode) why.push(cliSeen(x));
    if (!w.started) why.push('внук гейта не стартовал - сигнал не послан');
    if (w.alive) why.push('внук ' + w.pid + ' жив после выхода gates.js - дерево гейта не снято');
    if (!new RegExp('прерван \\(' + signal + '\\): снято деревьев гейтов - 1').test(x.err)) why.push('прерывание и снятое дерево не названы в stderr');
    if (all.lastGates[signal] !== null) why.push('поставлена отметка lastGates ' + all.lastGates[signal]);
    return why.length ? why.join('; ') : { note: (x.ms / 1000).toFixed(1) + ' с' };
  });
}
check('gates.js из командной строки: сигнал после выхода оболочки гейта не снимает ничего повторно (POSIX - одно снятие группы, Windows - ни одного taskkill)', () => {
  const all = gateRunCases();
  const x = all.cli.afterExit;
  const s = all.spy.afterExit;
  const why = [];
  if (x.hung || x.code !== 143) why.push(cliSeen(x));
  if (!all.watch.afterExit.started) why.push('внук гейта не стартовал - сигнал не послан');
  if (!/оболочка уже вышла, остаток не снимается - 1/.test(x.err)) why.push('вышедшая оболочка не названа в stderr');
  if (!s) why.push('счётчик снятий не записан');
  else if (process.platform === 'win32' ? s.taskkills !== 0 : s.groupKills !== 1) {
    why.push('снятий после выхода оболочки: группе ' + s.groupKills + ', taskkill ' + s.taskkills);
  }
  return why.length ? why.join('; ') : true;
});
// После предела «снят» - только когда снятие подтверждено и вывод закрылся в окне ожидания; иначе
// «СНЯТЬ РУКАМИ» с обоими фактами (D2): отказ снятия, закрылся ли вывод
check('gates.js из командной строки: снятие по пределу отказало, вывод не закрылся - код 1, оба факта, в сводке «СНЯТЬ РУКАМИ», не «снят»', () => {
  const x = gateRunCases().cli.killFail;
  const why = [];
  if (x.hung || x.code !== 1) why.push(cliSeen(x));
  if (!/снять дерево процессов не удалось: [^\n]*; вывод не закрылся за [^\n]*; снять руками/.test(x.out)) why.push('отказ снятия и открытый вывод не названы');
  if (/гейт снят по пределу|СНЯТ ПО ПРЕДЕЛУ/.test(x.out)) why.push('неснятый гейт назван снятым');
  if (!/p-stuck\s+.*\s+ПРЕДЕЛ 1 с, СНЯТЬ РУКАМИ \(/.test(x.out)) why.push('нет «ПРЕДЕЛ 1 с, СНЯТЬ РУКАМИ» в сводке');
  return why.length ? why.join('; ') : true;
});
// Отказ снятия, после которого вывод закрылся: закрывшийся пайп не доказывает, что дерева нет -
// «СНЯТЬ РУКАМИ», в тексте отказ и «вывод закрылся» фактом
check('gates.js из командной строки: снятие по пределу отказало, а вывод закрылся - код 1, «СНЯТЬ РУКАМИ», отказ и закрытие названы', () => {
  const x = gateRunCases().cli.killFailClosed;
  const why = [];
  if (x.hung || x.code !== 1) why.push(cliSeen(x));
  if (!/снять дерево процессов не удалось: [^\n]*; вывод закрылся; снять руками/.test(x.out)) why.push('отказ снятия и закрытый вывод не названы');
  if (/гейт снят по пределу|СНЯТ ПО ПРЕДЕЛУ|дерево вышло/.test(x.out)) why.push('по закрывшемуся выводу гейт назван снятым');
  if (!/p-slow\s+.*\s+ПРЕДЕЛ 1 с, СНЯТЬ РУКАМИ \(/.test(x.out)) why.push('нет «ПРЕДЕЛ 1 с, СНЯТЬ РУКАМИ» в сводке');
  return why.length ? why.join('; ') : true;
});
// Снятие ответило успехом, а вывод не закрылся: держатель пайпа жив - «СНЯТЬ РУКАМИ», не «снят»
check('gates.js из командной строки: снятие по пределу ответило успехом, вывод не закрылся - код 1, «СНЯТЬ РУКАМИ», не «снят»', () => {
  const x = gateRunCases().cli.killNoop;
  const why = [];
  if (x.hung || x.code !== 1) why.push(cliSeen(x));
  if (!/дерево процессов снято; вывод не закрылся за [^\n]*; снять руками/.test(x.out)) why.push('открытый после снятия вывод не назван');
  if (/гейт снят по пределу|СНЯТ ПО ПРЕДЕЛУ/.test(x.out)) why.push('гейт с живым держателем вывода назван снятым');
  if (!/p-noop\s+.*\s+ПРЕДЕЛ 1 с, СНЯТЬ РУКАМИ \(/.test(x.out)) why.push('нет «ПРЕДЕЛ 1 с, СНЯТЬ РУКАМИ» в сводке');
  return why.length ? why.join('; ') : true;
});
// stdin гейту не даётся: команда, читающая ввод до конца, получает конец сразу, даже когда у самого
// gates.js stdin - открытый пайп (inherit или свой pipe держали бы гейт до предела)
check('gates.js из командной строки: гейт, читающий stdin до конца, при открытом stdin gates.js получает конец ввода сразу - ok', () => {
  const x = gateRunCases().cli.stdin;
  const why = [];
  if (x.hung || x.code !== 0) why.push(cliSeen(x));
  if (!/stdin-end/.test(x.out)) why.push('гейт не получил конец ввода');
  if (!/--- sf \/ p-stdin: ok/.test(x.out)) why.push('p-stdin не ok');
  return why.length ? why.join('; ') : { note: (x.ms / 1000).toFixed(1) + ' с' };
});

// Полный прогон дольше предела foreground-вызова Bash: текст, который велит гнать gates.js (команды
// обвязки и подсказка report-honesty.js), велит гнать его в фоне, иначе инструмент снимет gates.js
// раньше предела гейта - без имени гейта и сводки (E0-12M, C2, D5). Строка с вызовом
// `node .claude/hooks/gates.js` (кроме `--list`) или следующая за ней называет `run_in_background: true`.
check('команды и report-honesty.js, которые велят гнать gates.js, велят гнать его в фоне (run_in_background: true рядом с вызовом)', () => {
  const dir = path.join(CLAUDE, 'commands');
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort().map((n) => path.join(dir, n));
  files.push(path.join(HOOKS, 'report-honesty.js'));
  const why = [];
  let seen = 0;
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('node .claude/hooks/gates.js') === -1 || /gates\.js --list/.test(lines[i])) continue;
      seen++;
      if (!/run_in_background: true/.test(lines[i] + '\n' + (lines[i + 1] || ''))) {
        why.push(path.basename(file) + ':' + (i + 1) + ' «' + lines[i].trim().slice(0, 60) + '»');
      }
    }
  }
  if (!seen) return 'ни одна команда не гонит gates.js - проба смотрит не туда';
  return why.length ? 'вызов без run_in_background: true рядом: ' + why.join('; ') : { note: seen + ' вызовов' };
});

/**
 * Выбирает ли selectGates из самого gates.js (экспорт модуля, а не повтор функции, L-008:
 * правка обработки when там обязана краснеть здесь) гейт gate на одном изменённом файле file
 * при полном прогоне (без --only). Вызов selectGates в пробах выбора - только здесь: gateProbe и
 * пробы отказа на изменённом when зовут selects (проба --only выше зовёт его со списком only).
 * Модуль - через gatesModule: gates.js не прошёл пробу require выше - исключение (красная строка).
 */
function selects(gate, file) {
  const { selectGates } = gatesModule();
  if (typeof selectGates !== 'function') throw new Error('gates.js не экспортирует функцию selectGates');
  const picked = selectGates([gate], [file], null);
  return Boolean(picked && picked[0] && picked[0].run);
}

/**
 * Гейт id из rules.sf.json и runs(file) - selects на нём, с мемо на гейт: пробы графа и стабов
 * спрашивают о тех же файлах много раз за прогон (TECH_DEBT 21.10.2026 E0-12L круги 3 и 4,
 * время прогона: `runs` без мемо). Нет гейта - исключение (красная строка check). Счёт: asked -
 * вопросов runs, selected - вызовов selects, seen - разных файлов; их сверяет проба в конце прогона
 * (selected === seen.size: каждый файл спрошен у gates.js один раз).
 */
const gateProbes = new Map();
function gateProbe(id) {
  if (gateProbes.has(id)) return gateProbes.get(id);
  const gate = ((repoRules && repoRules.gates) || []).find((g) => g.id === id);
  if (!gate) throw new Error('гейта ' + id + ' нет в правилах');
  const seen = new Map();
  const res = { gate, seen, asked: 0, selected: 0 };
  const select = (file) => {
    res.selected++;
    return selects(gate, file);
  };
  res.runs = (file) => {
    res.asked++;
    if (!seen.has(file)) seen.set(file, select(file));
    return seen.get(file);
  };
  gateProbes.set(id, res);
  return res;
}

/** Пути файлов, названные в note гейта; шаблоны с * и каталоги (`scripts/lib/**`) - нет. */
function notePaths(gate) {
  const note = String(gate.note || '');
  const named = note.match(/(?<![\w./*-])(?:test|scripts|apps|packages|infra|docs)\/[\w./-]*\.(?:ts|mjs|js|json|ya?ml|md)\b/g) || [];
  return [...new Set(named)];
}

/**
 * Гейты, чьи пути из note сверяются с диском (notePathsOnDisk): каждый гейт rules, в note которого
 * есть путь файла (notePaths). Выводом, а не списком: гейт, чей note начал называть файл, сверяется
 * сразу (E0-12N, docs/TECH_DEBT.md § E0-12N: прежний перечень пяти гейтов заменён этим выводом).
 */
function noteCheckedGates(rules) {
  return ((rules && rules.gates) || []).filter((gate) => notePaths(gate).length > 0);
}

/**
 * Гейты, чьи пути из note (вне их when и cmd) обязаны выбирать сам harness-selftest (проба выбора
 * гейта harness-selftest ниже): переименование такого файла краснеет локально, а не только в CI.
 * Уже noteCheckedGates: пути из note test:int, build и самого harness-selftest сверяются с диском
 * на каждом прогоне, но их правка гейт не выбирает (E0-12N). Список из двух гейтов - решение Q12
 * техлида (docs/DECISIONS.md, 18.10.2026, E0-12F): пути, которые читает when/cmd гейта-владельца
 * note, selftest не выбирают, иначе selftest идёт на каждой задаче; подтверждено решением ОВ1
 * E0-12N (21.10.2026). Расширять список или when harness-selftest - только новым решением техлида.
 */
const NOTE_SELECTING_GATES = ['compose', 'tracker'];

/**
 * Боевые формы роута: пробы S14 и пропуска standards в модуле роута читают эти файлы как пропуск,
 * поэтому каждый из них выбирает гейт harness-selftest (сверка - в его пробе выбора ниже).
 */
const ROUTE_FORMS = ['apps/api/src/routes/health/index.ts', 'apps/api/src/routes/system/index.ts'];

/**
 * Причина отказа notePathsOnDisk: файла нет в выборке git - он удалён, переименован или
 * игнорируется (тогда он на этой машине на диске, а в CI его не будет).
 */
const NOT_LISTED = 'нет в выборке git (удалён, переименован или игнорируется)';

/**
 * Пути файлов, названные в note гейта (`test/x.test.ts`, `scripts/x.mjs`, ...), есть в дереве:
 * note - то, что читает человек о гейте, и опечатка в нём переживала бы selftest (L-021).
 * Дерево - выборка git (listedFiles: в индексе или новые и не игнорируемые), а не existsSync:
 * игнорируемый файл, который лежит только на этой машине, и сбой stat (EPERM) не сходят
 * за файл, которого в CI не будет. Шаблоны с * и каталоги (`scripts/lib/**`) не сверяются.
 * listed - выборка для пробы; по умолчанию - выборка настоящего дерева.
 */
function notePathsOnDisk(gate, listed) {
  const files = notePaths(gate);
  if (!files.length) return 'в note гейта ' + gate.id + ' не найдено ни одного пути файла';
  const inTree = listed || listedFiles();
  const missing = files.filter((f) => !inTree.has(f));
  return missing.length ? 'в note гейта ' + gate.id + ' ' + NOT_LISTED + ': ' + missing.join(', ') : { note: files.length + ' путей' };
}

/** Отказы notePathsOnDisk по каждому гейту noteCheckedGates(rules); пусто - все пути на диске. */
function notePathViolations(rules, listed) {
  return noteCheckedGates(rules).map((gate) => notePathsOnDisk(gate, listed)).filter((r) => typeof r === 'string');
}

/** Файлы настоящего дерева в выборке git (trackedFiles с новыми неигнорируемыми) - один раз за прогон. */
let listedCache = null;
function listedFiles() {
  if (!listedCache) listedCache = new Set(trackedFiles({ others: true }));
  return listedCache;
}

check('пути файлов в note каждого гейта rules.sf.json, где они есть, на диске', () => {
  const checked = noteCheckedGates(repoRules).map((gate) => gate.id);
  if (!checked.length) return 'ни в одном note гейта rules.sf.json нет пути файла - сверять нечего';
  const missing = notePathViolations(repoRules);
  return missing.length ? missing.join('; ') : { note: checked.join(', ') };
});
// Проба отказа (L-008): гейт, которого нет ни в одном списке, с путём в note, которого нет на
// диске, - красный; без пути в note - не сверяется.
check('пути note: гейт вне прежнего перечня с путём, которого нет на диске, - отказ', () => {
  const probe = { id: 'sf-selftest-note', note: 'читает scripts/sf-selftest-missing.mjs' };
  const quiet = { id: 'sf-selftest-quiet', note: 'без путей файлов' };
  const rules = { gates: [...((repoRules && repoRules.gates) || []), probe, quiet] };
  const ids = noteCheckedGates(rules).map((gate) => gate.id);
  if (ids.includes(quiet.id)) return 'гейт без пути в note попал в сверку';
  const got = notePathViolations(rules);
  const want = 'в note гейта sf-selftest-note нет в выборке git (удалён, переименован или игнорируется): scripts/sf-selftest-missing.mjs';
  return (got.length === 1 && got[0] === want) || 'ожидался один отказ «' + want + '», получено ' + JSON.stringify(got);
});
// Проба отказа (L-008): файл, который есть на диске, но не в выборке git (игнорируемый), - отказ.
check('пути note: файл на диске, которого нет в выборке git, - отказ', () => {
  const real = 'scripts/check-no-search-list.mjs';
  if (!fs.existsSync(path.join(ROOT, real))) return 'нет ' + real + ' - пробе не на чем стоять';
  const probe = { id: 'sf-selftest-ignored', note: 'читает ' + real };
  const got = notePathViolations({ gates: [probe] }, new Set());
  const want = 'в note гейта sf-selftest-ignored нет в выборке git (удалён, переименован или игнорируется): ' + real;
  return (got.length === 1 && got[0] === want) || 'ожидался один отказ «' + want + '», получено ' + JSON.stringify(got);
});

/**
 * Общий каркас пробы гейта по glob (L-008): решение принимает настоящий selectGates,
 * своей копии разбора when нет. Выбор, пропуск и дополнительные проверки - отдельные
 * строки: отказ одной не скрывает состояние другой.
 *   spec.runWhat / spec.skipWhat - хвосты названий строк выбора и пропуска;
 *   spec.mustRun / spec.mustSkip - файлы, на которых гейт обязан выбираться / пропускаться;
 *   spec.extra - [{ name, fn({ gate, runs }, spec), graph, int }]: fn получает пробу гейта
 *     (gateProbe) и тот же spec вторым аргументом; результат fn - как у check; graph - fn читает
 *     граф turbo настоящего дерева (GRAPH_GATE) и без него не гоняется; int - ещё и test/imports.ts
 *     с дочерним vitest или require(esm) - та же граница Node (intGuard).
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
    checkIgnoreVerdict(git(['check-ignore', '--', ...spec.mustRun], { cwd: ROOT }), spec.mustRun.length));
  // x.graph - проба графа turbo настоящего дерева: без графа она не гоняется (snapshotGate)
  for (const x of spec.extra || []) {
    const name = 'гейт ' + id + ': ' + x.name;
    const fn = () => x.fn(gateProbe(id), spec);
    check(name, x.int ? intGuard(name, fn) : x.graph ? GRAPH_GATE.guard(name, fn) : fn);
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

/**
 * Маски верхнего уровня when вида `glob:{a,b/{c,d}}` - ['a', 'b/{c,d}']: запятые вложенных
 * скобок маску не делят. null - when не такого вида. Это только список масок верхнего уровня,
 * смысл самих масок разбирают gates.js и lib.js (E0-12K, B4).
 */
function whenMasks(when) {
  const m = /^glob:\{([\s\S]*)\}$/.exec(String(when || '').trim());
  if (!m) return null;
  const masks = [];
  let depth = 0;
  let cur = '';
  for (const c of m[1]) {
    if (c === ',' && depth === 0) {
      masks.push(cur);
      cur = '';
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth < 0) return null;
    cur += c;
  }
  if (depth !== 0) return null;
  masks.push(cur);
  return masks;
}

/**
 * extra-строка checkGateSelection, проба отказа: when без маски file не выбирает гейт на file,
 * и проба выбора на нём краснеет; control - файл выбора другой маской (сужение не сломало when).
 * Маска снимается из списка верхнего уровня (whenMasks) по точному равенству, а не подстрокой:
 * `scripts/lib/paths.mjs` не задевает маску `x-scripts/lib/paths.mjs`. Помощник общий для
 * compose и tracker (E0-12M).
 */
function refusalExtra(file, control, name) {
  return {
    name,
    fn: ({ gate }, spec) => {
      if (!spec.mustRun.includes(file)) return 'mustRun гейта не держит ' + file + ' - проба выбора на нём не краснеет';
      const when = String(gate.when || '');
      const masks = whenMasks(when);
      if (!masks) return 'when гейта не вида glob:{…} - проба отказа не построена: ' + when;
      const own = masks.filter((x) => x === file).length;
      if (own !== 1) return 'в when гейта маска ' + file + ' не ровно одна (' + own + ') - проба отказа не построена: ' + when;
      const narrowed = { ...gate, when: 'glob:{' + masks.filter((x) => x !== file).join(',') + '}' };
      const runsNarrowed = (f) => selects(narrowed, f);
      if (!runsNarrowed(control)) return 'суженный when не выбирает гейт и на ' + control + ' - сужение сломало when, проба ничего не доказывает';
      if (runsNarrowed(file)) return 'суженный when всё ещё выбирает гейт на ' + file + ' - проба выбора не краснеет';
      return { note: 'отказ на ' + file };
    },
  };
}

// Список масок when - по структуре: вложенные скобки, точное равенство, не when вида glob:{…}.
check('whenMasks: маски верхнего уровня when, вложенные скобки не делят', () => {
  const got = JSON.stringify([whenMasks('glob:{a/x.mjs,b/{c,d}.yml,x-a/x.mjs}'), whenMasks('glob:a/**'), whenMasks('glob:{a,{b}')]);
  const want = JSON.stringify([['a/x.mjs', 'b/{c,d}.yml', 'x-a/x.mjs'], null, null]);
  return got === want || 'ожидалось ' + want + ', получено ' + got;
});

/**
 * extra-строка checkGateSelection: каждый файл mustRun выбирается своей маской, а не более
 * широкой - ни один его сосед (то же имя с суффиксом, с префиксом, на каталог ниже) гейт не
 * выбирает (E0-12K, P2; общий помощник гейтов compose и tracker - E0-12M). exempt - маски
 * (`docs/*_TASKS.md`), которые when берёт по решению целиком: сосед под ними выбирает гейт законно.
 */
function neighboursExtra(exempt) {
  return {
    name: 'каждый файл выбора выбирает его своей маской, соседи - нет' + (exempt.length ? ' (кроме масок целиком: ' + exempt.join(', ') + ')' : ''),
    fn: ({ runs }, spec) => {
      const neighbours = (f) => {
        const at = f.lastIndexOf('/') + 1;
        return [f + '.bak', f.slice(0, at) + 'x-' + f.slice(at), 'x/' + f];
      };
      const all = spec.mustRun.flatMap(neighbours).filter((f) => !exempt.some((g) => L.matchGlob(g, f)));
      const stray = all.filter((f) => !spec.mustRun.includes(f) && runs(f));
      if (stray.length) return 'when шире файлов, которые гейт читает: выбирает его на ' + stray.join(', ');
      return { note: all.length + ' соседей' };
    },
  };
}

/**
 * extra-строка checkGateSelection: ни один файл настоящего дерева, который видит git
 * (`git ls-files`), кроме mustRun, гейт не выбирает - when не шире файлов выбора пробы на
 * всём дереве, а не только на ручном mustSkip (E0-12M). Отказ - до 10 имён и их число.
 * exempt - маски каталогов, которые when берёт целиком (`packages/db/migrations/**`): файл
 * под ними выбирает гейт законно и в mustRun не перечисляется (E0-12S).
 */
function trackedOutsideExtra(exempt = []) {
  return {
    name: 'ни один файл, который видит git, кроме файлов выбора' + (exempt.length ? ' и масок целиком (' + exempt.join(', ') + ')' : '') + ', его не выбирает',
    fn: ({ runs }, spec) => {
      const r = git(['-c', 'core.quotepath=false', 'ls-files', '-z'], { cwd: ROOT, maxBuffer: LISTING_MAX_BUFFER });
      if (r.error) return 'git ls-files не запустился: ' + r.error.message;
      if (r.status !== 0) return 'git ls-files: ' + (r.status === null ? 'сигнал ' + r.signal : 'код ' + r.status) + ': ' + String(r.stderr || '').trim();
      const files = String(r.stdout || '').split('\0').filter(Boolean);
      if (!files.length) return 'git ls-files не вернул ни одного файла';
      const stray = files.filter((f) => !spec.mustRun.includes(f) && !exempt.some((g) => L.matchGlob(g, f)) && runs(f));
      if (stray.length) {
        return 'when шире файлов выбора: выбирает его на ' + stray.slice(0, 10).join(', ') +
          (stray.length > 10 ? ' и ещё ' + (stray.length - 10) : '') + ' (всего ' + stray.length + ')';
      }
      return { note: files.length + ' файлов git' };
    },
  };
}

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
    // разбирает файлы (E0-12K), и сам разбор YAML читателя (readYaml, E0-12N).
    'scripts/lib/compose-graph.mjs',
    'scripts/lib/yaml-doc.mjs',
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
  // files.mjs, json.mjs, paths.mjs, compose-graph.mjs и yaml-doc.mjs; только
  // корневой .env.test.
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
    // Проба отказа (E0-12J, F15/G1; E0-12K): правило 13 (`init: true` у migrate) на
    // infra/docker-compose.app.yml держит только гейт; маски when берутся по одной, и файл
    // обязан оставаться в mustRun. app.Dockerfile в стек пробы не входит: гейт его не читает.
    refusalExtra('infra/docker-compose.app.yml', 'infra/docker-compose.yml', 'when без infra/docker-compose.app.yml не выбирает его на файле стека приложения (проба отказа)'),
    // Более широкая маска (infra/**, infra/docker/*.dockerignore, **/compose.yaml)
    // краснит пробу на первом же файле, который покрывает (E0-12K, P2).
    neighboursExtra([]),
    // Ручной mustSkip держит неотслеживаемые имена (compose.override.*, deploy/compose.yaml);
    // отслеживаемые сверяются все (E0-12M, TECH_DEBT 20.10.2026 E0-12K).
    trackedOutsideExtra(),
  ],
});

// Скрипт трекера берёт корень из scripts/lib/paths.mjs: правка любого из них
// может сломать render --check так же, как правка tasks.json (E0-12F). when - ровно то,
// что render --check читает (E0-12M, B11): tasks.json, 00_STATUS.md, doc каждой
// задачи (сегодня docs/*_TASKS.md и docs/TECH_DEBT.md) и граф импортов scripts/tasks.mjs.
// Журнал 90_WORKLOG.md render --check не читает: его дописывают done и add.
checkGateSelection('tracker', {
  runWhat: 'трекере, документах задач и графе импортов его скрипта',
  skipWhat: 'посторонних',
  mustRun: [
    'docs/tasks/tasks.json',
    'docs/00_STATUS.md',
    'docs/30_E0_TASKS.md',
    'docs/43_E13_TASKS.md',
    'docs/TECH_DEBT.md',
    'scripts/tasks.mjs',
    'scripts/lib/paths.mjs',
    'scripts/lib/tracker-doc.mjs',
    'scripts/lib/files.mjs',
  ],
  mustSkip: [
    'scripts/check-compose.mjs',
    'scripts/lib.mjs',
    'apps/web/scripts/lib/a.mjs',
    // помощники scripts/lib, которые скрипт трекера не импортирует
    'scripts/lib/manifest.mjs',
    'scripts/lib/compose-graph.mjs',
    'scripts/lib/json.mjs',
    // документы, которые render --check не читает: журнал, не doc ни одной задачи
    'docs/90_WORKLOG.md',
    'docs/60_HARNESS.md',
    'docs/DECISIONS.md',
    'docs/adr/README.md',
    'docs/tasks/other.json',
    'docsx/a.md',
    'apps/web/docs/a.md',
    'tasks/2026-10-18-E0-12F.md',
    'README.md',
  ],
  extra: [
    { name: 'пути файлов в его note на диске', fn: ({ gate }) => notePathsOnDisk(gate) },
    // Проба отказа: when без маски tracker-doc.mjs не выбирает гейт на этом файле (E0-12M).
    refusalExtra('scripts/lib/tracker-doc.mjs', 'scripts/tasks.mjs', 'when без scripts/lib/tracker-doc.mjs не выбирает его на этом файле (проба отказа)'),
    neighboursExtra(['docs/*_TASKS.md']),
    // when - перечень документов задач на сегодня: doc новой задачи вне него краснеет здесь,
    // а не молчит до первого переименования этого документа (E0-12M, B11).
    {
      name: 'doc каждой задачи docs/tasks/tasks.json его выбирает',
      fn: ({ runs }) => {
        const docs = [...new Set(readJson(path.join(ROOT, 'docs', 'tasks', 'tasks.json')).map((t) => t.doc))];
        const missed = docs.filter((d) => !runs('docs/' + d));
        if (missed.length) return 'when не выбирает гейт на документе задачи: ' + missed.map((d) => 'docs/' + d).join(', ');
        return { note: docs.length + ' документов' };
      },
    },
    // Выбор на документе задачи обещает, что render --check его читает: на копии трекера с
    // удалённым документом задачи гейт красный и называет его, на полной копии - зелёный.
    {
      name: 'render --check краснеет на удалённом документе задачи и зелёный на полной копии',
      fn: () => {
        const tmp = tempDir('tracker');
        try {
          const tasks = readJson(path.join(ROOT, 'docs', 'tasks', 'tasks.json'));
          fs.mkdirSync(path.join(tmp, 'docs', 'tasks'), { recursive: true });
          fs.copyFileSync(path.join(ROOT, 'docs', 'tasks', 'tasks.json'), path.join(tmp, 'docs', 'tasks', 'tasks.json'));
          // doc из tasks.json не должен уводить запись и удаление за tmp (`..`, абсолютный путь)
          const outside = (d) => {
            if (typeof d !== 'string' || !d) return true;
            const rel = path.relative(path.join(tmp, 'docs'), path.resolve(tmp, 'docs', ...d.split('/')));
            return rel.startsWith('..') || path.isAbsolute(rel);
          };
          const bad = tasks.map((t) => t.doc).find(outside);
          if (bad !== undefined || tasks.some((t) => outside(t.doc))) return 'doc вне tmp: ' + JSON.stringify(bad);
          for (const d of new Set(tasks.map((t) => t.doc))) {
            fs.mkdirSync(path.dirname(path.join(tmp, 'docs', ...d.split('/'))), { recursive: true });
            fs.writeFileSync(path.join(tmp, 'docs', ...d.split('/')), '');
          }
          const cli = (...args) => run(process.execPath, [path.join(ROOT, 'scripts', 'tasks.mjs'), '--root=' + tmp].concat(args), { cwd: ROOT });
          const said = (r) => 'код ' + r.status + ' ' + String(r.stderr || r.stdout || (r.error && r.error.message)).trim().slice(0, 160);
          const render = cli('render');
          if (render.status !== 0) return 'render на копии трекера: ' + said(render);
          const green = cli('render', '--check');
          if (green.status !== 0) return 'render --check на полной копии не зелёный: ' + said(green);
          // документ - doc задачи из самого tasks.json, а не имя из головы: смена doc не роняет пробу
          // по чужой причине; текст отказа - docProblem из scripts/lib/tracker-doc.mjs
          const doc = tasks[0] && tasks[0].doc;
          if (typeof doc !== 'string' || !doc) return 'у первой задачи tasks.json нет doc - удалять нечего';
          fs.rmSync(path.join(tmp, 'docs', ...doc.split('/')));
          const red = cli('render', '--check');
          const gone = new RegExp('docs/' + doc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' is not on disk');
          if (red.status === 0 || !gone.test(String(red.stderr))) return 'render --check без docs/' + doc + ': ' + said(red);
          return { note: 'красный: docs/' + doc };
        } finally {
          releaseTemp(tmp);
        }
      },
    },
  ],
});

// Гейт дрейфа схемы @sf/db (E0-12S): when - ровно то, что читает scripts/check-schema-drift.mjs
// и запуск drizzle-kit через tsx (L-018). Схема и папка миграций - маски целиком: новая таблица
// или миграция выбирает гейт без правки when.
const SCHEMA_DRIFT_WHOLE = ['packages/db/src/schema/**', 'packages/db/migrations/**'];
checkGateSelection('schema-drift', {
  runWhat: 'схеме, миграциях и том, что читает скрипт дрейфа',
  skipWhat: 'посторонних',
  mustRun: [
    'packages/db/src/schema/index.ts',
    'packages/db/src/schema/system.ts',
    'packages/db/migrations/0000_core.sql',
    'packages/db/migrations/meta/_journal.json',
    'packages/db/migrations/meta/0000_snapshot.json',
    'packages/db/drizzle.config.ts',
    // скрипты обхода db:generate/db:check и диапазон drizzle-kit
    'packages/db/package.json',
    // tsx читает их при запуске drizzle-kit: правка ломает запуск
    'packages/db/tsconfig.json',
    'tsconfig.base.json',
    // версии drizzle-kit и tsx
    'pnpm-lock.yaml',
    'scripts/check-schema-drift.mjs',
    'scripts/lib/files.mjs',
    'scripts/lib/json.mjs',
    'scripts/lib/paths.mjs',
  ],
  mustSkip: [
    'packages/db/src/migrate.ts',
    'packages/db/src/migration-lock.ts',
    'packages/db/src/repos/api-usage-log.ts',
    'packages/db/src/schema.ts',
    'packages/db/migrations.json',
    'packages/db/test/tsconfig.json',
    'packages/api/tsconfig.json',
    'tsconfig.json',
    'package.json',
    'scripts/check-compose.mjs',
    'scripts/lib/yaml-doc.mjs',
    'scripts/lib/manifest.mjs',
    'test/check-schema-drift.test.ts',
    'test/schema-drift-fixture.ts',
  ],
  extra: [
    {
      name: 'его скрипт на месте',
      fn: ({ gate }) => {
        const m = /^node\s+(\S+)$/.exec(String(gate.cmd || ''));
        if (!m) return 'cmd гейта schema-drift не node <скрипт>: ' + gate.cmd;
        if (!fs.existsSync(path.join(ROOT, m[1]))) return 'скрипта ' + m[1] + ' нет на диске';
        return true;
      },
    },
    { name: 'пути файлов в его note на диске', fn: ({ gate }) => notePathsOnDisk(gate) },
    // Проба отказа: when без packages/db/tsconfig.json (его читает tsx при запуске drizzle-kit)
    // не выбирает гейт на нём.
    refusalExtra('packages/db/tsconfig.json', 'packages/db/drizzle.config.ts', 'when без packages/db/tsconfig.json не выбирает его на этом файле (проба отказа)'),
    neighboursExtra(SCHEMA_DRIFT_WHOLE),
    trackedOutsideExtra(SCHEMA_DRIFT_WHOLE),
  ],
});

/**
 * Граф задач turbo (selftest-graph.js, E0-12L, решение техлида Р1 21.10.2026): один dry-JSON
 * на прогон для проб build, test:int и harness-selftest. Своего разбора pnpm-workspace.yaml
 * и next.config.* нет: корни, их зависимости и файлы, которые хеширует каждая задача, даёт turbo.
 */
const GRAPH_SCRIPTS = ['build', 'test:int'];

/**
 * Снимок, без которого группа проб не гоняется, - один на прогон: getSnap() зовётся один раз, его
 * результат - state.snap, отказ - state.error. Так устроены граф настоящего дерева (GRAPH_GATE:
 * snap - { dry, ws, patterns, tracked } - dry-JSON, манифесты пакетов dry, шаблоны
 * pnpm-workspace.yaml, tracked - файлы из git ls-files, которые есть на диске) и модуль разбора
 * импортов (IMPORTS_GATE: snap - модуль test/imports.ts). Отказ снимка (нет turbo, код, не JSON,
 * сбой git ls-files; Node ниже границы, сбой require...) - одна красная строка группы с перечнем
 * проб, которые без снимка не гонялись, а не каскад одинаковых красных строк. guard(name, fn) -
 * обёртка пробы группы: при отказе fn не зовётся, строка пробы не пишется (SKIPPED), name уходит в
 * перечень. getSnap - источник снимка (liveSnap, loadImports или подмена в кейсе).
 * opts.lazy - снимок снимается не сразу, а первым take() (ответ дочернего vitest - VITEST_GATE: его
 * ждут только пробы, которым он нужен); take() отдаёт снимок или бросает GateBlocked - проба, которая
 * его зовёт, уходит в перечень, где бы ни был вызов. guard - для снятого сразу снимка.
 */
function snapshotGate(getSnap, opts) {
  const state = { snap: null, error: null, blocked: [], taken: false };
  const takeOnce = () => {
    if (state.taken) return;
    state.taken = true;
    try {
      state.snap = getSnap();
    } catch (e) {
      state.error = (e && e.message) || String(e);
    }
  };
  state.take = () => {
    takeOnce();
    if (state.error !== null) throw new GateBlocked(state);
    return state.snap;
  };
  if (!(opts && opts.lazy)) takeOnce();
  state.guard = (name, fn) => (...args) => {
    if (state.error === null) return fn(...args);
    state.blocked.push(name);
    return SKIPPED;
  };
  return state;
}

/**
 * Строка пробы state (snapshotGate): отказ снимка с перечнем проб, которые не гонялись (what - чьи
 * пробы, в тексте отказа); okNote(snap) - пометка зелёной строки.
 */
function gateVerdict(state, okNote, what) {
  if (state.error !== null) return state.error + '; ' + (what || 'пробы') + ' не гонялись (' + state.blocked.length + '): ' + state.blocked.join('; ');
  return { note: okNote(state.snap) };
}
/** Строка пробы графа state (snapshotGate). */
function graphVerdict(state) {
  return gateVerdict(state, (snap) => snap.dry.tasks.length + ' задач', 'пробы графа');
}

/**
 * Кейс отказа: fn обязан бросить ровно want. Нет исключения или иной текст - красная строка с
 * полученным (L-020: ветка, заменённая на пропуск, краснит свой кейс, а не соседний).
 */
function refusedCheck(name, fn, want) {
  check(name, () => refusalVerdict(fn, want));
}
/** Вердикт кейса отказа (как у check): true - fn бросила ровно want, иначе строка с полученным. */
function refusalVerdict(fn, want) {
  try {
    fn();
  } catch (e) {
    // снимок пробы не снят - не отказ кейса: проба уходит в перечень снимка (outcome)
    if (e instanceof GateBlocked) throw e;
    const got = (e && e.message) || String(e);
    return got === want || 'ожидалось «' + want + '», получено «' + got + '»';
  }
  return 'отказа нет, ожидалось «' + want + '»';
}

/** Граф настоящего дерева (snapshotGate): один снимок на прогон; без модуля графа - отказ снимка. */
const GRAPH_GATE = snapshotGate(liveSnap);

/**
 * Граница Node и модуль разбора импортов (E0-12T, решение техлида Р2 E0-12L): проба test:int
 * грузит test/imports.ts через require (type stripping без флага и require(esm)) и гоняет
 * дочерний vitest. Type stripping включён по умолчанию с 22.18 в линии 22.x и с 23.6 в линии
 * 23.x, в 24+ - всегда; поэтому граница - по линии, а не «мажор больше 22» (NODE_LINES: мажор ->
 * наименьший минор; мажор выше последнего в перечне - годится). Ниже границы или при сбое
 * require - одна красная строка «test/imports.ts: require .ts» с причиной («нужен Node …, у тебя
 * X» или ошибка загрузки), пробы, которым нужен модуль, - SKIPPED (как у графа). Модуль грузится
 * один раз за прогон, на версии этого процесса (IMPORTS_GATE.version - её сверяет кейс).
 */
const NODE_LINES = { 22: 18, 23: 6 };
const NODE_NEED = 'нужен Node 22.18+ (линия 22.x), 23.6+ (линия 23.x) или 24+';
/** Отказ версии version (`v22.17.0`) или null: Node не ниже границы своей линии (NODE_LINES). */
function nodeVerdict(version) {
  const m = /^v?(\d+)\.(\d+)\./.exec(String(version));
  const major = m ? Number(m[1]) : 0;
  const minor = m ? Number(m[2]) : 0;
  const lines = Object.keys(NODE_LINES).map(Number);
  const top = Math.max(...lines);
  const fits = major > top || (lines.includes(major) && minor >= NODE_LINES[major]);
  return fits ? null : NODE_NEED + ', у тебя ' + version;
}
/** test/imports.ts через require на Node version; ниже границы или сбой загрузки - исключение с причиной. */
function loadImports(version) {
  const low = nodeVerdict(version);
  if (low) throw new Error(low + ' (require test/imports.ts и дочерний vitest пробы test:int)');
  let mod;
  try {
    mod = require(path.join(ROOT, 'test', 'imports.ts'));
  } catch (e) {
    throw new Error('require test/imports.ts: ' + ((e && e.message) || String(e)) + ' (в модуле нет относительных импортов и не-стираемого синтаксиса TS?)');
  }
  for (const name of ['importSpecifiers', 'repoRootUses']) {
    if (typeof mod[name] !== 'function') throw new Error('test/imports.ts не экспортирует функцию ' + name);
  }
  if (typeof mod.DYNAMIC_SPECIFIER !== 'string') throw new Error('test/imports.ts не экспортирует строку DYNAMIC_SPECIFIER');
  return mod;
}
/** Модуль test/imports.ts на версии version (snapshotGate с полем version - на какой версии он судился). */
function importsGate(version) {
  return Object.assign(snapshotGate(() => loadImports(version)), { version });
}
const IMPORTS_GATE = importsGate(process.version);
/** Обёртка пробы, которой нужны и граф, и test/imports.ts: без любого из них - SKIPPED. */
function intGuard(name, fn) {
  return GRAPH_GATE.guard(name, IMPORTS_GATE.guard(name, fn));
}

/** Дочерний процесс конфигов vitest (selftest-vitest.mjs) и начало его строки вывода. */
const VITEST_CHILD = path.join(HOOKS, 'selftest-vitest.mjs');
const VITEST_MARK = 'selftest-vitest ';
/** Предел дочернего vitest: замер E0-12T - 0,9 с на три конфига. */
const VITEST_TIMEOUT_MS = 60 * 1000;
/**
 * Код отказа «не запустился», когда pid нет, а повтор той же программы запустился (startVitest):
 * рядом с прочими VITEST_* - первый вызов startVitest (INT_VITEST_START) идёт до тела функций ниже,
 * const ниже него читался бы до инициализации (замечание ревью E2 E0-12T).
 */
const SPAWN_CODE_UNKNOWN = 'код ошибки неизвестен (pid нет, повтор запустился)';
/** Сколько awaitVitest и кейсы ждут конца процесса (pidGone) после строки выхода или SIGKILL. */
const VITEST_GONE_MS = 2000;

/** Команда корня стаба int-пробы и его файлы (пути от каталога стаба). */
const INT_STUB_COMMAND = 'vitest run --config vitest.selftest.config.mjs';
const INT_STUB_BASE = {
  'vitest.selftest.config.mjs': 'export default { test: { setupFiles: ["./vitest/selftest-setup.ts"], globalSetup: ["./vitest/selftest-global.mjs"] } };\n',
  'vitest/selftest-setup.ts': 'import { testEnvFilePath } from "./selftest-paths.js";\n\nvoid testEnvFilePath;\n',
  'vitest/selftest-paths.ts': 'import { join } from "node:path";\n\nconst repoRoot = "";\nexport const testEnvFilePath = join(repoRoot, ".env.test");\n',
  // globalSetup пишет метку и при загрузке, и в setup(): метка после ответа vitest - globalSetup исполнился
  'vitest/selftest-global.mjs': 'import { writeFileSync } from "node:fs";\n\nconst mark = () => writeFileSync(new URL("../global-ran", import.meta.url), "ran");\nmark();\nexport function setup() {\n  mark();\n}\n',
};
/**
 * Стаб: базовые файлы, конфиг с пробелом в имени (пары `-c "…"`, `-c '…'`) и корень `rooted/` для
 * пары с `--root rooted`: его конфиг и setup с именами, которых нет вне `rooted/`, - ответ с ними
 * значит, что vitest получил корень из флага, как у настоящего запуска.
 */
const INT_STUB_FILES = Object.assign({}, INT_STUB_BASE, {
  'vitest space.config.mjs': INT_STUB_BASE['vitest.selftest.config.mjs'],
  'rooted/vitest.selftest.config.mjs': 'export default { test: { setupFiles: ["./vitest/rooted-setup.ts"], globalSetup: ["./vitest/rooted-global.mjs"] } };\n',
  'rooted/vitest/rooted-setup.ts': 'export {};\n',
  'rooted/vitest/rooted-global.mjs': INT_STUB_BASE['vitest/selftest-global.mjs'],
});
/** Метки globalSetup стаба (пишет selftest-global.mjs): ни одной после ответа vitest. */
const INT_STUB_GLOBAL_MARKS = ['global-ran', 'rooted/global-ran'];
/**
 * Пары дочернего vitest по стабу сверх основной: ветки отказа конфига (команда без --config,
 * конфиг, которого нет, оператор оболочки в команде) и разбор флагов (путь в двойных и одинарных
 * кавычках, в том числе с пробелом; --root).
 */
const INT_STUB_PAIRS = {
  noConfig: 'vitest run',
  missingConfig: 'vitest run --config vitest.missing.config.ts',
  shell: 'vitest run --config vitest.selftest.config.mjs && rm -rf x',
  quoted: 'vitest run -c "vitest.selftest.config.mjs"',
  spacedDouble: 'vitest run -c "vitest space.config.mjs"',
  spacedSingle: "vitest run -c 'vitest space.config.mjs'",
  rooted: 'vitest run --root rooted --config vitest.selftest.config.mjs',
};

// Боевой путь «pid нет, повтор запустился» до первого вызова startVitest (замечание ревью E2
// E0-12T): всё, что он читает, обязано быть инициализировано здесь - кейс ниже по файлу шёл после
// всех const и TDZ не видел. Программы нет - процесса нет, повтор подменён (ошибки нет).
check('ответ vitest: «pid нет, повтор запустился» до INT_VITEST_START - отказ «код ошибки неизвестен», а не ReferenceError', () => {
  const dir = tempDir('vitest-early');
  try {
    const h = startVitest([['/a', 'vitest run --config x.ts']], dir, { bin: 'sf-selftest-no-node', spawnSync: () => ({ status: 0 }) });
    return refusalVerdict(() => awaitVitest(h), 'selftest-vitest.mjs не запустился: ' + SPAWN_CODE_UNKNOWN);
  } finally {
    releaseTemp(dir);
  }
});
/** Дочерний vitest пробы test:int стартует здесь, без ожидания (startIntVitest). */
const INT_VITEST_START = startIntVitest();
// Причина «не стартовал» - своя на каждую из трёх (замечание ревью E4 E0-12T): красный граф или
// test/imports.ts не объясняется пробой синтаксиса. Подменённые снимки - процесс не стартует.
check('дочерний vitest: не стартовал - причина названа (граф, test/imports.ts, синтаксис selftest-vitest.mjs), null нет', () => {
  const ok = { error: null };
  const syntax = (v) => new Map([['selftest-vitest.mjs', v]]);
  const cases = [
    [{ graph: { error: 'g' }, imports: ok, syntax: syntax(true) }, 'дочерний vitest не стартовал: нет графа turbo (g)'],
    [{ graph: ok, imports: { error: 'i' }, syntax: syntax(true) }, 'дочерний vitest не стартовал: test/imports.ts не загружен (i)'],
    [{ graph: ok, imports: ok, syntax: syntax(false) }, 'дочерний vitest не стартовал: selftest-vitest.mjs не прошёл пробу синтаксиса'],
  ];
  const bad = cases.map(([gates, want]) => {
    const got = startIntVitest(gates);
    const text = got && got.error && got.error.message;
    return text === want ? null : 'ожидалось «' + want + '», получено ' + (got === null ? 'null' : JSON.stringify(text));
  }).filter(Boolean);
  return !bad.length || bad.join('; ');
});
/** Ответ дочернего vitest - ленивый снимок: его ждёт первая проба, которой он нужен (intVitest). */
const VITEST_GATE = snapshotGate(takeIntVitest, { lazy: true });
// Ленивый снимок (замечание ревью C10 E0-12T): снимается первым take(), один раз; проба, чей take()
// упал (и внутри refusalVerdict), не гонялась - она в перечне снимка, своей строки нет.
check('снимок: ленивый снимок не снят - пробы, которые его взяли (и через refusalVerdict), не гонялись и названы одной строкой', () => {
  let calls = 0;
  const g = snapshotGate(() => {
    calls++;
    throw new Error('boom');
  }, { lazy: true });
  if (calls) return 'ленивый снимок снят до первой пробы';
  const got = [outcome('a', () => g.take() && true), outcome('b', () => refusalVerdict(() => g.take(), 'x'))];
  if (got.some((r) => r !== null)) return 'проба без снимка дала строку: ' + JSON.stringify(got);
  if (calls !== 1) return 'getSnap вызван ' + calls + ' раз(а)';
  const line = gateVerdict(g, () => '');
  return line === 'boom; пробы не гонялись (2): a; b' || 'строка снимка: ' + JSON.stringify(line);
});

// Граница Node - на подменённой версии: ниже 22.18 - отказ с версией, пробы за ней не гоняются.
check('граница Node: отказ на v21.9.0, v22.17.0, v23.1.0, v23.5.1; пропуск на v22.18.0, v23.6.0, v24.0.0; без модуля пробы не гоняются', () => {
  const versions = ['v21.9.0', 'v22.17.0', 'v23.1.0', 'v23.5.1', 'v22.18.0', 'v23.6.0', 'v24.0.0'];
  const got = JSON.stringify(versions.map(nodeVerdict));
  const want = JSON.stringify(versions.map((v, i) => (i < 4 ? NODE_NEED + ', у тебя ' + v : null)));
  if (got !== want) return 'ожидалось ' + want + ', получено ' + got;
  const low = importsGate('v22.17.0');
  let called = 0;
  const r = low.guard('проба x', () => { called++; return true; })();
  if (r !== SKIPPED || called) return 'проба гонялась без модуля (результат ' + String(r) + ', вызовов ' + called + ')';
  const line = gateVerdict(low, () => '');
  const wantLine = NODE_NEED + ', у тебя v22.17.0 (require test/imports.ts и дочерний vitest пробы test:int); пробы не гонялись (1): проба x';
  return line === wantLine || 'строка отказа: ' + JSON.stringify(line);
});
// Живой модуль судится на версии этого процесса, а не на подставленной: подмена версии в
// IMPORTS_GATE выключила бы границу на настоящем прогоне при зелёном кейсе выше.
check('граница Node: модуль test/imports.ts этого прогона судился на process.version', () =>
  IMPORTS_GATE.version === process.version || 'IMPORTS_GATE на версии ' + JSON.stringify(IMPORTS_GATE.version) + ', процесс ' + process.version);

/**
 * Временный корень кейса: файлы files ({ путь: текст }) во временном каталоге реестра; каталог
 * снимается dropTemp (ссылки и junction внутри - unlink до удаления; TECH_DEBT 21.10.2026 E0-12L круг 4, `withTempRoot`).
 */
function withTempRoot(files, fn) {
  const dir = tempDir('turbo');
  try {
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    return fn(dir);
  } finally {
    releaseTemp(dir);
  }
}

// Ветки отказа selftest-graph.js - на синтетическом dry и подменённом результате spawn, без
// turbo: каждый кейс ждёт точный текст отказа, и ветка, заменённая на пропуск (`return []`,
// `continue`), краснит свой кейс (E0-12L, L-020). Кейсы spawn идут на стаб-корне FIXTURE со
// своими turbo и @turbo/<os>-<arch>, а не на node_modules репозитория: свежий клон без
// pnpm install краснит одну строку «dry-JSON настоящего дерева», а не каждый кейс. Без модуля
// графа кейсы не гоняются - их называет та же строка.
if (!G) GRAPH_GATE.blocked.push('синтетические кейсы модуля графа');
if (G) {
  const refusedWith = (name, fn, want) => refusedCheck('граф turbo: ' + name, fn, want);
  const what = 'turbo run build --dry=json';
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
  // законный pnpm virtual-store-dir вне корня (TECH_DEBT 21.10.2026 E0-12L круг 4, `underNodeModules`): модуль под virtualStoreDir из
  // node_modules/.modules.yaml - под корнем; модуль в постороннем каталоге - нет; .modules.yaml,
  // который не разбирается, - отказ, а не молча «нет»
  check('граф turbo: underNodeModules - модуль под virtualStoreDir из .modules.yaml вне корня - под ним, посторонний каталог - нет', () => withTempRoot({
    'repo/node_modules/.keep': '',
    'store/.pnpm/turbo/package.json': '{"name":"turbo"}',
    'other/turbo/package.json': '{"name":"turbo"}',
  }, (dir) => {
    const repo = path.join(dir, 'repo');
    const yaml = 'virtualStoreDir: ' + JSON.stringify(path.join(dir, 'store', '.pnpm')) + '\n';
    // yaml - пакет репозитория: во временном корне его нет
    const parseYaml = require(require.resolve('yaml', { paths: [ROOT] })).parse;
    const at = (rel) => G.underNodeModules(path.join(dir, ...rel.split('/')), repo, { modulesYaml: yaml, parseYaml });
    const got = JSON.stringify([at('store/.pnpm/turbo/package.json'), at('other/turbo/package.json'), G.underNodeModules(path.join(dir, 'store', '.pnpm', 'turbo', 'package.json'), repo, { modulesYaml: null })]);
    if (got !== JSON.stringify([true, false, false])) return 'ожидалось [true,false,false] (хранилище, посторонний, без .modules.yaml), получено ' + got;
    return refusalVerdict(() => G.underNodeModules(path.join(dir, 'other', 'turbo', 'package.json'), repo, { modulesYaml: 'storeDir: x\n', parseYaml }), 'в node_modules/.modules.yaml нет строки virtualStoreDir');
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
  refusedWith('вход с буквой диска и прямым слешем - отказ', () => withInput('C:/x.ts'), 'вход C:/x.ts задачи @sf/b#build - абсолютный путь, вне корня репозитория');
  // имя файла с двоеточием - не буква диска там, где такое имя возможно (TECH_DEBT 21.10.2026
  // E0-12L круг 4, `inRoot`); на Windows имени с двоеточием нет, и `C:x.ts` - путь от текущего
  // каталога диска C, вне репозитория
  check('граф turbo: inRoot - вход a:b.json не на Windows - законное имя файла пакета, не абсолютный путь', () => {
    const got = G.inRoot('packages/b', 'a:b.json', '@sf/b#build', 'linux');
    return got === 'packages/b/a:b.json' || 'вход a:b.json на linux: ' + JSON.stringify(got);
  });
  check('граф turbo: inRoot - на Windows буква диска без слеша (C:x.ts, a:b.json) - отказ', () => {
    const bad = ['C:x.ts', 'a:b.json'].map((x) => refusalVerdict(() => G.inRoot('packages/b', x, '@sf/b#build', 'win32'),
      'вход ' + x + ' задачи @sf/b#build - абсолютный путь, вне корня репозитория')).filter((v) => v !== true);
    return !bad.length || bad.join('; ');
  });
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
  // inputsGap на графе со скриптом без ожидания - отказ с именем, а не TypeError (TECH_DEBT 21.10.2026 E0-12L круг 3, `inputsGap`)
  refusedWith('inputsGap: узел скрипта без ожидания в DECLARED_INPUTS - отказ с именем задачи',
    () => G.inputsGap({ roots: [], nodes: [{ name: '@sf/a#lint', pkg: '@sf/a', dir: 'packages/a', reads: [] }] }, ['packages/a/x.ts'], sample()),
    'у задачи @sf/a#lint нет ожидания inputs в DECLARED_INPUTS selftest-graph.js');
  // EXTRA_INPUTS (TECH_DEBT 21.10.2026 E0-12L круг 4, `checkDeclaredInputs`): законное расширение inputs одной задачи проходит, тот же вход
  // у соседней задачи - отказ; боевой перечень - объект с причиной на каждую задачу
  check('граф turbo: EXTRA_INPUTS - расширение inputs одной задачи проходит, тот же вход у соседа краснеет', () => {
    if (!G.EXTRA_INPUTS || typeof G.EXTRA_INPUTS !== 'object') return 'selftest-graph.js не экспортирует EXTRA_INPUTS';
    const noWhy = Object.entries(G.EXTRA_INPUTS).filter(([, x]) => !x || !Array.isArray(x.inputs) || typeof x.why !== 'string' || !x.why).map(([id]) => id);
    if (noWhy.length) return 'EXTRA_INPUTS без inputs или причины: ' + noWhy.join(', ');
    const extraInputs = { '@sf/a#build': { inputs: ['x.json'], why: 'кейс' } };
    const widened = (id) => withTask(id, (t) => Object.assign(t, { resolvedTaskDefinition: { inputs: ['x.json'] } }));
    try {
      G.taskGraph(widened('@sf/a#build'), 'build', { extraInputs });
    } catch (e) {
      return 'расширение своей задачи отвергнуто: ' + e.message;
    }
    // тот же вход и у своей задачи, и у соседа: свою пропускает расширение, соседа - нет
    const both = widened('@sf/b#build');
    both.tasks = both.tasks.map((t) => (t.taskId === '@sf/a#build' ? Object.assign({}, t, { resolvedTaskDefinition: { inputs: ['x.json'] } }) : t));
    return refusalVerdict(() => G.taskGraph(both, 'build', { extraInputs }),
      'inputs задачи @sf/b#build в turbo.json: ["x.json"], ожидалось [] (DECLARED_INPUTS: build без inputs: turbo хеширует все файлы пакета, видимые git, - их и читает next build)');
  });
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
    const want = 'у графа turbo run build нет узлов кроме корней из замыкания манифестов - детектор разницы с манифестами не построить';
    if (got !== want) return 'ожидалось «' + want + '», получено ' + JSON.stringify(got);
    const ok2 = manifestGapBlind(sample(), 'build', G.taskGraph(sample(), 'build'), ws);
    return ok2 === null || 'на графе с узлом: ' + JSON.stringify(ok2);
  });
  // первый некорневой узел пришёл явным dependsOn "@sf/x#build" без манифеста: срез идёт по узлу
  // из замыкания манифестов, ложного «проба не замечает» нет (TECH_DEBT 21.10.2026 E0-12L круг 3, `manifestGapBlind`)
  check('граф turbo: детектор разницы с манифестами - узел явного dependsOn вне манифестов не берётся для среза', () => {
    const dry = sample();
    dry.tasks = dry.tasks.map((t) => (t.taskId === '@sf/a#build' ? Object.assign({}, t, { dependencies: ['@sf/c#build', '@sf/b#build'] }) : t));
    const ws = manifests({ '@sf/a': { dependencies: { '@sf/b': 'workspace:*' } }, '@sf/b': {}, '@sf/c': {} });
    const graph = G.taskGraph(dry, 'build');
    const first = graph.nodes.find((n) => !n.root);
    if (!first || first.name !== '@sf/c#build') return 'первый некорневой узел кейса не @sf/c#build: ' + JSON.stringify(first && first.name);
    const got = manifestGapBlind(dry, 'build', graph, ws);
    return got === null || 'детектор срезал узел вне манифестов: ' + JSON.stringify(got);
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
  // граф только из корневой задачи (каталог '.'): её вход a.ts - вход «своего пакета», как в
  // inputsGap (G.under), детектор строится (TECH_DEBT 21.10.2026 E0-12L круг 4, `own` в пробе входов)
  check('граф turbo: детектор входов на графе из одной корневой задачи (каталог .) строится, а не отказ', () => {
    const dry = { globalCacheInputs: { files: {} }, tasks: [task('//#build', { directory: '', command: 'tsc -b', inputs: { 'a.ts': 'h', 'b.ts': 'h' } })] };
    const got = inputsGapBlind(dry, 'build', G.taskGraph(dry, 'build'), ['a.ts', 'b.ts']);
    return got === null || 'на корневой задаче: ' + JSON.stringify(got);
  });
  // вход корневой задачи (каталог '.') из вложенного пакета inputsGap не считает её файлом: срез
  // такого входа дал бы ложное «проба не замечает» - детектор берёт тот же отбор G.ownFiles
  check('граф turbo: детектор входов не режет у корневой задачи вход вложенного пакета (тот же отбор, что у inputsGap)', () => {
    const dry = {
      globalCacheInputs: { files: {} },
      tasks: [
        task('//#build', { directory: '', command: 'tsc -b', dependencies: ['@sf/b#build'], inputs: { 'packages/b/src/index.ts': 'h', 'a.ts': 'h' } }),
        task('@sf/b#build'),
      ],
    };
    const got = inputsGapBlind(dry, 'build', G.taskGraph(dry, 'build'), ['packages/b/src/index.ts', 'a.ts']);
    return got === null || 'на корневой задаче с входом вложенного пакета: ' + JSON.stringify(got);
  });
  // форма задач dry проверяется раз на объект dry (TECH_DEBT 21.10.2026 E0-12L круг 3,
  // `dryPackages` -> `tasksById`): второй вопрос к тому же снимку не перебирает его задачи, стаб -
  // новый объект - проверяется сам
  check('граф turbo: tasksById - форма задач проверяется раз на объект dry, стаб с задачей без taskId - отказ', () => {
    const base = sample();
    let reads = 0;
    const tasks = base.tasks;
    const dry = Object.assign({}, base);
    Object.defineProperty(dry, 'tasks', { get: () => { reads++; return tasks; }, enumerable: true });
    G.rootTasks(dry, 'build');
    G.rootTasks(dry, 'build');
    if (reads !== 1) return 'задачи dry перебраны ' + reads + ' раз(а) на двух вопросах к одному снимку';
    return refusalVerdict(() => G.rootTasks(Object.assign({}, base, { tasks: base.tasks.concat({}) }), 'build'),
      'задача dry-JSON без taskId - форма dry-JSON turbo неизвестна');
  });
  // workspace: только в peerDependencies (Р5 техлида E0-12T; TECH_DEBT 21.10.2026 E0-12L круг 4, peer-only workspace-зависимость): отказ с пакетом,
  // зависимостью и подсказкой; peer с дублем в devDependencies и peer не workspace: - пропуск
  check('граф turbo: peerOnly - workspace: только в peerDependencies - отказ с подсказкой; peer + dev и peer не workspace: - нет', () => {
    const ws = {
      '@sf/a': { dir: 'packages/a', pkg: { name: '@sf/a', peerDependencies: { '@sf/b': 'workspace:*', react: '^18' } } },
      '@sf/c': { dir: 'packages/c', pkg: { name: '@sf/c', peerDependencies: { '@sf/b': 'workspace:^' }, devDependencies: { '@sf/b': 'workspace:^' } } },
      '@sf/b': { dir: 'packages/b', pkg: { name: '@sf/b' } },
    };
    const got = JSON.stringify(G.peerOnly(ws));
    const want = JSON.stringify(['пакет @sf/a: @sf/b (workspace:*) только в peerDependencies - turbo не строит по нему ребро, добавь в devDependencies']);
    return got === want || 'ожидалось ' + want + ', получено ' + got;
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
  // turbo.jsonc рядом с turbo.json (TECH_DEBT 21.10.2026 E0-12L круг 4, `turbo.jsonc`); `**` - пакет и на первом, и на втором
  // уровне (TECH_DEBT 21.10.2026 E0-12L круг 3, `patternPackage`)
  check('граф turbo: graphSources - корень без ./, у пакета package.json, turbo.json и turbo.jsonc, новый пакет по шаблону (** - два уровня, и без пакетов), без повторов', () => {
    const dry = {
      globalCacheInputs: { files: {} },
      tasks: [
        task('//#lint', { directory: '.', command: 'biome check', inputs: {} }),
        task('@sf/a#build', { directory: 'apps\\a', inputs: {} }),
        task('@sf/a#test', { directory: 'apps\\a', inputs: {} }),
      ],
    };
    const got = JSON.stringify(G.graphSources(dry, ['apps/*', './tools/**/', '!apps/x']).map((x) => x.file));
    const N = G.NEW_SIBLING;
    const three = (dir) => [dir + '/package.json', dir + '/turbo.json', dir + '/turbo.jsonc'];
    const want = JSON.stringify(['package.json', 'pnpm-workspace.yaml', 'turbo.json', 'turbo.jsonc'].concat(
      three('apps/a'), three('apps/' + N), three('tools/' + N), three('tools/' + N + '/' + N)));
    return got === want || 'ожидалось ' + want + ', получено ' + got;
  });
  refusedWith('graphSources: шаблон с ? [ ] { } - отказ', () => G.graphSources(sample(), ['apps/{a,b}']),
    'шаблон apps/{a,b} pnpm-workspace.yaml не разбирается пробой (знаки ? [ ] { }) - разбери руками');
  // Разбор шаблонов workspace - пакетом yaml: без него отказ снимка (liveSnap зовёт тот же разбор),
  // и кейсы ниже не гоняются - одна красная строка графа, а не три (TECH_DEBT 21.10.2026 E0-12L круг 4, разбор шаблонов workspace без yaml).
  {
    const line = 'граф turbo: workspacePatterns - список packages pnpm-workspace.yaml';
    check(line, GRAPH_GATE.guard(line, () => {
      const got = JSON.stringify(G.workspacePatterns('packages:\n  - "apps/*"\n  - \'tools/*\'\n'));
      return got === JSON.stringify(['apps/*', 'tools/*']) || 'получено ' + got;
    }));
    const refused = 'граф turbo: workspacePatterns: нет списка строк packages - отказ';
    check(refused, GRAPH_GATE.guard(refused, () => refusalVerdict(() => G.workspacePatterns('packages:\n  - 1\n'),
      'в pnpm-workspace.yaml нет списка строк packages - шаблоны пакетов workspace неизвестны')));
  }
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
    const g = snapshotGate(() => { throw new Error('boom'); });
    const r = g.guard('проба x', () => { called++; return true; })();
    if (r !== SKIPPED || called) return 'проба графа гонялась без графа (результат ' + String(r) + ', вызовов ' + called + ')';
    const v = graphVerdict(g);
    return v === 'boom; пробы графа не гонялись (1): проба x' || 'строка отказа: ' + JSON.stringify(v);
  });
  check('граф turbo: с графом пробы графа гоняются как есть', () => {
    const g = snapshotGate(() => ({ dry: { tasks: [] } }));
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
  // ENOBUFS - вывод больше maxBuffer, а не «не запустился» (TECH_DEBT 21.10.2026 E0-12L круг 4, `trackedFiles` и ENOBUFS)
  refusedWith('trackedFiles: вывод git больше maxBuffer (ENOBUFS) - своя причина, не «не запустился»',
    () => trackedFiles({ spawn: () => ({ pid: 4242, status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' }) }) }),
    'git ls-files: вывод больше maxBuffer (' + LISTING_MAX_BUFFER + ' байт)');
  // Ссылки выборки судятся по цели, как в близнеце scripts/lib/files.mjs (stat, решение ревью B13
  // E0-12T): ссылка на каталог и висячая ссылка - не файл. Корень кейса - временный каталог с
  // настоящими junction (на Windows ссылка на файл требует прав - её кейс не строит).
  const linkRoot = (fn) => withTempRoot({ 'package.json': '{}', 'dir/x.txt': 'x', 'gone/x.txt': 'x', '.claude/x.txt': 'x' }, (root) => {
    fs.symlinkSync(path.join(root, 'dir'), path.join(root, 'link-dir'), 'junction');
    fs.symlinkSync(path.join(root, 'gone'), path.join(root, 'link-gone'), 'junction');
    fs.rmSync(path.join(root, 'gone'), { recursive: true, force: true });
    return fn(root);
  });
  check('граф turbo: trackedFiles - отслеживаемая ссылка на каталог и висячая ссылка - не в списке (как files.mjs)', () => linkRoot((root) => {
    const got = JSON.stringify(trackedFiles({ root, spawn: lsFiles('package.json\0link-dir\0link-gone\0') }));
    return got === JSON.stringify(['package.json']) || 'получено ' + got;
  }));
  // Близнец trackedFiles с others и trackedFiles из scripts/lib/files.mjs (загружен в дочерний node)
  // на одном ответе git и одном корне со ссылками: одни аргументы git и один список - дубли путей
  // (конфликт) по разу, пропавший файл, каталог, ссылка на каталог и висячая ссылка выпадают (E0-12N,
  // К2-6 круга 2; образец - сверка isGone по Р4).
  check('граф turbo: близнец trackedFiles (others) зовёт git и отбирает файлы как trackedFiles из scripts/lib/files.mjs (и ссылки)', () => linkRoot((root) => {
    const stdout = 'package.json\0package.json\0sf-selftest-gone.ts\0.claude\0package.json\0link-dir\0link-gone\0';
    const module = require('url').pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'files.mjs')).href;
    const program = 'const { trackedFiles, LISTING_MAX_BUFFER } = await import(' + JSON.stringify(module) + ');' +
      'let args = null; let maxBuffer = null;' +
      'const spawn = (command, given, options) => { args = [command, ...given]; maxBuffer = options.maxBuffer; return { status: 0, stdout: ' + JSON.stringify(stdout) + ', stderr: "" }; };' +
      'const got = trackedFiles(' + JSON.stringify(root) + ', { spawn });' +
      'console.log(JSON.stringify({ args, got, maxBuffer, exported: LISTING_MAX_BUFFER }));';
    const r = run(process.execPath, ['--input-type=module', '--eval', program], { cwd: ROOT });
    if (r.error || r.status !== 0) return 'files.mjs не загрузился: ' + String((r.error && r.error.message) || r.stderr).slice(0, 160);
    const original = JSON.parse(String(r.stdout).trim());
    let args = null;
    let maxBuffer = null;
    const got = trackedFiles({ root, others: true, spawn: (command, given, options) => { args = [command, ...given]; maxBuffer = options.maxBuffer; return lsFiles(stdout)(); } });
    if (original.maxBuffer !== original.exported) {
      return 'files.mjs даёт git maxBuffer ' + original.maxBuffer + ', а LISTING_MAX_BUFFER ' + original.exported;
    }
    if (maxBuffer !== original.exported) {
      return 'maxBuffer близнеца ' + maxBuffer + ', LISTING_MAX_BUFFER files.mjs ' + original.exported;
    }
    if (JSON.stringify(args) !== JSON.stringify(original.args)) {
      return 'git близнеца ' + JSON.stringify(args) + ', у files.mjs ' + JSON.stringify(original.args);
    }
    if (JSON.stringify(got) !== JSON.stringify(original.got)) {
      return 'список близнеца ' + JSON.stringify(got) + ', у files.mjs ' + JSON.stringify(original.got);
    }
    return { note: original.got.length + ' файл из ' + stdout.split('\0').filter(Boolean).length + ' путей' };
  }));
  // «путь под каталогом» - один предикат G.strictlyUnder (решение ревью B3 E0-12T): каталог `..x`
  // внутри корня - под ним, родитель корня и сам корень - нет
  check('граф turbo: relUnder - каталог ..x внутри корня под ним, родитель и сам корень - отказ', () => withTempRoot({ 'root/..x/a.ts': 'x', 'out.ts': 'x' }, (dir) => {
    const base = fs.realpathSync(path.join(dir, 'root'));
    const got = relUnder(path.join(base, '..x', 'a.ts'), base, 'кейс');
    if (got !== '..x/a.ts') return 'путь в каталоге ..x: ' + JSON.stringify(got);
    const bad = [path.join(dir, 'out.ts'), base].map((abs) => refusalVerdict(() => relUnder(abs, base, 'кейс'), 'кейс: путь ' + abs + ' вне ' + base)).filter((v) => v !== true);
    return !bad.length || bad.join('; ');
  }));
  // «вне корня» для путей от корня - один предикат G.outsideRoot (замечание ревью C5 E0-12T): его
  // берут inRoot, резолв `./`/`../` и join/resolve(repoRoot, …) обхода int-наборов
  check('граф turbo: outsideRoot - .., ../a и /a вне корня; ..x/a, a/..b и a - внутри', () => {
    const paths = ['..', '../a', '/a', '..x/a', 'a/..b', 'a'];
    const got = JSON.stringify(paths.map(G.outsideRoot));
    const want = JSON.stringify([true, true, true, false, false, false]);
    return got === want || JSON.stringify(paths) + ': ожидалось ' + want + ', получено ' + got;
  });
}

/**
 * Файлы, которые git видит в дереве (`git ls-files -z`, пути от корня) и которые есть на диске:
 * удалённый в рабочем дереве файл turbo не хеширует. Для G.inputsGap; git зовёт только
 * самопроверка (помощник git()), модуль графа получает список параметром. git не запустился или
 * упал - исключение; вывод больше maxBuffer (ENOBUFS) - своя причина, а не «не запустился».
 * Наличие на диске - stat, как у близнеца trackedFiles из scripts/lib/files.mjs: ссылка судится по
 * цели - на файл в списке, на каталог и висячая - нет; ENOENT и ENOTDIR (родитель стал файлом) -
 * файла нет, путь стал каталогом - файла нет, иная ошибка (EACCES) - исключение, а не молча
 * выпавший файл. opts - подмена для кейсов: root (корень дерева; по умолчанию репозиторий), git
 * (имя команды), spawn (вместо run), stat (вместо fs.statSync); others - ещё и новые
 * неигнорируемые файлы (--others --exclude-standard, сверка путей note). С others - близнец trackedFiles из scripts/lib/files.mjs без keep: аргументы git,
 * дедуп путей и отбор файлов сверяет проба «близнец trackedFiles» выше (правка флагов там без
 * правки здесь - красная), она же - maxBuffer git с LISTING_MAX_BUFFER из files.mjs (К3-6 E0-12N).
 */
function trackedFiles(opts) {
  const o = opts || {};
  const stat = o.stat || fs.statSync;
  const root = o.root || ROOT;
  const others = o.others ? ['--others', '--exclude-standard'] : [];
  const r = git(['ls-files', '-z', '--cached', ...others], { cwd: root, maxBuffer: LISTING_MAX_BUFFER, spawn: o.spawn, bin: o.git });
  if (r.error && r.error.code === 'ENOBUFS') throw new Error('git ls-files: вывод больше maxBuffer (' + LISTING_MAX_BUFFER + ' байт)');
  if (r.error) throw new Error('git ls-files не запустился: ' + r.error.message);
  if (r.status !== 0) throw new Error('git ls-files: ' + (r.status === null ? 'сигнал ' + r.signal : 'код ' + r.status) + ': ' + String(r.stderr || '').trim());
  const isFile = (f) => {
    try {
      return stat(path.join(root, f)).isFile();
    } catch (e) {
      if (L.isNotFile(e)) return false;
      throw e;
    }
  };
  // --cached --others даёт файл с конфликтом по строке на стадию - один раз, как в files.mjs.
  return [...new Set(r.stdout.split('\0'))].filter((f) => f && isFile(f));
}

/**
 * Снимок настоящего дерева для GRAPH_GATE: dry (dry-JSON turbo), ws (манифесты пакетов dry), patterns
 * (шаблоны pnpm-workspace.yaml), tracked (файлы, видимые git) и int - ленивое поле: обход чтений
 * int-наборов (liveIntWalk), null до первой пробы, которой он нужен. Корневой package.json - не здесь,
 * а в rootPkg; ответ дочернего vitest - в VITEST_GATE. Без модуля графа снимка нет: отказ называет
 * строка графа.
 */
function liveSnap() {
  if (!G) throw new Error('модуль графа selftest-graph.js не загружен (строка синтаксиса или require выше)');
  const dry = G.turboDry(GRAPH_SCRIPTS);
  return {
    dry,
    ws: dryManifests(dry),
    patterns: G.workspacePatterns(fs.readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8')),
    tracked: trackedFiles(),
    int: null,
  };
}

/**
 * Манифесты пакетов dry: { имя: { dir, pkg } } - workspace:-зависимости для G.manifestGap и
 * G.peerOnly, exports для резолва `@sf/<пакет>[/<подпуть>]` в обходе int-наборов (intModule).
 * Читаются один раз за прогон, в снимке liveSnap.
 */
function dryManifests(dry) {
  const ws = {};
  for (const [name, dir] of G.dryPackages(dry)) ws[name] = { dir, pkg: readJson(path.join(ROOT, dir, 'package.json')) };
  return ws;
}

/**
 * Корневой package.json - одно чтение за прогон (TECH_DEBT 21.10.2026 E0-12L круг 3,
 * `checkRootScriptLines`, `rootScriptExtra`): пробы скриптов корня берут его отсюда. Сбой чтения -
 * исключение в каждой пробе, которой он нужен (их строки красные с причиной), запомненное, как и
 * текст. ROOT_PKG_READS - сколько раз файл прочитан с диска: его сверяет проба в конце прогона.
 */
let rootPkgMemo = null;
let ROOT_PKG_READS = 0;
function rootPkg() {
  if (!rootPkgMemo) {
    try {
      ROOT_PKG_READS++;
      rootPkgMemo = { value: readJson(path.join(ROOT, 'package.json')) };
    } catch (e) {
      rootPkgMemo = { error: e };
    }
  }
  if (rootPkgMemo.error) throw rootPkgMemo.error;
  return rootPkgMemo.value;
}

/**
 * Конфиги int-наборов у самого vitest (E0-12T, решение техлида Р3 E0-12L): один дочерний
 * selftest-vitest.mjs на все пары [dir, command] (абсолютный каталог пакета и команда его
 * test:int). Один путь запуска: startVitest стартует процесс без ожидания, awaitVitest ждёт его
 * ответ (условный стоп 2 техлида E0-12T: асинхронный старт - секунда ребёнка идёт параллельно
 * пробам до первой, которой он нужен). Ответ - массив по парам: { dir, config, setupFiles,
 * globalSetup } (абсолютные пути) или { dir, error } - ошибка пары (нет --config, нет конфига, не
 * простой вызов vitest) - данные, а не отказ. Отказ, fail-closed (L-028), - vitestAnswer.
 *
 * startVitest(pairs, dir, opts): stdout и stderr ребёнка - в файлы каталога dir; opts - подмена
 * для кейсов: bin (вместо process.execPath), child (вместо VITEST_CHILD), timeoutMs (вместо
 * VITEST_TIMEOUT_MS), goneMs (вместо VITEST_GONE_MS), spawn и spawnSync (вместо cp.spawn и cp.spawnSync). Процесс, который не
 * запустился (pid нет - spawn сообщит ошибку только событием, а самопроверка синхронна и цикла
 * событий до выхода не отдаёт), - сразу отказ «не запустился: <код>»: код - у синхронного повтора
 * запуска той же программы (--version), повтор запустился - SPAWN_CODE_UNKNOWN; предела отказ не
 * ждёт. Запущенный ребёнок - в LIVE_CHILDREN до ответа: выход прогона его снимает.
 */
function startVitest(pairs, dir, opts) {
  const o = opts || {};
  const bin = o.bin || process.execPath;
  const out = path.join(dir, 'vitest-out.txt');
  const err = path.join(dir, 'vitest-err.txt');
  const fdOut = fs.openSync(out, 'w');
  const fdErr = fs.openSync(err, 'w');
  let child;
  try {
    child = (o.spawn || cp.spawn)(bin, [o.child || VITEST_CHILD].concat(...pairs), { cwd: ROOT, stdio: ['ignore', fdOut, fdErr], windowsHide: true });
  } finally {
    fs.closeSync(fdOut);
    fs.closeSync(fdErr);
  }
  const h = { pairs, out, err, child, timeoutMs: o.timeoutMs || VITEST_TIMEOUT_MS, goneMs: o.goneMs === undefined ? VITEST_GONE_MS : o.goneMs, started: performance.now(), spawnError: null };
  // событие error придёт только после выхода синхронного прогона; без обработчика оно уронило бы
  // выход процесса
  child.on('error', () => {});
  if (child.pid === undefined) {
    const again = (o.spawnSync || cp.spawnSync)(bin, ['--version'], { cwd: ROOT, stdio: 'ignore', windowsHide: true, timeout: 5000 });
    h.spawnError = (again.error && again.error.code) || SPAWN_CODE_UNKNOWN;
    return h;
  }
  // процесс прогона не ждёт ребёнка: его ответ забирает awaitVitest, а пробе, которая до него не
  // дошла, ребёнок не нужен - выход прогона снимает его (killLiveChildren)
  child.unref();
  LIVE_CHILDREN.add(child);
  return h;
}
/**
 * Процесса pid нет в течение ms (монотонные часы, паузы 20 мс; ms 0 - одна сверка): true; жив весь
 * срок - false. Linux: процесс, вышедший или убитый, пока цикл событий прогона занят (самопроверка
 * синхронна), - зомби до сбора родителем, и kill(pid, 0) видит его живым; состояние Z в
 * /proc/<pid>/stat (или файла нет при читаемом /proc/self/stat) - процесса нет (замечание ревью E1
 * E0-12T). Иначе - kill(pid, 0): ESRCH - нет. Иная ошибка чтения или kill - «жив» (false), не
 * исключение (решение техлида, круг 3). deps - подмена для кейса: platform, readStat(pid) (текст /proc/<pid>/stat), kill.
 */
function pidGone(pid, ms, deps) {
  const d = Object.assign({ platform: process.platform, readStat: (p) => fs.readFileSync('/proc/' + p + '/stat', 'utf8'), kill: (p, sig) => process.kill(p, sig) }, deps);
  const readable = (p) => {
    try {
      d.readStat(p);
      return true;
    } catch (_) {
      return false;
    }
  };
  const gone = () => {
    if (d.platform === 'linux') {
      let stat = '';
      try {
        stat = d.readStat(pid);
      } catch (e) {
        // иная ошибка - «жив», а не исключение поверх готового ответа (решение техлида, круг 3);
        // ENOENT - «нет» только при читаемом /proc/self/stat, иначе /proc не смонтирован - ветка kill
        if (!(e && e.code === 'ENOENT')) return false;
        if (readable('self')) return true;
      }
      // состояние - первое поле после имени программы в скобках (в имени бывают скобки и пробелы)
      const close = stat.lastIndexOf(')');
      if (close !== -1 && stat.charAt(close + 2) === 'Z') return true;
    }
    try {
      d.kill(pid, 0);
    } catch (e) {
      return Boolean(e && e.code === 'ESRCH');
    }
    return false;
  };
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const t0 = performance.now();
  for (;;) {
    if (gone()) return true;
    if (performance.now() - t0 >= ms) return false;
    Atomics.wait(pause, 0, 0, 20);
  }
}
/** Строка выхода дочернего vitest (его обработчик exit пишет её в stdout последней). */
const VITEST_EXIT_MARK = 'selftest-vitest-exit ';
/**
 * Ответ дочернего vitest, запущенного startVitest: синхронное ожидание строки выхода
 * (VITEST_EXIT_MARK <код>, целая строка; код не целое - отказ) в файле stdout с паузами Atomics.wait по монотонным часам
 * (performance.now); дальше - конец процесса (pidGone, до h.goneMs: строку выхода пишет его
 * обработчик exit, процесс ещё жив и держит файлы каталога; не вышел за срок - SIGKILL, не отказ:
 * ответ уже полон) и сверка формы vitestAnswer. Нет строки выхода за h.timeoutMs -
 * процесс снимается SIGKILL, отказ «не ответил»; процесс, убитый снаружи до строки выхода, - тот
 * же отказ по пределу. Не запустился (h.spawnError) - отказ сразу.
 */
function awaitVitest(h) {
  if (h.spawnError) return vitestAnswer({ error: Object.assign(new Error(h.spawnError), { code: h.spawnError }), status: null, signal: null, stdout: '', stderr: '' }, h);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const stdout = fs.readFileSync(h.out, 'utf8');
    // только целые строки: хвост без перевода строки ребёнок, может быть, ещё дописывает
    const exit = stdout.split(/\r?\n/).slice(0, -1).find((line) => line.startsWith(VITEST_EXIT_MARK));
    if (exit !== undefined) {
      if (!pidGone(h.child.pid, h.goneMs)) h.child.kill('SIGKILL');
      LIVE_CHILDREN.delete(h.child);
      // код - целое числом без пробелов и знака «+»; иное (обрезанная строка, `1x`) - отказ, а не
      // Number('') = 0 - успех
      const text = exit.slice(VITEST_EXIT_MARK.length);
      if (!/^-?\d+$/.test(text)) throw new Error('selftest-vitest.mjs: строка выхода без целого кода: ' + JSON.stringify(exit));
      return vitestAnswer({ status: Number(text), signal: null, stdout, stderr: fs.readFileSync(h.err, 'utf8') }, h);
    }
    if (performance.now() - h.started > h.timeoutMs) {
      h.child.kill('SIGKILL');
      LIVE_CHILDREN.delete(h.child);
      return vitestAnswer({ status: null, signal: 'SIGKILL', stdout, stderr: '', error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) }, h);
    }
    Atomics.wait(pause, 0, 0, 20);
  }
}

/**
 * Сверка ответа дочернего vitest r ({ error, status, signal, stdout, stderr }) запуска h
 * (startVitest: pairs, timeoutMs). Отказ: процесс не запустился (код), предел, код не 0, нет ровно
 * одной строки VITEST_MARK, не JSON, не массив по парам, элемент иной формы или чужого каталога.
 */
function vitestAnswer(r, h) {
  const what = 'selftest-vitest.mjs';
  const pairs = h.pairs;
  if (r.error && r.error.code === 'ETIMEDOUT') throw new Error(what + ': не ответил за ' + h.timeoutMs / 1000 + ' с - процесс убит');
  if (r.error) throw new Error(what + ' не запустился: ' + r.error.code);
  if (r.status !== 0) {
    throw new Error(what + ': ' + (r.status === null ? 'сигнал ' + r.signal : 'код ' + r.status) + ': ' + (String(r.stderr || '').trim().slice(0, 200) || 'stderr пуст'));
  }
  const stdout = String(r.stdout || '');
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith(VITEST_MARK));
  if (lines.length !== 1) throw new Error(what + ': в stdout не ровно одна строка «' + VITEST_MARK.trim() + ' <JSON>»: ' + JSON.stringify(stdout.slice(0, 120)));
  let out;
  try {
    out = JSON.parse(lines[0].slice(VITEST_MARK.length));
  } catch (e) {
    throw new Error(what + ': ответ не JSON (' + e.message + ')');
  }
  if (!Array.isArray(out) || out.length !== pairs.length) throw new Error(what + ': ответ не массив из ' + pairs.length + ' элементов: ' + JSON.stringify(out).slice(0, 120));
  const strings = (a) => Array.isArray(a) && a.every((s) => typeof s === 'string');
  out.forEach((x, i) => {
    const shaped = x && typeof x === 'object' && x.dir === pairs[i][0] &&
      (typeof x.error === 'string' ? Object.keys(x).length === 2 : typeof x.config === 'string' && strings(x.setupFiles) && strings(x.globalSetup));
    if (!shaped) throw new Error(what + ': ответ пары ' + (i + 1) + ' (' + pairs[i][0] + ') иной формы: ' + JSON.stringify(x).slice(0, 160));
  });
  return out;
}

/**
 * Входы пробы test:int (решение техлида Р1 E0-12T): файлы, правка которых меняет то, что читает
 * сама проба, - они обязаны выбирать гейт harness-selftest. Виды чтений графа int-наборов:
 *   config      - конфиг из --config команды корня графа;
 *   setup       - модуль setupFiles (после пресета, как его разрешил vitest);
 *   globalSetup - модуль globalSetup (то же);
 *   join        - модуль с join/resolve(repoRoot, …): его правка меняет фикстуры;
 *   fixture     - файл из join/resolve(repoRoot, …);
 *   manifest    - package.json пакета workspace, чьи exports разрешили спецификатор.
 * И два файла, которые проба читает всегда (INT_PROBE_STATIC): vitest.preset.ts (его зовёт
 * каждый конфиг; setupFiles и globalSetup приходят из него) и test/imports.ts (разбор импортов
 * пробы). Остальное - вид module: транзитивный импорт обхода. Он меняет чтения int-наборов только
 * новым join(repoRoot, …), обязан лежать под glob test:int (проба сверяет), а harness-selftest на нём
 * не выбирается - новый join в глубине модуля ловит прогон selftest в CI (ci.yml гоняет его всегда).
 */
const INT_PROBE_INPUT_KINDS = ['config', 'setup', 'globalSetup', 'join', 'fixture', 'manifest'];
const INT_PROBE_STATIC = ['vitest.preset.ts', 'test/imports.ts'];

/**
 * join/resolve(repoRoot, …), который не чтение (решение техлида Р2 E0-12T): точное имя -> причина.
 * Содержимое этих файлов selftest не читает никогда; прочие - чтение с проверкой наличия.
 */
const JOINED_NOT_READ = {
  '.env': 'bootstrapEnv не читает файл под VITEST (packages/config/src/env-file.ts, ветка VITEST в bootstrapEnv)',
};

/**
 * Модули, где употребление repoRoot не по форме join/resolve(repoRoot, "<литерал>") разобрано
 * руками и не чтение фикстуры (решение техлида B5 E0-12T): точный путь модуля от корня -> причина.
 * В модуле перечня такие употребления не отказ; его литеральные join/resolve - чтение, как везде.
 * Запись, которую обход настоящего дерева не встретил, - красная (проба «перечень REPO_ROOT_REVIEWED
 * …»): устаревшая запись молча разрешала бы новое употребление.
 */
const REPO_ROOT_REVIEWED = {
  'packages/config/src/schema.ts': 'resolve(repoRoot, dir) - вычисление MEDIA_DIR из переменной окружения, не чтение фикстуры',
};

/**
 * Источник обхода int-наборов (пути от корня): read - текст модуля, isFile - модуль есть,
 * present - фикстура есть (не absent: ENOENT и ENOTDIR - нет, иная ошибка - исключение).
 */
const DISK = {
  read: (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8'),
  isFile: (rel) => {
    try {
      return fs.statSync(path.join(ROOT, rel)).isFile();
    } catch (e) {
      if (L.isNotFile(e)) return false;
      throw e;
    }
  },
  present: (rel) => !absent(path.join(ROOT, rel)),
};
/** Источник DISK с наложенными текстами files ({ путь от корня: текст }) - стабы и кейсы. */
function overlaySource(files) {
  const own = (rel) => Object.prototype.hasOwnProperty.call(files, rel);
  return {
    read: (rel) => (own(rel) ? files[rel] : DISK.read(rel)),
    isFile: (rel) => own(rel) || DISK.isFile(rel),
    present: (rel) => own(rel) || DISK.present(rel),
  };
}

/**
 * Условия exports, которые vitest 2.1.9 (vite 5.4.21, окружение node, режим test) принимает при
 * импорте пакета workspace из setup и его импортов. Замер E0-12T (Fix 2): пакет-ссылка с exports
 * из двенадцати условий, по одному снятию выбранного - module, development, node, import, default;
 * browser, worker, deno, react-native, edge-light, production, require - не принимаются.
 */
const VITEST_CONDITIONS = ['module', 'development', 'node', 'import', 'default'];
/**
 * Цель exports target: строка как есть; условный объект - первый ключ в порядке ключей объекта из
 * VITEST_CONDITIONS (как у Node и vite: порядок ключей, а не порядок условий), вложенный объект -
 * так же; ни одного совпадения или иное - undefined (отказ называет intModule).
 */
function exportsCondition(target) {
  if (typeof target === 'string') return target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
  const key = Object.keys(target).find((k) => VITEST_CONDITIONS.includes(k));
  return key === undefined ? undefined : exportsCondition(target[key]);
}
/**
 * Модуль, который из модуля from (путь от корня) называет спецификатор spec: { file } или
 * { file, manifest } для пакета workspace; null - конец обхода, не чтение (`node:*`, встроенный
 * модуль, внешний пакет - имени нет среди пакетов dry). `./`, `../` - от каталога from, `.js` - его
 * `.ts` на диске, как в исходниках workspace; `<пакет>` и `<пакет>/<подпуть>` (имя из манифестов
 * dry при любом scope или без него) - файл из exports манифеста пакета dry
 * (строка или условный объект - exportsCondition; без поля exports корень пакета - main, как у
 * Node). Отказ с именем: нестроковый спецификатор (DYNAMIC_SPECIFIER), путь вне корня,
 * абсолютный спецификатор, `#…` (поле imports), `@sf/x` вне пакетов dry, нет строки exports, нет
 * файла.
 */
function intModule(spec, from, ws, src, imports) {
  if (spec === imports.DYNAMIC_SPECIFIER) throw new Error(from + ': нестроковый спецификатор (' + spec + ') - что грузит модуль, проба не знает');
  if (spec.startsWith('node:') || require('module').builtinModules.includes(spec)) return null;
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const rel = path.posix.normalize(path.posix.dirname(from) + '/' + spec);
    if (G.outsideRoot(rel)) throw new Error(from + ': ' + spec + ' - вне корня репозитория');
    if (src.isFile(rel)) return { file: rel };
    const ts = rel.replace(/\.js$/, '.ts');
    if (ts !== rel && src.isFile(ts)) return { file: ts };
    throw new Error(from + ': файла ' + rel + ' нет на диске');
  }
  if (spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec) || spec.startsWith('file:')) throw new Error(from + ': абсолютный спецификатор ' + spec + ' - разбери руками');
  // поле imports пакета (#…) проба не разрешает (замечание ревью E7 E0-12T): молча внешним пакетом
  // оно увело бы обход мимо модуля workspace
  if (spec.startsWith('#')) throw new Error(from + ': импорт ' + spec + ' по полю imports пакета - разбери руками');
  // имя пакета - `@scope/имя` или `имя`, дальше подпуть; пакет workspace - по имени в манифестах dry
  // при любом scope, не только @sf (замечание ревью E7 E0-12T)
  const m = /^((?:@[^/]+\/)?[^/]+)(?:\/(.+))?$/.exec(spec);
  const dep = m && Object.prototype.hasOwnProperty.call(ws, m[1]) ? ws[m[1]] : undefined;
  if (!dep) {
    if (spec.startsWith('@sf/')) throw new Error(from + ': ' + (m ? m[1] : spec) + ' нет среди пакетов dry-JSON turbo (вне workspace)');
    return null;
  }
  const key = m[2] ? './' + m[2] : '.';
  const exp = dep.pkg.exports;
  const isMap = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
  let target;
  if (typeof exp === 'string') target = key === '.' ? exp : undefined;
  else if (isMap(exp)) target = Object.keys(exp).some((k) => k.startsWith('.')) ? exp[key] : key === '.' ? exp : undefined;
  // без поля exports корень пакета - main, как у Node (@sf/core, @sf/contracts); подпуть - отказ ниже
  else if (exp === undefined && key === '.') target = dep.pkg.main;
  target = exportsCondition(target);
  if (typeof target !== 'string') throw new Error(from + ': у ' + m[1] + ' нет строки exports["' + key + '"] (условия ' + VITEST_CONDITIONS.join(', ') + ')' + (exp === undefined && key === '.' ? ' и main' : ''));
  const file = path.posix.normalize(dep.dir + '/' + target);
  if (!src.isFile(file)) throw new Error(from + ': файла ' + file + ' (' + spec + ') нет на диске');
  return { file, manifest: path.posix.join(dep.dir, 'package.json') };
}

/**
 * Граф чтений int-наборов (E0-12T; TECH_DEBT 11.10.2026 E0-02A круг 3 - `intProbeReads` и второй
 * файл окружения, `moduleReads` и транзитивные импорты; 17.10.2026 E0-12A круг 3 - пресет и
 * globalSetup; 19.10.2026 E0-12D круг 1 - разбор импортов регулярками): по каждому корню entries
 * ({ name, config, setupFiles, globalSetup } - пути от корня, как их разрешил vitest) - конфиг,
 * каждый setup и globalSetup и их транзитивные импорты внутри workspace (importSpecifiers из
 * test/imports.ts, резолв - intModule; `.json` - лист без разбора), а в каждом обойдённом модуле -
 * употребления repoRoot (repoRootUses, решение техлида B5 E0-12T): join/resolve(repoRoot, …) с
 * литералами - фикстура, чтение (кроме JOINED_NOT_READ), обязана быть на диске; нелитерал и любое
 * иное употребление repoRoot - отказ «разбери руками» с модулем и строкой, кроме модулей
 * REPO_ROOT_REVIEWED. Setup без testEnvFilePath законен; корень без единой фикстуры - отказ (что
 * читают наборы, проба тогда не знает). Ошибка пары vitest (entry.error) - отказ с именем корня.
 * Модуль разбирается один раз на вызов. ws - манифесты dry; src - источник; imports - модуль
 * test/imports.ts; reviewed - перечень модулей, разобранных руками (по умолчанию
 * REPO_ROOT_REVIEWED). Возвращает { reads, reviewedHit }: reads - [{ file, why, kind, input }] без
 * повторов (kind - первый вид чтения, INT_PROBE_INPUT_KINDS или module; input - файл - вход пробы
 * хоть одним видом), reviewedHit - модули перечня, чьё употребление обход встретил.
 */
function intProbeWalk(entries, ws, src, imports, reviewed = REPO_ROOT_REVIEWED) {
  const out = new Map();
  const reviewedHit = new Set();
  const add = (file, kind, why) => {
    const prev = out.get(file);
    const input = INT_PROBE_INPUT_KINDS.includes(kind);
    if (!prev) out.set(file, { file, why, kind, input });
    else if (input && !prev.input) out.set(file, { file, why, kind, input });
  };
  const parsed = new Map();
  const parse = (mod) => {
    if (!parsed.has(mod)) {
      const text = src.read(mod);
      parsed.set(mod, { uses: imports.repoRootUses(mod, text), specs: imports.importSpecifiers(mod, text) });
    }
    return parsed.get(mod);
  };
  const byHand = (mod, line, what) => {
    if (Object.prototype.hasOwnProperty.call(reviewed, mod)) {
      reviewedHit.add(mod);
      return;
    }
    throw new Error(mod + ':' + line + ': ' + what + ' - что читает модуль, проба не знает; разбери руками (REPO_ROOT_REVIEWED)');
  };
  for (const e of entries) {
    if (e.error) throw new Error(e.name + ': ' + e.error);
    add(e.config, 'config', '--config ' + e.name);
    const queue = [];
    for (const f of e.setupFiles) { add(f, 'setup', 'setupFiles ' + e.name); queue.push(f); }
    for (const f of e.globalSetup) { add(f, 'globalSetup', 'globalSetup ' + e.name); queue.push(f); }
    const seen = new Set();
    let fixtures = 0;
    while (queue.length) {
      const mod = queue.shift();
      if (seen.has(mod)) continue;
      seen.add(mod);
      if (mod.endsWith('.json')) continue;
      const { uses, specs } = parse(mod);
      for (const use of uses) {
        if (use.kind !== 'path') {
          byHand(mod, use.line, 'repoRoot не первым аргументом join/resolve');
          continue;
        }
        const call = use.callee + '(repoRoot, …)';
        if (use.path === imports.DYNAMIC_SPECIFIER) {
          byHand(mod, use.line, call + ' с нелитералом');
          continue;
        }
        add(mod, 'join', call + ' в ' + e.name);
        if (Object.prototype.hasOwnProperty.call(JOINED_NOT_READ, use.path)) continue;
        // сегменты склеены через '/': абсолютный сегмент (resolve отбрасывает всё до него, join -
        // нет), обратный слеш и буква диска (Windows) posix-нормализация не разбирает - fail-closed
        // (замечание ревью E5 E0-12T)
        if (/\\|\/\/|^\/|(?:^|\/)[A-Za-z]:/.test(use.path)) {
          byHand(mod, use.line, call + ' с путём ' + JSON.stringify(use.path) + ' (обратный слеш, абсолютный сегмент или буква диска)');
          continue;
        }
        const rel = path.posix.normalize(use.path);
        if (G.outsideRoot(rel)) throw new Error(mod + ': ' + use.callee + '(repoRoot, "' + use.path + '") - вне корня репозитория');
        if (!src.present(rel)) throw new Error('фикстуры ' + rel + ' (' + call + ' в ' + mod + ') нет в корне');
        add(rel, 'fixture', call + ' в ' + mod);
        fixtures++;
      }
      for (const spec of specs) {
        const hit = intModule(spec, mod, ws, src, imports);
        if (!hit) continue;
        if (hit.manifest) add(hit.manifest, 'manifest', 'exports для ' + spec + ' (' + mod + ')');
        add(hit.file, 'module', 'импорт ' + spec + ' из ' + mod);
        queue.push(hit.file);
      }
    }
    if (!fixtures) throw new Error('у корня ' + e.name + ' ноль фикстур join(repoRoot, …) в setupFiles, globalSetup и их импортах - что читают наборы, проба не знает');
  }
  return { reads: Array.from(out.values()), reviewedHit };
}
/** Чтения графа int-наборов (intProbeWalk(...).reads). */
function intProbeReads(entries, ws, src, imports, reviewed) {
  return intProbeWalk(entries, ws, src, imports, reviewed).reads;
}

/**
 * Путь abs (как его отдал vitest) от каталога base через realpath (base - уже realpath): ссылка
 * pnpm `node_modules/@sf/config` становится `packages/config`. Путь вне base - исключение с what
 * (кто спрашивал). «Под каталогом» - один предикат strictlyUnder модуля графа (каталог `..x`
 * внутри base - под ним). Результат - с `/`.
 */
function relUnder(abs, base, what) {
  const real = fs.realpathSync(abs);
  if (!G.strictlyUnder(real, base)) throw new Error(what + ': путь ' + abs + ' вне ' + base);
  return path.relative(base, real).split(path.sep).join('/');
}

/**
 * Корни графа roots ({ name, dir, command }) и ответ awaitVitest по ним -> entries intProbeReads
 * (пути от корня через rel(abs)).
 */
function intEntries(roots, results, rel) {
  return roots.map((root, i) => {
    const x = results[i];
    if (x.error) return { name: root.name, error: x.error };
    return { name: root.name, config: rel(x.config), setupFiles: x.setupFiles.map(rel), globalSetup: x.globalSetup.map(rel) };
  });
}

/**
 * Дочерний vitest пробы test:int - один на прогон (условный стоп 2 техлида E0-12T: второго
 * процесса нет): корни графа test:int, стаб int-пробы и пары INT_STUB_PAIRS одним запуском.
 * Стаб - временный каталог (`<dir>/stub`) с конфигом без импортов, setup `./…`, модулем с
 * join(repoRoot, ".env.test") и globalSetup, который пишет метку. Процесс стартует без ожидания
 * (startVitest) сразу после снимков графа и test/imports.ts - без них и без зелёной пробы
 * синтаксиса selftest-vitest.mjs не стартует; ответ разбирает intVitest. Не стартовал (причина
 * названа: граф, test/imports.ts, синтаксис) или ошибка подготовки - { error }, её назовут пробы,
 * которым нужен ответ; null не возвращается (замечание ревью E4 E0-12T). gates - подмена для
 * кейса: { graph, imports } (snapshotGate) и syntax (SYNTAX_OK).
 */
function startIntVitest(gates = { graph: GRAPH_GATE, imports: IMPORTS_GATE, syntax: SYNTAX_OK }) {
  const not = 'дочерний vitest не стартовал: ';
  if (gates.graph.error !== null) return { error: new Error(not + 'нет графа turbo (' + gates.graph.error + ')') };
  if (gates.imports.error !== null) return { error: new Error(not + 'test/imports.ts не загружен (' + gates.imports.error + ')') };
  if (gates.syntax.get('selftest-vitest.mjs') !== true) return { error: new Error(not + 'selftest-vitest.mjs не прошёл пробу синтаксиса') };
  const dir = tempDir('int-vitest');
  try {
    const stub = path.join(dir, 'stub');
    for (const [rel, body] of Object.entries(INT_STUB_FILES)) {
      fs.mkdirSync(path.dirname(path.join(stub, rel)), { recursive: true });
      fs.writeFileSync(path.join(stub, rel), body);
    }
    const roots = G.taskGraph(GRAPH_GATE.snap.dry, 'test:int').roots;
    const keys = Object.keys(INT_STUB_PAIRS);
    const pairs = roots.map((r) => [path.join(ROOT, r.dir), r.command])
      .concat([[stub, INT_STUB_COMMAND]], keys.map((k) => [stub, INT_STUB_PAIRS[k]]));
    return { dir, stub, roots, keys, handle: startVitest(pairs, dir) };
  } catch (e) {
    releaseTemp(dir);
    return { error: e };
  }
}

/**
 * Ответ дочернего vitest (INT_VITEST_START), разобранный один раз за прогон - снимок VITEST_GATE
 * (ленивый snapshotGate, замечание ревью C10 E0-12T): { live, stub }. live - entries корней графа (пути от корня
 * через realpath) или ошибка их отображения; stub - стаб int-пробы: entry корня стаба (пути
 * стаба отображены на G.STUB_DIR - stubUnderGlob и детекторы видят его, как любой стаб-файл),
 * pairs - ответы пар INT_STUB_PAIRS по ключам как есть, entries - они же как entries
 * intProbeReads (пути стаба; ошибка пары - { error }), globalRan - метки globalSetup, которые
 * нашлись (absent: недоступная метка - отказ, а не «нет»), src - наложенный источник с текстами
 * стаба, files - стаб-файлы от корня, expect - setup, который детектор обязан назвать вне glob.
 * Каталог стаба снимается после разбора (releaseTemp: сбой снятия не подменяет ответ). Отказ
 * (не стартовал, не ответил, ответ иной формы) - одна красная строка снимка «дочерний vitest пробы
 * test:int», пробы, которым нужен ответ, - в её перечне (GateBlocked), а не каскад одинаковых строк.
 */
function intVitest() {
  return VITEST_GATE.take();
}
/** Снимок VITEST_GATE: ответ INT_VITEST_START, каталог стаба снимается после разбора. */
function takeIntVitest() {
  const start = INT_VITEST_START;
  try {
    if (start.error) throw start.error;
    return readIntVitest(start);
  } finally {
    if (start.dir) releaseTemp(start.dir);
  }
}
/** Разбор ответа startIntVitest (каталог стаба ещё на диске) - см. intVitest. */
function readIntVitest(start) {
  const results = awaitVitest(start.handle);
  const n = start.roots.length;
  let live;
  try {
    const realRoot = fs.realpathSync(ROOT);
    live = { value: intEntries(start.roots, results.slice(0, n), (abs) => relUnder(abs, realRoot, 'корень репозитория')) };
  } catch (e) {
    live = { error: e };
  }
  const realStub = fs.realpathSync(start.stub);
  const rel = (abs) => G.STUB_DIR + '/' + relUnder(abs, realStub, 'стаб int-пробы');
  const name = G.stubTaskId('test:int');
  const texts = {};
  for (const [f, body] of Object.entries(INT_STUB_FILES)) texts[G.STUB_DIR + '/' + f] = body;
  const pairs = {};
  const entries = {};
  start.keys.forEach((k, i) => {
    pairs[k] = results[n + 1 + i];
    entries[k] = pairs[k].error ? { name, error: pairs[k].error } : intEntries([{ name }], [pairs[k]], rel)[0];
  });
  return {
    live,
    stub: {
      entry: intEntries([{ name }], [results[n]], rel)[0],
      pairs,
      entries,
      globalRan: INT_STUB_GLOBAL_MARKS.filter((m) => !absent(path.join(start.stub, m))),
      src: overlaySource(texts),
      files: Object.keys(texts),
      expect: G.STUB_DIR + '/vitest/selftest-setup.ts',
    },
  };
}

/**
 * Чтения int-наборов на настоящем дереве - ленивое поле снимка GRAPH_GATE (snap.int): один
 * обход за прогон по ответу intVitest; их сверяют пробы test:int и harness-selftest. Отказ
 * запоминается тоже. snap.int.reviewedHit - модули REPO_ROOT_REVIEWED, которые обход встретил.
 */
function liveIntWalk() {
  const snap = GRAPH_GATE.snap;
  if (!snap.int) {
    try {
      const live = intVitest().live;
      if (live.error) throw live.error;
      snap.int = { value: intProbeWalk(live.value, snap.ws, DISK, IMPORTS_GATE.snap) };
    } catch (e) {
      snap.int = { error: e };
    }
  }
  if (snap.int.error) throw snap.int.error;
  return snap.int.value;
}
/** Чтения int-наборов настоящего дерева (liveIntWalk().reads). */
function liveIntReads() {
  return liveIntWalk().reads;
}

/** Стаб int-пробы (intVitest().stub). */
function intProbeStubBase() {
  return intVitest().stub;
}

/**
 * Стаб для детектора чтений int на G.stubNode: задача test:int с командой INT_STUB_COMMAND в
 * STUB_DIR (вне glob гейта, корень графа рядом с настоящими) и чтения графа int со стабом.
 * Возвращает { dry, reads, expect, files }: reads - чтения настоящих корней и корня стаба,
 * expect - setup стаба, который детектор обязан назвать; files - стаб-файлы (их glob гейта
 * покрывать не должен). Снимок dry не правится.
 */
function intProbeStub(dry, ws) {
  const base = intProbeStubBase();
  const stub = G.stubNode(dry, 'test:int', { command: INT_STUB_COMMAND });
  const reads = intProbeReads([base.entry], ws, base.src, IMPORTS_GATE.snap).concat(liveIntReads());
  return { dry: stub, reads, expect: base.expect, files: base.files };
}

/**
 * Чтения int-наборов, которых быть не должно (E0-12T; TECH_DEBT 11.10.2026 E0-02A - `scripts/**` и `infra/**` вне glob test:int, вложенные `.env.test`, glob test:int без `infra/**`; Р4 и В1
 * техлида E0-12M): под scripts/ и infra/ (стек Compose и его гейт наборы не читают) и вложенный
 * .env.test пакета (testEnvFilePath читает только корневой). Строки `file (why)`.
 */
function intForbidden(reads) {
  return reads
    .filter((r) => r.file.startsWith('scripts/') || r.file.startsWith('infra/') || (r.file !== '.env.test' && path.posix.basename(r.file) === '.env.test'))
    .map((r) => r.file + ' (' + r.why + ')');
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
 * Детектор разницы графа с манифестами (G.manifestGap) не слепой: граф script без рёбер к
 * некорневому узлу graph (G.stubCut) обязан назвать его пакет. Узел для среза - первый некорневой,
 * чей пакет в замыкании workspace:-зависимостей манифестов от корней (G.manifestClosure): узел,
 * пришедший явным `dependsOn "@sf/x#build"` без манифеста, разницы с манифестами не даёт, и срез
 * его давал бы ложное «проба не замечает» (TECH_DEBT 21.10.2026 E0-12L круг 3, `manifestGapBlind`). Таких узлов нет - детектор не
 * построить, это отказ, а не пропуск. Строка отказа или null.
 */
function manifestGapBlind(dry, script, graph, ws) {
  const closure = G.manifestClosure(graph, ws);
  const cut = graph.nodes.find((n) => !n.root && closure.has(n.pkg));
  if (!cut) return 'у графа turbo run ' + script + ' нет узлов кроме корней из замыкания манифестов - детектор разницы с манифестами не построить';
  if (G.manifestGap(G.taskGraph(G.stubCut(dry, cut.name), script), ws).includes(cut.pkg)) return null;
  return 'проба не замечает граф без ' + cut.name + ' (стаб без рёбер к узлу): ' + cut.pkg + ' не назван разницей с манифестами';
}

/**
 * Детектор G.inputsGap не слепой: граф без одного файла пакета во входах первого узла, у которого
 * такой вход есть и он среди tracked (G.stubWithoutInput), обязан назвать этот файл. «Файл пакета» -
 * тот же отбор G.ownFiles, что у inputsGap: под каталогом узла (каталог `.` корневой задачи - весь
 * корень), не во вложенном пакете, не в TRACKED_NOT_HASHED - срез файла, который inputsGap не
 * считает, дал бы ложное «проба не замечает». Вход только из tracked: turbo хеширует и
 * неотслеживаемые файлы, а inputsGap сверяет лишь tracked - срез нового `??`-файла дал бы то же
 * ложное «проба не замечает». Строка отказа или null.
 */
function inputsGapBlind(dry, script, graph, tracked) {
  const seen = new Set(tracked);
  const dirs = Array.from(G.dryPackages(dry).values());
  const own = (n) => G.ownFiles(n, n.reads.map((r) => r.file), dirs).filter((f) => seen.has(f));
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
 * своим файлом, граф без рёбер к узлу из замыкания манифестов (G.stubCut) - разницу с манифестами
 * с его пакетом; при opts.extraStub - и стаб opts.extraStub(dry, ws) ({ dry, reads, expect, files }):
 * его expect обязан попасть в отказ. Стаб-каталог под glob - первым: это условие детекторов, и
 * проба стаб-каталога не гоняет весь граф ради него. opts.label - кто читает, с глаголом.
 */
function checkTurboGraph(script, opts) {
  return ({ gate, runs }) => {
    const { dry, ws, tracked } = GRAPH_GATE.snap;
    const s = opts.extraStub ? opts.extraStub(dry, ws) : null;
    const under = stubUnderGlob(runs, gate.id, s ? s.files : []);
    if (under) return under;
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
    const want = G.STUB_DIR + '/package.json ';
    const stub = graphOutside(runs, G.stubNode(dry, script, { inputs: { 'package.json': 'stub' } }), script, extra);
    if (!stub.outside.some((b) => b.startsWith(want))) return 'проба не замечает узел ' + G.STUB_DIR + ' вне glob ' + gate.id + ' на стабе';
    // globalCacheInputs сверяются наравне со входами задач: посторонний глобальный вход - отказ
    if (!graphOutside(runs, G.stubGlobal(dry), script, extra).outside.some((b) => b.startsWith(G.STUB_GLOBAL + ' '))) {
      return 'проба не замечает глобальный вход ' + G.STUB_GLOBAL + ' вне glob ' + gate.id + ' на стабе';
    }
    const gapBlind = manifestGapBlind(dry, script, real.graph, ws);
    if (gapBlind) return gapBlind;
    if (s && !graphOutside(runs, s.dry, script, s.reads).outside.some((b) => b.startsWith(s.expect + ' '))) {
      return 'проба не замечает ' + s.expect + ' вне glob ' + gate.id + ' на стабе чтений сверх графа';
    }
    const files = real.graph.nodes.reduce((n, x) => n + x.reads.length, 0);
    const skipped = G.globalReads(dry).skipped.map((r) => r.file);
    return {
      note: script + ': корни ' + real.graph.roots.map((r) => r.name).join(', ') + '; узлов ' + real.graph.nodes.length + ', файлов ' + files +
        (extra.length ? ' и ' + extra.length + ' чтений сверх графа' : '') + (skipped.length ? '; не сверяются (HASHED_NOT_READ): ' + skipped.join(', ') : ''),
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
    const dry = GRAPH_GATE.snap.dry;
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
  return actual === expected || scriptKey(script) + ' в корневом package.json не ' + expected + ': ' + JSON.stringify(actual);
}

/**
 * Две строки «скрипт корня = ровно expected»: на настоящем package.json (rootPkg - одно чтение за
 * прогон) и проба отказа - тот же скрипт с лишним флагом обязан краснеть. label - начало названия.
 */
function checkRootScriptLines(label, script, expected) {
  check(label + ': ' + scriptKey(script) + ' = ' + expected + ' в корневом package.json', () => rootScriptVerdict(rootPkg(), script, expected));
  check(label + ': ' + scriptKey(script) + ' с лишним флагом краснеет (проба отказа)', () => {
    const r = rootScriptVerdict({ scripts: { [script]: expected + ' --passWithNoTests' } }, script, expected);
    return typeof r === 'string' || 'скрипт с лишним флагом принят за ' + expected;
  });
}

/**
 * extra-строка гейта, который гоняет корневой скрипт: cmd гейта - ровно `pnpm <script>`,
 * scripts[script] корневого package.json (rootPkg) - ровно expected (rootScriptVerdict).
 */
function rootScriptExtra(script, expected) {
  return {
    name: 'cmd pnpm ' + script + ' и ' + scriptKey(script) + ' = ' + expected + ' в корневом package.json',
    fn: ({ gate }) => {
      if (gate.cmd !== 'pnpm ' + script) return 'cmd гейта ' + gate.id + ' не pnpm ' + script + ': ' + gate.cmd;
      return rootScriptVerdict(rootPkg(), script, expected);
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
    // turbo 2.10 читает и turbo.jsonc корня (TECH_DEBT 21.10.2026 E0-12L круг 4, `turbo.jsonc`)
    'turbo.jsonc',
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
    'docs/turbo.jsonc',
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

/** Проба графа test:int: сверх графа - чтения int-наборов (liveIntReads) и их стаб (intProbeStub). */
const INT_GRAPH_OPTS = {
  label: 'int-тесты читают',
  liveExtra: liveIntReads,
  extraStub: intProbeStub,
};

// Стаб-каталог под glob гейта - отказ с именем STUB_DIR, а не «проба не замечает» (вина не
// на пробе): проба графа на glob, который выбирает всё, на glob, который выбирает только
// глобальный стаб-вход, и на glob test:int, который выбирает setup int-стаба.
{
  const name = 'граф turbo: стаб-каталог под glob гейта - отказ с именем STUB_DIR';
  check(name, intGuard(name, () => {
    const gate = { id: 'build-all' };
    const fileUnder = (files) => 'стаб-каталог ' + G.STUB_DIR + ' под glob build-all (' + files.join(', ') + ') - детектор не построить, смени STUB_DIR в selftest-graph.js';
    const all = checkTurboGraph('build', { label: 'сборка читает' })({ gate, runs: () => true });
    if (all !== fileUnder(G.STUB_FILES)) return 'glob на всё: ожидалось «' + fileUnder(G.STUB_FILES) + '», получено ' + JSON.stringify(all);
    const runs = (f) => f === G.STUB_GLOBAL || gateProbe('build').runs(f);
    const global = checkTurboGraph('build', { label: 'сборка читает' })({ gate, runs });
    if (global !== fileUnder([G.STUB_GLOBAL])) return 'glob со STUB_GLOBAL: ожидалось «' + fileUnder([G.STUB_GLOBAL]) + '», получено ' + JSON.stringify(global);
    const setup = intProbeStubBase().expect;
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
// корневой vitest.preset.ts (ADR-0011) и корневой .env.test; glob гейта test:int - по факту
// чтения (docs/DECISIONS.md 11.10.2026, E0-02A, вопрос «Селектор гейта test:int: буква эпика,
// glob по графу зависимостей или always»). Граф пакетов и корни - у turbo (E0-12L); конфиги,
// setupFiles и globalSetup - у vitest (selftest-vitest.mjs), их импорты - test/imports.ts
// (E0-12T): граф чтений int-наборов - intProbeReads.
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
    // Вложенные .env.test int-пакетов выбирает маска пакета: turbo хеширует файл как вход узла
    // (E0-12M, В1). Наборы их не читают: testEnvFilePath - только корень, это сверяет проба
    // «int-наборы не читают scripts/, infra/ и вложенный .env.test» ниже.
    'apps/api/.env.test',
    'packages/db/.env.test',
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    'turbo.json',
    // turbo 2.10 читает и turbo.jsonc корня (TECH_DEBT 21.10.2026 E0-12L круг 4, `turbo.jsonc`)
    'turbo.jsonc',
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
    // Стек Compose и его гейт int-наборы не читают (E0-12M, решение техлида Р4): адрес стека -
    // из корневого .env.test (testEnvFilePath - только корень), стек перезапускает человек;
    // что наборы их не читают, сверяет проба «int-наборы не читают …» ниже.
    'infra/docker-compose.yml',
    'infra/docker-compose.app.yml',
    'scripts/check-compose.mjs',
    'scripts/lib/paths.mjs',
    'scripts/tasks.mjs',
    'scripts/tsconfig.json',
    'apps/web/.env.test',
    'xapps/a.ts',
    'docs/apps/api/x.ts',
    'docs/turbo.jsonc',
  ],
  extra: [
    rootScriptExtra('test:int', 'turbo run test:int --concurrency=1'),
    {
      name: 'каждый файл графа turbo run test:int (узлы от корней, globalCacheInputs) и граф чтений int-наборов (конфиги --config, setupFiles, globalSetup, их импорты, фикстуры join(repoRoot, …)) под glob',
      int: true,
      fn: checkTurboGraph('test:int', INT_GRAPH_OPTS),
    },
    {
      // Р4 и В1 техлида E0-12M (TECH_DEBT 11.10.2026 E0-02A - `scripts/**`, `infra/**` и вложенные `.env.test`): граф чтений не заходит в
      // scripts/, infra/ и вложенный .env.test; имена из mustSkip под scripts/ и infra/ и
      // вложенные .env.test из mustRun в нём не встречаются; детектор - стаб с join(repoRoot,
      // "scripts/tasks.mjs") обязан покраснеть.
      name: 'int-наборы не читают scripts/, infra/ и вложенный .env.test (граф чтений; имена mustSkip и mustRun сверены; проба отказа - стаб с join(repoRoot, "scripts/tasks.mjs"))',
      int: true,
      fn: (_probe, spec) => {
        const reads = liveIntReads();
        const bad = intForbidden(reads);
        if (bad.length) return 'int-наборы читают то, на чём гейт не выбирается: ' + bad.join(', ');
        const files = new Set(reads.map((r) => r.file));
        const named = spec.mustSkip.filter((f) => /^(?:scripts|infra)\//.test(f)).concat(spec.mustRun.filter((f) => f !== '.env.test' && path.posix.basename(f) === '.env.test'));
        const read = named.filter((f) => files.has(f));
        if (read.length) return 'граф чтений int-наборов держит файлы из mustSkip/mustRun, которые наборы не читают: ' + read.join(', ');
        const planted = intForbidden(intCaseReads({ 'vitest/s.ts': 'import { join } from "node:path";\nconst repoRoot = "";\njoin(repoRoot, ".env.test");\njoin(repoRoot, "scripts/tasks.mjs");\n' }));
        const want = 'scripts/tasks.mjs (join(repoRoot, …) в ' + G.STUB_DIR + '/vitest/s.ts)';
        if (planted.join() !== want) return 'проба не замечает чтение scripts/ на стабе: ожидалось «' + want + '», получено ' + JSON.stringify(planted);
        return { note: reads.length + ' чтений, сверено имён ' + named.length };
      },
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

/**
 * Обход int-наборов на наложенном источнике без дочернего vitest (ветки отказа - TECH_DEBT
 * 11.10.2026 E0-02A круг 3 «у веток throw нет красной посадки»; детектор чтений scripts/): один
 * корень стаба с setup STUB_DIR/vitest/s.ts. files - { путь от STUB_DIR: текст }; extraWs - пакеты
 * сверх манифестов dry; rootFiles - тексты по путям от корня; reviewed - перечень модулей,
 * разобранных руками (по умолчанию REPO_ROOT_REVIEWED). Возвращает intProbeWalk.
 */
function intCaseWalk(files, extraWs, rootFiles, reviewed) {
  const texts = Object.assign({}, rootFiles || {});
  for (const [f, body] of Object.entries(files)) texts[G.STUB_DIR + '/' + f] = body;
  const entry = { name: G.stubTaskId('test:int'), config: G.STUB_DIR + '/vitest.selftest.config.mjs', setupFiles: [G.STUB_DIR + '/vitest/s.ts'], globalSetup: [] };
  return intProbeWalk([entry], Object.assign({}, GRAPH_GATE.snap.ws, extraWs || {}), overlaySource(texts), IMPORTS_GATE.snap, reviewed);
}
/** Чтения intCaseWalk. */
function intCaseReads(files, extraWs, rootFiles) {
  return intCaseWalk(files, extraWs, rootFiles).reads;
}

// Ветки отказа графа чтений int-наборов (E0-12T; TECH_DEBT 11.10.2026 E0-02A круг 3 «у веток throw
// нет красной посадки»; L-020): каждая ждёт точный текст отказа, ветка, заменённая на пропуск,
// краснит свой кейс. Конфиг и флаги - на ответе дочернего vitest по стабу (одним запуском со
// стабом, intProbeStubBase), обход - на наложенном источнике.
{
  const S = (f) => G ? G.STUB_DIR + '/' + f : f;
  // want - функция: текст отказа строится от модуля графа, его зовёт только проба под intGuard
  const intRefused = (name, fn, want) => {
    const line = 'граф чтений int: ' + name;
    check(line, intGuard(line, () => refusalVerdict(fn, want())));
  };
  const stubName = () => G.stubTaskId('test:int');
  const refusalOf = (key) => intProbeReads([intProbeStubBase().entries[key]], {}, DISK, IMPORTS_GATE.snap);
  intRefused('команда без --config - отказ с именем корня', () => refusalOf('noConfig'),
    () => stubName() + ': команда "vitest run" не называет конфиг через --config или -c');
  intRefused('конфига из --config нет на диске - отказ', () => refusalOf('missingConfig'),
    () => stubName() + ': конфига vitest.missing.config.ts (--config команды "vitest run --config vitest.missing.config.ts") нет на диске');
  intRefused('оператор оболочки в команде (&&) - отказ, команда не разбирается как вызов vitest', () => refusalOf('shell'),
    () => stubName() + ': команда "vitest run --config vitest.selftest.config.mjs && rm -rf x" - не простой вызов vitest (оператор оболочки в «&&»)');
  const setupImporting = (spec) => ({ 'vitest/s.ts': 'import "' + spec + '";\nimport { join } from "node:path";\nconst repoRoot = "";\njoin(repoRoot, ".env.test");\n' });
  intRefused('@sf/x вне пакетов dry - отказ', () => intCaseReads(setupImporting('@sf/selftest-missing/x')),
    () => S('vitest/s.ts') + ': @sf/selftest-missing нет среди пакетов dry-JSON turbo (вне workspace)');
  intRefused('нет строки exports для подпути - отказ', () => intCaseReads(setupImporting('@sf/selftest-case/nothing'), { '@sf/selftest-case': { dir: S('case'), pkg: { name: '@sf/selftest-case', exports: { '.': './index.ts' } } } }),
    () => S('vitest/s.ts') + ': у @sf/selftest-case нет строки exports["./nothing"] (условия ' + VITEST_CONDITIONS.join(', ') + ')');
  // ОВ1 техлида E0-12T: пакет без поля exports (как @sf/core, @sf/contracts) - корень через main,
  // как у Node; подпуть у такого пакета и корень без main - отказ с именем
  const mainOnly = (pkg) => ({ '@sf/selftest-main': { dir: S('main'), pkg: Object.assign({ name: '@sf/selftest-main' }, pkg) } });
  {
    const line = 'граф чтений int: пакет без exports - корень @sf/x разрешается через main (модуль и манифест в чтениях)';
    check(line, intGuard(line, () => {
      const reads = intCaseReads(Object.assign(setupImporting('@sf/selftest-main'), { 'main/src/index.ts': 'export const x = 1;\n' }), mainOnly({ main: './src/index.ts' }), { '.env.test': 'X=1\n' });
      const kindOf = (file) => (reads.find((r) => r.file === file) || {}).kind;
      if (kindOf(S('main/src/index.ts')) !== 'module') return 'модуль main не в чтениях: ' + JSON.stringify(reads.map((r) => r.file));
      return kindOf(S('main/package.json')) === 'manifest' || 'манифест пакета не в чтениях: ' + JSON.stringify(reads.map((r) => r.file));
    }));
  }
  // Голый спецификатор (замечание ревью E7 E0-12T): `#…` - отказ; имя пакета dry вне @sf (другой
  // scope, без scope) - пакет workspace, его модуль и манифест в чтениях; имени нет среди пакетов -
  // внешний пакет, конец обхода
  intRefused('импорт #… (поле imports) - отказ «разбери руками»', () => intCaseReads(setupImporting('#selftest/x')),
    () => S('vitest/s.ts') + ': импорт #selftest/x по полю imports пакета - разбери руками');
  {
    const line = 'граф чтений int: пакет workspace вне @sf (другой scope и без scope) - модуль и манифест в чтениях, имя не из dry - внешний пакет';
    check(line, intGuard(line, () => {
      const pkg = (name, dir) => ({ [name]: { dir: S(dir), pkg: { name, exports: { '.': './i.ts' } } } });
      const ws = Object.assign(pkg('@selftest/scoped', 'scoped'), pkg('selftest-bare', 'bare'));
      const setup = { 'vitest/s.ts': 'import "@selftest/scoped";\nimport "selftest-bare";\nimport "selftest-external";\nimport { join } from "node:path";\nconst repoRoot = "";\njoin(repoRoot, ".env.test");\n' };
      const reads = intCaseReads(Object.assign(setup, { 'scoped/i.ts': '', 'bare/i.ts': '' }), ws, { '.env.test': 'X=1\n' });
      const files = reads.map((r) => r.kind + ' ' + r.file);
      const want = ['module ' + S('scoped/i.ts'), 'manifest ' + S('scoped/package.json'), 'module ' + S('bare/i.ts'), 'manifest ' + S('bare/package.json')];
      const missing = want.filter((w) => !files.includes(w));
      if (missing.length) return 'нет в чтениях: ' + missing.join(', ') + '; получено ' + JSON.stringify(files);
      const stray = files.filter((x) => x.includes('selftest-external'));
      return !stray.length || 'внешний пакет в чтениях: ' + stray.join(', ');
    }));
  }
  // DISK.present - absent, не existsSync (замечание ревью C6/E10 E0-12T): ошибка lstat не ENOENT и не
  // ENOTDIR (здесь - путь с NUL) - исключение, а не «фикстуры нет»
  check('граф чтений int: DISK.present - ошибка lstat не ENOENT/ENOTDIR (путь с NUL) - исключение, а не «нет»', () => {
    try {
      return 'ответ ' + DISK.present('selftest\0x') + ' вместо исключения';
    } catch (e) {
      return (e && e.code === 'ERR_INVALID_ARG_VALUE') || 'иное исключение: ' + ((e && e.message) || String(e));
    }
  });
  intRefused('пакет без exports - подпуть - отказ', () => intCaseReads(setupImporting('@sf/selftest-main/x'), mainOnly({ main: './src/index.ts' })),
    () => S('vitest/s.ts') + ': у @sf/selftest-main нет строки exports["./x"] (условия ' + VITEST_CONDITIONS.join(', ') + ')');
  intRefused('пакет без exports и без main - корень - отказ', () => intCaseReads(setupImporting('@sf/selftest-main'), mainOnly({})),
    () => S('vitest/s.ts') + ': у @sf/selftest-main нет строки exports["."] (условия ' + VITEST_CONDITIONS.join(', ') + ') и main');
  // Условный exports (замечание ревью C7 E0-12T): первое в порядке ключей условие из набора vitest
  // (VITEST_CONDITIONS), вложенный объект - так же; ни одного совпавшего - отказ
  {
    const line = 'граф чтений int: условный exports - первое по порядку ключей условие vitest (browser мимо, node раньше default, вложенный import, default первым), ни одного - отказ';
    check(line, intGuard(line, () => {
      const pkg = (exports) => ({ '@sf/selftest-cond': { dir: S('cond'), pkg: { name: '@sf/selftest-cond', exports } } });
      const texts = Object.assign(setupImporting('@sf/selftest-cond'), { 'cond/b.ts': '', 'cond/n.ts': '', 'cond/d.ts': '', 'cond/i.ts': '' });
      const moduleOf = (exports) => intCaseReads(texts, pkg(exports), { '.env.test': 'X=1\n' }).filter((r) => r.kind === 'module').map((r) => r.file);
      const got = [
        moduleOf({ browser: './b.ts', node: './n.ts', default: './d.ts' }),
        moduleOf({ '.': { require: './b.ts', node: { browser: './b.ts', import: './i.ts', default: './d.ts' }, default: './d.ts' } }),
        moduleOf({ default: './d.ts', node: './n.ts' }),
      ];
      const want = [[S('cond/n.ts')], [S('cond/i.ts')], [S('cond/d.ts')]];
      if (JSON.stringify(got) !== JSON.stringify(want)) return 'ожидалось ' + JSON.stringify(want) + ', получено ' + JSON.stringify(got);
      return refusalVerdict(() => intCaseReads(texts, pkg({ browser: './b.ts', require: './b.ts' })),
        S('vitest/s.ts') + ': у @sf/selftest-cond нет строки exports["."] (условия ' + VITEST_CONDITIONS.join(', ') + ')');
    }));
  }
  intRefused('нет файла модуля - отказ', () => intCaseReads(setupImporting('./missing.js')),
    () => S('vitest/s.ts') + ': файла ' + S('vitest/missing.js') + ' нет на диске');
  intRefused('относительный импорт вне корня репозитория (../../../x.js) - отказ', () => intCaseReads(setupImporting('../../../x.js')),
    () => S('vitest/s.ts') + ': ../../../x.js - вне корня репозитория');
  // абсолютный спецификатор - три формы одной ветки: без неё каждая молча выпала бы из графа как
  // внешний пакет
  for (const spec of ['/etc/selftest-x.js', 'C:/selftest-x.js', 'file:///selftest-x.js']) {
    intRefused('абсолютный спецификатор ' + spec + ' - отказ «разбери руками»', () => intCaseReads(setupImporting(spec)),
      () => S('vitest/s.ts') + ': абсолютный спецификатор ' + spec + ' - разбери руками');
  }
  const withRoot = (...lines) => ({ 'vitest/s.ts': 'import { join, relative, resolve } from "node:path";\nconst repoRoot = "";\n' + lines.join('\n') + '\n' });
  intRefused('нет фикстуры join(repoRoot, …) - отказ', () => intCaseReads(withRoot('join(repoRoot, "selftest-missing.env");')),
    () => 'фикстуры selftest-missing.env (join(repoRoot, …) в ' + S('vitest/s.ts') + ') нет в корне');
  intRefused('join(repoRoot, "../x") вне корня - отказ', () => intCaseReads(withRoot('join(repoRoot, ".env.test");', 'join(repoRoot, "../selftest-x");')),
    () => S('vitest/s.ts') + ': join(repoRoot, "../selftest-x") - вне корня репозитория');
  intRefused('ноль фикстур у корня - отказ', () => intCaseReads({ 'vitest/s.ts': 'export const x = 1;\n' }),
    () => 'у корня ' + stubName() + ' ноль фикстур join(repoRoot, …) в setupFiles, globalSetup и их импортах - что читают наборы, проба не знает');
  intRefused('нестроковый спецификатор (DYNAMIC_SPECIFIER) - отказ', () => intCaseReads({ 'vitest/s.ts': 'const name = "x";\nawait import(name);\n' }),
    () => S('vitest/s.ts') + ': нестроковый спецификатор (<dynamic>) - что грузит модуль, проба не знает');
  // Употребления repoRoot (решение техлида B5 E0-12T): resolve - чтение, как join; нелитерал и
  // любое иное употребление - отказ с модулем и строкой, кроме модулей REPO_ROOT_REVIEWED.
  const byHand = (line, what) => () => S('vitest/s.ts') + ':' + line + ': ' + what + ' - что читает модуль, проба не знает; разбери руками (REPO_ROOT_REVIEWED)';
  intRefused('join(repoRoot, …) с нелитералом - отказ с модулем и строкой', () => intCaseReads(withRoot('const f = "x";', 'join(repoRoot, f);')),
    byHand(4, 'join(repoRoot, …) с нелитералом'));
  intRefused('resolve(repoRoot, "<файл>") - чтение: файла нет - отказ', () => intCaseReads(withRoot('resolve(repoRoot, "selftest-missing.json");')),
    () => 'фикстуры selftest-missing.json (resolve(repoRoot, …) в ' + S('vitest/s.ts') + ') нет в корне');
  // путь не posix-формы (замечание ревью E5 E0-12T): поздний абсолютный сегмент resolve, обратный
  // слеш, буква диска - «разбери руками», а не склейка в путь под корнем или мимо outsideRoot
  for (const [call, joined] of [['resolve(repoRoot, "cfg", "/etc/x")', 'cfg//etc/x'], ['join(repoRoot, "..\\\\x")', '..\\x'], ['join(repoRoot, "C:/x")', 'C:/x'], ['join(repoRoot, "/x")', '/x'], ['join(repoRoot, "a/C:/x")', 'a/C:/x']]) {
    intRefused(call + ' - отказ «разбери руками»', () => intCaseReads(withRoot('join(repoRoot, ".env.test");', call + ';')),
      byHand(4, call.slice(0, call.indexOf('(')) + '(repoRoot, …) с путём ' + JSON.stringify(joined) + ' (обратный слеш, абсолютный сегмент или буква диска)'));
  }
  intRefused('relative(repoRoot, …) вне перечня - отказ «разбери руками»', () => intCaseReads(withRoot('join(repoRoot, ".env.test");', 'relative(repoRoot, "x");')),
    byHand(4, 'repoRoot не первым аргументом join/resolve'));
  intRefused('import { repoRoot as root } - отказ «разбери руками»', () => intCaseReads({ 'vitest/s.ts': 'import { repoRoot as root } from "./selftest-paths.js";\nimport { join } from "node:path";\njoin(root, ".env.test");\n', 'vitest/selftest-paths.ts': 'export const repoRoot = "";\n' }),
    byHand(1, 'repoRoot не первым аргументом join/resolve'));
  {
    const line = 'граф чтений int: модуль из перечня REPO_ROOT_REVIEWED - иное употребление repoRoot не отказ, литеральный join в нём - чтение, попадание записано';
    check(line, intGuard(line, () => {
      const reviewed = { [S('vitest/s.ts')]: 'кейс' };
      const walk = intCaseWalk(withRoot('join(repoRoot, ".env.test");', 'relative(repoRoot, "x");', 'resolve(repoRoot, dir);'), {}, {}, reviewed);
      if (!walk.reads.some((r) => r.file === '.env.test' && r.kind === 'fixture')) return 'литеральный join модуля перечня не в чтениях: ' + JSON.stringify(walk.reads.map((r) => r.file));
      return walk.reviewedHit.has(S('vitest/s.ts')) || 'попадание модуля перечня не записано';
    }));
  }
  {
    // запись перечня, которую обход настоящего дерева не встретил, - красная: устаревшая запись
    // молча разрешала бы новое употребление repoRoot в своём модуле
    const line = 'граф чтений int: перечень REPO_ROOT_REVIEWED - у каждой записи причина, каждую встретил обход настоящего дерева (проба отказа - запись без попадания)';
    check(line, intGuard(line, () => {
      const noWhy = Object.entries(REPO_ROOT_REVIEWED).filter(([, why]) => typeof why !== 'string' || !why).map(([mod]) => mod);
      if (noWhy.length) return 'запись без причины: ' + noWhy.join(', ');
      const hit = liveIntWalk().reviewedHit;
      const missed = (keys) => keys.filter((mod) => !hit.has(mod));
      const stale = missed(Object.keys(REPO_ROOT_REVIEWED));
      if (stale.length) return 'запись перечня без попадания в обходе настоящего дерева: ' + stale.join(', ');
      const planted = S('selftest-never.ts');
      return missed(Object.keys(REPO_ROOT_REVIEWED).concat(planted)).join() === planted || 'запись без попадания не названа - сверка слепа';
    }));
  }
  // Р2 техлида E0-12T: join '.env' - не чтение по JOINED_NOT_READ (точное имя, не маска:
  // '.env.local' - уже чтение и проверка наличия); второй файл окружения (.env.int - TECH_DEBT
  // 11.10.2026 E0-02A круг 3, `intProbeReads`) - чтение наравне с .env.test; setup без
  // testEnvFilePath законен, если фикстура есть где-то в обходе.
  {
    const line = 'граф чтений int: join(repoRoot, ".env") - не чтение (JOINED_NOT_READ с причиной), ".env.local" - не под исключением, второй файл окружения .env.int - чтение';
    check(line, intGuard(line, () => {
      if (typeof JOINED_NOT_READ['.env'] !== 'string' || !JOINED_NOT_READ['.env']) return 'у JOINED_NOT_READ[".env"] нет причины';
      const joins = (...names) => withRoot(...names.map((n) => 'join(repoRoot, "' + n + '");'));
      const files = intCaseReads(joins('.env', '.env.test', '.env.int'), {}, { '.env.int': 'X=1\n' }).map((r) => r.file);
      if (files.includes('.env')) return '.env попал в чтения: ' + JSON.stringify(files);
      if (!files.includes('.env.test') || !files.includes('.env.int')) return '.env.test и .env.int не оба в чтениях: ' + JSON.stringify(files);
      const local = refusalVerdict(() => intCaseReads(joins('.env.test', '.env.local')), 'фикстуры .env.local (join(repoRoot, …) в ' + G.STUB_DIR + '/vitest/s.ts) нет в корне');
      if (local !== true) return '.env.local: ' + local;
      return { note: '.env - ' + JOINED_NOT_READ['.env'] };
    }));
  }
  // Ответ дочернего vitest по стабу (TECH_DEBT 11.10.2026 E0-02A круг 3 «-c и путь в кавычках»):
  // конфиг и setup стаба - пути стаба; globalSetup не исполнен; кавычки и --root разобраны.
  const stubEntry = (dir) => ({ name: stubName(), config: S(dir + 'vitest.selftest.config.mjs'), setupFiles: [S(dir + 'vitest/selftest-setup.ts')], globalSetup: [S(dir + 'vitest/selftest-global.mjs')] });
  const stubLine = (name, fn) => {
    const line = 'граф чтений int: дочерний vitest - ' + name;
    check(line, intGuard(line, fn));
  };
  stubLine('конфиг, setupFiles и globalSetup стаба на месте', () => {
    const want = JSON.stringify(stubEntry(''));
    return JSON.stringify(intProbeStubBase().entry) === want || 'ожидалось ' + want + ', получено ' + JSON.stringify(intProbeStubBase().entry);
  });
  stubLine('globalSetup при чтении конфига не исполнен (меток стаба нет)', () => {
    const ran = intProbeStubBase().globalRan;
    return !ran.length || 'globalSetup стаба исполнился при чтении конфига: метки ' + ran.join(', ');
  });
  stubLine('-c "конфиг" и -c \'конфиг\' (и с пробелом в имени) - один конфиг стаба', () => {
    const e = intProbeStubBase().entries;
    const spaced = Object.assign(stubEntry(''), { config: S('vitest space.config.mjs') });
    const want = { quoted: stubEntry(''), spacedDouble: spaced, spacedSingle: spaced };
    const bad = Object.keys(want).filter((k) => JSON.stringify(e[k]) !== JSON.stringify(want[k])).map((k) => INT_STUB_PAIRS[k] + ': ' + JSON.stringify(e[k]));
    return !bad.length || bad.join('; ');
  });
  stubLine('--root: конфиг и setupFiles разрешены от корня из флага, как у настоящего запуска', () => {
    const want = JSON.stringify({ name: stubName(), config: S('rooted/vitest.selftest.config.mjs'), setupFiles: [S('rooted/vitest/rooted-setup.ts')], globalSetup: [S('rooted/vitest/rooted-global.mjs')] });
    return JSON.stringify(intProbeStubBase().entries.rooted) === want || 'ожидалось ' + want + ', получено ' + JSON.stringify(intProbeStubBase().entries.rooted);
  });
}

/**
 * Ветки ответа дочернего vitest на боевом пути startVitest/awaitVitest (fail-closed, L-028):
 * поддельный ребёнок - node-скрипт во временном каталоге, с той же строкой выхода, что у
 * selftest-vitest.mjs; не запустившийся процесс - программа, которой нет. Все стартуют разом и
 * ждутся по очереди (один раз за прогон, fakeVitest); каталог снимается после ответов. Ответ по
 * ключу - { value, ms } или { error, ms, pid } (ms - сколько ждал awaitVitest). Короткий предел
 * FAKE_VITEST_TIMEOUT_MS - только у ребёнка, который не отвечает никогда (FAKE_TIMEOUT_KEYS): у
 * прочих - боевой VITEST_TIMEOUT_MS, иначе старт десятка процессов разом на занятой машине дал бы
 * ложное «не ответил» (замечание ревью C9 E0-12T).
 */
const FAKE_VITEST_TIMEOUT_MS = 500;
const FAKE_TIMEOUT_KEYS = ['hang'];
const FAKE_PAIRS = [['/a', 'vitest run --config x.ts']];
const FAKE_EXIT = 'process.on("exit", (c) => process.stdout.write("' + VITEST_EXIT_MARK + '" + c + "\\n"));\n';
const FAKE_VITEST = {
  code1: FAKE_EXIT + 'process.stderr.write("boom\\n");\nprocess.exitCode = 1;\n',
  empty: FAKE_EXIT,
  notJson: FAKE_EXIT + 'process.stdout.write("' + VITEST_MARK + '{oops\\n");\n',
  count: FAKE_EXIT + 'process.stdout.write("' + VITEST_MARK + '[]\\n");\n',
  foreign: FAKE_EXIT + 'process.stdout.write(' + JSON.stringify(VITEST_MARK + JSON.stringify([{ dir: '/b', config: '/b/x.ts', setupFiles: [], globalSetup: [] }]) + '\n') + ');\n',
  hang: 'setInterval(() => {}, 1000);\n',
  // строка выхода без целого кода (обрезанная, с хвостом) - отказ, а не код 0
  exitEmpty: 'process.stdout.write("' + VITEST_EXIT_MARK + '\\n");\n',
  exitText: 'process.stdout.write("' + VITEST_EXIT_MARK + '1x\\n");\n',
  ok: FAKE_EXIT + 'process.stdout.write(' + JSON.stringify(VITEST_MARK + JSON.stringify([{ dir: '/a', config: '/a/x.ts', setupFiles: ['/a/s.ts'], globalSetup: [] }]) + '\n') + ');\n',
};
let fakeVitestMemo = null;
function fakeVitest() {
  if (fakeVitestMemo) return fakeVitestMemo;
  const dir = tempDir('vitest-fake');
  const runs = {};
  try {
    const sub = (key) => {
      const d = path.join(dir, key);
      fs.mkdirSync(d);
      return d;
    };
    for (const [key, body] of Object.entries(FAKE_VITEST)) {
      const d = sub(key);
      fs.writeFileSync(path.join(d, 'child.js'), body);
      runs[key] = startVitest(FAKE_PAIRS, d, { child: path.join(d, 'child.js'), timeoutMs: FAKE_TIMEOUT_KEYS.includes(key) ? FAKE_VITEST_TIMEOUT_MS : undefined });
    }
    runs.noSpawn = startVitest(FAKE_PAIRS, sub('noSpawn'), { bin: 'sf-selftest-no-node' });
    const out = {};
    for (const [key, h] of Object.entries(runs)) {
      const t0 = performance.now();
      try {
        out[key] = { value: awaitVitest(h), ms: performance.now() - t0 };
      } catch (e) {
        out[key] = { error: (e && e.message) || String(e), ms: performance.now() - t0, pid: h.child.pid };
      }
    }
    fakeVitestMemo = out;
    return out;
  } finally {
    releaseTemp(dir);
  }
}
/** Вердикт кейса отказа по ответу fakeVitest()[key]: ровно want или строка с полученным. */
function fakeRefused(key, want) {
  const r = fakeVitest()[key];
  if (r.error === undefined) return 'отказа нет, ожидалось «' + want + '»; ответ ' + JSON.stringify(r.value);
  return r.error === want || 'ожидалось «' + want + '», получено «' + r.error + '»';
}
{
  const what = 'selftest-vitest.mjs';
  const line = (name) => 'граф чтений int: ответ vitest (startVitest/awaitVitest) - ' + name;
  check(line('законный ответ разобран'), () => {
    const r = fakeVitest().ok;
    const want = JSON.stringify([{ dir: '/a', config: '/a/x.ts', setupFiles: ['/a/s.ts'], globalSetup: [] }]);
    return (r.error === undefined && JSON.stringify(r.value) === want) || 'получено ' + JSON.stringify(r);
  });
  check(line('вышел с кодом 1 - отказ с кодом и stderr'), () => fakeRefused('code1', what + ': код 1: boom'));
  check(line('stdout без строки ответа - отказ'), () => fakeRefused('empty', what + ': в stdout не ровно одна строка «selftest-vitest <JSON>»: ' + JSON.stringify(VITEST_EXIT_MARK + '0\n')));
  check(line('ответ не JSON - отказ'), () => {
    let why = '';
    try {
      JSON.parse('{oops');
    } catch (e) {
      why = e.message;
    }
    return fakeRefused('notJson', what + ': ответ не JSON (' + why + ')');
  });
  check(line('ответ не по числу пар - отказ'), () => fakeRefused('count', what + ': ответ не массив из 1 элементов: []'));
  check(line('элемент чужого каталога - отказ'), () => fakeRefused('foreign', what + ': ответ пары 1 (/a) иной формы: {"dir":"/b","config":"/b/x.ts","setupFiles":[],"globalSetup":[]}'));
  check(line('нет строки выхода за предел - отказ, процесс снят SIGKILL'), () => {
    const verdict = fakeRefused('hang', what + ': не ответил за ' + FAKE_VITEST_TIMEOUT_MS / 1000 + ' с - процесс убит');
    if (verdict !== true) return verdict;
    const pid = fakeVitest().hang.pid;
    return pidGone(pid, VITEST_GONE_MS) || 'процесс ' + pid + ' жив через 2 с после отказа по пределу';
  });
  check(line('программа не запустилась - отказ «не запустился: ENOENT» без ожидания предела'), () => {
    const verdict = fakeRefused('noSpawn', what + ' не запустился: ENOENT');
    if (verdict !== true) return verdict;
    const ms = fakeVitest().noSpawn.ms;
    return ms < 5000 || 'отказ через ' + Math.round(ms) + ' мс - ждал предела';
  });
  // замечание ревью C12 E0-12T: Number('') = 0 сделал бы обрезанную строку выхода успехом
  check(line('строка выхода без кода и с нецелым кодом - отказ «без целого кода»'), () => {
    const bad = [['exitEmpty', ''], ['exitText', '1x']]
      .map(([key, code]) => fakeRefused(key, what + ': строка выхода без целого кода: ' + JSON.stringify(VITEST_EXIT_MARK + code)))
      .filter((v) => v !== true);
    return !bad.length || bad.join('; ');
  });
  // Ветка «pid нет, а повтор той же программы запустился» (замечание ревью C2 E0-12T): подменённые
  // spawn (ребёнок без pid) и spawnSync (повтор без ошибки) - отказ SPAWN_CODE_UNKNOWN сразу, без
  // ожидания предела и без kill процесса, которого нет
  check(line('pid нет, повтор запустился - отказ «не запустился: код ошибки неизвестен» без ожидания предела'), () => {
    const dir = tempDir('vitest-nopid');
    try {
      const killed = [];
      const fake = { pid: undefined, on: () => fake, unref: () => {}, kill: (sig) => killed.push(sig) };
      const t0 = performance.now();
      const h = startVitest(FAKE_PAIRS, dir, { spawn: () => fake, spawnSync: () => ({ status: 0 }), timeoutMs: FAKE_VITEST_TIMEOUT_MS });
      const verdict = refusalVerdict(() => awaitVitest(h), what + ' не запустился: ' + SPAWN_CODE_UNKNOWN);
      if (verdict !== true) return verdict;
      if (killed.length) return 'kill процесса без pid: ' + killed.join(', ');
      if (LIVE_CHILDREN.has(fake)) return 'процесс без pid в LIVE_CHILDREN';
      const ms = performance.now() - t0;
      return ms < FAKE_VITEST_TIMEOUT_MS || 'отказ через ' + Math.round(ms) + ' мс - ждал предела';
    } finally {
      releaseTemp(dir);
    }
  });
  // LIVE_CHILDREN (замечание ревью C3 E0-12T): запущенный без ожидания ребёнок - в наборе до ответа,
  // killLiveChildren снимает его SIGKILL и чистит набор, обработчик exit процесса зовёт её раньше
  // снятия каталогов реестра (TEMP.dropAll). Набор кейса - свой: общий держит дочерний vitest пробы.
  check(line('ребёнок без ответа - в LIVE_CHILDREN, killLiveChildren снимает его до снятия каталогов на exit'), () => {
    const exits = process.listeners('exit');
    const kill = exits.indexOf(killLiveChildrenOnExit);
    if (kill === -1) return 'killLiveChildren не в обработчиках exit';
    if (kill > exits.indexOf(TEMP.dropAll)) return 'killLiveChildren на exit позже TEMP.dropAll';
    const dir = tempDir('vitest-live');
    try {
      fs.writeFileSync(path.join(dir, 'child.js'), FAKE_VITEST.hang);
      const h = startVitest(FAKE_PAIRS, dir, { child: path.join(dir, 'child.js') });
      const had = LIVE_CHILDREN.delete(h.child);
      const own = new Set([h.child]);
      killLiveChildren(own);
      if (!had) {
        h.child.kill('SIGKILL');
        return 'запущенный ребёнок не в LIVE_CHILDREN';
      }
      if (own.size) return 'набор после killLiveChildren не пуст';
      return pidGone(h.child.pid, VITEST_GONE_MS) || 'процесс ' + h.child.pid + ' жив через 2 с после killLiveChildren';
    } finally {
      releaseTemp(dir);
    }
  });
  // Строку выхода пишет обработчик exit ребёнка, процесс ещё жив (замечание ревью E3 E0-12T):
  // awaitVitest ждёт его конца до снятия из LIVE_CHILDREN и каталога. Ребёнок кейса пишет ответ и
  // строку выхода сам и живёт ещё 300 мс - после awaitVitest его нет с первой сверки.
  check(line('строка выхода, процесс ещё жив - awaitVitest ждёт его конца до ответа'), () => {
    const dir = tempDir('vitest-linger');
    try {
      const answer = VITEST_MARK + JSON.stringify([{ dir: '/a', config: '/a/x.ts', setupFiles: [], globalSetup: [] }]) + '\n' + VITEST_EXIT_MARK + '0\n';
      fs.writeFileSync(path.join(dir, 'child.js'), 'process.stdout.write(' + JSON.stringify(answer) + ');\nsetTimeout(() => {}, 300);\n');
      const h = startVitest(FAKE_PAIRS, dir, { child: path.join(dir, 'child.js') });
      try {
        awaitVitest(h);
      } catch (e) {
        return 'ответ ребёнка кейса отвергнут: ' + ((e && e.message) || String(e));
      }
      return pidGone(h.child.pid, 0) || 'процесс ' + h.child.pid + ' жив после ответа awaitVitest';
    } finally {
      releaseTemp(dir);
    }
  });
  // Linux (замечание ревью E1 E0-12T): процесс-зомби (Z в /proc/<pid>/stat) - нет, хотя kill(pid, 0)
  // отвечает; файла stat нет - нет; иное состояние - по kill. Источник подменён, процессов нет.
  check('pidGone: Linux - зомби (Z, имя со скобками и пробелом) и снятый /proc/<pid>/stat - процесса нет, S при живом kill - есть', () => {
    const alive = () => true;
    const linux = (readStat) => pidGone(4242, 0, { platform: 'linux', readStat, kill: alive });
    // нет stat процесса при смонтированном /proc (свой stat читается)
    const enoent = (p) => {
      if (p === 'self') return '1 (node) R 0 1';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const got = [linux(() => '4242 (node (x) y) Z 1 4242'), linux(enoent), linux(() => '4242 (node) S 1 4242')];
    return JSON.stringify(got) === '[true,true,false]' || 'ожидалось [true,true,false] (Z, нет stat, S), получено ' + JSON.stringify(got);
  });
  // Решение техлида (круг 3): иная ошибка kill/readStat - «жив», а не исключение поверх готового
  // ответа; ENOENT без читаемого /proc/self/stat (/proc не смонтирован) - не «нет», ветка kill
  check('pidGone: kill и readStat с EACCES - «жив» без исключения; ENOENT на всё (/proc нет) при живом kill - «жив»', () => {
    const fail = (code) => () => {
      throw Object.assign(new Error(code), { code });
    };
    let got;
    try {
      got = [
        pidGone(4242, 0, { platform: 'win32', kill: fail('EACCES') }),
        pidGone(4242, 0, { platform: 'linux', readStat: fail('EACCES'), kill: () => true }),
        pidGone(4242, 0, { platform: 'linux', readStat: fail('ENOENT'), kill: () => true }),
      ];
    } catch (e) {
      return 'исключение вместо «жив»: ' + ((e && e.message) || String(e));
    }
    return JSON.stringify(got) === '[false,false,false]' || 'ожидалось [false,false,false] (kill EACCES, stat EACCES, нет /proc), получено ' + JSON.stringify(got);
  });
  // Решение техлида (круг 3): ребёнок, не вышедший за goneMs после строки выхода, снимается SIGKILL
  // до снятия из LIVE_CHILDREN; goneMs 0 - без ожидания
  check(line('строка выхода, процесс не вышел за goneMs - снят SIGKILL'), () => {
    const dir = tempDir('vitest-stuck');
    try {
      const answer = VITEST_MARK + JSON.stringify([{ dir: '/a', config: '/a/x.ts', setupFiles: [], globalSetup: [] }]) + '\n' + VITEST_EXIT_MARK + '0\n';
      fs.writeFileSync(path.join(dir, 'child.js'), 'process.stdout.write(' + JSON.stringify(answer) + ');\nsetTimeout(() => {}, 1000);\n');
      const h = startVitest(FAKE_PAIRS, dir, { child: path.join(dir, 'child.js'), goneMs: 0 });
      try {
        awaitVitest(h);
      } catch (e) {
        return 'ответ ребёнка кейса отвергнут: ' + ((e && e.message) || String(e));
      }
      const killed = h.child.killed;
      pidGone(h.child.pid, VITEST_GONE_MS);
      return killed === true || 'процесс ' + h.child.pid + ' не снят SIGKILL после строки выхода';
    } finally {
      releaseTemp(dir);
    }
  });
}
// Ветки самого selftest-vitest.mjs, которые harness-selftest.js не вызывает: нечётное число
// аргументов (до загрузки vitest) и vitest/node, который не грузится (копия модуля и его lib.js вне
// репозитория, где пакета vitest нет), - ошибка каждой пары в JSON, выход с кодом 0.
check('selftest-vitest.mjs: нечётное число аргументов - ошибка пары в ответе, без загрузки vitest', () => {
  const r = run(process.execPath, [VITEST_CHILD, 'a', 'b', 'c'], { cwd: ROOT, timeout: 30000, killSignal: 'SIGKILL' });
  const want = VITEST_MARK + JSON.stringify([{ dir: 'a', error: 'аргументы - не пары <dir> <command>: 3 слов' }]);
  const got = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith(VITEST_MARK));
  return (r.status === 0 && got === want) || 'код ' + r.status + ', строка ' + JSON.stringify(got) + ', ожидалась ' + JSON.stringify(want);
});
check('selftest-vitest.mjs: vitest/node не загрузился - ошибка каждой пары в ответе, код 0', () => {
  const dir = tempDir('vitest-alone');
  try {
    const copy = path.join(dir, 'selftest-vitest.mjs');
    fs.copyFileSync(VITEST_CHILD, copy);
    // модуль берёт isNotFile из соседнего lib.js
    fs.copyFileSync(path.join(HOOKS, 'lib.js'), path.join(dir, 'lib.js'));
    const r = run(process.execPath, [copy, 'a', 'vitest run -c x.ts', 'b', 'vitest run -c y.ts'], { cwd: dir, timeout: 30000, killSignal: 'SIGKILL' });
    const got = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith(VITEST_MARK));
    let out = null;
    try {
      out = JSON.parse(String(got).slice(VITEST_MARK.length));
    } catch (_) {
      // строки ответа нет или она не JSON - отказ ниже
    }
    const prefix = 'vitest/node не загрузился: ';
    const ok = r.status === 0 && Array.isArray(out) && out.length === 2 && out.every((x, i) => x.dir === ['a', 'b'][i] && typeof x.error === 'string' && x.error.startsWith(prefix));
    return ok || 'код ' + r.status + ', ответ ' + JSON.stringify(got) + ' ' + String(r.stderr || '').slice(0, 160);
  } finally {
    releaseTemp(dir);
  }
});

// Пробы графа build и test:int читают не только .claude/**, но и файлы проекта: то, из чего
// turbo строит граф (корневые package.json, pnpm-workspace.yaml, turbo.json и turbo.jsonc;
// package.json, turbo.json и turbo.jsonc каждого пакета и нового пакета по каждому шаблону
// pnpm-workspace.yaml - graphSources), и входы пробы test:int (INT_PROBE_INPUT_KINDS и
// INT_PROBE_STATIC: конфиги, setupFiles, globalSetup, модули с join(repoRoot, …), фикстуры,
// vitest.preset.ts, test/imports.ts). Гейт самопроверки обязан выбираться на каждом из них, иначе
// устаревший glob build или test:int уйдёт молча (docs/DECISIONS.md, 11.10.2026, E0-02A; E0-12L,
// 21.10.2026; Р1 техлида E0-12T). Транзитивные модули обхода int и входы задач turbo (исходники
// пакетов) самопроверку не выбирают: их сверяют с glob test:int и build сами пробы этих гейтов;
// новый join(repoRoot, …) в глубине модуля ловит прогон selftest в CI. next.config.* ни одна
// проба не читает (граф сборки - у turbo), на нём самопроверка не выбирается. Боевые формы роута
// (ROUTE_FORMS) читают пробы S14 и пропуска standards в модуле роута - их сверка здесь же (E0-12D).
/**
 * Близнец workspaceGlobs (Р4 техлида E0-12T) - под intGuard (int): require(esm) manifest.mjs -
 * та же граница Node, что у require test/imports.ts (IMPORTS_GATE), а не граф turbo (замечание
 * ревью E6 E0-12T: под одним GRAPH_GATE на Node ниже границы - лишняя красная ERR_REQUIRE_ESM).
 */
const WORKSPACE_TWIN_PROBE = {
  // Р4 техлида E0-12T: шаблоны workspace пробы (workspacePatterns, пакет yaml) - близнец
  // workspaceGlobs из scripts/lib/manifest.mjs (ручной разбор): на настоящем
  // pnpm-workspace.yaml они равны, текст без packages: оба отвергают. На flow-списке
  // (`packages: [...]`) расхождение известно: workspaceGlobs бросает, workspacePatterns отдаёт
  // список (TECH_DEBT 23.10.2026 E0-12T «workspaceGlobs - ручной разбор YAML»); кейс фиксирует
  // его, а не красит; изменилось - строка красная с просьбой снять строку долга.
  name: 'шаблоны workspace пробы (workspacePatterns, yaml) - как workspaceGlobs из scripts/lib/manifest.mjs: равны на pnpm-workspace.yaml, оба отвергают текст без packages:, расхождение на flow-списке - известное',
  int: true,
  fn: () => {
    const { workspaceGlobs } = require(path.join(ROOT, 'scripts', 'lib', 'manifest.mjs'));
    const text = fs.readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
    const outcome = (fn, t) => {
      try {
        return JSON.stringify(fn(t));
      } catch (_) {
        return 'отказ';
      }
    };
    const both = (t) => [outcome(workspaceGlobs, t), outcome(G.workspacePatterns, t)];
    const [real1, real2] = both(text);
    if (real1 !== real2) return 'pnpm-workspace.yaml: workspaceGlobs ' + real1 + ', workspacePatterns ' + real2;
    const none = both('onlyBuiltDependencies:\n  - esbuild\n');
    if (none.join() !== 'отказ,отказ') return 'текст без packages: - workspaceGlobs ' + none[0] + ', workspacePatterns ' + none[1] + ' (ожидался отказ обоих)';
    const flow = both('packages: ["apps/*"]\n');
    if (flow.join() !== 'отказ,["apps/*"]') return 'flow-список: известное расхождение изменилось (workspaceGlobs ' + flow[0] + ', workspacePatterns ' + flow[1] + ') - сверь и сними строку TECH_DEBT «workspaceGlobs - ручной разбор YAML»';
    return { note: real1 };
  },
};
check('гейт harness-selftest: близнец workspaceGlobs (require(esm) manifest.mjs) - под intGuard, как test/imports.ts', () =>
  WORKSPACE_TWIN_PROBE.int === true || 'близнец не int - на Node ниже границы require(esm) он красный вместо SKIPPED');
checkGateSelection('harness-selftest', {
  runWhat: '.claude/**, файлах, из которых turbo строит граф, входах пробы test:int и путях из note вне when',
  skipWhat: 'исходниках, lockfile, next.config.*, .env, docs и путях из when и cmd гейтов-владельцев note',
  mustRun: [
    '.claude/hooks/gates.js',
    '.claude/hooks/rules.sf.json',
    '.claude/hooks/selftest-graph.js',
    '.claude/hooks/selftest-vitest.mjs',
    '.claude/hooks/selftest-temp.js',
    '.claude/agents/worker.md',
    'package.json',
    'apps/web/package.json',
    'apps/api/package.json',
    'packages/core/package.json',
    'packages/integrations/youtube/package.json',
    'pnpm-workspace.yaml',
    'turbo.json',
    'turbo.jsonc',
    'packages/db/turbo.json',
    'packages/db/turbo.jsonc',
    'apps/api/turbo.json',
    'apps/web/turbo.json',
    // новый пакет по шаблону workspace (graphSources): без модуля графа имени нет, и строка
    // модуля уже красная
    ...(G ? ['apps/' + G.NEW_SIBLING + '/package.json', 'packages/integrations/' + G.NEW_SIBLING + '/turbo.json', 'apps/' + G.NEW_SIBLING + '/turbo.jsonc'] : []),
    'apps/api/vitest.int.config.ts',
    'apps/worker/vitest.int.config.ts',
    'packages/db/vitest.int.config.ts',
    'packages/config/src/paths.ts',
    'packages/config/vitest/setup.ts',
    'packages/db/test-support/entry-check/postgres.ts',
    'packages/db/test-support/entry-check/migrated-stack.ts',
    'vitest.preset.ts',
    'test/imports.ts',
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
    // проба-близнец workspacePatterns грузит его (Р4 техлида E0-12T), как files.mjs - близнец trackedFiles
    'scripts/lib/manifest.mjs',
    'apps/api/.env.test',
    // join(repoRoot, ".env") - не чтение (JOINED_NOT_READ, Р2 техлида E0-12T)
    '.env',
    'apps/api/vitest.config.ts',
    // транзитивные модули обхода int - под glob test:int, не входы пробы (Р1 техлида E0-12T)
    'packages/config/src/index.ts',
    'packages/config/src/env-file.ts',
    'packages/db/src/index.ts',
    'packages/db/test-support/fixture.ts',
    'test/imports.test.ts',
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
    'docs/turbo.jsonc',
    'xapps/api/turbo.json',
    'docs/apps/api/turbo.json',
  ],
  extra: [
    {
      // notePathsOnDisk сверяет эти пути с диском: переименование такого файла должно
      // выбирать самопроверку локально, а не краснеть только в CI (E0-12F). Путь из when
      // или cmd гейта-владельца note самопроверку не выбирает (решение техлида к кругу 3).
      name: 'его выбирает каждый путь из note гейтов ' + NOTE_SELECTING_GATES.join(' и ') + ' вне их when и cmd',
      fn: ({ runs }) => {
        const named = NOTE_SELECTING_GATES.flatMap((id) => {
          const owner = gateProbe(id);
          return notePaths(owner.gate).filter((f) => !owner.runs(f) && !String(owner.gate.cmd || '').includes(f));
        });
        if (!named.length) return 'в note гейтов ' + NOTE_SELECTING_GATES.join(' и ') + ' нет ни одного пути вне их when и cmd';
        const stray = named.filter((f) => !runs(f));
        if (stray.length) return 'пути из note вне glob harness-selftest: ' + stray.join(', ');
        return { note: named.length + ' путей' };
      },
    },
    {
      name: 'его выбирает каждая боевая форма роута, которую читают пробы S14 и пропуска standards',
      fn: ({ runs }) => {
        const stray = ROUTE_FORMS.filter((f) => !runs(f));
        if (stray.length) return 'пробы S14 и пропуска standards читают вне glob harness-selftest: ' + stray.join(', ');
        return { note: ROUTE_FORMS.length + ' файла' };
      },
    },
    {
      // Файл графа вне glob (пакет по шаблону tools/* в pnpm-workspace.yaml, turbo.json пакета)
      // меняет граф turbo, и без этой сверки его правка самопроверку не запускала бы (E0-12L;
      // TECH_DEBT, строки 11.10.2026 E0-01A «when harness-selftest знает только apps/**,
      // packages/**» и 11.10.2026 E0-02A «workspacePackages: шаблоны вне apps/, packages/»).
      // Новый пакет по каждому шаблону workspace (graphSources) - и по шаблону без единого
      // пакета - требует glob на шаблон каталога, а не на перечень сегодняшних пакетов.
      // Детектор: стаб-пакет и стаб-шаблон G.STUB_PATTERN дают свои G.STUB_SOURCES.
      name: 'его выбирает каждый файл, из которого turbo строит граф (корневые package.json, pnpm-workspace.yaml, turbo.json, turbo.jsonc; package.json, turbo.json и turbo.jsonc каждого пакета dry и нового пакета по каждому шаблону workspace)',
      graph: true,
      fn: ({ gate, runs }) => {
        const { dry, patterns } = GRAPH_GATE.snap;
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
      // Р1 техлида E0-12T: входы пробы test:int (виды INT_PROBE_INPUT_KINDS и INT_PROBE_STATIC)
      // выбирают самопроверку; транзитивные модули обхода обязаны быть под glob test:int (иначе
      // их правка не выбирает ни тот гейт, ни этот). Детектор - стаб int-пробы: его входы вне glob.
      name: 'его выбирает каждый вход пробы test:int (конфиги --config, setupFiles, globalSetup, модули с join(repoRoot, …), фикстуры, манифесты exports, vitest.preset.ts, test/imports.ts); транзитивные модули обхода - под glob test:int',
      int: true,
      fn: ({ gate, runs }) => {
        const reads = liveIntReads();
        const inputs = reads.filter((r) => r.input).concat(INT_PROBE_STATIC.map((file) => ({ file, why: 'вход пробы test:int' })));
        const bad = G.outsideGlob(runs, inputs);
        if (bad.length) return G.refusal('проба test:int читает', gate.id, bad);
        const intRuns = gateProbe('test:int').runs;
        const deep = G.outsideGlob(intRuns, reads.filter((r) => !r.input));
        if (deep.length) return 'транзитивные модули обхода int-наборов вне glob test:int: ' + deep.join(', ') + ' - расширь glob test:int';
        const base = intProbeStubBase();
        const under = stubUnderGlob(runs, gate.id, base.files);
        if (under) return under;
        const stubInputs = intProbeReads([base.entry], GRAPH_GATE.snap.ws, base.src, IMPORTS_GATE.snap).filter((r) => r.input);
        if (!G.outsideGlob(runs, stubInputs).some((b) => b.startsWith(base.expect + ' '))) return 'проба не замечает вход ' + base.expect + ' вне glob ' + gate.id + ' на стабе';
        return { note: inputs.length + ' входов, ' + (reads.length - reads.filter((r) => r.input).length) + ' транзитивных модулей' };
      },
    },
    WORKSPACE_TWIN_PROBE,
    {
      // Р5 техлида E0-12T (TECH_DEBT 21.10.2026 E0-12L круг 4, peer-only workspace-зависимость): workspace:-пакет только в peerDependencies turbo
      // не упорядочивает - ребра нет, а сверка с манифестами (DEP_FIELDS) его не видит.
      name: 'ни у одного пакета dry workspace:-зависимости только в peerDependencies (без дубля в dependencies/devDependencies/optionalDependencies)',
      graph: true,
      fn: () => {
        const ws = GRAPH_GATE.snap.ws;
        const bad = G.peerOnly(ws);
        if (bad.length) return bad.join('; ');
        return { note: Object.keys(ws).length + ' манифестов' };
      },
    },
  ],
});

// Последняя строка графа: отказ снимка (dry-JSON, манифесты, шаблоны workspace, tracked - git ls-files
// с файлами на диске; сбой git ls-files или stat файла - тоже здесь) называется здесь один раз,
// с перечнем проб графа, которые без него не гонялись (snapshotGate).
check('граф turbo: dry-JSON настоящего дерева (turbo run ' + GRAPH_SCRIPTS.join(' ') + ' --dry=json)', () => graphVerdict(GRAPH_GATE));
// Строка модуля разбора импортов: граница Node или сбой require test/imports.ts - здесь один раз,
// с перечнем проб, которые без модуля не гонялись.
check('test/imports.ts: require .ts (Node 22.18+, 23.6+ или 24+) для пробы test:int', () => gateVerdict(IMPORTS_GATE, () => 'Node ' + process.version));

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
 * пробе сверки дерева: init без шаблонов (`--template=`), коммит через git(…, { isolated }) -
 * core.hooksPath на пустой каталог, без подписи и fsmonitor. Иначе глобальный pre-commit красит
 * пробу или исполняется в ней.
 */
check('commit-gate: isBootstrap - true без коммитов, false после первого', () => {
  const { isBootstrap } = require('./commit-gate.js');
  const tmp = tempDir('boot');
  const env = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@x', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@x' });
  const inTmp = (args) => gitStrict(args, { cwd: tmp, env, isolated: true });
  try {
    inTmp(['init', '-q', '--template=', '-b', 'main']);
    if (!isBootstrap(tmp)) return 'репозиторий без коммитов не опознан как bootstrap';
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'a');
    inTmp(['add', 'a.txt']);
    inTmp(['commit', '-q', '-m', 'chore: init']);
    if (isBootstrap(tmp)) return 'репозиторий с коммитом всё ещё bootstrap';
    return true;
  } finally {
    releaseTemp(tmp);
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
 * Крах standards.js - красный на обеих сторонах, как в standardsCases: код вне 0/2 или HOOK_ERROR
 * (крах внутри L.guard - код 0, и только строка HOOK_ERROR отличает его от пропуска). Вердикт по
 * ответам хука src и test - runtimeStandardsVerdict; его ветки краха сверяют кейсы на подменённых
 * ответах (TECH_DEBT 19.10.2026 E0-12D круг 6, проба standards runtime): строка называет крах, а
 * не «не пойманы».
 */
function runtimeStandardsVerdict(src, test) {
  if (src.err.includes(HOOK_ERROR)) return 'src: standards.js упал внутри guard - ' + src.err.slice(0, 160);
  if (src.code !== 2 || !/S03/.test(src.err) || !/S05/.test(src.err)) return 'console/process.env в src не пойманы: код ' + src.code + ' ' + src.err.slice(0, 160);
  if (test.code !== 0 && test.code !== 2) return 'тест пакета: standards.js упал, код ' + test.code + ' ' + test.err.slice(0, 160);
  if (test.err.includes(HOOK_ERROR)) return 'тест пакета: standards.js упал внутри guard - ' + test.err.slice(0, 160);
  if (/S03|S05/.test(test.err)) return 'тест пакета получил S03/S05: ' + test.err.slice(0, 160);
  return true;
}
check('standards: console и process.env в packages/runtime/src пойманы, в его test - нет', () => {
  const gone = missingDirs(['packages/runtime/src', 'packages/runtime/test']);
  if (gone) return gone;
  const body = 'export const u = process.env.SF_X;\nconsole.log(u);\n';
  return withScratchTree((tree) => {
    tree.write('packages/runtime/src/zz_selftest_bad.ts', body);
    tree.write('packages/runtime/test/zz_selftest.test.ts', body);
    return runtimeStandardsVerdict(tree.standards('packages/runtime/src/zz_selftest_bad.ts'), tree.standards('packages/runtime/test/zz_selftest.test.ts'));
  });
});
check('standards runtime: крах standards.js внутри guard называется крахом - на src (код 0) и на тесте пакета (код 0)', () => {
  const crash = { code: 0, out: '', err: HOOK_ERROR + ' Error: selftest' };
  const caught = { code: 2, out: '', err: '[S03] console\n[S05] process.env' };
  const clean = { code: 0, out: '', err: '' };
  const got = [runtimeStandardsVerdict(crash, clean), runtimeStandardsVerdict(caught, crash), runtimeStandardsVerdict(caught, clean)];
  const want = ['src: standards.js упал внутри guard - ' + crash.err, 'тест пакета: standards.js упал внутри guard - ' + crash.err, true];
  return JSON.stringify(got) === JSON.stringify(want) || 'ожидалось ' + JSON.stringify(want) + ', получено ' + JSON.stringify(got);
});

/** Текст файла пробы standards: строка line и строка кода после неё - один помощник проб S04, S11, S15, S16. */
function lineFile(line) {
  return line + '\nexport const x = 1;\n';
}

/**
 * Отказ и пропуск одного правила standards на файле rel дерева пробы (L-008). refused / allowed -
 * тексты файлов целиком; отказ - код 2 и [id] в замечаниях, пропуск - код 0 или 2 и ни одного [id].
 * Крах standards.js - красный, а не пропуск: и код вне 0/2, и исключение, пойманное L.guard
 * (код 0, в stderr HOOK_ERROR - см. withScratchTree). Засчитывается
 * только своё правило (L-020): соседнее правило на том же тексте строку не красит и не зеленит.
 * id - строка с id правила или ANY_RULE - любое правило standards: id всех правил
 * rules.common.json и rules.sf.json, прочитанные из самих файлов (W.. и S..), каждый в форме
 * [id], как его печатает standards.js (render); отказ - код 2 и хотя бы один [id], пропуск - ни
 * одного (модуль роута целиком, E0-12P), одна петля на оба случая. Пустой список id - красная
 * проба: предикату, которому не с чем сверять, прошло бы любое тело.
 */
const ANY_RULE = { label: 'любое правило', ids: standardsIds };
/** id правил standards обоих файлов правил, как они записаны; файл, что не разобрался, - пуст. */
function standardsIds() {
  return [].concat((common && common.standards) || [], (repoRules && repoRules.standards) || [])
    .map((rule) => rule && rule.id)
    .filter((id) => typeof id === 'string' && id !== '');
}
function standardsCases(rule, rel, refused, allowed) {
  const id = typeof rule === 'string' ? rule : rule.label;
  const ids = typeof rule === 'string' ? [rule] : rule.ids();
  if (!ids.length) return id + ': ни одного id правила standards в rules.common.json и rules.sf.json - сверять не с чем';
  const named = (err) => ids.some((one) => err.includes('[' + one + ']'));
  return withScratchTree((tree) => {
    for (const body of refused) {
      tree.write(rel, body);
      const r = tree.standards(rel);
      if (r.err.includes(HOOK_ERROR)) return id + ' на запрещённом: standards.js упал внутри guard - ' + r.err.slice(0, 160);
      if (r.code !== 2 || !named(r.err)) return 'не пойман ' + id + ': ' + JSON.stringify(body.slice(0, 120)) + ' - код ' + r.code + ' ' + r.err.slice(0, 160);
    }
    for (const body of allowed) {
      tree.write(rel, body);
      const r = tree.standards(rel);
      if (r.code !== 0 && r.code !== 2) return id + ' на разрешённом: standards.js упал, код ' + r.code + ' ' + r.err.slice(0, 160);
      if (r.err.includes(HOOK_ERROR)) return id + ' на разрешённом: standards.js упал внутри guard - ' + r.err.slice(0, 160);
      if (named(r.err)) return id + ' на разрешённом: ' + JSON.stringify(body.slice(0, 120)) + ' - ' + r.err.slice(0, 160);
    }
    return { note: refused.length + ' отказ, ' + allowed.length + ' пропуск' };
  });
}

/**
 * S04 держит ту же границу, что гейт no-search-list (Б1/Б12 ревью E0-12N, К2-1 круга 2): правило
 * одно - scripts/lib/search-list.mjs. Хук видит строку, а не файл, поэтому пропуск - только
 * строчный комментарий // с меткой `no-search-list: allowed` и без того, что может закончить
 * комментарий раньше конца строки (звезда со слешем, обратная кавычка, {, < - тег в тексте JSX
 * (К3-3), кавычки, одиночный CR, U+2028, U+2029). Строка с вызовом краснеет со словом never/NEVER/запрещ, с меткой после кода,
 * в строковом литерале, после закрытия блочного комментария в голове строки, после /*-слеша,
 * на строке-продолжении со звездой (умножение), на строке блочного комментария, в комментарии
 * без метки; CRLF - та же граница. Каждый отказ - своя строка refused: проба возвращает первый
 * провал, и откат одной ветки ALLOWED краснеет на своём кейсе. Файлы - любой исходник дерева,
 * не только apps/packages/scripts. Вызов собран из частей: этот файл сканирует сам гейт.
 */
check('standards: S04 - вызов search пойман и со словом never, и с меткой после кода; пропуск - только строчный комментарий // с меткой', () => {
  const gone = missingDirs(['packages/integrations/youtube/src']);
  if (gone) return gone;
  const call = ['youtube', 'search', 'list'].join('.');
  const endpoint = ['', 'youtube', 'v3', 'search'].join('/');
  const mark = 'no-search-list: allowed';
  const crlf = (line) => line + '\r\nexport const x = 1;\r\n';
  const cr = String.fromCharCode(13);
  const ls = String.fromCharCode(0x2028);
  const ps = String.fromCharCode(0x2029);
  const refused = [
    'await ' + call + '({}); // never in production',
    'await ' + call + '({}); // NEVER',
    'const url = "https://www.googleapis.com' + endpoint + '"; // запрещён',
    'await ' + call + '({}); // see check-no-search-list',
    'await ' + call + '({}); // ' + mark,
    'const why = "// ' + mark + '"; await ' + call + '({});',
    '/* x */ await ' + call + '({}); // ' + mark,
    ' * x */ await ' + call + '({}); // ' + mark,
    '*/ await ' + call + '({}); // ' + mark,
    '/*/ ' + call + '({}) // ' + mark,
    '  * (await ' + call + '({})).data; // ' + mark,
    ' * never ' + call + ' (100 units)',
    ' * never ' + call + ' (100 units) (' + mark + ')',
    '/** never ' + call + ' - ' + mark + ' */',
    '// x */ ' + call + '(); ' + mark,
    '// ` + ' + call + '() + ` ' + mark,
    '// {' + call + '({})} ' + mark,
    '// <' + call + ' /> ' + mark,
    '// </p>; void ' + call + '(); // ' + mark,
    '// " + ' + call + '() + " ' + mark,
    "// ' + " + call + "() + ' " + mark,
    '// ' + mark + cr + 'await ' + call + '();',
    '// ' + mark + ls + 'await ' + call + '();',
    '// ' + mark + ps + 'await ' + call + '();',
  ].map(lineFile).concat([crlf('await ' + call + '({}); // ' + mark)]);
  const allowed = [
    '// never ' + call + ' - ' + mark,
    '    // never ' + call + ' - ' + mark,
    'export const y = 1; // ' + mark,
    'await playlistItems.list({});',
  ].map(lineFile).concat([crlf('// never ' + call + ' - ' + mark)]);
  const own = standardsCases('S04', 'packages/integrations/youtube/src/zz_selftest_s04.ts', refused, allowed);
  if (own !== true && typeof own !== 'object') return own;
  for (const rel of ['tools/zz_selftest_s04.mjs', 'test/zz_selftest_s04.test.ts', '.claude/hooks/zz_selftest_s04.js', 'zz_selftest_s04.config.cts']) {
    const other = standardsCases('S04', rel, [lineFile('await ' + call + '({});')], [lineFile('// never ' + call + ' - ' + mark)]);
    if (other !== true && typeof other !== 'object') return rel + ': ' + other;
  }
  return own;
});

/**
 * S04 на отслеживаемом файле с концами строк CRLF: хук берёт строки из git diff, и каждая
 * добавленная строка несёт CR (новый файл он читает с диска и режет по CRLF - там CR нет).
 * //-строка с меткой пропускается и с CR в конце, вызов с меткой после кода - отказ. Репозиторий
 * пробы - без шаблонов, хуков git и autocrlf машины (как в пробе isBootstrap).
 */
check('standards: S04 на отслеживаемом файле с CRLF - //-строка с меткой пропущена, вызов пойман', () => {
  const gone = missingDirs(['packages/integrations/youtube/src']);
  if (gone) return gone;
  const call = ['youtube', 'search', 'list'].join('.');
  const mark = 'no-search-list: allowed';
  const rel = 'packages/integrations/youtube/src/zz_selftest_s04_crlf.ts';
  const env = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@x', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@x' });
  return withScratchTree((tree) => {
    const inTree = (args) => gitStrict(['-c', 'core.autocrlf=false'].concat(args), { cwd: tree.dir, env, isolated: true });
    tree.write(rel, 'export const x = 1;\n');
    inTree(['init', '-q', '--template=', '-b', 'main']);
    inTree(['config', 'core.autocrlf', 'false']);
    inTree(['add', rel]);
    inTree(['commit', '-q', '-m', 'chore: init']);
    tree.write(rel, '// never ' + call + ' - ' + mark + '\r\nexport const x = 1;\r\n');
    const passed = tree.standards(rel);
    if (passed.err.includes(HOOK_ERROR)) return 'standards.js упал внутри guard - ' + passed.err.slice(0, 160);
    if (passed.err.includes('[S04]')) return 'S04 на //-строке с меткой и CR в конце: ' + passed.err.slice(0, 160);
    tree.write(rel, 'await ' + call + '({}); // ' + mark + '\r\nexport const x = 1;\r\n');
    const refused = tree.standards(rel);
    if (refused.code !== 2 || !refused.err.includes('[S04]')) return 'не пойман S04 на вызове с меткой после кода и CR в конце - код ' + refused.code + ' ' + refused.err.slice(0, 160);
    return true;
  });
});

/**
 * S04 и гейт no-search-list - одно правило: шаблон, пропуск и файлы S04 сверяются с
 * BANNED, ALLOWED и SOURCE_EXTENSIONS из scripts/lib/search-list.mjs, загруженного в
 * дочерний node. Правка одной стороны без другой здесь красная.
 */
check('standards: S04 - шаблон, пропуск и файлы те же, что у гейта no-search-list (scripts/lib/search-list.mjs)', () => {
  const s04 = ((repoRules && repoRules.standards) || []).find((st) => st.id === 'S04');
  if (!s04) return 'в rules.sf.json нет S04';
  const module = require('url').pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'search-list.mjs')).href;
  const program = 'const m = await import(' + JSON.stringify(module) + ');' +
    'console.log(JSON.stringify({ banned: m.BANNED.source, bannedFlags: m.BANNED.flags, allowed: m.ALLOWED.source, allowedFlags: m.ALLOWED.flags, ext: m.SOURCE_EXTENSIONS }));';
  const r = run(process.execPath, ['--input-type=module', '--eval', program], { cwd: ROOT });
  if (r.error || r.status !== 0) return 'search-list.mjs не загрузился: ' + String((r.error && r.error.message) || r.stderr).slice(0, 160);
  const rule = JSON.parse(String(r.stdout).trim());
  const flags = typeof s04.flags === 'string' ? s04.flags : '';
  const sourceOf = (pattern) => new RegExp(pattern, flags).source;
  if (sourceOf(s04.pattern) !== rule.banned || flags !== rule.bannedFlags) return 'шаблон S04 ' + JSON.stringify(s04.pattern) + ' не BANNED гейта ' + JSON.stringify(rule.banned);
  if (sourceOf(s04.skipIf) !== rule.allowed || flags !== rule.allowedFlags) return 'skipIf S04 ' + JSON.stringify(s04.skipIf) + ' не ALLOWED гейта ' + JSON.stringify(rule.allowed);
  const files = ['**/*.{' + rule.ext.map((e) => e.slice(1)).join(',') + '}'];
  if (JSON.stringify(s04.files) !== JSON.stringify(files)) return 'файлы S04 ' + JSON.stringify(s04.files) + ', у гейта ' + JSON.stringify(files);
  return { note: rule.ext.length + ' расширений' };
});

/**
 * isGone хуков (lib.js) - близнец isGone из scripts/lib/files.mjs (Р4 техлида E0-12N): ответ
 * на ENOENT, ENOTDIR, EPERM и EACCES сверяется с оригиналом, загруженным в дочерний node, и
 * isNotFile - с isNotFile оттуда же (ENOENT и ENOTDIR). Близнец, отвечающий «пропал» на всё,
 * здесь красный.
 */
check('lib.js: isGone и isNotFile отвечают как одноимённые из scripts/lib/files.mjs на ENOENT, ENOTDIR, EPERM, EACCES', () => {
  const codes = ['ENOENT', 'ENOTDIR', 'EPERM', 'EACCES'];
  const module = require('url').pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'files.mjs')).href;
  const program = 'const { isGone, isNotFile } = await import(' + JSON.stringify(module) + ');' +
    'const codes = ' + JSON.stringify(codes) + ';' +
    'const error = (code) => Object.assign(new Error(code), { code });' +
    'console.log(JSON.stringify([codes.map((code) => isGone(error(code))), codes.map((code) => isNotFile(error(code)))]));';
  const r = run(process.execPath, ['--input-type=module', '--eval', program], { cwd: ROOT });
  if (r.error || r.status !== 0) return 'files.mjs не загрузился: ' + String((r.error && r.error.message) || r.stderr).slice(0, 160);
  const [original, originalNotFile] = JSON.parse(String(r.stdout).trim());
  const error = (code) => Object.assign(new Error(code), { code });
  const twin = codes.map((code) => L.isGone(error(code)));
  if (JSON.stringify(twin) !== JSON.stringify(original)) {
    return 'isGone lib.js ' + JSON.stringify(twin) + ', files.mjs ' + JSON.stringify(original) + ' на ' + codes.join(', ');
  }
  const notFile = codes.map((code) => L.isNotFile(error(code)));
  if (JSON.stringify(notFile) !== JSON.stringify(originalNotFile)) {
    return 'isNotFile lib.js ' + JSON.stringify(notFile) + ', files.mjs ' + JSON.stringify(originalNotFile) + ' на ' + codes.join(', ');
  }
  if (L.isGone({ code: 'ENOENT' }) || L.isGone(null)) return 'isGone принял не ошибку за пропавший путь';
  return { note: codes.map((code, i) => code + '=' + original[i]).join(', ') };
});

check('standards: серверные пакеты в apps/web/src (корень, подпуть, побочный импорт) пойманы S11, вход web - нет', () => {
  const gone = missingDirs(['apps/web/src/lib']);
  if (gone) return gone;
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
  ].map(lineFile), [
    'import { env } from "@sf/config/server";',
    'import { createServerClient } from "@sf/api-client/server";',
    'import { BuildInfoSchema } from "@sf/contracts";',
    'import "server-only";',
  ].map(lineFile));
});

/**
 * Форма роута (E0-12D, Р6; E0-12P): роут модуля routes регистрируется только defineRoute из
 * src/lib/define-route.ts. Регистрацию мимо помощника держит тип: модуль получает RouteRegistrar
 * без единого ключа экземпляра (apps/api/test/define-route.test.ts, docs/adr/0015-route-registrar.md),
 * построчное правило S13 снято; экземпляр из хендлера (request.server, reply.server, this) держит
 * разбор по AST в apps/api/test/route-modules.test.ts, построчное правило S17 снято (В1 E0-12P). Обе
 * боевые формы - сами файлы health и system из репозитория - пропуск S14 и всех правил standards.
 * Отказ S14 - defineRoute в файле без ...errorResponses() в коде: без спреда, спред только в
 * комментарии (//, блочный, строка JSDoc, хвост строки); пропуск - ключ response: в файле без
 * defineRoute (лог, тело ответа). Точные статусы 4xx/5xx правило не видит - их проверяет
 * apps/api/test/route-shape.test.ts.
 */
function routeFile(lines) {
  return 'export function registerRoutes(registrar: RouteRegistrar): void {\n' + lines.map((l) => '  ' + l + '\n').join('') + '}\n';
}
const ROUTE_DEFINITION = [
  'const responses = { ...errorResponses(), [OK_STATUS]: X };',
  'defineRoute(registrar, { method: "GET", url: "/x", responses, schema: { tags: ["x"] } }, handler);',
];
/**
 * Тексты боевых форм роута (ROUTE_FORMS) из репозитория - пропуск в пробах S14 и модуля роута;
 * с диска - один раз за прогон (TECH_DEBT 19.10.2026 E0-12D круг 5, хелпер `file(line)` и `ROUTE_FORMS`).
 */
let routeFormsMemo = null;
function routeFormTexts() {
  if (!routeFormsMemo) routeFormsMemo = ROUTE_FORMS.map((form) => fs.readFileSync(path.join(ROOT, form), 'utf8'));
  return routeFormsMemo;
}
/**
 * Пропуск модуля роута целиком (строка долга :644, E0-12P): вызовы с именами методов экземпляра на
 * том, что экземпляром не является (repo.get, map.delete, searchParams.get, Promise.all), рядом с
 * defineRoute и ...errorResponses() не отказываются ни одним правилом standards - ложный отказ
 * снятого S13 не возвращается; то же для ложных отказов снятого S17 (В1 E0-12P): this в строковом
 * литерале; `deps.config.server` правила standards не отказывают, его отказывает разбор по AST
 * (apps/api/test/route-modules.test.ts), не S17. Отказ - любой [id] правила standards в замечаниях (standardsCases с
 * ANY_RULE); крах - красный. Сторона отказа в том же пути показывает, что предикат совпадает и на
 * S-, и на W-правиле: тело без ...errorResponses() (S14) и тело с @ts-ignore (W03 общего файла -
 * действует здесь через склейку standards в lib.rulesFor, проба склейки ниже).
 */
check('standards: модуль роута с repo.get(, map.delete(, searchParams.get(, this в строке и defineRoute не отказывается ни одним правилом; S14 и W03 в том же пути - отказ', () => {
  const gone = missingDirs(ROUTE_FORMS);
  if (gone) return gone;
  const bodies = routeFormTexts().concat([
    routeFile(ROUTE_DEFINITION.concat([
      'const found = repo.get(id);',
      'map.delete(key);',
      'const page = searchParams.get("page");',
      'const [a, b] = await Promise.all([one(), two()]);',
      'request.log.info("cannot undo this.");',
      'const url = deps.config.server;',
    ])),
  ]);
  return standardsCases(ANY_RULE, 'apps/api/src/routes/zz_selftest/index.ts', [
    routeFile(['const responses = { [OK_STATUS]: X };', ROUTE_DEFINITION[1]]),
    routeFile(ROUTE_DEFINITION.concat(['// @ts-ignore', 'const n: number = id;'])),
  ], bodies);
});
/**
 * Склейка standards (E0-12P, решение техлида по п.5 круга 3): lib.rulesFor отдаёт репозиторию со
 * своим списком и общие правила - каждый id обоих файлов ровно один раз, общие первыми; при
 * одинаковом id побеждает правило репозитория (mergeStandards). Откат к Object.assign - красный:
 * W-правила пропадают из списка репозитория.
 */
check('lib.rulesFor склеивает standards общего файла и репозитория, одинаковый id - правило репозитория', () => {
  const repo = L.repoFor(path.join(ROOT, 'package.json'));
  if (!repo) return 'репозиторий проекта не найден lib.repoFor';
  const got = (L.rulesFor(repo).standards || []).map((rule) => rule && rule.id);
  const shared = ((common && common.standards) || []).map((rule) => rule.id);
  const mine = ((repoRules && repoRules.standards) || []).map((rule) => rule.id);
  if (!shared.length || !mine.length) return 'пустой список standards в файле правил - сверять не с чем';
  const want = shared.filter((id) => !mine.includes(id)).concat(mine);
  if (JSON.stringify(got) !== JSON.stringify(want)) return 'standards репозитория ' + JSON.stringify(got) + ', ждали ' + JSON.stringify(want);
  if (typeof L.mergeStandards !== 'function') return 'lib.mergeStandards не экспортирован';
  const merged = L.mergeStandards([{ id: 'X', from: 'common' }, { id: 'Y', from: 'common' }], [{ id: 'X', from: 'own' }]);
  const seen = JSON.stringify(merged.map((rule) => rule.id + ':' + rule.from));
  if (seen !== JSON.stringify(['Y:common', 'X:own'])) return 'одинаковый id: ' + seen + ', ждали ["Y:common","X:own"]';
  return { note: got.length + ' правил: ' + shared.length + ' общих, ' + mine.length + ' своих' };
});
/**
 * Склейка и правило без id (E0-12P, решение техлида по кругу 4, п.5): в множество id попадают только
 * строки, поэтому общее правило без id не отбрасывается вместе с отсутствующим id у правила
 * репозитория. Откат к `new Set(mine.map((rule) => rule && rule.id))` - красный: undefined в множестве
 * выбрасывает все общие правила без id.
 */
check('lib.mergeStandards: общее правило без id переживает склейку', () => {
  if (typeof L.mergeStandards !== 'function') return 'lib.mergeStandards не экспортирован';
  const merged = L.mergeStandards([{ from: 'common-no-id' }, { id: 'Y', from: 'common' }], [{ from: 'own-no-id' }, { id: 'X', from: 'own' }]);
  const seen = JSON.stringify(merged.map((rule) => rule.from));
  const want = JSON.stringify(['common-no-id', 'common', 'own-no-id', 'own']);
  if (seen !== want) return 'склейка ' + seen + ', ждали ' + want;
  return { note: 'правила без id в обоих списках сохранены' };
});
check('standards: S14 ловит defineRoute без ...errorResponses() в коде файла, боевые роуты - нет', () => {
  const gone = missingDirs(ROUTE_FORMS);
  if (gone) return gone;
  const route = ROUTE_DEFINITION[1];
  return standardsCases('S14', 'apps/api/src/routes/zz_selftest/index.ts', [
    routeFile(['const responses = { [OK_STATUS]: X };', route]),
    routeFile(['const failures = errorResponses();', 'const responses = { ...failures, [OK_STATUS]: X };', route]),
    routeFile(['// const responses = { ...errorResponses(), [OK_STATUS]: X };', 'const responses = { [OK_STATUS]: X };', route]),
    routeFile(['/* ...errorResponses() */', 'const responses = { [OK_STATUS]: X };', route]),
    routeFile(['/**', ' * ...errorResponses() goes first', ' */', 'const responses = { [OK_STATUS]: X };', route]),
    routeFile(['const responses = { [OK_STATUS]: X }; // no ...errorResponses() here', route]),
  ], routeFormTexts().concat([
    routeFile(ROUTE_DEFINITION),
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
  ].map(lineFile), [
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
  ].map(lineFile));
});
check('standards: S16 ловит @sf/* кроме @sf/contracts в packages/api-client, @sf/contracts и самоимпорт - нет', () => {
  const gone = missingDirs(['packages/api-client/src']);
  if (gone) return gone;
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
  ].map(lineFile), [
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
  ].map(lineFile));
});
/**
 * Пробы Stop- и UserPromptSubmit-хуков. Состояние - L.statePath(), то есть временная папка
 * прогона (SF_HOOK_STATE_DIR); помощник кладёт туда стартовое состояние пробы, а транскрипт -
 * в свою временную папку, которую убирает после пробы.
 */
function withProbeState(seed, fn) {
  const statePath = L.statePath();
  if (path.resolve(statePath) === path.resolve(LIVE_STATE)) return 'проба смотрит в боевой .qa-state: ' + statePath;
  const dir = tempDir('tr');
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
    releaseTemp(dir);
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
    const link = path.join(tempDir('link'), 'old');
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
      releaseTemp(path.dirname(link));
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
 * Сверка дерева в последней пробе ловит то, ради чего снимок такой (E0-12D, B8 круга 1; E0-12T):
 * перезапись файла, который уже `M`, новый игнорируемый каталог и новый файл внутри уже
 * игнорируемого каталога. Проверяется на временном репозитории теми же repoSnapshot и treeDiff:
 * без изменений разницы нет, после перезаписи `M`-файла, записи в новый игнорируемый каталог и
 * нового файла рядом со старым в игнорируемом `coverage/` - каждая запись названа. Временный
 * репозиторий не берёт ничего из настроек машины, что исполняет код: init без шаблонов
 * (`--template=`, иначе init.templateDir кладёт свои хуки), коммит через git(…, { isolated }).
 */
check('сверка дерева ловит перезапись M-файла, новый игнорируемый каталог, новый файл в уже игнорируемом каталоге и остаток vite *.timestamp-*.mjs, без изменений - тишина', () => {
  const dir = tempDir('repo');
  try {
    const inDir = (args) => gitStrict(['-c', 'user.name=selftest', '-c', 'user.email=selftest@localhost', '-c', 'core.autocrlf=false'].concat(args), { cwd: dir, isolated: true });
    inDir(['init', '-q', '--template=']);
    // *.timestamp-*.mjs - как в .gitignore репозитория: остаток vite рядом с конфигом (Р3 E0-12T)
    fs.writeFileSync(path.join(dir, '.gitignore'), 'coverage/\nout/\n*.timestamp-*.mjs\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    inDir(['add', '.']);
    inDir(['commit', '-q', '-m', 'probe']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    fs.mkdirSync(path.join(dir, 'coverage'));
    fs.writeFileSync(path.join(dir, 'coverage', 'old.txt'), 'old\n');
    const before = repoSnapshot(dir);
    const still = treeDiff(before, repoSnapshot(dir));
    if (still.length) return 'разница без изменений: ' + still.join(', ');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'three\n');
    fs.mkdirSync(path.join(dir, 'out'));
    fs.writeFileSync(path.join(dir, 'out', 'x.txt'), 'x\n');
    fs.writeFileSync(path.join(dir, 'coverage', 'new.txt'), 'new\n');
    // стаб дочернего vitest, оставивший файл vite рядом с конфигом в дереве
    fs.writeFileSync(path.join(dir, 'vitest.int.config.ts.timestamp-1.mjs'), 'x\n');
    const diff = treeDiff(before, repoSnapshot(dir));
    const missed = ['изменилось содержимое  M a.txt', 'появилось !! out/x.txt', 'появилось !! coverage/new.txt', 'появилось !! vitest.int.config.ts.timestamp-1.mjs']
      .filter((line) => !diff.includes(line));
    return missed.length ? 'сверка не видит: ' + missed.join(', ') + ' (видит: ' + (diff.join(', ') || 'ничего') + ')' : { note: diff.length + ' записи' };
  } finally {
    releaseTemp(dir);
  }
});

// Отпечаток ссылки (замечание ревью C11 E0-12T): ссылка на файл - sha1 цели, правка цели меняет
// отпечаток; игнорируемая запись - размер+mtime самой записи. Подмена io: ссылок на файл Windows
// без прав разработчика не создаёт.
check('сверка дерева: отпечаток ссылки на файл - sha1 цели (правка цели видна), игнорируемой записи - размер и mtime самой записи', () => {
  const sha1 = (s) => require('crypto').createHash('sha1').update(Buffer.from(s)).digest('hex');
  let body = 'one';
  const io = {
    lstat: () => ({ isFile: () => false, isSymbolicLink: () => true, size: 7, mtimeMs: 1 }),
    stat: () => ({ isFile: () => true }),
    read: () => Buffer.from(body),
  };
  const before = snapshotPrint('link.txt', false, io);
  body = 'two';
  const after = snapshotPrint('link.txt', false, io);
  if (before !== sha1('one') || after !== sha1('two')) return 'ссылка на файл: ' + JSON.stringify([before, after]) + ', ожидались sha1 цели ' + JSON.stringify([sha1('one'), sha1('two')]);
  const ignored = snapshotPrint('link.txt', true, io);
  return ignored === '7 1' || 'игнорируемая запись: ' + JSON.stringify(ignored) + ', ожидалось "7 1"';
});

/**
 * Исключения сверки дерева (ОВ2 техлида E0-12T): на временном репозитории с .gitignore как у
 * репозитория запись в tasks/x.md, .claude/.qa-state и .claude/.qa-state.<pid>.tmp молчит (пропуск),
 * а соседние пути - docs/tasks/x.md, tasks.md, .claude/.qa-state.bak, .claude/x.tmp,
 * .claude/.qa-state.a/b.tmp - названы (охват). У каждой записи перечня - причина.
 */
check('сверка дерева: TREE_NOT_COMPARED - tasks/, .claude/.qa-state и его .<pid>.tmp молчат, соседние пути названы, у каждой записи причина', () => {
  const noWhy = TREE_NOT_COMPARED.filter((x) => typeof x.why !== 'string' || !x.why);
  if (noWhy.length) return 'запись без причины: ' + JSON.stringify(noWhy);
  const dir = tempDir('repo');
  try {
    const inDir = (args) => gitStrict(['-c', 'user.name=selftest', '-c', 'user.email=selftest@localhost', '-c', 'core.autocrlf=false'].concat(args), { cwd: dir, isolated: true });
    inDir(['init', '-q', '--template=']);
    fs.writeFileSync(path.join(dir, '.gitignore'), '/tasks/\n.claude/.qa-state\n.claude/.qa-state.*.tmp\n');
    inDir(['add', '.']);
    inDir(['commit', '-q', '-m', 'probe']);
    const put = (rel) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), 'x\n');
    };
    const before = repoSnapshot(dir);
    const silent = ['tasks/x.md', '.claude/.qa-state', '.claude/.qa-state.123.tmp'];
    const named = ['docs/tasks/x.md', 'tasks.md', '.claude/.qa-state.bak', '.claude/x.tmp', '.claude/.qa-state.a/b.tmp'];
    for (const rel of silent.concat(named)) put(rel);
    const diff = treeDiff(before, repoSnapshot(dir));
    const leaked = diff.filter((line) => silent.some((rel) => line.endsWith(' ' + rel)));
    if (leaked.length) return 'исключение названо: ' + leaked.join(', ');
    const missed = named.filter((rel) => !diff.some((line) => line.startsWith('появилось ') && line.endsWith(' ' + rel)));
    return missed.length ? 'сверка не видит: ' + missed.join(', ') + ' (видит: ' + (diff.join(', ') || 'ничего') + ')' : { note: diff.length + ' записей названо, ' + silent.length + ' молчат' };
  } finally {
    releaseTemp(dir);
  }
});

/**
 * Полнота копии хуков (E0-12T, TECH_DEBT 19.10.2026 E0-12D круг 3, `withScratchTree`): copyHooksTo из временного источника с файлом
 * иного расширения (x.cjs) и подкаталогом (sub/y.txt) - перечень файлов копии рекурсивно равен
 * перечню источника.
 */
check('дерево пробы: копия хуков полная - x.cjs и sub/y.txt источника на месте, перечни равны', () => {
  const from = tempDir('hooks-src');
  const to = tempDir('hooks-copy');
  try {
    fs.writeFileSync(path.join(from, 'a.js'), 'a');
    fs.writeFileSync(path.join(from, 'x.cjs'), 'x');
    fs.mkdirSync(path.join(from, 'sub'));
    fs.writeFileSync(path.join(from, 'sub', 'y.txt'), 'y');
    const want = filesUnder(from);
    const got = filesUnder(copyHooksTo(to, from));
    return JSON.stringify(got) === JSON.stringify(want) || 'копия ' + JSON.stringify(got) + ', источник ' + JSON.stringify(want);
  } finally {
    releaseTemp(from);
    releaseTemp(to);
  }
});

/** Файлы, чей текст сверяет статический кейс помощника git. */
const HELPER_SCANNED = ['harness-selftest.js', 'selftest-graph.js'];
/**
 * git мимо помощника git() (E0-12T, TECH_DEBT 19.10.2026 E0-12D круг 6 «изоляция git в пробах»;
 * решения ревью B7 и C16 E0-12T): вызов spawn-функции, чей первый аргумент (до запятой) называет
 * git - литералом (имя в кавычках, `git status` у execSync), именем-переменной (GIT_BIN, gitBin)
 * или выражением (o.git с запасным именем); сверка - по всему тексту, вызов на нескольких строках
 * (`run(` и имя строкой ниже) - тот же отказ, номер - строки вызова. Имя программы в кавычках
 * (GIT_LITERAL) - только в строке GIT_BIN: `const bin = <имя>; run(bin)` ловит эта сверка, а не
 * первая. Помощник зовёт (o.spawn || run)(o.bin || GIT_BIN, …) - имя функции в скобках, вызова по
 * имени нет. Остаток слепоты (имя из конкатенации, вызов через ссылку на функцию) - TECH_DEBT E0-12T.
 */
const GIT_BYPASS = /\b(?:run|spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*(?:[^,)]*[^A-Za-z,)])?git/gi;
const GIT_LITERAL = /(['"`])git\1/;
const GIT_BIN_LINE = 'const GIT_BIN = ' + "'gi" + "t';";
/** Номера строк (с 1), на которых начинается совпадение глобального re по всему тексту text. */
function textMatches(text, re) {
  const lines = [];
  for (const m of text.matchAll(re)) lines.push(text.slice(0, m.index).split('\n').length);
  return lines;
}
check('git: в harness-selftest.js и selftest-graph.js ни одного вызова git мимо помощника git() и имени git в кавычках вне GIT_BIN (проба отказа - литерал, переменная, выражение, execSync, вызов на двух строках, имя в переменной)', () => {
  const bad = [];
  for (const f of HELPER_SCANNED) {
    const text = fs.readFileSync(path.join(HOOKS, f), 'utf8');
    for (const n of textMatches(text, GIT_BYPASS)) bad.push(f + ':' + n);
    const lines = text.split(/\r?\n/);
    for (const n of linesMatching(text, GIT_LITERAL)) if (lines[n - 1].trim() !== GIT_BIN_LINE) bad.push(f + ':' + n + ' (имя в кавычках)');
  }
  if (bad.length) return 'git мимо помощника: ' + bad.join(', ');
  if (linesMatching(fs.readFileSync(__filename, 'utf8'), GIT_LITERAL).length !== 1) return 'строки GIT_BIN нет - сверка имени в кавычках слепа';
  // имя функции со скобкой и имя программы в кавычках склеиваются здесь, а не в тексте файла: иначе
  // сверка выше поймала бы сам кейс
  const call = (name) => name + '(';
  const q = "'gi" + "t'";
  const planted = [
    call('run') + q + ", ['status']);",
    call('spawn') + 'o.git || ' + q + ", ['ls-files']);",
    call('run') + 'GIT_BIN, args);',
    call('execSync') + "'gi" + "t status');",
    call('run') + '\n  ' + q + ', args);',
  ];
  const missed = planted.filter((text) => textMatches(text, GIT_BYPASS).join() !== '1');
  if (missed.length) return 'вызов git мимо помощника не пойман - сверка слепа: ' + missed.join(' | ');
  if (!GIT_LITERAL.test('const bin = ' + q + ';')) return 'имя git в переменной не поймано - сверка слепа';
  const clean = [call('run') + 'process.execPath, [file]);', call('spawn') + 'digits, []);', call('run') + '\n  process.execPath, [file]);'];
  const caught = clean.filter((text) => textMatches(text, GIT_BYPASS).length);
  return !caught.length || 'вызов не git принят за git: ' + caught.join(' | ');
});
// Текст отказа gitStrict называет подкоманду, а не пары -c впереди (замечание ревью C13 E0-12T)
check('git: gitStrict - текст отказа называет подкоманду после пар -c', () =>
  refusalVerdict(() => gitStrict(['-c', 'user.name=selftest', '-c', 'user.email=selftest@localhost', 'commit', '-q'], { spawn: () => ({ status: 1, stderr: 'boom' }) }), 'git commit: boom'));
/**
 * Временный каталог мимо помощника tempDir (E0-12T, TECH_DEBT 19.10.2026 E0-12D круг 6 «каталоги
 * sf-selftest-* в %TEMP%»): mkdtempSync - одно место в фабрике реестра (selftest-temp.js), ни
 * одного в harness-selftest.js и selftest-graph.js.
 */
const MKDTEMP_CALL = /\bmkdtempSync\s*\(/;
check('tempDir: mkdtempSync только в фабрике реестра (одно место в selftest-temp.js, ноль в harness-selftest.js и selftest-graph.js; проба отказа - второй вызов)', () => {
  const want = { 'selftest-temp.js': 1, 'harness-selftest.js': 0, 'selftest-graph.js': 0 };
  const bad = Object.entries(want)
    .map(([f, n]) => [f, n, linesMatching(fs.readFileSync(path.join(HOOKS, f), 'utf8'), MKDTEMP_CALL).length])
    .filter(([, n, got]) => got !== n)
    .map(([f, n, got]) => f + ' ' + got + ' (ожидалось ' + n + ')');
  if (bad.length) return 'mkdtempSync: ' + bad.join(', ');
  const call = 'mkdtemp' + 'Sync(';
  const planted = 'const a = fs.' + call + 'x);\nconst b = fs.' + call + 'y);\n';
  return linesMatching(planted, MKDTEMP_CALL).length === 2 || 'второй вызов mkdtempSync не пойман - сверка слепа';
});
/**
 * Каталоги проб снимает releaseTemp (замечание ревью C4 E0-12T): сбой снятия (EBUSY на Windows) не
 * подменяет вердикт пробы и не роняет прогон до report(). Голый вызов dropTemp - только в самом
 * releaseTemp и в кейсе dropTemp с подменой rm: DROP_TEMP_DIRECT - их точные строки (имя склеено,
 * иначе сверка поймала бы сам перечень).
 */
const DROP_TEMP_DIRECT = ['drop' + 'Temp(dir, opts);', 'drop' + 'Temp(box, {'];
const DROP_TEMP_CALL = /\bdropTemp\(/;
check('tempDir: каталоги проб снимает releaseTemp - голый dropTemp только в releaseTemp и кейсе подмены rm (проба отказа - вставленный вызов)', () => {
  const text = fs.readFileSync(__filename, 'utf8');
  const lines = text.split(/\r?\n/);
  const bad = linesMatching(text, DROP_TEMP_CALL).filter((n) => !DROP_TEMP_DIRECT.includes(lines[n - 1].trim()));
  if (bad.length) return 'dropTemp мимо releaseTemp: harness-selftest.js:' + bad.join(', :');
  const direct = linesMatching(text, DROP_TEMP_CALL).length;
  if (direct !== DROP_TEMP_DIRECT.length) return 'строк DROP_TEMP_DIRECT в тексте ' + direct + ', в перечне ' + DROP_TEMP_DIRECT.length;
  const planted = '  } finally {\n    ' + 'drop' + 'Temp(dir);\n  }\n';
  return linesMatching(planted, DROP_TEMP_CALL).join() === '2' || 'вставленный dropTemp не пойман - сверка слепа';
});

/**
 * Обработчик exit реестра (E0-12T, TECH_DEBT 19.10.2026 E0-12D круг 6 «каталоги sf-selftest-* в %TEMP%»): каталог реестра, оставленный пробой, которую
 * прервали process.exit (как report() внутри пробы) или SIGINT -> exit(130) (Ctrl+C), снимается
 * при выходе процесса, а junction внутри снимается unlink - цель цела. Дочерний node берёт модуль
 * selftest-temp.js через require (один модуль, без копии исходника); каталоги - внутри временного
 * каталога этой пробы.
 */
check('tempDir: process.exit и SIGINT посреди пробы - каталог реестра снят обработчиком exit, цель junction внутри цела', () => {
  const box = tempDir('exit');
  try {
    const target = path.join(box, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
    const child = (how) => {
      const code = [
        'const { makeTempRegistry } = require(' + JSON.stringify(path.join(HOOKS, 'selftest-temp.js')) + ');',
        'const reg = makeTempRegistry({ fs: require("fs"), os: require("os"), path: require("path"), isNotFile: require(' + JSON.stringify(path.join(HOOKS, 'lib.js')) + ').isNotFile });',
        'process.on("exit", reg.dropAll);',
        'process.on("SIGINT", () => process.exit(130));',
        'const dir = reg.tempDir("child", ' + JSON.stringify(box) + ');',
        'require("fs").symlinkSync(' + JSON.stringify(target) + ', require("path").join(dir, "link"), "junction");',
        'process.stdout.write(dir);',
        how === 'exit' ? 'process.exit(3);' : 'process.emit("SIGINT");',
        'setTimeout(() => {}, 5000);',
      ].join('\n');
      const r = run(process.execPath, ['-e', code], { cwd: ROOT, timeout: 30000, killSignal: 'SIGKILL' });
      return { code: r.status, dir: String(r.stdout || ''), err: String(r.stderr || '') };
    };
    const why = [];
    for (const [how, want] of [['exit', 3], ['SIGINT', 130]]) {
      const c = child(how);
      if (c.code !== want || !c.dir) why.push(how + ': код ' + c.code + ' (ожидался ' + want + '), каталог ' + JSON.stringify(c.dir) + ' ' + c.err.slice(0, 120));
      else if (!absent(c.dir)) why.push(how + ': каталог реестра остался после выхода: ' + c.dir);
    }
    if (absent(path.join(target, 'keep.txt'))) why.push('цель junction удалена вместе с каталогом');
    return why.length ? why.join('; ') : { note: 'exit 3 и SIGINT 130' };
  } finally {
    releaseTemp(box);
  }
});
/**
 * Снятие ссылок до рекурсивного удаления (L-028; TECH_DEBT 21.10.2026 E0-12L круг 4, `withTempRoot`): на момент вызова rmSync внутри
 * каталога нет ни одной ссылки - подмена rm смотрит на дерево до удаления.
 */
check('tempDir: dropTemp снимает junction unlink до рекурсивного удаления (rmSync не видит ни одной ссылки)', () => {
  const box = tempDir('links');
  const target = tempDir('links-target');
  try {
    fs.mkdirSync(path.join(box, 'sub'));
    fs.symlinkSync(target, path.join(box, 'sub', 'link'), 'junction');
    let seen = null;
    dropTemp(box, {
      rm: (dir, opts) => {
        const links = [];
        const walk = (d) => {
          for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) links.push(path.relative(box, path.join(d, entry.name)));
            else if (entry.isDirectory()) walk(path.join(d, entry.name));
          }
        };
        walk(dir);
        seen = links;
        fs.rmSync(dir, opts);
      },
    });
    if (seen === null) return 'rm не вызван';
    return !seen.length || 'rmSync получил каталог со ссылками: ' + seen.join(', ');
  } finally {
    releaseTemp(box);
    releaseTemp(target);
  }
});

/**
 * Сбой снятия каталога (EBUSY на Windows) не подменяет итог пробы и не роняет прогон до report()
 * (решение ревью B12 E0-12T): releaseTemp не бросает, сбой записан в DROP_FAILURES, каталог остаётся
 * в реестре до снятия обработчиком exit.
 */
check('tempDir: releaseTemp - сбой снятия (EBUSY) не исключение, записан в DROP_FAILURES, каталог в реестре', () => {
  const box = tempDir('busy');
  const before = DROP_FAILURES.length;
  try {
    let got;
    try {
      got = releaseTemp(box, { rm: () => { throw Object.assign(new Error('EBUSY: resource busy or locked, rmdir ' + box), { code: 'EBUSY' }); } });
    } catch (e) {
      return 'сбой снятия - исключение: ' + ((e && e.message) || String(e));
    }
    const noted = DROP_FAILURES.slice(before);
    if (got !== false || noted.length !== 1 || !noted[0].startsWith(box + ': EBUSY')) return 'ответ ' + got + ', записи ' + JSON.stringify(noted);
    return TEMP.live.has(box) || 'каталог со сбоем снятия выпал из реестра';
  } finally {
    DROP_FAILURES.splice(before);
    releaseTemp(box);
  }
});
// Отсутствие пути - lstat с кодом, а не existsSync (замечание ревью R1 E0-12T): недоступный путь
// (EACCES) - исключение, а не «нет».
check('absent: ENOENT и ENOTDIR - нет, EACCES - исключение, путь на месте - есть', () => {
  const thrower = (code) => () => { throw Object.assign(new Error(code + ': selftest'), { code }); };
  const got = [absent('x', thrower('ENOENT')), absent('x', thrower('ENOTDIR')), absent(__filename)];
  if (JSON.stringify(got) !== JSON.stringify([true, true, false])) return 'ENOENT, ENOTDIR, этот файл: ' + JSON.stringify(got);
  return refusalVerdict(() => absent('x', thrower('EACCES')), 'EACCES: selftest');
});
// Одно чтение корневого package.json за прогон (rootPkg) и один вопрос к gates.js на файл у пробы
// гейта (gateProbe) - TECH_DEBT 21.10.2026 E0-12L круг 3 и круг 4; сверка - здесь, когда все пробы
// уже спросили.
check('мемо прогона: корневой package.json прочитан с диска один раз, gateProbe спрашивает gates.js о файле один раз', () => {
  if (ROOT_PKG_READS !== 1) return 'корневой package.json прочитан ' + ROOT_PKG_READS + ' раз(а)';
  const twice = [];
  let asked = 0;
  let selected = 0;
  for (const [id, p] of gateProbes) {
    asked += p.asked;
    selected += p.selected;
    if (p.selected !== p.seen.size) twice.push(id + ': ' + p.selected + ' вызовов selects на ' + p.seen.size + ' файлов');
  }
  if (twice.length) return 'gates.js спрошен о файле больше одного раза: ' + twice.join('; ');
  return asked > selected || 'мемо gateProbe ни разу не сработало (' + asked + ' вопросов, ' + selected + ' вызовов) - сверка слепа';
});

// Строка снимка VITEST_GATE - после всех проб, которым нужен ответ дочернего vitest: отказ
// (не стартовал, не ответил, иная форма) - одна строка с перечнем не гонявшихся проб.
{
  const line = 'дочерний vitest пробы test:int: ответ selftest-vitest.mjs по корням графа и стабу';
  check(line, intGuard(line, () => {
    try {
      VITEST_GATE.take();
    } catch (e) {
      if (!(e instanceof GateBlocked)) throw e;
    }
    return gateVerdict(VITEST_GATE, (snap) => (snap.live.error ? 'корни: ' + snap.live.error.message : snap.live.value.length + ' корней') + ', стаб', 'пробы дочернего vitest');
  }));
}

// ------------------------------------------------------------------ боевое состояние
check('боевой .qa-state после проб байт в байт прежний', () => {
  const now = liveBytes();
  const same = LIVE_BYTES === null ? now === null : now !== null && LIVE_BYTES.equals(now);
  if (same) return true;
  return 'боевой ' + LIVE_STATE + ' изменился за прогон: ' +
    (LIVE_BYTES === null ? 'не было' : LIVE_BYTES.length + ' байт') + ' -> ' + (now === null ? 'нет' : now.length + ' байт');
});
// Каталоги прогона (E0-12T, TECH_DEBT 19.10.2026 E0-12D круг 6 «каталоги sf-selftest-* в %TEMP%»): каждый каталог реестра, кроме PROBE_STATE_DIR (его
// снимает выход процесса), снят своей пробой - не в реестре и не на диске. Каталог хуков git
// временных репозиториев (noHooksDir) живёт до последней пробы с коммитом - он снимается здесь.
if (noHooks) releaseTemp(noHooks);
check('временные каталоги прогона сняты: ни одного каталога реестра на диске, кроме PROBE_STATE_DIR', () => {
  const left = TEMP.made.filter((d) => d !== PROBE_STATE_DIR && (TEMP.live.has(d) || !absent(d)));
  if (left.length) return 'остались: ' + left.join(', ') + (DROP_FAILURES.length ? '; сбой снятия: ' + DROP_FAILURES.join('; ') : '');
  return { note: TEMP.made.length + ' каталогов, все с префиксом ' + TEMP.PREFIX };
});
check('пробы не оставили файлов в репозитории: записи git status с содержимым и игнорируемые файлы (кроме node_modules) до и после прогона те же', () => {
  if (!LIVE_TREE) return 'снимок дерева до проб не снят: ' + LIVE_TREE_ERROR;
  const now = repoSnapshot();
  const diff = treeDiff(LIVE_TREE, now);
  if (!diff.length) return { note: now.size + ' записей' };
  return 'за прогон: ' + diff.join(', ').slice(0, 300) + ' (если файлы в это время правили руками или другим процессом - перезапусти)';
});

// ------------------------------------------------------------------ итог
report();

/** Строки results и счёт; код выхода 1, если красна хоть одна. */
function report() {
  let red = 0;
  for (const r of results) {
    if (!r.ok) red++;
    console.log((r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.note ? '  - ' + r.note : ''));
  }
  console.log(red ? 'Самопроверка обвязки: КРАСНАЯ, ' + red + ' из ' + results.length : 'Самопроверка обвязки: зелёная, ' + results.length + ' проверок');
  process.exit(red ? 1 : 0);
}
