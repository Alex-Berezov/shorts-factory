'use strict';
/**
 * selftest-graph.js - граф задач turbo для проб гейтов build и test:int в harness-selftest.js
 * (E0-12L, решение техлида Р1 21.10.2026). Не хук: модуль самопроверки, Node без зависимостей
 * проекта, кроме тех, что читают сами пробы: turbo (граф) и yaml (шаблоны pnpm-workspace.yaml).
 *
 * Граф пакетов берётся у turbo (`turbo run <скрипты> --dry=json`), а не своим разбором
 * pnpm-workspace.yaml, манифестов и next.config.*: какие пакеты собираются, в каком порядке
 * и какие файлы каждая задача хеширует, знает только turbo. Отказ любой ветки - исключение
 * с названной причиной (его ловит check пробы): неизвестная форма вывода краснеет, а не даёт
 * пустой граф.
 *
 * inputs в dry-JSON - только файлы, видимые git: новый файл из .gitignore в граф не попадёт.
 * Это то же, что видит gates.js (L.changedFiles: diff и ls-files --exclude-standard, L-033):
 * изменение такого файла гейт не выбрало бы и с верным glob.
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { isGone } = require('./lib.js');

const ROOT = path.resolve(__dirname, '..', '..');

/** command задачи turbo у пакета без такого скрипта. */
const NONEXISTENT = '<NONEXISTENT>';

/**
 * Файлы globalCacheInputs, которые turbo хеширует сам, а задачи не читают: сверять их с glob
 * гейта - требовать выбора гейта на файле, правка которого сборку и тесты не меняет (L-018).
 * Перечень именованный, с причиной на файл: молчаливого фильтра нет (L-027).
 */
const HASHED_NOT_READ = {
  '.gitattributes': 'turbo добавляет его в globalCacheInputs без globalDependencies; это атрибуты git (eol, diff), next build и vitest его не читают',
};

/**
 * inputs задач в turbo.json (корня и пакетов, `extends ["//"]`) - именованное ожидание с причиной
 * (В2 техлида E0-12L): пробы сверяют с glob файлы, которые хеширует задача, и сужение inputs
 * в turbo.json пакета сузило бы сверку молча (L-018, L-027). resolvedTaskDefinition.inputs узла
 * графа, отличный от ожидания, - отказ с taskId и фактическим перечнем. turbo пишет inputs
 * разрешёнными (resolvedInputs): `$TURBO_ROOT$/x` - путь от каталога задачи, `$TURBO_DEFAULT$`
 * в выводе нет.
 */
const DECLARED_INPUTS = {
  build: {
    inputs: [],
    why: 'build без inputs: turbo хеширует все файлы пакета, видимые git, - их и читает next build',
  },
  'test:int': {
    inputs: ['$TURBO_DEFAULT$', '$TURBO_ROOT$/vitest.preset.ts'],
    why: 'файлы пакета и корневой vitest.preset.ts, который вызывает каждый vitest.int.config.ts (ADR-0011)',
  },
};

/**
 * Законное расширение inputs одной задачи сверх DECLARED_INPUTS её скрипта (TECH_DEBT 21.10.2026 E0-12L круг 4, `checkDeclaredInputs`):
 * taskId -> { inputs (записи turbo.json, как в DECLARED_INPUTS), why }. Ожидание узла - inputs
 * скрипта и затем его расширение; тот же вход у задачи вне перечня - отказ, как и прежде. Перечень
 * именованный, с причиной на задачу; сейчас пуст.
 */
const EXTRA_INPUTS = {};

/**
 * Файлы пакета, которые git видит, а turbo по замыслу не хеширует: сверка «файлы пакета - во
 * входах узла» (inputsGap) их пропускает. Перечень именованный, с причиной на файл (путь от
 * корня); сейчас пуст - на 21.10.2026 turbo хеширует каждый файл пакета, видимый git.
 */
const TRACKED_NOT_HASHED = {};

/** Ожидание declared (запись turbo.json) в виде resolvedTaskDefinition.inputs задачи в каталоге dir. */
function resolvedInputs(declared, dir) {
  const ROOT_PREFIX = '$TURBO_ROOT$/';
  return declared
    .filter((i) => i !== '$TURBO_DEFAULT$')
    .map((i) => (i.startsWith(ROOT_PREFIX) ? path.posix.relative(dir || '.', i.slice(ROOT_PREFIX.length)) : i));
}

/** Поля задачи dry-JSON, без которых граф не строится, и проверка формы каждого (по задаче). */
const TASK_FIELDS = [
  ['directory', (t) => typeof t.directory === 'string'],
  ['command', (t) => typeof t.command === 'string'],
  ['dependencies', (t) => Array.isArray(t.dependencies) && t.dependencies.every((d) => typeof d === 'string')],
  ['inputs', (t) => Boolean(t.inputs) && typeof t.inputs === 'object' && !Array.isArray(t.inputs)],
  ['resolvedTaskDefinition.inputs', (t) => Boolean(t.resolvedTaskDefinition) && typeof t.resolvedTaskDefinition === 'object' &&
    Array.isArray(t.resolvedTaskDefinition.inputs) && t.resolvedTaskDefinition.inputs.every((i) => typeof i === 'string')],
];

