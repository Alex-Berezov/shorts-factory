'use strict';
/**
 * selftest-turbo.js - бинарь и запуск turbo для модуля графа selftest-graph.js (E0-12U: разрез
 * selftest-graph.js по заботам). Не хук: модуль самопроверки, Node без зависимостей проекта,
 * кроме turbo (граф) и yaml (virtualStoreDir в node_modules/.modules.yaml).
 *
 * Здесь только то, что находит нативный бинарь turbo этого корня и зовёт `turbo run <скрипты>
 * --dry=json`: пакет платформы `@turbo/<os>-<arch>`, проверка «модуль под node_modules корня»,
 * окружение без TURBO_*, предел ожидания и разбор вывода в dry-JSON. Отказ любой ветки -
 * исключение с названной причиной (его ловит check пробы). Граф и сверки - selftest-graph.js,
 * стабы - selftest-stub.js. Цепочка require: lib.js <- selftest-turbo.js <- selftest-graph.js <-
 * selftest-stub.js, обратных рёбер нет. Запуск turbo - точка запуска самопроверки (ctx.run), её
 * передаёт вызывающий: своей точки модуль не строит.
 */

const fs = require('fs');
const path = require('path');
const { isGone } = require('./lib.js');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Предел ожидания turbo dry: зависший turbo не вешает selftest и замок коммита. Замер 23.10.2026
 * (E0-12U; Windows, Node 22, turbo 2.10.12, `turboDry(['build', 'test:int'])` в свежем процессе
 * node, 24 задачи): тёплый (daemon и .turbo на месте) - 140, 115, 109 мс; холодный (перед каждым
 * вызовом `turbo daemon stop` и .turbo убран из корня) - 191, 186, 188 мс, худший холодный 191 мс.
 * Предел - 15 с, ~80x худшего холодного: не измерены CI ubuntu и холодный кэш файлов ОС (первый
 * запуск после pnpm install), они медленнее локального, но не на два порядка. Прежняя минута
 * добавляла бы к прогону selftest (55-78 с) ещё минуту ожидания зависшего turbo перед красной
 * строкой графа; 15 с - четверть этого.
 */
const TURBO_TIMEOUT_MS = 15 * 1000;

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
 * каталогом» для модулей графа и int-пробы selftest-int.js (relUnder) - каталог `..x` внутри dir под ним.
 */
