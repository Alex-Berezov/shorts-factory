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
/**
 * Модули самопроверки - один перечень (E0-12U, ревью круга 1): из него строятся HOOK_FILES (проба
 * синтаксиса), NO_EXIT_FILES, HELPER_SCANNED, ожидания сверки mkdtempSync и загрузка модулей; новый
 * модуль, дописанный сюда, попадает под все статические пробы сразу. Порядок - порядок строк
 * синтаксиса и загрузки. Поля:
 *   load - кто его грузит (только SELFTEST_LOADS): 'graph' - цепочка модуля графа G (loadGraphChain,
 *     по порядку перечня), 'gates' - пробы гейтов (loadSelftestModule в разделе 2a), null - этот файл
 *     его не грузит после пробы синтаксиса;
 *   why - почему load: null (обязательно при null); значения load и why сверяет проба полноты перечня;
 *   exit - почему exit процесса в его тексте законен (тогда файл вне NO_EXIT_FILES); без поля - в них;
 *   mkdtemp - сколько вызовов mkdtempSync ждёт сверка (без поля - ноль).
 */
const SELFTEST_MODULES = [
  { file: 'selftest-turbo.js', load: 'graph' },
  { file: 'selftest-graph.js', load: 'graph' },
  { file: 'selftest-stub.js', load: 'graph' },
  { file: 'selftest-vitest.mjs', load: null, why: 'дочерний процесс vitest/node пробы test:int (startVitest), не require' },
  {
    file: 'selftest-temp.js',
    load: null,
    why: 'реестр временных каталогов нужен до первой пробы - require в начале файла, до пробы синтаксиса',
    mkdtemp: 1,
  },
  { file: 'selftest-int.js', load: 'gates' },
  {
    file: 'selftest-gates-run.js',
    load: 'gates',
    exit: 'gateRunner и программы `node -e` пробы запуска - код дочернего процесса: его process.exit - выход ребёнка, а не самопроверки',
  },
  { file: 'selftest-tree-graph.js', load: 'gates' },
  { file: 'selftest-roots.js', load: 'gates' },
  { file: 'selftest-int-cases.js', load: 'gates' },
  { file: 'selftest-gates.js', load: 'gates' },
  { file: 'selftest-graph-cases.js', load: 'gates' },
];
/** Допустимые значения поля load перечня SELFTEST_MODULES; опечатка (`'gate'`) роняет прогон TypeError на сборке проб гейтов или графа до report() (код 1, без сводки). */
const SELFTEST_LOADS = ['graph', 'gates', null];
const HOOK_FILES = [
  'lib.js', 'diff-hash.js', 'standards.js', 'commit-gate.js',
  'answer-length.js', 'report-honesty.js', 'remind-format.js',
  'gates.js', ...SELFTEST_MODULES.map((m) => m.file),
];

const results = [];
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
/** Окружение git временного репозитория пробы: автор и коммитер заданы, глобальный конфиг машины их не подставляет. */
function gitIdentityEnv() {
  return Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@x', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@x' });
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

/**
 * Каждый файл selftest-*.js / *.mjs / *.cjs каталога хуков - в перечне SELFTEST_MODULES (E0-12U, ревью
 * круга 2): статические пробы (синтаксис, exit процесса, git мимо помощника, mkdtempSync) строятся из
 * перечня, и модуль, который грузят мимо него, выпал бы из всех разом. Каталог читается без подкаталогов:
 * copyHooksTo копирует их, а require модулей самопроверки идёт только из каталога хуков. В той же
 * строке - значения полей перечня (E0-12U, решение техлида B2 после круга 3): load из SELFTEST_LOADS,
 * при load: null - причина в why.
 */
