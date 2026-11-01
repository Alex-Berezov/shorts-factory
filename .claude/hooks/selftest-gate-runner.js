'use strict';
/**
 * selftest-gate-runner.js - тело дочернего node проб запуска gates.js (E0-12AA, TECH_DEBT 23.10.2026
 * E0-12U круг 2: gateRunner вынесен из selftest-gates-run.js). Не хук: модуль самопроверки, который
 * исполняет только дочерний процесс (`node -e` пробы делает `require(<этот файл>).gateRunner(cfg)`, как
 * selftest-temp.js в решении техлида B4 E0-12T); процесс самопроверки берёт из него только суффикс
 * отметки старта STARTED_SUFFIX (selftest-gates-run.js) - при require модуль ничего не исполняет.
 *
 * Exit процесса здесь законен (поле exit записи в SELFTEST_MODULES): это выход ребёнка с готовым
 * итогом пробы. selftest-gates-run.js, который пишет строки проб в процессе самопроверки, - в
 * NO_EXIT_FILES.
 */

const fs = require('fs');
const L = require('./lib.js');
const { envByList, makeChildRegistry, makeLauncher } = require('./selftest-children.js');

/**
 * Суффикс файла отметки старта внука проб (<pid-файл><STARTED_SUFFIX>): его пишет программа внука
 * (selftest-gates-run.js получает суффикс отсюда, JSON.stringify при генерации) и читает gcStartedAt -
 * одна строка протокола на обе стороны (решение техлида Р9 E0-12AA).
 */
const STARTED_SUFFIX = '.started';

/**
 * Текст файла f или null, только если пути нет (L.statIfPresent - помощник «путь есть» обвязки, своей
 * копии разбора ошибки нет); иной сбой (EACCES, каталог на месте файла - EISDIR) - исключение, а не
 * «внук не жив» (решение техлида Р9 E0-12AA). Файлы внука (PID, отметка, пульс) никто не удаляет до
 * конца пробы: окна между stat и чтением нет.
 */
function readIfPresent(f) {
  return L.statIfPresent(f) ? fs.readFileSync(f, 'utf8') : null;
}

/**
 * Дочерний процесс проб запуска гейтов (gateRunCases): `node -e` берёт функцию require этого модуля
 * (TECH_DEBT 21.10.2026 E0-12M круг 2, исходник функции строкой снят) - вместе с модулем целиком, так
 * что функция берёт модули, как любая другая; при require модуль ничего не исполняет. Случаи идут
 * параллельно в два этапа (решение техлида Р4 E0-12AB): этап 1 - случаи runGate и запуски gates.js без
 * stage, этап 2 - запуски со stage: 2, после возврата всех случаев этапа 1 (их нагрузка не сдвигает
 * окна проб runGate). Время пробы - самый долгий случай этапа 1 плюс самый долгий этапа 2, а не сумма.
 *   cfg.gates - случаи runGate ({ gate, capMs }); итог - с end (часы ОС на возврате);
 *   cfg.cli - запуски gates.js из командной строки в дереве пробы ({ args, env, capMs, stage }); итог -
 *     со start и end (часы ОС на запуске и на close) и stage: по ним проба сверяет порядок этапов; через точку
 *     запуска makeLauncher (liveState - cfg.liveState: SF_HOOK_STATE_DIR случая не боевой каталог) с
 *     окружением по белому списку (envByList, как у git проб; L-030) и переменными случая сверху;
 *   cfg.watch - внуки ({ pid, hb, stage }): внук пишет при старте отметку старта (gcStartedAt) и свой PID в
 *     файл, каждые 100 мс - отметку в файл hb. Жив ли внук после возврата, решает отметка: сдвинулась за cfg.watchMs - жив. Ни зомби на
 *     POSIX (он не пишет), ни PID, доставшийся другому процессу на Windows, такой ответ не подделают.
 *     Пульс читается сразу после возврата случаев своего этапа (stage - этап случая-владельца, как у cfg.cli;
 *     решение техлида Р7 E0-12AB), до старта следующего: внук сам выходит через cfg.gcLifeMs, и пульс,
 *     прочитанный позже, «не жив» доказывал бы его срок жизни, а не снятие. Итог - с readAt (часы ОС на
 *     втором чтении); пульс не сдвинулся, а второе чтение не раньше cfg.gcLifeMs от старта внука или отметки
 *     старта нет при PID - alive: null (watchAlive).
 *     Живой внук добивается здесь же по PID (только живой - иначе PID мог бы быть чужим) через набор
 *     детей (makeChildRegistry): ESRCH (уже вышел) молчит, иной сбой (EPERM) - исключение, ребёнок
 *     падает без итога, и строки проб красные, а не зелёные при живом внуке.
 * Каждый случай ограничен capMs: зависший runGate - { hung }, а не зависшая самопроверка.
 */
