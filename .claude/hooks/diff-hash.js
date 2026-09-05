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
 * Отпечаток нарочно берётся от списка файлов, а не от содержимого: точка отсчёта
 * L.baseRef переезжает с HEAD на origin/<база> в момент коммита, и список файлов
 * при этом не меняется - значит, отметка, поставленная до коммита, доживает до пуша.
 *
 * Поля в .qa-state:
 *   lastQa      - дата прогона /qa (её пишет и qa-lock.js, формат не меняем)
 *   qaDiffHash  - отпечаток диффа, по которому прогнали /qa
 *   lastGates   - { hash, code, at }: отпечаток, код возврата gates.js и дата
 *
 * Запускается и руками:  node .claude/hooks/diff-hash.js
 * тогда печатает отпечаток и файлы, которые в него вошли.
 */

const crypto = require('crypto');
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

  if (from) {
    const d = L.sh('git', ['diff', '--name-only', from], root);
    if (d.ok) d.out.split('\n').filter(Boolean).forEach((f) => set.add(f));
  } else {
    // ветки сравнения нет вовсе - остаётся рабочее дерево против HEAD
    L.changedFiles(repo, rules).forEach((f) => set.add(f));
  }

  const u = L.sh('git', ['ls-files', '--others', '--exclude-standard'], root);
  if (u.ok) u.out.split('\n').filter(Boolean).forEach((f) => set.add(f));

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
  return crypto.createHash('sha1').update(list.join('\n'), 'utf8').digest('hex');
}

/** Отметка о прогоне /qa по текущему диффу. Зовётся из команды /qa. */
function markQa(hash) {
  const state = L.readState();
  const labels = diffLabels();
  state.lastQa = new Date().toISOString();
  state.qaDiffHash = hash || diffHash(labels);
  // Список файлов, а не только отпечаток: по нему потом видно, что ревьюеры уже видели,
  // и какие файлы появились после них. Без списка отказ может быть только «набор не тот»,
  // без имени файла, - а по такому отказу непонятно, чинить его или он законный.
  state.qaFiles = labels;
  L.writeState(state);
  return state;
}

/** Отметка о прогоне гейтов: код возврата сохраняется честно, включая ненулевой. */
function markGates(code, hash) {
  const state = L.readState();
  const labels = diffLabels();
  state.lastGates = {
    hash: hash || diffHash(labels),
    files: labels,
    code: Number.isFinite(Number(code)) ? Number(code) : 1,
    at: new Date().toISOString(),
  };
  L.writeState(state);
  return state;
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
  return 'ревьюеры не видели этих файлов: ' + extra.slice(0, 6).join(', ') +
    (extra.length > 6 ? ' и ещё ' + (extra.length - 6) : '');
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
        (extra && extra.length ? ': ' + extra.slice(0, 6).join(', ') : '');
    }
  }
  if (Number(g.code) !== 0) {
    return 'последний прогон гейтов упал, код возврата ' + g.code + (g.at ? ' (' + g.at + ')' : '');
  }
  return null;
}

module.exports = { diffLabels, newLabels, diffHash, markQa, markGates, qaProblem, gatesProblem, unreviewed };

if (require.main === module) {
  const labels = diffLabels();
  console.log(diffHash(labels));
  console.log('файлов в диффе: ' + labels.length);
  labels.forEach((l) => console.log('  ' + l));
}
