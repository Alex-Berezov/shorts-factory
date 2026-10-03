#!/usr/bin/env node
'use strict';
/**
 * answer-length.js - Stop. Третий уровень контроля формата: объём ответа.
 *
 * Берёт последнее сообщение ассистента, меряет в нём прозу (код, команды и таблицы
 * не считаются) и строки. Перебор порога answerFormat.maxProse / maxLines не возвращает
 * ответ на переписывание - иначе владелец видит тот же ответ дважды. Замечание кладётся
 * в состояние под номером сессии (lengthNotes, операции - раздел «состояние» lib.js),
 * и remind-format.js отдаёт его агенту в начале следующего хода той же сессии. Если
 * следующего хода нет (отчёт /auto, затем /clear), замечание не доходит: длину отчёта
 * там держит форма auto.md / output-styles/short.md.
 *
 * Меряется всегда последний ответ, в том числе заход после отказа другого Stop-хука
 * (stop_hook_active): сам хук не блокирует, петли нет, а замечание должно описывать
 * ответ, который владелец увидит. Ответ в пределах порога или без текста снимает
 * замечание своей сессии. Без session_id на входе хук ничего не пишет: адресата нет.
 * Состояние пишется, только если оно изменилось.
 *
 * Порог один на все репозитории: ответ у агента общий, а не отдельный на каждый проект.
 * Ничего не блокирует, выход всегда нулевой.
 */

const L = require('./lib.js');

const DEFAULT_MAX = 2200;
const DEFAULT_MAX_LINES = 40;

function render(len, max) {
  return (
    'Прошлый ответ вышел длиннее порога: ' + len + ' знаков прозы при ' + max + '.\n' +
    'Не переписывай его; этот ответ держи короче - режь рассуждения, пересказ хода\n' +
    'работы и вводные обороты. Код, команды и таблицы в объём не входят.\n'
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
    'Прошлый ответ вышел длиннее порога: ' + lines + ' непустых строк при ' + max + '.\n' +
    'Не переписывай его; подробности клади в файл дела (путь в .claude/.task-current;\n' +
    'нет задачи - в чат только суть), в чате - отчёт по output-styles/short.md.\n'
  );
}

function noteFor(text) {
  if (!text) return '';
  const fmt = L.commonRules().answerFormat || {};
  const raw = Number(fmt.maxProse);
  const max = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX;

  const rawLines = Number(fmt.maxLines);
  const maxLines = Number.isFinite(rawLines) && rawLines > 0 ? Math.floor(rawLines) : DEFAULT_MAX_LINES;

  const lines = lineCount(text);
  if (lines > maxLines) return renderLines(lines, maxLines);
  const len = L.proseLength(text);
  if (len > max) return render(len, max);
  return '';
}

L.guard(async () => {
  const input = await L.readStdin();
  const sessionId = L.sessionIdOf(input);
  if (!sessionId) return; // некому адресовать замечание

  const note = noteFor(L.lastAssistantText(input && input.transcript_path));

  const s = L.readState();
  const changed = note
    ? L.putLengthNote(s, sessionId, note, Date.now())
    : L.dropLengthNote(s, sessionId);
  if (changed) L.writeState(s);
});
