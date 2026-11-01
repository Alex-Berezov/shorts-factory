'use strict';
/**
 * selftest-gates-run.js - пробы запуска gates.js (E0-12U: раздел гейтов harness-selftest.js по
 * заботам): require без побочных эффектов, предел гейта (gateTimeoutSec, timeoutSec правил),
 * --only, runGate (предел, снятие дерева, вывод) и gates.js из командной строки (сводка, файлы
 * вывода, сигналы, stdin), фон вызова gates.js в командах. Не хук: модуль самопроверки.
 *
 * При require модуль только объявляет: registerGateRunProbes(ctx) пишет строки через check из ctx в
 * прежнем порядке и отдаёт gatesModule - загрузчик gates.js для проб выбора гейтов (только после
 * зелёной пробы require). Тело дочернего node проб запуска - selftest-gate-runner.js (E0-12AA): этот
 * модуль работает в процессе самопроверки и выходит из процесса только через report() (NO_EXIT_FILES
 * harness-selftest.js); exit процесса в программах дочерних node собирается из частей (EXIT).
 */

const fs = require('fs');
const path = require('path');
// имя exit процесса для программ дочерних node - склеено один раз в selftest-children.js (L-042)
const { PROCESS_EXIT: EXIT } = require('./selftest-children.js');
// суффикс отметки старта внука - одна строка протокола с gcStartedAt (решение техлида Р9 E0-12AA); при
// require модуль ничего не исполняет, exit - только в gateRunner дочернего node
const { STARTED_SUFFIX } = require('./selftest-gate-runner.js');

