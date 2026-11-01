'use strict';
/**
 * selftest-state.js - пробы процессов записи .qa-state под блокировкой .qa-state.lock (docs/adr/0016-qa-state-writes.md,
 * E0-12AE; решения техлида Р-3, Р-6, Р-7 E0-12AE и Р9 E0-12AB). Не хук: модуль самопроверки. harness-selftest.js
 * грузит его после пробы синтаксиса и зовёт registerStateProbes(ctx) в разделе проб Stop-хуков. Статические пробы
 * (запись мимо updateState, реестр писателей) - selftest-state-static.js. Писатели, которым нужен параллельный
 * запуск (блокировка занята, гонки), идут в дочернем node selftest-state-runner.js (stateRunner) одновременно.
 *
 * Пробы (каждая - отказ и пропуск, L-008):
 *   - блокировка занята (свежий .qa-state.lock): answer-length и remind-format выходят с кодом 0 и не пишут;
 *     remind-format отдаёт замечание, прочитанное без блокировки, и памятку; markGates бросает «занята»; чужая
 *     блокировка не снята;
 *   - Stop-хук упал при занятой блокировке: запасной маркер поломки записан, commit-gate отказывает по нему;
 *     маркер не записать - отказ хука называет потерю; bumpEdits отдаёт null, standards.js пишет строку в stderr;
 *   - отказ ФС на openSync 'wx' (EPERM) - «не взять … отказ файловой системы»; протухшую не снять (EACCES на
 *     rename) - «протухла, но снять … не удалось», а не «держит другой писатель»;
 *   - проход без изменения блокировку не берёт и файл не пишет; удачный проход Stop-хука снимает маркер;
 *   - протухшая блокировка при пределе ожидания 0; пределы stateLockLimits вне диапазона - константы;
 *   - гонка Р9 (L-014), гонка двух за протухшую, finally владельца, чью блокировку сочли протухшей;
 *   - блокировку увели посреди записи - держатель не пишет, отказ снятия - строка в stderr; возврат на место не
 *     удался - отодвинутая блокировка остаётся; STATE_LOCK_FREE_RETRIES - единственная преграда петле; EBUSY на
 *     чтении своего токена - своя блокировка снимается; писатель без предиката читает состояние один раз;
 *   - commit-gate: сбой чтения каталога состояния (маркеры) - отказ, а не пропуск; маркер .broken-constructor -
 *     отказ (собственные ключи);
 *   - решение техлида Р-8: имя хука вне [a-z0-9-] и без имени - ничего не пишется, потеря названа; отказ снять
 *     отметку на удачном проходе - строка в stderr; EEXIST, затем отказ ФС - текст по последней ошибке; разовый
 *     EBUSY на stat протухшей и отодвинутой - повтор; проход без изменения не создаёт каталог состояния;
 *   - /qa (команда qa.md §6): отказ записи - ненулевой код и «отметка /qa не поставлена»; запись - отпечаток,
 *     edits = 0, strayFiles = [].
 * Ожидания - по файлам-сигналам, не по таймеру (L-016, L-029); пределы блокировки детям проб задаёт
 * предзагрузка (L.stateLockLimits), а не часы машины (ревью E0-12AE, круг 1, Б11). Имена путей предзагрузка
 * берёт у lib.js (statePath, stateLockPath, stateTmpPath, asidePath, hookMarkerPath), а не строит сама.
 */

const fs = require('fs');
const path = require('path');
const L = require('./lib.js');
const { RESULT_PREFIX, CASE_CAP_MS } = require('./selftest-state-runner.js');

/** Ответ, который answer-length считает простынёй: 60 непустых строк. */
const STATE_LONG_ANSWER = Array.from({ length: 60 }, (_, i) => 'Строка ответа ' + i).join('\n');
/** Замечание сессии S1 в стартовом состоянии проб записи. */
const STATE_NOTE_S1 = 'Прошлый ответ вышел длиннее порога: проба selftest-state.\n';
/** Стартовое состояние проб записи: отметки-часовые, которые писатель не должен потерять. */
const STATE_SEED = {
  edits: 3,
  strayFiles: [],
  lastQa: { sentinel: 'selftest-state' },
  lastGates: { hash: 'seed-green', files: ['sf/b.txt'], code: 0, at: '2000-01-01T00:00:00.000Z' },
  lengthNotes: { S1: { text: STATE_NOTE_S1, at: 1 } },
};
/** Начало памятки формата remind-format (REMINDER): выдаётся и при занятой блокировке. */
const REMINDER_HEAD = 'Формат ответа держи такой';
/** Имя Stop-хука проб: его отметка о поломке и маркер. */
const PROBE_HOOK = 'probe-hook';
/** Чужой токен в блокировке пробы «блокировку увели». */
const FOREIGN_LOCK = 'foreign-token 2000-01-01T00:00:00.000Z\n';
/** Предел попыток openSync в пробе STATE_LOCK_FREE_RETRIES: без предела петля упирается в него и выходит. */
const WX_CAP = 50;