function strictlyUnder(child, dir) {
  const rel = path.relative(dir, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/**
 * file лежит под `<root>/node_modules` или под виртуальным хранилищем pnpm этого корня
 * (`virtualStoreDir` из `<root>/node_modules/.modules.yaml`: законный `virtual-store-dir` вне
 * корня, TECH_DEBT 21.10.2026 E0-12L круг 4, `underNodeModules`) - пути через realpath. Нет node_modules - не лежит; иная ошибка
 * realpath (EACCES) - исключение как есть. `.modules.yaml` читается, только если file не под
 * node_modules: его нет - хранилища вне корня нет; он не разбирается yaml или virtualStoreDir не
 * строка - исключение (fail-closed) с путём файла. Относительный virtualStoreDir - от node_modules.
 * `.modules.yaml` читается и разбирается один раз на каталог node_modules и корень за прогон
 * (virtualStore, TECH_DEBT 23.10.2026 E0-12T, correctness; сбой - не запоминается). opts - подмена для кейсов: realpath
 * (вместо fs.realpathSync), modulesYaml (текст `.modules.yaml` или null - файла нет), readFile (чтение
 * файла вместо readIfExists), parseYaml (разбор текста), memo (Map мемо вместо мемо прогона). С
 * подменой текста, чтения или разбора мемо прогона не берётся и не пополняется: только своё opts.memo.
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
  const store = virtualStore(nm, root, o);
  if (store === null) return false;
  let dir;
  try {
    dir = realpath(path.resolve(nm, store));
  } catch (e) {
    if (isGone(e)) return false;
    throw e;
  }
  return strictlyUnder(real, dir);
}

/** virtualStoreDir по каталогу nm (realpath node_modules) и корню root - мемо на прогон: только ответ, исключение не запоминается. */
const modulesYamlMemo = new Map();
/**
 * virtualStoreDir из <nm>/.modules.yaml (underNodeModules): null - файла нет; не разбирается или
 * нет строки virtualStoreDir - исключение. Один раз на пару nm и root (yaml резолвится от root) -
 * ответ запоминается в мемо: o.memo кейса или мемо прогона, если текст, чтение и разбор не подменены;
 * с подменой без o.memo - без мемо (чужой ответ кейсу не достаётся и в прогон не уходит). Исключение
 * не запоминается: разовый сбой чтения (EBUSY, EACCES) не красит все следующие пробы графа - следующий
 * вопрос читает снова (решение техлида Р9 E0-12AA, как сверка версии git).
 */
function virtualStore(nm, root, o) {
  const substituted = o.modulesYaml !== undefined || Boolean(o.readFile) || Boolean(o.parseYaml);
  const memo = o.memo || (substituted ? null : modulesYamlMemo);
  const key = nm + '\0' + root;
  if (memo && memo.has(key)) return memo.get(key);
  const store = readVirtualStore(nm, root, o);
  if (memo) memo.set(key, store);
  return store;
}
/** Разбор <nm>/.modules.yaml без мемо (virtualStore): путь файла - в тексте отказа разбора. */
function readVirtualStore(nm, root, o) {
  const file = path.join(nm, '.modules.yaml');
  const text = o.modulesYaml !== undefined ? o.modulesYaml : (o.readFile || readIfExists)(file);
  if (text === null) return null;
  let store;
  try {
    // yaml берётся у корня без проверки underNodeModules: иначе круг (yaml сам резолвится через неё)
    const parse = o.parseYaml || require(require.resolve('yaml', { paths: [root] })).parse;
    store = parse(text).virtualStoreDir;
  } catch (e) {
    throw new Error(file + ' не разбирается yaml: ' + ((e && e.message) || String(e)));
  }
  if (typeof store !== 'string' || !store) throw new Error('в node_modules/.modules.yaml нет строки virtualStoreDir');
  return store;
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
 * turboEnv и с пределом TURBO_TIMEOUT_MS (SIGKILL). opts.run - точка запуска самопроверки (ctx.run;
 * решение техлида Р3 E0-12AA), без неё и без opts.spawn - исключение. opts.root - корень (по умолчанию
 * репозиторий), opts.platform/opts.arch - платформа (по умолчанию процесса), opts.env - окружение, из
 * которого turboEnv строит окружение turbo (по умолчанию процесса; кейс передаёт своё, не правя
 * process.env), opts.spawn - подмена запуска для кейсов веток отказа. Результат кэшируется на прогон
 * (пробы build, test:int и harness-selftest видят один снимок) только по явному opts.shared - его
 * ставит один вызов, чья точка запуска - run самопроверки (liveSnap, selftest-tree-graph.js), - и в
 * окружении процесса без подмены: ключ - корень и скрипты, а снимок без opts.shared (кейс с подменённым
 * opts.run), с opts.env или opts.spawn кэш не читает и не пополняет (замечание ревью E0-12AA: кейс с
 * окружением или фальшивым run получал чужой снимок или травил кэш прогона; решение техлида Р9).
 */
function turboDry(scripts, opts) {
  const o = opts || {};
  const root = o.root || ROOT;
  const key = root + '\0' + scripts.join(' ');
  const shared = o.shared === true && o.env === undefined && !o.spawn;
  if (shared && dryCache.has(key)) return dryCache.get(key);
  const what = 'turbo run ' + scripts.join(' ') + ' --dry=json';
  let bin;
  try {
    bin = turboBinary(root, o.platform || process.platform, o.arch || process.arch);
  } catch (e) {
    throw new Error(what + ': ' + ((e && e.message) || String(e)));
  }
  const spawn = o.spawn || o.run;
  if (typeof spawn !== 'function') throw new Error(what + ': нет точки запуска (opts.run) - turbo зовётся только через run самопроверки');
  const r = spawn(bin, ['run', ...scripts, '--dry=json'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: TURBO_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: turboEnv(o.env || process.env),
  });
  const dry = parseDry(r, what);
  if (shared) dryCache.set(key, dry);
  return dry;
}

module.exports = {
  ROOT,
  TURBO_TIMEOUT_MS,
  turboEnv,
  resolveFrom,
  underNodeModules,
  strictlyUnder,
  turboDry,
};
