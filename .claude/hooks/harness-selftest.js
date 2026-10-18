#!/usr/bin/env node
'use strict';
/**
 * harness-selftest.js - самопроверка обвязки. Запускается руками, гейтом `harness-selftest`
 * (rules.sf.json: .claude/** и файлы проекта, которые читают пробы гейтов build и test:int,
 * перечень - glob гейта) и установщиком install.ps1.
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
  'gates.js',
];

const results = [];
function ok(name, note) { results.push({ ok: true, name, note }); }
function fail(name, note) { results.push({ ok: false, name, note }); }
function check(name, fn) {
  try {
    const r = fn();
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
const PROBE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-selftest-state-'));
process.env.SF_HOOK_STATE_DIR = PROBE_STATE_DIR;
process.on('exit', () => fs.rmSync(PROBE_STATE_DIR, { recursive: true, force: true }));
process.on('SIGINT', () => process.exit(130));

/** Запуск хука с JSON на stdin. Возвращает { code, out, err }. */
function probe(hook, input, cwd) {
  const env = Object.assign({}, process.env, { SF_HOOK_STATE_DIR: PROBE_STATE_DIR });
  const r = run(process.execPath, [path.join(HOOKS, hook)], { input: JSON.stringify(input), cwd: cwd || ROOT, env });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
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
 * selectGates из самого gates.js, а не её повтор (L-008): правка обработки when там
 * обязана краснеть здесь. gates.js - скрипт: main() исполняется при загрузке и выходит
 * через process.exit, функции он не экспортирует. Поэтому исходник исполняется в
 * отдельном контексте vm: argv - `--help` (main() печатает справку в заглушённую консоль
 * и возвращает ran:false - отметки о прогоне нет, гейты не запускаются), process.exit -
 * заглушка. Объявления функций верхнего уровня скрипта становятся свойствами контекста.
 */
function loadSelectGates() {
  const vm = require('vm');
  const file = path.join(HOOKS, 'gates.js');
  // шебанг заменяется пустой строкой, номера строк в стеке не сдвигаются
  const src = fs.readFileSync(file, 'utf8').replace(/^#!.*/, '');
  const silent = { log() {}, error() {}, warn() {} };
  const sandbox = {
    require,
    console: silent,
    process: { argv: [process.execPath, file, '--help'], env: process.env, exit() {} },
    __dirname: HOOKS,
    __filename: file,
  };
  vm.runInNewContext(src, sandbox, { filename: file });
  if (typeof sandbox.selectGates !== 'function') throw new Error('в gates.js нет функции selectGates');
  return sandbox.selectGates;
}

/**
 * Гейт id из rules.sf.json и runs(file) - выбирает ли его настоящий selectGates на одном
 * изменённом файле при полном прогоне (без --only). Вызов selectGates в пробах - только здесь. gates.js загружается в vm один раз
 * на весь прогон, проба каждого гейта - тоже. Нет гейта - исключение (красная строка check).
 */
let loadedSelectGates = null;
const gateProbes = new Map();
function gateProbe(id) {
  if (gateProbes.has(id)) return gateProbes.get(id);
  const gate = ((repoRules && repoRules.gates) || []).find((g) => g.id === id);
  if (!gate) throw new Error('гейта ' + id + ' нет в правилах');
  if (!loadedSelectGates) loadedSelectGates = loadSelectGates();
  const selectGates = loadedSelectGates;
  const runs = (file) => {
    const picked = selectGates([gate], [file], null);
    return Boolean(picked && picked[0] && picked[0].run);
  };
  const res = { gate, runs };
  gateProbes.set(id, res);
  return res;
}

/**
 * Общий каркас пробы гейта по glob (L-008): решение принимает настоящий selectGates,
 * своей копии разбора when нет. Выбор, пропуск и дополнительные проверки - отдельные
 * строки: отказ одной не скрывает состояние другой.
 *   spec.runWhat / spec.skipWhat - хвосты названий строк выбора и пропуска;
 *   spec.mustRun / spec.mustSkip - файлы, на которых гейт обязан выбираться / пропускаться;
 *   spec.extra - [{ name, fn({ gate, runs }) }], результат fn - как у check.
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
  for (const x of spec.extra || []) check('гейт ' + id + ': ' + x.name, () => x.fn(gateProbe(id)));
}

// Гейт по glob, ошибка в шаблоне, в его разборе или в пути скрипта не краснеет,
// а молча выключает гейт (E0-11).
checkGateSelection('compose', {
  runWhat: 'файлах Compose',
  skipWhat: 'посторонних',
  mustRun: [
    'compose.yaml',
    'infra/docker-compose.yml',
    'infra/docker-compose.app.yml',
    'infra/docker/api.Dockerfile',
    'scripts/check-compose.mjs',
    'scripts/compose-rules.mjs',
    '.dockerignore',
    'infra/docker/worker.Dockerfile.dockerignore',
  ],
  // Манифесты приложений check-compose не читает: выбор на них обещал бы
  // проверку, которой нет (E0-11, круг 7-2).
  mustSkip: ['apps/web/src/app/page.tsx', 'apps/api/package.json', 'apps/worker/package.json', 'apps/web/package.json', 'apps/api/src/package.json', 'x.dockerignore', 'docs/30_E0_TASKS.md', 'README.md', 'scripts/tasks.mjs', 'xinfra/a.yml'],
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
  ],
});

/**
 * Пакеты workspace по pnpm-workspace.yaml: { имя: { dir, pkg, transpile } }. Разбор
 * простой - строки `- 'шаблон'` под ключом packages:, шаблон - каталог или каталог/*;
 * комментарии и пустые строки пропускаются; иная строка внутри packages: и иной шаблон
 * (!, **, другие маски) - исключение, а не молчаливый пропуск.
 * transpile - transpilePackages из next.config.* пакета ([] без next.config).
 * Снимок один на прогон: пробы build, test:int и harness-selftest видят одни и те же данные;
 * стабы снимок не правят, а строят копию.
 */
const NEXT_CONFIGS = ['next.config.ts', 'next.config.mts', 'next.config.js', 'next.config.mjs', 'next.config.cjs'];
let wsSnapshot = null;
function workspacePackages() {
  if (!wsSnapshot) wsSnapshot = readWorkspacePackages();
  return wsSnapshot;
}
function readWorkspacePackages() {
  const text = fs.readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const patterns = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    // комментарий в любой колонке и пустая строка блок packages: не закрывают
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) { inPackages = /^packages\s*:/.test(line); continue; }
    if (!inPackages) continue;
    const m = /^\s*-\s*(["']?)([^"'#]*?)\1\s*(?:#.*)?$/.exec(line);
    if (!m) throw new Error('строка packages: в pnpm-workspace.yaml не разбирается пробой: ' + line.trim());
    patterns.push(m[2].trim());
  }
  if (!patterns.length) throw new Error('в pnpm-workspace.yaml нет шаблонов packages');
  const dirs = [];
  for (const pat of patterns) {
    if (/^[\w.@-]+(?:\/[\w.@-]+)*\/\*$/.test(pat)) {
      const base = pat.slice(0, -2);
      const abs = path.join(ROOT, base);
      if (!fs.existsSync(abs)) continue;
      for (const d of fs.readdirSync(abs, { withFileTypes: true })) if (d.isDirectory()) dirs.push(base + '/' + d.name);
    } else if (/^[\w.@-]+(?:\/[\w.@-]+)*$/.test(pat)) {
      dirs.push(pat);
    } else {
      throw new Error('шаблон pnpm-workspace.yaml не разбирается пробой: ' + pat);
    }
  }
  const ws = {};
  for (const dir of dirs) {
    const manifest = path.join(ROOT, dir, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const pkg = readJson(manifest);
    if (!pkg.name) continue;
    const cfg = NEXT_CONFIGS.map((f) => path.join(ROOT, dir, f)).find((p) => fs.existsSync(p));
    ws[pkg.name] = { dir, pkg, transpile: cfg ? stringArrayAt(fs.readFileSync(cfg, 'utf8'), 'transpilePackages', dir + '/' + path.basename(cfg), { required: false }) : [] };
  }
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
 * общий разбор transpilePackages (next.config) и setupFiles (конфиг vitest). Ключа нет -
 * [] при required: false, исключение при required: true. Ключ встречается больше одного раза
 * или значение не массив строковых литералов (переменная, spread, вызов, одна строка) -
 * исключение: молчаливый [] или первое из двух вхождений спрятали бы то, что читает гейт.
 */
function stringArrayAt(src, key, file, opts) {
  const code = stripJsComments(src);
  const hits = code.match(new RegExp('\\b' + key + '\\b', 'g')) || [];
  if (!hits.length) {
    if (opts.required) throw new Error(key + ' в ' + file + ' нет - разбери руками');
    return [];
  }
  if (hits.length > 1) throw new Error(key + ' в ' + file + ' встречается ' + hits.length + ' раза - разбери руками');
  const m = new RegExp('\\b' + key + '\\s*:\\s*\\[([^\\]]*)\\]').exec(code);
  const STR = /"[^"]*"|'[^']*'|`[^`$]*`/g;
  if (!m || m[1].replace(STR, '').replace(/[\s,]/g, '') !== '') {
    throw new Error(key + ' в ' + file + ' не массив строковых литералов - разбери руками');
  }
  return (m[1].match(STR) || []).map((s) => s.slice(1, -1));
}

/**
 * Файл конфига vitest из скрипта пакета: значение `--config <файл>` / `--config=<файл>`.
 * Флага нет - исключение: без него vitest берёт vitest.config.*, и проба сверяла бы не тот
 * конфиг, которым гоняется скрипт.
 */
function vitestConfigOf(script, owner) {
  const m = /(?:^|\s)--config(?:=|\s+)(\S+)/.exec(String(script || ''));
  if (!m) throw new Error('скрипт ' + owner + ' не называет конфиг через --config: ' + JSON.stringify(script) + ' - разбери руками');
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
 * Последний элемент - сам модуль. Пакета нет в workspace, нет строки exports, иная форма
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
  if (!dep) throw new Error(who + ': ' + m[1] + ' нет в workspace');
  const target = dep.pkg.exports && dep.pkg.exports['./' + m[2]];
  if (typeof target !== 'string') throw new Error(who + ': у ' + m[1] + ' нет строки exports["./' + m[2] + '"]');
  const rel = path.posix.normalize(dep.dir + '/' + target);
  if (!src.exists(rel)) throw new Error(who + ': файла ' + rel + ' (' + spec + ') нет на диске');
  return [dep.dir + '/package.json', rel];
}

/**
 * Пакеты workspace со scripts[script] - их запускает turbo run <script>.
 */
function scriptRoots(ws, script) {
  return Object.keys(ws).filter((n) => ws[n].pkg.scripts && ws[n].pkg.scripts[script]);
}

/**
 * Всё, что читает проба test:int сверх графа пакетов, - и что читают сами int-тесты:
 * конфиг из --config скрипта пакета, модули его setupFiles (`./` - от каталога конфига),
 * модуль, из которого setup импортирует testEnvFilePath, и сама фикстура - файл в корне
 * из `join(repoRoot, "<файл>")`. Setup без импорта testEnvFilePath, иная форма
 * testEnvFilePath, нет файла - исключение. Возвращает [{ file, why }] без повторов.
 */
function intProbeReads(ws, roots, src) {
  const out = new Map();
  const add = (file, why) => { if (!out.has(file)) out.set(file, why); };
  const IMPORT = /\bimport\s*\{([^}]*)\}\s*from\s*(["'])([^"']+)\2/g;
  for (const name of roots) {
    const cfg = path.posix.normalize(ws[name].dir + '/' + vitestConfigOf(ws[name].pkg.scripts['test:int'], name));
    if (!src.exists(cfg)) throw new Error('конфига ' + cfg + ' (--config скрипта test:int ' + name + ') нет на диске');
    add(cfg, '--config test:int ' + name);
    for (const spec of stringArrayAt(src.read(cfg), 'setupFiles', cfg, { required: true })) {
      const files = moduleReads(spec, path.posix.dirname(cfg), ws, src, 'setupFiles ' + name);
      const setup = files[files.length - 1];
      for (const f of files) add(f, 'setupFiles ' + name);
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

/**
 * Стаб для детектора intProbeReads: пакет со scripts['test:int'] в каталоге hostDir, его конфиг
 * берёт setup из пакета peer (вне glob test:int), setup импортирует testEnvFilePath из соседнего
 * модуля. Возвращает { ws, roots, src, expect } - expect: setup-файл, который детектор обязан
 * назвать. Снимок workspace не правится.
 */
function intProbeStub(ws, hostDir, peer) {
  const p = ws[peer];
  const stubWs = Object.assign({}, ws, {
    [peer]: Object.assign({}, p, { pkg: Object.assign({}, p.pkg, { exports: { './vitest/selftest-setup': './vitest/selftest-setup.ts' } }) }),
    '@sf/selftest-stub': { dir: hostDir, pkg: { scripts: { 'test:int': 'vitest run --config vitest.selftest.config.ts' } }, transpile: [] },
  });
  const setup = p.dir + '/vitest/selftest-setup.ts';
  const src = overlaySource({
    [hostDir + '/vitest.selftest.config.ts']: 'export default { test: { setupFiles: ["' + peer + '/vitest/selftest-setup"] } };',
    [setup]: 'import { testEnvFilePath } from "./selftest-paths.js";\n',
    [p.dir + '/vitest/selftest-paths.ts']: 'export const testEnvFilePath = join(repoRoot, ".env.test");\n',
  });
  return { ws: stubWs, roots: ['@sf/selftest-stub'], src, expect: setup };
}

/**
 * Пакеты workspace, у которых есть scripts[script] (их запускает turbo run <script>), и всё,
 * что они читают: транзитивные workspace-зависимости (dependencies, devDependencies,
 * peerDependencies, optionalDependencies) и transpilePackages. Имена вне workspace
 * (сторонние npm) не учитываются. Возвращает { roots, read, bad } - bad: пакеты,
 * правка которых не выбирает гейт (runs - его проба).
 */
function uncoveredScriptPackages(runs, ws, script) {
  const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  const reads = (entry) => {
    const names = [];
    for (const f of DEP_FIELDS) names.push.apply(names, Object.keys(entry.pkg[f] || {}));
    return names.concat(entry.transpile || []).filter((n) => ws[n]);
  };
  const roots = scriptRoots(ws, script);
  const seen = new Set();
  const queue = roots.slice();
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push.apply(queue, reads(ws[name]));
  }
  const bad = [];
  for (const name of seen) {
    const dir = ws[name].dir;
    if (!runs(dir + '/package.json') || !runs(dir + '/src/index.ts')) bad.push(name + ' (' + dir + ')');
  }
  return { roots, read: Array.from(seen), bad };
}

/**
 * Проба графа гейта, который гоняет turbo run <script> (extra-строка checkGateSelection):
 * пакеты workspace со scripts[script], их транзитивные workspace-зависимости и файлы
 * opts.extraReads(ws, roots, src) ([{ file, why }]) обязаны выбирать гейт.
 * Детекторы не слепые: стаб-пакет со scripts[script] и peer-зависимостью на opts.stubPeer
 * (пакет вне glob гейта) обязан дать отказ; при extraReads - и стаб opts.extraStub(ws, hostDir,
 * stubPeer) (его expect обязан попасть в отказ). opts.label - кто читает, с глаголом (в тексте отказа).
 */
function checkScriptGraph(script, opts) {
  const key = /^\w+$/.test(script) ? 'scripts.' + script : "scripts['" + script + "']";
  const outside = (runs, reads) => reads.filter((r) => !runs(r.file));
  return ({ gate, runs }) => {
    const ws = workspacePackages();
    const real = uncoveredScriptPackages(runs, ws, script);
    if (!real.roots.length) return 'ни у одного пакета workspace нет ' + key + ' - гейту ' + gate.id + ' нечего запускать';
    const extra = opts.extraReads ? opts.extraReads(ws, real.roots, DISK) : [];
    const bad = real.bad.concat(outside(runs, extra).map((r) => r.file + ' (' + r.why + ')'));
    if (bad.length) return opts.label + ' вне glob ' + gate.id + ': ' + bad.join(', ') + ' - расширь glob ' + gate.id;
    if (!ws[opts.stubPeer]) return 'в workspace нет ' + opts.stubPeer + ' - стаб-проба детектора не строится';
    const hostDir = ws[real.roots[0]].dir;
    const stub = Object.assign({}, ws, {
      '@sf/selftest-stub': { dir: hostDir, pkg: { scripts: { [script]: 'x' }, peerDependencies: { [opts.stubPeer]: 'workspace:*' } }, transpile: [] },
    });
    if (!uncoveredScriptPackages(runs, stub, script).bad.some((b) => b.startsWith(opts.stubPeer + ' '))) {
      return 'проба не замечает ' + opts.stubPeer + ' вне glob ' + gate.id + ' в стаб-данных';
    }
    if (opts.extraReads) {
      const s = opts.extraStub(ws, hostDir, opts.stubPeer);
      if (!outside(runs, opts.extraReads(s.ws, s.roots, s.src)).some((r) => r.file === s.expect)) {
        return 'проба не замечает ' + s.expect + ' вне glob ' + gate.id + ' в стаб-данных extraReads';
      }
    }
    return { note: script + ': ' + real.roots.join(', ') + '; читает: ' + real.read.join(', ') + (extra.length ? ' и ' + extra.length + ' файлов конфигов' : '') + '; workspace ' + Object.keys(ws).length };
  };
}

/**
 * extra-строка гейта, который гоняет корневой скрипт: cmd гейта gateId - ровно `pnpm <script>`,
 * scripts[script] корневого package.json - ровно expected. Точное равенство: лишний флаг
 * (--dry, --filter, --passWithNoTests) выключил бы проверку при зелёном гейте.
 */
function rootScriptCheck(gateId, script, expected) {
  const key = /^\w+$/.test(script) ? 'scripts.' + script : "scripts['" + script + "']";
  return {
    name: 'cmd pnpm ' + script + ' и ' + key + ' = ' + expected + ' в корневом package.json',
    fn: ({ gate }) => {
      if (gate.cmd !== 'pnpm ' + script) return 'cmd гейта ' + gateId + ' не pnpm ' + script + ': ' + gate.cmd;
      const pkg = readJson(path.join(ROOT, 'package.json'));
      const actual = pkg.scripts && pkg.scripts[script];
      if (actual !== expected) return key + ' в корневом package.json не ' + expected + ': ' + JSON.stringify(actual);
      return true;
    },
  };
}

// Сборка web (next build, ADR-0005) читает только apps/web и его пакеты; glob гейта
// build сужен до них и корневых конфигов (E0-01A, docs/DECISIONS.md 11.10.2026).
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
    rootScriptCheck('build', 'build', 'turbo run build'),
    {
      name: 'пакеты со scripts.build и всё, что они читают, под glob',
      fn: checkScriptGraph('build', { label: 'сборка читает', stubPeer: '@sf/db' }),
    },
  ],
});

// Юнит-тесты читают и не-исходники (rules.sf.json, ci.yml, infra/docker/**), поэтому гейт test
// always: выбор на одном файле не отличает always от glob, правило сверяется прямо (E0-02A, L-014).
{
  // файл вне glob всех остальных гейтов: выбор на нём даёт только when always
  const TEST_RUN = 'docs/30_E0_TASKS.md';
  check('гейт test: when always', () => {
    const { gate } = gateProbe('test');
    return gate.when === 'always' || 'when гейта test не always: ' + gate.when;
  });
  check('гейт test: gates.js выбирает его на файле вне всех glob (' + TEST_RUN + ')', () => {
    const { runs } = gateProbe('test');
    return runs(TEST_RUN) || 'gates.js не выбирает его на ' + TEST_RUN;
  });
  const cmd = rootScriptCheck('test', 'test', 'turbo run test test:repo');
  check('гейт test: ' + cmd.name, () => cmd.fn(gateProbe('test')));
  // cmd гейта - pnpm test, поэтому test:repo сверяется как скрипт, точным равенством: echo или
  // --passWithNoTests выключили бы корневые тесты (замок «копий нет» пресета) при зелёном гейте
  check("гейт test: scripts['test:repo'] = vitest run --config vitest.repo.config.mts в корневом package.json", () => {
    const pkg = readJson(path.join(ROOT, 'package.json'));
    const actual = pkg.scripts && pkg.scripts['test:repo'];
    const expected = 'vitest run --config vitest.repo.config.mts';
    return actual === expected || "scripts['test:repo'] в корневом package.json не " + expected + ': ' + JSON.stringify(actual);
  });
}

// Гейт typecheck гоняет и пакеты, и корневой проект (tsconfig.json корня: test/, vitest.preset.ts,
// vitest.repo.config.mts - ADR-0011): выпавший typecheck:repo оставил бы корневые тесты без tsc.
{
  check('гейт typecheck: when always', () => {
    const { gate } = gateProbe('typecheck');
    return gate.when === 'always' || 'when гейта typecheck не always: ' + gate.when;
  });
  const cmd = rootScriptCheck('typecheck', 'typecheck', 'turbo run typecheck typecheck:repo');
  check('гейт typecheck: ' + cmd.name, () => cmd.fn(gateProbe('typecheck')));
  // cmd гейта - pnpm typecheck, поэтому typecheck:repo сверяется как скрипт, точным равенством
  check("гейт typecheck: scripts['typecheck:repo'] = tsc -p tsconfig.json в корневом package.json", () => {
    const pkg = readJson(path.join(ROOT, 'package.json'));
    const actual = pkg.scripts && pkg.scripts['typecheck:repo'];
    return actual === 'tsc -p tsconfig.json' || "scripts['typecheck:repo'] в корневом package.json не tsc -p tsconfig.json: " + JSON.stringify(actual);
  });
}

// Int-тесты api, worker, db читают свои пакеты, их зависимости, @sf/config/vitest/setup,
// корневой vitest.preset.ts (ADR-0011) и корневой .env.test; glob гейта test:int - по факту чтения (docs/DECISIONS.md 11.10.2026, E0-02A, вопрос «Селектор гейта test:int: буква эпика, glob по графу зависимостей или always»).
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
    rootScriptCheck('test:int', 'test:int', 'turbo run test:int --concurrency=1'),
    {
      name: "пакеты со scripts['test:int'], всё, что они читают, конфиги --config, setupFiles и фикстура testEnvFilePath под glob",
      fn: checkScriptGraph('test:int', {
        label: 'int-тесты читают',
        stubPeer: '@sf/api-client',
        extraReads: intProbeReads,
        extraStub: intProbeStub,
      }),
    },
  ],
});

