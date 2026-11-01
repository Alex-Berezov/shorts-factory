#!/usr/bin/env node
'use strict';
/**
 * diff-hash.js - отпечаток текущего диффа и общий формат отметок в .qa-state.
 *
 * Отметка «/qa прошёл» и отметка «гейты зелёные» сами по себе ничего не стерегут:
 * они остаются в состоянии от прошлой задачи и открывают замок уже другому диффу.
 * Поэтому обе отметки хранятся вместе с отпечатком того диффа, по которому их поставили,
 * а commit-gate.js и report-honesty.js сравнивают отпечаток с текущим.
 *
 * Отпечаток - sha1 от отсортированного списка изменённых файлов по ВСЕМ репозиториям,
 * подписанных именем репозитория ("books/src/app.ts"), склеенных переводом строки.
 * Считается он ровно в одном месте - здесь: два независимых счётчика разошлись бы
 * при первой же правке, и замок тихо открылся бы сам.
 *
 * Отпечаток в .qa-state (diffHash) нарочно берётся от списка файлов, а не от содержимого:
 * точка отсчёта L.baseRef переезжает с HEAD на origin/<база> в момент коммита, и список
 * файлов при этом не меняется - значит, отметка, поставленная до коммита, доживает до пуша.
 * Содержимое файлов диффа здесь тоже читается, но только для сверки одного прогона gates.js
 * (diffSnapshot/diffMoved, решения техлида Р1 и Р6 E0-12AB; отпечатка нет - у метки-каталога, не обычного
 * файла, непрочитанного файла - отметка и выход с кодом 1): в .qa-state оно не пишется, и замок коммита
 * по-прежнему сверяет список.
 *
 * Поля в .qa-state:
 *   lastQa      - дата прогона /qa (формат не меняем)
 *   qaDiffHash  - отпечаток диффа, по которому прогнали /qa
 *   lastGates   - { hash, files, code, at }: отпечаток, метки диффа, код возврата gates.js и дата
 *
 * Запускается и руками:  node .claude/hooks/diff-hash.js
 * тогда печатает отпечаток и файлы, которые в него вошли.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const L = require('./lib.js');

/**
 * Файлы захода по одному репозиторию: рабочее дерево **плюс** уже закоммиченное,
 * но не отправленное.
 *
 * 🔴 Считать только рабочее дерево нельзя, и это было доказано прогоном. `L.baseRef`
 * переезжает с базовой ветки на `HEAD` в тот момент, когда правки уходят в коммит,
 * поэтому после `git commit` файлы репозитория пропадают из диффа, набор меняется,
 * отпечаток вместе с ним - и второй `git push` в том же заходе отвергается замком
 * по причине «гейты гонялись по другому диффу». Заход `/auto` коммитит три репозитория
 * по очереди, так что ломалось это не в аварийном ходе, а в штатном.
 *
 * Поэтому точка отсчёта здесь своя и неподвижная: `origin/<база>`, а при её отсутствии -
 * локальная база. Набор файлов от неё не меняется ни от коммита, ни от пуша первого
 * репозитория, и живёт ровно до отправки - то есть до конца захода.
 */
function repoLabels(repo) {
  const rules = L.rulesFor(repo);
  const base = (rules && rules.baseBranch) || 'main';
  const root = repo.path;
  const set = new Set();

  let from = null;
  for (const ref of ['origin/' + base, base]) {
    const r = L.sh('git', ['rev-parse', '--verify', '--quiet', ref], root);
    if (r.ok && r.out) {
      from = ref;
      break;
    }
  }

  // -z и сырой вывод (raw) у каждого вызова git: имя не в кавычках с восьмеричными escape (core.quotepath
  // у не-ASCII имён) и не обрезано по краям - метка совпадает с путём на диске, и сверка прогона читает
  // сам файл
  const names = (r) => r.out.split('\0').filter(Boolean);
  // ветки сравнения нет вовсе - остаётся рабочее дерево против HEAD, тем же разбором
  const d = L.sh('git', ['diff', '--name-only', '-z', from || 'HEAD'], root, { raw: true });
  if (d.ok) names(d).forEach((f) => set.add(f));

  const u = L.sh('git', ['ls-files', '--others', '--exclude-standard', '-z'], root, { raw: true });
  if (u.ok) names(u).forEach((f) => set.add(f));

  return Array.from(set).map((f) => L.label(repo, f));
}

