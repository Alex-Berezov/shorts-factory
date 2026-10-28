'use strict';
/**
 * selftest-int.js - механика int-пробы для проб гейтов test:int и harness-selftest
 * (E0-12U, решение техлида Р2: отдельный модуль самопроверки, фабрика с ctx). Не хук: граница Node
 * и модуль разбора импортов test/imports.ts, дочерний vitest (selftest-vitest.mjs: старт без
 * ожидания, ответ, сверка формы), стаб int-пробы и обход чтений int-наборов на наложенном источнике.
 *
 * createIntProbe(ctx) только объявляет: процессов не запускает, файлов не пишет и строк check не
 * пишет. Состояние прогона (IMPORTS_GATE, INT_VITEST_START, VITEST_GATE) создаёт и держит вызывающий
 * (selftest-int-cases.js, кейсы int-пробы - там же) в прежнем порядке: дочерний vitest стартует startIntVitest в той же точке
 * прогона, снимки ему передаются параметром. Все объявления фабрики стоят до первого вызова её
 * функций - TDZ (замечание ревью E2 E0-12T) не возникает. ctx - замороженная общая инфраструктура
 * harness-selftest.js (реестр temp, LIVE_CHILDREN, модуль графа G).
 */

const fs = require('fs');
const path = require('path');

