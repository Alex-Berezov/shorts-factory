#!/usr/bin/env node
'use strict';
/**
 * gates.js - прогон обязательных проверок. Это НЕ хук: запускается руками
 * и командой /gates, читает только аргументы командной строки.
 *
 * Репозиториев несколько и лежат они рядом. Скрипт сам смотрит, где есть изменения,
 * и гоняет гейты каждого такого репозитория его же правилами, из его же папки.
 *
 * Смысл скрипта простой: нельзя написать "всё зелёное", не запустив проверки.
 * Вывод команд печатается настоящий, код возврата сохраняется честно.
 *
 * Использование:
 *   node .claude/hooks/gates.js              - выбрать и прогнать
 *   node .claude/hooks/gates.js --list       - только показать, что будет запущено
 *   node .claude/hooks/gates.js --only=typecheck,lint  - только эти гейты; названный гейт идёт
 *                                                       при любом when (glob без совпавших файлов, never)
 *                                                       и на чистом дереве (в каждом репозитории, где
 *                                                       гейт объявлен; --repo сужает); id, которого нет
 *                                                       ни в одном репозитории, и пустой --only - код 1
 *   node .claude/hooks/gates.js --repo=books-front
 *   node .claude/hooks/gates.js --bail       - остановиться на первом падении
 *
 * Предел: у каждого гейта в правилах поле timeoutSec (целое от 1 до MAX_TIMEOUT_SEC, секунды).
 * Гейт, не завершившийся за предел, снимается вместе со всем деревом процессов (Windows -
 * taskkill /T /F, POSIX - группа процессов); гейт без поля или с недопустимым значением не
 * запускается (E0-12M). Гейт красный во всех случаях, кроме: оболочка вышла с 0 и вывод закрылся
 * сам; метки сводки (VERDICTS) и что делать - docs/60_HARNESS.md, «Гейты». SIGINT, SIGTERM,
 * SIGHUP, которые дошли до обработчика gates.js, снимают дерево текущего гейта, выход ненулевой;
 * полный прогон пишет красную отметку (код 1), частичный отметку не ставит (на Windows внешний
 * SIGTERM - TerminateProcess, обработчик не зовётся; docs/60_HARNESS.md).
 * stdin гейту не даётся: гейт не интерактивен - команда, ждущая ввода, получает конец ввода сразу,
 * а не висит до предела (на POSIX гейт ещё и в своей сессии, setsid, и делил бы терминал с
 * оператором).
 *
 * Код выхода: 1, если упал хотя бы один гейт в любом репозитории, иначе 0.
 *
 * Отметка о прогоне (lastGates в .qa-state, только полный прогон без --repo и --only) - по диффу,
 * снятому до запуска гейтов; дифф изменился за прогон (файл появился, пропал, сменил содержимое или
 * не прочитан - метка-каталог, сбой чтения) - отметка с кодом 1 и код возврата 1, и при зелёных гейтах
 * (решение техлида Р6 E0-12AB: код выхода = код отметки); сверка, запись или сам прогон упали - код 1
 * и красная отметка.
 */

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./lib.js');
// diff-hash.js грузится сразу, а не перед отметкой: сбой его загрузки роняет gates.js до первого гейта
// кодом 1 со стеком - громко и до траты времени на прогон; отметку тогда не пишет никто, но commit-gate.js
// берёт тот же модуль и без него коммит не пускает
const H = require('./diff-hash.js');

// сколько строк вывода показываем целиком и как режем длинный
const FULL_LIMIT = 200;
const HEAD_LINES = 40;
const TAIL_LINES = 60;

// сколько ждём закрытия вывода после снятия дерева или выхода оболочки: процесс, которого
// снятие не достало, держал бы пайп вечно, а гейт обязан вернуться
const KILL_GRACE_MS = 2000;

// потолок timeoutSec: час - больше любого гейта с запасом и далеко ниже предела таймера Node
// (2^31-1 мс: больше - таймер срабатывает через 1 мс, и гейт снимался бы сразу)
const MAX_TIMEOUT_SEC = 3600;

// сколько вывода гейта держим в памяти: голова и хвост, середина срезается с отметкой в выводе
// (прежний spawnSync держал maxBuffer; без предела болтливый гейт съел бы память gates.js)
const OUTPUT_HEAD_BYTES = 1024 * 1024;
const OUTPUT_TAIL_BYTES = 1024 * 1024;
// хвост держится кусками не больше этого: срез начала хвоста - сдвиг внутри первого куска, без копии,
// и лишнее в памяти - меньше одного куска
const OUTPUT_TAIL_PIECE_BYTES = 64 * 1024;

// taskkill по абсолютному пути: голое имя Windows ищет и в текущем каталоге
const TASKKILL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
// код taskkill /T /F, когда корень дерева вышел сам между перечислением и снятием («нет запущенного
// экземпляра»): единственный ненулевой код, разобранный замером (E0-12AB, файл дела «Замер шага 0»)
const TASKKILL_ROOT_GONE = 255;

// ------------------------------------------------------------------ аргументы