/**
 * Только ЗАВЕДЁННЫЕ за заход файлы, подписанные репозиторием.
 *
 * Нужны там, где правило отличает «новое» от «изменённого»: новый раздел сайта - это новый
 * каталог в app/[lang]/, а правка существующей страницы трогает ровно те же шаблоны путей.
 * Без этого признака правило про публичные маршруты поднималось бы на каждой правке любой
 * страницы, и его сняли бы в первый же день.
 *
 * Точка отсчёта та же, что у repoLabels: origin/<база>. Коммит своей половины пары признак
 * не теряет - `--diff-filter=AR` от неподвижной базы видит файл добавленным и после коммита.
 *
 * 🔴 `AR`, а не `A`: определение переименований у git включено по умолчанию, и перенесённый
 * каталог приходит буквой `R`. С одним `A` правило с `ifNew` молчало бы ровно там, где
 * появился новый публичный адрес, и ответ зависел бы от индекса - незастейдженный `mv`
 * виден через `ls-files --others`, застейдженный нет.
 */
function newLabels() {
  const out = [];
  for (const repo of L.knownRepos()) {
    const rules = L.rulesFor(repo);
    const base = (rules && rules.baseBranch) || 'main';
    const set = new Set();

    let from = null;
    for (const ref of ['origin/' + base, base]) {
      const r = L.sh('git', ['rev-parse', '--verify', '--quiet', ref], repo.path);
      if (r.ok && r.out) {
        from = ref;
        break;
      }
    }
    if (from) {
      const a = L.sh('git', ['diff', '--name-only', '--diff-filter=AR', from], repo.path);
      if (a.ok) a.out.split('\n').filter(Boolean).forEach((f) => set.add(f));
    } else {
      // Ветки сравнения нет вовсе - остаётся индекс против HEAD. Без этой ветки заведённый
      // и уже добавленный в индекс файл выпадал отовсюду: в --diff-filter=A его не с чем
      // сравнивать, а в ls-files --others он уже не попадает. Правило с ifNew молча
      // не срабатывало бы - то есть отказывало бы в пользу разрешения.
      const a = L.sh('git', ['diff', '--name-only', '--diff-filter=AR', '--cached'], repo.path);
      if (a.ok) a.out.split('\n').filter(Boolean).forEach((f) => set.add(f));
    }
    const u = L.sh('git', ['ls-files', '--others', '--exclude-standard'], repo.path);
    if (u.ok) u.out.split('\n').filter(Boolean).forEach((f) => set.add(f));

    for (const f of set) out.push(L.label(repo, f));
  }
  return out.sort();
}

/**
 * Файлы текущего захода по всем репозиториям, подписанные репозиторием, отсортированные.
 *
 * 🔴 Обвязка входит сюда как обычный репозиторий - через `repos.json`, где она стоит
 * с 02.09.2026 (решение арбитра, `decisions-log.md`). Отдельной ручной записи для неё
 * здесь больше нет: пока она была, отпечаток её видел, а `checkGarbage`, `checkWeakenings`
 * и `gates.js` - нет, потому что те ходят по `L.knownRepos()`. Половинчатая починка держалась
 * ровно до захода, который внёс в правила два ослабления и не был за это остановлен.
 *
 * Пропадёт запись из `repos.json` - обвязка исчезнет из отпечатка молча, и замок начнёт
 * пропускать её правки. За этим следит `obvyazka-selftest.js` строкой «обвязка видна
 * как репозиторий».
 */
function diffLabels() {
  const out = [];
  for (const repo of L.knownRepos()) out.push.apply(out, repoLabels(repo));
  return out.sort();
}

/** Отпечаток диффа. Без аргумента считает список сам. */
function diffHash(labels) {
  const list = (Array.isArray(labels) ? labels.slice() : diffLabels()).sort();
  return sha1(list.join('\n'));
}

/** sha1 строки (UTF-8) или байт, hex. */
function sha1(data) {
  return crypto.createHash('sha1').update(data).digest('hex');
}

