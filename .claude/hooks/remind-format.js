#!/usr/bin/env node
'use strict';
/**
 * remind-format.js - UserPromptSubmit. Второй уровень контроля формата: напоминание.
 *
 * На коротких сессиях молчит: пока ходов пользователя меньше MIN_TURNS, формат обычно
 * ещё держится сам. Дальше на каждый ход дописывает в конец контекста короткую памятку.
 * Ничего не блокирует, выход всегда нулевой.
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

  if (L.userTurnCount(input && input.transcript_path) < MIN_TURNS) return;

  // пишем синхронно: guard завершает процесс сразу после нас
  try {
    fs.writeSync(1, REMINDER);
  } catch (_) {
    /* некуда писать - не повод шуметь */
  }
});