function gateRunner(cfg) {
  const { runGate } = require(cfg.gatesFile);
  const launch = makeLauncher({ liveState: cfg.liveState });
  const reaper = makeChildRegistry({ kill: (c) => process.kill(c.pid, 'SIGKILL') });
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  // этап записи (cfg.cli[k] или cfg.watch[k]) - одно выражение на всех: 2 только у stage: 2, иначе 1
  const stageOf = (entry) => (entry.stage === 2 ? 2 : 1);
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
    // end - время возврата (часы ОС): окно пробы считается от отметки старта ребёнка, а не от вызова
    return r ? Object.assign({ code: r.code, ms: Date.now() - t, end: Date.now(), remnant: r.remnant, manual: r.manual }, brief(r.text)) : { hung: true, ms: Date.now() - t, end: Date.now() };
  };
  const cliCase = (k) =>
    new Promise((resolve) => {
      const c = cfg.cli[k];
      const t = Date.now();
      const stage = stageOf(c);
      // stdinOpen: gates.js получает пайп stdin, который проба не закрывает до его выхода
      let child;
      try {
        child = launch.spawn(process.execPath, ['-r', cfg.preload, cfg.cliGates].concat(c.args), {
          cwd: cfg.dir,
          env: envByList(process.env, c.env),
          stdio: [c.stdinOpen ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (e) {
        // отказ точки запуска (окружение случая без каталога состояния проб) - итог случая, а не обрыв ребёнка
        resolve({ code: null, signal: null, hung: false, ms: Date.now() - t, start: t, end: Date.now(), stage, out: '', err: 'точка запуска: ' + ((e && e.message) || String(e)) });
        return;
      }
      let out = '';
      let err = '';
      let hung = false;
      child.stdout.on('data', (b) => { out += b; });
      child.stderr.on('data', (b) => { err += b; });
      const cap = setTimeout(() => { hung = true; child.kill('SIGKILL'); }, c.capMs);
      child.on('close', (code, signal) => {
        clearTimeout(cap);
        if (child.stdin) child.stdin.destroy();
        resolve({ code, signal, hung, ms: Date.now() - t, start: t, end: Date.now(), stage, out: out.slice(-6000), err: err.slice(-1500) });
      });
    });
  // пульс внуков этапа: два чтения через cfg.watchMs сразу после возврата его случаев; живой внук добивается
  const readWatch = async (stage, res) => {
    const keys = Object.keys(cfg.watch).filter((k) => stageOf(cfg.watch[k]) === stage);
    const before = {};
    for (const k of keys) before[k] = readIfPresent(cfg.watch[k].hb);
    await pause(cfg.watchMs);
    for (const k of keys) {
      const now = readIfPresent(cfg.watch[k].hb);
      const readAt = Date.now();
      const pid = Number(readIfPresent(cfg.watch[k].pid)) || null;
      const startedAt = gcStartedAt(cfg.watch[k].pid);
      const moved = now !== null && now !== before[k];
      res.watch[k] = { started: pid !== null, pid, alive: watchAlive({ moved, readAt, startedAt, lifeMs: cfg.gcLifeMs, pid }), startedAt, readAt, stage };
      if (moved) {
        const failed = reaper.kill(new Set([{ pid }]));
        if (failed.length) throw new Error('внук ' + k + ' не снят: ' + failed.join('; '));
      }
    }
    // следующий этап стартует в следующую миллисекунду часов ОС: старт в ту же, что последний readAt, порядок
    // «пульс прочитан до старта» по отметкам не доказывал бы
    await nextMs({ now: Date.now, pause });
  };
  (async () => {
    const res = { gates: {}, cli: {}, watch: {} };
    const cliKeys = Object.keys(cfg.cli);
    await Promise.all(
      Object.keys(cfg.gates).map(async (k) => { res.gates[k] = await gateCase(k); }).concat(
        cliKeys.filter((k) => stageOf(cfg.cli[k]) === 1).map(async (k) => { res.cli[k] = await cliCase(k); }),
      ),
    );
    await readWatch(1, res);
    await Promise.all(cliKeys.filter((k) => stageOf(cfg.cli[k]) === 2).map(async (k) => { res.cli[k] = await cliCase(k); }));
    await readWatch(2, res);
    process.stdout.write('probe ' + JSON.stringify(res));
    process.exit(0);
  })();
}

/**
 * Жив ли внук по пульсу; аргументы - объект { moved, readAt, startedAt, lifeMs, pid } (решение техлида Р9
 * E0-12AB, п.6): moved - отметка сдвинулась за cfg.watchMs. Таблица истинности (решение техлида
 * Р8 E0-12AB): пульс сдвинулся - true всегда (внук жив, сколько бы ни прошло от старта); не сдвинулся и
 * второе чтение (readAt) не раньше lifeMs от старта внука (startedAt, gcStartedAt) - null: внук мог выйти
 * сам по сроку жизни, и «не жив» ничего не доказывает; не сдвинулся, PID есть (pid !== null), а отметки
 * старта нет - null (fail-closed: срок жизни проверить не по чему); иначе - false. Строка пробы на null
 * красная.
 */
function watchAlive({ moved, readAt, startedAt, lifeMs, pid }) {
  if (!Number.isFinite(lifeMs) || lifeMs <= 0) throw new Error('watchAlive: срок жизни внука не задан: ' + lifeMs);
  if (moved) return true;
  if (!Number.isFinite(startedAt)) return pid !== null ? null : false;
  return readAt - startedAt >= lifeMs ? null : false;
}

/**
 * Предел ожидания nextMs в мс - по монотонным часам процесса, а не числом пауз (пауза в 1 мс на Windows
 * длится до ~15 мс): часы ОС, не сменившие показание за это время, стоят.
 */
const NEXT_MS_LIMIT = 1000;

/**
 * Ждёт смены показания часов now() паузами pause(1) не дольше limit мс по монотонным часам mono() (по
 * умолчанию performance.now() этого процесса); возвращает новое показание. Показание проверяется после
 * каждой паузы, и после последней тоже; сдвиг назад (перевод часов) - тоже смена (now !== прежнего), а не
 * «часы стоят» (решение техлида Р9 E0-12AB, п.4). Не сменилось за limit мс - исключение «часы ОС не идут»
 * (ребёнок падает без итога, строки проб красные, а не зависшая самопроверка). Часы now - Date.now(), а не
 * performance.now(): этапы сверяются с отметкой старта внука (gcStartedAt), которую пишет другой процесс, а
 * performance.now() между процессами несравним (исключение из L-030 с причиной; решение техлида Р8
 * E0-12AB); срок ожидания внутри процесса - по монотонным mono().
 */
async function nextMs({ now, pause, mono = () => performance.now(), limit = NEXT_MS_LIMIT }) {
  const last = now();
  const from = mono();
  for (;;) {
    await pause(1);
    const t = now();
    if (t !== last) return t;
    if (mono() - from >= limit) break;
  }
  throw new Error('nextMs: часы ОС не идут - ' + limit + ' мс без смены показания ' + last);
}

/**
 * Отметка старта внука проб (окно пробы orphan - от фактического старта, T8): часы ОС внука
 * (Date.now()), которые он пишет текстом в <pidFile>.started до файла PID. Не mtime файла: часы ФС с
 * грубым шагом (exFAT - 2 с) против Date.now() дали бы ложный отказ окна (замечание ревью E0-12AA).
 * Нет файла или не число - null (окно от вызова); иной сбой чтения - исключение (readIfPresent).
 * read(file) - текст или null, по умолчанию readIfPresent.
 */
function gcStartedAt(pidFile, read = readIfPresent) {
  const at = Number(read(pidFile + STARTED_SUFFIX));
  return Number.isFinite(at) && at > 0 ? at : null;
}

module.exports = { NEXT_MS_LIMIT, STARTED_SUFFIX, gateRunner, gcStartedAt, nextMs, watchAlive };