// пауза перед повтором чтения файла диффа: на Windows файл бывает занят мгновение (EBUSY, EPERM от
// антивируса или индексатора), и без повтора такой сбой давал бы «дифф изменился» и лишний перепрогон
const READ_RETRY_MS = 50;
// кусок чтения файла диффа: файл читается кусками в sha1, а не целиком - память прогона не растёт с
// размером файла, и файл больше предела Buffer (2 ГиБ) читается, а не даёт вечный «не читается»
const HASH_CHUNK_BYTES = 1024 * 1024;

/** sha1 содержимого файла, hex: чтение кусками HASH_CHUNK_BYTES. */
function fileSha1(file) {
  const h = crypto.createHash('sha1');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, HASH_CHUNK_BYTES, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/**
 * Отпечаток одного пути: { print } - sha1 содержимого файла, 'ссылка <sha1 цели>' у ссылки (lstat: ссылка
 * не разыменовывается, файл вне репозитория не читается), 'нет' - пути нет. Каталог - { print: null, dir }:
 * отпечатка у каталога нет (решение техлида Р6 E0-12AB, fail-closed). Не обычный файл (FIFO, сокет,
 * устройство) - { print: null, why: 'не обычный файл' } без открытия: чтение FIFO висело бы без предела
 * (решение техлида Р7 E0-12AB). Сбой чтения - один повтор через READ_RETRY_MS, затем { print: null, why } с
 * кодом сбоя. hash(file) - sha1 файла (fileSha1), lstat(file) - fs.lstatSync; оба подменяются пробами.
 */
function pathPrint(file, hash, lstat) {
  let err = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const st = L.statIfPresent(file, lstat);
      if (!st) return { print: 'нет' };
      if (st.isSymbolicLink()) return { print: 'ссылка ' + sha1(fs.readlinkSync(file)) };
      if (st.isDirectory()) return { print: null, dir: true };
      if (!st.isFile()) return { print: null, why: 'не обычный файл' };
      return { print: hash(file) };
    } catch (e) {
      err = e;
      if (attempt === 0) L.pauseSync(READ_RETRY_MS);
    }
  }
  return { print: null, why: 'не читается (' + ((err && (err.code || err.message)) || String(err)) + ')' };
}

/**
 * Снимок диффа для сверки одного прогона gates.js (решение техлида Р1 E0-12AB): метки (labels как даны;
 * без аргумента - diffLabels()), отпечаток каждой метки (prints: { <метка>: строка pathPrint | null }) и
 * причина каждого null (unread: { <метка>: текст }): метка-каталог (вложенный репозиторий, решения техлида Р6
 * и Р7), не обычный файл, сбой чтения с кодом, метка ни одного известного репозитория. null сверка считает
 * изменившимся - отметка не зелёная (fail-closed). Правку уже изменённого файла diffHash не видит - набор
 * меток тот же, - а prints видит. В .qa-state не пишется. opts.repos (по умолчанию L.knownRepos()), opts.hash
 * (sha1 файла, по умолчанию fileSha1) и opts.lstat (по умолчанию fs.lstatSync) - для проб.
 */
function diffSnapshot(labels, opts) {
  const o = opts || {};
  const repos = o.repos || L.knownRepos();
  const hash = o.hash || fileSha1;
  const lstat = o.lstat || fs.lstatSync;
  const list = Array.isArray(labels) ? labels.slice() : diffLabels();
  const prints = {};
  const unread = {};
  for (const label of list) {
    const at = L.unlabel(repos, label);
    if (!at) {
      prints[label] = null;
      unread[label] = label + ': метка ни одного репозитория repos.json';
      continue;
    }
    const p = pathPrint(path.join(at.repo.path, at.rel), hash, lstat);
    prints[label] = p.print;
    // запись в repos.json метку-каталог не снимает: внешний репозиторий видит каталог по-прежнему (ревью E0-12AB, круг 3)
    if (p.dir) unread[label] = 'метка-каталог ' + label + ': вложенный репозиторий: внеси каталог в .gitignore внешнего репозитория или убери (отдельный репозиторий - ещё и в repos.json)';
    else if (p.why) unread[label] = label + ': ' + p.why;
  }
  return { labels: list, prints, unread };
}

/**
 * Что изменилось между двумя снимками diffSnapshot: метки, появившиеся или пропавшие, и метки обоих
 * снимков с другим отпечатком; отпечаток null или его нет хотя бы в одном снимке - изменилась.
 * Пусто - дифф тот же. Правку, вернувшую файл к прежнему содержимому до второго снимка (A -> B -> A),
 * сверка не видит.
 */