function registerStateProbes(ctx) {
  const { HOOKS, CLAUDE, ROOT, LIVE_STATE, check, run, tempDir, put, releaseTemp, mkTranscript } = ctx;
  const reqOf = (file) => 'require(' + JSON.stringify(path.join(HOOKS, file)) + ')';
  const envOf = (dir) => ({ SF_HOOK_STATE_DIR: dir });
  const stateIn = (dir) => L.statePath(envOf(dir));
  const lockIn = (dir) => L.stateLockPath(envOf(dir));
  const markerIn = (dir) => L.hookMarkerPath(PROBE_HOOK, envOf(dir));
  const asidesIn = (dir) => {
    const lock = lockIn(dir);
    const [head, tail] = L.asidePath(lock, '\u0000').split('\u0000');
    return fs.readdirSync(dir).map((n) => path.join(dir, n)).filter((p) => p.startsWith(head) && p.endsWith(tail));
  };
  const seedDir = (dir, extra) => fs.writeFileSync(stateIn(dir), JSON.stringify(Object.assign({}, STATE_SEED, extra || {}), null, 2));
  const hookInput = (sessionId, transcript) => JSON.stringify({ session_id: sessionId, transcript_path: transcript });
  const hookArgs = (pre, file) => (pre ? ['-r', pre] : []).concat([path.join(HOOKS, file)]);
  const evalArgs = (pre, program) => (pre ? ['-r', pre] : []).concat(['-e', 'const L = ' + reqOf('lib.js') + '; const H = ' + reqOf('diff-hash.js') + '; ' + program]);
  const MARK_RED = "H.markGates(1, ['sf/x']);";
  const guardBoom = (nameField) => "L.guard(() => { throw new Error('probe boom'); }, { failClosed: true, stop: true" + nameField + ' });';
  const GUARD_BOOM = guardBoom(", name: '" + PROBE_HOOK + "'");
  const GUARD_OK = "L.guard(() => true, { stop: true, name: '" + PROBE_HOOK + "' });";
  // писатель, у которого блокировку увели посреди read-modify-write: mutate (под блокировкой) кладёт в неё чужой токен
  const STOLEN = "const fs = require('fs'); const f = L.updateState((s) => { fs.writeFileSync(L.stateLockPath(), " + JSON.stringify(FOREIGN_LOCK) + "); s.lastGates = { code: 1, files: ['sf/x'] }; return true; }); process.stdout.write(f ? f.message : 'null');";
  const COMMIT_INPUT = JSON.stringify({ tool_input: { command: 'git commit -m "feat: x"' } });

  /**
   * Предзагрузка (node -r) ребёнка пробы - файл в dir по opts. Пути - из lib.js ребёнка (его SF_HOOK_STATE_DIR):
   *   limits { waitMs, staleMs } - L.stateLockLimits ребёнка (проба не держится на часах машины, Б11);
   *   limitsThrow - чтение L.stateLockLimits.waitMs бросает (сбой внутри takeStateLock);
   *   wxLog - файл: каждая попытка openSync(<блокировка>, 'wx') дописывает строку;
   *   wxFail - код: такая попытка бросает его (отказ ФС, а не занятость);
   *   wxFailAfter { n, code } - первые n таких попыток настоящие (EEXIST чужой блокировки), дальше - code;
   *   statBusy - первый stat блокировки и первый stat отодвинутой - EBUSY (антивирус), дальше настоящие;
   *   wxBusy - каждая такая попытка - EEXIST, а stat блокировки - ENOENT («снята между open и stat»); после
   *     WX_CAP попыток - EINVAL (петля без предела выходит);
   *   hold { taken, go } - пауза посреди read-modify-write, под блокировкой: перед записью временного файла
   *     writeState - файл taken, затем ждать go;
   *   statPause { sig, release } - первый stat блокировки: файл sig, ждать release;
   *   tried, blocked - файлы: попытка взять блокировку (после release, если есть statPause) и её отказ EEXIST;
   *   wrote - файл: rename временного файла в .qa-state (запись состоялась);
   *   renameFail - код: rename блокировки (снятие) бросает его;
   *   linkFail - код: linkSync (возврат отодвинутой блокировки) бросает его;
   *   tokenBusy - первое чтение отодвинутой блокировки (токен) - EBUSY;
   *   readLog - файл: каждое чтение .qa-state дописывает строку;
   *   markerFail - запись маркера поломки PROBE_HOOK - EACCES;
   *   readdirFail - чтение каталога состояния - EACCES.
   * Файлы-сигналы пишет исходный fs.writeFileSync (до подмены).
   */
  const preload = (dir, name, opts) => {
    const q = JSON.stringify;
    const lines = [
      "const fs = require('fs');",
      "const path = require('path');",
      'const L = ' + reqOf('lib.js') + ';',
      'const w = fs.writeFileSync;',
      'const stateP = L.statePath();',
      'const lockP = L.stateLockPath();',
      "const [asideHead, asideTail] = L.asidePath(lockP, '\\u0000').split('\\u0000');",
      'const isLock = (p) => String(p) === lockP;',
      'const isAside = (p) => String(p).startsWith(asideHead) && String(p).endsWith(asideTail);',
      'const fail = (code) => Object.assign(new Error(code + " (проба)"), { code });',
      'const waitFor = (f) => { const from = Date.now(); while (!fs.existsSync(f) && Date.now() - from < ' + CASE_CAP_MS + ') L.pauseSync(5); };',
    ];
    if (opts.limits) lines.push('Object.assign(L.stateLockLimits, ' + q(opts.limits) + ');');
    if (opts.limitsThrow) lines.push("Object.defineProperty(L.stateLockLimits, 'waitMs', { get() { throw new Error('limits boom (проба)'); } });");
    if (opts.statPause || opts.wxBusy || opts.statBusy) {
      lines.push(
        'let released = ' + (opts.statPause ? 'false' : 'true') + ';',
        'let paused = false;',
        'let lockStats = 0;',
        'let asideStats = 0;',
        'const statSync = fs.statSync;',
        'fs.statSync = function (p) {',
        opts.wxBusy ? "  if (isLock(p)) throw fail('ENOENT');" : '',
        opts.statBusy ? "  if (isLock(p) && lockStats++ === 0) throw fail('EBUSY');" : '',
        opts.statBusy ? "  if (isAside(p) && asideStats++ === 0) throw fail('EBUSY');" : '',
        '  const r = statSync.apply(fs, arguments);',
        opts.statPause ? '  if (!paused && isLock(p)) { paused = true; w(' + q(opts.statPause.sig) + ", '1'); waitFor(" + q(opts.statPause.release) + '); released = true; }' : '',
        '  return r;',
        '};',
      );
    } else lines.push('const released = true;');
    lines.push(
      'let wxCount = 0;',
      'const openSync = fs.openSync;',
      'fs.openSync = function (p, flags) {',
      "  if (!isLock(p) || flags !== 'wx') return openSync.apply(fs, arguments);",
      opts.wxLog ? '  fs.appendFileSync(' + q(opts.wxLog) + ", 'wx\\n');" : '',
      opts.wxFail ? '  throw fail(' + q(opts.wxFail) + ');' : '',
      opts.wxFailAfter ? '  if (++wxCount > ' + opts.wxFailAfter.n + ') throw fail(' + q(opts.wxFailAfter.code) + ');' : '',
      opts.wxBusy ? "  if (++wxCount > " + WX_CAP + ") throw fail('EINVAL'); throw fail('EEXIST');" : '',
      opts.tried ? '  if (released) w(' + q(opts.tried) + ", '1');" : '',
      '  try { return openSync.apply(fs, arguments); } catch (e) {',
      opts.blocked ? "    if (released && e.code === 'EEXIST') w(" + q(opts.blocked) + ", '1');" : '',
      '    throw e;',
      '  }',
      '};',
    );
    if (opts.hold) {
      lines.push(
        'let held = false;',
        'fs.writeFileSync = function (p) {',
        '  if (!held && String(p) === L.stateTmpPath()) { held = true; w(' + q(opts.hold.taken) + ", '1'); waitFor(" + q(opts.hold.go) + '); }',
        '  return w.apply(fs, arguments);',
        '};',
      );
    }
    if (opts.markerFail) {
      lines.push(
        'fs.writeFileSync = function (p) {',
        "  if (String(p) === L.hookMarkerPath(" + q(PROBE_HOOK) + ")) throw fail('EACCES');",
        '  return w.apply(fs, arguments);',
        '};',
      );
    }
    if (opts.wrote || opts.renameFail) {
      lines.push(
        'const renameSync = fs.renameSync;',
        'fs.renameSync = function (a, b) {',
        opts.renameFail ? '  if (isLock(a)) throw fail(' + q(opts.renameFail) + ');' : '',
        '  const r = renameSync.apply(fs, arguments);',
        opts.wrote ? '  if (String(b) === stateP) w(' + q(opts.wrote) + ", '1');" : '',
        '  return r;',
        '};',
      );
    }
    if (opts.linkFail) lines.push('fs.linkSync = function () { throw fail(' + q(opts.linkFail) + '); };');
    if (opts.tokenBusy || opts.readLog) {
      lines.push(
        'let tokenReads = 0;',
        'const readFileSync = fs.readFileSync;',
        'fs.readFileSync = function (p) {',
        opts.tokenBusy ? "  if (isAside(p) && tokenReads++ === 0) throw fail('EBUSY');" : '',
        opts.readLog ? '  if (String(p) === stateP) fs.appendFileSync(' + q(opts.readLog) + ", 'read\\n');" : '',
        '  return readFileSync.apply(fs, arguments);',
        '};',
      );
    }
    if (opts.readdirFail) {
      lines.push(
        'const readdirSync = fs.readdirSync;',
        'fs.readdirSync = function (p) {',
        "  if (String(p) === path.dirname(stateP)) throw fail('EACCES');",
        '  return readdirSync.apply(fs, arguments);',
        '};',
      );
    }
    return put(dir, 'pre-' + name + '.js', lines.filter(Boolean).join('\n') + '\n');
  };

  /**
   * Дочерний процесс stateRunner (selftest-state-runner.js): писатели при занятой блокировке, отказе ФС и без
   * изменения - одновременно, гонки - сценариями по файлам-сигналам. Результат и ошибка запоминаются: строки
   * одного прогона не гоняют его заново.
   */
  let runnerResult = null;
  function runnerCases() {
    if (!runnerResult) {
      try {
        runnerResult = { value: buildRunnerCases() };
      } catch (e) {
        runnerResult = { error: e };
      }
    }
    if (runnerResult.error) throw runnerResult.error;
    return runnerResult.value;
  }
  function buildRunnerCases() {
    const dir = tempDir('state-run');
    try {
      const sub = (name, seed, extra) => {
        const d = path.join(dir, name);
        fs.mkdirSync(d);
        if (seed) seedDir(d, extra);
        return d;
      };
      const sig = (name) => path.join(dir, 'sig-' + name);
      const ago = (p, ms) => {
        const t = (Date.now() - ms) / 1000;
        fs.utimesSync(p, t, t);
      };
      const longT = put(dir, 'long.jsonl', mkTranscript(STATE_LONG_ANSWER, 1));
      // шесть ходов пользователя: remind-format выдаёт памятку формата (MIN_TURNS)
      const longT6 = put(dir, 'long6.jsonl', mkTranscript(STATE_LONG_ANSWER, 6));
      const shortT = put(dir, 'short.jsonl', mkTranscript('Коротко.', 1));
      // блокировка занята: свежий .qa-state.lock чужого процесса; протухнуть за прогон он не может (staleMs - час)
      const busy = sub('busy', true);
      fs.writeFileSync(lockIn(busy), 'чужая блокировка (проба)\n');
      const busyLimits = { waitMs: 200, staleMs: 3600000 };
      const busyPre = preload(dir, 'busy', { limits: busyLimits });
      const busyNoMarkerPre = preload(dir, 'busy-nomarker', { limits: busyLimits, markerFail: true });
      // маркер поломки и замок коммита: Stop-хук падает при занятой блокировке, затем commit-gate
      const marker = sub('marker', true);
      fs.writeFileSync(lockIn(marker), 'чужая блокировка (проба)\n');
      // имя Stop-хука вне [a-z0-9-] и без имени: ничего не пишется, потеря названа (решение техлида Р-8)
      const badName = sub('bad-name', true);
      // отказ снять отметку о поломке на удачном проходе (блокировка занята): строка в stderr, не отказ (Р-8)
      const heal = sub('heal', true, { brokenHooks: { [PROBE_HOOK]: { at: '2000-01-01T00:00:00.000Z', detail: 'probe boom' } } });
      fs.writeFileSync(lockIn(heal), 'чужая блокировка (проба)\n');
      // маркер с именем свойства прототипа: замок коммита видит и его (hasOwnProperty, ревью круг 3)
      const proto = sub('proto', true);
      fs.writeFileSync(L.hookMarkerPath('constructor', envOf(proto)), JSON.stringify({ detail: 'probe proto' }) + '\n');
      // проход без изменения в каталоге состояния, которого нет: каталог не создаётся (CR3-6)
      const absent = path.join(dir, 'absent');
      // EEXIST чужой свежей блокировки, затем отказ ФС до конца предела: текст - по последней ошибке (CR3-7)
      const flip = sub('flip', true);
      fs.writeFileSync(lockIn(flip), 'чужая блокировка (проба)\n');
      const flipPre = preload(dir, 'flip', { limits: { waitMs: 100, staleMs: 3600000 }, wxFailAfter: { n: 1, code: 'EPERM' } });
      // разовый EBUSY на stat протухшей и отодвинутой блокировки при пределе ожидания 0: retrySync, а не ожидание
      const statBusy = sub('stat-busy', true);
      fs.writeFileSync(lockIn(statBusy), 'оставил упавший процесс (проба)\n');
      ago(lockIn(statBusy), 2 * 3600 * 1000);
      const statBusyPre = preload(dir, 'stat-busy', { limits: { waitMs: 0, staleMs: 3600000 }, statBusy: true });
      // замок коммита не прочитал каталог состояния - отказ
      const rdfail = sub('rdfail', true);
      const rdfailPre = preload(dir, 'rdfail', { readdirFail: true });
      // отказ ФС на openSync 'wx' - не занятость
      const eperm = sub('eperm', true);
      const epermPre = preload(dir, 'eperm', { limits: { waitMs: 100 }, wxFail: 'EPERM' });
      // протухшую не снять: rename блокировки - EACCES весь предел
      const stuck = sub('stuck', true);
      fs.writeFileSync(lockIn(stuck), 'оставил упавший процесс (проба)\n');
      ago(lockIn(stuck), 2 * 3600 * 1000);
      const stuckPre = preload(dir, 'stuck', { limits: { waitMs: 100, staleMs: 3600000 }, renameFail: 'EACCES' });
      // пределы вне диапазона: staleMs -1 сделал бы свежую чужую блокировку протухшей, waitMs -5 - отказом сразу
      const limits = sub('limits', true);
      fs.writeFileSync(lockIn(limits), 'чужая блокировка (проба)\n');
      const limitsPre = preload(dir, 'limits', { limits: { waitMs: -5, staleMs: -1 } });
      // сбой внутри takeStateLock: updateState не бросает, а отдаёт ошибку
      const limitsThrow = sub('limits-throw', true);
      const limitsThrowPre = preload(dir, 'limits-throw', { limitsThrow: true });
      // блокировку увели посреди записи; второй - возврат отодвинутой на место не удался
      const stolen = sub('stolen', true);
      const linkFail = sub('link-fail', true);
      const linkFailPre = preload(dir, 'link-fail', { linkFail: 'EEXIST' });
      // STATE_LOCK_FREE_RETRIES: блокировка каждый раз «снята между open и stat»
      const freeRuns = sub('free-runs', true);
      const freeLog = path.join(dir, 'wx-free.log');
      const freePre = preload(dir, 'free', { limits: { waitMs: 0 }, wxBusy: true, wxLog: freeLog });
      // EBUSY на чтении своего токена при снятии
      const tokenBusy = sub('token-busy', true);
      const tokenBusyPre = preload(dir, 'token-busy', { tokenBusy: true });
      // писатель без предиката: чтения .qa-state
      const once = sub('once', true);
      const onceLog = path.join(dir, 'read-once.log');
      const oncePre = preload(dir, 'once', { readLog: onceLog });
      // проход без изменения: попытки взять блокировку - в свой журнал на писателя; маркер поломки снимается
      const idle = sub('idle', true);
      fs.writeFileSync(markerIn(idle), JSON.stringify({ detail: 'probe boom' }) + '\n');
      const idleLog = (k) => path.join(dir, 'wx-idle-' + k + '.log');
      const idlePre = (k) => preload(dir, 'idle-' + k, { wxLog: idleLog(k) });
      // гонка Р9: answer-length S2 держит блокировку перед записью; markGates, noteHookHealth, bumpEdits пишут
      const race = sub('race', true);
      const racePre = {
        holder: preload(dir, 'race-holder', { hold: { taken: sig('race-taken'), go: sig('race-go') } }),
      };
      const raceWriters = { mark: MARK_RED, health: GUARD_BOOM, edits: 'process.stdout.write(JSON.stringify(L.bumpEdits(2)));' };
      for (const k of Object.keys(raceWriters)) {
        racePre[k] = preload(dir, 'race-' + k, { limits: { waitMs: CASE_CAP_MS, staleMs: CASE_CAP_MS * 10 }, tried: sig('race-tried-' + k), wrote: sig('race-wrote-' + k) });
      }
      // гонка двух за протухшую: блокировка двухчасовой давности; B видит её протухшей и ждёт, пока A снимет её,
      // возьмёт свою и встанет посреди записи; потом B пробует снять «протухшую» - уже свежую блокировку A
      const staleRace = sub('stale-race', true);
      fs.writeFileSync(lockIn(staleRace), 'оставил упавший процесс (проба)\n');
      ago(lockIn(staleRace), 2 * 3600 * 1000);
      const staleA = preload(dir, 'stale-a', { hold: { taken: sig('stale-a-holds'), go: sig('stale-go') } });
      const staleB = preload(dir, 'stale-b', { limits: { waitMs: CASE_CAP_MS, staleMs: 1800000 }, statPause: { sig: sig('stale-b-saw'), release: sig('stale-a-holds') }, blocked: sig('stale-b-blocked'), wrote: sig('stale-b-wrote') });
      // finally владельца: B считает свежую блокировку A протухшей (staleMs 0), берёт её и встаёт посреди записи;
      // A дописывает и снимает в finally - не чужую блокировку B
      const takeover = sub('takeover', true);
      const takeA = preload(dir, 'take-a', { hold: { taken: sig('take-a-holds'), go: sig('take-go') } });
      const takeB = preload(dir, 'take-b', { limits: { waitMs: CASE_CAP_MS, staleMs: 0 }, hold: { taken: sig('take-b-in'), go: sig('take-b-go') } });

      const before = {};
      for (const [k, d] of Object.entries({ busy, idle, stolen, linkFail, limits, badName, heal, flip })) before[k] = fs.readFileSync(stateIn(d), 'utf8');
      const cfg = {
        liveState: LIVE_STATE,
        cwd: ROOT,
        parallel: [
          { key: 'busyAnswer', args: hookArgs(busyPre, 'answer-length.js'), env: envOf(busy), input: hookInput('S9', longT) },
          { key: 'busyRemind', args: hookArgs(busyPre, 'remind-format.js'), env: envOf(busy), input: hookInput('S1', longT6) },
          { key: 'busyMark', args: evalArgs(busyPre, MARK_RED), env: envOf(busy) },
          { key: 'busyGuard', args: evalArgs(busyPre, GUARD_BOOM), env: envOf(busy) },
          { key: 'busyNoMarker', args: evalArgs(busyNoMarkerPre, GUARD_BOOM), env: envOf(busy) },
          { key: 'busyEdits', args: evalArgs(busyPre, 'process.stdout.write(JSON.stringify(L.bumpEdits(1)));'), env: envOf(busy) },
          { key: 'busyStandards', args: hookArgs(busyPre, 'standards.js'), env: envOf(busy), input: '{}' },
          { key: 'badNameGuard', args: evalArgs(null, guardBoom(", name: 'Bad Name'")), env: envOf(badName) },
          { key: 'noNameGuard', args: evalArgs(null, guardBoom('')), env: envOf(badName) },
          { key: 'healGuard', args: evalArgs(busyPre, GUARD_OK), env: envOf(heal) },
          { key: 'protoCommit', args: hookArgs(null, 'commit-gate.js'), env: envOf(proto), input: COMMIT_INPUT },
          { key: 'absentHealth', args: evalArgs(null, GUARD_OK), env: envOf(absent) },
          { key: 'flipMark', args: evalArgs(flipPre, MARK_RED), env: envOf(flip) },
          { key: 'statBusyMark', args: evalArgs(statBusyPre, MARK_RED), env: envOf(statBusy) },
          { key: 'rdfailCommit', args: hookArgs(rdfailPre, 'commit-gate.js'), env: envOf(rdfail), input: COMMIT_INPUT },
          { key: 'epermMark', args: evalArgs(epermPre, MARK_RED), env: envOf(eperm) },
          { key: 'stuckMark', args: evalArgs(stuckPre, MARK_RED), env: envOf(stuck) },
          { key: 'limitsMark', args: evalArgs(limitsPre, MARK_RED), env: envOf(limits) },
          { key: 'throwEdits', args: evalArgs(limitsThrowPre, 'process.stdout.write(JSON.stringify(L.bumpEdits(1)));'), env: envOf(limitsThrow) },
          { key: 'throwMark', args: evalArgs(limitsThrowPre, MARK_RED), env: envOf(limitsThrow) },
          { key: 'stolen', args: evalArgs(null, STOLEN), env: envOf(stolen) },
          { key: 'linkFail', args: evalArgs(linkFailPre, STOLEN), env: envOf(linkFail) },
          { key: 'freeMark', args: evalArgs(freePre, MARK_RED), env: envOf(freeRuns) },
          { key: 'tokenBusyMark', args: evalArgs(tokenBusyPre, MARK_RED), env: envOf(tokenBusy) },
          { key: 'onceEdits', args: evalArgs(oncePre, 'process.stdout.write(JSON.stringify(L.bumpEdits(1)));'), env: envOf(once) },
          { key: 'idleAnswer', args: hookArgs(idlePre('answer'), 'answer-length.js'), env: envOf(idle), input: hookInput('S8', shortT) },
          { key: 'idleRemind', args: hookArgs(idlePre('remind'), 'remind-format.js'), env: envOf(idle), input: hookInput('S8', shortT) },
          { key: 'idleHealth', args: evalArgs(idlePre('health'), GUARD_OK), env: envOf(idle) },
        ],
        scenarios: [
          {
            key: 'marker',
            children: {
              guard: { args: evalArgs(busyPre, GUARD_BOOM), env: envOf(marker) },
              commit: { args: hookArgs(null, 'commit-gate.js'), env: envOf(marker), input: COMMIT_INPUT },
            },
            steps: [{ start: 'guard' }, { join: 'guard' }, { exists: markerIn(marker), as: 'marker' }, { start: 'commit' }, { join: 'commit' }],
          },
          {
            key: 'race',
            children: Object.assign(
              { holder: { args: hookArgs(racePre.holder, 'answer-length.js'), env: envOf(race), input: hookInput('S2', longT) } },
              ...Object.keys(raceWriters).map((k) => ({ [k]: { args: evalArgs(racePre[k], raceWriters[k]), env: envOf(race) } })),
            ),
            steps: [{ start: 'holder' }, { wait: [sig('race-taken')], as: 'taken' }]
              .concat(Object.keys(raceWriters).map((k) => ({ start: k })))
              .concat(Object.keys(raceWriters).map((k) => ({ wait: [sig('race-tried-' + k), sig('race-wrote-' + k)], as: k })))
              .concat([{ write: sig('race-go') }]),
          },
          {
            key: 'staleRace',
            children: {
              a: { args: hookArgs(staleA, 'answer-length.js'), env: envOf(staleRace), input: hookInput('S2', longT) },
              b: { args: evalArgs(staleB, MARK_RED), env: envOf(staleRace) },
            },
            steps: [
              { start: 'b' },
              { wait: [sig('stale-b-saw')], as: 'bSaw' },
              { start: 'a' },
              { wait: [sig('stale-a-holds')], as: 'aHolds' },
              { wait: [sig('stale-b-blocked'), sig('stale-b-wrote')], as: 'b' },
              { write: sig('stale-go') },
            ],
          },
          {
            key: 'takeover',
            children: {
              a: { args: hookArgs(takeA, 'answer-length.js'), env: envOf(takeover), input: hookInput('S2', longT) },
              b: { args: evalArgs(takeB, MARK_RED), env: envOf(takeover) },
            },
            steps: [
              { start: 'a' },
              { wait: [sig('take-a-holds')], as: 'aHolds' },
              { start: 'b' },
              { wait: [sig('take-b-in')], as: 'bIn' },
              { write: sig('take-go') },
              { join: 'a' },
              { exists: lockIn(takeover), as: 'lockAfterA' },
              { write: sig('take-b-go') },
              { join: 'b' },
            ],
          },
        ],
      };
      const cfgFile = put(dir, 'state-runner.json', JSON.stringify(cfg));
      const code = reqOf('selftest-state-runner.js') + '.stateRunner(JSON.parse(require("fs").readFileSync(' + JSON.stringify(cfgFile) + ', "utf8")));';
      const r = run(process.execPath, ['-e', code], {
        cwd: ROOT,
        timeout: CASE_CAP_MS * 4,
        killSignal: 'SIGKILL',
        env: Object.assign({}, process.env, envOf(race)),
      });
      const at = String(r.stdout || '').lastIndexOf(RESULT_PREFIX);
      if (at === -1) throw new Error('дочерний процесс проб записи состояния не дошёл до итога (код ' + r.status + '): ' + String(r.stderr || r.stdout || (r.error && r.error.message)).slice(0, 300));
      const res = JSON.parse(String(r.stdout).slice(at + RESULT_PREFIX.length));
      const readJsonOf = (d) => JSON.parse(fs.readFileSync(stateIn(d), 'utf8'));
      const textOf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
      res.before = before;
      res.after = {};
      for (const [k, d] of Object.entries({ busy, idle, stolen, linkFail, limits, badName, heal, flip })) res.after[k] = fs.readFileSync(stateIn(d), 'utf8');
      res.busyLock = textOf(lockIn(busy));
      res.busyMarker = textOf(markerIn(busy));
      res.limitsLock = textOf(lockIn(limits));
      res.epermAfter = readJsonOf(eperm);
      res.stuckLock = textOf(lockIn(stuck));
      res.stolenLock = textOf(lockIn(stolen));
      res.linkFailLock = textOf(lockIn(linkFail));
      res.linkFailAsides = asidesIn(linkFail).map((p) => fs.readFileSync(p, 'utf8'));
      res.linkFailNames = fs.readdirSync(linkFail).filter((n) => n !== path.basename(stateIn(linkFail)) && n !== path.basename(lockIn(linkFail))).sort();
      res.badNameFiles = fs.readdirSync(badName).sort();
      res.healLock = textOf(lockIn(heal));
      res.absentDir = fs.existsSync(absent);
      res.flipLock = textOf(lockIn(flip));
      res.statBusyLock = fs.existsSync(lockIn(statBusy));
      res.statBusyAsides = asidesIn(statBusy).length;
      res.statBusyState = readJsonOf(statBusy);
      res.freeTries = (textOf(freeLog) || '').split('\n').filter(Boolean).length;
      res.tokenBusyLock = fs.existsSync(lockIn(tokenBusy));
      res.tokenBusyAsides = asidesIn(tokenBusy).length;
      res.tokenBusyState = readJsonOf(tokenBusy);
      res.onceReads = (textOf(onceLog) || '').split('\n').filter(Boolean).length;
      res.idleWx = ['answer', 'remind', 'health'].filter((k) => fs.existsSync(idleLog(k)));
      res.idleMarker = fs.existsSync(markerIn(idle));
      res.raceState = readJsonOf(race);
      res.raceLock = fs.existsSync(lockIn(race));
      res.raceMarker = fs.existsSync(markerIn(race));
      res.staleState = readJsonOf(staleRace);
      res.staleLock = fs.existsSync(lockIn(staleRace));
      res.takeLock = fs.existsSync(lockIn(takeover));
      return res;
    } finally {
      releaseTemp(dir);
    }
  }
  const seen = (x) => (x ? 'код ' + x.code + (x.signal ? ' (' + x.signal + ')' : '') + ', stdout ' + JSON.stringify(String(x.out).slice(-160)) + ', stderr ' + JSON.stringify(String(x.err).slice(-240)) : 'не запускался');
  const redX = (g) => Boolean(g && g.code === 1 && JSON.stringify(g.files) === JSON.stringify(['sf/x']));
  const noteOf = (st, sid) => Boolean(st.lengthNotes && st.lengthNotes[sid] && /непустых строк/.test(st.lengthNotes[sid].text));

  check('updateState: блокировка .qa-state.lock занята (свежая) - answer-length и remind-format выходят с кодом 0 и не пишут (.qa-state байт в байт прежний), remind-format отдаёт замечание, прочитанное без блокировки (оно остаётся в состоянии), и памятку формата; markGates бросает «запись .qa-state не удалась … занята», чужая блокировка не снята', () => {
    const all = runnerCases();
    const p = all.parallel;
    const why = [];
    if (!p.busyAnswer || p.busyAnswer.code !== 0) why.push('answer-length: ' + seen(p.busyAnswer));
    if (!p.busyRemind || p.busyRemind.code !== 0) why.push('remind-format: ' + seen(p.busyRemind));
    else {
      if (!p.busyRemind.out.includes(STATE_NOTE_S1)) why.push('remind-format не отдал замечание при занятой блокировке - следующий короткий ответ стёр бы его невыданным: ' + seen(p.busyRemind));
      if (!p.busyRemind.out.includes(REMINDER_HEAD)) why.push('remind-format не выдал памятку формата при занятой блокировке (шесть ходов): ' + seen(p.busyRemind));
    }
    if (!p.busyMark || p.busyMark.code === 0 || !/запись \.qa-state не удалась: блокировка [^\n]*занята дольше 200 мс - её держит другой писатель/.test(p.busyMark.err)) why.push('markGates не бросил отказ блокировки: ' + seen(p.busyMark));
    if (all.after.busy !== all.before.busy) why.push('.qa-state изменён при занятой блокировке: ' + JSON.stringify(all.after.busy.slice(0, 200)));
    if (all.busyLock !== 'чужая блокировка (проба)\n') why.push('чужая блокировка снята или переписана: ' + JSON.stringify(all.busyLock));
    return why.length ? why.join('; ') : true;
  });

  check('noteHookHealth: Stop-хук упал при занятой блокировке - запасной маркер поломки записан (решение техлида Р-6), отказ хука потерю не называет, commit-gate отказывает по маркеру; маркер не записать - отказ хука говорит «ни в .qa-state, ни маркером … замок коммита о ней не узнает»', () => {
    const all = runnerCases();
    const p = all.parallel;
    const sc = all.scenarios.marker;
    const why = [];
    const g = p.busyGuard;
    if (!g || g.code !== 2 || !/probe boom/.test(g.err)) why.push('guard stop: ' + seen(g));
    else if (/не записана/.test(g.err)) why.push('отметка о поломке названа потерянной, а маркер есть: ' + seen(g));
    if (!all.busyMarker || !/probe boom/.test(all.busyMarker)) why.push('маркер поломки не записан при занятой блокировке: ' + JSON.stringify(all.busyMarker));
    const n = p.busyNoMarker;
    if (!n || n.code !== 2 || !/Отметка о поломке не записана ни в \.qa-state, ни маркером \(блокировка [^\n]*занята дольше[^\n]*маркер [^\n]*не записан: EACCES\): замок коммита о ней не узнает\./.test(n.err)) why.push('потеря отметки не названа (маркер не записать): ' + seen(n));
    else if (/не коммить, пока хук не починен/.test(n.err)) why.push('прежний текст «не коммить, пока хук не починен»: ' + seen(n));
    if (sc.exists.marker !== true) why.push('маркер сценария замка коммита не записан: ' + seen(sc.children.guard));
    const c = sc.children.commit;
    if (!c || !/проверка «probe-hook» упала на последней сдаче: [^"]*probe boom/.test(c.out)) why.push('commit-gate не отказал по маркеру: ' + seen(c));
    return why.length ? why.join('; ') : true;
  });

  check('hookMarkerPath: имя Stop-хука вне [a-z0-9-] и без имени - исключение, а не общий маркер stop-hook (решение техлида Р-8); guard упавшего хука с таким именем ничего не пишет (.qa-state байт в байт прежний, маркеров нет) и в отказе говорит «не записана ни в .qa-state, ни маркером (имя …): замок коммита о ней не узнает»; имя из [a-z0-9-] - путь <statePath>.broken-<имя>', () => {
    const all = runnerCases();
    const p = all.parallel;
    const why = [];
    const env = envOf(ROOT);
    for (const bad of ['Bad Name', 'stop_hook', '../x', '', undefined, 7]) {
      let got;
      try {
        got = 'путь ' + L.hookMarkerPath(bad, env);
      } catch (e) {
        got = /не из \[a-z0-9-\] - маркер поломки не построить/.test(e.message) ? null : 'иное исключение: ' + e.message;
      }
      if (got !== null) why.push('имя ' + JSON.stringify(bad) + ': ' + got);
    }
    if (L.hookMarkerPath(PROBE_HOOK, env) !== L.statePath(env) + '.broken-' + PROBE_HOOK) why.push('путь маркера имени из [a-z0-9-]: ' + L.hookMarkerPath(PROBE_HOOK, env));
    const lostRe = /Отметка о поломке не записана ни в \.qa-state, ни маркером \(имя Stop-хука [^\n]* не из \[a-z0-9-\] - маркер поломки не построить\): замок коммита о ней не узнает\./;
    for (const k of ['badNameGuard', 'noNameGuard']) {
      const x = p[k];
      if (!x || x.code !== 2 || !/probe boom/.test(x.err) || !lostRe.test(x.err)) why.push(k + ': потеря отметки не названа - ' + seen(x));
    }
    if (all.after.badName !== all.before.badName) why.push('.qa-state изменён отметкой с недопустимым именем: ' + JSON.stringify(all.after.badName.slice(0, 200)));
    if (JSON.stringify(all.badNameFiles) !== JSON.stringify([path.basename(stateIn(ROOT))])) why.push('в каталоге состояния лишние файлы (маркер?): ' + JSON.stringify(all.badNameFiles));
    return why.length ? why.join('; ') : true;
  });

  check('guard: удачный проход Stop-хука, снять отметку о поломке не удалось (блокировка занята) - код 0, одна строка в stderr «отметку о поломке не снять (…занята…) - замок коммита отказывает по ней до следующего удачного прохода», отметка и чужая блокировка на месте (решение техлида Р-8)', () => {
    const all = runnerCases();
    const x = all.parallel.healGuard;
    const why = [];
    const lineRe = /^probe-hook: отметку о поломке не снять \(блокировка [^\n]*занята дольше 200 мс[^\n]*\) - замок коммита отказывает по ней до следующего удачного прохода\n$/;
    if (!x || x.code !== 0 || !lineRe.test(x.err)) why.push('guard: ' + seen(x));
    if (all.after.heal !== all.before.heal) why.push('.qa-state изменён при занятой блокировке');
    if (all.healLock !== 'чужая блокировка (проба)\n') why.push('чужая блокировка снята: ' + JSON.stringify(all.healLock));
    return why.length ? why.join('; ') : true;
  });

  check('commit-gate: маркер поломки с именем свойства прототипа (.broken-constructor) - отказ по нему, а не пропуск (brokenHooks по собственным ключам, hasOwnProperty)', () => {
    const x = runnerCases().parallel.protoCommit;
    return (x && /"permissionDecision":"deny"/.test(x.out) && /проверка «constructor» упала на последней сдаче: [^"]*probe proto/.test(x.out)) || 'commit-gate: ' + seen(x);
  });

  check('updateState: блокировка занята - bumpEdits отдаёт null, а не 0; standards.js (PostToolUse) называет незаписанный шаг счёта в stderr', () => {
    const p = runnerCases().parallel;
    const why = [];
    if (!p.busyEdits || p.busyEdits.code !== 0 || p.busyEdits.out !== 'null') why.push('bumpEdits при занятой блокировке: ' + seen(p.busyEdits) + ', ждали null');
    if (!p.busyStandards || p.busyStandards.code !== 0 || !/standards\.js: шаг счёта правок \(edits в \.qa-state\) не записан/.test(p.busyStandards.err)) why.push('standards.js: ' + seen(p.busyStandards));
    return why.length ? why.join('; ') : true;
  });

  check('commit-gate: каталог состояния не прочитать (маркеры поломки, EACCES) - отказ «Проверка сломалась» с причиной, а не пропуск (fail-closed)', () => {
    const x = runnerCases().parallel.rdfailCommit;
    return (x && /"permissionDecision":"deny"/.test(x.out) && /Проверка сломалась/.test(x.out) && /EACCES \(проба\)/.test(x.out)) || 'commit-gate: ' + seen(x);
  });

  check('updateState: openSync(.qa-state.lock, wx) отказывает EPERM весь предел - markGates бросает «не взять … EPERM - это отказ файловой системы, а не другой писатель», не «занята», состояние не тронуто', () => {
    const all = runnerCases();
    const x = all.parallel.epermMark;
    const why = [];
    if (!x || x.code === 0 || !/запись \.qa-state не удалась: блокировку [^\n]*не взять за 100 мс: EPERM - это отказ файловой системы, а не другой писатель/.test(x.err)) why.push('markGates: ' + seen(x));
    else if (/занята/.test(x.err)) why.push('отказ ФС назван занятостью: ' + seen(x));
    if (!(all.epermAfter.lastGates && all.epermAfter.lastGates.hash === 'seed-green')) why.push('отметка изменена: ' + JSON.stringify(all.epermAfter.lastGates));
    return why.length ? why.join('; ') : true;
  });

  check('updateState: первая попытка - EEXIST свежей чужой блокировки, дальше openSync отказывает EPERM до конца предела - текст по последней ошибке: «не взять за 100 мс: EPERM - это отказ файловой системы», а не «держит другой писатель» (ревью круг 3, CR3-7); чужая блокировка и состояние на месте', () => {
    const all = runnerCases();
    const x = all.parallel.flipMark;
    const why = [];
    if (!x || x.code === 0 || !/запись \.qa-state не удалась: блокировку [^\n]*не взять за 100 мс: EPERM - это отказ файловой системы, а не другой писатель/.test(x.err)) why.push('markGates: ' + seen(x));
    if (x && /держит другой писатель/.test(x.err)) why.push('отказ ФС на последней попытке назван чужим писателем: ' + seen(x));
    if (all.flipLock !== 'чужая блокировка (проба)\n') why.push('чужая блокировка снята: ' + JSON.stringify(all.flipLock));
    if (all.after.flip !== all.before.flip) why.push('.qa-state изменён');
    return why.length ? why.join('; ') : true;
  });

  check('takeStateLock: разовый EBUSY (антивирус) на stat протухшей блокировки и на stat отодвинутой при пределе ожидания 0 - stat повторяется (retrySync, Р-7 п.3), протухшая снята, отметка записана, блокировок и отодвинутых не осталось, stderr пуст', () => {
    const all = runnerCases();
    const x = all.parallel.statBusyMark;
    const why = [];
    if (!x || x.code !== 0 || x.err !== '') why.push('markGates: ' + seen(x));
    if (!redX(all.statBusyState.lastGates)) why.push('отметка не записана: ' + JSON.stringify(all.statBusyState.lastGates));
    if (all.statBusyLock) why.push('блокировка осталась');
    if (all.statBusyAsides) why.push('отодвинутых блокировок осталось: ' + all.statBusyAsides);
    return why.length ? why.join('; ') : true;
  });

  check('updateState: проход без изменения (guard Stop-хука, noteHookHealth(имя, null) без отметки) в каталоге состояния, которого нет, - каталог не создаётся (mkdirSync после предиката, ревью круг 3, CR3-6), код 0', () => {
    const all = runnerCases();
    const x = all.parallel.absentHealth;
    const why = [];
    if (!x || x.code !== 0 || x.err !== '') why.push('guard: ' + seen(x));
    if (all.absentDir) why.push('каталог состояния создан проходом без изменения');
    return why.length ? why.join('; ') : true;
  });

  check('updateState: протухшую блокировку не снять (rename - EACCES весь предел) - markGates бросает «протухла, но снять её за 100 мс не удалось: … EACCES … - см. причину», а не «держит другой писатель»; блокировка на месте', () => {
    const all = runnerCases();
    const x = all.parallel.stuckMark;
    const why = [];
    if (!x || x.code === 0 || !/запись \.qa-state не удалась: блокировка [^\n]*протухла, но снять её за 100 мс не удалось: EACCES \(проба\) - см. причину/.test(x.err)) why.push('markGates: ' + seen(x));
    if (x && /держит другой писатель/.test(x.err)) why.push('отказ снятия протухшей назван чужим писателем: ' + seen(x));
    if (all.stuckLock !== 'оставил упавший процесс (проба)\n') why.push('блокировка снята или переписана: ' + JSON.stringify(all.stuckLock));
    return why.length ? why.join('; ') : true;
  });

  check('updateState: пределы stateLockLimits вне диапазона (waitMs -5, staleMs -1) заменяются константами - свежую чужую блокировку не снимает, отказ «занята дольше 1000 мс»', () => {
    const all = runnerCases();
    const x = all.parallel.limitsMark;
    const why = [];
    if (!x || x.code === 0 || !/занята дольше 1000 мс - её держит другой писатель/.test(x.err)) why.push('markGates: ' + seen(x));
    if (all.limitsLock !== 'чужая блокировка (проба)\n') why.push('чужая блокировка снята при staleMs -1: ' + JSON.stringify(all.limitsLock));
    if (all.after.limits !== all.before.limits) why.push('.qa-state изменён мимо чужой блокировки');
    return why.length ? why.join('; ') : true;
  });

  check('updateState не бросает: сбой внутри takeStateLock (предел не прочитать) - bumpEdits отдаёт null, markGates бросает «запись .qa-state не удалась: …» с причиной', () => {
    const p = runnerCases().parallel;
    const why = [];
    if (!p.throwEdits || p.throwEdits.code !== 0 || p.throwEdits.out !== 'null') why.push('bumpEdits: ' + seen(p.throwEdits) + ', ждали null');
    if (!p.throwMark || p.throwMark.code === 0 || !/запись \.qa-state не удалась: limits boom \(проба\)/.test(p.throwMark.err)) why.push('markGates: ' + seen(p.throwMark));
    return why.length ? why.join('; ') : true;
  });

  check('updateState: менять нечего (answer-length и remind-format без замечания своей сессии, guard Stop-хука - noteHookHealth(имя, null) - без отметки) - блокировка не берётся, .qa-state байт в байт прежний; удачный проход Stop-хука снимает маркер поломки', () => {
    const all = runnerCases();
    const p = all.parallel;
    const why = [];
    for (const k of ['idleAnswer', 'idleRemind', 'idleHealth']) if (!p[k] || p[k].code !== 0) why.push(k + ': ' + seen(p[k]));
    if (all.idleWx.length) why.push('блокировку брали без изменения: ' + all.idleWx.join(', '));
    if (all.after.idle !== all.before.idle) why.push('.qa-state переписан без изменения');
    if (all.idleMarker) why.push('маркер поломки не снят удачным проходом хука');
    return why.length ? why.join('; ') : true;
  });

  check('updateState: блокировка .qa-state.lock протухла (mtime старше предела протухания) при пределе ожидания 0 - снятие протухшей не ожидание: answer-length пишет замечание, прочие поля на месте, блокировка снята', () => {
    const dir = tempDir('state-stale');
    try {
      seedDir(dir);
      const lock = lockIn(dir);
      fs.writeFileSync(lock, 'оставил упавший процесс (проба)\n');
      const past = (Date.now() - L.STATE_LOCK_STALE_MS - 60000) / 1000;
      fs.utimesSync(lock, past, past);
      const transcript = put(dir, 'transcript.jsonl', mkTranscript(STATE_LONG_ANSWER, 1));
      const pre = preload(dir, 'wait0', { limits: { waitMs: 0 } });
      const r = run(process.execPath, hookArgs(pre, 'answer-length.js'), { input: hookInput('S9', transcript), cwd: ROOT, env: Object.assign({}, process.env, envOf(dir)), timeout: CASE_CAP_MS });
      const x = { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
      const why = [];
      if (x.code !== 0) why.push('answer-length: ' + seen(x));
      const st = JSON.parse(fs.readFileSync(stateIn(dir), 'utf8'));
      if (!noteOf(st, 'S9')) why.push('замечание S9 не записано при протухшей блокировке: ' + JSON.stringify(st).slice(0, 200));
      if (!(st.lastGates && st.lastGates.hash === 'seed-green' && st.lastQa && st.lastQa.sentinel === 'selftest-state')) why.push('прочие поля потеряны: ' + JSON.stringify(st).slice(0, 200));
      if (fs.existsSync(lock)) why.push('блокировка не снята после записи');
      return why.length ? why.join('; ') : true;
    } finally {
      releaseTemp(dir);
    }
  });

  check('updateState: блокировку увели посреди read-modify-write (в ней чужой токен) - держатель не пишет («токен в блокировке … не свой (foreign-token): её увели как протухшую или место занял другой писатель, запись отменена», .qa-state байт в байт прежний), чужую блокировку не снимает и называет это в stderr; возврат отодвинутой на место не удался - отодвинутая блокировка остаётся под именем <lock>-<токен>.tmp, ошибка в stderr', () => {
    const all = runnerCases();
    const p = all.parallel;
    const why = [];
    const s = p.stolen;
    if (!s || s.code !== 0 || !/токен в блокировке [^\n]* не свой \(foreign-token\): её увели как протухшую или место занял другой писатель, запись отменена/.test(s.out)) why.push('держатель уведённой блокировки: ' + seen(s));
    if (all.after.stolen !== all.before.stolen) why.push('держатель уведённой блокировки записал поверх: ' + JSON.stringify(all.after.stolen.slice(0, 200)));
    if (all.stolenLock !== FOREIGN_LOCK) why.push('чужая блокировка снята: ' + JSON.stringify(all.stolenLock));
    if (s && !/updateState: блокировка [^\n]* не своя - её сочли протухшей и взяли, оставлена владельцу/.test(s.err)) why.push('отказ снятия не назван в stderr: ' + seen(s));
    const l = p.linkFail;
    if (!l || !/updateState: блокировку [^\n]* не вернуть на место \(EEXIST\): её место заняла другая, отодвинутая оставлена в /.test(l.err)) why.push('отказ возврата не назван в stderr: ' + seen(l));
    // имя отодвинутой - из самой блокировки: <имя блокировки>-<pid>-<16 hex>.tmp в её каталоге (Р-7 п.5, CR7)
    const asideName = new RegExp('^' + path.basename(L.stateLockPath(envOf(ROOT))).replace(/[.]/g, '\\.') + '-\\d+-[0-9a-f]{16}\\.tmp$');
    if (all.linkFailNames.length !== 1 || !asideName.test(all.linkFailNames[0])) why.push('отодвинутая при отказе возврата не по форме <lock>-<токен>.tmp рядом с блокировкой (Р-7 п.5): ' + JSON.stringify(all.linkFailNames));
    if (JSON.stringify(all.linkFailAsides) !== JSON.stringify([FOREIGN_LOCK])) why.push('отодвинутая блокировка при отказе возврата: ' + JSON.stringify(all.linkFailAsides) + ', ждали одну с чужим токеном');
    if (all.after.linkFail !== all.before.linkFail) why.push('.qa-state изменён при уведённой блокировке');
    return why.length ? why.join('; ') : true;
  });

  check('takeStateLock: блокировка каждый раз «снята между open и stat», предел ожидания 0 - повторов без сверки с пределом STATE_LOCK_FREE_RETRIES, затем отказ «занята», без петли', () => {
    const all = runnerCases();
    const x = all.parallel.freeMark;
    const want = 1 + L.STATE_LOCK_FREE_RETRIES;
    const why = [];
    if (all.freeTries !== want) why.push('попыток openSync ' + all.freeTries + ', ждали ' + want + (all.freeTries > WX_CAP ? ' - петля без предела' : ''));
    if (!x || x.code === 0 || !/занята дольше 0 мс/.test(x.err)) why.push('markGates: ' + seen(x));
    return why.length ? why.join('; ') : true;
  });

  check('dropStateLock: первое чтение своего токена из отодвинутой блокировки - EBUSY (антивирус) - чтение повторяется, своя блокировка снята, отодвинутых не осталось, отметка записана, stderr пуст', () => {
    const all = runnerCases();
    const x = all.parallel.tokenBusyMark;
    const why = [];
    if (!x || x.code !== 0 || /updateState:/.test(x.err)) why.push('markGates: ' + seen(x));
    if (all.tokenBusyLock) why.push('своя блокировка осталась после EBUSY на чтении токена');
    if (all.tokenBusyAsides) why.push('отодвинутых блокировок осталось: ' + all.tokenBusyAsides);
    if (!redX(all.tokenBusyState.lastGates)) why.push('отметка не записана: ' + JSON.stringify(all.tokenBusyState.lastGates));
    return why.length ? why.join('; ') : true;
  });

  check('updateState без предиката (bumpEdits, как и putMark отметок) читает .qa-state один раз - под блокировкой', () => {
    const all = runnerCases();
    const x = all.parallel.onceEdits;
    const why = [];
    if (!x || x.code !== 0 || x.out !== String(STATE_SEED.edits + 1)) why.push('bumpEdits: ' + seen(x));
    if (all.onceReads !== 1) why.push('чтений .qa-state ' + all.onceReads + ', ждали 1');
    return why.length ? why.join('; ') : true;
  });

  check('updateState: гонка Р9 - answer-length держит блокировку посреди read-modify-write, markGates(1), noteHookHealth (guard упавшего Stop-хука) и bumpEdits(2) в это время пишут: в файле замечание сессии, красная отметка, отметка о поломке (без запасного маркера) и edits + 2, блокировка снята', () => {
    const sc = runnerCases().scenarios.race;
    const st = runnerCases().raceState;
    const why = [];
    if (!sc.waits.taken) why.push('answer-length не дошёл до записи - проба ничего не доказывает: ' + seen(sc.children.holder));
    for (const k of ['mark', 'health', 'edits']) if (!sc.waits[k]) why.push(k + ' не тронул блокировку и не записал до сигнала - проба ничего не доказывает: ' + seen(sc.children[k]));
    for (const k of ['holder', 'mark', 'edits']) if (!sc.children[k] || sc.children[k].code !== 0) why.push(k + ': ' + seen(sc.children[k]));
    // noteHookHealth пишет guard Stop-хука, упавшего на исключении: его код - 2 (отказ на Stop), отметка записана
    if (!sc.children.health || sc.children.health.code !== 2 || /не записана/.test(sc.children.health.err)) why.push('health: ' + seen(sc.children.health));
    if (!noteOf(st, 'S2')) why.push('замечание S2 потеряно: ' + JSON.stringify(st).slice(0, 240));
    if (!redX(st.lastGates)) why.push('красная отметка потеряна: lastGates ' + JSON.stringify(st.lastGates));
    if (!(st.brokenHooks && st.brokenHooks[PROBE_HOOK] && /probe boom/.test(st.brokenHooks[PROBE_HOOK].detail))) why.push('отметка о поломке noteHookHealth потеряна: ' + JSON.stringify(st.brokenHooks));
    if (runnerCases().raceMarker) why.push('запасной маркер записан, хотя запись состояния удалась');
    if (st.edits !== STATE_SEED.edits + 2) why.push('bumpEdits потерян: edits ' + st.edits + ', ждали ' + (STATE_SEED.edits + 2));
    if (!(st.lengthNotes && st.lengthNotes.S1 && st.lengthNotes.S1.text === STATE_NOTE_S1)) why.push('чужое замечание S1 потеряно');
    if (runnerCases().raceLock) why.push('блокировка осталась после всех писателей');
    return why.length ? why.join('; ') : true;
  });

  check('updateState: гонка двух за протухшую блокировку - второй, увидевший её протухшей, свежую блокировку первого (взятую за это время) не снимает и ждёт: в файле и замечание первого, и красная отметка второго, блокировка снята', () => {
    const all = runnerCases();
    const sc = all.scenarios.staleRace;
    const st = all.staleState;
    const why = [];
    if (!sc.waits.bSaw || !sc.waits.aHolds) why.push('второй не увидел протухшую или первый не взял блокировку - проба ничего не доказывает: ' + JSON.stringify(sc.waits));
    if (!sc.waits.b) why.push('второй не дошёл ни до попытки, ни до записи: ' + seen(sc.children.b));
    else if (sc.waits.b === 'sig-stale-b-wrote') why.push('второй снял свежую блокировку первого и записал посреди его записи');
    for (const k of ['a', 'b']) if (!sc.children[k] || sc.children[k].code !== 0) why.push(k + ': ' + seen(sc.children[k]));
    if (!noteOf(st, 'S2')) why.push('замечание первого потеряно: ' + JSON.stringify(st).slice(0, 240));
    if (!redX(st.lastGates)) why.push('красная отметка второго потеряна: lastGates ' + JSON.stringify(st.lastGates));
    if (all.staleLock) why.push('блокировка осталась');
    return why.length ? why.join('; ') : true;
  });

  check('updateState: блокировку писателя сочли протухшей и взяли - его finally чужую блокировку не снимает (сверка токена): после его выхода блокировка второго на месте, после второго - снята', () => {
    const all = runnerCases();
    const sc = all.scenarios.takeover;
    const why = [];
    if (!sc.waits.aHolds || !sc.waits.bIn) why.push('второй не взял блокировку первого - проба ничего не доказывает: ' + JSON.stringify(sc.waits) + '; ' + seen(sc.children.b));
    for (const k of ['a', 'b']) if (!sc.children[k] || sc.children[k].code !== 0) why.push(k + ': ' + seen(sc.children[k]));
    if (sc.exists.lockAfterA !== true) why.push('finally первого снял блокировку второго');
    if (all.takeLock) why.push('блокировка второго осталась после его выхода');
    return why.length ? why.join('; ') : true;
  });

  /** Команда qa.md §6 (строка node -e "…" в блоке кода): текст программы, null - не найдена. */
  function qaMarkProgram() {
    const text = fs.readFileSync(path.join(CLAUDE, 'commands', 'qa.md'), 'utf8');
    const m = /^node -e "(.*)"$/m.exec(text.slice(text.indexOf('## 6.')));
    return m ? m[1] : null;
  }
  check('/qa (qa.md §6): запись .qa-state не удалась (каталог состояния - обычный файл) - ненулевой код и «отметка /qa не поставлена», без «файлов на ревью»; запись прошла - отпечаток, edits = 0, strayFiles = [], прочие поля на месте', () => {
    const program = qaMarkProgram();
    if (!program) return 'в qa.md §6 нет строки node -e "…" с отметкой /qa';
    const dir = tempDir('state-qa');
    try {
      // cwd программы - свой каталог с .claude/hooks/diff-hash.js, который берёт настоящий: относительный путь
      // программы (прежняя форма писала ./.claude/.qa-state) не дотягивается до боевого состояния
      put(dir, '.claude/hooks/diff-hash.js', 'module.exports = ' + reqOf('diff-hash.js') + ';\n');
      const stateDir = path.join(dir, 'state');
      fs.mkdirSync(stateDir);
      seedDir(stateDir, { strayFiles: ['a.ts'] });
      const notDir = put(dir, 'state-is-a-file', 'не каталог\n');
      const mark = (stateDirOrFile) => {
        const r = run(process.execPath, ['-e', program], { cwd: dir, env: Object.assign({}, process.env, envOf(stateDirOrFile)), timeout: CASE_CAP_MS });
        return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
      };
      const why = [];
      const refused = mark(notDir);
      if (refused.code === 0 || /файлов на ревью/.test(refused.out) || !/отметка \/qa не поставлена: запись \.qa-state не удалась/.test(refused.err)) why.push('отказ записи: ' + seen(refused));
      if (fs.readFileSync(notDir, 'utf8') !== 'не каталог\n') why.push('файл на месте каталога состояния изменён');
      const ok = mark(stateDir);
      if (ok.code !== 0 || !/файлов на ревью: \d+ \| отпечаток: [0-9a-f]{8} \| edits: 0/.test(ok.out)) why.push('запись: ' + seen(ok));
      const st = JSON.parse(fs.readFileSync(stateIn(stateDir), 'utf8'));
      if (st.edits !== 0 || !Array.isArray(st.strayFiles) || st.strayFiles.length || !/^[0-9a-f]{40}$/.test(String(st.qaDiffHash)) || !Array.isArray(st.qaFiles)) why.push('состояние после отметки: ' + JSON.stringify(st).slice(0, 240));
      if (!(st.lastGates && st.lastGates.hash === 'seed-green' && st.lengthNotes && st.lengthNotes.S1)) why.push('отметка /qa потеряла прочие поля');
      return why.length ? why.join('; ') : true;
    } finally {
      releaseTemp(dir);
    }
  });
}

module.exports = { registerStateProbes };
