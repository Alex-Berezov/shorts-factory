#!/usr/bin/env node
'use strict';
/**
 * diff-boundaries.js - Stop.
 *
 * Смотрит на дифф целиком, когда агент считает работу законченной, и не даёт сдать:
 *   - файлы под rules.protected            - трогать их нельзя вообще;
 *   - файлы под rules.diffBoundaries.forbidden - дампы, временные файлы, рабочие
 *     заметки, логи, отчёты сборки: в репозиторий они не едут;
 *   - незакрытые парные правки rules.crossChecks: изменил одно - обязан изменить второе
 *     (при requireNew - именно завести новый файл, например каталог миграции);
 *   - незакрытые парные правки rules.common.json/crossRepoChecks: то же самое, но когда
 *     стороны пары лежат в РАЗНЫХ репозиториях.
 *
 * Репозиториев несколько, и дифф может быть сразу в нескольких. Хук обходит их все,
 * каждый проверяет его собственными правилами и группирует замечания по репозиториям.
 *
 * Разовое исключение для первых двух пунктов - строка с путём в общем unlock.txt,
 * ровно как в protect-files.js: иначе агент упрётся в замечание, которое нечем снять.
 */

const L = require('./lib.js');
const H = require('./diff-hash.js');

/** Первый шаблон из списка, под который подходит путь. */
function firstMatch(globs, relPath) {
  return (globs || []).find((g) => L.matchGlob(g, relPath)) || null;
}

/**
 * Файлы, которых в базовой точке не было: неотслеживаемые плюс добавленные в диффе.
 *
 * 🔴 `AR`, а не `A`. Определение переименований у git включено по умолчанию, поэтому
 * `git mv app/[lang]/старый app/[lang]/новый` приходит буквой `R`: путь назначения есть
 * в `changed`, а в `--diff-filter=A` его нет вовсе. Правило с `ifNew` на таком диффе
 * замолчало бы ровно там, где появился новый публичный адрес, - то есть отказало бы
 * в пользу разрешения. Сильнее того, ответ зависел бы от индекса: незастейдженный `mv`
 * виден через `ls-files --others`, застейдженный - нет, и один и тот же перенос ловился
 * бы или пропускался в зависимости от того, был ли `git add`.
 */
function newFiles(repo, rules) {
  const set = new Set();
  const u = L.sh('git', ['ls-files', '--others', '--exclude-standard'], repo.path);
  if (u.ok) u.out.split('\n').filter(Boolean).forEach((f) => set.add(f));
  const base = L.baseRef(repo, rules);
  const a = L.sh('git', ['diff', '--name-only', '--diff-filter=AR', base], repo.path);
  if (a.ok) a.out.split('\n').filter(Boolean).forEach((f) => set.add(f));
  // Базовой точки может не быть вовсе (свежая машина, ветка сравнения не заведена):
  // тогда остаётся индекс против HEAD. Без этой ветки заведённый и уже добавленный
  // в индекс файл выпадает отовсюду - в `--diff-filter` его не с чем сравнивать,
  // а в `ls-files --others` он уже не попадает. Паритет с `newLabels()` в diff-hash.js.
  if (!a.ok || !a.out) {
    const c = L.sh('git', ['diff', '--name-only', '--diff-filter=AR', '--cached'], repo.path);
    if (c.ok) c.out.split('\n').filter(Boolean).forEach((f) => set.add(f));
  }
  return set;
}

/**
 * Как вернуть файл на место. Отслеживаемый гит вернёт сам, нового файла в базе не было -
 * его надо просто убрать, git checkout тут бесполезен.
 */
function howToRevert(repo, relPath) {
  if (L.isTracked(repo, relPath)) {
    return 'верни его к исходному виду: git -C ' + repo.path + ' checkout -- ' + relPath;
  }
  return 'файл новый, в базовой точке его не было: удали его или впиши в .gitignore';
}

/**
 * Парные правки через границу репозитория.
 *
 * 🔴 crossChecks в rules.<репо>.json обходят репозитории по одному и видят только свой дифф.
 * Пара, у которой одна сторона в books, а вторая в books-front, не проверялась ничем: обе
 * стороны собираются, гейты чистые, отказ вылезает на живом запросе. Ровно эти пары названы
 * в D:/newDev/CLAUDE.md как «правки, которые всегда затрагивают два репозитория».
 *
 * 🔴 База сравнения здесь НЕ та, что у checkRepo. checkRepo идёт от baseRef, а он на всех
 * трёх репозиториях сейчас отдаёт HEAD - работа ведётся прямо в main, и в дифф попадает
 * только незакоммиченное. Для пары это ровно наоборот тому, что нужно: CLAUDE.md требует
 * коммитить парную правку двумя отдельными коммитами, и первый же коммит вынес бы свою
 * половину из диффа - встречное правило тут же пожаловалось бы на «второго нет». Поэтому
 * помеченный список берётся из diff-hash.js, который считает от origin/<база>: закоммиченная,
 * но не запушенная половина в нём остаётся, и пара видна целиком до самого пуша.
 *
 * Выход один - строка в unlock.txt: либо помеченный путь файла-повода, либо номер правила
 * (XR03). Без неё правило вида «любой dto тянет за собой документ» не снять ничем, а
 * неснимаемое замечание кончается тем, что хук выключают целиком.
 *
 * Оба аргумента необязательны и нужны матрице проб: живой дифф трёх репозиториев под пару
 * не подстроить, а живой unlock.txt делает пробы зависимыми от постороннего состояния -
 * строка снятия, которую велит писать сам хук, красила бы самопроверку.
 */
