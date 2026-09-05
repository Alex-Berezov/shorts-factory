#!/usr/bin/env node
'use strict';
/**
 * scope.js - PreToolUse на Write|Edit|MultiEdit.
 *
 * Держит правки в рамках начатой задачи. Зона считается по каждому репозиторию
 * отдельно: файлы его текущего диффа относительно базовой ветки плюс папки этих
 * файлов - сосед в той же папке свой. Репозиторий определяется по пути файла,
 * так что один вызов инструмента может проверяться сразу двумя зонами.
 * Счётчик уходов в сторону при этом общий и лежит в .qa-state рядом с хуками.
 *
 * Режим и зона берутся из общего scope.txt:
 *
 *   # комментарий - обычно дата фиксации и имя задачи
 *   mode: strict                  strict | soft | off; допустимо и одиноким словом
 *   books-app-docs/scripts/**     строки зоны, каждая с именем репозитория
 *
 * Режимы:
 *   strict - любой выход за зону запрещён;
 *   off    - хук молчит;
 *   пусто или файла нет - мягкий режим: уходы копятся в .qa-state
 *   (поле strayFiles) и запрет включается, когда их станет больше scope.softLimit.
 *
 * Строк зоны нет - зона выводится из диффа, как было всегда. Строки есть - они и есть зона,
 * плюс файлы текущего диффа. Явная зона появилась потому, что зона из диффа не умеет одного:
 * пустить первый файл в новую папку. Папки нет в диффе, пока в ней нет файлов, а файла не
 * создать, пока папки нет в зоне - в строгом режиме новый модуль было не начать вовсе,
 * и рамки приходилось снимать на всю задачу.
 */

const path = require('path');
const L = require('./lib.js');

const SCOPE_FILE = path.join(L.STATE_DIR, 'scope.txt');

/** Абсолютный путь: относительные считаем от каталога запуска. */
function absOf(input, p) {
  if (path.isAbsolute(p)) return path.resolve(p);
  return path.resolve((input && input.cwd) || process.cwd(), p);
}

function dirOf(relPath) {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? '.' : relPath.slice(0, i);
}

/**
 * Служебные файлы самой обвязки в зону не входят и в счёт не идут.
 *
 * 🔴 Проверок две, и вторая появилась 02.09.2026 вместе с записью `.claude`
 * в `repos.json` (решение техлида, `decisions-log.md`). Первая ловит обвязку, когда
 * путь считается от корня соседнего репозитория и потому начинается с `.claude/`.
 * Вторая - когда корнем стала сама обвязка: тогда `L.rel` даёт `hooks/gates.js`
 * без всякого префикса, и одной первой проверки уже не хватает.
 *
 * Без второй правка обвязки попадала бы в зону задачи и в счётчик `softLimit`:
 * тринадцатый файл останавливал бы отказом саму работу над обвязкой. Все остальные
 * гарды её видеть обязаны - `scope.js` единственное исключение, и оно намеренное.
 */
function isHarness(p, repo) {
  if (repo && repo.name === '.claude') return true;
  return p === '.claude' || p.startsWith('.claude/');
}

/** Короткий список: не больше limit пунктов, остальное числом. */
function listSome(items, limit) {
  const arr = items.slice(0, limit).map((s) => '  ' + s);
  if (items.length > limit) arr.push('  и ещё ' + (items.length - limit));
  return arr.join('\n');
}

/** Описание зоны одного репозитория, все пути подписаны его именем. */
function zoneText(repo, files, dirs, globs, explicit, outsideZone) {
  const head = outsideZone
    ? 'Репозиторий ' + repo.name + ' в явной зоне задачи не назван вовсе, поэтому в задачу\n' +
      'не входит. Своими остаются только файлы, которые уже в диффе:'
    : explicit
      ? 'Зона задачи в репозитории ' + repo.name +
        ' задана явно в scope.txt.\nСвоими считаются файлы:'
      : 'Зона задачи в репозитории ' + repo.name +
        ' - это файлы его диффа относительно базовой ветки:';
  const parts = [head, listSome(files.map((f) => L.label(repo, f)), 20)];
  if (dirs.length) {
    parts.push('и любые файлы в их папках:');
    parts.push(
      listSome(
        dirs.map((d) => (d === '.' ? 'корень ' + repo.name : L.label(repo, d) + '/')),
        12,
      ),
    );
  }
  if (globs.length) {
    parts.push('и всё, что подходит под шаблоны:');
    parts.push(listSome(globs.map((g) => L.label(repo, g)), 12));
  }
  return parts.join('\n');
}

