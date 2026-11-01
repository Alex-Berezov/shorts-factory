'use strict';
/**
 * selftest-children.js - дочерние процессы самопроверки (E0-12AA, решения техлида Р3 и Р7): одна точка
 * запуска с проверкой состояния хуков (makeLauncher, hookStateGuard), окружение по белому списку
 * (envByList) и набор детей, запущенных без ожидания, с телом обработчика exit (makeChildRegistry).
 * Здесь же ребёнок в фоне (makeDetached; строка выхода - exitLineHook, её разбор - exitSplit, текст
 * отказа ребёнка без итога - childFailure), программа -e дочернего node с настройками из JSON
 * (childProgram), родительская сторона пакетного запуска (makeBatch; тело ребёнка - selftest-batch.js) и
 * запоминание старта в фоне и сбора (rememberOnce, lazyStart; модулям проб - через ctx).
 * Не хук: модуль самопроверки. Его берут через require процесс самопроверки, модули проб, дочерний
 * node проб запуска gates.js (selftest-gate-runner.js), дочерний node пакета (selftest-batch.js) и
 * дочерний node кейса обработчика exit - один модуль, без копии исходника (как реестр каталогов
 * selftest-temp.js, решение техлида B4 E0-12T).
 *
 * Модуль child_process в модулях самопроверки берёт только этот файл (статическая проба
 * harness-selftest.js по имени модуля в кавычках; исключения - программы дочерних node по строке и
 * числу). Exit процесса здесь запрещён: модуль процессом не распоряжается.
 */

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
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

/**
 * Код отказа «не запустился», когда pid нет, а повтор той же программы запустился (startDetached);
 * текст сверяют кейсы «pid нет, повтор запустился» проб int.
 */
const SPAWN_CODE_UNKNOWN = 'код ошибки неизвестен (pid нет, повтор запустился)';
/** Сколько awaitDetached и кейсы ждут конца процесса (pidGone) после строки выхода или SIGKILL. */
const DETACHED_GONE_MS = 2000;
/**
 * Сколько awaitDetached ждёт конца процесса после SIGKILL до снятия из набора детей и отдачи
 * вызывающему, который снимает каталог (TECH_DEBT 23.10.2026 E0-12T Fix 3a): на Windows процесс с
 * открытым файлом выходит не сразу; не дождался - отказ с pid, а не молчаливое снятие (каталог с его
 * файлами дал бы EBUSY и остаток в %TEMP%). 10 с - запас к DETACHED_GONE_MS (2 с, замер E0-12T).
 */
const DETACHED_KILL_GONE_MS = 10 * 1000;