/** Ключ скрипта манифеста в тексте отказа: scripts.build, scripts['test:int']. */
function scriptKey(script) {
  return /^\w+$/.test(script) ? 'scripts.' + script : "scripts['" + script + "']";
}

/** Имя пакета задачи turbo: `@sf/web#build` -> `@sf/web`. */
function taskPackage(taskId) {
  return taskId.slice(0, taskId.lastIndexOf('#'));
}

/** Скрипт задачи turbo: `@sf/web#build` -> `build`. */
function taskScript(taskId) {
  return taskId.slice(taskId.lastIndexOf('#') + 1);
}

/** Предел ожидания turbo dry: зависший turbo не вешает selftest и замок коммита. */
const TURBO_TIMEOUT_MS = 60 * 1000;

/**
 * Окружение turbo: окружение процесса без переменных TURBO_* (TURBO_FORCE, TURBO_ENV_MODE,
 * TURBO_SCM_BASE, TURBO_BINARY_PATH... меняют граф, входы задач и сам бинарь - граф пробы не
 * должен зависеть от оболочки) и с выключенной телеметрией. env - исходное окружение; оно не
 * правится.
 */
function turboEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^TURBO_/i.test(k)) out[k] = v;
  out.TURBO_TELEMETRY_DISABLED = '1';
  return out;
}

/** Имена платформ и архитектур Node в именах пакетов бинаря turbo (`@turbo/<os>-<arch>`). */
const TURBO_OS = { win32: 'windows', darwin: 'darwin', linux: 'linux' };
const TURBO_ARCH = { x64: '64', arm64: 'arm64' };

/**
 * Путь модуля spec от каталога from, лежащий под `<root>/node_modules`; модуля нет
 * (MODULE_NOT_FOUND) или он нашёлся вне `<root>/node_modules` - исключение «нет <name> - сначала
 * pnpm install», иная ошибка резолва - как есть. require.resolve поднимается по предкам from,
 * NODE_PATH и ~/.node_modules: без проверки корня граф строил бы чужой turbo другой версии.
 * Сверку корня делает underNodeModules (через realpath обоих концов: пакеты pnpm в
 * node_modules - симлинки); сам resolveFrom realpath не вызывает.
 */
function resolveFrom(spec, from, name, root) {
  let file;
  try {
    file = require.resolve(spec, { paths: [from] });
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') throw new Error('нет ' + name + ' - сначала pnpm install');
    throw e;
  }
  if (!underNodeModules(file, root)) throw new Error('нет ' + name + ' - сначала pnpm install');
  return file;
}

/**
 * child лежит строго под dir (оба пути абсолютные и уже через realpath): один предикат «путь под
 * каталогом» для модуля графа и harness-selftest.js (relUnder) - каталог `..x` внутри dir под ним.
 */
function strictlyUnder(child, dir) {
  const rel = path.relative(dir, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/**
 * Путь rel от корня репозитория (posix, после path.posix.normalize) выходит из корня: `..`, `../…`
 * или абсолютный. Один предикат «вне корня» для путей от корня - inRoot здесь, резолв `./`/`../` и
 * join/resolve(repoRoot, …) обхода int-наборов в harness-selftest.js; каталог `..x` - внутри корня.
 */
function outsideRoot(rel) {
  return rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel);
}

/**
 * file лежит под `<root>/node_modules` или под виртуальным хранилищем pnpm этого корня
 * (`virtualStoreDir` из `<root>/node_modules/.modules.yaml`: законный `virtual-store-dir` вне
 * корня, TECH_DEBT 21.10.2026 E0-12L круг 4, `underNodeModules`) - пути через realpath. Нет node_modules - не лежит; иная ошибка
 * realpath (EACCES) - исключение как есть. `.modules.yaml` читается, только если file не под
 * node_modules: его нет - хранилища вне корня нет; он не разбирается yaml или virtualStoreDir не
 * строка - исключение (fail-closed). Относительный virtualStoreDir - от node_modules. opts -
 * подмена для кейсов: realpath (вместо fs.realpathSync), modulesYaml (текст `.modules.yaml` или
 * null - файла нет), parseYaml (разбор текста).
 */
function underNodeModules(file, root, opts) {
  const o = opts || {};
  const realpath = o.realpath || fs.realpathSync;
  let nm;
  try {
    nm = realpath(path.join(root, 'node_modules'));
  } catch (e) {
    if (isGone(e)) return false;
    throw e;
  }
  const real = realpath(file);
  if (strictlyUnder(real, nm)) return true;
  const text = o.modulesYaml !== undefined ? o.modulesYaml : readIfExists(path.join(nm, '.modules.yaml'));
  if (text === null) return false;
  let store;
  try {
    // yaml берётся у корня без проверки underNodeModules: иначе круг (yaml сам резолвится через неё)
    const parse = o.parseYaml || require(require.resolve('yaml', { paths: [root] })).parse;
    store = parse(text).virtualStoreDir;
  } catch (e) {
    throw new Error('node_modules/.modules.yaml не разбирается yaml: ' + ((e && e.message) || String(e)));
  }
  if (typeof store !== 'string' || !store) throw new Error('в node_modules/.modules.yaml нет строки virtualStoreDir');
  let dir;
  try {
    dir = realpath(path.resolve(nm, store));
  } catch (e) {
    if (isGone(e)) return false;
    throw e;
  }
  return strictlyUnder(real, dir);
}

/** Текст файла или null, если его нет (ENOENT); иная ошибка - исключение. */
function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (isGone(e)) return null;
    throw e;
  }
}