function parseArgs(argv) {
  const res = { list: false, bail: false, only: null, repo: null, help: false };
  for (const a of argv) {
    if (a === '--list') res.list = true;
    else if (a === '--bail') res.bail = true;
    else if (a === '--help' || a === '-h') res.help = true;
    else if (a.startsWith('--repo=')) res.repo = a.slice('--repo='.length).trim() || null;
    else if (a.startsWith('--only=')) {
      res.only = a
        .slice('--only='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return res;
}

/**
 * Полный ли прогон: без --help, --list, --repo и --only. Только он ставит отметку lastGates, и только его
 * прерывание или сбой пишут красную - одно определение на main(), обработчик сигнала и catch (ревью
 * E0-12AB, круг 3; решение техлида Р7): новый сужающий ключ добавляется сюда, а не в три места.
 */
function isFull(args) {
  return !args.help && !args.list && !args.repo && !args.only;
}

function printHelp() {
  console.log(
    [
      'gates.js - прогон обязательных проверок по всем репозиториям, где есть изменения.',
      '',
      '  --list            показать выбранные гейты и выйти, ничего не запуская',
      '  --only=a,b        запустить только гейты с этими id - при любом when, в том числе',
      '                    без изменённых файлов под шаблоном и при when="never"',
      '  --repo=имя        взять только этот репозиторий',
      '  --bail            остановиться сразу после первого падения',
      '',
      'Список гейтов берётся из правил репозитория, поле gates.',
      'Гейт с when="always" запускается всегда, с when="glob:<шаблон>" - только если',
      'под шаблон подходит хотя бы один изменённый файл этого репозитория,',
      'с when="never" - только по прямому указанию в --only.',
      'Гейт, названный в --only, запускается при любом when, в том числе на чистом дереве',
      '(тогда - в каждом репозитории, где гейт объявлен; --repo сужает). Id, которого нет ни в одном',
      'репозитории, и пустой --only - код 1, ничего не запускается.',
      '',
      'Предел времени - поле timeoutSec гейта (целое от 1 до ' + MAX_TIMEOUT_SEC + ', секунды): гейт,',
      'не завершившийся за предел, снимается вместе с деревом процессов; гейт без поля не запускается.',
      'Гейт красный во всех случаях, кроме: оболочка вышла с 0 и вывод закрылся сам; метки сводки и',
      'что делать - docs/60_HARNESS.md, «Гейты». Ctrl+C (SIGINT), SIGTERM, SIGHUP',
      'снимают дерево текущего гейта, код ненулевой (на Windows внешний SIGTERM обработчик не зовёт).',
    ].join('\n'),
  );
}

function files(n) {
  const last = n % 10;
  const two = n % 100;
  if (two >= 11 && two <= 14) return n + ' файлов';
  if (last === 1) return n + ' файл';
  if (last >= 2 && last <= 4) return n + ' файла';
  return n + ' файлов';
}

// ------------------------------------------------------------------ выбор гейтов

/** Разбор условия when: возвращает шаблон для glob:... или null для always. */
function whenGlob(when) {
  const w = String(when || 'always').trim();
  if (w.startsWith('glob:')) return w.slice('glob:'.length).trim();
  return null;
}

/**
 * Отбор гейтов. Для каждого - решение и причина человеческими словами.
 * Возвращает [{ gate, run, reason }] в исходном порядке.
 */
function selectGates(gates, changed, only) {
  const picked = only && only.length;
  return gates.map((gate) => {
    if (picked) {
      // названный гейт идёт при любом when: glob без совпавших файлов - не повод ответить
      // exit 0, не запустив проверку, которую попросили прямо
      if (only.indexOf(gate.id) === -1) return { gate, run: false, reason: 'не выбран через --only' };
      return { gate, run: true, reason: 'выбран через --only' };
    }
    if (String(gate.when || '').trim() === 'never') {
      return { gate, run: false, reason: 'помечен never - только руками, через --only' };
    }
    const glob = whenGlob(gate.when);
    if (!glob) return { gate, run: true, reason: 'запускается всегда' };
    const hit = changed.find((f) => L.matchGlob(glob, f));
    if (hit) {
      return { gate, run: true, reason: 'включил файл ' + hit + ' (шаблон ' + glob + ')' };
    }
    return { gate, run: false, reason: 'нет изменённых файлов под шаблон ' + glob };
  });
}

// ------------------------------------------------------------------ вывод команды

function secs(ms) {
  const s = ms / 1000;
  return (s < 10 ? s.toFixed(1) : String(Math.round(s))) + 'с';
}

/** Строки вывода гейта без хвостовых пробелов; пустой вывод - ни одной строки. Режется один раз. */
function outputLines(text) {
  const raw = String(text == null ? '' : text).replace(/\s+$/, '');
  return raw ? raw.split(/\r?\n/) : [];
}

/**
 * Длинный вывод режем посередине; путь файла вывода (log.path, needsLog) печатается под ним, а
 * сбой записи файла (log.error) назван прямо - без пути, которого нет, и с тем, что без файла
 * потеряно (срезанные на экране строки, срез памяти). Собранный текст - не
 * обязательно полный вывод: болтливому гейту outputBuffer срезает середину (cutBytes), и
 * подпись файла говорит об этом прямо.
 */
function printOutput(lines, log, cutBytes) {
  if (!lines.length) {
    console.log('  (команда ничего не вывела)');
  } else if (lines.length <= FULL_LIMIT) {
    console.log(lines.join('\n'));
  } else {
    const cut = lines.length - HEAD_LINES - TAIL_LINES;
    console.log(lines.slice(0, HEAD_LINES).join('\n'));
    console.log('... срезано ' + cut + ' строк ...');
    console.log(lines.slice(lines.length - TAIL_LINES).join('\n'));
  }
  if (!log) return;
  if (log.error) {
    // без файла срезанное не вернуть: экранный срез строк и срез памяти называем прямо
    const lost = [];
    if (lines.length > FULL_LIMIT) lost.push('срезанные на экране ' + (lines.length - HEAD_LINES - TAIL_LINES) + ' строк середины');
    if (cutBytes) lost.push('середина (' + cutBytes + ' байт), срезанная пределом памяти gates.js');
    console.log(
      'Файл вывода не записан (' + log.error + '): ' +
        (lost.length ? 'вывод выше неполон, потеряны ' + lost.join(' и ') + '.' : 'выше - весь вывод этого гейта.'),
    );
  } else if (cutBytes) {
    console.log(
      'Вывод в файле - первые и последние байты, середина (' + cutBytes + ' байт) срезана пределом памяти gates.js: ' + log.path,
    );
  } else {
    console.log('Полный вывод: ' + log.path);
  }
}

/**
 * Кому нужен файл вывода (решение техлида Р2 E0-12O от 22.10.2026, вариант A): красному гейту с
 * выводом - всегда, каким бы коротким ни был вывод: причину прошлого красного ищут по файлу, а не по
 * note гейта (docs/TECH_DEBT.md § E0-12O); любому гейту с выводом длиннее FULL_LIMIT - тоже: его
 * экранный вывод срезан посередине, и без файла середина терялась бы (60_HARNESS, «Гейты»).
 * Короткий зелёный и гейт без вывода файла не оставляют - пустой файл ничего не объясняет.
 */
function needsLog(code, lines) {
  return lines.length > 0 && (code !== 0 || lines.length > FULL_LIMIT);
}

// сколько живёт файл вывода гейта: старше - удаляется при первой записи следующего прогона
const LOG_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// свой каталог файлов вывода в os.tmpdir(): чистка смотрит только сюда, чужих файлов TEMP не видит
const LOG_DIR_NAME = 'sf-gates';
// имя файла вывода, который пишет saveLog: gates-<repo>-<гейт>-<pid>.log; прочие файлы каталога не трогаем
const LOG_NAME = /^gates-[a-zA-Z0-9._-]+-\d+\.log$/;
// чистка - одна на прогон gates.js, при первой записи файла вывода, а не на каждый красный гейт
let logsPruned = false;

/** Удаляет файлы вывода gates.js в dir старше LOG_KEEP_MS; сбой чтения каталога или одного файла - мимо, гейт не роняет. */
function pruneLogs(dir, now) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return;
  }
  for (const name of names) {
    if (!LOG_NAME.test(name)) continue;
    const p = path.join(dir, name);
    try {
      if (now - fs.statSync(p).mtimeMs > LOG_KEEP_MS) fs.unlinkSync(p);
    } catch (_) {
      // занят или уже удалён другим прогоном - следующий прогон попробует снова
    }
  }
}

/**
 * Файл вывода гейта в своём каталоге os.tmpdir()/sf-gates (0o700), pid прогона в имени, доступ
 * только владельцу (0o600: вывод гейта может нести пути и тексты окружения, а TEMP на Linux бывает
 * общим). Файл с тем же именем (pid прошлого прогона достался этому) удаляется, и новый создаётся
 * заново (flag 'wx') - иначе запись унаследовала бы права старого. Старые файлы вывода удаляются
 * при первой записи прогона (pruneLogs). Сбой записи гейт не роняет: { error } вместо { path }.
 */
function saveLog(id, text) {
  const dir = path.join(os.tmpdir(), LOG_DIR_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!logsPruned) {
      logsPruned = true;
      pruneLogs(dir, Date.now());
    }
    const safe = String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
    const p = path.join(dir, 'gates-' + safe + '-' + process.pid + '.log');
    fs.rmSync(p, { force: true });
    fs.writeFileSync(p, text, { mode: 0o600, flag: 'wx' });
    return { path: p };
  } catch (e) {
    return { error: (e && e.code) || String((e && e.message) || e) };
  }
}