function checkCross(labelled, unlockedList, newList, triggerScope) {
  const checks = L.commonRules().crossRepoChecks || [];
  if (!checks.length) return [];

  const files = Array.isArray(labelled) ? labelled : H.diffLabels();
  if (!files.length) return [];

  // Поводом может быть не весь дифф, а его часть: коммит-гейт сужает повод до репозитория,
  // в который коммитят, чтобы не отказывать из-за пары, до которой работа ещё не дошла.
  // Закрытие ищется всегда по всему диффу - вторая половина на то и в другом репозитории.
  const causes = Array.isArray(triggerScope) ? triggerScope : files;

  // Список заведённых файлов считается лениво: он нужен только правилам с ifNew,
  // а каждый его подсчёт - это по два git на репозиторий.
  let fresh = Array.isArray(newList) ? newList : null;
  const isNew = (f) => {
    if (fresh === null) fresh = H.newLabels();
    return fresh.indexOf(f) !== -1;
  };

  const unlocked = Array.isArray(unlockedList) ? unlockedList : L.unlockList();
  const isUnlocked = (f) => unlocked.some((u) => u === f || L.matchGlob(u, f));
  const problems = [];

  for (const c of checks) {
    if (!c || !c.ifChanged || !c.requireChanged) continue;
    if (c.id && unlocked.indexOf(c.id) !== -1) continue;

    // unless - вычет из повода. Без него ifChanged приходится держать широким («любой dto»),
    // и правило поднимается на спеке самой dto или на query-параметрах, которых фронт как
    // схему ответа не разбирает вовсе. Правило, шумящее на рядовой правке, кончается тем,
    // что его снимают строкой в unlock.txt каждый заход, а потом перестают читать вовсе.
    const skip = c.unless || [];
    const trigger = causes.filter(
      (f) =>
        L.matchGlob(c.ifChanged, f) &&
        !skip.some((u) => L.matchGlob(u, f)) &&
        // ifNew - повод только у ЗАВЕДЁННОГО файла. Новый раздел сайта и правка существующей
        // страницы попадают под один и тот же шаблон пути, и без этого признака правило про
        // публичные маршруты поднималось бы на каждой правке любой страницы.
        (!c.ifNew || isNew(f)),
    );
    if (!trigger.length) continue;
    if (trigger.every(isUnlocked)) continue; // все поводы сняты поимённо

    // unless вычитается и из ЗАКРЫТИЯ, а не только из повода. Иначе пара закрывалась бы
    // файлом, который сама же считает к делу не относящимся: правка спеки dto засчитывалась
    // как «вторая сторона контракта тронута», хотя контракт при этом не менялся.
    if (
      files.some(
        (f) => L.matchGlob(c.requireChanged, f) && !skip.some((u) => L.matchGlob(u, f)),
      )
    ) {
      continue;
    }

    problems.push(
      '  ' + trigger.slice(0, 3).join(', ') +
        (trigger.length > 3 ? ' и ещё ' + (trigger.length - 3) : '') + '\n' +
        '    правило ' + (c.id || 'парная правка через границу') +
        ': изменено одно, а второго в диффе нет\n' +
        '    не хватает: изменений в ' + c.requireChanged +
        (c.message ? '\n    ' + c.message : '') + '\n' +
        '    ложная тревога - сними строкой в unlock.txt: ' + (c.id || trigger[0]),
    );
  }
  return problems;
}

/** Замечания по одному репозиторию. Пусто - тут всё в порядке. */
function checkRepo(repo, rules, changed) {
  const protectedGlobs = rules.protected || [];
  const forbidden = (rules.diffBoundaries && rules.diffBoundaries.forbidden) || [];
  const crossChecks = rules.crossChecks || [];
  if (!protectedGlobs.length && !forbidden.length && !crossChecks.length) return [];

  const notes = rules.protectedNote || {};
  const problems = [];

  // 1. лишнее в диффе
  for (const r of changed) {
    if (L.isUnlocked(repo, r)) continue;

    const hit = firstMatch(protectedGlobs, r);
    if (hit) {
      problems.push(
        '  ' + r + '\n' +
          '    файл под защитой, шаблон ' + hit +
          (notes[hit] ? '\n    почему: ' + notes[hit] : '') + '\n' +
          '    ' + howToRevert(repo, r),
      );
      continue;
    }

    const bad = firstMatch(forbidden, r);
    if (bad) {
      problems.push(
        '  ' + r + '\n' +
          '    такому файлу в диффе не место, шаблон ' + bad +
          (notes[bad] ? '\n    почему: ' + notes[bad] : '') + '\n' +
          '    убери его из диффа: удали файл или впиши его в .gitignore',
      );
    }
  }

  // 2. парные правки
  problems.push(...crossProblems(repo, crossChecks, changed, newFiles(repo, rules)));

  return problems;
}