function diffMoved(before, after) {
  const was = new Set(before.labels);
  const now = new Set(after.labels);
  const moved = after.labels.filter((l) => !was.has(l)).concat(before.labels.filter((l) => !now.has(l)));
  for (const l of before.labels) {
    // отпечаток - строка; null (не прочитан) или его нет - изменилась, даже если в обоих снимках одинаково
    if (now.has(l) && (typeof before.prints[l] !== 'string' || before.prints[l] !== after.prints[l])) moved.push(l);
  }
  return moved;
}

/** Причины непрочитанных меток из moved (unread обоих снимков diffSnapshot), без повторов. */
function movedWhy(moved, before, after) {
  const why = new Set();
  for (const l of moved) {
    for (const s of [before, after]) if (s.unread && s.unread[l]) why.add(s.unread[l]);
  }
  return Array.from(why);
}

/**
 * Записать поля fields в состояние под блокировкой (L.updateState, docs/adr/0016-qa-state-writes.md) и
 * вернуть записанное состояние. Запись не удалась (блокировка занята, состояние недоступно) - исключение:
 * прежняя отметка осталась, и вызывающий обязан это сказать (решение техлида Р9 E0-12AB, п.8). Отметка
 * пишется всегда - updateState без предиката, одно чтение под блокировкой (ревью E0-12AE, круг 2, CR8);
 * updateState отдаёт только Error.
 */
function putMark(fields) {
  let written = null;
  const failed = L.updateState((state) => {
    Object.assign(state, fields);
    written = state;
    return true;
  });
  if (failed) throw new Error('запись .qa-state не удалась: ' + failed.message);
  return written;
}

/**
 * Отметка о прогоне /qa по текущему диффу. Зовётся только из команды /qa (qa.md §6). Каждый вызов, кроме
 * отметки, сам обнуляет счётчик правок и список посторонних файлов (edits = 0, strayFiles = []) - той же
 * записью под блокировкой: новый вызывающий молча сотрёт их, звать markQa вне /qa нельзя. Запись не удалась -
 * исключение, как у markGates: /qa не скажет «отметка поставлена» над прежним qaDiffHash.
 */
function markQa(hash) {
  // метки - до блокировки: git медленный, под блокировкой только файл
  const labels = diffLabels();
  return putMark({
    lastQa: new Date().toISOString(),
    qaDiffHash: hash || diffHash(labels),
    // Список файлов, а не только отпечаток: по нему потом видно, что ревьюеры уже видели,
    // и какие файлы появились после них. Без списка отказ может быть только «набор не тот»,
    // без имени файла, - а по такому отказу непонятно, чинить его или он законный.
    qaFiles: labels,
    edits: 0,
    strayFiles: [],
  });
}

/**
 * Отметка о прогоне гейтов: код возврата сохраняется честно, включая ненулевой. labels - метки
 * диффа, по которому выбраны гейты (gates.js снимает их до очереди): отпечаток и files - по ним, а
 * не по диффу в конце прогона. Без аргумента - текущий дифф. labels не массив (прежняя форма
 * markGates(code, hash)) - исключение до записи: молча поставить отметку по диффу конца прогона нельзя.
 * Запись состояния не удалась (L.updateState вернул ошибку: блокировка занята, состояние недоступно) -
 * исключение: прежняя отметка осталась, и gates.js обязан это сказать, а не «записана» (решение техлида
 * Р9 E0-12AB, п.8).
 */
function markGates(code, labels) {
  if (labels !== undefined && !Array.isArray(labels)) {
    throw new TypeError('markGates(code, labels): labels - массив меток диффа или ничего, дано ' + typeof labels);
  }
  const list = Array.isArray(labels) ? labels.slice().sort() : diffLabels();
  return putMark({
    lastGates: {
      hash: diffHash(list),
      files: list,
      code: Number.isFinite(Number(code)) ? Number(code) : 1,
      at: new Date().toISOString(),
    },
  });
}