// Проба графа test:int выше читает не только .claude/**, но и файлы проекта (манифесты, конфиги
// int-тестов, setup, фикстуру): гейт самопроверки обязан выбираться на каждом из них, иначе
// устаревший glob test:int уйдёт молча. Файлы пробы build (манифесты, конфиги сборки) здесь
// перечислены как есть, но сверки "каждый прочитанный файл" для build нет - долг E0-12D (docs/DECISIONS.md 11.10.2026, E0-02A, вопрос «гейт harness-selftest не выбирается на файлах, которые читает проба графа test:int»).
// turbo.json ни одна проба не читает - выбор на нём обещал бы сверку, которой нет.
checkGateSelection('harness-selftest', {
  runWhat: '.claude/** и файлах проекта, которые читают пробы build и test:int',
  skipWhat: 'исходниках, lockfile, turbo.json и docs',
  mustRun: [
    '.claude/hooks/gates.js',
    '.claude/hooks/rules.sf.json',
    '.claude/agents/worker.md',
    'package.json',
    'apps/web/package.json',
    'apps/api/package.json',
    'packages/core/package.json',
    'packages/integrations/youtube/package.json',
    'apps/web/next.config.ts',
    'apps/web/next.config.mjs',
    'packages/core/next.config.js',
    'pnpm-workspace.yaml',
    'apps/api/vitest.int.config.ts',
    'apps/worker/vitest.int.config.ts',
    'packages/db/vitest.int.config.ts',
    'packages/config/src/paths.ts',
    'packages/config/vitest/setup.ts',
    '.env.test',
  ],
  mustSkip: [
    'turbo.json',
    'apps/api/.env.test',
    'apps/api/vitest.config.ts',
    'packages/config/src/index.ts',
    'xapps/api/vitest.int.config.ts',
    'docs/apps/api/vitest.int.config.ts',
    'apps/web/src/app/page.tsx',
    'packages/core/src/index.ts',
    'pnpm-lock.yaml',
    'apps/api/src/server.ts',
    'docs/30_E0_TASKS.md',
    'README.md',
    'scripts/tasks.mjs',
    'xapps/web/package.json',
    'docs/apps/web/package.json',
  ],
  extra: [
    {
      // файлы берутся тем же intProbeReads, что и в пробе test:int: конфиг из --config с любым
      // именем, setup-модули, модуль testEnvFilePath, фикстура
      name: 'его выбирает каждый файл, который читает проба test:int',
      fn: ({ runs }) => {
        const ws = workspacePackages();
        const reads = intProbeReads(ws, scriptRoots(ws, 'test:int'), DISK);
        const stray = reads.filter((r) => !runs(r.file));
        if (stray.length) return 'проба test:int читает вне glob harness-selftest: ' + stray.map((r) => r.file + ' (' + r.why + ')').join(', ');
        return { note: reads.length + ' файлов' };
      },
    },
  ],
});

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
check('commit-gate: isBootstrap - true без коммитов, false после первого', () => {
  const { isBootstrap } = require('./commit-gate.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-boot-'));
  const env = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@x', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@x' });
  try {
    run('git', ['init', '-q', '-b', 'main'], { cwd: tmp });
    if (!isBootstrap(tmp)) return 'репозиторий без коммитов не опознан как bootstrap';
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'a');
    run('git', ['add', 'a.txt'], { cwd: tmp, env });
    run('git', ['commit', '-q', '-m', 'chore: init'], { cwd: tmp, env });
    if (isBootstrap(tmp)) return 'репозиторий с коммитом всё ещё bootstrap';
    return true;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