/**
 * Бинарь turbo платформы platform-arch (имена Node) для репозитория root: пакет `@turbo/<os>-<arch>`
 * резолвится от каталога пакета turbo, как его ищет сама обёртка `turbo/bin/turbo` (В3 техлида
 * E0-12L). Обёртку пробы не зовут: убитая по пределу, она оставляет нативный turbo сиротой, а без
 * пакета платформы сама запускает npm install (сеть и запись в node_modules из замка коммита).
 * Пары вне TURBO_OS x TURBO_ARCH - отказ: эмуляции arm64 и TURBO_BINARY_PATH здесь нет.
 */
function turboBinary(root, platform, arch) {
  const os = TURBO_OS[platform];
  const cpu = TURBO_ARCH[arch];
  if (!os || !cpu) {
    throw new Error('нет пакета turbo для платформы ' + platform + '-' + arch + ' (пакеты @turbo/<os>-<arch>: ' +
      Object.values(TURBO_OS).join(', ') + ' x ' + Object.values(TURBO_ARCH).join(', ') + ')');
  }
  const pkg = '@turbo/' + os + '-' + cpu;
  const wrapper = path.dirname(resolveFrom('turbo/package.json', root, 'turbo', root));
  return resolveFrom(pkg + '/bin/turbo' + (platform === 'win32' ? '.exe' : ''), wrapper, pkg, root);
}

/**
 * Вывод `turbo run ... --dry=json` (результат spawnSync) -> разобранный dry-JSON. Отказ:
 * turbo не запустился (pid нет), прерван после запуска (предел - отдельно, ENOBUFS и прочее -
 * с ошибкой), вышел не с 0 (код или сигнал по имени), stdout не JSON, нет tasks. what - команда
 * в тексте отказа. Разбирается только stdout: строка `• turbo <версия>` идёт в stderr и с JSON
 * не склеивается.
 */
function parseDry(r, what) {
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT') throw new Error(what + ': не ответил за ' + TURBO_TIMEOUT_MS / 1000 + ' с - процесс убит');
    if (r.pid) throw new Error(what + ': прерван после запуска: ' + r.error.message);
    throw new Error(what + ' не запустился: ' + r.error.message);
  }
  if (r.status !== 0) {
    const ended = r.status === null ? 'сигнал ' + r.signal : 'код ' + r.status;
    throw new Error(what + ': ' + ended + ': ' + (String(r.stderr || '').trim().slice(0, 200) || 'stderr пуст'));
  }
  let dry;
  try {
    dry = JSON.parse(String(r.stdout || ''));
  } catch (e) {
    throw new Error(what + ': stdout не JSON (' + e.message + '): ' + JSON.stringify(String(r.stdout || '').slice(0, 80)));
  }
  if (!dry || typeof dry !== 'object' || !Array.isArray(dry.tasks)) {
    throw new Error(what + ': в выводе нет массива tasks - форма dry-JSON turbo неизвестна');
  }
  return dry;
}

const dryCache = new Map();
/**
 * dry-JSON turbo для скриптов scripts. Зовётся нативный бинарь turboBinary из корня, в окружении
 * turboEnv и с пределом TURBO_TIMEOUT_MS (SIGKILL). Результат кэшируется на прогон: пробы build,
 * test:int и harness-selftest видят один снимок. opts.root - корень (по умолчанию репозиторий),
 * opts.platform/opts.arch - платформа (по умолчанию процесса), opts.spawn - подмена spawnSync для
 * кейсов веток отказа (с подменой кэш не используется).
 */
function turboDry(scripts, opts) {
  const o = opts || {};
  const root = o.root || ROOT;
  const key = root + '\0' + scripts.join(' ');
  if (!o.spawn && dryCache.has(key)) return dryCache.get(key);
  const what = 'turbo run ' + scripts.join(' ') + ' --dry=json';
  let bin;
  try {
    bin = turboBinary(root, o.platform || process.platform, o.arch || process.arch);
  } catch (e) {
    throw new Error(what + ': ' + ((e && e.message) || String(e)));
  }
  const spawn = o.spawn || cp.spawnSync;
  const r = spawn(bin, ['run', ...scripts, '--dry=json'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: TURBO_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: turboEnv(process.env),
  });
  const dry = parseDry(r, what);
  if (!o.spawn) dryCache.set(key, dry);
  return dry;
}