/**
 * Процесса pid нет в течение ms (монотонные часы, паузы 20 мс; ms 0 - одна сверка): true; жив весь
 * срок - false. Linux: процесс, вышедший или убитый, пока цикл событий прогона занят (самопроверка
 * синхронна), - зомби до сбора родителем, и kill(pid, 0) видит его живым; состояние Z (и X - dead,
 * TECH_DEBT 23.10.2026 E0-12T F10) в /proc/<pid>/stat (или файла нет при читаемом /proc/self/stat) -
 * процесса нет (замечание ревью E1 E0-12T). Иначе - kill(pid, 0): ESRCH - нет. Иная ошибка чтения или
 * kill - «жив» (false), не исключение (решение техлида, круг 3). deps - подмена для кейса: platform,
 * readStat(pid) (текст /proc/<pid>/stat), kill.
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
      if (close !== -1 && (stat.charAt(close + 2) === 'Z' || stat.charAt(close + 2) === 'X')) return true;
    }
    try {
      d.kill(pid, 0);
    } catch (e) {
      return Boolean(e && e.code === 'ESRCH');
    }
    return false;
  };
  const t0 = performance.now();
  for (;;) {
    if (gone()) return true;
    if (performance.now() - t0 >= ms) return false;
    L.pauseSync(20);
  }
}

/**
 * Ребёнок в фоне (E0-12AC; обобщение startVitest/awaitVitest E0-12T): самопроверка синхронна и событий
 * дочернего процесса до своего выхода не получает, поэтому ребёнок пишет stdout и stderr в файлы, а
 * конец ответа - строкой выхода (exitMark и код, целая строка) из своего обработчика exit; ответ
 * забирает синхронный опрос файла. deps - состояние прогона: spawn и spawnSync - точка запуска
 * самопроверки (makeLauncher, решение техлида Р3 E0-12AA), live - набор детей (makeChildRegistry:
 * выход прогона до ответа снимает их SIGKILL), holdTemp(dir, why) - каталог, который держит не снятый
 * ребёнок (releaseTemp вызывающего его не трогает).
 *
 * startDetached(cmd, args, opts) - старт без ожидания; opts:
 *   dir, name - файлы <dir>/<name>-out.txt и <dir>/<name>-err.txt; exitMark - начало строки выхода;
 *   what - чей ответ в тексте отказа строки выхода; label - имя ребёнка в тексте отказа снятия;
 *   cwd, env - как у spawn; timeoutMs - предел ответа (обязателен), goneMs, killGoneMs - вместо
 *   DETACHED_GONE_MS и DETACHED_KILL_GONE_MS; kill - снятие ребёнка вместо SIGKILL; spawn и spawnSync -
 *   подмена точки запуска для кейса; hold - корень временного каталога, который снимает releaseTemp
 *   вызывающего, когда dir - его подкаталог (по умолчанию dir): его держит killAndWait.
 * Процесс, который не запустился (pid нет - spawn сообщит ошибку только событием), - сразу отказ: код - у
 * синхронного повтора запуска той же программы (--version), повтор запустился - SPAWN_CODE_UNKNOWN.
 * Запущенный ребёнок - в live до ответа.
 *
 * awaitDetached(h) - синхронное ожидание строки выхода в файле stdout с паузами L.pauseSync по
 * монотонным часам; дальше - конец процесса (pidGone до goneMs: строку выхода пишет его обработчик exit,
 * процесс ещё жив и держит файлы каталога; не вышел за срок - SIGKILL и killAndWait, не отказ: ответ уже
 * полон). Ответ - { status, signal, stdout, stderr } (как у spawnSync) и body - stdout без строки выхода
 * (exitSplit: один разбор на всех вызывающих - и поиск строки выхода, и тело); строка выхода без целого кода -
 * исключение «<what>: строка выхода без целого кода». Конец процесса сверяется до чтения файла на каждом
 * опросе: вышедший без строки выхода ребёнок (OOM, падение node, SIGKILL снаружи) - сразу { status: null,
 * signal: null, stdout, stderr, body } (не дошёл до итога; причину называет stderr), а не ETIMEDOUT через
 * весь предел. Предел - timeoutMs от запуска (h.startedAt, startDetached), ответ сверяется раньше
 * предела: ребёнок, ответивший до сбора, отдаёт ответ и при сборе позже предела, а зависший на старте не
 * получает сверх timeoutMs от запуска; нет строки выхода к пределу - SIGKILL, killAndWait и
 * { status: null, signal: 'SIGKILL', stderr, error: ETIMEDOUT } (stderr - из файла: причина зависания в
 * тексте отказа); не запустился - { error } с кодом.
 * killAndWait(h) - SIGKILL (h.kill) и ожидание конца до killGoneMs: вышел - снят из live; не вышел -
 * исключение с label и pid, ребёнок остаётся в live, h.hold - в holdTemp.
 */