function registerGateRunProbes(ctx) {
  const { CLAUDE, HOOKS, LIVE_STATE, ROOT, check, copyHooksTo, gitStrict, put, releaseTemp, repoRules, run, tempDir } = ctx;

  /**
   * gates.js - модуль для проб и скрипт для человека: main() под require.main === module.
   * Проба грузит его require в отдельном процессе, где всё, что main() сделал бы при загрузке,
   * безопасно и видно: argv - полный прогон (без --list), список изменённых файлов подменён
   * (L.allChanged - один репозиторий с одним гейтом always), каждый запуск child_process
   * (spawn, spawnSync, exec, execSync, execFile, execFileSync, fork - с shell и без) подменён
   * счётчиком с пустым ответом, exit процесса - записью кода. Без стража main() дошёл бы до
   * конца: «прогнал» бы гейт, поставил бы отметку lastGates (markGates - только после
   * настоящего полного прогона, поэтому --list её не проверял бы) и вышел бы из процесса.
   * У гейта пробы есть timeoutSec (без него runGate ответил бы «нет предела», не дойдя до cp.spawn),
   * подменённый spawn сразу «завершает» команду, а итог пробы печатается на beforeExit - когда цикл
   * событий опустел: main() асинхронный, и без стража его запуск, отметка и выход идут после
   * await, позже синхронного конца require - E0-12M, C8.
   * Ждём код 0, пустой stderr, в stdout ровно строку итога пробы, ноль запусков, ни одного
   * exit процесса и ни одной отметки в состоянии пробы (своя временная папка,
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
        // команда «отработала» сразу: main() без стража дошёл бы до сводки, markGates и exit процесса
        "    setImmediate(() => { child.emit('exit', 0, null); child.emit('close', 0, null); });",
        '    return child;',
        '  };',
        '}',
        'const L = require(' + JSON.stringify(path.join(HOOKS, 'lib.js')) + ');',
        // у гейта есть предел: без него runGate ответил бы «нет предела», не дойдя до cp.spawn
        "L.allChanged = () => [{ repo: { name: 'probe', path: process.cwd() }, rules: { gates: [{ id: 'probe', cmd: 'probe', when: 'always', timeoutSec: 30 }] }, files: ['probe.txt'] }];",
        'let exited = null;',
        'const exit = ' + EXIT + ';',
        EXIT + ' = (c) => { if (exited === null) exited = c === undefined ? 0 : c; };',
        'process.argv = [process.execPath, ' + JSON.stringify(file) + '];',
        'const g = require(' + JSON.stringify(file) + ');',
        // main() асинхронный: снимок - когда цикл событий опустел, то есть после всего, что main()
        // успел бы сделать без стража (запуск, отметка, exit процесса после await)
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
      if (seen.exited !== null) why.push('вызван exit процесса (' + seen.exited + ')');
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
   *   killNoop - снятие ответило успехом, ничего не сняв (SF_PROBE_KILL_NOOP): «СНЯТЬ РУКАМИ», не «снят»;
   *   touchNone, touched, touchedContent (E0-12AB) - полный прогон в своём дереве (SF_PROBE_ROOT, гейты
   *     SF_PROBE_RULES=touch): без правки - отметка с кодом 0; гейт создал файл или дописал b.txt при прежней
   *     зелёной отметке (SEED_GREEN) - отметка с кодом 1, код 1, «Дифф изменился во время прогона» (решение
   *     техлида Р6); дерево пробы под .gitignore, в диффе только b.txt;
   *   remnant - оболочка вышла с 0, detached-внук держит вывод: метка остатка в итоге и сводке, код 1;
   *   onlyBothDirty - изменения в sf, --only=<гейт обоих>: гейт идёт в sf, other назван с --repo;
   *   killPartial, killPartialOpen (только Windows) - код taskkill подменён на 255 (SF_PROBE_KILL_STATUS):
   *     дерево снято и вывод закрылся - «СНЯТ ПО ПРЕДЕЛУ»; ничего не снято (SF_PROBE_KILL_NOOP) - «СНЯТЬ РУКАМИ»;
   *   killStatusOne (только Windows) - код taskkill 1 при снятом дереве: «СНЯТЬ РУКАМИ» (решение техлида Р5);
   *   touchedRed, markFail - в состоянии прежняя зелёная отметка (SEED_GREEN): красный прогон с правкой b.txt
   *     пишет красную отметку; сверка диффа после прогона бросает (SF_PROBE_MOVED_FAIL) - код 1, красная отметка;
   *   markWriteFail - сверка бросает и запись красной отметки тоже (SF_PROBE_MARK_FAIL): код 1, прежняя
   *     отметка осталась и это сказано; mainFail - main() бросил после снятия меток (снимок до очереди,
   *     SF_PROBE_SNAP_FAIL, перед отказом создаёт during.txt - SF_PROBE_TOUCH=new): код 1, красная отметка по
   *     меткам до очереди (Р9 п.1); labelsFail - main() бросил до снятия меток (SF_PROBE_LABELS_FAIL): код 1,
   *     красная отметка по текущему диффу (Р9 п.2); stateLocked - .qa-state и его каталог только для чтения,
   *     гейты зелёные: код 1, прежняя отметка осталась и это сказано (Р9 п.8); nestedDir - метка-каталог (вложенный git в корне дерева): отметка с кодом 1,
   *     причина «метка-каталог» в строке «Дифф изменился» (решение техлида Р6); fullSignal - полный прогон
   *     (SF_PROBE_RULES=touchSig) прерван SIGINT на старте гейта с внуком: код 130, внук снят, прежняя зелёная
   *     отметка заменена красной по диффу до запуска (решение техлида Р7); внук до файла PID создаёт
   *     during.txt (SF_PROBE_TOUCH=new) - отметка по текущему диффу, а не по меткам до очереди, краснеет (Р8);
   *   fullClean - полный прогон на чистом дереве: снимков диффа ни одного (файлы не читаются).
   * Шпион считает и снимки диффа (H.diffSnapshot копии diff-hash.js) и аргументы taskkill.
   * Случаи E0-12AB (CLI_STAGE_TWO) - этап 2 ребёнка проб: после возврата всех случаев runGate и прежних
   * запусков (решение техлида Р4 E0-12AB), их нагрузка не сдвигает окна проб runGate.
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
  /** Запуски gates.js этапа 2 ребёнка проб (решение техлида Р4 E0-12AB); killPartial* - только на Windows. */
  const CLI_STAGE_TWO = ['touchNone', 'touched', 'touchedContent', 'touchedRed', 'markFail', 'markWriteFail', 'mainFail', 'labelsFail', 'stateLocked', 'nestedDir', 'fullSignal', 'remnant', 'onlyBothDirty', 'killPartial', 'killPartialOpen', 'killStatusOne'];
  /** Внуки случаев этапа 2 (решение техлида Р7 E0-12AB): их пульс читается после этапа 2, остальных - после этапа 1. */
  const WATCH_STAGE_TWO = ['held', 'partial', 'partialNoop', 'partialOne', 'fullSig'];
  /** Срок жизни внука gc.js: выходит сам, чтобы не пережить пробу; пульс, прочитанный позже, ничего не доказывает. */
  const GC_LIFE_MS = 30000;
  /** Прежняя зелёная отметка в состоянии случаев SEEDED_GREEN: набор имён - дифф их дерева (sf/b.txt). */
  const SEED_GREEN = { hash: 'seed-green', files: ['sf/b.txt'], code: 0, at: '2000-01-01T00:00:00.000Z' };
  /** Случаи с прежней зелёной отметкой: она не должна пережить ни один из них. */
  const SEEDED_GREEN = ['touched', 'touchedContent', 'touchedRed', 'markFail', 'markWriteFail', 'mainFail', 'labelsFail', 'stateLocked', 'nestedDir', 'fullSignal'];
  function buildGateRunCases() {
    const { limits } = gatesModule();
    // без умолчания: снятый экспорт - красная строка, а не молча 2 с
    const grace = limits && limits.KILL_GRACE_MS;
    if (!Number.isInteger(grace) || grace <= 0) throw new Error('gates.js не экспортирует limits.KILL_GRACE_MS: ' + JSON.stringify(grace));
    const dir = tempDir('rungate');
    // каталог состояния stateLocked, закрытый на запись: права возвращаются до удаления дерева пробы
    let lockedState = null;
    try {
      const q = (p) => '"' + p + '"';
      const cmd = (...args) => [process.execPath].concat(args).map(q).join(' ');
      const sleep = put(dir, 'bin/sleep.js', 'setTimeout(() => {}, 30000);\n');
      // сон с отметкой старта (T8, TECH_DEBT 21.10.2026 E0-12M круг 3): окно «вернулся за предел + запас»
      // считается от фактического старта ребёнка, а не от spawn - медленный старт на занятой машине не красит
      const sleepStarted = path.join(dir, 'started-sleep');
      const sleepMarked = put(dir, 'bin/sleep-marked.js', 'require("fs").writeFileSync(' + JSON.stringify(sleepStarted) + ', String(Date.now()));\nsetTimeout(() => {}, 30000);\n');
      // правка диффа «новый файл» (SF_PROBE_TOUCH=new) - одна строка программы на всех, кто её делает (внук
      // gc.js, гейт bin/touch.js, предзагрузка gates.js): during.txt в каталоге where (выражение JS программы)
      const touchNew = (where) => "if (process.env.SF_PROBE_TOUCH === 'new') require('fs').writeFileSync(require('path').join(" + where + ", 'during.txt'), 'during');";
      const gc = put(dir, 'bin/gc.js', [
        "const fs = require('fs');",
        'const [pidFile, hbFile] = process.argv.slice(2);',
        // отметка старта - часы ОС внука текстом, до файла PID (gcStartedAt, selftest-gate-runner.js)
        // fullSignal (SF_PROBE_TOUCH=new, как bin/touch.js): новый файл в корне репозитория sf до файла PID -
        // сигнал приходит при диффе, сдвинувшемся после снятия меток; отметка обязана лечь по меткам до очереди
        touchNew("'.'"),
        'fs.writeFileSync(pidFile + ' + JSON.stringify(STARTED_SUFFIX) + ', String(Date.now()));',
        'fs.writeFileSync(pidFile, String(process.pid));',
        'const beat = () => fs.writeFileSync(hbFile, Date.now() + " " + Math.random());',
        'beat();',
        'setInterval(beat, 100);',
        'setTimeout(() => ' + EXIT + '(0), ' + GC_LIFE_MS + ');',
      ].join('\n'));
      // tree: внук держит вывод, ребёнок спит; orphan: внук держит вывод, ребёнок выходит с кодом 3,
      // как только внук записал свой PID (внук точно был, когда оболочка вышла). На Windows libuv
      // снимает не-detached детей node вместе с ним (job object), поэтому переживает ребёнка там
      // только detached-внук; на POSIX внук остаётся в группе гейта. orphanAway - внук detached на
      // обеих системах (POSIX - своя сессия): снятие группы при выходе оболочки его не достаёт.
      const spawnGc = (opts) => "const c = require('child_process').spawn(process.execPath, process.argv.slice(2), { stdio: 'inherit'" + opts + ' });';
      const tree = put(dir, 'bin/tree.js', spawnGc('') + '\nsetTimeout(() => {}, 30000);\n');
      const exitOnGc = (code) => "const up = setInterval(() => { if (require('fs').existsSync(process.argv[3])) { clearInterval(up); " + EXIT + '(' + code + '); } }, 20);';
      // orphan выходит с 0: зелёный код оболочки при живом остатке - ровно тот случай, где гейт обязан быть красным
      const orphan = put(dir, 'bin/orphan.js', [spawnGc(", detached: process.platform === 'win32'"), 'c.unref();', exitOnGc(0)].join('\n'));
      const orphanAway = put(dir, 'bin/orphan-away.js', [spawnGc(', detached: true'), 'c.unref();', exitOnGc(3)].join('\n'));
      // оболочка выходит с 0, detached-внук держит вывод (POSIX - своя сессия, снятие группы его не
      // достаёт): «ОСТАТОК ЖИВ» на обеих системах (E0-12AB, строка TECH_DEBT T6)
      const orphanHeld = put(dir, 'bin/orphan-held.js', [spawnGc(', detached: true'), 'c.unref();', exitOnGc(0)].join('\n'));
      const pass = put(dir, 'bin/pass.js', "console.log('ok');\n");
      // короткий красный: одна строка и код 3 - файл вывода пишется и ему (needsLog), не только длинному
      const failShort = put(dir, 'bin/fail-short.js', "console.log('short-red-line');\n" + EXIT + '(3);\n');
      // красный без вывода: файла нет - пустой ничего не объясняет; длинный зелёный (больше
      // FULL_LIMIT строк, меньше предела памяти) - файл есть: его середина на экране срезана
      const failSilent = put(dir, 'bin/fail-silent.js', EXIT + '(3);\n');
      const longGreen = put(dir, 'bin/long-green.js', "for (let i = 0; i < 260; i++) console.log('long-green-line-' + i);\n");
      // граница FULL_LIMIT (200): ровно 200 строк - целиком на экране и без файла, 201 - срез и файл
      const linesGreen = (n) => put(dir, 'bin/green-' + n + '.js', 'for (let i = 0; i < ' + n + "; i++) console.log('edge-line-' + i);\n");
      const green200 = linesGreen(200);
      const green201 = linesGreen(201);
      // читает stdin до конца и выходит 0: без stdin (ignore) конец ввода приходит сразу, с открытым
      // пайпом gates.js (inherit) или своим пайпом (pipe) - никогда, гейт висел бы до предела
      const stdinRead = put(dir, 'bin/stdin-read.js', "process.stdin.resume();\nprocess.stdin.on('end', () => { console.log('stdin-end'); " + EXIT + "(0); });\n");
      // выходит сам через 1,5 с - после предела 1 с, но в окне ожидания вывода
      const slow = put(dir, 'bin/slow.js', 'setTimeout(() => {}, 1500);\n');
      // голова - 11 байт, строка - 511 «ж» и перевод строки (1023 байта): граница головы (1 МиБ) и
      // начало хвоста (последний МиБ) приходятся на второй байт символа
      const flood = put(dir, 'bin/flood.js', "process.stdout.write('HEAD-START\\n' + ('ж'.repeat(511) + '\\n').repeat(5 * 1024) + 'TAIL-END!\\n');\n");
      const split = put(dir, 'bin/split.js', [
        "const b = Buffer.from('ПРИВЕТ-ЮНИКОД\\n', 'utf8');",
        'process.stdout.write(b.subarray(0, 1));',
        "setTimeout(() => { process.stderr.write('E\\n'); setTimeout(() => process.stdout.write(b.subarray(1)), 100); }, 100);",
      ].join('\n'));
      // больше 200 строк и больше предела памяти: gates.js пишет файл вывода и срезает середину
      const floodCli = put(dir, 'bin/flood-cli.js', "process.stdout.write(('y'.repeat(15) + '\\n').repeat(160 * 1024));\n");
      // гейт отметки по диффу (E0-12AB, шаг 1): во время прогона пишет в корень своего дерева - новый файл
      // (SF_PROBE_TOUCH=new) или дописывает уже изменённый b.txt (content); без переменной ничего не пишет
      const touchJs = put(dir, 'bin/touch.js', [
        "const fs = require('fs');",
        touchNew("'.'"),
        "if (process.env.SF_PROBE_TOUCH === 'content') fs.appendFileSync('b.txt', 'during\\n');",
      ].join('\n'));
      const marker = path.join(dir, 'marker-rungate');
      const cliMarker = path.join(dir, 'marker-cli');
      const mark = (m) => put(dir, 'bin/mark-' + path.basename(m) + '.js', 'require("fs").writeFileSync(' + JSON.stringify(m) + ', "ran");\n');
      const watch = {};
      const watchKeys = ['tree', 'orphan', 'afterExit', 'stuck', 'noop', 'held', 'partial', 'partialNoop', 'partialOne', 'fullSig'].concat(PROBE_SIGNALS.map(([s]) => s));
      for (const k of watchKeys) watch[k] = { pid: path.join(dir, 'gc-' + k + '.pid'), hb: path.join(dir, 'gc-' + k + '.hb') };
      for (const k of WATCH_STAGE_TWO) watch[k].stage = 2;
      const withGc = (file, k) => cmd(file, gc, watch[k].pid, watch[k].hb);
      const cap = (sec) => sec * 1000 + grace + 20000;
      const gates = {
        sleep: { gate: { id: 'probe-sleep', cmd: cmd(sleepMarked), timeoutSec: 1 }, capMs: cap(1) },
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
          { id: 'p-orphan-held', cmd: withGc(orphanHeld, 'held'), when: 'never', timeoutSec: 30 },
          { id: 'p-stuck-255', cmd: cmd(gc, watch.partial.pid, watch.partial.hb), when: 'never', timeoutSec: 1 },
          { id: 'p-noop-255', cmd: cmd(gc, watch.partialNoop.pid, watch.partialNoop.hb), when: 'never', timeoutSec: 1 },
          { id: 'p-stuck-1', cmd: cmd(gc, watch.partialOne.pid, watch.partialOne.hb), when: 'never', timeoutSec: 1 },
        ].concat(PROBE_SIGNALS.map(([s]) => ({ id: 'p-tree-' + s, cmd: withGc(tree, s), when: 'never', timeoutSec: 30 }))),
      }));
      // git дерева пробы - gitStrict: окружение по белому списку (GIT_DIR родителя init не уводит), отказ с подкомандой
      gitStrict(['init', '-q', '--template='], { cwd: dir });
      // дифф дерева пробы для отметки lastGates (E0-12AB, шаг 1) - один b.txt: файлы, которые параллельные
      // случаи пишут в дерево (состояние, шпионы, PID внуков, TEMP), под .gitignore и дифф не двигают
      put(dir, '.gitignore', '*\n!/b.txt\n');
      put(dir, 'b.txt', 'b\n');
      // свои деревья случаев отметки (свой git): гейт p-touch пишет в корень своего дерева, общий дифф не трогает
      const touchRoots = {};
      for (const k of ['touchNone', 'touched', 'touchedContent', 'touchedRed', 'markFail', 'markWriteFail', 'mainFail', 'labelsFail', 'stateLocked', 'nestedDir', 'fullSignal']) {
        touchRoots[k] = path.join(dir, 'root-' + k);
        put(touchRoots[k], '.gitignore', '*\n!/b.txt\n!/during.txt\n!/sub/\n');
        put(touchRoots[k], 'b.txt', 'b\n');
        gitStrict(['init', '-q', '--template='], { cwd: touchRoots[k] });
      }
      // метка-каталог (решение техлида Р6 E0-12AB): вложенный репозиторий в корне дерева, не в repos.json
      put(touchRoots.nestedDir, 'sub/x.txt', 'x\n');
      gitStrict(['init', '-q', '--template='], { cwd: path.join(touchRoots.nestedDir, 'sub') });
      const touchGates = [
        { id: 'p-pass', cmd: cmd(pass), when: 'always', timeoutSec: 30 },
        { id: 'p-touch', cmd: cmd(touchJs), when: 'always', timeoutSec: 30 },
      ];
      // красный прогон с правкой во время него: те же гейты и красный без вывода
      const touchRedGates = touchGates.concat([{ id: 'p-red', cmd: cmd(failSilent), when: 'always', timeoutSec: 30 }]);
      // полный прогон, прерванный сигналом: зелёный гейт, затем гейт с внуком, на старте которого приходит сигнал
      const touchSigGates = [touchGates[0], { id: 'p-sig-hold', cmd: cmd(gc, watch.fullSig.pid, watch.fullSig.hb), when: 'always', timeoutSec: 30 }];
      const preload = put(dir, 'pre.js', [
        "const fs = require('fs');",
        "const cp = require('child_process');",
        'const L = require(' + JSON.stringify(path.join(hooks, 'lib.js')) + ');',
        "const one = process.env.SF_PROBE_CHANGED === 'one';",
        // SF_PROBE_ROOT: репозиторий sf - своё дерево случая отметки; SF_PROBE_RULES=touch - его гейты p-pass, p-touch
        "if (process.env.SF_PROBE_ROOT) L.knownRepos = () => [{ name: 'sf', path: process.env.SF_PROBE_ROOT }];",
        "if (process.env.SF_PROBE_RULES === 'touch') L.rulesFor = () => ({ gates: " + JSON.stringify(touchGates) + ' });',
        "if (process.env.SF_PROBE_RULES === 'touchRed') L.rulesFor = () => ({ gates: " + JSON.stringify(touchRedGates) + ' });',
        "if (process.env.SF_PROBE_RULES === 'touchSig') L.rulesFor = () => ({ gates: " + JSON.stringify(touchSigGates) + ' });',
        "L.allChanged = () => { if (!one) return []; const repo = L.knownRepos()[0]; return [{ repo, rules: L.rulesFor(repo), files: ['b.txt'] }]; };",
        // leak - переменная окружения самопроверки вне белого списка (envByList) дошла до gates.js
        "const spy = { groupKills: 0, taskkills: 0, taskkillArgs: [], snapshots: 0, logWrites: [], logDirReads: 0, logUnlinks: 0, leak: process.env.SF_SELFTEST_LEAK || null };",
        'const spyFile = process.env.SF_PROBE_SPY;',
        "if (spyFile) process.on('exit', () => fs.writeFileSync(spyFile, JSON.stringify(spy)));",
        // снимки диффа (diffSnapshot) - в шпиона; SF_PROBE_MOVED_FAIL - сверка диффа после прогона бросает
        'const H = require(' + JSON.stringify(path.join(hooks, 'diff-hash.js')) + ');',
        'const diffSnapshot = H.diffSnapshot;',
        // SF_PROBE_SNAP_FAIL - снимок до очереди бросает (main() падает после снятия меток), с SF_PROBE_TOUCH=new -
        // создав during.txt в дереве случая: текущий дифф уходит от меток до очереди; SF_PROBE_MARK_FAIL - запись
        // отметки бросает; SF_PROBE_LABELS_FAIL - метки до очереди (H.diffLabels из gates.js) бросают: main() падает
        // до снятия меток (markGates берёт свой diffLabels модуля, не подменённый)
        "H.diffSnapshot = function () { spy.snapshots++; if (process.env.SF_PROBE_SNAP_FAIL === '1') { " + touchNew('process.env.SF_PROBE_ROOT') + " throw new Error('diffSnapshot EIO (проба)'); } return diffSnapshot.apply(H, arguments); };",
        'const diffLabels = H.diffLabels;',
        "H.diffLabels = function () { if (process.env.SF_PROBE_LABELS_FAIL === '1') throw new Error('diffLabels EIO (проба)'); return diffLabels.apply(H, arguments); };",
        'const diffMoved = H.diffMoved;',
        "H.diffMoved = function () { if (process.env.SF_PROBE_MOVED_FAIL === '1') throw new Error('diffMoved EIO (проба)'); return diffMoved.apply(H, arguments); };",
        'const markGates = H.markGates;',
        "H.markGates = function () { if (process.env.SF_PROBE_MARK_FAIL === '1') throw new Error('markGates EIO (проба)'); return markGates.apply(H, arguments); };",
        "const failKill = process.env.SF_PROBE_KILL_FAIL === '1';",
        // SF_PROBE_KILL_NOOP: снятие отвечает успехом, ничего не сняв (taskkill 0, сигнал группе «ушёл»)
        "const noopKill = process.env.SF_PROBE_KILL_NOOP === '1';",
        // SF_PROBE_KILL_STATUS: код taskkill подменён; настоящий taskkill выполняется (кроме SF_PROBE_KILL_NOOP)
        'const killStatus = process.env.SF_PROBE_KILL_STATUS ? Number(process.env.SF_PROBE_KILL_STATUS) : null;',
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
        'cp.spawnSync = function (file, args) {',
        "  if (String(file).toLowerCase().endsWith('taskkill.exe')) {",
        '    spy.taskkills++;',
        '    spy.taskkillArgs.push(args);',
        "    if (failKill) return { pid: 0, status: null, signal: null, error: Object.assign(new Error('taskkill ENOENT (проба)'), { code: 'ENOENT' }) };",
        '    if (noopKill) return { pid: 0, status: killStatus === null ? 0 : killStatus, signal: null };',
        '    if (killStatus !== null) return Object.assign({}, spawnSync.apply(cp, arguments), { status: killStatus });',
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
      // отметка по диффу до очереди (E0-12AB, шаг 1): полный прогон в своём дереве - без правки, новый файл, дописан b.txt
      cliCase('touchNone', [], { SF_PROBE_CHANGED: 'one', SF_PROBE_ROOT: touchRoots.touchNone, SF_PROBE_RULES: 'touch' });
      cliCase('touched', [], { SF_PROBE_CHANGED: 'one', SF_PROBE_ROOT: touchRoots.touched, SF_PROBE_RULES: 'touch', SF_PROBE_TOUCH: 'new' });
      cliCase('touchedContent', [], { SF_PROBE_CHANGED: 'one', SF_PROBE_ROOT: touchRoots.touchedContent, SF_PROBE_RULES: 'touch', SF_PROBE_TOUCH: 'content' });
      cliCase('remnant', ['--only=p-orphan-held'], { SF_PROBE_CHANGED: 'none' });
      cliCase('onlyBothDirty', ['--only=p-both'], { SF_PROBE_CHANGED: 'one' });
      // прежняя зелёная отметка (тот же набор имён), затем красный прогон с правкой b.txt; затем сверка
      // диффа после прогона бросает (ревью E0-12AB): зелёная отметка не должна пережить ни один из них
      cliCase('touchedRed', [], { SF_PROBE_CHANGED: 'one', SF_PROBE_ROOT: touchRoots.touchedRed, SF_PROBE_RULES: 'touchRed', SF_PROBE_TOUCH: 'content' });
      cliCase('markFail', [], { SF_PROBE_CHANGED: 'one', SF_PROBE_ROOT: touchRoots.markFail, SF_PROBE_RULES: 'touch', SF_PROBE_MOVED_FAIL: '1' });
      // сверка бросила, и красную отметку записать не удалось; main() бросил; метка-каталог (ревью E0-12AB, круг 2)
      cliCase('markWriteFail', [], { SF_PROBE_CHANGED: 'one', SF_PROBE_ROOT: touchRoots.markWriteFail, SF_PROBE_RULES: 'touch', SF_PROBE_MOVED_FAIL: '1', SF_PROBE_MARK_FAIL: '1' });
      // mainFail: main() бросил после снятия меток, дифф к тому времени ушёл (during.txt) - отметка по меткам до
      // очереди (redMark), а не по текущему диффу; labelsFail: main() бросил до снятия меток - отметка по текущему
      // диффу, а не отказ записи (решение техлида Р9 E0-12AB, п.1-2)
      cliCase('mainFail', [], { SF_PROBE_CHANGED: 'one', SF_PROBE_ROOT: touchRoots.mainFail, SF_PROBE_RULES: 'touch', SF_PROBE_SNAP_FAIL: '1', SF_PROBE_TOUCH: 'new' });
      cliCase('labelsFail', [], { SF_PROBE_CHANGED: 'one', SF_PROBE_ROOT: touchRoots.labelsFail, SF_PROBE_RULES: 'touch', SF_PROBE_LABELS_FAIL: '1' });
      // зелёный прогон, состояние не записывается (.qa-state только для чтения, каталог - тоже): writeState
      // отдаёт отказ, markGates бросает - код 1 и «прежняя отметка … осталась», а не молча старая зелёная (Р9 п.8)
      cliCase('stateLocked', [], { SF_PROBE_CHANGED: 'one', SF_PROBE_ROOT: touchRoots.stateLocked, SF_PROBE_RULES: 'touch' });
      cliCase('nestedDir', [], { SF_PROBE_CHANGED: 'one', SF_PROBE_ROOT: touchRoots.nestedDir, SF_PROBE_RULES: 'touch' });
      // полный прогон прерван SIGINT при прежней зелёной отметке (ревью E0-12AB, круг 3; решение техлида Р7)
      cliCase('fullSignal', [], { SF_PROBE_CHANGED: 'one', SF_PROBE_ROOT: touchRoots.fullSignal, SF_PROBE_RULES: 'touchSig', SF_PROBE_TOUCH: 'new', SF_PROBE_SIGNAL_ON: watch.fullSig.pid, SF_PROBE_SIGNAL: 'SIGINT' });
      // полный прогон на чистом дереве: гонять нечего - файлы диффа не читаются (ревью E0-12AB, круг 2, C8)
      cliCase('fullClean', [], { SF_PROBE_CHANGED: 'none' });
      for (const k of SEEDED_GREEN) {
        fs.writeFileSync(path.join(state[k], '.qa-state'), JSON.stringify({ lastGates: SEED_GREEN }));
      }
      // недоступный путь состояния stateLocked: файл только для чтения (Windows: rename и запись поверх - EPERM),
      // каталог тоже (POSIX: временный файл не создаётся); права вернёт finally до удаления дерева пробы
      fs.chmodSync(path.join(state.stateLocked, '.qa-state'), 0o444);
      fs.chmodSync(state.stateLocked, 0o555);
      lockedState = state.stateLocked;
      // taskkill /T /F с кодом 255 (E0-12AB, шаг 6): путь снятия Windows, на POSIX случаев нет (строки - с заметкой)
      if (process.platform === 'win32') {
        cliCase('killPartial', ['--only=p-stuck-255'], { SF_PROBE_CHANGED: 'none', SF_PROBE_KILL_STATUS: '255' });
        cliCase('killPartialOpen', ['--only=p-noop-255'], { SF_PROBE_CHANGED: 'none', SF_PROBE_KILL_STATUS: '255', SF_PROBE_KILL_NOOP: '1' });
        // код 1 (не разобран замером) - отказ снятия, хоть дерево и снято (решение техлида Р5 E0-12AB)
        cliCase('killStatusOne', ['--only=p-stuck-1'], { SF_PROBE_CHANGED: 'none', SF_PROBE_KILL_STATUS: '1' });
      }
      for (const k of CLI_STAGE_TWO) if (cli[k]) cli[k].stage = 2;
      // дифф дерева пробы до запуска - копией diff-hash.js дерева: с ним сверяется отметка случая full
      const beforeState = tempDir('state-before', dir);
      const before = run(process.execPath, ['-e', 'const H = require(' + JSON.stringify(path.join(hooks, 'diff-hash.js')) + '); const l = H.diffLabels(); process.stdout.write(JSON.stringify({ hash: H.diffHash(l), labels: l }));'], {
        cwd: dir,
        env: Object.assign({}, process.env, { SF_HOOK_STATE_DIR: beforeState }),
      });
      if (before.status !== 0) throw new Error('дифф дерева пробы до запуска: код ' + before.status + ' ' + String(before.stderr || '').slice(0, 160));
      const treeBefore = JSON.parse(String(before.stdout));
      const cfg = { gatesFile: path.join(HOOKS, 'gates.js'), cliGates: path.join(hooks, 'gates.js'), preload, dir, gates, cli, watch, watchMs: 1500, gcLifeMs: GC_LIFE_MS, liveState: LIVE_STATE };
      // настройки ребёнка - файлом, а не текстом -e: командная строка Windows - до 32 767 символов, и случаи
      // круга 2 E0-12AB её переросли (spawnSync ENAMETOOLONG)
      const cfgFile = put(dir, 'gate-runner.json', JSON.stringify(cfg));
      const code = 'require(' + JSON.stringify(path.join(HOOKS, 'selftest-gate-runner.js')) + ').gateRunner(JSON.parse(require("fs").readFileSync(' + JSON.stringify(cfgFile) + ', "utf8")));';
      // SF_SELFTEST_LEAK - метка окружения ребёнка вне белого списка: до gates.js она доходить не должна
      const r = run(process.execPath, ['-e', code], { cwd: dir, timeout: 120000, killSignal: 'SIGKILL', env: Object.assign({}, process.env, { SF_SELFTEST_LEAK: 'leak' }) });
      const m = /(?:^|\n)probe (\{.*\})$/.exec(String(r.stdout || ''));
      if (!m) throw new Error('проба запуска гейтов не дошла до итога (код ' + r.status + '): ' + String(r.stderr || r.stdout || (r.error && r.error.message)).slice(0, 200));
      const res = JSON.parse(m[1]);
      res.markerWritten = fs.existsSync(marker);
      res.sleepStarted = fs.existsSync(sleepStarted) ? Number(fs.readFileSync(sleepStarted, 'utf8')) : null;
      res.cliMarkerWritten = fs.existsSync(cliMarker);
      res.lastGates = {};
      res.marks = {};
      res.treeBefore = treeBefore;
      res.spy = {};
      for (const k of Object.keys(state)) {
        const g = lastGatesIn(state[k]);
        res.lastGates[k] = g ? g.code : null;
        res.marks[k] = g;
        res.spy[k] = fs.existsSync(spies[k]) ? JSON.parse(fs.readFileSync(spies[k], 'utf8')) : null;
      }
      res.grace = grace;
      // правка «новый файл» в деревьях случаев отметки: была ли она (дифф ушёл от меток до очереди)
      res.during = {};
      for (const k of Object.keys(touchRoots)) res.during[k] = fs.existsSync(path.join(touchRoots[k], 'during.txt'));
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
      try {
        if (lockedState !== null) {
          fs.chmodSync(lockedState, 0o755);
          fs.chmodSync(path.join(lockedState, '.qa-state'), 0o644);
        }
      } finally {
        // папку держит не снятый процесс - его отказ назван строкой пробы; каталог остаётся в
        // реестре: его снимет выход процесса, а не снятый назовёт проба «каталоги прогона»
        releaseTemp(dir);
      }
    }
  }
  /** Случай пробы runGate словами для строки отказа. */
  function runGateSeen(x) {
    if (x.hung) return 'runGate не вернулся за ' + (x.ms / 1000).toFixed(1) + ' с';
    return 'код ' + x.code + ', ' + (x.ms / 1000).toFixed(1) + ' с, вывод ' + JSON.stringify(String(x.tail).slice(-200));
  }
  /**
   * Причина отказа на alive: null (watchAlive) словами: пульс не сдвинулся, а второе чтение - не раньше срока
   * жизни внука, или отметки старта нет при PID (срок проверить не по чему) - решение техлида Р9 E0-12AB, п.3.
   */
  function aliveNullWhy(w) {
    if (!Number.isFinite(w.startedAt)) return 'пульс внука не сдвинулся, а отметки его старта нет (PID ' + w.pid + ') - срок жизни проверить не по чему, «снят» ничего не доказывает';
    return 'пульс внука прочитан позже срока его жизни (gc.js выходит сам) - «снят» ничего не доказывает';
  }
  /** Запуск gates.js из командной строки словами для строки отказа. */
  function cliSeen(x) {
    if (x.hung) return 'gates.js не вышел за ' + (x.ms / 1000).toFixed(1) + ' с';
    return 'код ' + x.code + (x.signal ? ' (' + x.signal + ')' : '') + ', stdout …' + JSON.stringify(x.out.slice(-300)) + (x.err ? ', stderr ' + JSON.stringify(x.err.slice(-200)) : '');
  }
  /**
   * Окно «вернулся за предел + запас» пробы снятия по пределу (T8, TECH_DEBT 21.10.2026 E0-12M круг 3):
   * от отметки старта ребёнка (startedAt), а не от вызова runGate - медленный старт на занятой машине не
   * красит. Ребёнок, снятый до своей отметки (старт node дольше предела), - окно от вызова (x.ms): такой
   * исход законен (команда снята по пределу), а не отказ «окно не от чего считать» (замечание ревью
   * E0-12AA). Тот же счёт - у окна вывода внука пробы orphan (отметка - <pid>.started внука, gcStartedAt). { why } - отказ,
   * { note } - пропуск; x - случай runGate (ms, end), boundMs - предел и запас, who - чей старт.
   */
  function limitWindowVerdict(x, startedAt, boundMs, who) {
    const marked = Number.isFinite(startedAt) && startedAt > 0;
    const windowMs = marked ? x.end - startedAt : x.ms;
    const from = marked ? 'после старта ' + who : 'от вызова (' + who + ' без отметки старта)';
    if (windowMs >= boundMs) return { why: 'вернулся через ' + (windowMs / 1000).toFixed(1) + ' с ' + from + ' - дольше окна и запаса' };
    return { note: (windowMs / 1000).toFixed(1) + ' с ' + from + ', ' + (x.ms / 1000).toFixed(1) + ' с от вызова' };
  }
  check('gates.js runGate: команда дольше timeoutSec снята по пределу (код не 0, «снят по пределу», вернулся за предел + запас)', () => {
    const all = gateRunCases();
    const x = all.gates.sleep;
    if (x.hung || x.code === 0 || !/снят по пределу 1 с/.test(x.tail)) return runGateSeen(x);
    const v = limitWindowVerdict(x, all.sleepStarted, 1000 + all.grace + 8000, 'ребёнка');
    return v.why ? v.why + '; ' + runGateSeen(x) : { note: v.note };
  });
  // Окно предела без отметки старта (замечание ревью E0-12AA): ребёнок снят до отметки - окно от вызова,
  // не отказ; с отметкой - от неё; дольше предела и запаса от того, от чего считается, - отказ
  check('gates.js runGate: окно предела - от отметки старта ребёнка; без отметки (снят до неё) - от вызова, не отказ; дольше предела и запаса - отказ', () => {
    const bound = 11000;
    const got = [
      limitWindowVerdict({ ms: 3000, end: 10000 }, null, bound, 'ребёнка'),
      limitWindowVerdict({ ms: 30000, end: 40000 }, 37000, bound, 'ребёнка'),
      limitWindowVerdict({ ms: 3000, end: 40000 }, 20000, bound, 'ребёнка'),
      limitWindowVerdict({ ms: 30000, end: 40000 }, null, bound, 'ребёнка'),
    ].map((v) => (v.why ? 'отказ' : 'пропуск'));
    return got.join() === 'пропуск,пропуск,отказ,отказ' || 'без отметки в окне, с отметкой в окне, с отметкой за окном, без отметки за окном: ' + got.join(', ');
  });
  // Отметка старта внука - текст часов ОС внука, а не mtime файла PID (замечание ревью E0-12AA: часы ФС
  // с шагом 2 с на exFAT против Date.now()); дочерний node берёт gcStartedAt с его чтением по умолчанию
  // (readIfPresent), как тело проб запуска: нет файла - null, иной сбой (каталог на месте отметки - EISDIR) -
  // исключение, а не «внук не жив» (решение техлида Р9 E0-12AA)
  check('gates.js runGate: отметка старта внука - часы ОС текстом из <pid>.started, а не mtime файла PID (mtime сдвинут - ответ тот же; нет отметки, не число - null; отметка не читается - исключение)', () => {
    const dir = tempDir('gc-started');
    try {
      const pidFile = put(dir, 'gc.pid', '4242');
      const marked = put(dir, 'gc-marked.pid', '4243');
      put(dir, 'gc-marked.pid' + STARTED_SUFFIX, '1700000000123');
      const junk = put(dir, 'gc-junk.pid', '4244');
      put(dir, 'gc-junk.pid' + STARTED_SUFFIX, 'not a number');
      const unreadable = put(dir, 'gc-dir.pid', '4245');
      fs.mkdirSync(unreadable + STARTED_SUFFIX);
      // mtime файла PID - на сутки раньше отметки: ответ по mtime отличим от ответа по тексту
      fs.utimesSync(marked, new Date(1699900000000), new Date(1699900000000));
      const code = 'const { gcStartedAt } = require(' + JSON.stringify(path.join(HOOKS, 'selftest-gate-runner.js')) + ');\n' +
        'const at = (f) => { try { return gcStartedAt(f); } catch (e) { return (e && e.code) || String(e); } };\n' +
        'process.stdout.write(JSON.stringify(' + JSON.stringify([pidFile, marked, junk, unreadable]) + '.map(at)));';
      const r = run(process.execPath, ['-e', code], { cwd: dir });
      const got = String(r.stdout || '');
      const want = '[null,1700000000123,null,"EISDIR"]';
      return got === want || 'нет отметки, отметка, не число, не читается: ' + got + ' (код ' + r.status + ' ' + String(r.stderr || '').slice(0, 120) + '), ожидалось ' + want;
    } finally {
      releaseTemp(dir);
    }
  });
  check('gates.js runGate: снято всё дерево - внук, держащий вывод, мёртв после возврата', () => {
    const all = gateRunCases();
    const x = all.gates.tree;
    const w = all.watch.tree;
    if (x.hung || x.code === 0 || !/снят по пределу/.test(x.tail)) return runGateSeen(x);
    if (!w.started) return 'внук не стартовал до предела (нет файла PID) - проба ничего не доказывает; ' + runGateSeen(x);
    if (w.alive === null) return aliveNullWhy(w) + '; ' + runGateSeen(x);
    if (w.alive) return 'внук ' + w.pid + ' жив после возврата runGate - снята только оболочка, не дерево; ' + runGateSeen(x);
    return { note: 'внук ' + w.pid + ' снят, ' + (x.ms / 1000).toFixed(1) + ' с' };
  });
  // Оболочка вышла с 0, а остаток жил: код 0 только при закрывшемся самом выводе без снятия (D2/D3),
  // поэтому здесь код 1 на обеих системах, код оболочки - в тексте
  check('gates.js runGate: оболочка вышла с 0, внук держит вывод - код 1, без «снят по пределу», остаток назван (POSIX - снят)', () => {
    const all = gateRunCases();
    const x = all.gates.orphan;
    const w = all.watch.orphan;
    if (x.hung || x.code !== 1 || /снят по пределу/.test(x.tail)) return runGateSeen(x);
    if (!w.started) return 'внук не стартовал до выхода оболочки (нет файла PID) - проба ничего не доказывает; ' + runGateSeen(x);
    if (w.alive === null) return aliveNullWhy(w) + '; ' + runGateSeen(x);
    // окно - от старта внука (отметка <pid>.started, gcStartedAt), а не от spawn оболочки (T8)
    const v = limitWindowVerdict(x, w.startedAt, all.grace + 8000, 'внука');
    if (v.why) return v.why + '; ' + runGateSeen(x);
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
  // Окружение gates.js из командной строки - по белому списку (envByList, как у git проб; замечание ревью
  // E0-12AA L-030): метка окружения ребёнка проб вне списка до gates.js не доходит, переменные случая - доходят
  check('gates.js из командной строки: окружение по белому списку - переменная родителя вне списка до gates.js не доходит, переменные случая доходят', () => {
    const all = gateRunCases();
    const spy = all.spy.onlyClean;
    if (!spy) return 'шпион случая onlyClean не записан - SF_PROBE_SPY случая не дошёл до gates.js; ' + cliSeen(all.cli.onlyClean);
    return spy.leak === null || 'переменная родителя вне белого списка дошла до gates.js: SF_SELFTEST_LEAK=' + spy.leak;
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
  // Отметка по диффу до очереди (E0-12AB, шаг 1; строка TECH_DEBT 21.10.2026 E1): hash и files lastGates -
  // дифф, снятый до запуска, а не в конце прогона
  check('gates.js из командной строки: полный прогон ставит отметку по диффу, снятому до запуска (hash и files lastGates - дифф дерева пробы до запуска)', () => {
    const all = gateRunCases();
    const g = all.marks.full;
    const b = all.treeBefore;
    const why = [];
    if (!b.labels.length) why.push('дифф дерева пробы до запуска пуст - проба ничего не доказывает');
    if (!g) why.push('отметки нет; ' + cliSeen(all.cli.full));
    else {
      if (g.hash !== b.hash) why.push('hash отметки ' + String(g.hash).slice(0, 8) + ', а дифф до запуска ' + b.hash.slice(0, 8));
      if (JSON.stringify(g.files) !== JSON.stringify(b.labels)) why.push('files отметки ' + JSON.stringify(g.files) + ', а дифф до запуска ' + JSON.stringify(b.labels));
    }
    if (/Дифф изменился во время прогона/.test(all.cli.full.out)) why.push('без правки во время прогона напечатано «Дифф изменился»');
    return why.length ? why.join('; ') : { note: b.labels.join(', ') };
  });
  // Этап 2 ребёнка проб (решение техлида Р4 E0-12AB): запуски E0-12AB стартуют после возврата всех случаев
  // runGate и запусков этапа 1 - их нагрузка не ложится на окна проб runGate (окно orphan под нагрузкой)
  check('gates.js из командной строки: запуски этапа 2 (случаи E0-12AB) стартуют после возврата всех случаев runGate и запусков этапа 1', () => {
    const all = gateRunCases();
    const why = [];
    const two = CLI_STAGE_TWO.filter((k) => all.cli[k]);
    const one = Object.keys(all.cli).filter((k) => !CLI_STAGE_TWO.includes(k));
    if (!two.length) return 'запусков этапа 2 нет - проба ничего не доказывает';
    for (const k of two) if (all.cli[k].stage !== 2) why.push(k + ': этап ' + all.cli[k].stage + ', ждали 2');
    const noTime = Object.keys(all.gates).map((k) => ['runGate ' + k, all.gates[k].end]).concat(two.concat(one).map((k) => [k, all.cli[k].start]), one.map((k) => [k, all.cli[k].end])).filter((p) => !Number.isFinite(p[1]));
    if (noTime.length) why.push('без отметки времени: ' + noTime.map((p) => p[0]).join(', '));
    if (why.length) return why.join('; ');
    const firstTwo = Math.min(...two.map((k) => all.cli[k].start));
    const lastGate = Math.max(...Object.keys(all.gates).map((k) => all.gates[k].end));
    const lastOne = Math.max(...one.map((k) => all.cli[k].end));
    if (firstTwo < lastGate) why.push('этап 2 стартовал за ' + (lastGate - firstTwo) + ' мс до возврата последнего случая runGate');
    if (firstTwo < lastOne) why.push('этап 2 стартовал за ' + (lastOne - firstTwo) + ' мс до возврата последнего запуска этапа 1');
    return why.length ? why.join('; ') : { note: two.length + ' запусков этапа 2, старт через ' + (firstTwo - Math.max(lastGate, lastOne)) + ' мс после этапа 1' };
  });
  // Пульс внуков читается после своего этапа (ревью E0-12AB, круг 3; решение техлида Р7): внук gc.js выходит сам
  // через GC_LIFE_MS, и пульс внука этапа 1, прочитанный после этапа 2, доказывал бы срок жизни, а не снятие
  check('gates.js из командной строки: пульс внуков этапа 1 прочитан до старта первого запуска этапа 2, внуков этапа 2 - после возврата последнего', () => {
    const all = gateRunCases();
    const why = [];
    const two = CLI_STAGE_TWO.filter((k) => all.cli[k]);
    const keys = Object.keys(all.watch);
    const ones = keys.filter((k) => !WATCH_STAGE_TWO.includes(k));
    const twos = keys.filter((k) => WATCH_STAGE_TWO.includes(k));
    if (!two.length || !ones.length || !twos.length) return 'нет запусков этапа 2 или внуков одного из этапов - проба ничего не доказывает';
    const noTime = keys.filter((k) => !Number.isFinite(all.watch[k].readAt));
    if (noTime.length) return 'пульс без отметки времени readAt: ' + noTime.join(', ');
    for (const k of keys) {
      const want = WATCH_STAGE_TWO.includes(k) ? 2 : 1;
      if (all.watch[k].stage !== want) why.push(k + ': пульс этапа ' + all.watch[k].stage + ', ждали ' + want);
    }
    const firstTwo = Math.min(...two.map((k) => all.cli[k].start));
    const lastTwo = Math.max(...two.map((k) => all.cli[k].end));
    const lateOne = ones.filter((k) => all.watch[k].readAt >= firstTwo);
    if (lateOne.length) why.push('пульс этапа 1 прочитан после старта этапа 2: ' + lateOne.map((k) => k + ' (+' + (all.watch[k].readAt - firstTwo) + ' мс)').join(', '));
    const earlyTwo = twos.filter((k) => all.watch[k].readAt < lastTwo);
    if (earlyTwo.length) why.push('пульс этапа 2 прочитан до возврата этапа 2: ' + earlyTwo.join(', '));
    return why.length ? why.join('; ') : true;
  });
  // Страж срока жизни внука (решения техлида Р7, Р8 E0-12AB): сдвинувшийся пульс - жив всегда; несдвинувшийся,
  // прочитанный не раньше GC_LIFE_MS от старта внука или при PID без отметки старта, - null («ничего не доказывает»)
  check('selftest-gate-runner.js watchAlive: пульс сдвинулся - жив при любом сроке; не сдвинулся - null не раньше срока жизни внука и при PID без отметки старта, false до срока и без PID; срок не задан - исключение', () => {
    const code = 'const { watchAlive } = require(' + JSON.stringify(path.join(HOOKS, 'selftest-gate-runner.js')) + ');\n' +
      'const at = (f) => { try { return f(); } catch (e) { return "throw"; } };\n' +
      'process.stdout.write(JSON.stringify([' +
      'at(() => watchAlive({ moved: false, readAt: 1000 + ' + GC_LIFE_MS + ', startedAt: 1000, lifeMs: ' + GC_LIFE_MS + ', pid: 123 })),' +
      'at(() => watchAlive({ moved: true, readAt: 1000 + ' + GC_LIFE_MS + ' + 5, startedAt: 1000, lifeMs: ' + GC_LIFE_MS + ', pid: 123 })),' +
      'at(() => watchAlive({ moved: false, readAt: 1000 + ' + GC_LIFE_MS + ' - 1, startedAt: 1000, lifeMs: ' + GC_LIFE_MS + ', pid: 123 })),' +
      'at(() => watchAlive({ moved: true, readAt: 5000, startedAt: 1000, lifeMs: ' + GC_LIFE_MS + ', pid: 123 })),' +
      'at(() => watchAlive({ moved: false, readAt: 5000, startedAt: null, lifeMs: ' + GC_LIFE_MS + ', pid: 123 })),' +
      'at(() => watchAlive({ moved: true, readAt: 5000, startedAt: null, lifeMs: ' + GC_LIFE_MS + ', pid: 123 })),' +
      'at(() => watchAlive({ moved: false, readAt: 5000, startedAt: null, lifeMs: ' + GC_LIFE_MS + ', pid: null })),' +
      'at(() => watchAlive({ moved: false, readAt: 5000, startedAt: 1000, lifeMs: undefined, pid: 123 }))' +
      ']));';
    const r = run(process.execPath, ['-e', code], { cwd: ROOT });
    const got = String(r.stdout || '');
    const want = '[null,true,false,true,null,true,false,"throw"]';
    return got === want || 'на сроке (не жив), после срока (жив), до срока (не жив, жив), без отметки старта при PID (не жив, жив), без PID, без срока: ' + got + ' (код ' + r.status + ' ' + String(r.stderr || '').slice(0, 120) + '), ожидалось ' + want;
  });
  // Две причины alive: null - два текста отказа (решение техлида Р9 E0-12AB, п.3): строка пробы называет ту, что была
  check('selftest-gates-run.js aliveNullWhy: alive: null по сроку жизни внука - «прочитан позже срока его жизни», при PID без отметки старта - «отметки его старта нет», тексты различны', () => {
    const late = aliveNullWhy({ pid: 123, startedAt: 1000, alive: null });
    const unmarked = aliveNullWhy({ pid: 123, startedAt: null, alive: null });
    const why = [];
    if (!/прочитан позже срока его жизни/.test(late)) why.push('срок: ' + JSON.stringify(late));
    if (!/отметки его старта нет \(PID 123\)/.test(unmarked) || /позже срока/.test(unmarked)) why.push('нет отметки старта: ' + JSON.stringify(unmarked));
    return why.length ? why.join('; ') : true;
  });
  // Ожидание смены показания часов с пределом (решения техлида Р8, Р9 E0-12AB): предел - в мс по монотонным часам
  // (не числом пауз), показание проверяется и после последней паузы, сдвиг назад - смена, а не «часы стоят»
  check('selftest-gate-runner.js nextMs: часы стоят - исключение «часы ОС не идут» через NEXT_MS_LIMIT мс монотонных часов при любой длине паузы; часы сменились на последней паузе, вперёд или назад - новое показание', () => {
    const code = 'const { NEXT_MS_LIMIT, nextMs } = require(' + JSON.stringify(path.join(HOOKS, 'selftest-gate-runner.js')) + ');\n' +
      '(async () => {\n' +
      '  const out = { limit: NEXT_MS_LIMIT };\n' +
      // подменённые часы: pause(1) считает паузы и двигает монотонные часы mono на step мс
      '  let pauses = 0;\n' +
      '  let m = 0;\n' +
      '  let step = 1;\n' +
      '  const mono = () => m;\n' +
      '  const pause = async (ms) => { pauses++; m += step; if (ms !== 1) throw new Error("пауза " + ms); };\n' +
      '  const probe = async (k, now, s) => {\n' +
      '    pauses = 0; m = 0; step = s;\n' +
      '    try { out[k] = await nextMs({ now, pause, mono }); } catch (e) { out[k] = "throw: " + e.message; }\n' +
      '    out[k + "Pauses"] = pauses;\n' +
      '  };\n' +
      '  await probe("stuck", () => 5000, 1);\n' +
      '  await probe("slow", () => 5000, 15);\n' +
      '  await probe("lastPause", () => (pauses >= NEXT_MS_LIMIT ? 5001 : 5000), 1);\n' +
      '  const ahead = [7000, 7000, 7000, 7001];\n' +
      '  await probe("moving", () => (ahead.length > 1 ? ahead.shift() : ahead[0]), 1);\n' +
      '  const back = [7000, 5500];\n' +
      '  await probe("back", () => (back.length > 1 ? back.shift() : back[0]), 1);\n' +
      '  process.stdout.write(JSON.stringify(out));\n' +
      '})();';
    // предел ребёнка: nextMs без предела на стоящих часах не возвращается - строка красная по пределу, а не зависшая самопроверка
    const r = run(process.execPath, ['-e', code], { cwd: ROOT, timeout: 15000 });
    let got = null;
    try { got = JSON.parse(String(r.stdout || '')); } catch (e) { got = null; }
    if (!got) return 'нет итога (код ' + r.status + (r.error ? ', ' + (r.error.code || r.error.message) : '') + ' ' + String(r.stderr || '').slice(0, 200) + ')';
    const why = [];
    if (!Number.isInteger(got.limit) || got.limit < 500 || got.limit > 2000) why.push('NEXT_MS_LIMIT ' + got.limit + ', ждали ~1000');
    const stuckWhy = (k, pauses, what) => {
      if (typeof got[k] !== 'string' || !/^throw: .*часы ОС не идут/.test(got[k])) why.push(what + ': ' + JSON.stringify(got[k]) + ', ждали исключение «часы ОС не идут»');
      else if (got[k + 'Pauses'] !== pauses) why.push(what + ': пауз ' + got[k + 'Pauses'] + ', ждали ' + pauses + ' (предел ' + got.limit + ' мс)');
    };
    stuckWhy('stuck', got.limit, 'стоящие часы, пауза 1 мс');
    stuckWhy('slow', Math.ceil(got.limit / 15), 'стоящие часы, пауза 15 мс');
    if (got.lastPause !== 5001 || got.lastPausePauses !== got.limit) why.push('часы сменились на последней паузе: ' + JSON.stringify(got.lastPause) + ' после ' + got.lastPausePauses + ' пауз, ждали 5001 после ' + got.limit);
    if (got.moving !== 7001 || got.movingPauses !== 3) why.push('идущие часы: ' + JSON.stringify(got.moving) + ' после ' + got.movingPauses + ' пауз, ждали 7001 после 3');
    if (got.back !== 5500 || got.backPauses !== 1) why.push('часы назад на 1,5 с: ' + JSON.stringify(got.back) + ' после ' + got.backPauses + ' пауз, ждали 5500 после 1');
    return why.length ? why.join('; ') : true;
  });
  /**
   * Зелёный прогон при прежней зелёной отметке, файл диффа тронут во время прогона (решение техлида Р6 E0-12AB):
   * отметка с кодом 1 по диффу до запуска вместо прежней, замок коммита (gatesProblem) её не пускает, код 1,
   * строка называет файл; extra - причина «Не прочитано» в той же строке. Контроль - дерево без правки.
   */
  function touchedVerdict(all, k, file, extra) {
    const x = all.cli[k];
    const g = all.marks[k];
    const ctl = all.cli.touchNone;
    const H = require('./diff-hash.js');
    const why = [];
    if (ctl.hung || ctl.code !== 0 || all.lastGates.touchNone !== 0 || /Дифф изменился/.test(ctl.out)) {
      why.push('контроль (то же дерево без правки) не дал отметку с кодом 0: lastGates ' + all.lastGates.touchNone + '; ' + cliSeen(ctl));
    }
    if (x.hung || x.code !== 1) why.push('код прогона не 1: ' + cliSeen(x));
    if (!/--- sf \/ p-touch: ok/.test(x.out) || !/Все гейты прошли/.test(x.out)) why.push('гейты прогона не зелёные - проба ничего не доказывает');
    if (!g || g.code !== 1 || g.hash === SEED_GREEN.hash) why.push('отметка ' + JSON.stringify(g) + ', ждали код 1 вместо прежней зелёной');
    else {
      if (g.hash !== H.diffHash(g.files) || g.files.indexOf('sf/b.txt') === -1) why.push('отметка не по диффу до запуска: ' + JSON.stringify(g));
      const p = H.gatesProblem({ lastGates: g }, g.hash, g.files);
      if (!p || !/упал, код возврата 1/.test(p)) why.push('замок коммита (gatesProblem) по отметке: ' + JSON.stringify(p) + ', ждали отказ «упал, код возврата 1»');
    }
    const line = 'Дифф изменился во время прогона \\(sf/' + file + '\\): записана отметка «не зелено» \\(код 1\\): гейты прошли, но изменившиеся файлы не проверены, прогони gates\\.js заново в фоне' + (extra || '\\.');
    if (!new RegExp(line).test(x.out)) why.push('нет строки «Дифф изменился во время прогона (sf/' + file + '): записана отметка «не зелено» (код 1) …»: …' + JSON.stringify(x.out.slice(-300)));
    return why.length ? why.join('; ') : true;
  }
  check('gates.js из командной строки: прежняя зелёная отметка, гейт создал файл во время зелёного полного прогона - отметка с кодом 1, замок коммита её не пускает, «Дифф изменился во время прогона» с именем файла, код 1', () => touchedVerdict(gateRunCases(), 'touched', 'during\\.txt'));
  // Остаток дыры строки E1 (решение техлида Р1 E0-12AB): набор файлов тот же, содержимое другое
  check('gates.js из командной строки: прежняя зелёная отметка, гейт дописал уже изменённый файл во время зелёного полного прогона (набор файлов тот же) - отметка с кодом 1, замок коммита её не пускает, «Дифф изменился» с именем файла, код 1', () => touchedVerdict(gateRunCases(), 'touchedContent', 'b\\.txt'));
  // Метка-каталог (решение техлида Р6 E0-12AB): отпечатка у каталога нет - fail-closed, причина в строке вывода
  // Совет причины снимает метку (ревью E0-12AB, круг 3; решение техлида Р7): запись в repos.json её не снимает
  check('gates.js из командной строки: метка-каталог (вложенный репозиторий) - отметка с кодом 1, код 1, причина «метка-каталог … внеси каталог в .gitignore внешнего репозитория или убери …» в строке «Дифф изменился»', () => touchedVerdict(gateRunCases(), 'nestedDir', 'sub/', '\\. Не прочитано: метка-каталог sf/sub/: вложенный репозиторий: внеси каталог в \\.gitignore внешнего репозитория или убери \\(отдельный репозиторий - ещё и в repos\\.json\\)\\.'));
  // Красный прогон при изменившемся диффе (ревью E0-12AB, D6): прежняя зелёная отметка с тем же набором имён
  // пустила бы коммит после красного прогона - красный прогон пишется и тогда
  check('gates.js из командной строки: прежняя зелёная отметка, затем красный прогон с правкой файла во время него - записана красная отметка, «Дифф изменился» с именем файла, код 1', () => {
    const all = gateRunCases();
    const x = all.cli.touchedRed;
    const g = all.marks.touchedRed;
    const why = [];
    if (x.hung || x.code !== 1) why.push(cliSeen(x));
    if (!/--- sf \/ p-red: ПАДАЕТ, код 3/.test(x.out)) why.push('красный гейт p-red не прогнан');
    if (!g || g.code !== 1 || g.hash === SEED_GREEN.hash) why.push('отметка ' + JSON.stringify(g) + ', ждали красную (код 1) вместо прежней зелёной');
    if (!/Дифф изменился во время прогона \(sf\/b\.txt\): записана отметка о красном прогоне \(код 1\), прогони gates\.js заново в фоне/.test(x.out)) {
      why.push('нет строки «Дифф изменился … записана отметка о красном прогоне»: …' + JSON.stringify(x.out.slice(-200)));
    }
    return why.length ? why.join('; ') : true;
  });
  // Сбой сверки диффа после прогона (ревью E0-12AB, L-004): молчать нельзя - прежняя зелёная отметка пустила бы коммит
  check('gates.js из командной строки: сверка диффа после прогона бросила - код 1, причина в stderr, прежняя зелёная отметка заменена красной', () => {
    const all = gateRunCases();
    const x = all.cli.markFail;
    const g = all.marks.markFail;
    const why = [];
    if (x.hung || x.code !== 1) why.push(cliSeen(x));
    if (!/Все гейты прошли/.test(x.out)) why.push('гейты прогона не зелёные - проба ничего не доказывает');
    if (!/Сверка диффа или отметка о прогоне упала \(diffMoved EIO \(проба\)\): записана отметка о красном прогоне \(код 1\), код прогона 1/.test(x.err)) why.push('причина не названа в stderr: ' + JSON.stringify(x.err.slice(-200)));
    if (!g || g.code !== 1 || g.hash === SEED_GREEN.hash) why.push('отметка ' + JSON.stringify(g) + ', ждали красную (код 1) вместо прежней зелёной');
    return why.length ? why.join('; ') : true;
  });
  // Запись красной отметки упала (ревью E0-12AB, круг 2, T7): прежняя отметка осталась - так и сказано, код 1
  check('gates.js из командной строки: сверка диффа бросила и красную отметку записать не удалось - код 1, в stderr обе причины и «прежняя отметка … осталась - не коммить»', () => {
    const all = gateRunCases();
    const x = all.cli.markWriteFail;
    const g = all.marks.markWriteFail;
    const why = [];
    if (x.hung || x.code !== 1) why.push(cliSeen(x));
    if (!/Все гейты прошли/.test(x.out)) why.push('гейты прогона не зелёные - проба ничего не доказывает');
    if (!/Сверка диффа или отметка о прогоне упала \(diffMoved EIO \(проба\)\): красную отметку записать не удалось \(markGates EIO \(проба\)\), прежняя отметка в \.qa-state осталась - не коммить до полного прогона с отметкой, код прогона 1/.test(x.err)) why.push('обе причины и «не коммить» не названы в stderr: ' + JSON.stringify(x.err.slice(-300)));
    if (!g || g.hash !== SEED_GREEN.hash) why.push('отметка ' + JSON.stringify(g) + ', а запись падала - ждали прежнюю');
    return why.length ? why.join('; ') : true;
  });
  // main() бросил в полном прогоне (ревью E0-12AB, круг 2, L-004/T7/D6): прежняя зелёная отметка не переживает сломавшийся прогон
  // Отметка catch main() - по меткам до очереди (redMark), когда они сняты, а дифф с тех пор ушёл (решение техлида Р9 E0-12AB, п.1)
  check('gates.js из командной строки: main() полного прогона бросил после снятия меток, дифф ушёл - код 1, «gates.js сломался» и запись красной отметки в stderr, прежняя зелёная отметка заменена красной по меткам до очереди', () => {
    const all = gateRunCases();
    const x = all.cli.mainFail;
    const g = all.marks.mainFail;
    const H = require('./diff-hash.js');
    const why = [];
    if (x.hung || x.code !== 1) why.push(cliSeen(x));
    if (!all.during.mainFail) why.push('during.txt не создан - дифф не ушёл от меток, проба ничего не доказывает');
    if (!/gates\.js сломался: [^\n]*diffSnapshot EIO \(проба\)/.test(x.err)) why.push('причина не названа в stderr: ' + JSON.stringify(x.err.slice(-300)));
    if (!/записана отметка о красном прогоне \(код 1\), код прогона 1/.test(x.err)) why.push('запись красной отметки не названа в stderr');
    if (!g || g.code !== 1 || g.hash === SEED_GREEN.hash) why.push('отметка ' + JSON.stringify(g) + ', ждали красную (код 1) вместо прежней зелёной');
    else if (g.hash !== H.diffHash(g.files) || JSON.stringify(g.files) !== JSON.stringify(['sf/b.txt'])) why.push('отметка не по меткам до очереди: ' + JSON.stringify(g));
    return why.length ? why.join('; ') : true;
  });
  // main() бросил до снятия меток (fullLabels null): отметка по текущему диффу, а не отказ записи (Р9 п.2)
  check('gates.js из командной строки: main() полного прогона бросил до снятия меток - код 1, «gates.js сломался» и запись красной отметки в stderr, отметка - код 1 по текущему диффу', () => {
    const all = gateRunCases();
    const x = all.cli.labelsFail;
    const g = all.marks.labelsFail;
    const H = require('./diff-hash.js');
    const why = [];
    if (x.hung || x.code !== 1) why.push(cliSeen(x));
    if (!/gates\.js сломался: [^\n]*diffLabels EIO \(проба\)/.test(x.err)) why.push('причина не названа в stderr: ' + JSON.stringify(x.err.slice(-300)));
    if (!/записана отметка о красном прогоне \(код 1\), код прогона 1/.test(x.err)) why.push('запись красной отметки не названа в stderr: ' + JSON.stringify(x.err.slice(-300)));
    if (!g || g.code !== 1 || g.hash === SEED_GREEN.hash) why.push('отметка ' + JSON.stringify(g) + ', ждали красную (код 1) вместо прежней зелёной');
    else if (g.hash !== H.diffHash(g.files) || JSON.stringify(g.files) !== JSON.stringify(['sf/b.txt'])) why.push('отметка не по текущему диффу: ' + JSON.stringify(g));
    return why.length ? why.join('; ') : true;
  });
  // Состояние не записывается (решение техлида Р9 E0-12AB, п.8): writeState отдаёт отказ, markGates бросает - зелёный
  // прогон не может молча оставить прежнюю зелёную отметку и выйти с 0
  check('gates.js из командной строки: путь состояния закрыт на запись, гейты зелёные - код 1, в stderr «красную отметку записать не удалось … прежняя отметка в .qa-state осталась - не коммить»', () => {
    const all = gateRunCases();
    const x = all.cli.stateLocked;
    const g = all.marks.stateLocked;
    const why = [];
    if (x.hung || x.code !== 1) why.push(cliSeen(x));
    if (!/Все гейты прошли/.test(x.out)) why.push('гейты прогона не зелёные - проба ничего не доказывает');
    if (!g || g.hash !== SEED_GREEN.hash) why.push('отметка ' + JSON.stringify(g) + ' записана - путь состояния не закрыт, проба ничего не доказывает');
    if (!/Сверка диффа или отметка о прогоне упала \(запись \.qa-state не удалась: [^\n]*\): красную отметку записать не удалось \(запись \.qa-state не удалась: [^\n]*\), прежняя отметка в \.qa-state осталась - не коммить до полного прогона с отметкой, код прогона 1/.test(x.err)) why.push('отказ записи и «не коммить» не названы в stderr: ' + JSON.stringify(x.err.slice(-300)));
    return why.length ? why.join('; ') : true;
  });
  // Сигнал в полном прогоне (ревью E0-12AB, круг 3; решение техлида Р7): прежняя зелёная отметка не переживает
  // прерванный прогон - иначе правка, сделанная после неё, ушла бы в коммит по старой зелёной
  check('gates.js из командной строки: полный прогон прерван SIGINT при прежней зелёной отметке - код 130, дерево гейта снято, «записана отметка о красном прогоне (код 1)» в stderr, отметка - код 1 по диффу до запуска', () => {
    const all = gateRunCases();
    const x = all.cli.fullSignal;
    const g = all.marks.fullSignal;
    const w = all.watch.fullSig;
    const H = require('./diff-hash.js');
    const why = [];
    if (x.hung || x.code !== 130) why.push(cliSeen(x));
    if (!w.started) why.push('внук гейта не стартовал - сигнал не послан, проба ничего не доказывает');
    if (w.alive === null) why.push(aliveNullWhy(w));
    if (w.alive) why.push('внук ' + w.pid + ' жив после выхода gates.js - дерево гейта не снято');
    if (!/gates\.js прерван \(SIGINT\): снято деревьев гейтов - 1, записана отметка о красном прогоне \(код 1\)/.test(x.err)) why.push('прерывание и запись красной отметки не названы в stderr: ' + JSON.stringify(x.err.slice(-300)));
    if (!g || g.code !== 1 || g.hash === SEED_GREEN.hash) why.push('отметка ' + JSON.stringify(g) + ', ждали красную (код 1) вместо прежней зелёной');
    else if (g.hash !== H.diffHash(g.files) || JSON.stringify(g.files) !== JSON.stringify(['sf/b.txt'])) why.push('отметка не по диффу до запуска: ' + JSON.stringify(g));
    return why.length ? why.join('; ') : true;
  });
  // Снимок диффа (sha1 файлов) - только у прогона, который ставит отметку (ревью E0-12AB): частичный и --list его не берут
  check('gates.js из командной строки: снимок диффа берёт только полный прогон с непустой очередью (до первого гейта и после последнего), частичный и прогон без работы - ни одного', () => {
    const all = gateRunCases();
    const why = [];
    const seen = (k) => (all.spy[k] ? all.spy[k].snapshots : null);
    if (seen('full') !== 2) why.push('полный прогон: снимков ' + seen('full') + ', ждали 2');
    if (seen('fullClean') !== 0) why.push('полный прогон без работы (чистое дерево): снимков ' + seen('fullClean') + ', ждали 0 - файлы диффа читаются зря');
    if (!/Изменений нет ни в одном репозитории - гонять нечего/.test(all.cli.fullClean.out)) why.push('fullClean: дерево не чистое - ' + cliSeen(all.cli.fullClean));
    for (const k of ['onlyClean', 'onlyNoLimit', 'onlyBothDirty']) if (seen(k) !== 0) why.push(k + ' (частичный): снимков ' + seen(k) + ', ждали 0');
    return why.length ? why.join('; ') : true;
  });
  // Текст «ОСТАТОК ЖИВ» в итоге и сводке (строка TECH_DEBT 21.10.2026 T6): оболочка вышла с 0, вывод держит
  // detached-внук (POSIX - своя сессия)
  check('gates.js из командной строки: оболочка вышла с 0, а остаток держит вывод - «ОСТАТОК ЖИВ, СНЯТЬ РУКАМИ» в итоге и сводке, код 1', () => {
    const all = gateRunCases();
    const x = all.cli.remnant;
    const why = [];
    if (!all.watch.held.started) why.push('внук гейта не стартовал - проба ничего не доказывает');
    if (x.hung || x.code !== 1) why.push(cliSeen(x));
    if (!/--- sf \/ p-orphan-held: ОСТАТОК ЖИВ, СНЯТЬ РУКАМИ, /.test(x.out)) why.push('нет итога «ОСТАТОК ЖИВ, СНЯТЬ РУКАМИ» гейта p-orphan-held');
    if (!/p-orphan-held\s+.*\s+ОСТАТОК ЖИВ, СНЯТЬ РУКАМИ \(/.test(x.out)) why.push('нет «ОСТАТОК ЖИВ, СНЯТЬ РУКАМИ» в сводке');
    if (!/вышла с кодом 0, а вывод держал оставшийся от неё процесс/.test(x.out)) why.push('код оболочки и остаток не названы в тексте');
    return why.length ? why.join('; ') : true;
  });
  // Одна строка о чистом дереве при --only (строка TECH_DEBT 21.10.2026 «два сообщения»)
  check('gates.js из командной строки: --only на чистом дереве - одна строка «Изменений нет ни в одном репозитории», без «Пойдём по репозиториям»', () => {
    const x = gateRunCases().cli.onlyClean;
    const why = [];
    const n = (x.out.match(/Изменений нет ни в одном репозитории/g) || []).length;
    if (n !== 1) why.push('строк «Изменений нет ни в одном репозитории»: ' + n);
    if (/Пойдём по репозиториям/.test(x.out)) why.push('напечатано «Пойдём по репозиториям» при чистом дереве');
    return why.length ? why.join('; ') + '; ' + cliSeen(x) : true;
  });
  // --only при диффе идёт только в изменённые репозитории; владелец без изменений назван (решение техлида Р3 E0-12AB)
  check('gates.js из командной строки: --only при диффе гонит гейт в изменённом репозитории и называет владельца без изменений с --repo; все владельцы в прогоне или чистое дерево - строки нет', () => {
    const all = gateRunCases();
    const x = all.cli.onlyBothDirty;
    const why = [];
    if (x.hung || x.code !== 0) why.push(cliSeen(x));
    if (!/--- sf \/ p-both: ok/.test(x.out)) why.push('p-both не прогнан в sf');
    if (/^=== other \//m.test(x.out)) why.push('прогон пошёл в other без изменений');
    if (!/--only: гейт p-both объявлен и в other без изменений, туда прогон не идёт \(--repo=other\)/.test(x.out)) why.push('владелец other без изменений не назван');
    for (const k of ['onlyNoLimit', 'onlyCleanBoth']) {
      if (/--only: гейт .* объявлен и в /.test(all.cli[k].out)) why.push(k + ': строка о владельце вне прогона без такого владельца');
    }
    return why.length ? why.join('; ') : true;
  });
  // taskkill /T /F с ненулевым кодом (E0-12AB, шаг 6; решение техлида Р2): вердикт по эффекту
  check('gates.js из командной строки: taskkill /T /F вышел с кодом 255, а оболочка вышла и вывод закрылся - «СНЯТ ПО ПРЕДЕЛУ», код 255 в тексте, внук мёртв, не «СНЯТЬ РУКАМИ» (только Windows)', () => {
    if (process.platform !== 'win32') return { note: 'только Windows: taskkill - путь снятия Windows' };
    const all = gateRunCases();
    const x = all.cli.killPartial;
    const w = all.watch.partial;
    const why = [];
    if (x.hung || x.code !== 1) why.push(cliSeen(x));
    if (!w.started) why.push('внук гейта не стартовал до предела - проба ничего не доказывает');
    if (w.alive === null) why.push(aliveNullWhy(w));
    if (w.alive) why.push('внук ' + w.pid + ' жив - дерево не снято');
    if (!(all.spy.killPartial && all.spy.killPartial.taskkills >= 1)) why.push('taskkill не звался');
    else {
      const bad = all.spy.killPartial.taskkillArgs.filter((a) => !(Array.isArray(a) && a.length === 4 && a[0] === '/pid' && /^\d+$/.test(a[1]) && a[2] === '/T' && a[3] === '/F'));
      if (bad.length) why.push('аргументы taskkill не /pid <pid> /T /F: ' + JSON.stringify(bad));
    }
    if (!/гейт снят по пределу 1 с [^\n]*taskkill \/T \/F вышел с кодом 255, оболочка вышла, вывод закрылся/.test(x.out)) why.push('код 255 и закрывшийся вывод не названы');
    if (!/p-stuck-255\s+.*\s+СНЯТ ПО ПРЕДЕЛУ 1 с \(/.test(x.out)) why.push('нет «СНЯТ ПО ПРЕДЕЛУ 1 с» в сводке');
    if (/СНЯТЬ РУКАМИ|снять руками/.test(x.out)) why.push('снятое дерево названо «снять руками»');
    return why.length ? why.join('; ') : true;
  });
  check('gates.js из командной строки: taskkill /T /F вышел с кодом 255, а вывод не закрылся - «ПРЕДЕЛ 1 с, СНЯТЬ РУКАМИ», код 255 в тексте (только Windows)', () => {
    if (process.platform !== 'win32') return { note: 'только Windows: taskkill - путь снятия Windows' };
    const x = gateRunCases().cli.killPartialOpen;
    const why = [];
    if (x.hung || x.code !== 1) why.push(cliSeen(x));
    if (!/снять дерево процессов не удалось: taskkill \/T \/F вышел с кодом 255; вывод не закрылся за [^\n]*; снять руками/.test(x.out)) why.push('код 255 и открытый вывод не названы');
    if (!/p-noop-255\s+.*\s+ПРЕДЕЛ 1 с, СНЯТЬ РУКАМИ \(/.test(x.out)) why.push('нет «ПРЕДЕЛ 1 с, СНЯТЬ РУКАМИ» в сводке');
    if (/гейт снят по пределу|СНЯТ ПО ПРЕДЕЛУ/.test(x.out)) why.push('гейт с открытым выводом назван снятым');
    return why.length ? why.join('; ') : true;
  });
  // Код taskkill, не разобранный замером (решение техлида Р5 E0-12AB): дерево снято и вывод закрылся, но код 1 - отказ снятия
  check('gates.js из командной строки: taskkill /T /F вышел с кодом 1, а оболочка вышла и вывод закрылся - «ПРЕДЕЛ 1 с, СНЯТЬ РУКАМИ», код 1 в тексте (только Windows)', () => {
    if (process.platform !== 'win32') return { note: 'только Windows: taskkill - путь снятия Windows' };
    const x = gateRunCases().cli.killStatusOne;
    const why = [];
    if (x.hung || x.code !== 1) why.push(cliSeen(x));
    if (!/снять дерево процессов не удалось: taskkill \/T \/F вышел с кодом 1; вывод закрылся; снять руками/.test(x.out)) why.push('код 1 и закрывшийся вывод не названы отказом');
    if (!/p-stuck-1\s+.*\s+ПРЕДЕЛ 1 с, СНЯТЬ РУКАМИ \(/.test(x.out)) why.push('нет «ПРЕДЕЛ 1 с, СНЯТЬ РУКАМИ» в сводке');
    if (/гейт снят по пределу|СНЯТ ПО ПРЕДЕЛУ/.test(x.out)) why.push('код 1 назван снятием');
    return why.length ? why.join('; ') : true;
  });
  /** Вывод одного гейта прогона: от «=== repo / id:» до конца строки «--- repo / id:», '' - если гейта нет. */
  function gateRunOutput(out, repo, id) {
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
    const flood = gateRunOutput(x.out, 'sf', 'p-flood');
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
    const printed = /Полный вывод: (.+)/.exec(gateRunOutput(x.out, 'sf', 'p-fail-short'));
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
    const glob = gateRunOutput(x.out, 'sf', 'p-glob');
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
    const section = gateRunOutput(x.out, 'sf', 'p-long-green');
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
    const at = gateRunOutput(all.cli.green200.out, 'sf', 'p-green-200');
    const past = gateRunOutput(all.cli.green201.out, 'sf', 'p-green-201');
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
    const section = gateRunOutput(x.out, 'sf', 'p-fail-short');
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
    const long = gateRunOutput(all.cli.longGreenNoLog.out, 'sf', 'p-long-green');
    const flood = gateRunOutput(all.cli.floodNoLog.out, 'sf', 'p-flood');
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
    const section = gateRunOutput(x.out, 'sf', 'p-fail-silent');
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
    const section = gateRunOutput(x.out, 'sf', 'p-fail-short');
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
      const section = gateRunOutput(x.out, 'sf', 'p-fail-short');
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
      if (w.alive === null) why.push(aliveNullWhy(w));
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

  /**
   * runGate с поддельным процессом (E0-12AB, шаги 4-6): дочерний node подменяет cp.spawn (поддельный
   * процесс: EventEmitter, stdout/stderr - PassThrough, свой pid у каждого), снятие дерева (cp.spawnSync
   * для taskkill - аргументы сверяются с /pid <pid> /T /F, код подменяется случаем; process.kill группе;
   * снятие вышедшего процесса - ESRCH), process.platform (случаи taskkill идут путём Windows на любой
   * ОС) и таймер предела: колбэк предела зовётся руками - порядок двух таймеров одной длительности в
   * одном обороте не обещан, ручной вызов детерминирован (выбор - в деле E0-12AB). Подмены - только в
   * дочернем процессе. Случаи:
   *   sameTurn, beforeCheck - колбэк предела, выход оболочки с 0 до фазы check этого оборота
   *     (process.nextTick; setImmediate, поставленный раньше отложенного снятия): снятий 0, код 0;
   *   afterCheck - выход в setImmediate после отложенного снятия: снятие одно (окно сужено, а не снято);
   *   late - колбэк предела без выхода: снятие ровно одно, «снят по пределу»;
   *   closeOnly - close(0) без exit и без error: код 1, «не сообщила о выходе»;
   *   errorClose - error, затем close: код 1, «не удалось запустить команду», исключений нет;
   *   splitFake - первый байт символа в stdout, кусок stderr, остаток символа в stdout: символ цел;
   *   kill255Closed, kill255Open, kill1Closed - путь Windows, taskkill снимает дерево (или нет) и
   *     отвечает 255 или 1: вердикт по эффекту - только у 255 при вышедшей оболочке и закрывшемся выводе;
   *   abortTwo - два runGate параллельно, abortRunning: сняты оба;
   *   abort255 - путь Windows, abortRunning при коде taskkill 255: отказ снятия с кодом в причине (Р2, Р7).
   */
  let fakeRunResult = null;
  function fakeRunCases() {
    if (!fakeRunResult) {
      try {
        fakeRunResult = { value: buildFakeRunCases() };
      } catch (e) {
        fakeRunResult = { error: e };
      }
    }
    if (fakeRunResult.error) throw fakeRunResult.error;
    return fakeRunResult.value;
  }
  function buildFakeRunCases() {
    // ребёнок грузит gates.js require - только после зелёной пробы require
    const { limits } = gatesModule();
    const dir = tempDir('fake-run');
    try {
      const code = [
        "const cp = require('child_process');",
        "const { EventEmitter } = require('events');",
        "const { PassThrough } = require('stream');",
        'const LIMIT_MS = 1000;',
        'const realSetTimeout = setTimeout;',
        // process.platform случая: путь снятия Windows (taskkill) проверяется на любой ОС
        'const realPlatform = process.platform;',
        'let platform = realPlatform;',
        "Object.defineProperty(process, 'platform', { get: () => platform, configurable: true });",
        'let fakes = [];',
        'let fake = null;',
        'let limitCb = null;',
        'let kills = 0;',
        // код taskkill случая (null - 0 при снятии живого, 128 при вышедшем) и снимает ли taskkill процесс
        'let killStatus = null;',
        'let killDoes = true;',
        'let taskkillArgs = [];',
        // таймер предела запоминается, а не ставится: его колбэк зовёт случай
        'global.setTimeout = function (fn, ms) {',
        '  if (ms === LIMIT_MS && fake && !limitCb) { limitCb = fn; return realSetTimeout(() => {}, 0); }',
        '  return realSetTimeout.apply(this, arguments);',
        '};',
        'function exitAndClose(f, code, signal) {',
        '  if (f.exited) return;',
        '  f.exited = true;',
        "  f.emit('exit', code, signal);",
        "  realSetTimeout(() => { f.stdout.end(); f.stderr.end(); f.emit('close', code, signal); }, 10);",
        '}',
        // снятие живого процесса считается и завершает его; вышедшего или чужого - ESRCH, как у настоящей группы
        'function killed(f) {',
        "  if (!f || f.exited) throw Object.assign(new Error('ESRCH (проба)'), { code: 'ESRCH' });",
        '  kills++;',
        "  process.nextTick(() => exitAndClose(f, null, 'SIGKILL'));",
        '}',
        'const byPid = (pid) => fakes.find((f) => f.pid === pid);',
        'cp.spawn = () => {',
        '  fake = new EventEmitter();',
        '  fake.pid = 2147480000 + fakes.length;',
        '  fake.exited = false;',
        '  fake.stdout = new PassThrough();',
        '  fake.stderr = new PassThrough();',
        '  fakes.push(fake);',
        '  return fake;',
        '};',
        'const errors = [];',
        // taskkill: аргументы - ровно /pid <pid> /T /F живого поддельного процесса, иначе ошибка ребёнка
        'cp.spawnSync = (file, args) => {',
        "  if (!/taskkill/i.test(String(file))) throw new Error('spawnSync ' + file);",
        '  taskkillArgs.push(args);',
        '  const f = byPid(Number(args && args[1]));',
        "  if (!f || JSON.stringify(args) !== JSON.stringify(['/pid', String(f.pid), '/T', '/F'])) {",
        "    errors.push('taskkill с аргументами ' + JSON.stringify(args));",
        '    return { pid: 1, status: 1, signal: null };',
        '  }',
        '  let status = 0;',
        '  try { if (killDoes) killed(f); } catch (_) { status = 128; }',
        '  return { pid: 1, status: killStatus === null ? status : killStatus, signal: null };',
        '};',
        'const realKill = process.kill;',
        "process.kill = function (pid) { if (typeof pid === 'number' && pid < 0) { killed(byPid(-pid)); return true; } return realKill.apply(process, arguments); };",
        "process.on('uncaughtException', (e) => errors.push(String((e && e.message) || e)));",
        'const { runGate, abortRunning } = require(' + JSON.stringify(path.join(HOOKS, 'gates.js')) + ');',
        "const gate = { id: 'probe-fake', cmd: 'fake', timeoutSec: 1 };",
        'const reset = (o) => {',
        '  const c = o || {};',
        '  fakes = []; fake = null; limitCb = null; kills = 0; taskkillArgs = [];',
        '  platform = c.platform || realPlatform;',
        '  killStatus = c.status === undefined ? null : c.status;',
        '  killDoes = c.kills !== false;',
        '};',
        'const cap = () => new Promise((res) => realSetTimeout(() => res(null), ' + (limits.KILL_GRACE_MS + 6000) + '));',
        'const one = async (drive, o) => {',
        '  reset(o);',
        '  const p = runGate(gate, process.cwd());',
        '  realSetTimeout(drive, 5);',
        '  const r = await Promise.race([p, cap()]);',
        '  const pid = fakes.length ? fakes[0].pid : null;',
        '  return r ? { code: r.code, text: r.text, timedOut: r.timedOut, manual: r.manual, kills, taskkillArgs, pid } : { hung: true, kills };',
        '};',
        '(async () => {',
        '  const cases = {};',
        // выход отдан после колбэка предела, но до фазы check этого оборота: страж отложенного снятия его видит
        '  cases.sameTurn = await one(() => { limitCb(); process.nextTick(() => exitAndClose(fake, 0, null)); });',
        '  cases.beforeCheck = await one(() => { setImmediate(() => exitAndClose(fake, 0, null)); limitCb(); });',
        // выход после отложенного снятия (позже в фазе check): окно стража сужено, а не снято
        '  cases.afterCheck = await one(() => { limitCb(); setImmediate(() => exitAndClose(fake, 0, null)); });',
        '  cases.late = await one(() => limitCb());',
        "  cases.closeOnly = await one(() => { fake.stdout.end(); fake.stderr.end(); fake.emit('close', 0, null); });",
        "  cases.errorClose = await one(() => { fake.emit('error', new Error('spawn fake ENOENT (проба)')); fake.emit('close', -2, null); });",
        "  const b = Buffer.from('ПРИВЕТ-ЮНИКОД\\n', 'utf8');",
        "  cases.splitFake = await one(() => { fake.stdout.emit('data', b.subarray(0, 1)); fake.stderr.emit('data', Buffer.from('E\\n')); fake.stdout.emit('data', b.subarray(1)); exitAndClose(fake, 0, null); });",
        // путь Windows на любой ОС: taskkill снял дерево или нет и ответил 255 или 1 (решения техлида Р2, Р5 E0-12AB)
        "  cases.kill255Closed = await one(() => limitCb(), { platform: 'win32', status: 255 });",
        "  cases.kill255Open = await one(() => limitCb(), { platform: 'win32', status: 255, kills: false });",
        "  cases.kill1Closed = await one(() => limitCb(), { platform: 'win32', status: 1 });",
        // два runGate параллельно (как в ребёнке проб запуска): abortRunning снимает оба
        '  reset();',
        '  const two = [runGate(gate, process.cwd()), runGate(gate, process.cwd())];',
        '  await new Promise((res) => realSetTimeout(res, 5));',
        '  const a = abortRunning();',
        '  const rs = await Promise.race([Promise.all(two), cap()]);',
        '  cases.abortTwo = { killed: a.killed, failed: a.failed, exited: a.exited, kills, codes: rs ? rs.map((x) => x.code) : null };',
        // снятие сигналом при коде taskkill 255: эффект в обработчике проверить нечем - отказ (решения техлида Р2, Р7
        // E0-12AB); rootGone - в итоге случая, чтобы третий исход вместо отказа был виден строке пробы
        "  reset({ platform: 'win32', status: 255 });",
        '  const g255 = runGate(gate, process.cwd());',
        '  await new Promise((res) => realSetTimeout(res, 5));',
        '  const a255 = abortRunning();',
        '  await Promise.race([g255, cap()]);',
        '  cases.abort255 = { killed: a255.killed, failed: a255.failed, exited: a255.exited, rootGone: a255.rootGone, kills };',
        "  process.stdout.write('probe ' + JSON.stringify({ cases, errors }));",
        '  ' + EXIT + '(0);',
        '})();',
      ].join('\n');
      const r = run(process.execPath, ['-e', code], { cwd: dir, timeout: 60000, killSignal: 'SIGKILL', env: Object.assign({}, process.env, { SF_HOOK_STATE_DIR: dir }) });
      const m = /(?:^|\n)probe (\{.*\})$/.exec(String(r.stdout || ''));
      if (!m) throw new Error('проба runGate с поддельным процессом не дошла до итога (код ' + r.status + '): ' + String(r.stderr || r.stdout || (r.error && r.error.message)).slice(0, 200));
      return JSON.parse(m[1]);
    } finally {
      releaseTemp(dir);
    }
  }
  /** Случай поддельного процесса словами для строки отказа. */
  function fakeSeen(x) {
    if (x.hung) return 'runGate не вернулся, снятий ' + x.kills;
    return 'код ' + x.code + ', снятий ' + x.kills + ', timedOut ' + x.timedOut + ', manual ' + x.manual + ', текст ' + JSON.stringify(String(x.text).slice(-160));
  }
  /** Ошибки дочернего node (исключения, taskkill с чужими аргументами) - отказ любой строки поддельного процесса. */
  function fakeErrors(all) {
    return all.errors.length ? 'ошибки в ребёнке: ' + all.errors.join('; ') : null;
  }
  // Предел рядом с выходом оболочки (строки TECH_DEBT 21.10.2026 «страж entry.exited» и «предел в одном обороте
  // с выходом cmd.exe»): снятие отложено на фазу check - выход, отданный до неё, страж видит; выход после неё -
  // нет (снятие одно). Фаза, в которой Windows отдаёт выход cmd.exe, не замерялась (комментарий в gates.js).
  check('gates.js runGate: выход оболочки после колбэка предела, но до фазы check этого оборота (process.nextTick; setImmediate, поставленный раньше снятия), - снятий 0, код оболочки, не «снят по пределу»', () => {
    const all = fakeRunCases();
    const why = [];
    for (const k of ['sameTurn', 'beforeCheck']) {
      const x = all.cases[k];
      if (x.hung || x.kills !== 0 || x.code !== 0 || x.timedOut) why.push(k + ': ' + fakeSeen(x));
    }
    const err = fakeErrors(all);
    if (err) why.push(err);
    return why.length ? why.join('; ') : true;
  });
  check('gates.js runGate: выход оболочки после отложенного снятия (позже в фазе check) - снятие одно, «снят по пределу»: окно стража сужено, а не снято', () => {
    const x = fakeRunCases().cases.afterCheck;
    if (x.hung || x.kills !== 1 || x.code !== 1 || !x.timedOut || !/гейт снят по пределу 1 с/.test(x.text)) return fakeSeen(x);
    return true;
  });
  check('gates.js runGate: предел без выхода оболочки - снятие ровно одно, «снят по пределу»', () => {
    const x = fakeRunCases().cases.late;
    if (x.hung || x.kills !== 1 || x.code !== 1 || !x.timedOut || !/гейт снят по пределу 1 с/.test(x.text)) return fakeSeen(x);
    return true;
  });
  // Вердикт по эффекту (решения техлида Р2 и Р5 E0-12AB) - путь Windows с подменённым taskkill на любой ОС:
  // только код 255 при вышедшей оболочке и закрывшемся выводе - «снят по пределу»
  check('gates.js runGate (taskkill подменён, любая ОС): код 255, оболочка вышла и вывод закрылся - «снят по пределу», код в тексте, не «снять руками»; аргументы taskkill - /pid <pid> /T /F', () => {
    const all = fakeRunCases();
    const x = all.cases.kill255Closed;
    const why = [];
    if (x.hung || x.code !== 1 || !x.timedOut || x.manual || x.kills !== 1) why.push(fakeSeen(x));
    if (!/гейт снят по пределу 1 с [^\n]*taskkill \/T \/F вышел с кодом 255, оболочка вышла, вывод закрылся/.test(String(x.text))) why.push('код 255 и закрывшийся вывод не названы');
    if (JSON.stringify(x.taskkillArgs) !== JSON.stringify([['/pid', String(x.pid), '/T', '/F']])) why.push('вызовы taskkill ' + JSON.stringify(x.taskkillArgs) + ', ждали один /pid ' + x.pid + ' /T /F');
    const err = fakeErrors(all);
    if (err) why.push(err);
    return why.length ? why.join('; ') : true;
  });
  check('gates.js runGate (taskkill подменён, любая ОС): код 255, вывод не закрылся - «снять руками», код и открытый вывод в тексте', () => {
    const x = fakeRunCases().cases.kill255Open;
    if (x.hung || x.code !== 1 || !x.timedOut || !x.manual || !/taskkill \/T \/F вышел с кодом 255; вывод не закрылся за [^;]*; снять руками/.test(String(x.text))) return fakeSeen(x);
    return true;
  });
  check('gates.js runGate (taskkill подменён, любая ОС): код 1, хоть оболочка вышла и вывод закрылся, - «снять руками»: вердикт по эффекту только у кода 255', () => {
    const x = fakeRunCases().cases.kill1Closed;
    if (x.hung || x.code !== 1 || !x.timedOut || !x.manual || !/taskkill \/T \/F вышел с кодом 1; вывод закрылся; снять руками/.test(String(x.text))) return fakeSeen(x);
    return true;
  });
  // runGate экспортирован и идёт параллельно в ребёнке проб: обработчик сигнала снимает каждое идущее дерево (ревью E0-12AB)
  check('gates.js abortRunning: два параллельных runGate - сняты оба, оба вернулись', () => {
    const all = fakeRunCases();
    const x = all.cases.abortTwo;
    const why = [];
    if (x.killed !== 2 || x.kills !== 2 || x.failed.length) why.push('снято ' + x.killed + ' (снятий ' + x.kills + ', отказов ' + x.failed.length + '), ждали 2');
    if (!x.codes || x.codes.length !== 2 || x.codes.some((c) => c === 0)) why.push('итоги ' + JSON.stringify(x.codes) + ', ждали два красных');
    const err = fakeErrors(all);
    if (err) why.push(err);
    return why.length ? why.join('; ') : true;
  });
  // Ctrl+C при коде taskkill 255 (решения техлида Р2 и Р7 E0-12AB): эффект снятия обработчик сигнала проверить не
  // может (вывод не ждётся) - отказ с кодом в причине, обработчик печатает его с «снять руками»
  check('gates.js abortRunning (taskkill подменён, любая ОС): код 255 - отказ снятия, «taskkill /T /F вышел с кодом 255» в причине, не «снято» и не третий исход', () => {
    const all = fakeRunCases();
    const x = all.cases.abort255;
    const why = [];
    if (x.killed !== 0 || x.failed.length !== 1 || !/taskkill \/T \/F вышел с кодом 255/.test(String(x.failed[0])) || x.kills !== 1) {
      why.push('снято ' + x.killed + ', отказов ' + x.failed.length + ' (' + x.failed.join('; ') + '), снятий ' + x.kills + ', ждали 0 снятых и один отказ «taskkill /T /F вышел с кодом 255»');
    }
    if (x.rootGone !== undefined) why.push('итог abortRunning с полем rootGone ' + x.rootGone + ' - третий исход вместо отказа');
    const err = fakeErrors(all);
    if (err) why.push(err);
    return why.length ? why.join('; ') : true;
  });
  // close без exit (строка TECH_DEBT 21.10.2026 A8): код из close гейт зелёным не делает (fail-closed)
  check('gates.js runGate: вывод закрылся без выхода оболочки (close без exit и error) - код 1, «не сообщила о выходе»', () => {
    const x = fakeRunCases().cases.closeOnly;
    if (x.hung || x.code !== 1 || !/вывод закрылся, а оболочка гейта не сообщила о выходе/.test(x.text)) return fakeSeen(x);
    return true;
  });
  check('gates.js runGate: ошибка запуска, затем close - код 1, «не удалось запустить команду», исключений нет', () => {
    const all = fakeRunCases();
    const x = all.cases.errorClose;
    if (x.hung || x.code !== 1 || !/не удалось запустить команду: spawn fake ENOENT/.test(x.text)) return fakeSeen(x);
    return all.errors.length ? 'исключения в ребёнке: ' + all.errors.join('; ') : true;
  });
  // Хвост незаконченного символа у каждого потока (E0-12AB, шаг 9): куски - событиями data поддельного
  // процесса, без пайпа - их не склеит занятый цикл событий, как куски пробы split через настоящий пайп
  check('gates.js runGate: символ UTF-8, разрезанный между кусками stdout поддельного процесса с куском stderr между ними, цел (куски - событиями, без пайпа)', () => {
    const x = fakeRunCases().cases.splitFake;
    if (x.hung || x.code !== 0) return fakeSeen(x);
    return /^E\nПРИВЕТ-ЮНИКОД\s*$/.test(x.text) || 'вывод ' + JSON.stringify(x.text) + ', ждали "E\\nПРИВЕТ-ЮНИКОД\\n"';
  });

  /** Раздел «## Гейты» документа: от заголовка до следующего «## »; null - раздела нет. */
  function harnessGatesSection(text) {
    const start = text.indexOf('\n## Гейты\n');
    if (start < 0) return null;
    const end = text.indexOf('\n## ', start + 1);
    return text.slice(start, end < 0 ? text.length : end);
  }
  /**
   * Расхождения меток сводки и матрицы (E0-12AB, шаг 3; строка TECH_DEBT 21.10.2026 A3): каждая метка - код в
   * обратных кавычках раздела, и в разделе нет кода с заглавным словом (три и больше заглавных кириллицей),
   * которого нет среди меток. Текст раздела - параметром: отказы - на синтетике, пропуск - на документе.
   */
  function verdictMatrixGaps(labels, section) {
    const spans = String(section).split('`').filter((_, i) => i % 2 === 1);
    const why = [];
    for (const l of labels) if (spans.indexOf(l) === -1) why.push('метки «' + l + '» нет в матрице');
    for (const sp of spans) if (/[А-ЯЁ]{3,}/.test(sp) && labels.indexOf(sp) === -1) why.push('в матрице метка «' + sp + '», которой нет в VERDICTS');
    return why;
  }
  check('gates.js: метки вердиктов (verdicts) и матрица docs/60_HARNESS.md «Гейты» совпадают; выдуманная и пропавшая метка - отказ', () => {
    const { verdicts } = gatesModule();
    if (!Array.isArray(verdicts) || !verdicts.length) return 'gates.js не экспортирует verdicts: ' + JSON.stringify(verdicts);
    const table = (labels) => labels.map((l) => '| `' + l + '` | когда | что делать |').join('\n');
    const why = [];
    const full = verdictMatrixGaps(verdicts, table(verdicts));
    if (full.length) why.push('синтетика с полной матрицей - отказ: ' + full.join('; '));
    if (!verdictMatrixGaps(verdicts, table(verdicts) + '\n| `СНЯТО НАВСЕГДА` | когда | что делать |').length) why.push('выдуманная метка в синтетике не замечена');
    if (!verdictMatrixGaps(verdicts, table(verdicts.slice(1))).length) why.push('пропавшая из синтетики метка не замечена');
    const section = harnessGatesSection(fs.readFileSync(path.join(ROOT, 'docs', '60_HARNESS.md'), 'utf8'));
    if (section === null) why.push('в docs/60_HARNESS.md нет раздела «## Гейты»');
    else why.push(...verdictMatrixGaps(verdicts, section));
    return why.length ? why.join('; ') : { note: verdicts.length + ' меток' };
  });

  // Снимок диффа одного прогона (решения техлида Р1 и Р6 E0-12AB, ревью круги 1 и 2): каждая ветка отпечатка и
  // сверки - своя причина отказа; файлы - во временном каталоге, репозиторий пробы передан opts.repos, sha1 файла - opts.hash
  check('diff-hash.js diffSnapshot/diffMoved: файл - sha1 (чтение кусками, не readFileSync), удалённый - «нет», каталог - null с причиной «метка-каталог … .gitignore …», не обычный файл (FIFO) - null «не обычный файл» без открытия, ссылка - не по ссылке, чужая метка и сбой чтения после повтора - null с причиной; новая, пропавшая, другая и null - изменилась, причины без повторов; shortList (lib.js, не diff-hash.js) - «и ещё N», и в отказе gatesProblem', () => {
    const H = require('./diff-hash.js');
    const L = require('./lib.js');
    const dir = tempDir('snapshot');
    try {
      put(dir, 'f.txt', 'a');
      put(dir, 'd/inner.txt', 'x');
      const repos = [{ name: 't', path: dir }];
      const labels = ['t/f.txt', 't/gone.txt', 't/d', 'zz/out.txt'];
      const why = [];
      // файл читается кусками: readFileSync на нём бросает (как у файла больше предела Buffer)
      const readFileSync = fs.readFileSync;
      const target = path.join(dir, 'f.txt');
      fs.readFileSync = function (p) {
        if (path.resolve(String(p)) === target) throw Object.assign(new Error('File size is greater than 2 GiB (проба)'), { code: 'ERR_FS_FILE_TOO_LARGE' });
        return readFileSync.apply(fs, arguments);
      };
      let s1;
      try {
        s1 = H.diffSnapshot(labels, { repos });
      } finally {
        fs.readFileSync = readFileSync;
      }
      if (s1.prints['t/f.txt'] !== require('crypto').createHash('sha1').update('a').digest('hex')) why.push('файл (readFileSync бросает): ' + s1.prints['t/f.txt'] + ' (' + s1.unread['t/f.txt'] + ')');
      if (s1.prints['t/gone.txt'] !== 'нет') why.push('удалённый: ' + s1.prints['t/gone.txt']);
      if (s1.prints['t/d'] !== null || s1.unread['t/d'] !== 'метка-каталог t/d: вложенный репозиторий: внеси каталог в .gitignore внешнего репозитория или убери (отдельный репозиторий - ещё и в repos.json)') why.push('каталог: ' + s1.prints['t/d'] + ', причина ' + JSON.stringify(s1.unread['t/d']));
      // не обычный файл (FIFO, сокет, устройство; решение техлида Р7): поддельный lstat - не ссылка, не каталог, не
      // файл; открытие FIFO висело бы без предела - hash не зовётся
      let opened = 0;
      const fifo = { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false };
      const special = H.diffSnapshot(['t/f.txt'], { repos, lstat: () => fifo, hash: () => { opened++; return 'opened'; } });
      if (special.prints['t/f.txt'] !== null || special.unread['t/f.txt'] !== 't/f.txt: не обычный файл' || opened) why.push('не обычный файл: ' + special.prints['t/f.txt'] + ', причина ' + JSON.stringify(special.unread['t/f.txt']) + ', открытий ' + opened);
      if (s1.prints['zz/out.txt'] !== null || !/^zz\/out\.txt: метка ни одного репозитория/.test(String(s1.unread['zz/out.txt']))) why.push('метка чужого репозитория: ' + s1.prints['zz/out.txt'] + ', причина ' + JSON.stringify(s1.unread['zz/out.txt']));
      // ссылка (на Windows - junction, без прав администратора): отпечаток - сама ссылка, каталог-цель не читается
      fs.symlinkSync(path.join(dir, 'd'), path.join(dir, 'link'), 'junction');
      const link = H.diffSnapshot(['t/link'], { repos });
      if (!/^ссылка [0-9a-f]{40}$/.test(String(link.prints['t/link']))) why.push('ссылка на каталог: ' + link.prints['t/link'] + ', причина ' + JSON.stringify(link.unread['t/link']) + ' - ссылка разыменована');
      let calls = 0;
      const flaky = (f) => {
        calls++;
        if (calls === 1) throw Object.assign(new Error('EBUSY (проба)'), { code: 'EBUSY' });
        return 'h:' + path.basename(f);
      };
      const retried = H.diffSnapshot(['t/f.txt'], { repos, hash: flaky }).prints['t/f.txt'];
      if (retried !== 'h:f.txt' || calls !== 2) why.push('сбой чтения один раз: ' + retried + ', чтений ' + calls + ', ждали отпечаток после повтора');
      const broken = () => {
        throw Object.assign(new Error('EBUSY (проба)'), { code: 'EBUSY' });
      };
      const twice = H.diffSnapshot(['t/f.txt'], { repos, hash: broken });
      if (twice.prints['t/f.txt'] !== null || twice.unread['t/f.txt'] !== 't/f.txt: не читается (EBUSY)') why.push('сбой чтения дважды: ' + twice.prints['t/f.txt'] + ', причина ' + JSON.stringify(twice.unread['t/f.txt']));
      const moved = (x, y) => H.diffMoved(x, y).sort().join(',');
      const base = { labels: ['a', 'b', 'c', 'd'], prints: { a: 'x', b: 'y', c: null, d: 'нет' } };
      const got = moved(base, { labels: ['a', 'b', 'c', 'd', 'e'], prints: { a: 'x', b: 'z', c: null, d: 'нет', e: '1' } });
      if (got !== 'b,c,e') why.push('другой, null, новая: ' + got + ', ждали b,c,e');
      const gone = moved(base, { labels: ['a', 'b'], prints: { a: 'x', b: 'y' } });
      if (gone !== 'c,d') why.push('пропавшие: ' + gone + ', ждали c,d');
      const same = moved({ labels: ['a'], prints: { a: 'x' } }, { labels: ['a'], prints: { a: 'x' } });
      if (same !== '') why.push('тот же дифф: ' + same);
      const noPrint = moved({ labels: ['a'], prints: { a: 'x' } }, { labels: ['a'], prints: {} });
      if (noPrint !== 'a') why.push('нет отпечатка во втором снимке: ' + noPrint);
      const w = H.movedWhy(['c', 'e'], { labels: ['c'], prints: { c: null }, unread: { c: 'причина c' } }, { labels: ['c', 'e'], prints: { c: null, e: '1' }, unread: { c: 'причина c' } });
      if (JSON.stringify(w) !== JSON.stringify(['причина c'])) why.push('причины moved: ' + JSON.stringify(w) + ', ждали одну «причина c»');
      const long = L.shortList(['1', '2', '3', '4', '5', '6', '7', '8']);
      if (long !== '1, 2, 3, 4, 5, 6 и ещё 2') why.push('shortList восьми: ' + long);
      if (L.shortList(['1', '2']) !== '1, 2') why.push('shortList двух: ' + L.shortList(['1', '2']));
      // помощник списка - один, в lib.js (решение техлида Р7): модуль отметок его не держит и не экспортирует
      if (H.shortList !== undefined) why.push('shortList экспортирует diff-hash.js - вторая точка помощника');
      const eight = ['sf/1', 'sf/2', 'sf/3', 'sf/4', 'sf/5', 'sf/6', 'sf/7', 'sf/8'];
      const gp = H.gatesProblem({ lastGates: { hash: 'old', files: [], code: 0 } }, 'new', eight);
      if (!/: sf\/1, sf\/2, sf\/3, sf\/4, sf\/5, sf\/6 и ещё 2$/.test(String(gp))) why.push('gatesProblem не через shortList: ' + JSON.stringify(gp));
      return why.length ? why.join('; ') : true;
    } finally {
      releaseTemp(dir);
    }
  });
  // Имена файлов диффа с не-ASCII символами и пробелом с краю (ревью E0-12AB, круг 2): git без -z отдаёт первые в
  // кавычках с восьмеричными escape, обрезка вывода срезает второй - метка не совпала бы с путём на диске, и
  // правка такого файла за прогон была бы не видна (отпечаток «нет» до и после)
  // branch - ветка временного репозитория: main - база есть (дифф от неё), иное имя - базы нет, ветка рабочего дерева
  // против HEAD (ревью E0-12AB, круг 3; решение техлида Р7: тот же -z и разбор, что у ветки с базой)
  function nonAsciiNames(branch) {
    const dir = tempDir('names');
    try {
      gitStrict(['init', '-q', '--template='], { cwd: dir });
      put(dir, 'ж.txt', '1');
      gitStrict(['add', '-A'], { cwd: dir });
      gitStrict(['-c', 'user.name=probe', '-c', 'user.email=probe@local', 'commit', '-q', '-m', 'base'], { cwd: dir });
      gitStrict(['branch', '-M', branch], { cwd: dir });
      put(dir, 'ж.txt', '2');
      put(dir, ' lead.txt', 'l');
      put(dir, 'ё.txt', 'e');
      const code = [
        'const L = require(' + JSON.stringify(path.join(HOOKS, 'lib.js')) + ');',
        "L.knownRepos = () => [{ name: 't', path: " + JSON.stringify(dir) + ' }];',
        'L.rulesFor = () => ({});',
        'const H = require(' + JSON.stringify(path.join(HOOKS, 'diff-hash.js')) + ');',
        'const a = H.diffSnapshot();',
        "require('fs').appendFileSync(" + JSON.stringify(path.join(dir, 'ж.txt')) + ", '3');",
        'const b = H.diffSnapshot();',
        'process.stdout.write(JSON.stringify({ labels: a.labels, prints: a.prints, moved: H.diffMoved(a, b) }));',
      ].join('\n');
      const r = run(process.execPath, ['-e', code], { cwd: dir, env: Object.assign({}, process.env, { SF_HOOK_STATE_DIR: dir }) });
      if (r.status !== 0) return 'ребёнок: код ' + r.status + ' ' + String(r.stderr || '').slice(0, 200);
      const x = JSON.parse(String(r.stdout));
      const want = ['t/ lead.txt', 't/ж.txt', 't/ё.txt'];
      const why = [];
      if (JSON.stringify(x.labels) !== JSON.stringify(want)) why.push('метки ' + JSON.stringify(x.labels) + ', ждали ' + JSON.stringify(want));
      for (const l of want) if (!/^[0-9a-f]{40}$/.test(String(x.prints[l]))) why.push(l + ': отпечаток ' + JSON.stringify(x.prints[l]));
      if (JSON.stringify(x.moved) !== JSON.stringify(['t/ж.txt'])) why.push('правка t/ж.txt: изменились ' + JSON.stringify(x.moved));
      return why.length ? why.join('; ') : true;
    } finally {
      releaseTemp(dir);
    }
  }
  check('diff-hash.js diffLabels: не-ASCII имя (изменённое и новое) и имя с пробелом в начале - метки как на диске, отпечаток - sha1 файла, правка видна', () => nonAsciiNames('main'));
  check('diff-hash.js diffLabels без базовой ветки (ни origin/main, ни main): не-ASCII имя (изменённое и новое) и имя с пробелом в начале - метки как на диске, отпечаток - sha1 файла, не «нет», правка видна', () => nonAsciiNames('probe-no-base'));
  // Имя репозитория - префикс другого (ревью E0-12AB, круг 2, T1): метка - самого длинного подошедшего, порядок repos не важен
  check('lib.js unlabel: имена «sf» и «sf/x» - метка sf/x/a.txt у sf/x в любом порядке repos, sf/y.txt у sf, чужая - null', () => {
    const L = require('./lib.js');
    const sf = { name: 'sf', path: '/r/sf' };
    const sfx = { name: 'sf/x', path: '/r/sfx' };
    const why = [];
    for (const repos of [[sf, sfx], [sfx, sf]]) {
      const order = repos.map((r) => r.name).join(',');
      const a = L.unlabel(repos, 'sf/x/a.txt');
      if (!a || a.repo !== sfx || a.rel !== 'a.txt') why.push(order + ': sf/x/a.txt -> ' + JSON.stringify(a));
      const b = L.unlabel(repos, 'sf/y.txt');
      if (!b || b.repo !== sf || b.rel !== 'y.txt') why.push(order + ': sf/y.txt -> ' + JSON.stringify(b));
    }
    if (L.unlabel([sf, sfx], 'zz/a.txt') !== null) why.push('чужая метка не null');
    return why.length ? why.join('; ') : true;
  });
  // markGates(code, <не массив>) - прежняя форма markGates(code, hash): молча поставить отметку по диффу конца
  // прогона нельзя (ревью E0-12AB, C1); ребёнок со своим каталогом состояния - отметка не уходит в боевой
  check('diff-hash.js markGates(code, <не массив>) - исключение до записи, отметки нет', () => {
    const dir = tempDir('mark-shape');
    try {
      const r = run(process.execPath, ['-e', 'const H = require(' + JSON.stringify(path.join(HOOKS, 'diff-hash.js')) + ');' + " try { H.markGates(0, 'abc'); process.stdout.write('marked'); } catch (e) { process.stdout.write('threw ' + e.name); }"], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { SF_HOOK_STATE_DIR: dir }),
      });
      const why = [];
      if (String(r.stdout) !== 'threw TypeError') why.push('вывод ' + JSON.stringify(String(r.stdout)) + ', ждали «threw TypeError»; stderr ' + String(r.stderr || '').slice(0, 120));
      if (lastGatesIn(dir) !== null) why.push('отметка поставлена');
      return why.length ? why.join('; ') : true;
    } finally {
      releaseTemp(dir);
    }
  });
  // Память вывода (ревью E0-12AB, C8): срез subarray держал бы весь кусок, от которого отрезан
  check('gates.js outputBuffer: кусок больше головы и хвоста не держится целиком - голова, хвост и хвост символа - копии (heldBytes не больше головы, хвоста и 64 КиБ)', () => {
    const { outputBuffer, limits } = gatesModule();
    const { EventEmitter } = require('events');
    const ob = outputBuffer();
    const s = new EventEmitter();
    ob.attach(s);
    const big = Buffer.alloc(limits.OUTPUT_HEAD_BYTES + limits.OUTPUT_TAIL_BYTES + 1024 * 1024, 0x61);
    // первый байт «ж» в конце куска - хвост символа ждёт следующего куска (carry)
    big[big.length - 1] = 0xd0;
    s.emit('data', big);
    const held = ob.heldBytes;
    const bound = limits.OUTPUT_HEAD_BYTES + limits.OUTPUT_TAIL_BYTES + 64 * 1024;
    return held <= bound || 'держит ' + held + ' байт при пределе ' + bound + ' (кусок ' + big.length + ')';
  });
  // Срез начала хвоста без копии остатка (ревью E0-12AB, круг 2, C8): после большого куска каждый следующий кусок
  // копировал бы почти весь первый кусок хвоста - копии байт считаются подменой Buffer.from
  check('gates.js outputBuffer: срез начала хвоста не копирует остаток - за 16 кусков по 64 КиБ после большого куска копий не больше двух объёмов этих кусков', () => {
    const { outputBuffer, limits } = gatesModule();
    const { EventEmitter } = require('events');
    const ob = outputBuffer();
    const s = new EventEmitter();
    ob.attach(s);
    s.emit('data', Buffer.alloc(limits.OUTPUT_HEAD_BYTES + limits.OUTPUT_TAIL_BYTES + 1024 * 1024, 0x61));
    const from = Buffer.from;
    let copied = 0;
    Buffer.from = function (x) {
      if (Buffer.isBuffer(x)) copied += x.length;
      return from.apply(Buffer, arguments);
    };
    const pushed = 16 * 64 * 1024;
    try {
      for (let i = 0; i < 16; i++) s.emit('data', Buffer.alloc(64 * 1024, 0x62));
    } finally {
      Buffer.from = from;
    }
    ob.flush();
    const t = ob.text();
    const why = [];
    if (copied > 2 * pushed) why.push('скопировано ' + copied + ' байт за ' + pushed + ' байт вывода');
    if (!/b{1000}$/.test(t.replace(/\s+$/, '')) || ob.cutBytes !== 1024 * 1024 + pushed) why.push('срез ' + ob.cutBytes + ', хвост текста ' + JSON.stringify(t.slice(-20)));
    return why.length ? why.join('; ') : true;
  });
  /**
   * Строковые литералы исходника JS ('…', "…", `…`) через перевод строки - строки вывода и подсказки;
   * комментарии пропускаются (докблок использования gates.js - справка терминала, не подсказка).
   * Регэксп-литералы не разбираются: кавычка внутри регэкспа сбила бы разбор (в gates.js таких нет).
   */
  function sourceLiterals(src) {
    const s = String(src);
    const out = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '/' && s[i + 1] === '/') {
        const e = s.indexOf('\n', i);
        i = e < 0 ? s.length : e;
      } else if (c === '/' && s[i + 1] === '*') {
        const e = s.indexOf('*/', i + 2);
        i = e < 0 ? s.length : e + 2;
      } else if (c === "'" || c === '"' || c === '`') {
        let j = i + 1;
        while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
        out.push(s.slice(i, j + 1));
        i = j + 1;
      } else i++;
    }
    return out.join('\n');
  }
  /**
   * Вызовы gates.js без фона в тексте name (E0-12AB; строка TECH_DEBT 21.10.2026 T2/T4/L-014): каждый вызов -
   * node, необязательная кавычка, `$CLAUDE_PROJECT_DIR/` или `./`, .claude/hooks/gates.js (разделитель / или \) -
   * вне формы --list этого вызова (флаги вызова - до кавычки, обратной кавычки, скобки, ;, |, & или конца
   * строки) требует run_in_background: true после себя на своей строке или следующей, и между вызовом и
   * флагом нет другого вызова. Возвращает { seen, why }: вызовов без --list и отказы «файл:строка «вызов»».
   */
  const GATES_CALL = /node\s+["']?(?:\$CLAUDE_PROJECT_DIR\/|\.\/)?\.claude[\\/]hooks[\\/]gates\.js/g;
  const BACKGROUND_FLAG = 'run_in_background: true';
  function backgroundViolations(name, text) {
    const src = String(text);
    const calls = Array.from(src.matchAll(GATES_CALL), (m) => ({ at: m.index, end: m.index + m[0].length }));
    const why = [];
    let seen = 0;
    calls.forEach((c, i) => {
      const flags = /^[^`'"()\n;|&]*/.exec(src.slice(c.end))[0];
      if (/(?:^|\s)--list(?:\s|$)/.test(flags)) return;
      seen++;
      const eol = src.indexOf('\n', c.end);
      const eol2 = eol < 0 ? src.length : src.indexOf('\n', eol + 1) < 0 ? src.length : src.indexOf('\n', eol + 1);
      const next = i + 1 < calls.length ? calls[i + 1].at : src.length;
      const flag = src.indexOf(BACKGROUND_FLAG, c.end);
      if (flag < 0 || flag >= Math.min(eol2, next)) {
        why.push(name + ':' + src.slice(0, c.at).split('\n').length + ' «' + src.slice(c.at, c.at + 60).split('\n')[0].trim() + '»');
      }
    });
    return { seen, why };
  }
  check('проба фона gates.js: флаг соседнего вызова, строка с --list и вторым вызовом, вызов через ./.claude - отказ; вызов --list и вызов с флагом - пропуск', () => {
    const call = 'node .claude/hooks/gates.js';
    const refuse = [
      ['флаг соседнего вызова', '`' + call + '` - запусти\n`' + call + ' --only=lint` с `' + BACKGROUND_FLAG + '`'],
      ['--list и второй вызов на строке', '`' + call + ' --list`, затем `' + call + '`\nи жди'],
      ['вызов через ./.claude', 'прогони `node ./.claude/hooks/gates.js` и жди'],
    ];
    const pass = [
      ['вызов --list', '`' + call + ' --list` - план'],
      ['флаг на следующей строке', '`' + call + '` - инструментом Bash\nс `' + BACKGROUND_FLAG + '`'],
    ];
    const why = [];
    for (const [k, t] of refuse) if (backgroundViolations(k, t).why.length !== 1) why.push(k + ': отказов ' + backgroundViolations(k, t).why.length + ', ждали 1');
    for (const [k, t] of pass) if (backgroundViolations(k, t).why.length) why.push(k + ': отказ ' + backgroundViolations(k, t).why.join('; '));
    return why.length ? why.join('; ') : true;
  });
  // Полный прогон дольше предела foreground-вызова Bash: текст, который велит гнать gates.js (команды
  // обвязки, подсказка report-honesty.js и подсказка частичного прогона gates.js), велит гнать его в фоне,
  // иначе инструмент снимет gates.js раньше предела гейта - без имени гейта и сводки (E0-12M, C2, D5).
  // У gates.js смотрятся строковые литералы (sourceLiterals): докблок использования - справка терминала.
  check('команды, report-honesty.js и подсказки gates.js, которые велят гнать gates.js, велят гнать его в фоне (run_in_background: true после вызова, на его строке или следующей)', () => {
    const dir = path.join(CLAUDE, 'commands');
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort().map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]);
    files.push(['report-honesty.js', fs.readFileSync(path.join(HOOKS, 'report-honesty.js'), 'utf8')]);
    files.push(['gates.js (строки вывода)', sourceLiterals(fs.readFileSync(path.join(HOOKS, 'gates.js'), 'utf8'))]);
    const why = [];
    // сборщик литералов на синтетике: подсказка шаблонной строкой и строкой в двойных кавычках без флага -
    // отказ, вызов в комментарии - не подсказка, литерал с флагом - пропуск (ревью E0-12AB, T6)
    const call = 'node .claude/hooks/gates.js';
    const synth = [
      ['шаблонная строка без флага', 'console.log(`прогони ' + call + ' целиком`);', 1],
      ['двойные кавычки без флага', 'log(\n  "прогони ' + call + ' целиком");', 1],
      ['вызов в комментарии', '// ' + call + ' - справка\nconsole.log(1);', 0],
      ['литерал с флагом', "console.log('прогони " + call + ' (' + BACKGROUND_FLAG + ")');", 0],
    ];
    for (const [k, src, want] of synth) {
      const got = backgroundViolations(k, sourceLiterals(src)).why.length;
      if (got !== want) why.push('синтетика «' + k + '»: отказов ' + got + ', ждали ' + want);
    }
    let seen = 0;
    const per = [];
    for (const [name, text] of files) {
      const v = backgroundViolations(name, text);
      seen += v.seen;
      why.push(...v.why);
      if (name.startsWith('gates.js')) per.push('gates.js ' + v.seen);
    }
    if (!seen) return 'ни одна команда не гонит gates.js - проба смотрит не туда';
    if (per[0] === 'gates.js 0') why.push('в строках вывода gates.js нет вызова - подсказка частичного прогона не найдена');
    return why.length ? 'вызов без run_in_background: true после себя: ' + why.join('; ') : { note: seen + ' вызовов' };
  });

  return { gatesModule };
}

module.exports = { registerGateRunProbes };