/**
 * Шаблоны пакетов pnpm-workspace.yaml (текст text) - разбор пакетом yaml проекта, своего разбора
 * YAML нет. Нет списка строк packages или текст не YAML - исключение.
 */
function workspacePatterns(text) {
  const YAML = require(resolveFrom('yaml', ROOT, 'yaml', ROOT));
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    throw new Error('pnpm-workspace.yaml не разбирается yaml: ' + ((e && e.message) || String(e)));
  }
  const list = doc && doc.packages;
  if (!Array.isArray(list) || !list.every((p) => typeof p === 'string')) {
    throw new Error('в pnpm-workspace.yaml нет списка строк packages - шаблоны пакетов workspace неизвестны');
  }
  return list;
}

/** Каталог задачи с `/` (на Windows turbo пишет `\`). */
function posixDir(dir) {
  return dir.split('\\').join('/');
}

/**
 * Каталог пакета задачи t от корня с `/`, нормализованный: у корневой задачи (directory `''`
 * или `.`) - `.`. Один помощник для узлов графа и каталогов пакетов dry: '' и '.' иначе
 * расходились бы в сверке «файл пакета - под каталогом узла» (inputsGap).
 */
function packageDir(t) {
  return path.posix.normalize(posixDir(t.directory) || '.');
}

/**
 * Путь входа задачи от корня репозитория; вход вне корня - исключение. Абсолютный - `/…` и буква
 * диска со слешем (`C:\x`, `C:/x`) на любой платформе; на Windows (platform win32, по умолчанию -
 * платформа процесса) и буква диска без слеша (`C:x.ts` - путь от текущего каталога диска C, вне
 * репозитория): имя файла с двоеточием там невозможно. На прочих платформах `a:b.json` - законное
 * имя файла (TECH_DEBT 21.10.2026 E0-12L круг 4, `inRoot`).
 */
function inRoot(dir, input, taskId, platform = process.platform) {
  const posix = input.split('\\').join('/');
  const drive = platform === 'win32' ? /^[A-Za-z]:/ : /^[A-Za-z]:\//;
  // абсолютный путь проверяется до склейки с каталогом: 'packages/b/' + '/etc/x' стал бы относительным
  if (path.posix.isAbsolute(posix) || drive.test(posix)) {
    throw new Error('вход ' + input + ' задачи ' + taskId + ' - абсолютный путь, вне корня репозитория');
  }
  const rel = path.posix.normalize(path.posix.join(dir || '.', posix));
  if (outsideRoot(rel)) throw new Error('вход ' + input + ' задачи ' + taskId + ' вне корня репозитория');
  return rel;
}

/**
 * Задачи dry по taskId; задача без taskId или без поля из TASK_FIELDS - исключение. Форма
 * проверяется раз на объект dry (TECH_DEBT 21.10.2026 E0-12L круг 3, `dryPackages` -> `tasksById`; круг 4, время прогона): результат в WeakMap по самому
 * объекту; стабы - новые объекты dry и проверяются сами. Объект dry после первого вызова не
 * правится (стабы копируют).
 */
const byIdCache = new WeakMap();
function tasksById(dry) {
  if (byIdCache.has(dry)) return byIdCache.get(dry);
  const byId = new Map();
  for (const t of dry.tasks) {
    if (!t || typeof t.taskId !== 'string') throw new Error('задача dry-JSON без taskId - форма dry-JSON turbo неизвестна');
    for (const [field, valid] of TASK_FIELDS) {
      if (!valid(t)) throw new Error('у задачи ' + t.taskId + ' нет ' + field + ' - форма dry-JSON turbo неизвестна');
    }
    byId.set(t.taskId, t);
  }
  byIdCache.set(dry, byId);
  return byId;
}

/** taskId задач script с командой (command не <NONEXISTENT>) среди проверенных задач byId. */
function rootIds(byId, script) {
  return Array.from(byId.values()).filter((t) => t.taskId.endsWith('#' + script) && t.command !== NONEXISTENT).map((t) => t.taskId);
}

/** Корни script: [{ name, command }] - без исключения на пустом списке (его сверяет проба корней). */
function rootTasks(dry, script) {
  const byId = tasksById(dry);
  return rootIds(byId, script).map((id) => ({ name: id, command: byId.get(id).command }));
}

/** Ожидание inputs скрипта задачи taskId (DECLARED_INPUTS); нет - исключение с именем задачи. */
function declaredFor(taskId) {
  const decl = DECLARED_INPUTS[taskScript(taskId)];
  if (!decl) throw new Error('у задачи ' + taskId + ' нет ожидания inputs в DECLARED_INPUTS selftest-graph.js');
  return decl;
}

