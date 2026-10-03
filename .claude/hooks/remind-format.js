#!/usr/bin/env node
'use strict';
/**
 * remind-format.js - UserPromptSubmit. Второй уровень контроля формата: напоминание.
 *
 * На коротких сессиях молчит: пока ходов пользователя меньше MIN_TURNS, формат обычно
 * ещё держится сам. Дальше на каждый ход дописывает в конец контекста короткую памятку.
 * Замечание answer-length.js о длине прошлого ответа отдаётся на любом ходу, но только
 * своей сессии, и после выдачи снимается; замечания других сессий остаются на месте
 * (операции - раздел «состояние» lib.js). Без session_id на входе замечание не отдаётся
 * и состояние не пишется. Ничего не блокирует, выход всегда нулевой.
 */

const fs = require('fs');
const L = require('./lib.js');

const MIN_TURNS = 6;

const REMINDER =
  'Формат ответа держи такой: суть до трёх строк; затем строки-ключи\n' +
  'Задача / Решено за тебя / Проверки / Обвязка / Дальше - по одной каждая.\n' +
  'Подробности - в файл дела (tasks/), а не в чат. Без пересказа хода работы и вводных.\n';

L.guard(async () => {
  const input = await L.readStdin();

  const sessionId = L.sessionIdOf(input);

  const s = sessionId ? L.readState() : null;
  const taken = s ? L.takeLengthNote(s, sessionId) : { text: '', changed: false };

  const out = taken.text +
    (L.userTurnCount(input && input.transcript_path) < MIN_TURNS ? '' : REMINDER);

  // сначала агенту, потом состояние: замечание не снимается раньше, чем отдано.
  // Пишем синхронно: guard завершает процесс сразу после нас.
  if (out) {
    try {
      fs.writeSync(1, out);
    } catch (_) {
      /* некуда писать - не повод шуметь */
    }
  }
  if (taken.changed) L.writeState(s);
});
