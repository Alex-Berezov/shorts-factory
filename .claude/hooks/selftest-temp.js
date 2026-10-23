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
 *   dropTemp(dir, opts) - снятие: ссылки и junction внутри - unlink до рекурсивного удаления
 *     (L-028: удаление по ссылке не должно дойти до её цели, какой бы ни была реализация rmSync),
 *     затем rmSync с повтором (maxRetries: на Windows каталог, который только что держал дочерний
 *     процесс, отвечает EBUSY/EPERM); opts.rm - подмена rmSync для кейса;
 *   dropAll() - снять всё, что в live (обработчик exit; сбой одного каталога не мешает остальным).
 * Каталоги, созданные не этим прогоном, реестр не трогает: их может держать параллельный прогон.
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
  const dropTemp = (dir, opts) => {
    unlinkLinks(dir);
    const rm = (opts && opts.rm) || fs.rmSync;
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    // вложенные каталоги реестра (tempDir с parent) уходят вместе с dir
    for (const d of Array.from(live)) if (d === dir || d.startsWith(dir + path.sep)) live.delete(d);
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
  return { PREFIX, made, live, tempDir, dropTemp, dropAll };
}

module.exports = { makeTempRegistry };
