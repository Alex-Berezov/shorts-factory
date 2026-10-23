'use strict';
/**
 * selftest-gates-run.js - пробы запуска gates.js (E0-12U: раздел гейтов harness-selftest.js по
 * заботам): require без побочных эффектов, предел гейта (gateTimeoutSec, timeoutSec правил),
 * --only, runGate (предел, снятие дерева, вывод) и gates.js из командной строки (сводка, файлы
 * вывода, сигналы, stdin), фон вызова gates.js в командах. Не хук: модуль самопроверки.
 *
 * При require модуль только объявляет: gateRunner - тело дочернего node проб запуска (ребёнок
 * делает `require(<этот файл>).gateRunner(cfg)`, решение техлида B4 E0-12T для selftest-temp.js),
 * registerGateRunProbes(ctx) пишет строки через check из ctx в прежнем порядке и отдаёт
 * gatesModule - загрузчик gates.js для проб выбора гейтов (только после зелёной пробы require).
 */

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Дочерний процесс проб запуска гейтов (gateRunCases): `node -e` берёт функцию require этого модуля
 * (TECH_DEBT 21.10.2026 E0-12M круг 2, исходник функции строкой снят) - вместе с модулем целиком, так что
 * функция берёт cp и fs модуля, как любая другая; при require модуль ничего не исполняет. Все случаи идут параллельно: время пробы - самый
 * долгий случай, а не сумма. cfg.gates - случаи runGate ({ gate, capMs }), cfg.cli - запуски gates.js из
 * командной строки в дереве пробы ({ args, env, capMs }), cfg.watch - внуки ({ pid, hb }): внук пишет свой
 * PID в файл при старте и каждые 100 мс - отметку в файл hb. Жив ли внук после возврата, решает отметка:
 * сдвинулась за cfg.watchMs - жив. Ни зомби на POSIX (он не пишет), ни PID, доставшийся другому процессу на
 * Windows, такой ответ не подделают. Живой внук добивается здесь же по PID (только живой - иначе PID мог бы
 * быть чужим). Каждый случай ограничен capMs: зависший runGate - { hung }, а не зависшая самопроверка.
 */
function gateRunner(cfg) {
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

function registerGateRunProbes(ctx) {
  const { CLAUDE, HOOKS, ROOT, check, copyHooksTo, git, releaseTemp, repoRules, run, tempDir } = ctx;

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
      const code = 'require(' + JSON.stringify(path.join(HOOKS, 'selftest-gates-run.js')) + ').gateRunner(' + JSON.stringify(cfg) + ');';
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

  return { gatesModule };
}

module.exports = { gateRunner, registerGateRunProbes };