/**
 * Предел гейта в секундах: целое от 1 до MAX_TIMEOUT_SEC из поля timeoutSec, иначе null
 * (строка "60", 1.5, 0, отрицательное, null, больше потолка - null: гейт не запускается).
 */
function gateTimeoutSec(gate) {
  const t = gate && gate.timeoutSec;
  return Number.isInteger(t) && t > 0 && t <= MAX_TIMEOUT_SEC ? t : null;
}

/**
 * Снятие группы процессов POSIX целиком: null - сигнал ушёл, иначе код ошибки (ESRCH - группы
 * нет, EPERM - нельзя).
 */
function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
    return null;
  } catch (e) {
    return (e && e.code) || String(e);
  }
}

/**
 * Снятие всего дерева процессов команды, пока её оболочка жива. Убить одну оболочку мало:
 * на Windows cmd.exe умирает, а pnpm -> turbo -> next остаются и держат пайп вывода, и гейт
 * висит дальше. Windows - taskkill /T по PID живой оболочки, POSIX - SIGKILL её группе.
 * Возвращает { ok, why, unconfirmed, status }: ok - снятие подтверждено (taskkill с кодом 0, сигнал
 * группе ушёл), иначе why - почему снять не удалось (нет taskkill.exe, его отказ, нет группы).
 * unconfirmed - только код taskkill TASKKILL_ROOT_GONE (255, status - код): под нагрузкой корень
 * cmd.exe, потеряв снятого ребёнка, выходит сам между перечислением дерева и своим снятием, и taskkill
 * отвечает 255 «нет запущенного экземпляра», сняв остальное дерево (замер E0-12AB). Вердикт по такому
 * снятию - по эффекту (settle в runGate, решения техлида Р2 и Р5 E0-12AB). Прочие ненулевые коды
 * (1 - отказ доступа и др.) замером не разобраны - отказ снятия, «снять руками».
 */
