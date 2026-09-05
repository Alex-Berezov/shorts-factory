#!/usr/bin/env node
'use strict';
/**
 * answer-length.js - Stop. Третий уровень контроля формата: объём ответа.
 *
 * Берёт последнее сообщение ассистента, меряет в нём прозу (код, команды и таблицы
 * не считаются) и, если вышло больше answerFormat.maxProse из общих правил, возвращает
 * агенту замечание с требованием переписать ответ короче и по формату.
 *
 * Порог один на все репозитории: ответ у агента общий, а не отдельный на каждый проект.
 * Ничего не проверяет по коду и никогда не запрещает действий: только объём текста.
 */

const L = require('./lib.js');

const DEFAULT_MAX = 2200;
const DEFAULT_MAX_LINES = 40;

function render(len, max) {
  const over = len - max;
  return (
    'Ответ слишком длинный: ' + len + ' знаков прозы при пороге ' + max +
    ', перебор ' + over + '.\n' +
    'Перепиши тот же ответ короче, ничего не теряя по смыслу, и держи формат:\n' +
    '1) что сделано по сути - до трёх строк;\n' +
    '2) Проверки: команда - результат, по строке на каждую команду;\n' +
    '3) что осталось или что может сломаться - только если это правда есть,\n' +
    '   иначе третий блок просто опусти.\n' +
    'Код, команды и таблицы в объём не входят - режь рассуждения, пересказ хода\n' +
    'работы и вводные обороты.\n'
  );
}

/** Строк в ответе - считаем всё: прозу, таблицы, списки. Простыня ловится именно здесь. */
function lineCount(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '').length;
}

function renderLines(lines, max) {
  return (
    'Ответ слишком длинный: ' + lines + ' непустых строк при пороге ' + max + '.\n' +
    'Подробности в чат не идут - им место в файле дела:\n' +
    '  путь лежит в .claude/.task-current;\n' +
    '  нет пути - заведи tasks/<ГГГГ-ММ-ДД>-<id-задачи>.md и запиши его туда.\n' +
    'Перенеси в дело таблицы находок, план, список файлов, полный вывод команд и разбор\n' +
    'того, как ты работал. В чате оставь только это:\n' +
    '1) суть - до двух строк;\n' +
    '2) что требует решения человека - или «вопросов нет»;\n' +
    '3) что учесть - до трёх строк, только дорогое;\n' +
    '4) итог проверок одной строкой;\n' +
    '5) путь к файлу дела.\n'
  );
}

L.guard(async () => {
  const input = await L.readStdin();

  // повторный заход после нашего же замечания - молчим, иначе получится петля
  if (input && input.stop_hook_active === true) return;

  const text = L.lastAssistantText(input && input.transcript_path);
  if (!text) return; // транскрипта нет или последний ответ пуст

  const fmt = L.commonRules().answerFormat || {};
  const raw = Number(fmt.maxProse);
  const max = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX;

  const rawLines = Number(fmt.maxLines);
  const maxLines = Number.isFinite(rawLines) && rawLines > 0 ? Math.floor(rawLines) : DEFAULT_MAX_LINES;

  const lines = lineCount(text);
  if (lines > maxLines) L.complain(renderLines(lines, maxLines));

  const len = L.proseLength(text);
  if (len > max) L.complain(render(len, max));
});