function createIntProbe(ctx) {
  const { G, HOOKS, L, LIVE_CHILDREN, ROOT, absent, holdTemp, put, releaseTemp, run, snapshotGate, spawn, tempDir } = ctx;

  /**
   * Граница Node и модуль разбора импортов (E0-12T, решение техлида Р2 E0-12L): проба test:int
   * грузит test/imports.ts через require - type stripping без флага и require(esm) - и гоняет
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

  /** Дочерний процесс конфигов vitest (selftest-vitest.mjs) и начало его строки вывода. */
  const VITEST_CHILD = path.join(HOOKS, 'selftest-vitest.mjs');
  // строки протокола ребёнка - один модуль на обе стороны (selftest-vitest.mjs берёт его же)
  const { VITEST_MARK, VITEST_EXIT_MARK } = require('./selftest-vitest-protocol.cjs');
  /** Предел дочернего vitest: замер E0-12T - 0,9 с на три конфига. */
  const VITEST_TIMEOUT_MS = 60 * 1000;
  /**
   * Код отказа «не запустился», когда pid нет, а повтор той же программы запустился (startVitest);
   * текст сверяют кейсы «pid нет, повтор запустился» проб int. Место константы порядка не держит:
   * функции фабрики зовут только после возврата createIntProbe, когда все её const уже
   * инициализированы (TDZ замечания ревью E2 E0-12T снят переносом в фабрику).
   */
  const SPAWN_CODE_UNKNOWN = 'код ошибки неизвестен (pid нет, повтор запустился)';
  /** Сколько awaitVitest и кейсы ждут конца процесса (pidGone) после строки выхода или SIGKILL. */
  const VITEST_GONE_MS = 2000;
  /**
   * Сколько awaitVitest ждёт конца процесса после SIGKILL до снятия из LIVE_CHILDREN и отдачи
   * вызывающему, который снимает каталог (TECH_DEBT 23.10.2026 E0-12T Fix 3a): на Windows процесс с
   * открытым файлом выходит не сразу; не дождался - отказ с pid, а не молчаливое снятие (каталог с его
   * файлами дал бы EBUSY и остаток в %TEMP%). 10 с - запас к VITEST_GONE_MS (2 с, замер E0-12T).
   */
  const VITEST_KILL_GONE_MS = 10 * 1000;

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

  /**
   * Конфиги int-наборов у самого vitest (E0-12T, решение техлида Р3 E0-12L): один дочерний
   * selftest-vitest.mjs на все пары [dir, command] (абсолютный каталог пакета и команда его
   * test:int). Один путь запуска: startVitest стартует процесс без ожидания, awaitVitest ждёт его
   * ответ (условный стоп 2 техлида E0-12T: асинхронный старт - секунда ребёнка идёт параллельно
   * пробам до первой, которой он нужен). Ответ - массив по парам: { dir, config, setupFiles,
   * globalSetup } (абсолютные пути) или { dir, error } - ошибка пары (нет --config, нет конфига, не
   * простой вызов vitest) - данные, а не отказ. Отказ, fail-closed (L-028), - vitestAnswer.
   *
   * startVitest(pairs, dir, opts): stdout и stderr ребёнка - в файлы каталога dir. Запуск и повтор -
   * через одну точку запуска самопроверки (ctx.spawn и ctx.run: дочерний node только с каталогом
   * состояния проб, решение техлида Р3 E0-12AA). opts - подмена для кейсов:
   *   bin - вместо process.execPath; child - вместо VITEST_CHILD;
   *   timeoutMs, goneMs, killGoneMs - вместо VITEST_TIMEOUT_MS, VITEST_GONE_MS, VITEST_KILL_GONE_MS;
   *   kill - снятие ребёнка вместо SIGKILL; spawn и spawnSync - вместо ctx.spawn и ctx.run;
   *   hold - корень временного каталога, который снимает releaseTemp вызывающего, когда dir - его
   *     подкаталог (по умолчанию dir): его держит killAndWait.
   * Процесс, который не запустился (pid нет - spawn сообщит ошибку только событием, а самопроверка
   * синхронна и цикла событий до выхода не отдаёт), - сразу отказ «не запустился: <код>»: код - у
   * синхронного повтора запуска той же программы (--version), повтор запустился - SPAWN_CODE_UNKNOWN;
   * предела отказ не ждёт. Запущенный ребёнок - в LIVE_CHILDREN до ответа: выход прогона его снимает.
   */
  function startVitest(pairs, dir, opts) {
    const o = opts || {};
    const bin = o.bin || process.execPath;
    const childFile = o.child || VITEST_CHILD;
    const out = path.join(dir, 'vitest-out.txt');
    const err = path.join(dir, 'vitest-err.txt');
    const fdOut = fs.openSync(out, 'w');
    const fdErr = fs.openSync(err, 'w');
    let child;
    try {
      child = (o.spawn || spawn)(bin, [childFile].concat(...pairs), { cwd: ROOT, stdio: ['ignore', fdOut, fdErr], windowsHide: true });
    } finally {
      fs.closeSync(fdOut);
      fs.closeSync(fdErr);
    }
    const h = {
      pairs, out, err, child, childFile, hold: o.hold || dir, timeoutMs: o.timeoutMs || VITEST_TIMEOUT_MS, goneMs: o.goneMs === undefined ? VITEST_GONE_MS : o.goneMs,
      killGoneMs: o.killGoneMs === undefined ? VITEST_KILL_GONE_MS : o.killGoneMs, kill: o.kill || ((c) => c.kill('SIGKILL')),
      started: performance.now(), spawnError: null,
    };
    // событие error придёт только после выхода синхронного прогона; без обработчика оно уронило бы
    // выход процесса
    child.on('error', () => {});
    if (child.pid === undefined) {
      const again = (o.spawnSync || run)(bin, ['--version'], { cwd: ROOT, stdio: 'ignore', windowsHide: true, timeout: 5000 });
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
   * синхронна), - зомби до сбора родителем, и kill(pid, 0) видит его живым; состояние Z (и X - dead,
   * TECH_DEBT 23.10.2026 E0-12T F10) в
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
        if (close !== -1 && (stat.charAt(close + 2) === 'Z' || stat.charAt(close + 2) === 'X')) return true;
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
        if (!pidGone(h.child.pid, h.goneMs)) killAndWait(h);
        LIVE_CHILDREN.delete(h.child);
        // код - целое числом без пробелов и знака «+»; иное (обрезанная строка, `1x`) - отказ, а не
        // Number('') = 0 - успех
        const text = exit.slice(VITEST_EXIT_MARK.length);
        if (!/^-?\d+$/.test(text)) throw new Error('selftest-vitest.mjs: строка выхода без целого кода: ' + JSON.stringify(exit));
        return vitestAnswer({ status: Number(text), signal: null, stdout, stderr: fs.readFileSync(h.err, 'utf8') }, h);
      }
      if (performance.now() - h.started > h.timeoutMs) {
        killAndWait(h);
        LIVE_CHILDREN.delete(h.child);
        return vitestAnswer({ status: null, signal: 'SIGKILL', stdout, stderr: '', error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) }, h);
      }
      Atomics.wait(pause, 0, 0, 20);
    }
  }

  /**
   * SIGKILL ребёнку запуска h (h.kill - подмена для кейса) и ожидание его конца (pidGone до
   * h.killGoneMs) - в обеих ветках awaitVitest, до снятия из LIVE_CHILDREN (TECH_DEBT 23.10.2026
   * E0-12T Fix 3a). Не вышел за предел - исключение с именем программы ребёнка и pid: ребёнок остаётся
   * в LIVE_CHILDREN, корень временного каталога вызывающего (h.hold, а не каталог файла вывода: у
   * fakeVitest это подкаталог корня) - в holdTemp (releaseTemp вызывающего его не трогает, второй
   * красной строки EBUSY нет); их снимет выход прогона, а отказ назван строкой пробы.
   */
  function killAndWait(h) {
    h.kill(h.child);
    if (!pidGone(h.child.pid, h.killGoneMs)) {
      const why = path.basename(h.childFile) + ': процесс ' + h.child.pid + ' жив через ' + h.killGoneMs / 1000 + ' с после SIGKILL - каталог его вывода не снять';
      holdTemp(h.hold, why);
      throw new Error(why);
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
   * Источник обхода int-наборов (пути от корня): read - текст модуля, isFile - модуль есть
   * (L.isFilePresent - один помощник «файл есть» обвязки), present - фикстура есть (не absent:
   * ENOENT и ENOTDIR - нет, иная ошибка - исключение).
   */
  const DISK = {
    read: (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8'),
    isFile: (rel) => L.isFilePresent(path.join(ROOT, rel)),
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
   * которым нужен ответ; null не возвращается (замечание ревью E4 E0-12T). gates - снимки прогона:
   * { graph, imports } (snapshotGate: GRAPH_GATE selftest-tree-graph.js и IMPORTS_GATE selftest-int-cases.js) и syntax
   * (SYNTAX_OK); кейс подменяет их.
   */
  function startIntVitest(gates) {
    const not = 'дочерний vitest не стартовал: ';
    if (gates.graph.error !== null) return { error: new Error(not + 'нет графа turbo (' + gates.graph.error + ')') };
    if (gates.imports.error !== null) return { error: new Error(not + 'test/imports.ts не загружен (' + gates.imports.error + ')') };
    if (gates.syntax.get('selftest-vitest.mjs') !== true) return { error: new Error(not + 'selftest-vitest.mjs не прошёл пробу синтаксиса') };
    const dir = tempDir('int-vitest');
    try {
      const stub = path.join(dir, 'stub');
      for (const [rel, body] of Object.entries(INT_STUB_FILES)) put(stub, rel, body);
      const roots = G.taskGraph(gates.graph.snap.dry, 'test:int').roots;
      const keys = Object.keys(INT_STUB_PAIRS);
      const pairs = roots.map((r) => [path.join(ROOT, r.dir), r.command])
        .concat([[stub, INT_STUB_COMMAND]], keys.map((k) => [stub, INT_STUB_PAIRS[k]]));
      return { dir, stub, roots, keys, handle: startVitest(pairs, dir) };
    } catch (e) {
      releaseTemp(dir);
      return { error: e };
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
        runs[key] = startVitest(FAKE_PAIRS, d, { hold: dir, child: path.join(d, 'child.js'), timeoutMs: FAKE_TIMEOUT_KEYS.includes(key) ? FAKE_VITEST_TIMEOUT_MS : undefined });
      }
      runs.noSpawn = startVitest(FAKE_PAIRS, sub('noSpawn'), { hold: dir, bin: 'sf-selftest-no-node' });
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

  return {
    NODE_LINES, NODE_NEED, nodeVerdict, importsGate, VITEST_CHILD, VITEST_MARK, SPAWN_CODE_UNKNOWN, VITEST_GONE_MS,
    INT_STUB_COMMAND, INT_STUB_PAIRS, startVitest, pidGone, VITEST_EXIT_MARK, awaitVitest, INT_PROBE_STATIC,
    JOINED_NOT_READ, REPO_ROOT_REVIEWED, DISK, overlaySource, VITEST_CONDITIONS, intProbeWalk, intProbeReads,
    relUnder, startIntVitest, readIntVitest, intForbidden, FAKE_VITEST_TIMEOUT_MS, FAKE_PAIRS, FAKE_VITEST,
    fakeVitest, fakeRefused,
  };
}

module.exports = { createIntProbe };
