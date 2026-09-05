#!/usr/bin/env node
'use strict';
/**
 * protect-files.js - PreToolUse на Write|Edit|MultiEdit.
 *
 * Не даёт писать в файлы, которые ломать нельзя:
 *   rules.protected   - запрет на запись совсем;
 *   rules.createOnly  - создать новый файл можно, править существующий нельзя
 *                       (новая миграция - да, применённая - нет).
 *
 * Репозиторий определяется по пути каждого файла, а не по текущему каталогу:
 * агента запускают из папки над репозиториями, и один вызов инструмента может
 * тронуть файлы сразу двух проектов. У каждого свои правила, поэтому каждый файл
 * проверяется правилами своего репозитория, а в сообщениях путь подписан его именем.
 *
 * Разовое исключение - строка с путём в общем unlock.txt рядом с состоянием обвязки.
 * Строку можно писать и с именем репозитория, и без него.
 */

const fs = require('fs');
const path = require('path');
const L = require('./lib.js');

const UNLOCK_FILE = path.join(L.STATE_DIR, 'unlock.txt');

/** Абсолютный путь: относительные считаем от каталога запуска. */
function absOf(input, p) {
  if (path.isAbsolute(p)) return path.resolve(p);
  return path.resolve((input && input.cwd) || process.cwd(), p);
}

/** Первый шаблон из списка, под который подходит путь. */
function firstMatch(globs, relPath) {
  return (globs || []).find((g) => L.matchGlob(g, relPath)) || null;
}

function unlockHint(name) {
  return (
    'Если правка действительно нужна - впиши строку\n' +
    '  ' +
    name +
    '\n' +
    'в файл\n  ' +
    UNLOCK_FILE +
    '\nи повтори действие. Разрешение разовое, после работы строку убери.'
  );
}

L.guard(async () => {
  const input = await L.readStdin();

  for (const file of L.targetFiles(input)) {
    const abs = absOf(input, file);

    // файл вне известных репозиториев - не наше дело
    const repo = L.repoFor(abs);
    if (!repo) continue;

    const r = L.rel(repo.path, abs);
    if (!r || r.startsWith('..')) continue;

    const name = L.label(repo, r);
    if (L.isUnlocked(repo, r)) continue;

    const rules = L.rulesFor(repo);
    const protectedGlobs = rules.protected || [];
    const createOnly = rules.createOnly || [];
    if (!protectedGlobs.length && !createOnly.length) continue;

    const notes = rules.protectedNote || {};

    const hit = firstMatch(protectedGlobs, r);
    if (hit) {
      const why = notes[hit] ? '\nПочему: ' + notes[hit] : '';
      L.deny(
        'Файл под защитой: ' + name + '\n' +
          'Сработал шаблон: ' + hit + ' (правила репозитория ' + repo.name + ')' + why + '\n\n' +
          unlockHint(name),
      );
    }

    const only = firstMatch(createOnly, r);
    if (only) {
      let exists = false;
      try {
        exists = fs.statSync(path.resolve(repo.path, r)).isFile();
      } catch (_) {
        exists = false;
      }
      if (exists) {
        const why = notes[only] ? '\nПочему: ' + notes[only] : '';
        L.deny(
          'Этот файл можно только создавать, править существующий нельзя: ' + name + '\n' +
            'Сработал шаблон: ' + only + ' (правила репозитория ' + repo.name + ')' + why + '\n' +
            'Нужно изменение - заведи новый файл рядом, а не переписывай этот.\n\n' +
            unlockHint(name),
        );
      }
    }
  }
});