check('commit-gate: пропуск не-git команды', () => {
  const r = probe('commit-gate.js', { tool_input: { command: 'pnpm typecheck && ls -la' } }, CWD);
  return r.code === 0 && !r.out ? true : 'неожиданный ответ: ' + (r.out || r.err).slice(0, 120);
});
check('standards: замечание на any и console в новом файле, тишина на чистом', () => {
  const dir = path.join(ROOT, 'packages/core/src');
  const bad = path.join(dir, 'zz_selftest_bad.ts');
  const good = path.join(dir, 'zz_selftest_good.ts');
  fs.writeFileSync(bad, 'export const x: any = 1;\nconsole.log(x);\n');
  fs.writeFileSync(good, 'export const y: number = 1;\n');
  try {
    const r1 = probe('standards.js', { tool_input: { file_path: bad } }, CWD);
    const r2 = probe('standards.js', { tool_input: { file_path: good } }, CWD);
    if (r1.code !== 2 || !/S01/.test(r1.err) || !/S03/.test(r1.err)) return 'any/console не пойманы: код ' + r1.code + ' ' + r1.err.slice(0, 160);
    if (r2.code !== 0 || r2.err) return 'чистый файл получил замечание: ' + r2.err.slice(0, 120);
    return true;
  } finally {
    fs.unlinkSync(bad);
    fs.unlinkSync(good);
  }
});
/**
 * @sf/runtime (E0-12B, ADR-0012) - код процессов api и worker: console и process.env в его src
 * ловятся так же, как в apps; тесты пакета не ловятся (L-008: отказ и пропуск на боевом пути).
 */
