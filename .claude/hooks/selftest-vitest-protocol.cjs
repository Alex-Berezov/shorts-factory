'use strict';
/**
 * selftest-vitest-protocol.cjs - строки протокола дочернего vitest пробы test:int (E0-12AA, TECH_DEBT
 * 23.10.2026 E0-12T круг 2: строки были объявлены в двух файлах). Не хук: модуль самопроверки без
 * зависимостей. Его берут обе стороны протокола: ребёнок selftest-vitest.mjs (createRequire) и
 * selftest-int.js (require), который ждёт и разбирает ответ. Правка строки здесь меняет обе стороны
 * сразу; копию строки в другом файле ловит проба «протокол дочернего vitest - в одном модуле»
 * harness-selftest.js.
 *
 *   VITEST_MARK      - начало строки ответа в stdout: метка и JSON по парам;
 *   VITEST_EXIT_MARK - начало строки выхода с кодом, последней в stdout (обработчик exit ребёнка).
 */

const VITEST_MARK = 'selftest-vitest ';
const VITEST_EXIT_MARK = 'selftest-vitest-exit ';

module.exports = { VITEST_MARK, VITEST_EXIT_MARK };
