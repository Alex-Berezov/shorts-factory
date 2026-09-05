#!/usr/bin/env node
'use strict';
/**
 * qa-lock.js - Stop. Замок отдела контроля качества.
 *
 * Считает, сколько правок накопилось со времени последнего прогона /qa
 * (счётчик edits в общем файле состояния растит хук на запись файлов).
 * Перевалило за порог qaLock.threshold из общих правил - работу не закрываем,
 * пока не прошёл /qa.
 *
 * Счётчик и порог одни на все репозитории: /qa тоже идёт по всем сразу.
 * Обнуляет счётчик сама команда /qa. Хук его не трогает: иначе замок открывался бы
 * от одного лишь факта остановки.
 */

const L = require('./lib.js');

L.guard(async () => {
  const input = await L.readStdin();
  // защита от зацикливания: замечание уже выдано, второй заход молчит
  if (input && input.stop_hook_active === true) return;

  const rules = L.commonRules();
  const threshold =
    rules.qaLock && typeof rules.qaLock.threshold === 'number' ? rules.qaLock.threshold : 10;

  const state = L.readState();
  const edits = typeof state.edits === 'number' ? state.edits : 0;
  if (edits <= threshold) return;

  const since = state.lastQa ? 'Последний прогон: ' + state.lastQa + '.\n' : '';

  L.complain(
    'Накопилось ' + edits + ' изменений без прогона /qa, запусти его.\n' +
      'Порог - ' + threshold + '.\n' +
      since +
      'Пройдёт /qa - счётчик обнулится сам, и работу можно будет закрыть.\n' +
      'Замечания /qa разбери до конца, а не откладывай на потом.',
  );
});