check('standards: console и process.env в packages/runtime/src пойманы, в его test - нет', () => {
  const srcDir = path.join(ROOT, 'packages/runtime/src');
  const testDir = path.join(ROOT, 'packages/runtime/test');
  if (!fs.existsSync(srcDir) || !fs.existsSync(testDir)) return 'нет packages/runtime/src или packages/runtime/test';
  const body = 'export const u = process.env.SF_X;\nconsole.log(u);\n';
  const bad = path.join(srcDir, 'zz_selftest_bad.ts');
  const good = path.join(testDir, 'zz_selftest.test.ts');
  fs.writeFileSync(bad, body);
  fs.writeFileSync(good, body);
  try {
    const r1 = probe('standards.js', { tool_input: { file_path: bad } }, CWD);
    const r2 = probe('standards.js', { tool_input: { file_path: good } }, CWD);
    if (r1.code !== 2 || !/S03/.test(r1.err) || !/S05/.test(r1.err)) return 'console/process.env в src не пойманы: код ' + r1.code + ' ' + r1.err.slice(0, 160);
    if (/S03|S05/.test(r2.err)) return 'тест пакета получил S03/S05: ' + r2.err.slice(0, 160);
    return true;
  } finally {
    fs.unlinkSync(bad);
    fs.unlinkSync(good);
  }
});
/**
 * S11 (E0-12B): web не тянет серверные пакеты - ни корнем, ни подпутём (`@sf/runtime/redis` грузит
 * ioredis, `@sf/config/redis-url` читает REDIS_URL, `@sf/db/test-support/*` - Postgres), ни побочным
 * `import "@sf/..."`, ни реэкспортом. Пропуск - на том, чем web пользуется: `@sf/config/server`
 * (помечен server-only), `@sf/api-client/server`, `@sf/contracts`, побочный `import "server-only"`
 * (L-008: отказ каждой формы и пропуск на боевом пути).
 */