/**
 * resolvedTaskDefinition.inputs задачи t (каталог dir) - ровно DECLARED_INPUTS её скрипта и
 * затем расширение задачи из extra (EXTRA_INPUTS); иначе исключение с taskId и фактическим
 * перечнем. Вход сверх ожидания у задачи вне extra - отказ: расширение одного пакета не
 * ослабляет сверку остальных.
 */
function checkDeclaredInputs(t, dir, extra) {
  const decl = declaredFor(t.taskId);
  const more = Object.prototype.hasOwnProperty.call(extra, t.taskId) ? extra[t.taskId] : null;
  const want = resolvedInputs(decl.inputs.concat(more ? more.inputs : []), dir);
  const got = t.resolvedTaskDefinition.inputs;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error('inputs задачи ' + t.taskId + ' в turbo.json: ' + JSON.stringify(got) + ', ожидалось ' + JSON.stringify(want) +
      ' (DECLARED_INPUTS: ' + decl.why + (more ? '; EXTRA_INPUTS: ' + more.why : '') + ')');
  }
}

/**
 * Граф задачи script: корни - задачи script с командой (command не <NONEXISTENT>), узлы -
 * транзитивное замыкание dependencies от корней. Все задачи dry брать нельзя: в dry test:int
 * есть узлы всех пакетов, и web потребовал бы glob test:int. Каждый узел -
 * { name, pkg, dir, command, root, reads: [{ file, why }] }, file - путь от корня с `/`.
 * Отказ (исключение, не пропуск): нет корней, зависимость на taskId вне dry, вход вне корня,
 * задача неизвестной формы, inputs узла не DECLARED_INPUTS с расширением EXTRA_INPUTS.
 * opts.extraInputs - подмена EXTRA_INPUTS для кейсов.
 */
function taskGraph(dry, script, opts) {
  const extra = (opts && opts.extraInputs) || EXTRA_INPUTS;
  const byId = tasksById(dry);
  const roots = rootIds(byId, script);
  if (!roots.length) throw new Error('в dry-JSON нет задачи ' + script + ' с командой - ни у одного пакета нет ' + scriptKey(script));
  // корень - сам себе граф, даже если до него дошёл обход от другого корня (db из api)
  const reachedFrom = new Map(roots.map((id) => [id, id]));
  const queue = roots.slice();
  while (queue.length) {
    const id = queue.shift();
    for (const dep of byId.get(id).dependencies) {
      if (!byId.has(dep)) throw new Error('зависимость ' + dep + ' задачи ' + id + ' вне dry-JSON - граф неполон');
      if (reachedFrom.has(dep)) continue;
      reachedFrom.set(dep, reachedFrom.get(id));
      queue.push(dep);
    }
  }
  const nodes = Array.from(reachedFrom, ([id, root]) => {
    const t = byId.get(id);
    const dir = packageDir(t);
    checkDeclaredInputs(t, dir, extra);
    const why = id === root ? 'корень ' + id : 'узел ' + id + ' графа ' + root;
    return {
      name: id,
      pkg: taskPackage(id),
      dir,
      command: t.command,
      root: id === root,
      reads: Object.keys(t.inputs).map((input) => ({ file: inRoot(dir, input, id), why })),
    };
  });
  return { roots: nodes.filter((n) => n.root), nodes };
}

/**
 * Файл file (путь от корня с `/`) - в каталоге пакета dir: у корневого пакета (`.`) - любой файл.
 * Один предикат для inputsGap и детектора входов harness-selftest (TECH_DEBT 21.10.2026 E0-12L
 * круг 4, `own` в пробе входов).
 */
function under(file, dir) {
  return dir === '.' || file.startsWith(dir + '/');
}

/**
 * Файлы files (пути от корня), которые inputsGap считает файлами пакета узла n: под его каталогом
 * (under), не во вложенном пакете (dirs - каталоги пакетов dry) и не в TRACKED_NOT_HASHED. Один
 * отбор для inputsGap и детектора входов harness-selftest (inputsGapBlind): срез файла, который
 * inputsGap не считает, дал бы ложное «проба не замечает».
 */
function ownFiles(n, files, dirs) {
  const nested = dirs.filter((d) => d !== n.dir && under(d, n.dir));
  return files.filter((file) => under(file, n.dir) && !nested.some((d) => under(file, d)) &&
    !Object.prototype.hasOwnProperty.call(TRACKED_NOT_HASHED, file));
}

/**
 * Файлы пакетов, видимые git (tracked - пути от корня, список даёт вызывающий: git зовёт
 * harness-selftest), которых нет среди входов узла graph (решение техлида по `$TURBO_DEFAULT$`,
 * E0-12L): turbo пишет inputs разрешёнными без `$TURBO_DEFAULT$`, и его снятие в turbo.json
 * видно только так. Сверяются узлы, чьё ожидание DECLARED_INPUTS пусто или содержит
 * `$TURBO_DEFAULT$`; файлы вложенного пакета (каталоги пакетов dry) и TRACKED_NOT_HASHED не
 * считаются. Скрипт узла без ожидания в DECLARED_INPUTS - исключение с именем задачи, а не
 * TypeError (TECH_DEBT 21.10.2026 E0-12L круг 3, `inputsGap`). Строки `<taskId>: <до 5 файлов>[ и ещё N]`; пусто - покрыто.
 */
