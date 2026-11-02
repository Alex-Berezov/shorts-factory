'use strict';
/**
 * Формы импорта одной строкой - одна таблица для двух носителей (E0-12V, решение техлида В7):
 * пробы правил направления S07, S11, S15, S16 в harness-selftest.js и сверка тех же правил с таблицей
 * рёбер в test/dependency-direction.ts (directionRuleViolations). Данные без побочных эффектов.
 *
 * IMPORT_HEADS - ветви головы регулярки правил направления: `from` (from, export … from), `import`
 * (побочный import, import("…"), typeof import("…")) и `require` (require("…"), import X = require("…")).
 * IMPORT_FORMS - записи { head, form }: head - ветвь головы, которой строка поймана; form(spec) -
 * строка импорта спецификатора spec. Кавычки - все три, которые читает голова (", ', `).
 * Новая форма - запись здесь: её получают оба носителя. Первая запись ветви - та, что пробует её
 * самую узкую часть (у import - вызов import("…"), который держит `\(?` головы): спаун-пробы selftest
 * берут по одной форме на ветвь (oneOfEachHead), полноту форм x имён x кавычек держит сверка.
 */
const IMPORT_HEADS = ['from', 'import', 'require'];

const IMPORT_FORMS = [
  { head: 'from', form: (spec) => 'import { x } from "' + spec + '";' },
  { head: 'from', form: (spec) => "import type { X } from '" + spec + "';" },
  { head: 'from', form: (spec) => 'export * from "' + spec + '";' },
  { head: 'from', form: (spec) => "export { x } from '" + spec + "';" },
  { head: 'import', form: (spec) => 'const m = await import("' + spec + '");' },
  { head: 'import', form: (spec) => 'import "' + spec + '";' },
  { head: 'import', form: (spec) => "type M = typeof import('" + spec + "');" },
  { head: 'require', form: (spec) => 'const r = require("' + spec + '");' },
  { head: 'require', form: (spec) => 'import X = require("' + spec + '");' },
  { head: 'require', form: (spec) => 'const r = require(`' + spec + '`);' },
];

/** Первая запись forms каждой ветви IMPORT_HEADS, в порядке IMPORT_HEADS; ветвь без записи пропущена. */
function oneOfEachHead(forms) {
  return IMPORT_HEADS.map((head) => forms.find((entry) => entry.head === head)).filter((entry) => entry !== undefined);
}

module.exports = { IMPORT_HEADS, IMPORT_FORMS, oneOfEachHead };