/**
 * Парные правки внутри одного репозитория. Вынесено из checkRepo чистой функцией
 * ради матрицы проб: живым диффом трёх репозиториев ни `ifNew`, ни снятие через
 * unlock.txt не подстроить, а ветка без пробы - ветка, о поломке которой узнают
 * на чужой задаче.
 */
function crossProblems(repo, crossChecks, changed, created, unlockedList) {
  // Список снятий - параметром, как у checkCross: матрица проб подставляет свой,
  // живой запуск берёт unlock.txt.
  const unlocked = Array.isArray(unlockedList) ? unlockedList : L.unlockList();
  const isUnlocked = (f) =>
    unlocked.some((u) => u === f || u === L.label(repo, f) || L.matchGlob(u, f));
  const problems = [];
  for (const c of crossChecks) {
    if (!c || !c.ifChanged || !c.requireChanged) continue;
    // Снятие поимённо - как в checkCross. Раньше этот цикл unlock.txt не читал вовсе,
    // и его находку нельзя было снять ничем: ни строкой с идентификатором правила,
    // ни строкой с путём. Правило, которое нечем снять, чинят правкой самого правила -
    // то есть каждая ложная тревога стоит правки обвязки.
    if (c.id && unlocked.indexOf(c.id) !== -1) continue;
    // ifNew - повод только у ЗАВЕДЁННОГО файла, по образцу checkCross выше. Новый раздел
    // сайта и правка существующей страницы попадают под один и тот же шаблон пути, и без
    // этого признака правило про новый раздел поднималось бы на каждой правке любой уже
    // существующей страницы.
    const trigger = changed.filter(
      (f) => L.matchGlob(c.ifChanged, f) && (!c.ifNew || created.has(f)),
    );
    if (!trigger.length) continue;
    if (trigger.every(isUnlocked)) continue; // все поводы сняты поимённо

    const found = changed.filter(
      (f) => L.matchGlob(c.requireChanged, f) && (!c.requireNew || created.has(f)),
    );
    if (found.length) continue;

    problems.push(
      '  ' + trigger.slice(0, 3).join(', ') + (trigger.length > 3 ? ' и ещё ' + (trigger.length - 3) : '') + '\n' +
        '    правило ' + (c.id || 'парная правка') + ': изменено одно, а второго в диффе нет\n' +
        '    не хватает: ' + (c.requireNew ? 'нового файла по шаблону ' : 'изменений в ') + c.requireChanged +
        (c.message ? '\n    ' + c.message : '') + '\n' +
        '    ложная тревога - сними строкой в unlock.txt: ' + (c.id || trigger[0]),
    );
  }

  return problems;
}

// Матрица проб зовёт checkCross и crossProblems напрямую: на живом диффе трёх
// репозиториев ни одну пару не подстроить, а непроверенный хук ничем не лучше
// отсутствующего.
module.exports = { checkCross, crossProblems };

if (require.main !== module) return;

L.guard(async () => {
  const input = await L.readStdin();
  // защита от зацикливания: замечание уже выдано, второй заход молчит.
  // false, а не true: это молчание, а не работа, и отметку о поломке оно не снимает.
  if (input && input.stop_hook_active === true) return false;

  // 🔴 Раннего выхода по пустому L.allChanged() здесь больше нет. allChanged считает
  // от baseRef, то есть от HEAD, и после коммита отдаёт пустоту - а пара живёт до пуша.
  const blocks = [];
  for (const g of L.allChanged()) {
    const problems = checkRepo(g.repo, g.rules, g.files);
    if (!problems.length) continue;
    blocks.push(g.repo.name + ':\n' + problems.join('\n\n'));
  }

  const cross = checkCross();
  if (cross.length) blocks.push('через границу репозиториев:\n' + cross.join('\n\n'));

  if (!blocks.length) return true;

  L.complain(
    'Дифф вышел за границы, работу так сдавать нельзя.\n\n' +
      blocks.join('\n\n') + '\n\n' +
      'Разбери каждый пункт: лишнее убери из диффа, недостающее добавь. Потом заканчивай.\n' +
      'Считаешь замечание ложным - это развилка, а не повод для остановки: неси её\n' +
      'техлиду (.claude/agents/techlead.md), запиши решение строкой в\n' +
      'docs/DECISIONS.md и сними замечание строкой в unlock.txt.',
  );
}, { failClosed: true, stop: true, name: 'Проверка границ диффа (diff-boundaries.js)' });