function inputsGap(graph, tracked, dry) {
  const dirs = Array.from(dryPackages(dry).values());
  const out = [];
  for (const n of graph.nodes) {
    const decl = declaredFor(n.name);
    if (decl.inputs.length && !decl.inputs.includes('$TURBO_DEFAULT$')) continue;
    const have = new Set(n.reads.map((r) => r.file));
    const missing = ownFiles(n, tracked, dirs).filter((file) => !have.has(file));
    if (missing.length) out.push(n.name + ': ' + missing.slice(0, 5).join(', ') + (missing.length > 5 ? ' и ещё ' + (missing.length - 5) : ''));
  }
  return out;
}

/**
 * Поля манифеста, по которым сверяется граф `^<script>`: те, по которым turbo строит рёбра.
 * Замер turbo 2.10.12 (`--dry=json` на временном workspace): workspace:-пакет только в
 * optionalDependencies даёт ребро `^<script>`, только в peerDependencies - нет. peer в
 * перечне дал бы вечный красный «граф уже манифестов», который правкой dependsOn не снять.
 */
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/**
 * Пакеты, которые манифесты тянут от корней графа graph (поля DEP_FIELDS со значением
 * `workspace:`, транзитивно), а граф turbo - нет (В1 техлида E0-12L): граф не уже
 * манифестов. Снятое `^<script>` в dependsOn turbo.json сжало бы граф до корня, и сверка с glob
 * прошла бы на одних файлах корня. ws - манифесты пакетов dry: { имя: { dir, pkg } };
 * workspace:-зависимость на пакет вне ws - исключение. Возвращает имена пакетов по алфавиту.
 */
function manifestGap(graph, ws) {
  const inGraph = new Set(graph.nodes.map((n) => n.pkg));
  return Array.from(manifestClosure(graph, ws)).filter((n) => !inGraph.has(n)).sort();
}

/**
 * Замыкание workspace:-зависимостей манифестов (поля DEP_FIELDS) от пакетов корней graph, сами
 * корни - тоже: Set имён пакетов. workspace:-зависимость на пакет вне ws - исключение.
 */
function manifestClosure(graph, ws) {
  const seen = new Set();
  const queue = graph.roots.map((r) => r.pkg);
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    for (const field of DEP_FIELDS) {
      for (const [dep, spec] of Object.entries(ws[name].pkg[field] || {})) {
        if (!String(spec).startsWith('workspace:')) continue;
        if (!ws[dep]) throw new Error('workspace:-зависимость ' + dep + ' пакета ' + name + ' (' + field + ') вне пакетов dry-JSON');
        queue.push(dep);
      }
    }
  }
  return seen;
}

/**
 * workspace:-зависимости только в peerDependencies (без дубля в DEP_FIELDS) у манифестов ws
 * (решение техлида Р5 E0-12T; TECH_DEBT 21.10.2026 E0-12L круг 4, peer-only workspace-зависимость): turbo 2.10.12 ребра `^<script>` по peer не
 * строит, и сверка с манифестами её не видит - пакет собирался бы не раньше того, кто его читает.
 * Признак - префикс значения `workspace:`, не имя `@sf/*`. Строки отказа с пакетом, зависимостью
 * и подсказкой; пусто - таких нет.
 */
function peerOnly(ws) {
  const out = [];
  for (const [name, { pkg }] of Object.entries(ws)) {
    for (const [dep, spec] of Object.entries(pkg.peerDependencies || {})) {
      if (!String(spec).startsWith('workspace:')) continue;
      if (DEP_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(pkg[field] || {}, dep))) continue;
      out.push('пакет ' + name + ': ' + dep + ' (' + spec + ') только в peerDependencies - turbo не строит по нему ребро, добавь в devDependencies');
    }
  }
  return out;
}

/**
 * Файлы globalCacheInputs.files: их правка меняет хеш каждой задачи, поэтому они сверяются
 * с glob гейта так же, как входы задач. Возвращает { reads, skipped } - skipped: файлы
 * из HASHED_NOT_READ с причиной. Нет globalCacheInputs.files - исключение.
 */
function globalReads(dry) {
  const g = dry.globalCacheInputs;
  const files = g && g.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('в dry-JSON нет globalCacheInputs.files - форма dry-JSON turbo неизвестна');
  const reads = [];
  const skipped = [];
  for (const file of Object.keys(files)) {
    const rel = inRoot('', file, 'globalCacheInputs');
    if (Object.prototype.hasOwnProperty.call(HASHED_NOT_READ, rel)) skipped.push({ file: rel, why: HASHED_NOT_READ[rel] });
    else reads.push({ file: rel, why: 'globalCacheInputs turbo' });
  }
  return { reads, skipped };
}

