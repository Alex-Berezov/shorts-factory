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
 * что функция берёт модули, как любая другая; при require модуль ничего не исполняет. Все случаи идут
 * параллельно: время пробы - самый долгий случай, а не сумма.
 *   cfg.gates - случаи runGate ({ gate, capMs });
 *   cfg.cli - запуски gates.js из командной строки в дереве пробы ({ args, env, capMs }): через точку
 *     запуска makeLauncher (liveState - cfg.liveState: SF_HOOK_STATE_DIR случая не боевой каталог) с
 *     окружением по белому списку (envByList, как у git проб; L-030) и переменными случая сверху;
 *   cfg.watch - внуки ({ pid, hb }): внук пишет при старте отметку старта (gcStartedAt) и свой PID в
 *     файл, каждые 100 мс - отметку в файл hb. Жив ли внук после возврата, решает отметка: сдвинулась за cfg.watchMs - жив. Ни зомби на
 *     POSIX (он не пишет), ни PID, доставшийся другому процессу на Windows, такой ответ не подделают.
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
    return r ? Object.assign({ code: r.code, ms: Date.now() - t, end: Date.now(), remnant: r.remnant, manual: r.manual }, brief(r.text)) : { hung: true, ms: Date.now() - t };
  };
  const cliCase = (k) =>
    new Promise((resolve) => {
      const c = cfg.cli[k];
      const t = Date.now();
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
        resolve({ code: null, signal: null, hung: false, ms: Date.now() - t, out: '', err: 'точка запуска: ' + ((e && e.message) || String(e)) });
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
    for (const k of Object.keys(cfg.watch)) before[k] = readIfPresent(cfg.watch[k].hb);
    await pause(cfg.watchMs);
    for (const k of Object.keys(cfg.watch)) {
      const now = readIfPresent(cfg.watch[k].hb);
      const pid = Number(readIfPresent(cfg.watch[k].pid)) || null;
      const alive = now !== null && now !== before[k];
      res.watch[k] = { started: pid !== null, pid, alive, startedAt: gcStartedAt(cfg.watch[k].pid) };
      if (alive) {
        const failed = reaper.kill(new Set([{ pid }]));
        if (failed.length) throw new Error('внук ' + k + ' не снят: ' + failed.join('; '));
      }
    }
    process.stdout.write('probe ' + JSON.stringify(res));
    process.exit(0);
  })();
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

module.exports = { STARTED_SUFFIX, gateRunner, gcStartedAt };
