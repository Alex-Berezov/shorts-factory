'use strict';
/**
 * selftest-batch.js - тело дочернего node пакетного запуска проб standards (E0-12AC, TECH_DEBT 23.10.2026
 * «E0-12T (условный стоп 2 техлида)»: пробы standards - по процессу на тело, параллельно). Не хук: модуль
 * самопроверки, который исполняет только дочерний процесс (`node -e` грузит этот файл и зовёт batchRunner с
 * настройками со stdin или из файла, как selftest-gate-runner.js - gateRunner); при загрузке модуль ничего
 * не исполняет.
 *
 * Зачем ребёнок: самопроверка синхронна и событий своих асинхронных детей до выхода не получает, поэтому
 * параллельный запуск заданий и сбор их ответов - в отдельном node, а процесс самопроверки ждёт его
 * синхронно (run) или забирает итог пакета в фоне в точке сбора отложенных строк (startDetached) - готовым
 * одной строкой.
 *
 * Exit процесса здесь законен (поле exit записи в SELFTEST_MODULES): это выход ребёнка с готовым итогом.
 */

const fs = require('fs');
// строки протокола пакета - общие с родительской стороной (makeBatch), там же их описание
const { BATCH_EXIT_MARK, BATCH_MARK, envByList, exitLineHook, makeChildRegistry, makeLauncher } = require('./selftest-children.js');

/** Наибольший срок таймера node (2^31 - 1 мс): capMs больше него setTimeout сократил бы до 1 мс. */
const MAX_TIMER_MS = 2147483647;

/**
 * Пакет заданий cfg.jobs ({ args, input, cwd, env, capMs, capAfterOutput, slot, write }): каждое - process.execPath с args,
 * input - на stdin (строка или нет поля, иначе отказ пакета до первого запуска), cwd; окружение - по белому списку (envByList, как у gateRunner; L-030) и env задания
 * сверху; запуск - через точку запуска makeLauncher (liveState - cfg.liveState: задание без каталога
 * состояния проб или с боевым - отказ точки запуска, итог задания, а не обрыв пакета). Одновременно - не
 * больше cfg.limit заданий (целое больше 0, иначе отказ пакета, а не молчаливый последовательный режим);
 * задания с одним slot (одно дерево на диске) идут по очереди, в порядке заданий, и write ({ file, text })
 * пишется перед запуском своего задания (каталог файла - готов у вызывающего) - так подкорень с копией хуков служит
 * нескольким телам подряд. capMs - предел задания (число больше 0 и не больше MAX_TIMER_MS у каждого, иначе
 * отказ пакета до первого запуска) от запуска, а с capAfterOutput: true - от первого вывода задания в stdout
 * или stderr (рукопожатие: предел не съедает холодный старт node; без вывода предел не заводится, задание
 * держит только предел ответа пакета у вызывающего); capAfterOutput - true, false или нет поля, иначе отказ
 * пакета. По пределу задание снимается SIGKILL (hung) и пайпы задания закрываются тут же, вышло оно или
 * нет: итог не ждёт внука, который держит пайпы (внук не снимается - он уже не потомок задания на Windows).
 * Выход пакета, пока задания идут (исключение, exit процесса), снимает их SIGKILL (набор детей
 * makeChildRegistry) и называет их число в stderr; когда ребёнка пакета убивают снаружи (SIGKILL по
 * пределу вызывающего), обработчик exit не зовётся, и судьба заданий не проверяется ни на одной
 * платформе: проба и снятие заданий группой процессов - E0-12AE (TECH_DEBT 01.11.2026 «E0-12AC, Fix 2»).
 * Итог - BATCH_MARK и массив { code, signal, hung, out, err } в порядке заданий (не в порядке
 * завершения), затем выход с 0 - после того, как итог ушёл в stdout (колбэк записи: на платформе с
 * асинхронным pipe выход сразу после записи оборвал бы итог). Сбой
 * самого пакета (не массив заданий, исключение при запуске) - причина первой строкой stderr и выход с 1
 * без итога: вызывающий (runBatch) называет код и начало stderr. Исключение в обработчике события
 * задания (после возврата batchRunner) - выход node с 1 и стеком в stderr, тоже без итога. Последней
 * строкой stdout в каждом исходе - строка выхода BATCH_EXIT_MARK с кодом.
 */