/** Каталоги пакетов из dry: Map<имя пакета, каталог с `/`>. */
function dryPackages(dry) {
  const byId = tasksById(dry);
  const pkgs = new Map();
  for (const [id, t] of byId) pkgs.set(taskPackage(id), packageDir(t));
  return pkgs;
}

/** Файл file в каталоге пакета dir (от корня, с `/`): у корневого пакета (`.`) - сам file. */
function inDir(dir, file) {
  return path.posix.join(dir || '.', file);
}

/** Имя каталога «нового пакета» по шаблону workspace (graphSources). */
const NEW_SIBLING = 'selftest-new';

/**
 * Каталоги нового пакета, который добавил бы шаблон pattern pnpm-workspace.yaml: `*` ->
 * NEW_SIBLING (`tools/*` -> `tools/selftest-new`); `**` - любая глубина, поэтому и один, и два
 * уровня (`packages/**` -> `packages/selftest-new` и `packages/selftest-new/selftest-new`: glob,
 * покрывающий только первый уровень, иначе прошёл бы сверку, TECH_DEBT 21.10.2026 E0-12L круг 3, `patternPackage`); шаблон без них -
 * сам каталог. Иные знаки glob (`?`, `[`, `{`) - исключение: пример пакета из них не построить.
 */
function patternPackages(pattern) {
  const p = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  if (/[?[\]{}]/.test(p)) throw new Error('шаблон ' + pattern + ' pnpm-workspace.yaml не разбирается пробой (знаки ? [ ] { }) - разбери руками');
  const one = p.replace(/\*\*?/g, NEW_SIBLING);
  if (!p.includes('**')) return [one];
  return [one, p.replace(/\*\*/g, NEW_SIBLING + '/' + NEW_SIBLING).replace(/\*/g, NEW_SIBLING)];
}

/**
 * Файлы конфигурации turbo в каталоге: turbo 2.10 читает и turbo.json, и turbo.jsonc (проверено
 * живым прогоном, TECH_DEBT 21.10.2026 E0-12L круг 4, `turbo.jsonc`) - оба в источниках графа.
 */
const TURBO_CONFIGS = ['turbo.json', 'turbo.jsonc'];

/**
 * Файлы, из которых turbo строит граф: корневые package.json, pnpm-workspace.yaml, turbo.json и
 * turbo.jsonc; у каждого пакета dry - его package.json, turbo.json и turbo.jsonc (`extends ["//"]`
 * правит inputs задач пакета; файла может не быть - turbo прочтёт его, как только он появится); у
 * каждого шаблона patterns pnpm-workspace.yaml - те же файлы нового пакета patternPackages: шаблон
 * добавит пакет без правки pnpm-workspace.yaml, и шаблон без единого пакета (`tools/*`) - тоже,
 * поэтому glob обязан покрывать шаблон, а не перечень сегодняшних пакетов. Исключающий шаблон
 * (`!x`) пакетов не добавляет. [{ file, why }] без повторов.
 */
function graphSources(dry, patterns) {
  const out = new Map([
    ['package.json', 'корневой манифест'],
    ['pnpm-workspace.yaml', 'пакеты workspace'],
  ]);
  const add = (file, why) => { if (!out.has(file)) out.set(file, why); };
  for (const f of TURBO_CONFIGS) add(f, 'задачи turbo');
  const pkgFiles = (dir, who) => {
    add(inDir(dir, 'package.json'), 'манифест ' + who);
    for (const f of TURBO_CONFIGS) add(inDir(dir, f), f + ' ' + who);
  };
  for (const [name, dir] of dryPackages(dry)) pkgFiles(dir, 'пакета ' + name);
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    for (const dir of patternPackages(pattern)) pkgFiles(dir, 'нового пакета по шаблону ' + pattern);
  }
  return Array.from(out, ([file, why]) => ({ file, why }));
}

/** Чтения reads, правка которых гейт не выбирает (runs - его проба): строки `file (why)`. */
function outsideGlob(runs, reads) {
  return reads.filter((r) => !runs(r.file)).map((r) => r.file + ' (' + r.why + ')');
}

/** Текст отказа «кто читает вне glob гейта»: who - кто читает, с глаголом; bad - из outsideGlob. */
function refusal(who, gateId, bad) {
  return who + ' вне glob ' + gateId + ': ' + bad.join(', ') + ' - расширь glob ' + gateId;
}

/**
 * Стаб проб графа: пакет STUB_PACKAGE в каталоге STUB_DIR - вне glob любого гейта и вне шаблонов
 * workspace, поэтому законное расширение glob гейта (packages/db, docs, tools/*) детектор не
 * ломает. Все файлы стабов - в STUB_DIR: STUB_GLOBAL (глобальный вход), STUB_PATTERN (шаблон
 * workspace); STUB_SOURCES - файлы графа, которые стаб-пакет и стаб-шаблон добавляют в
 * graphSources (собраны здесь напрямую, не через graphSources: детектор сверяет её с ними);
 * STUB_FILES - все файлы стабов, по которым проба проверяет, что стаб вне glob гейта.
 */
