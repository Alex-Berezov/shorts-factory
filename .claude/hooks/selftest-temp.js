'use strict';
/**
 * selftest-temp.js - реестр временных каталогов прогона harness-selftest.js (E0-12T; решение
 * техлида B4 E0-12T 23.10.2026). Не хук: модуль самопроверки, Node без зависимостей. Его берут
 * через require и сама самопроверка, и дочерний node пробы обработчика exit (там каталог
 * снимается после exit процесса, который минует finally), - один модуль, без копии исходника.
 *
 * Выход через exit процесса здесь запрещён (статический кейс в harness-selftest.js): модуль
 * только создаёт и снимает каталоги, процессом распоряжается тот, кто его взял.
 */

/**
 * Реестр каталогов. deps - { fs, os, path, isNotFile } (isNotFile - L.isNotFile из lib.js).
 *   tempDir(prefix, parent) - каталог `sf-selftest-<prefix>-XXXXXX` в parent (по умолчанию
 *     os.tmpdir()), в реестре: made - все созданные, live - не снятые;
 *   dropTemp - снятие dir (opts - ниже): ссылки и junction внутри - unlink до рекурсивного удаления
 *     (L-028: удаление по ссылке не должно дойти до её цели, какой бы ни была реализация rmSync),
 *     затем rmSync с повтором (maxRetries: на Windows каталог, который только что держал дочерний
 *     процесс, отвечает EBUSY/EPERM); opts.rm - подмена rmSync для кейса;
 *   dropAll() - снять всё, что в live (обработчик exit; сбой одного каталога не мешает остальным);
 *   put(dir, rel, text) - файл пробы dir/rel (rel с «/», каталоги создаются), абсолютный путь;
 *   sweepStale(maxAgeMs, opts) - снятие каталогов прошлых прогонов старше maxAgeMs (ниже).
 * Каталоги, созданные не этим прогоном, реестр снимает только старше суток (sweepStale в начале прогона,
 * решение техлида Р3 E0-12AC): младше суток не трогает - их может держать параллельный прогон.
 */
function makeTempRegistry(deps) {
  const { fs, os, path, isNotFile } = deps;
  const PREFIX = 'sf-selftest-';
  const made = [];
  const live = new Set();
  const tempDir = (prefix, parent) => {
    const dir = fs.mkdtempSync(path.join(parent || os.tmpdir(), PREFIX + prefix + '-'));
    made.push(dir);
    live.add(dir);
    return dir;
  };
  const unlinkLinks = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (isNotFile(e)) return;
      throw e;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) fs.unlinkSync(p);
      else if (entry.isDirectory()) unlinkLinks(p);
    }
  };
  // снятие дерева dir: ссылки - unlink до рекурсивного удаления (L-028), rm - rmSync или подмена кейса;
  // retries - повторы rmSync на EBUSY/EPERM (по 100 мс)
  const removeTree = (dir, rm, retries) => {
    unlinkLinks(dir);
    rm(dir, { recursive: true, force: true, maxRetries: retries, retryDelay: 100 });
  };
  const dropTemp = (dir, opts) => {
    removeTree(dir, (opts && opts.rm) || fs.rmSync, 5);
    // вложенные каталоги реестра (tempDir с parent) уходят вместе с dir
    for (const d of Array.from(live)) if (d === dir || d.startsWith(dir + path.sep)) live.delete(d);
  };
  /**
   * Каталоги прошлых прогонов (E0-12AC, решение техлида Р3; TECH_DEBT 28.10.2026 E0-12AA круг 2: процесс,
   * убитый снаружи, обработчиков не зовёт, и его каталоги копятся): каталог parent (по умолчанию
   * os.tmpdir()) с именем на PREFIX, чей mtime (самого каталога, без обхода вглубь) старше maxAgeMs,
   * снимается тем же removeTree, что у снятия каталога реестра (ссылки - unlink), но без повторов rmSync:
   * старый каталог, занятый чужим процессом, занят и через полсекунды, а повторы на каждом таком каталоге
   * в начале каждого прогона - секунды синхронного ожидания; младший и с чужим префиксом не трогаются -
   * младший может держать параллельный прогон. Сбой снятия одного - «путь: текст» в failed, остальные
   * снимаются; сбой чтения parent - тоже в failed. opts.now - часы (по умолчанию Date.now()). Ответ -
   * { removed, failed }.
   */
  const sweepStale = (maxAgeMs, opts) => {
    const o = opts || {};
    const parent = o.parent || os.tmpdir();
    const now = o.now === undefined ? Date.now() : o.now;
    const removed = [];
    const failed = [];
    const why = (e) => (e && e.message) || String(e);
    let entries;
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch (e) {
      failed.push(parent + ': ' + why(e));
      return { removed, failed };
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue;
      const dir = path.join(parent, entry.name);
      try {
        if (now - fs.lstatSync(dir).mtimeMs <= maxAgeMs) continue;
        removeTree(dir, fs.rmSync, 0);
        removed.push(dir);
      } catch (e) {
        failed.push(dir + ': ' + why(e));
      }
    }
    return { removed, failed };
  };
  const dropAll = () => {
    for (const dir of Array.from(live)) {
      try {
        dropTemp(dir);
      } catch (_) {
        // выход процесса: назвать некому, остаток увидит счёт sf-selftest-* в %TEMP%
      }
    }
  };
  // файл пробы во временном каталоге: один помощник на все модули (TECH_DEBT 23.10.2026 E0-12U круг 2:
  // два локальных put) - rel с «/», каталоги создаются, возвращает абсолютный путь
  const put = (dir, rel, text) => {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
  };
  return { PREFIX, made, live, tempDir, dropTemp, dropAll, put, sweepStale };
}

module.exports = { makeTempRegistry };