function batchRunner(cfg) {
  // строка выхода - и после итога, и при сбое пакета: пакет в фоне ждут по ней (awaitDetached)
  exitLineHook(BATCH_EXIT_MARK);
  // задания, идущие при выходе пакета, снимаются - иначе они держали бы файлы дерева пробы (EBUSY)
  const reaper = makeChildRegistry();
  process.on('exit', () => {
    const left = reaper.live.size;
    if (!left) return;
    const failed = reaper.kill();
    process.stderr.write('batchRunner: на выходе сняты задания - ' + left + (failed.length ? '; не сняты: ' + failed.join('; ') : '') + '\n');
  });
  try {
    runJobs(cfg, reaper.live);
  } catch (e) {
    // сбой пакета - текст причины первой строкой stderr и код 1, без строки итога
    process.stderr.write('batchRunner: ' + ((e && e.message) || String(e)) + '\n');
    process.exit(1);
  }
}
function runJobs(cfg, live) {
  const jobs = cfg.jobs;
  if (!Array.isArray(jobs)) throw new Error('jobs не массив - ' + JSON.stringify(jobs));
  const limit = cfg.limit;
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('limit не целое больше 0 - ' + JSON.stringify(limit));
  jobs.forEach((job, i) => {
    const cap = job && job.capMs;
    if (!Number.isFinite(cap) || cap <= 0 || cap > MAX_TIMER_MS) throw new Error('задание ' + i + ': capMs не число больше 0 и не больше ' + MAX_TIMER_MS + ' - ' + JSON.stringify(cap));
    const after = job.capAfterOutput;
    if (after !== undefined && typeof after !== 'boolean') throw new Error('задание ' + i + ': capAfterOutput не true/false - ' + JSON.stringify(after));
    if (job.input !== undefined && typeof job.input !== 'string') throw new Error('задание ' + i + ': input не строка - ' + JSON.stringify(job.input));
  });
  const launch = makeLauncher({ liveState: cfg.liveState });
  const results = new Array(jobs.length);
  const started = new Array(jobs.length).fill(false);
  // задание без slot - своё дерево: занятость ключом по номеру задания
  const slotOf = (i) => (jobs[i].slot === undefined ? '#' + i : 's' + jobs[i].slot);
  const busy = new Set();
  let running = 0;
  let done = 0;
  let pumping = false;
  let again = false;
  const finish = () => {
    process.stdout.write(BATCH_MARK + JSON.stringify(results), () => process.exit(0));
  };
  const settle = (i, result) => {
    results[i] = result;
    busy.delete(slotOf(i));
    running--;
    done++;
    pump();
  };
  const startOne = (i) => {
    const job = jobs[i];
    let child;
    try {
      if (job.write) fs.writeFileSync(job.write.file, job.write.text);
      child = launch.spawn(process.execPath, job.args, {
        cwd: job.cwd,
        env: envByList(process.env, job.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      settle(i, { code: null, signal: null, hung: false, out: '', err: 'запуск задания: ' + ((e && e.message) || String(e)) });
      return;
    }
    live.add(child);
    let out = '';
    let err = '';
    let hung = false;
    let closed = false;
    let cap = null;
    // close приходит, когда процесс вышел и его пайпы закрылись; по пределу пайпы закрываются сразу,
    // вышло задание или нет, - иначе пакет ждал бы внука, который их держит, до своего предела
    const arm = () => {
      if (cap !== null) return;
      cap = setTimeout(() => {
        hung = true;
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
      }, job.capMs);
    };
    if (!job.capAfterOutput) arm();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (s) => {
      out += s;
      if (job.capAfterOutput) arm();
    });
    child.stderr.on('data', (s) => {
      err += s;
      if (job.capAfterOutput) arm();
    });
    const close = (code, signal, extra) => {
      if (closed) return;
      closed = true;
      if (cap !== null) clearTimeout(cap);
      live.delete(child);
      settle(i, { code, signal, hung, out, err: err + (extra || '') });
    };
    child.on('error', (e) => close(null, null, 'ошибка запуска: ' + ((e && e.message) || String(e))));
    child.on('close', (code, signal) => close(code, signal));
    child.stdin.on('error', () => {});
    child.stdin.end(job.input || '');
  };
  // запуск по порядку заданий: первое не начатое задание со свободным slot, пока есть место
  const pump = () => {
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    do {
      again = false;
      for (let i = 0; i < jobs.length && running < limit; i++) {
        if (started[i] || busy.has(slotOf(i))) continue;
        started[i] = true;
        busy.add(slotOf(i));
        running++;
        startOne(i);
      }
    } while (again);
    pumping = false;
    if (done === jobs.length) finish();
  };
  pump();
}

module.exports = { batchRunner };