const STUB_DIR = 'selftest-stub';
const STUB_PACKAGE = '@sf/selftest-stub';
const STUB_GLOBAL = STUB_DIR + '/selftest-global.json';
const STUB_PATTERN = STUB_DIR + '/*';
const STUB_SOURCES = ['package.json', ...TURBO_CONFIGS, NEW_SIBLING + '/package.json', ...TURBO_CONFIGS.map((f) => NEW_SIBLING + '/' + f)].map((f) => STUB_DIR + '/' + f);
const STUB_FILES = STUB_SOURCES.concat(STUB_GLOBAL);

/** taskId стаб-задачи script. */
function stubTaskId(script) {
  return STUB_PACKAGE + '#' + script;
}

/** Задача taskId есть в dry - иначе исключение «стаб: задачи ... нет». */
function requireTask(dry, taskId) {
  if (!dry.tasks.some((t) => t.taskId === taskId)) throw new Error('стаб: задачи ' + taskId + ' нет в dry-JSON');
}

/**
 * Стаб: копия dry с задачей script пакета STUB_PACKAGE в STUB_DIR (без команды, рёбер и входов,
 * inputs по DECLARED_INPUTS; fields - поля поверх) и ребром к ней от первого корня графа script.
 * Снимок не правится.
 */
function stubNode(dry, script, fields) {
  const from = taskGraph(dry, script).roots[0].name;
  const decl = DECLARED_INPUTS[script];
  const task = Object.assign({
    taskId: stubTaskId(script),
    directory: STUB_DIR,
    command: NONEXISTENT,
    dependencies: [],
    inputs: {},
    resolvedTaskDefinition: { inputs: decl ? resolvedInputs(decl.inputs, STUB_DIR) : [] },
  }, fields);
  return Object.assign({}, dry, {
    tasks: dry.tasks
      .map((t) => (t.taskId === from ? Object.assign({}, t, { dependencies: t.dependencies.concat(task.taskId) }) : t))
      .concat(task),
  });
}

/** Стаб: копия dry с командой command у задачи taskId. taskId нет в dry - исключение. */
function stubCommand(dry, taskId, command) {
  requireTask(dry, taskId);
  return Object.assign({}, dry, { tasks: dry.tasks.map((t) => (t.taskId === taskId ? Object.assign({}, t, { command }) : t)) });
}

/** Стаб: копия dry без рёбер к задаче taskId (её зависимые её не видят). taskId нет в dry - исключение. */
function stubCut(dry, taskId) {
  requireTask(dry, taskId);
  return Object.assign({}, dry, {
    tasks: dry.tasks.map((t) => Object.assign({}, t, { dependencies: t.dependencies.filter((d) => d !== taskId) })),
  });
}

/**
 * Стаб: копия dry без входа задачи taskId, который разрешается в file (путь от корня).
 * taskId нет в dry или такого входа нет - исключение.
 */
function stubWithoutInput(dry, taskId, file) {
  requireTask(dry, taskId);
  const t = dry.tasks.find((x) => x.taskId === taskId);
  const dir = packageDir(t);
  const keys = Object.keys(t.inputs).filter((k) => inRoot(dir, k, taskId) !== file);
  if (keys.length === Object.keys(t.inputs).length) throw new Error('стаб: у задачи ' + taskId + ' нет входа ' + file);
  const inputs = Object.fromEntries(keys.map((k) => [k, t.inputs[k]]));
  return Object.assign({}, dry, { tasks: dry.tasks.map((x) => (x === t ? Object.assign({}, x, { inputs }) : x)) });
}

/** Стаб: копия dry с файлом STUB_GLOBAL в globalCacheInputs.files. Нет globalCacheInputs.files - исключение. */
function stubGlobal(dry) {
  globalReads(dry);
  const g = dry.globalCacheInputs;
  return Object.assign({}, dry, { globalCacheInputs: Object.assign({}, g, { files: Object.assign({}, g.files, { [STUB_GLOBAL]: 'stub' }) }) });
}

module.exports = {
  NONEXISTENT,
  NEW_SIBLING,
  STUB_DIR,
  STUB_PACKAGE,
  STUB_GLOBAL,
  STUB_PATTERN,
  STUB_SOURCES,
  STUB_FILES,
  TURBO_TIMEOUT_MS,
  scriptKey,
  turboEnv,
  underNodeModules,
  strictlyUnder,
  outsideRoot,
  under,
  ownFiles,
  inRoot,
  turboDry,
  EXTRA_INPUTS,
  workspacePatterns,
  rootTasks,
  taskGraph,
  manifestGap,
  manifestClosure,
  peerOnly,
  inputsGap,
  globalReads,
  dryPackages,
  graphSources,
  outsideGlob,
  refusal,
  stubTaskId,
  stubNode,
  stubCommand,
  stubCut,
  stubWithoutInput,
  stubGlobal,
};