/** Порог мягкого режима: сначала правила репозитория, потом общие, потом 12. */
function limitOf(scope) {
  if (typeof scope.softLimit === 'number') return scope.softLimit;
  const common = (L.commonRules() || {}).scope || {};
  if (typeof common.softLimit === 'number') return common.softLimit;
  return 12;
}

/**
 * Строки явной зоны, относящиеся к этому репозиторию.
 *
 * Каждая строка scope.txt начинается с имени репозитория - `books-app-docs/scripts/**`, -
 * потому что рядом лежат три репозитория и путь без имени ничей. Строка с неизвестным
 * префиксом не отбрасывается молча: она попадает в `unknown` и называется в тексте отказа.
 * Опечатка в зоне сужает её, а сужение, о котором никто не сказал, - это запрет без причины.
 */
function entriesFor(repo, entries) {
  const mine = [];
  const unknown = [];
  const prefix = repo.name + '/';
  for (const e of entries) {
    if (e === repo.name) {
      mine.push('**');
      continue;
    }
    if (e.startsWith(prefix)) {
      mine.push(e.slice(prefix.length));
      continue;
    }
    if (!L.knownRepos().some((r) => e === r.name || e.startsWith(r.name + '/'))) unknown.push(e);
  }
  return { mine, unknown };
}

/**
 * Зона репозитория: явная, если она задана в scope.txt, иначе выведенная из диффа.
 *
 * Явная зона - это ответ на дефект, ради которого она заводилась: зона из диффа это «файлы
 * диффа плюс их папки», и первый файл в новой папке в неё не попадает никогда - папки нет
 * в диффе, потому что в ней нет файлов. Строгий режим не давал начать новый модуль вовсе.
 *
 * Даже при явной зоне файлы текущего диффа остаются своими. Иначе человек, зафиксировавший
 * зону, получал бы запрет на правку файла, который сам же и менял пять минут назад.
 */
function zoneOf(repo, rules, entries) {
  const changed = L.changedFiles(repo, rules).filter((f) => !isHarness(f, repo));
  const { mine, unknown } = entriesFor(repo, entries);

  if (!mine.length) {
    // Зона задана, но этот репозиторий в ней не назван - значит он и не в задаче. Правка
    // в соседнем репозитории «заодно» запрещена отдельно (D:/newDev/CLAUDE.md, запрет 3),
    // и явная зона - как раз то место, где человек говорит, куда можно. Уже изменённые
    // файлы остаются своими: зону фиксируют по ходу задачи, а не до её начала.
    if (entries.length) {
      return {
        explicit: true,
        outsideZone: true,
        unknown,
        files: new Set(changed),
        dirs: new Set(),
        globs: [],
        empty: false,
      };
    }
    return {
      explicit: false,
      outsideZone: false,
      unknown,
      files: new Set(changed),
      dirs: new Set(changed.map(dirOf)),
      globs: [],
      empty: !changed.length,
    };
  }

  const files = new Set(changed);
  const dirs = new Set();
  const globs = [];
  for (const pattern of mine) {
    if (pattern.includes('*')) {
      globs.push(pattern);
      continue;
    }
    // Конкретный путь тянет за собой свою папку - сосед по модулю почти всегда свой.
    files.add(pattern);
    dirs.add(dirOf(pattern));
  }
  return { explicit: true, outsideZone: false, unknown, files, dirs, globs, empty: false };
}