/**
 * Файлы, появление которых после ревью замок не считает изменением диффа.
 *
 * 🔴 Иначе цикл не замыкается вовсе. Порядок шагов в `/auto` такой: ревью и гейты - шаг 6
 * и 8, документы - шаг 9, коммит - шаг 10. На девятом шаге заводятся и правятся
 * `changelog.md`, `tech-debt-journal.md`, `work-queue.md`, `decisions-log.md`,
 * `legacy-warnings.md` и файл дела - то есть набор файлов после ревью **обязан** отличаться
 * от набора на ревью, так задуман протокол. Сверка «набор должен совпасть» отвергала бы
 * каждый штатный коммит, и стоп-условие 6 срабатывало бы каждый заход.
 *
 * Послабление узкое и односторонее: перечисленное можно только **добавить**. Появился
 * файл кода, спека или конфига, которого ревьюеры не видели, - отметка недействительна,
 * и это правильный отказ: непроверенный код в коммит не идёт.
 */
/**
 * Список берётся из rules.common.json, поле afterReviewAllowed (глобы с именем
 * репозитория первым сегментом: "sf/docs/90_WORKLOG.md", "sf/tasks/**").
 * Хардкода здесь нет намеренно: набор документов, которые протокол пишет после ревью,
 * меняется вместе с протоколом, а не с кодом замка.
 */
function afterReviewAllowed() {
  const list = L.commonRules().afterReviewAllowed;
  return Array.isArray(list) ? list : [];
}

function isAfterReviewAllowed(label) {
  return afterReviewAllowed().some((g) => g === label || L.matchGlob(g, label));
}

/**
 * Покрыт ли текущий набор файлов тем, по которому шло ревью.
 * Возвращает список файлов, которых ревьюеры не видели.
 */
function unreviewed(reviewed, current) {
  const seen = new Set(reviewed || []);
  return (current || []).filter((f) => !seen.has(f) && !isAfterReviewAllowed(f));
}

/** Прошёл ли /qa по этому диффу. Возвращает null или причину отказа человеческими словами. */
function qaProblem(state, hash, currentLabels) {
  if (!state || !state.lastQa) return 'отметки о прогоне /qa нет вовсе';
  if (!state.qaDiffHash) return 'отметка /qa есть, но она без отпечатка диффа';
  if (state.qaDiffHash === hash) return null;

  // Набор разошёлся. Разрешено ровно одно: документы, которые протокол пишет после ревью.
  const reviewed = Array.isArray(state.qaFiles) ? state.qaFiles : null;
  if (!reviewed) {
    return 'отметка /qa стоит по другому диффу (' + state.qaDiffHash.slice(0, 8) + '), а сейчас ' +
      hash.slice(0, 8);
  }
  const extra = unreviewed(reviewed, currentLabels || diffLabels());
  if (!extra.length) return null;
  return 'ревьюеры не видели этих файлов: ' + L.shortList(extra);
}

/** Зелёные ли гейты по этому диффу. Возвращает null или причину отказа. */
function gatesProblem(state, hash, currentLabels) {
  const g = state && state.lastGates;
  if (!g || typeof g !== 'object') return 'гейты по этому диффу не гонялись ни разу';
  if (!g.hash) return 'запись о гейтах есть, но она без отпечатка диффа';
  if (g.hash !== hash) {
    // То же послабление, что у /qa: документы шага 9 протокол пишет после гейтов.
    // Файл кода, появившийся после прогона, послаблением не покрыт - это законный отказ.
    const known = Array.isArray(g.files) ? g.files : null;
    const extra = known ? unreviewed(known, currentLabels || diffLabels()) : null;
    if (!known || extra.length) {
      return 'гейты гонялись по другому диффу (' + String(g.hash).slice(0, 8) + '), а сейчас ' +
        hash.slice(0, 8) + ' - после этого менялись файлы' +
        (extra && extra.length ? ': ' + L.shortList(extra) : '');
    }
  }
  if (Number(g.code) !== 0) {
    return 'последний прогон гейтов упал, код возврата ' + g.code + (g.at ? ' (' + g.at + ')' : '');
  }
  return null;
}

module.exports = { diffLabels, newLabels, diffHash, diffSnapshot, diffMoved, movedWhy, markQa, markGates, qaProblem, gatesProblem, unreviewed };

if (require.main === module) {
  const labels = diffLabels();
  console.log(diffHash(labels));
  console.log('файлов в диффе: ' + labels.length);
  labels.forEach((l) => console.log('  ' + l));
}