check('standards: серверные пакеты в apps/web/src (корень, подпуть, побочный импорт) пойманы S11, вход web - нет', () => {
  const webDir = path.join(ROOT, 'apps/web/src/lib');
  if (!fs.existsSync(webDir)) return 'нет apps/web/src/lib';
  const refused = [
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
  ];
  const allowed = [
    'import { env } from "@sf/config/server";',
    'import { createServerClient } from "@sf/api-client/server";',
    'import { BuildInfoSchema } from "@sf/contracts";',
    'import "server-only";',
  ];
  const file = path.join(webDir, 'zz_selftest_s11.ts');
  try {
    for (const line of refused) {
      fs.writeFileSync(file, line + '\nexport const x = 1;\n');
      const r = probe('standards.js', { tool_input: { file_path: file } }, CWD);
      if (r.code !== 2 || !/S11/.test(r.err)) return 'не пойман S11: ' + line + ' - код ' + r.code + ' ' + r.err.slice(0, 160);
    }
    for (const line of allowed) {
      fs.writeFileSync(file, line + '\nexport const x = 1;\n');
      const r = probe('standards.js', { tool_input: { file_path: file } }, CWD);
      if (/S11/.test(r.err)) return 'вход web получил S11: ' + line + ' - ' + r.err.slice(0, 160);
    }
    return true;
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
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

// ------------------------------------------------------------------ боевое состояние
check('боевой .qa-state после проб байт в байт прежний', () => {
  const now = liveBytes();
  const same = LIVE_BYTES === null ? now === null : now !== null && LIVE_BYTES.equals(now);
  if (same) return true;
  return 'боевой ' + LIVE_STATE + ' изменился за прогон: ' +
    (LIVE_BYTES === null ? 'не было' : LIVE_BYTES.length + ' байт') + ' -> ' + (now === null ? 'нет' : now.length + ' байт');
});

// ------------------------------------------------------------------ итог
let red = 0;
for (const r of results) {
  if (!r.ok) red++;
  console.log((r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.note ? '  - ' + r.note : ''));
}
console.log(red ? 'Самопроверка обвязки: КРАСНАЯ, ' + red + ' из ' + results.length : 'Самопроверка обвязки: зелёная, ' + results.length + ' проверок');
process.exit(red ? 1 : 0);