function makeDetached(deps) {
  const { spawn, spawnSync, live, holdTemp } = deps;
  function startDetached(cmd, args, opts) {
    const o = opts || {};
    if (!(o.timeoutMs > 0)) throw new Error('startDetached ' + o.label + ': предел ответа timeoutMs не задан');
    const out = path.join(o.dir, o.name + '-out.txt');
    const err = path.join(o.dir, o.name + '-err.txt');
    const fdOut = fs.openSync(out, 'w');
    const fdErr = fs.openSync(err, 'w');
    let child;
    try {
      const spawnOpts = { cwd: o.cwd, stdio: ['ignore', fdOut, fdErr], windowsHide: true };
      if (o.env) spawnOpts.env = o.env;
      child = (o.spawn || spawn)(cmd, args, spawnOpts);
    } finally {
      fs.closeSync(fdOut);
      fs.closeSync(fdErr);
    }
    const h = {
      out, err, child, what: o.what, label: o.label, exitMark: o.exitMark, hold: o.hold || o.dir, timeoutMs: o.timeoutMs,
      goneMs: o.goneMs === undefined ? DETACHED_GONE_MS : o.goneMs,
      killGoneMs: o.killGoneMs === undefined ? DETACHED_KILL_GONE_MS : o.killGoneMs, kill: o.kill || ((c) => c.kill('SIGKILL')),
      spawnError: null, startedAt: performance.now(),
    };
    // событие error придёт только после выхода синхронного прогона; без обработчика оно уронило бы
    // выход процесса
    child.on('error', () => {});
    if (child.pid === undefined) {
      const again = (o.spawnSync || spawnSync)(cmd, ['--version'], { cwd: o.cwd, stdio: 'ignore', windowsHide: true, timeout: 5000 });
      h.spawnError = (again.error && again.error.code) || SPAWN_CODE_UNKNOWN;
      return h;
    }
    // процесс прогона не ждёт ребёнка: его ответ забирает awaitDetached, а пробе, которая до него не
    // дошла, ребёнок не нужен - выход прогона снимает его (набор live)
    child.unref();
    live.add(child);
    return h;
  }
  function awaitDetached(h) {
    if (h.spawnError) return { error: Object.assign(new Error(h.spawnError), { code: h.spawnError }), status: null, signal: null, stdout: '', stderr: '', body: '' };
    for (;;) {
      // конец процесса - до чтения файла: вышедший ребёнок больше не пишет, прочитанное - весь его вывод
      const gone = pidGone(h.child.pid, 0);
      const stdout = fs.readFileSync(h.out, 'utf8');
      const { exit, body } = exitSplit(stdout, h.exitMark);
      if (exit !== undefined) {
        if (!gone && !pidGone(h.child.pid, h.goneMs)) killAndWait(h);
        live.delete(h.child);
        // код - целое числом без пробелов и знака «+»; иное (обрезанная строка, `1x`) - отказ, а не
        // Number('') = 0 - успех
        const text = exit.slice(h.exitMark.length);
        if (!/^-?\d+$/.test(text)) throw new Error(h.what + ': строка выхода без целого кода: ' + JSON.stringify(exit));
        return { status: Number(text), signal: null, stdout, stderr: fs.readFileSync(h.err, 'utf8'), body };
      }
      if (gone) {
        // вышел без строки выхода - не дошёл до итога: ждать предела нечего
        live.delete(h.child);
        return { status: null, signal: null, stdout, stderr: fs.readFileSync(h.err, 'utf8'), body };
      }
      if (performance.now() - h.startedAt > h.timeoutMs) {
        killAndWait(h);
        return { status: null, signal: 'SIGKILL', stdout, stderr: fs.readFileSync(h.err, 'utf8'), body, error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
      }
      L.pauseSync(20);
    }
  }
  function killAndWait(h) {
    h.kill(h.child);
    if (!pidGone(h.child.pid, h.killGoneMs)) {
      const why = h.label + ': процесс ' + h.child.pid + ' жив через ' + h.killGoneMs / 1000 + ' с после SIGKILL - каталог его вывода не снять';
      holdTemp(h.hold, why);
      throw new Error(why);
    }
    live.delete(h.child);
  }
  return { startDetached, awaitDetached, killAndWait };
}

/**
 * Разбор stdout дочернего node со строкой выхода (exitMark и код; её пишет обработчик exit ребёнка -
 * exitLineHook - с переводом строки перед ней): один разбор для ребёнка в фоне (awaitDetached) и
 * синхронного ребёнка пакета (runBatch). exit - ПОСЛЕДНЯЯ целая строка (с переводом строки после неё:
 * хвост без него ребёнок, может быть, ещё дописывает), что начинается с exitMark; строка с exitMark раньше
 * неё - тело, а не конец ответа. body - stdout до перевода строки перед строкой выхода; строки выхода нет -
 * { exit: undefined, body: stdout целиком }.
 * Инвариант протокола: метку в начале строки пишет только exitLineHook, одним write; боевые дети и
 * selftest-vitest.mjs отдают тело одной JSON-строкой под своей меткой, так что метка в начале строки тела -
 * только кейс G9. Разбор по потоку тела поэтому не различает метку в теле и строку выхода; отдельный канал
 * конца ответа - E0-12AE (docs/TECH_DEBT.md).
 */
function exitSplit(stdout, exitMark) {
  const text = String(stdout || '');
  let at = -1;
  let exit;
  for (let start = 0, nl = text.indexOf('\n'); nl !== -1; start = nl + 1, nl = text.indexOf('\n', start)) {
    const line = text.slice(start, nl).replace(/\r$/, '');
    if (line.startsWith(exitMark)) {
      at = start;
      exit = line;
    }
  }
  if (at === -1) return { exit: undefined, body: text };
  return { exit, body: text.slice(0, at).replace(/\r?\n$/, '') };
}

/**
 * Строка выхода дочернего node: обработчик exit процесса пишет в stdout целую строку <mark><код> с
 * переводом строки перед ней - и после итога, и при падении. Одно тело на всех детей с ответом через
 * строку выхода: ребёнок проб запуска gates.js и ребёнок пакета зовут функцию, программа ребёнка пробы
 * runGate с поддельным процессом берёт её текст (exitLineHook.toString()) - копии склейки нет.
 * Инвариант: только эта функция пишет метку в начале строки stdout ребёнка, одним write (перевод строки до
 * метки и после кода - в том же write); тело ребёнка метки в начале строки не пишет (см. exitSplit).
 */
function exitLineHook(mark) {
  process.on('exit', (code) => process.stdout.write('\n' + mark + code + '\n'));
}

/**
 * Причина в тексте отказа ребёнка без итога: код ошибки запуска или предела (ETIMEDOUT) и начало stderr
 * (или stdout без строки выхода - body), до 200 символов. Предел без stderr - только код; stderr без
 * ошибки - только он: зависший ребёнок назван и пределом, и тем, что успел написать.
 */
function childFailure(r, body = r.body) {
  return [r.error && (r.error.code || r.error.message), String(r.stderr || body || '')].filter(Boolean).join(': ').slice(0, 200);
}

/**
 * Программа -e дочернего node, который берёт тело из модуля file (абсолютный путь) и зовёт его функцию fn
 * с настройками - JSON из source (выражение пути для readFileSync: '0' - stdin, иначе JSON.stringify пути
 * файла): одна форма для ребёнка проб запуска gates.js (gateRunner) и ребёнка пакета (batchRunner).
 * Настройки - не текстом -e: командная строка Windows - до 32 767 символов (ENAMETOOLONG).
 */
function childProgram(file, fn, source) {
  return 'require(' + JSON.stringify(file) + ').' + fn + '(JSON.parse(require("fs").readFileSync(' + source + ', "utf8")));';
}

/** Предел одновременных заданий пакета: не меньше 2, не больше 8 и числа ядер. */
const BATCH_LIMIT = Math.max(2, Math.min(8, os.availableParallelism()));
/** Предел ответа ребёнка пакета - и синхронного (runBatch), и в фоне (startBatch). */
const BATCH_TIMEOUT_MS = 120 * 1000;
/** Начало итога пакета: строка `batch <JSON>` (задания пишут в свои пайпы, не в stdout пакета). */
const BATCH_MARK = 'batch ';
/**
 * Начало строки выхода пакета (как RUNNER_EXIT_MARK ребёнка проб запуска): целая строка
 * <BATCH_EXIT_MARK><код> после итога, её пишет обработчик exit selftest-batch.js - и при готовом итоге, и
 * при сбое пакета. Пакет в фоне - конец его ответа в файле stdout; синхронный разбор её срезает (exitSplit).
 */
const BATCH_EXIT_MARK = 'selftest-batch-exit ';
/** Тело дочернего node пакета. */
const BATCH_FILE = path.join(__dirname, 'selftest-batch.js');

/**
 * Пакетный запуск, родительская сторона (E0-12AC, TECH_DEBT 23.10.2026 «E0-12T (условный стоп 2 техлида)»;
 * решение техлида «блокер architecture» E0-12AC - общая часть здесь, подготовка проб standards - в
 * harness-selftest.js): задания jobs ({ args, input, cwd, env, capMs, capAfterOutput, slot, write } - node с args, см.
 * selftest-batch.js) идут в одном дочернем node параллельно, не больше BATCH_LIMIT разом. deps - состояние
 * прогона: run (синхронная точка запуска), startDetached и awaitDetached (makeDetached), put (файл в
 * каталоге реестра), liveState (боевой .qa-state - точке запуска ребёнка пакета), cwd (каталог ребёнка).
 *   runBatch(jobs, opts) - синхронно: настройки - на stdin ребёнка, предел ответа - opts.timeoutMs или
 *     BATCH_TIMEOUT_MS (spawnSync снимает ребёнка и закрывает его пайпы; зависшее задание с внуком
 *     самопроверку не держит);
 *   startBatch(jobs, dir) - в фоне (startDetached: stdin ребёнка закрыт), настройки - файлом в dir;
 *     ответ отдаёт возвращённая функция (ждёт ребёнка).
 * Ответ - { code, signal, hung, out, err } по каждому заданию в порядке заданий. Ребёнок без строки итога
 * (упал, отказ настроек, снят по пределу) - исключение с кодом и началом stderr, один текст для обоих
 * способов (batchAnswer). opts.limit и opts.liveState - вместо BATCH_LIMIT и deps.liveState (кейс).
 */
function makeBatch(deps) {
  const { run, startDetached, awaitDetached, put, liveState, cwd } = deps;
  function batchConfig(jobs, opts) {
    const o = opts || {};
    return { jobs, limit: o.limit === undefined ? BATCH_LIMIT : o.limit, liveState: o.liveState === undefined ? liveState : o.liveState };
  }
  // итог - одной строкой body: текст заданий внутри JSON, отдельных строк ребёнок не пишет
  function batchAnswer(r, body) {
    const notDone = () => new Error('пакетный запуск не дошёл до итога (код ' + r.status + '): ' + childFailure(r, body));
    if (r.status !== 0 || !body.startsWith(BATCH_MARK)) throw notDone();
    try {
      return JSON.parse(body.slice(BATCH_MARK.length));
    } catch (_) {
      // итог оборван (вывод не дописан до выхода) - тот же отказ с началом итога, а не голый SyntaxError
      throw notDone();
    }
  }
  function runBatch(jobs, opts) {
    const o = opts || {};
    const r = run(process.execPath, ['-e', childProgram(BATCH_FILE, 'batchRunner', '0')], {
      cwd, input: JSON.stringify(batchConfig(jobs, o)), timeout: o.timeoutMs === undefined ? BATCH_TIMEOUT_MS : o.timeoutMs, killSignal: 'SIGKILL',
    });
    return batchAnswer(r, exitSplit(r.stdout, BATCH_EXIT_MARK).body);
  }
  function startBatch(jobs, dir) {
    const cfgFile = put(dir, 'batch.json', JSON.stringify(batchConfig(jobs)));
    const handle = startDetached(process.execPath, ['-e', childProgram(BATCH_FILE, 'batchRunner', JSON.stringify(cfgFile))], {
      dir, name: 'batch', cwd, exitMark: BATCH_EXIT_MARK, what: 'selftest-batch.js', label: 'selftest-batch.js', timeoutMs: BATCH_TIMEOUT_MS,
    });
    return () => {
      const r = awaitDetached(handle);
      return batchAnswer(r, r.body);
    };
  }
  return { runBatch, startBatch };
}

/**
 * Геттер, который зовёт take один раз (E0-12AC, L-043): ответ или исключение запоминаются, следующие
 * вызовы отдают тот же ответ или бросают то же исключение, не зовя take заново.
 */
function rememberOnce(take) {
  let memo = null;
  return () => {
    if (!memo) {
      try {
        memo = { failed: false, value: take() };
      } catch (e) {
        // исход - флагом, а не истинностью исключения: throw undefined (null, 0, '') - тоже сбой
        memo = { failed: true, error: e };
      }
    }
    if (memo.failed) throw memo.error;
    return memo.value;
  };
}

/**
 * Старт в фоне и сбор (E0-12AC, решение техлида «пять копий» после Fix 1): build() готовит и запускает
 * ребёнка и отдаёт функцию сбора.
 *   start() - зовёт build один раз, запоминает функцию сбора или ошибку, не бросает;
 *   collect() - start(), если его не звали; итог сбора или ошибка (и ошибка старта) запоминаются
 *     (rememberOnce) и бросаются каждому потребителю тем же текстом;
 *   started() - start() уже звали.
 */
function lazyStart(build) {
  let begun = null;
  function start() {
    if (begun) return;
    try {
      begun = { failed: false, collect: build() };
    } catch (e) {
      // исход - флагом, как у rememberOnce: build, бросивший undefined, - тоже сбой старта
      begun = { failed: true, error: e };
    }
  }
  const collect = rememberOnce(() => {
    start();
    if (begun.failed) throw begun.error;
    return begun.collect();
  });
  return { start, collect, started: () => begun !== null };
}

module.exports = {
  PROCESS_EXIT, SPAWN_CODE_UNKNOWN, DETACHED_GONE_MS,
  BATCH_LIMIT, BATCH_MARK, BATCH_EXIT_MARK,
  envByList, samePath, makeLauncher, makeChildRegistry, pidGone, makeDetached, exitLineHook, childFailure, childProgram, makeBatch,
  rememberOnce, lazyStart,
};