const SELFTEST_FILE = /^selftest-.+\.[cm]?js$/;
/** Файлы files, похожие на модуль самопроверки (SELFTEST_FILE), которых нет в SELFTEST_MODULES. */
function unlistedSelftest(files) {
  const listed = new Set(SELFTEST_MODULES.map((m) => m.file));
  return files.filter((f) => SELFTEST_FILE.test(f) && !listed.has(f));
}
/** Записи modules с load вне SELFTEST_LOADS или с load: null без причины why - имена файлов. */
function badLoadEntries(modules) {
  return modules
    .filter((m) => !SELFTEST_LOADS.includes(m.load) || (m.load === null && !(typeof m.why === 'string' && m.why.trim())))
    .map((m) => m.file);
}
check('модули самопроверки: каждый selftest-* каталога хуков в SELFTEST_MODULES (проба отказа - файл вне перечня)', () => {
  const bad = unlistedSelftest(fs.readdirSync(HOOKS));
  if (bad.length) return 'вне SELFTEST_MODULES: ' + bad.join(', ') + ' - модуль вне перечня не проходит пробы синтаксиса, exit, git и mkdtempSync; допиши его в SELFTEST_MODULES (harness-selftest.js)';
  const sample = unlistedSelftest(['selftest-x.js', 'selftest-y.mjs', 'selftest-z.cjs', 'selftest-graph.js', 'lib.js']);
  if (sample.join() !== 'selftest-x.js,selftest-y.mjs,selftest-z.cjs') return 'файл вне перечня не пойман - сверка слепа: ' + JSON.stringify(sample);
  const badLoad = badLoadEntries(SELFTEST_MODULES);
  if (badLoad.length) return 'поле load вне ' + JSON.stringify(SELFTEST_LOADS) + ' или load: null без why: ' + badLoad.join(', ') + ' - опечатка в load роняет прогон TypeError до report(); исправь запись в SELFTEST_MODULES (harness-selftest.js)';
  const loadSample = badLoadEntries([
    { file: 'a.js', load: 'gate' }, { file: 'b.js', load: null }, { file: 'c.js', load: 'текст причины' },
    { file: 'd.js', load: 'graph' }, { file: 'e.js', load: 'gates' }, { file: 'f.js', load: null, why: 'причина' },
  ]);
  return loadSample.join() === 'a.js,b.js,c.js' || 'неверное поле load не поймано - сверка слепа: ' + JSON.stringify(loadSample);
});

/** Строки текста text, на которых re находит совпадение: номера с 1. */
function linesMatching(text, re) {
  return text.split(/\r?\n/).map((line, i) => (re.test(line) ? i + 1 : 0)).filter(Boolean);
}
/**
 * Модули самопроверки без exit процесса: selftest-vitest.mjs выходит, когда цикл событий опустел
 * (решение техлида Р3 E0-12T: vite снимает свой `<конфиг>.timestamp-*.mjs` неожидаемым unlink, и
 * ранний выход оставил бы файл в дереве); selftest-temp.js процессом не распоряжается (решение
 * техлида B4 E0-12T); прочие модули перечня SELFTEST_MODULES пишут строки через check, и выходом
 * распоряжается только report(). Вне сверки - модули с полем exit (причина - в перечне). Сверка по
 * тексту без комментариев не строится, поэтому запрещено само имя вызова в любом месте файла (сканер
 * linesMatching); сторона отказа - текст со вставленным вызовом.
 */
const EXIT_CALL = /\bprocess\s*\.\s*(?:exit|reallyExit|abort)\b/;
const NO_EXIT_FILES = SELFTEST_MODULES.filter((m) => !m.exit).map((m) => m.file);
check(NO_EXIT_FILES.join(', ') + ' не выходят через exit процесса (Р3, B4), вызов exit в тексте - отказ', () => {
  const bad = [];
  for (const f of NO_EXIT_FILES) {
    for (const n of linesMatching(fs.readFileSync(path.join(HOOKS, f), 'utf8'), EXIT_CALL)) bad.push(f + ':' + n);
  }
  if (bad.length) return 'exit процесса: ' + bad.join(', ');
  return linesMatching('const a = 1;\nprocess' + '.exit(0);\n', EXIT_CALL).join() === '2' || 'вызов exit в тексте не пойман - сверка слепа';
});

/**
 * Модуль самопроверки file (каталог хуков) грузится после пробы синтаксиса (её результат -
 * SYNTAX_OK), как gates.js - после пробы require (gatesModuleSafe). Синтаксическая ошибка - красная
 * строка синтаксиса, исключение при загрузке - одна строка `<file> загружается require`; в обоих
 * случаях null: пробы модуля не гоняются (их называет своя строка), остальные пробы идут.
 */
