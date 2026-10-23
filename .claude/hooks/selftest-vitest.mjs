/**
 * selftest-vitest.mjs - конфиги int-тестов для пробы test:int в harness-selftest.js (E0-12T,
 * решение техлида Р3 E0-12L, Р3 E0-12T). Не хук: дочерний процесс самопроверки.
 *
 * Аргументы - пары `<dir> <command>`: каталог пакета (абсолютный или от рабочего каталога) и
 * команда его скрипта test:int из dry-JSON turbo. По каждой паре флаги команды разбирает сам
 * vitest (`parseCLI` из `vitest/node`), конфиг, `setupFiles` и `globalSetup` после пресета -
 * тоже vitest (`createVitest` с теми же флагами, без запуска: `globalSetup` не исполняется, тесты
 * не ищутся). Нечётное число аргументов - ошибка каждой пары, до загрузки vitest.
 * Своего разбора JS здесь нет; команда только делится на слова по пробелам с учётом кавычек
 * (`-c "x y.ts"`), а команда с операторами оболочки - отказ пары, а не догадка.
 *
 * Вывод - одна строка `selftest-vitest <JSON>` в stdout: массив по парам в их порядке,
 * `{ dir, config, setupFiles, globalSetup }` (абсолютные пути, как их разрешил vitest) или
 * `{ dir, error }`. Ошибка пары и сбой загрузки vitest - в JSON, не кодом выхода. Последняя
 * строка - `selftest-vitest-exit <код>` из обработчика выхода: harness-selftest.js запускает
 * процесс без ожидания и ждёт её в файле stdout.
 *
 * Выход через exit процесса здесь запрещён (статический кейс в harness-selftest.js, решение
 * техлида Р3 E0-12T): vite 5 при загрузке конфига пакета `type: module` пишет рядом с конфигом
 * `<конфиг>.timestamp-<n>.mjs` и снимает его неожидаемым unlink; процесс выходит, когда цикл
 * событий опустел, - после снятия. Остаток ловит финальная сверка снимка дерева selftest.
 */
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// «файла нет» - один предикат обвязки (isNotFile из lib.js: ENOENT и ENOTDIR), без копии здесь
const { isNotFile } = createRequire(import.meta.url)('./lib.js');

/** Начало строки вывода; harness-selftest.js ищет его в stdout. */
const MARK = 'selftest-vitest ';

// Строка выхода с кодом - последней в stdout, при любом выходе с обработчиками (и после
// исключения): harness-selftest.js ждёт ребёнка, запущенного без ожидания, по ней, а не по событию.
process.on('exit', (code) => {
  process.stdout.write('selftest-vitest-exit ' + code + '\n');
});

/** Слово оболочки, которое меняет смысл команды: команда с ним - не простой вызов vitest. */
const SHELL_OPERATOR = /[;&|<>$`()]/;

/**
 * Команда words: слова по пробелам, `"…"` и `'…'` - одно слово без кавычек. Слово вне кавычек
 * с оператором оболочки - исключение.
 */
function commandWords(command) {
  const words = [];
  for (const m of String(command).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    if (m[3] !== undefined && SHELL_OPERATOR.test(m[3])) {
      throw new Error('команда ' + JSON.stringify(command) + ' - не простой вызов vitest (оператор оболочки в «' + m[3] + '»)');
    }
    words.push(m[1] ?? m[2] ?? m[3]);
  }
  return words;
}

/**
 * Конфиг, setupFiles и globalSetup пакета dir по его команде command (vitest - модуль vitest/node).
 * Все флаги, которые разобрал parseCLI, уходят в createVitest, как у настоящего `vitest run`
 * (`--root`, `--dir`, `--project` и прочие): иначе setupFiles разрешались бы не там, где при
 * запуске. Корень - `--root` от каталога пакета (рабочий каталог настоящего запуска) или сам
 * каталог; конфиг - от корня, как у createVitest.
 */
async function resolvePair(vitest, dir, command) {
  const { options } = vitest.parseCLI(commandWords(command));
  if (typeof options.config !== 'string' || options.config === '') {
    throw new Error('команда ' + JSON.stringify(command) + ' не называет конфиг через --config или -c');
  }
  const root = path.resolve(dir, typeof options.root === 'string' ? options.root : '.');
  const config = path.resolve(root, options.config);
  let file = false;
  try {
    file = statSync(config).isFile();
  } catch (e) {
    if (!isNotFile(e)) throw e;
  }
  if (!file) throw new Error('конфига ' + options.config + ' (--config команды ' + JSON.stringify(command) + ') нет на диске');
  const ctx = await vitest.createVitest('test', Object.assign({}, options, { config, root, watch: false }), {}, {});
  try {
    return { dir, config, setupFiles: [...ctx.config.setupFiles], globalSetup: [...ctx.config.globalSetup] };
  } finally {
    await ctx.close();
  }
}

const args = process.argv.slice(2);
const pairs = [];
for (let i = 0; i + 1 < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
const out = [];
// нечётное число аргументов - ошибка каждой пары до загрузки vitest: ответ по парам не построить
let loadError = args.length % 2 !== 0 ? 'аргументы - не пары <dir> <command>: ' + args.length + ' слов' : '';
let vitest = null;
if (!loadError) {
  try {
    vitest = await import('vitest/node');
  } catch (e) {
    loadError = 'vitest/node не загрузился: ' + ((e && e.message) || String(e));
  }
}
for (const [dir, command] of pairs) {
  if (loadError) {
    out.push({ dir, error: loadError });
    continue;
  }
  try {
    out.push(await resolvePair(vitest, dir, command));
  } catch (e) {
    out.push({ dir, error: (e && e.message) || String(e) });
  }
}
process.stdout.write(MARK + JSON.stringify(out) + '\n');
