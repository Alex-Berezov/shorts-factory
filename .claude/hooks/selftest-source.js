'use strict';
/**
 * selftest-source.js - разбор исходника JS для статических проб самопроверки: один лексер на обвязку (ревью
 * E0-12AE, круг 2, Н6: прежде их было два - codeOnly в selftest-state.js и sourceLiterals в
 * selftest-gates-run.js, с разной полнотой). Не хук: модуль самопроверки, загрузка ничего не исполняет.
 *
 * lexJs(text) режет текст на куски { kind, text }: 'comment' (// до конца строки, /* … *\/), 'string' ('…' и "…"
 * до парной кавычки на той же строке, `…` - многострочно, ${…} не разбирается), 'regex' (литерал регулярного
 * выражения: / после оператора, скобки, начала текста или return/typeof/case) и 'code' - всё прочее. Куски
 * подряд дают исходный текст байт в байт. Потребители:
 *   codeOnly(text, blankStrings) - код без комментариев (пробелы на их месте, переводы строк сохранены - номера
 *     строк те же); blankStrings - содержимое строк тоже пробелами (текст сообщения - не вызов);
 *   sourceLiterals(text) - строковые литералы через перевод строки (строки вывода и подсказки).
 */

const REGEX_AFTER = /[(,=:[!&|?{};+\-*%<>~^]/;

function lexJs(text) {
  const src = String(text);
  const parts = [];
  let code = '';
  let prev = '';
  const flush = () => {
    if (code) parts.push({ kind: 'code', text: code });
    code = '';
  };
  // хвост кода для «return /re/»: последние символы кода без комментариев
  let tail = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j++;
      flush();
      parts.push({ kind: 'comment', text: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      flush();
      parts.push({ kind: 'comment', text: src.slice(i, stop) });
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && (c === '`' || src[j] !== '\n')) j += src[j] === '\\' ? 2 : 1;
      flush();
      parts.push({ kind: 'string', text: src.slice(i, Math.min(j + 1, src.length)) });
      i = j + 1;
      prev = c;
      tail = '';
      continue;
    }
    if (c === '/' && (prev === '' || REGEX_AFTER.test(prev) || /\b(return|typeof|case)\s*$/.test(tail))) {
      let j = i + 1;
      let cls = false;
      while (j < src.length && src[j] !== '\n') {
        const ch = src[j];
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (cls) cls = ch !== ']';
        else if (ch === '[') cls = true;
        else if (ch === '/') break;
        j++;
      }
      flush();
      parts.push({ kind: 'regex', text: src.slice(i, Math.min(j + 1, src.length)) });
      i = j + 1;
      prev = '/';
      tail = '';
      continue;
    }
    code += c;
    tail = (tail + c).slice(-16);
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  flush();
  return parts;
}

/** Код JS без комментариев (см. шапку); blankStrings - содержимое строк и шаблонов пробелами. */
function codeOnly(text, blankStrings) {
  return lexJs(text)
    .map((p) => {
      if (p.kind === 'comment') return p.text.replace(/[^\n]/g, ' ');
      if (p.kind === 'string' && blankStrings) return p.text[0] + p.text.slice(1, -1).replace(/[^\n]/g, ' ') + (p.text.length > 1 ? p.text.slice(-1) : '');
      return p.text;
    })
    .join('');
}

/** Строковые литералы исходника JS ('…', "…", `…`) через перевод строки; комментарии и регулярные выражения - нет. */
function sourceLiterals(text) {
  return lexJs(text)
    .filter((p) => p.kind === 'string')
    .map((p) => p.text)
    .join('\n');
}

module.exports = { codeOnly, sourceLiterals };
