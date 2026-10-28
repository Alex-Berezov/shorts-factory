'use strict';
/**
 * selftest-children.js - дочерние процессы самопроверки (E0-12AA, решения техлида Р3 и Р7): одна точка
 * запуска с проверкой состояния хуков (makeLauncher, hookStateGuard), окружение по белому списку
 * (envByList) и набор детей, запущенных без ожидания, с телом обработчика exit (makeChildRegistry).
 * Не хук: модуль самопроверки. Его берут через require процесс самопроверки, модули проб, дочерний
 * node проб запуска gates.js (selftest-gate-runner.js) и дочерний node кейса обработчика exit -
 * один модуль, без копии исходника (как реестр каталогов selftest-temp.js, решение техлида B4 E0-12T).
 *
 * Модуль child_process в модулях самопроверки берёт только этот файл (статическая проба
 * harness-selftest.js по имени модуля в кавычках; исключения - программы дочерних node по строке и
 * числу). Exit процесса здесь запрещён: модуль процессом не распоряжается.
 */

const cp = require('child_process');
const path = require('path');
const L = require('./lib.js');

/** Имя exit процесса для текстов программ дочерних node: склеено, иначе сверка NO_EXIT_FILES поймала бы текст. */
const PROCESS_EXIT = 'process' + '.exit';

/**
 * Переменные окружения родителя, которые получает дочерний процесс с окружением по белому списку
 * (git проб, gates.js проб запуска; TECH_DEBT 23.10.2026 E0-12U круг 2, L-030): поиск программы (PATH,
 * PATHEXT), системный каталог и диск Windows (git-for-windows без SystemRoot и ComSpec не стартует),
 * домашний, временный каталоги и каталоги данных профиля Windows, язык и локаль (LANG, LANGUAGE, LC_*)
 * и каталог состояния проб SF_HOOK_STATE_DIR (решение техлида Р7 E0-12AA: точка запуска требует его у
 * каждого ребёнка). Прочее (GIT_DIR, GIT_INDEX_FILE, NODE_OPTIONS, переменные оболочки...) в ребёнка не
 * уходит. Имена - без учёта регистра (Path).
 */
const CHILD_ENV_KEEP = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'WINDIR',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LANGUAGE',
  'SF_HOOK_STATE_DIR',
];
const CHILD_ENV_PREFIXES = ['LC_'];
/** Окружение base по белому списку CHILD_ENV_KEEP и CHILD_ENV_PREFIXES; extra - сверху. */
function envByList(base, extra) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    const name = k.toUpperCase();
    if (CHILD_ENV_KEEP.includes(name) || CHILD_ENV_PREFIXES.some((p) => name.startsWith(p))) env[k] = v;
  }
  return Object.assign(env, extra || {});
}

/** Пути a и b - один путь: сравнение в форме L.foldPath (решение техлида Р6 E0-12AA - одна нормализация). */
function samePath(a, b) {
  return L.foldPath(a) === L.foldPath(b);
}

/**
 * Окружение env дочернего процесса проб (решения техлида Р3 и Р7 E0-12AA): SF_HOOK_STATE_DIR задан,
 * абсолютный (относительный ребёнок разрешил бы от своего cwd, а не от cwd самопроверки) и не каталог
 * liveState - боевого .qa-state; иначе - исключение (хук в таком ребёнке или в его потомке писал бы
 * состояние сессии). Проверка одна для любой программы: обёртки (cmd /c, bash -c, pnpm exec) запускают
 * node с тем же окружением.
 */
function hookStateGuard(env, liveState) {
  const dir = env.SF_HOOK_STATE_DIR;
  if (typeof dir !== 'string' || dir === '') throw new Error('дочерний процесс без SF_HOOK_STATE_DIR - хук в нём писал бы боевой ' + liveState + '; передай окружение с каталогом состояния проб');
  if (!path.isAbsolute(dir)) throw new Error('дочерний процесс с относительным SF_HOOK_STATE_DIR (' + dir + ') - ребёнок разрешил бы его от своего cwd; передай абсолютный каталог состояния проб');
  if (samePath(path.join(dir, '.qa-state'), liveState)) throw new Error('дочерний процесс с SF_HOOK_STATE_DIR на каталоге боевого .qa-state (' + dir + ') - хук в нём писал бы состояние сессии');
}

/**
 * Одна точка запуска дочерних процессов самопроверки: { spawn, spawnSync } - как у child_process, но
 * каждый ребёнок (node, git, turbo, оболочка) идёт только с окружением, которое прошло hookStateGuard
 * (opts.env, иначе окружение этого процесса); отказ - исключение до запуска, его текст встаёт в строку
 * пробы. o.liveState - боевой .qa-state (обязателен: процесс самопроверки берёт путь lib.js statePath
 * без переопределения до того, как закроет его защёлкой lib.js, кейс - подставной), o.spawn и
 * o.spawnSync - подмена для кейса.
 */
function makeLauncher(opts) {
  const o = opts || {};
  if (typeof o.liveState !== 'string' || !o.liveState) throw new Error('makeLauncher без liveState - точке запуска не с чем сверять SF_HOOK_STATE_DIR');
  const liveState = o.liveState;
  const guard = (options) => hookStateGuard((options && options.env) || process.env, liveState);
  return {
    liveState,
    spawn(cmd, args, options) {
      guard(options);
      return (o.spawn || cp.spawn)(cmd, args, options);
    },
    spawnSync(cmd, args, options) {
      guard(options);
      return (o.spawnSync || cp.spawnSync)(cmd, args, options);
    },
  };
}

/**
 * Набор дочерних процессов, запущенных без ожидания (E0-12AA, TECH_DEBT 23.10.2026 E0-12T E9): тело
 * обработчика exit живёт здесь, его берут и самопроверка, и дочерний node кейса обработчика (там
 * exit процесса минует finally) - одно тело, без копии исходника.
 *   live - набор детей;
 *   kill(children) - снять каждого SIGKILL и очистить набор (по умолчанию live); ответ - сбои снятия
 *     («pid: текст»), кроме ESRCH (ребёнок уже вышел): иной сбой (EPERM) не глотается молча;
 *   onExit() - обработчик exit процесса: kill() общего набора, сбои - в stderr (код выхода первым
 *     аргументом ему не нужен - набор он не принимает).
 * deps.kill(child) - снятие одного ребёнка (по умолчанию child.kill('SIGKILL')); подмена - сторона
 * отказа кейса (пустое тело, бросающее снятие).
 */
function makeChildRegistry(deps) {
  const killOne = (deps && deps.kill) || ((child) => child.kill('SIGKILL'));
  const live = new Set();
  const kill = (children = live) => {
    const failed = [];
    for (const child of children) {
      try {
        killOne(child);
      } catch (e) {
        if (!e || e.code !== 'ESRCH') failed.push((child && child.pid) + ': ' + ((e && e.message) || String(e)));
      }
    }
    children.clear();
    return failed;
  };
  const onExit = () => {
    const failed = kill();
    if (failed.length) process.stderr.write('самопроверка: дети не сняты на выходе - ' + failed.join('; ') + '\n');
  };
  return { live, kill, onExit };
}

module.exports = { PROCESS_EXIT, envByList, samePath, makeLauncher, makeChildRegistry };