function killTree(child) {
  if (process.platform === 'win32') {
    const r = cp.spawnSync(TASKKILL, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    if (r.error) return { ok: false, why: TASKKILL + ' не запустился (' + (r.error.code || r.error.message) + ')' };
    if (r.status !== 0) {
      const why = 'taskkill /T /F вышел с кодом ' + r.status + (r.signal ? ', сигнал ' + r.signal : '');
      return r.status === TASKKILL_ROOT_GONE ? { ok: false, unconfirmed: true, status: r.status, why } : { ok: false, why };
    }
    return { ok: true, why: '' };
  }
  const err = killGroup(child.pid);
  return err ? { ok: false, why: 'SIGKILL группе ' + child.pid + ' не ушёл (' + err + ')' } : { ok: true, why: '' };
}

/**
 * Длина головы buf, которая кончается на границе символа UTF-8: незаконченная последовательность
 * в конце отрезается (иначе декодер дал бы U+FFFD на месте среза).
 */
function utf8HeadEnd(buf) {
  let i = buf.length;
  let back = 0;
  // до трёх байт продолжения 10xxxxxx назад - к ведущему байту последнего символа
  while (i > 0 && back < 3 && (buf[i - 1] & 0xc0) === 0x80) {
    i--;
    back++;
  }
  if (i === 0) return buf.length;
  const lead = buf[i - 1];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return need > back + 1 ? i - 1 : buf.length;
}

/** Начало хвоста buf на границе символа UTF-8: байты продолжения в начале (до трёх) пропускаются. */
function utf8TailStart(buf) {
  let i = 0;
  while (i < buf.length && i < 3 && (buf[i] & 0xc0) === 0x80) i++;
  return i;
}

/**
 * Вывод гейта с пределом памяти: первые OUTPUT_HEAD_BYTES и последние OUTPUT_TAIL_BYTES байт,
 * середина срезается, и в текст встаёт строка, сколько срезано и почему. Вывод держится байтами и
 * перекодируется один раз, в text(); у каждого потока (stdout, stderr) свой хвост незаконченного
 * символа (carry): символ, разрезанный между двумя кусками одного потока, не разбивается куском
 * другого. Срез головы и хвоста идёт по границе символа. Куски держатся копиями (own): срез
 * subarray держал бы в памяти весь кусок, от которого он отрезан, и предел памяти не держался бы.
 * Хвост - копии кусками до OUTPUT_TAIL_PIECE_BYTES: срез его начала сдвигает начало первого куска
 * (skip) и снимает целые куски, ничего не копируя, - копия остатка на каждом куске вывода гоняла бы
 * мегабайты памяти на каждый кусок болтливого гейта.
 */
function outputBuffer() {
  const head = [];
  let headBytes = 0;
  const tail = [];
  // байт хвоста без срезанного начала первого куска (skip)
  let tailBytes = 0;
  let skip = 0;
  let cut = 0;
  // свой буфер под ровно эти байты: срез чужого буфера копируется
  const own = (b) => (b.byteOffset === 0 && b.length === b.buffer.byteLength ? b : Buffer.from(b));
  const push = (bytes) => {
    if (!bytes.length) return;
    let b = bytes;
    if (headBytes < OUTPUT_HEAD_BYTES) {
      const take = Math.min(b.length, OUTPUT_HEAD_BYTES - headBytes);
      head.push(own(b.subarray(0, take)));
      headBytes += take;
      b = b.subarray(take);
      if (!b.length) return;
    }
    // кусок длиннее всего хвоста: его начало срезано сразу, без копии
    if (b.length > OUTPUT_TAIL_BYTES) {
      cut += b.length - OUTPUT_TAIL_BYTES;
      b = b.subarray(b.length - OUTPUT_TAIL_BYTES);
    }
    for (let i = 0; i < b.length; i += OUTPUT_TAIL_PIECE_BYTES) tail.push(own(b.subarray(i, i + OUTPUT_TAIL_PIECE_BYTES)));
    tailBytes += b.length;
    while (tailBytes > OUTPUT_TAIL_BYTES) {
      const over = tailBytes - OUTPUT_TAIL_BYTES;
      const live = tail[0].length - skip;
      if (live <= over) {
        tail.shift();
        skip = 0;
        tailBytes -= live;
        cut += live;
      } else {
        skip += over;
        tailBytes -= over;
        cut += over;
      }
    }
  };
  // хвост без срезанного начала первого куска
  const tailLive = () => (skip ? [tail[0].subarray(skip)].concat(tail.slice(1)) : tail);
  const streams = [];
  return {
    /**
     * Поток процесса: в общий вывод идут его байты до границы символа, незаконченный символ в конце
     * куска ждёт следующего куска этого же потока (carry).
     */
    attach(stream) {
      const s = { carry: Buffer.alloc(0) };
      streams.push(s);
      stream.on('data', (chunk) => {
        const buf = s.carry.length ? Buffer.concat([s.carry, chunk]) : chunk;
        const end = utf8HeadEnd(buf);
        s.carry = own(buf.subarray(end));
        push(buf.subarray(0, end));
      });
    },
    /** Хвосты потоков (незаконченный символ в конце потока) - в вывод, перед text(). */
    flush() {
      for (const s of streams.splice(0)) push(s.carry);
    },
    get cutBytes() {
      return cut;
    },
    /** Сколько памяти держат куски вывода и хвосты потоков: размер их буферов, каждый буфер один раз. */
    get heldBytes() {
      const seen = new Set();
      let n = 0;
      for (const b of head.concat(tail, streams.map((s) => s.carry))) {
        if (seen.has(b.buffer)) continue;
        seen.add(b.buffer);
        n += b.buffer.byteLength;
      }
      return n;
    },
    text() {
      if (!cut) return Buffer.concat(head.concat(tail)).toString('utf8');
      const first = Buffer.concat(head);
      const last = Buffer.concat(tailLive());
      const headText = first.subarray(0, utf8HeadEnd(first)).toString('utf8');
      const tailText = last.subarray(utf8TailStart(last)).toString('utf8');
      return (
        headText + '\n... срезано ' + cut + ' байт вывода: gates.js держит первые ' + OUTPUT_HEAD_BYTES +
        ' и последние ' + OUTPUT_TAIL_BYTES + ' байт вывода гейта (предел памяти) ...\n' + tailText
      );
    },
  };
}

// Гейты, которые идут сейчас: их деревья снимает обработчик сигнала самого gates.js (abortRunning).
// main() гонит гейты по одному, но runGate экспортирован, и ребёнок проб (selftest-gate-runner.js)
// гонит его параллельно - один слот снимал бы только последний запущенный (ревью E0-12AB).
const running = new Set();

/**
 * Снятие деревьев всех идущих гейтов - для обработчика SIGINT/SIGTERM/SIGHUP gates.js: без него
 * прерванный gates.js оставлял бы дерево гейта сиротой (на POSIX оно в своей сессии и группе, и
 * сигнал терминала до него не доходит). Гейт, чья оболочка уже вышла, не трогается: на POSIX
 * остаток её группы снят в ветке exit, и номер пустой группы мог занять чужой лидер; на Windows
 * PID вышедшей оболочки мог получить чужой процесс. Возвращает { killed, failed, exited }: снято
 * деревьев, причины неудач, гейтов с вышедшей оболочкой.
 */
function abortRunning() {
  const res = { killed: 0, failed: [], exited: 0 };
  for (const entry of running) {
    if (entry.exited) {
      res.exited++;
      continue;
    }
    const k = killTree(entry.child);
    if (k.ok) res.killed++;
    else res.failed.push(k.why);
  }
  return res;
}

/**
 * Запуск одной команды из папки её репозитория. stdin не даётся, вывод собирается с пределом
 * памяти (outputBuffer). Возвращает Promise<{ code, ms, text, cutBytes, timedOut, manual,
 * remnant, noLimit, limit }> и не отклоняется никогда. Код 0 - только оболочка вышла с 0 и вывод
 * закрылся сам, без предела и без снятия (settle). Гейт без предела - код 1 без запуска (noLimit);
 * по пределу дерево снимается: снятие подтверждено и вывод закрылся в KILL_GRACE_MS - код 1,
 * timedOut; taskkill вышел не с 0, а оболочка вышла и вывод закрылся в KILL_GRACE_MS - тоже код 1 и
 * timedOut, код taskkill в тексте (Р2 E0-12AB); отказ снятия или вывод не закрылся - код 1, timedOut
 * и manual (снять руками, оба факта в тексте). Снятие по пределу отложено на фазу check (setImmediate):
 * выход оболочки, пришедший в том же обороте цикла, что и предел, обрабатывается раньше, и вышедшая
 * оболочка не снимается. Вывод закрылся без выхода оболочки - код 1 (fail-closed). Оболочка вышла,
 * а вывод открыт: остаток дерева снимается сразу на POSIX (группа
 * живёт, пока в ней есть процесс, и её номер не достаётся чужому) и не снимается на Windows
 * (дерево ищется только по PID живой оболочки, PID вышедшей мог получить чужой процесс); снят
 * остаток группы - код 1 и это в тексте; вывод не закрылся за KILL_GRACE_MS - код 1 и remnant
 * (остаток жив, код оболочки - только в тексте).
 */
function runGate(gate, root) {
  const started = Date.now();
  const limit = gateTimeoutSec(gate);
  if (limit === null) {
    return Promise.resolve({
      code: 1,
      ms: 0,
      text:
        'нет предела timeoutSec у гейта ' + gate.id + ' (целое от 1 до ' + MAX_TIMEOUT_SEC + ', секунды, поле гейта ' +
        'в rules.sf.json; дано ' + JSON.stringify(gate.timeoutSec) + '): команда не запускалась',
      cutBytes: 0,
      timedOut: false,
      manual: false,
      remnant: false,
      noLimit: true,
      limit: null,
    });
  }
  return new Promise((resolve) => {
    const out = outputBuffer();
    let settled = false;
    let timer = null;
    let grace = null;
    let entry = null;
    // снятие по пределу: null - предел не наступал, иначе итог killTree
    let limitKill = null;
    const finish = (code, tail, flags) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (entry) running.delete(entry);
      out.flush();
      let text = out.text();
      if (tail) text = (text ? text.replace(/\s+$/, '') + '\n' : '') + tail;
      const f = flags || {};
      resolve({
        code,
        ms: Date.now() - started,
        text,
        cutBytes: out.cutBytes,
        timedOut: limitKill !== null,
        manual: Boolean(f.manual),
        remnant: Boolean(f.remnant),
        noLimit: false,
        limit,
      });
    };
    let child;
    try {
      child = cp.spawn(gate.cmd, {
        cwd: root,
        shell: true,
        // stdin не даётся: гейт не интерактивен, команда, ждущая ввода, сразу получает конец ввода
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // POSIX: detached - setsid, своя сессия и группа процессов; её снимает killTree целиком
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      finish(1, 'не удалось запустить команду: ' + (e && e.message));
      return;
    }
    entry = { child, exited: false };
    running.add(entry);
    // выход оболочки: код, сигнал и снят ли остаток её группы (POSIX)
    let shell = null;
    const shellText = () =>
      shell.code === null ? 'прервана сигналом ' + (shell.signal || 'неизвестно') : 'вышла с кодом ' + shell.code;
    const graceSec = KILL_GRACE_MS / 1000;
    /**
     * Итог гейта - одно правило (E0-12M, D2/D3): код 0 только когда оболочка вышла с 0 и оба пайпа
     * закрылись сами - без предела и без снятия. Всё остальное - код не 0 и факты словами: что
     * сделало снятие, закрылся ли вывод; о дереве по закрывшемуся пайпу ничего не выводится.
     * closed - пайпы закрылись сами (close), иначе их закрыл таймер ожидания.
     */
    const settle = (closed) => {
      if (!closed) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      if (limitKill) {
        if (limitKill.ok && closed) {
          return finish(1, 'гейт снят по пределу ' + limit + ' с (timeoutSec в rules.sf.json): команда не завершилась');
        }
        // taskkill вышел не с 0, а оболочка вышла и вывод закрылся в окне ожидания: дерево снято, корень
        // ушёл сам между перечислением и снятием (замер E0-12AB) - вердикт по эффекту, код taskkill в тексте
        // (решение техлида Р2 E0-12AB); сбой запуска taskkill и незакрывшийся вывод - «снять руками» ниже
        if (limitKill.unconfirmed && closed && entry.exited) {
          return finish(
            1,
            'гейт снят по пределу ' + limit + ' с (timeoutSec в rules.sf.json): команда не завершилась; taskkill /T /F вышел с кодом ' +
              limitKill.status + ', оболочка вышла, вывод закрылся',
          );
        }
        return finish(
          1,
          'гейт не завершился за предел ' + limit + ' с (timeoutSec в rules.sf.json); ' +
            (limitKill.ok ? 'дерево процессов снято' : 'снять дерево процессов не удалось: ' + limitKill.why) + '; ' +
            (closed ? 'вывод закрылся' : 'вывод не закрылся за ' + graceSec + ' с после снятия') + '; снять руками',
          { manual: true },
        );
      }
      if (!closed) {
        const why =
          process.platform === 'win32'
            ? 'на Windows он не снят - дерево ищется по PID живой оболочки, PID вышедшей мог получить чужой процесс'
            : 'снятие группы его не достало (он сменил группу)';
        return finish(
          1,
          'оболочка гейта ' + shellText() + ', а вывод держал оставшийся от неё процесс ещё ' + graceSec + ' с: ' + why + '; снять руками',
          { remnant: true },
        );
      }
      // вывод закрылся без выхода, предела и ошибки запуска - Node этого не обещает; кода оболочки
      // нет, и код из close гейт зелёным не делает (fail-closed)
      if (shell === null) return finish(1, 'вывод закрылся, а оболочка гейта не сообщила о выходе');
      if (shell.swept) return finish(1, 'оболочка гейта ' + shellText() + ', оставшиеся процессы её группы сняты');
      if (shell.code === null) return finish(1, 'команда прервана сигналом ' + (shell.signal || 'неизвестно'));
      return finish(shell.code, '');
    };
    out.attach(child.stdout);
    out.attach(child.stderr);
    child.on('error', (e) => finish(1, 'не удалось запустить команду: ' + (e && e.message)));
    child.on('exit', (code, signal) => {
      entry.exited = true;
      if (limitKill) return;
      clearTimeout(timer);
      shell = { code, signal, swept: process.platform !== 'win32' && killGroup(child.pid) === null };
      // остаток, который снятие не достало (Windows), держал бы пайп вечно: гейт возвращается
      grace = setTimeout(() => settle(false), KILL_GRACE_MS);
    });
    // close после error (сбой запуска) молчит: итог уже отдан
    child.on('close', () => {
      if (settled) return;
      settle(true);
    });
    timer = setTimeout(() => {
      if (settled || entry.exited) return;
      // Предел и выход оболочки рядом: снятие откладывается на setImmediate (фаза check). По
      // документированному порядку фаз цикла Node (timers -> poll -> check,
      // https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick) событие, отданное
      // после таймера, но до фазы check этого оборота (в том числе в poll), обрабатывается раньше, и
      // страж ниже видит entry.exited - PID вышедшей оболочки не снимается. Приходит ли выход cmd.exe
      // на Windows в тот же оборот, что и таймер, не замерялось. Окно сужается, а не исчезает: выход
      // после фазы check страж не видит (снятие одно, его исход - вердикт по эффекту в settle); обе
      // стороны держат пробы runGate с поддельным процессом.
      setImmediate(() => {
        if (settled || entry.exited) return;
        limitKill = killTree(child);
        // процесс, которого снятие не достало, держал бы пайп вечно: гейт возвращается всё равно
        grace = setTimeout(() => settle(false), KILL_GRACE_MS);
      });
    }, limit * 1000);
  });
}

/**
 * Метки сводки - одна таблица (E0-12AB): первая подошедшая строка даёт метку. parts - текст метки
 * вокруг числа: у строки с n метка - parts, склеенные числом n(r) из итога runGate, без n - одна
 * часть. В матрице docs/60_HARNESS.md, «Гейты» (что каждая значит и что делать) на месте числа
 * стоит N (экспорт verdicts); совпадение держит harness-selftest.
 */
const VERDICTS = [
  { parts: ['ПРЕДЕЛ ', ' с, СНЯТЬ РУКАМИ'], when: (r) => r.timedOut && r.manual, n: (r) => r.limit },
  { parts: ['СНЯТ ПО ПРЕДЕЛУ ', ' с'], when: (r) => r.timedOut, n: (r) => r.limit },
  { parts: ['ОСТАТОК ЖИВ, СНЯТЬ РУКАМИ'], when: (r) => r.remnant },
  { parts: ['ПАДАЕТ, нет предела timeoutSec'], when: (r) => r.noLimit },
  { parts: ['ok'], when: (r) => r.code === 0 },
  { parts: ['ПАДАЕТ, код ', ''], when: () => true, n: (r) => r.code },
];

/** Итог гейта словами: для строки после его вывода и для сводки. */
function verdict(r) {
  const v = VERDICTS.find((x) => x.when(r));
  return v.n ? v.parts.join(String(v.n(r))) : v.parts[0];
}

// --------------------------------------------------------------- какие репозитории

/** Годные гейты правил репозитория: объявленные с id и cmd; без поля gates - ни одного. */
function gatesOf(rules) {
  return Array.isArray(rules.gates) ? rules.gates.filter((x) => x && x.id && x.cmd) : [];
}

/** Группа прогона репозитория без изменённых файлов (--repo без диффа, --only на чистом дереве). */
function bareGroup(repo) {
  return { repo, rules: L.rulesFor(repo), files: [] };
}

/**
 * Репозитории, по которым пойдём: те, где есть дифф. С --repo берём только названный,
 * и берём его даже без изменений - раз попросили прямо, прогоним хотя бы постоянные гейты.
 * Возвращает [{ repo, rules, files }].
 */
function pickRepos(wanted) {
  const changed = L.allChanged();
  if (!wanted) return changed;

  const found = changed.find((g) => g.repo.name === wanted);
  if (found) return [found];

  const repo = L.knownRepos().find((r) => r.name === wanted);
  if (!repo) {
    const names = L.knownRepos().map((r) => r.name);
    console.log(
      'Репозиторий ' + wanted + ' неизвестен. Есть: ' + (names.join(', ') || 'ни одного') + '.',
    );
    return null;
  }
  return [bareGroup(repo)];
}

/**
 * Репозитории прогона с --only. Id ищется по гейтам всех репозиториев repos.json, а не только тех,
 * где есть изменения: гейт другого репозитория - не опечатка (E0-12M, C7). Неизвестный id и гейт
 * только репозитория, куда прогон не идёт, - отказ (печатает причину, возвращает null). На чистом
 * дереве (groups пуст) гейты идут в каждом репозитории, где они объявлены; позиция в repos.json
 * не участвует (E0-12M, В2). Иначе - groups как есть.
 */
function onlyRepos(args, groups) {
  const owners = new Map();
  for (const repo of L.knownRepos()) {
    for (const x of gatesOf(L.rulesFor(repo))) {
      if (!owners.has(x.id)) owners.set(x.id, []);
      owners.get(x.id).push(repo.name);
    }
  }
  const unknown = args.only.filter((id) => !owners.has(id));
  if (unknown.length) {
    // опечатка в --only - не «запускать нечего» с exit 0: проверку просили, а она не идёт (E0-12M, B2)
    console.log(
      'Неизвестные id в --only: ' + unknown.join(', ') +
        '. Есть: ' + (Array.from(owners.keys()).join(', ') || 'ни одного') + '. Ничего не запускалось - исправь --only.',
    );
    return null;
  }
  if (!groups.length) {
    // --only на чистом дереве: гейты, которые попросили прямо, идут и без диффа - иначе
    // `--only=build` после коммита отвечал бы exit 0, ничего не собрав (E0-12M, B1)
    // группы помечены clean: строку о чистом дереве печатает main() вместо «Пойдём по репозиториям»
    const owning = L.knownRepos().filter((r) => args.only.some((id) => owners.get(id).indexOf(r.name) !== -1));
    return owning.map((repo) => Object.assign(bareGroup(repo), { clean: true }));
  }
  // гейт есть, но только в репозитории, куда прогон не идёт (там нет изменений, или --repo
  // назвал другой): молча не запустить его - тот же exit 0 без проверки
  const picked = groups.map((g) => g.repo.name);
  const elsewhere = args.only.filter((id) => !owners.get(id).some((n) => picked.indexOf(n) !== -1));
  if (elsewhere.length) {
    console.log(
      'Гейты из --only есть только в репозиториях, куда этот прогон не идёт: ' +
        elsewhere.map((id) => id + ' - ' + owners.get(id).join(', ')).join('; ') +
        '. Ничего не запускалось' + (args.repo ? '.' : ' - назови репозиторий: --repo=<имя>.'),
    );
    return null;
  }
  // гейт идёт в изменённых репозиториях, а объявлен и в репозитории без изменений: туда прогон не
  // идёт, и это говорится прямо - иначе оператор считал бы тот репозиторий проверенным (решение
  // техлида Р3 E0-12AB); --repo выбрал репозиторий сам - строки нет
  if (!args.repo) {
    for (const id of args.only) {
      for (const n of owners.get(id)) {
        if (picked.indexOf(n) === -1) {
          console.log('--only: гейт ' + id + ' объявлен и в ' + n + ' без изменений, туда прогон не идёт (--repo=' + n + ').');
        }
      }
    }
  }
  return groups;
}

// ---------------------------------------------------------------------- запуск

// Метки диффа полного прогона (diffLabels до выбора гейтов): по ним обработчик сигнала пишет красную
// отметку; null - метки ещё не сняты (тогда redMark() берёт текущий дифф) или прогон не полный.
let fullLabels = null;

async function main(args) {
  if (args.help) {
    printHelp();
    return { code: 0, ran: false };
  }

  if (args.only && !args.only.length) {
    // `--only=` или `--only=,` - сужение без единого id: не повод молча гнать всё или ничего
    console.log('--only без единого id гейта. Ничего не запускалось - назови гейты: --only=<id>[,<id>].');
    return { code: 1, ran: false };
  }

  // Снимок диффа - только у прогона, который ставит отметку (полный, не --list): метки (diffLabels) -
  // до выбора гейтов, отпечатки файлов (diffSnapshot) - когда очередь не пуста, перед первым гейтом:
  // прогон без работы файлы диффа не читает, а файл, появившийся между выбором и снимком, виден по
  // меткам. Отметка ставится по снимку, а файл, тронутый во время прогона (фоновый прогон идёт до
  // ~25 мин), даёт отметку с кодом 1 (E0-12AB, решение техлида Р6). Метки - дифф замка коммита
  // (diffLabels, от origin/<база>), а гейты выбирает L.allChanged (от L.baseRef): два источника -
  // строка TECH_DEBT 28.10.2026 E0-12AB.
  const full = isFull(args);
  const labels = full ? H.diffLabels() : null;
  fullLabels = labels;

  let groups = pickRepos(args.repo);
  if (groups === null) return { code: 1, ran: false };

  if (args.only) {
    groups = onlyRepos(args, groups);
    if (groups === null) return { code: 1, ran: false };
  }

  if (!groups.length) {
    // Особого хода для обвязки здесь нет: она в repos.json как часть репозитория sf, её гейт
    // harness-selftest - в rules.sf.json, и дифф из одних её правок идёт по общему пути. Сюда
    // доходит только по-настоящему пустой дифф.
    console.log('Изменений нет ни в одном репозитории - гонять нечего.');
    console.log('Нужен прогон без диффа - укажи репозиторий: --repo=<имя>.');
    return { code: 0, ran: false };
  }

  if (groups.every((g) => g.clean)) {
    console.log(
      'Изменений нет ни в одном репозитории; --only гонит названные гейты там, где они объявлены: ' +
        groups.map((g) => g.repo.name).join(', ') + ' (сузить - --repo=<имя>).',
    );
  } else {
    console.log(
      'Пойдём по репозиториям: ' +
        groups.map((g) => g.repo.name + ' - ' + files(g.files.length)).join(', '),
    );
  }
  for (const g of groups) {
    console.log('  ' + g.repo.name + '  ' + g.repo.path + '  база ' + (g.rules.baseBranch || 'main'));
  }

  // план по каждому репозиторию
  const plans = [];
  for (const g of groups) {
    plans.push({ group: g, plan: selectGates(gatesOf(g.rules), g.files, args.only) });
  }

  const queue = [];
  for (const p of plans) {
    const toRun = p.plan.filter((x) => x.run);
    const skipped = p.plan.filter((x) => !x.run);

    console.log('');
    console.log(p.group.repo.name + ': будет запущено (' + toRun.length + '):');
    if (!p.plan.length) console.log('  в правилах этого репозитория гейтов нет');
    else if (!toRun.length) console.log('  ничего');
    for (const x of toRun) {
      console.log(
        '  ' + x.gate.id + '  ' + x.gate.cmd + '  - ' + x.reason + (x.gate.note ? '. ' + x.gate.note : ''),
      );
      queue.push({ group: p.group, gate: x.gate });
    }
    if (skipped.length) {
      console.log('  пропущено (' + skipped.length + '):');
      for (const x of skipped) console.log('    ' + x.gate.id + '  - ' + x.reason);
    }
  }

  if (args.list) {
    console.log('');
    console.log('Это был --list, ничего не запускалось.');
    return { code: 0, ran: false };
  }
  if (!queue.length) {
    console.log('');
    console.log('Запускать нечего.');
    return { code: 0, ran: false };
  }
  const before = labels ? H.diffSnapshot(labels) : null;

  const results = [];
  let stopped = false;
  for (const item of queue) {
    const name = item.group.repo.name;
    if (stopped) {
      results.push({ repo: name, gate: item.gate, skippedAfterFail: true });
      continue;
    }
    console.log('');
    console.log('=== ' + name + ' / ' + item.gate.id + ': ' + item.gate.cmd + ' ===');
    const r = await runGate(item.gate, item.group.repo.path);
    const lines = outputLines(r.text);
    const log = needsLog(r.code, lines) ? saveLog(name + '-' + item.gate.id, r.text) : null;
    printOutput(lines, log, r.cutBytes);
    console.log('--- ' + name + ' / ' + item.gate.id + ': ' + verdict(r) + ', ' + secs(r.ms) + ' ---');
    results.push({ repo: name, gate: item.gate, run: r });
    if (r.code !== 0 && args.bail) stopped = true;
  }

  const failed = results.filter((r) => !r.skippedAfterFail && r.run.code !== 0);

  console.log('');
  console.log('Сводка:');
  const repoWidth = Math.max.apply(null, results.map((r) => r.repo.length));
  const idWidth = Math.max.apply(null, results.map((r) => r.gate.id.length));
  const cmdWidth = Math.max.apply(null, results.map((r) => r.gate.cmd.length));
  for (const r of results) {
    const repo = r.repo + ' '.repeat(repoWidth - r.repo.length);
    const id = r.gate.id + ' '.repeat(idWidth - r.gate.id.length);
    const cmd = r.gate.cmd + ' '.repeat(cmdWidth - r.gate.cmd.length);
    const status = r.skippedAfterFail
      ? 'не запускался (остановились на первом падении)'
      : verdict(r.run) + ' (' + secs(r.run.ms) + ')';
    console.log('  ' + repo + '  ' + id + '  ' + cmd + '  ' + status);
  }

  if (failed.length) {
    const byRepo = new Map();
    for (const r of failed) byRepo.set(r.repo, (byRepo.get(r.repo) || 0) + 1);
    console.log('');
    console.log(
      'Упало гейтов: ' + failed.length + ' из ' + results.length + ' (' +
        Array.from(byRepo).map(([n, c]) => n + ' - ' + c).join(', ') +
        '). Чини и прогоняй заново.',
    );
    return { code: 1, ran: true, full, before };
  }
  console.log('');
  console.log('Все гейты прошли.');
  return { code: 0, ran: true, full, before };
}

/**
 * Красная отметка (код 1) после сбоя сверки, отметки или самого прогона: labels - метки снимка до
 * прогона, без них - текущий дифф. Возвращает, что записано, словами; запись не удалась - так и
 * сказано, с тем, что прежняя отметка осталась и коммитить нельзя.
 */
function markRed(labels) {
  try {
    H.markGates(1, labels);
    return 'записана отметка о красном прогоне (код 1)';
  } catch (e) {
    return 'красную отметку записать не удалось (' + ((e && e.message) || e) + '), прежняя отметка в .qa-state осталась - не коммить до полного прогона с отметкой';
  }
}

/**
 * Красная отметка полного прогона по меткам, снятым до очереди (fullLabels), а до них - по текущему
 * диффу: одна форма у обработчика сигнала и у catch main() (ревью E0-12AB, круг 4; решение техлида Р8).
 */
function redMark() {
  return markRed(fullLabels || undefined);
}

// Скрипт исполняется только при запуске из командной строки. Через require его берёт
// harness-selftest (selectGates - та же функция, что выбирает гейты здесь, runGate - та же,
// что запускает их с пределом): загрузка модуля
// не запускает гейты, не ставит отметку о прогоне и не выходит из процесса (E0-12D).
if (require.main === module) {
  // Аргументы разбираются один раз: обработчик сигнала, main() и catch видят один и тот же isFull(args)
  const args = parseArgs(process.argv.slice(2));
  const full = isFull(args);
  // Прерывание самого gates.js (Ctrl+C, внешнее снятие): дерево идущего гейта снимается, выход
  // ненулевой. Полный прогон пишет красную отметку (redMark()) по меткам, снятым до очереди, а до них -
  // по текущему диффу: прежняя зелёная отметка иначе пережила бы прерванный прогон, и правка, сделанная
  // после неё, ушла бы в коммит (ревью E0-12AB, круг 3; решение техлида Р7). Частичный прогон отметку не
  // ставит. Код taskkill 255 здесь - отказ снятия с кодом в причине и «снять руками»: эффект снятия в
  // обработчике проверить нечем (решения техлида Р2 и Р7). SIGKILL, а на Windows и внешний SIGTERM
  // (TerminateProcess) обработчик не зовут - тогда дерево гейта остаётся и отметка прежняя (замер
  // E0-12M, 21.10.2026: снятый process.kill родитель, его ребёнок и внук живы; docs/60_HARNESS.md,
  // «Известные ограничения»).
  for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.on(signal, () => {
      const a = abortRunning();
      console.error(
        'gates.js прерван (' + signal + '): снято деревьев гейтов - ' + a.killed +
          (a.failed.length ? '; снять не удалось - ' + a.failed.length + ': ' + a.failed.join('; ') + ' - снять руками' : '') +
          (a.exited ? '; оболочка уже вышла, остаток не снимается - ' + a.exited : '') +
          ', ' + (full ? redMark() : 'отметка о прогоне не поставлена'),
      );
      process.exit(exitCode);
    });
  }
  // main() асинхронный (runGate ждёт команду с пределом): выход - только после его итога
  (async () => {
    let code = 1;
    let result = null;
    try {
      result = await main(args);
      code = result.code;
    } catch (e) {
      // скрипт-проверка не имеет права молча притвориться зелёным; полный прогон пишет красную отметку -
      // иначе прежняя зелёная пустила бы коммит после сломавшегося прогона (ревью E0-12AB, круг 2)
      console.error('gates.js сломался: ' + (e && e.stack ? e.stack : e) + (full ? '\n' + redMark() + ', код прогона 1.' : ''));
      code = 1;
      result = null;
    }

    // Отметка о прогоне в общем состоянии: код возврата вместе с отпечатком того диффа,
    // по которому выбраны гейты (снимок в main() до очереди), а не диффа в конце прогона.
    // Её читают commit-gate.js и report-honesty.js: коммит проходит только по зелёной отметке
    // текущего диффа, слово «зелено» в отчёте - тоже. Код пишется честный, включая ненулевой:
    // отметка «гейты падали» нужна не меньше, чем «гейты прошли».
    //
    // Дифф за прогон изменился - новый или пропавший файл, другое содержимое файла диффа (Р1
    // E0-12AB), файл не прочитан (метка-каталог, сбой чтения; Р6): тронутое во время прогона гейты
    // могли не видеть, и отметка пишется с кодом 1, код возврата тоже 1, даже если все гейты прошли
    // (решение техлида Р6 E0-12AB: код выхода = код отметки). Не писать ничего нельзя: прежняя
    // зелёная отметка с тем же набором имён пустила бы коммит. Сверка строже замка коммита: файлы
    // afterReviewAllowed (tasks.json, 00_STATUS.md, docs/*_TASKS.md), тронутые за прогон, тоже дают
    // код 1 - их читает гейт tracker, и отметка по ним стояла бы за непроверенный трекер (решение
    // техлида Р5 E0-12AB; цена - редкий перепрогон). Сверка или запись упала - код 1 и попытка
    // записать красную отметку (markRed): прежняя зелёная иначе пустила бы коммит без сверки.
    //
    // 🔴 Отметку ставит ТОЛЬКО настоящий полный прогон. Раньше здесь стояло «всё, кроме
    // --list», и этого было мало: `main()` возвращает ноль ещё в четырёх местах, ничего
    // не запустив, - `--help`, неизвестный репозиторий, «изменений нет ни в одном
    // репозитории», пустая очередь. Один `node gates.js --help` писал `lastGates{code:0}`
    // по текущему диффу, после чего замок пропускал коммит, а report-honesty молчал про
    // «зелено» - при том что не выполнилась ни одна проверка. Отметка, которую можно
    // поставить, не прогоняя проверок, отменяет обе защиты разом.
    //
    // Второе ограничение - `--repo` и `--only`. Отпечаток считается по всем репозиториям,
    // поэтому частичный прогон штамповал бы зелёным весь кросс-репозиторный дифф:
    // `--repo=books --only=lint` объявлял бы проверенным и фронт, и документацию.
    // Частичный прогон полезен при работе, но отметку не ставит - её ставит только
    // `node gates.js` без сужающих ключей.
    if (result && result.ran && result.full) {
      try {
        const after = H.diffSnapshot();
        const moved = H.diffMoved(result.before, after);
        const markCode = moved.length ? 1 : code;
        H.markGates(markCode, result.before.labels);
        if (moved.length) {
          const why = H.movedWhy(moved, result.before, after);
          console.log('');
          console.log(
            'Дифф изменился во время прогона (' + L.shortList(moved) + '): ' +
              (code !== 0
                ? 'записана отметка о красном прогоне (код ' + code + ')'
                : 'записана отметка «не зелено» (код 1): гейты прошли, но изменившиеся файлы не проверены') +
              ', прогони gates.js заново в фоне' + (why.length ? '. Не прочитано: ' + why.join('; ') : '') + '.',
          );
        }
        code = markCode;
      } catch (e) {
        code = 1;
        console.error('Сверка диффа или отметка о прогоне упала (' + ((e && e.message) || e) + '): ' + markRed(result.before.labels) + ', код прогона 1.');
      }
    } else if (result && result.ran && !result.full) {
      console.log('');
      console.log(
        'Прогон был частичным (--repo или --only), отметка о зелёных гейтах не поставлена.\n' +
          'Замок коммита её не увидит: перед коммитом прогони node .claude/hooks/gates.js целиком в фоне (run_in_background: true).',
      );
    }

    process.exit(code);
  })();
}

module.exports = {
  selectGates,
  runGate,
  gateTimeoutSec,
  limits: { MAX_TIMEOUT_SEC, KILL_GRACE_MS, OUTPUT_HEAD_BYTES, OUTPUT_TAIL_BYTES },
  verdicts: VERDICTS.map((v) => v.parts.join('N')),
  outputBuffer,
  abortRunning,
};