L.guard(async () => {
  const input = await L.readStdin();

  const { mode, entries } = L.scopeConfig();
  if (mode === 'off') return;

  // раскладываем запрошенные файлы по репозиториям: у каждого свои правила и свой дифф
  const asked = new Map();
  for (const file of L.targetFiles(input)) {
    const abs = absOf(input, file);
    const repo = L.repoFor(abs);
    if (!repo) continue; // файл вне наших репозиториев
    const r = L.rel(repo.path, abs);
    if (!r || r.startsWith('..')) continue;
    if (isHarness(r, repo)) continue;
    let entry = asked.get(repo.path);
    if (!entry) {
      entry = { repo, files: [] };
      asked.set(repo.path, entry);
    }
    entry.files.push(r);
  }
  if (!asked.size) return;

  const stray = [];
  const zones = [];
  const limits = [];
  const unknownEntries = [];

  for (const entry of asked.values()) {
    const repo = entry.repo;
    const rules = L.rulesFor(repo);
    const scope = rules.scope;
    if (!scope) continue; // рамки для этого репозитория не настроены

    const zone = zoneOf(repo, rules, entries);
    unknownEntries.push.apply(unknownEntries, zone.unknown);
    // дифф пуст и явной зоны нет - задача только началась, зоны ещё нет
    if (zone.empty) continue;

    const allowed = scope.alwaysAllowed || [];

    const out = [];
    for (const r of entry.files) {
      if (L.matchAny(allowed, r)) continue; // тесты, документация, миграции - всегда можно
      if (zone.files.has(r)) continue;
      if (zone.dirs.has(dirOf(r))) continue;
      if (L.matchAny(zone.globs, r)) continue;
      out.push(L.label(repo, r));
    }
    if (!out.length) continue;

    stray.push.apply(stray, out);
    zones.push(
      zoneText(
        repo,
        Array.from(zone.files).sort(),
        Array.from(zone.dirs).sort(),
        zone.globs.slice().sort(),
        zone.explicit,
        zone.outsideZone,
      ),
    );
    limits.push(limitOf(scope));
  }
  if (!stray.length) return;

  const zone =
    zones.join('\n\n') +
    (unknownEntries.length
      ? '\n\nСтроки scope.txt, не относящиеся ни к одному репозиторию, - зона от них не выросла:\n' +
        listSome(Array.from(new Set(unknownEntries)), 10) +
        '\nСтрока зоны обязана начинаться с имени репозитория из hooks/repos.json: ' + L.knownRepos().map((r) => r.name).join(', ') + '.'
      : '');

  if (mode === 'strict') {
    L.deny(
      'Строгий режим рамок: файл вне зоны задачи.\n' +
        'Просишь править:\n' + listSome(stray, 10) + '\n\n' +
        zone +
        '\n\nПравка нужна по делу - заведи отдельную запись LEGACY-NNN, а спорную границу\n' +
        'отнеси техлиду (.claude/agents/techlead.md) и запиши его решение в\n' +
        'docs/DECISIONS.md. Либо сними строгий режим:\n' +
        'первая строка файла\n  ' + SCOPE_FILE,
    );
  }

  // мягкий режим: копим уходы в сторону, счётчик один на все репозитории
  const limit = Math.min.apply(null, limits.length ? limits : [12]);
  const state = L.readState();
  const prev = Array.isArray(state.strayFiles) ? state.strayFiles : [];
  const all = Array.from(new Set(prev.concat(stray)));
  state.strayFiles = all;
  L.writeState(state);

  if (all.length > limit) {
    L.deny(
      'Задача расползлась: файлов вне зоны уже ' + all.length + ' при пороге ' + limit + '.\n' +
        'Остановись, ничего больше не правь и неси развилку техлиду\n' +
        '(.claude/agents/techlead.md): «это всё ещё одна задача или из неё выросла вторая».\n\n' +
        'Файлы вне зоны:\n' + listSome(all, 30) + '\n\n' +
        zone +
        '\n\nРешение техлида запиши строкой в docs/DECISIONS.md.\n' +
        'Сказал «одна задача» - очисти поле strayFiles в файле\n  ' + L.statePath() +
        '\nСказал «вторая» - заведи LEGACY-NNN и верни лишние файлы к исходному виду.',
    );
  }
});