function loadSelftestModule(file) {
  if (SYNTAX_OK.get(file) !== true) return null;
  try {
    return require(path.join(HOOKS, file));
  } catch (e) {
    fail(file + ' загружается require', (e && e.message) || String(e));
    return null;
  }
}
/**
 * Модуль графа G - объединение экспортов цепочки selftest-turbo.js <- selftest-graph.js <-
 * selftest-stub.js (бинарь и запуск turbo, граф и сверки, стабы). Модуль цепочки грузится, только
 * если загрузились нижние: без любого G = null - пробы графа не гоняются (строка «граф turbo: dry-JSON
 * настоящего дерева» называет их), остальные пробы идут. Имена экспортов цепочки не пересекаются
 * (E0-12U, решение техлида B3 после круга 3): имя, которое уже отдал модуль ниже, - строка
 * `<файл> загружается require` и G = null, а не тихое затенение раннего экспорта поздним.
 */
const G = loadGraphChain();
function loadGraphChain() {
  const merged = {};
  const owner = {};
  for (const m of SELFTEST_MODULES.filter((x) => x.load === 'graph')) {
    const mod = loadSelftestModule(m.file);
    if (!mod) return null;
    const clash = Object.keys(mod).filter((k) => Object.prototype.hasOwnProperty.call(owner, k));
    if (clash.length) {
      fail(m.file + ' загружается require', 'экспорт ' + clash.map((k) => k + ' (уже из ' + owner[k] + ')').join(', ') +
        ' - имена экспортов цепочки модуля графа пересекаются, поздний затенил бы ранний в G; переименуй экспорт');
      return null;
    }
    for (const k of Object.keys(mod)) owner[k] = m.file;
    Object.assign(merged, mod);
  }
  return Object.freeze(merged);
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
/**
 * Пробы standards.js не пишут в боевые src (E0-12D, TECH_DEBT: прерванный прогон оставлял
 * zz_selftest_* под git add -A). Дерево пробы - временный каталог (tempDir) с полной копией
 * .claude/hooks (copyHooksTo: каждый файл и подкаталог байт в байт, repos.json тот же:
 * репозиторий sf - корень копии) и файлами пробы по их путям от корня репозитория, так что glob
 * правил и rules.sf.json те же, что у боевого хука. Каталог снимается в finally (releaseTemp), в
 * том числе после красной строки.
 *   tree.dir              - корень дерева (пробе, которой нужен git в нём);
 *   tree.write(rel, body) - пишет файл пробы и отдаёт абсолютный путь;
 *   tree.standards(rel)   - запуск копии standards.js на этом файле ({ code, out, err }).
 * Хук идёт с CLAUDE_HOOK_DEBUG: исключение внутри L.guard без failClosed даёт код 0 и пустой
 * stdout - ровно как пропуск, - и отличить их можно только по строке HOOK_ERROR в stderr.
 */
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
 * Боевые формы роута: пробы S14 и пропуска standards в модуле роута читают эти файлы как пропуск,
 * поэтому каждый из них выбирает гейт harness-selftest (сверка - в его пробе выбора, selftest-gates.js).
 */
const ROUTE_FORMS = ['apps/api/src/routes/health/index.ts', 'apps/api/src/routes/system/index.ts'];

// ------------------------------------------------------------------ 2a. пробы гейтов
/**
 * Пробы гейтов - модули самопроверки с load: 'gates' (E0-12U, решения техлида Р2 и Р5): запуск
 * gates.js (selftest-gates-run.js), механика int-пробы (selftest-int.js), граф turbo настоящего
 * дерева (selftest-tree-graph.js), корни и корневые скрипты (selftest-roots.js), int-проба прогона
 * (selftest-int-cases.js), выбор гейтов (selftest-gates.js), синтетические кейсы модулей графа
 * (selftest-graph-cases.js). Каждый грузится после пробы синтаксиса (loadSelftestModule) и получает
 * ctx параметром: замороженная общая инфраструктура прогона - одни results, реестр temp,
 * LIVE_CHILDREN, SYNTAX_OK и G на все модули (свой реестр или набор в модуле оставил бы каталоги и
 * детей мимо проверок в конце прогона). Модули друг друга не require. Сборка - в двух местах: этот
 * файл грузит модули, зовёт registerGateRunProbes и createIntProbe и передаёт остальные модули
 * registerGateProbes (selftest-gates.js) в deps; их фабрики (createTreeGraph, createIntRun,
 * createRootProbes, registerGraphCases) зовёт selftest-gates.js в точках прогона, где стоят их строки:
 * им нужны пробы выбора гейта (gateProbe, selects) и снимок GRAPH_GATE, которые создаёт он. Новый
 * модуль проб гейтов - запись в SELFTEST_MODULES, ключ deps здесь и вызов фабрики в selftest-gates.js.
 * Модуль не загрузился - его строка синтаксиса или require и одна строка «пробы гейтов:
 * модули самопроверки загружены» с перечнем не гонявшихся проб; остальной selftest идёт.
 */
const ctx = Object.freeze({
  L, HOOKS, CLAUDE, ROOT, G, SYNTAX_OK, SKIPPED, LISTING_MAX_BUFFER, LIVE_CHILDREN, TEMP, ROUTE_FORMS,
  results, check, outcome, snapshotGate, gateVerdict, refusedCheck, refusalVerdict,
  run, git, tempDir, releaseTemp, absent, readJson, copyHooksTo, killLiveChildren, killLiveChildrenOnExit,
  repoRules,
});
const GATE_FILES = SELFTEST_MODULES.filter((m) => m.load === 'gates').map((m) => m.file);
const GATE_MODULES = new Map(GATE_FILES.map((file) => [file, loadSelftestModule(file)]));
const gateModule = (file) => GATE_MODULES.get(file);
const GATE_RUN = gateModule('selftest-gates-run.js') ? gateModule('selftest-gates-run.js').registerGateRunProbes(ctx) : null;
const GATES = GATE_RUN && GATE_FILES.every((file) => gateModule(file))
  ? gateModule('selftest-gates.js').registerGateProbes(ctx, {
    int: gateModule('selftest-int.js').createIntProbe(ctx),
    gateRun: GATE_RUN,
    treeGraph: gateModule('selftest-tree-graph.js'),
    roots: gateModule('selftest-roots.js'),
    intCases: gateModule('selftest-int-cases.js'),
    cases: gateModule('selftest-graph-cases.js'),
  })
  : null;
if (!GATE_RUN || !GATES) {
  const missing = GATE_FILES.filter((file) => !gateModule(file));
  const blocked = [];
  if (!GATE_RUN) blocked.push('пробы запуска gates.js (selftest-gates-run.js)');
  blocked.push('пробы выбора гейтов, путей note, графа turbo, корней и int-пробы (' + GATE_FILES.filter((file) => file !== 'selftest-gates-run.js').join(', ') + ')');
  blocked.push('мемо прогона и ответ дочернего vitest в конце прогона');
  fail('пробы гейтов: модули самопроверки загружены', 'не загружены: ' + missing.join(', ') + '; не гонялись: ' + blocked.join('; '));
}


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
 * Модуль commit-gate.js для проб, которым нужны его функции (isBootstrap, matchesAny), - одно место
 * require; ленивый: грузится внутри пробы, и сбой загрузки красит её строку, а не весь прогон.
 */
function commitGateModule() {
  return require('./commit-gate.js');
}
/**
 * Временный репозиторий пробы не берёт из настроек машины ничего, что исполняет код, - как в
 * пробе сверки дерева: init без шаблонов (`--template=`), коммит через git(…, { isolated }) -
 * core.hooksPath на пустой каталог, без подписи и fsmonitor. Иначе глобальный pre-commit красит
 * пробу или исполняется в ней.
 */
check('commit-gate: isBootstrap - true без коммитов, false после первого', () => {
  const { isBootstrap } = commitGateModule();
  const tmp = tempDir('boot');
  const env = gitIdentityEnv();
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

/**
 * Исключения замка ослаблений (commitGate.weakeningExempt) - ровно этот перечень (E0-12U, ревью круга 1):
 * исключённый файл замок не смотрит целиком, и настоящее `|| true` или `.skip(` в нём проходит молча.
 * Модули самопроверки selftest-*.js не исключены - литералы проб в них склеены из частей. Расширение
 * перечня - правка этой пробы и причина в weakeningExemptNote.
 */
const WEAKENING_EXEMPT = ['**/*.md', '.claude/hooks/rules.*.json', '.claude/hooks/harness-selftest.js'];
/** Вердикт перечня исключений list с заметкой note: ровно WEAKENING_EXEMPT, у каждого - причина в заметке. */
function weakeningExemptVerdict(list, note) {
  if (JSON.stringify(list) !== JSON.stringify(WEAKENING_EXEMPT)) {
    return 'weakeningExempt ' + JSON.stringify(list) + ', ожидался ' + JSON.stringify(WEAKENING_EXEMPT) +
      ' - исключение из замка ослаблений расширяется только правкой WEAKENING_EXEMPT в harness-selftest.js и причиной в weakeningExemptNote';
  }
  const noWhy = list.filter((g) => !String(note || '').includes(g));
  return !noWhy.length || 'в weakeningExemptNote нет причины для ' + noWhy.join(', ');
}
check('commitGate.weakeningExempt - ровно ожидаемый перечень с причиной на каждый, модули самопроверки не исключены (проба отказа - расширенный перечень)', () => {
  const gate = (common && common.commitGate) || {};
  const live = weakeningExemptVerdict(gate.weakeningExempt, gate.weakeningExemptNote);
  if (live !== true) return live;
  if (weakeningExemptVerdict(WEAKENING_EXEMPT.concat('.claude/hooks/selftest-gates.js'), gate.weakeningExemptNote) === true) return 'расширенный перечень принят - сверка слепа';
  // сопоставление - matchesAny самого commit-gate.js (путь от корня и метка <репозиторий>/<путь>), не копия
  const { matchesAny } = commitGateModule();
  const exempted = (globs) => SELFTEST_MODULES.map((m) => '.claude/hooks/' + m.file)
    .filter((f) => L.knownRepos().some((repo) => matchesAny(globs, repo, f)));
  const covered = exempted(gate.weakeningExempt);
  if (covered.length) return 'модули самопроверки под исключением: ' + covered.join(', ');
  const labelled = L.knownRepos().map((repo) => repo.name + '/.claude/hooks/**');
  return exempted(labelled).length === SELFTEST_MODULES.length || 'исключение с меткой репозитория (' + labelled.join(', ') + ') не сопоставлено с модулями - сверка слепа';
});
/**
 * Живая проба замка ослаблений на копии хуков (withScratchTree, репозиторий без коммитов - isBootstrap,
 * /qa и гейты не спрашиваются). Пропуск и отказ - по решению хука, а не по строкам [W..] (E0-12U,
 * решение техлида B1 после круга 3): чистая копия - не deny; строка с W02 в конце исключённого
 * harness-selftest.js - не deny; та же строка в конце selftest-gates.js (вне исключений) - deny,
 * отказ называет его с номером строки и не называет исключённый файл. Литерал склеен: иначе его
 * поймал бы замок на этом файле.
 */
check('commit-gate: W02 в модуле самопроверки вне weakeningExempt - отказ с файлом и строкой, тот же литерал в исключённом harness-selftest.js - пропуск', () => {
  const env = gitIdentityEnv();
  return withScratchTree((tree) => {
    gitStrict(['init', '-q', '--template=', '-b', 'main'], { cwd: tree.dir, env, isolated: true });
    const hooks = path.join(tree.dir, '.claude', 'hooks');
    const commit = () => probe('commit-gate.js', { tool_input: { command: 'git commit -m "feat: x"' } }, tree.dir, hooks, { CLAUDE_HOOK_DEBUG: '1' });
    const weak = (r) => r.out.match(/[\w./-]+:\d+ {2}\[W0\d\]/g) || [];
    // решение хука: L.deny - JSON с permissionDecision deny и код 0; строки [W..] без него - не отказ
    const decision = (r) => {
      try {
        return r.code === 0 ? JSON.parse(r.out).hookSpecificOutput.permissionDecision : 'код ' + r.code;
      } catch (_) {
        return 'не JSON: ' + JSON.stringify(r.out.slice(0, 120));
      }
    };
    const clean = commit();
    if (clean.err.includes(HOOK_ERROR)) return 'commit-gate.js упал внутри guard - ' + clean.err.slice(0, 160);
    if (decision(clean) === 'deny') return 'чистая копия хуков: коммит запрещён - ' + (weak(clean).join(', ') || clean.out.slice(0, 160));
    const line = 'const cmd = "next build |' + '| true";';
    const planted = (file) => {
      const p = path.join(hooks, file);
      fs.appendFileSync(p, '\n' + line + '\n');
      return fs.readFileSync(p, 'utf8').split(/\r?\n/).lastIndexOf(line) + 1;
    };
    planted('harness-selftest.js');
    const exempt = commit();
    if (decision(exempt) === 'deny') return 'ослабление в исключённом harness-selftest.js: коммит запрещён - ' + (weak(exempt).join(', ') || exempt.out.slice(0, 160));
    const at = planted('selftest-gates.js');
    const refused = commit();
    const got = weak(refused);
    const want = 'sf/.claude/hooks/selftest-gates.js:' + at + '  [W02]';
    if (!got.includes(want)) return 'нет отказа «' + want + '»: ' + (got.join(', ') || 'ни одного [W..]');
    if (decision(refused) !== 'deny') return 'ослабление названо, но коммит не запрещён: решение ' + JSON.stringify(decision(refused));
    const stray = got.filter((x) => x !== want);
    return !stray.length || 'лишние отказы (исключённый файл не пропущен?): ' + stray.join(', ');
  });
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
  const env = gitIdentityEnv();
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

/** Файлы, чей текст сверяет статический кейс помощника git: этот файл и каждый модуль самопроверки. */
const HELPER_SCANNED = ['harness-selftest.js', ...SELFTEST_MODULES.map((m) => m.file)];
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
check('git: в ' + HELPER_SCANNED.join(', ') + ' ни одного вызова git мимо помощника git() и имени git в кавычках вне GIT_BIN (проба отказа - литерал, переменная, выражение, execSync, вызов на двух строках, имя в переменной)', () => {
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
  // каждый модуль самопроверки (E0-12U) - по полю mkdtemp перечня SELFTEST_MODULES, без поля - ноль
  const want = { 'harness-selftest.js': 0 };
  for (const m of SELFTEST_MODULES) want[m.file] = m.mkdtemp || 0;
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
// Без модулей проб гейтов обе строки ниже не гонялись: их называет строка «пробы гейтов: модули
// самопроверки загружены» (GATES - отдача registerGateProbes, selftest-gates.js).
if (GATES) {
  check('мемо прогона: корневой package.json прочитан с диска один раз, gateProbe спрашивает gates.js о файле один раз', () => {
    const reads = GATES.rootPkgReads();
    if (reads !== 1) return 'корневой package.json прочитан ' + reads + ' раз(а)';
    const twice = [];
    let asked = 0;
    let selected = 0;
    for (const [id, p] of GATES.gateProbes) {
      asked += p.asked;
      selected += p.selected;
      if (p.selected !== p.seen.size) twice.push(id + ': ' + p.selected + ' вызовов selects на ' + p.seen.size + ' файлов');
    }
    if (twice.length) return 'gates.js спрошен о файле больше одного раза: ' + twice.join('; ');
    return asked > selected || 'мемо gateProbe ни разу не сработало (' + asked + ' вопросов, ' + selected + ' вызовов) - сверка слепа';
  });

  // Строка снимка VITEST_GATE - после всех проб, которым нужен ответ дочернего vitest: отказ
  // (не стартовал, не ответил, иная форма) - одна строка с перечнем не гонявшихся проб.
  const { intGuard, VITEST_GATE } = GATES;
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
