#!/usr/bin/env node
'use strict';
/**
 * gates.js - прогон обязательных проверок. Это НЕ хук: запускается руками
 * и командой /gates, читает только аргументы командной строки.
 *
 * Репозиториев несколько и лежат они рядом. Скрипт сам смотрит, где есть изменения,
 * и гоняет гейты каждого такого репозитория его же правилами, из его же папки.
 *
 * Смысл скрипта простой: нельзя написать "всё зелёное", не запустив проверки.
 * Вывод команд печатается настоящий, код возврата сохраняется честно.
 *
 * Использование:
 *   node .claude/hooks/gates.js              - выбрать и прогнать
 *   node .claude/hooks/gates.js --list       - только показать, что будет запущено
 *   node .claude/hooks/gates.js --only=typecheck,lint
 *   node .claude/hooks/gates.js --repo=books-front
 *   node .claude/hooks/gates.js --bail       - остановиться на первом падении
 *
 * Код выхода: 1, если упал хотя бы один гейт в любом репозитории, иначе 0.
 */

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./lib.js');

// сколько строк вывода показываем целиком и как режем длинный
const FULL_LIMIT = 200;
const HEAD_LINES = 40;
const TAIL_LINES = 60;

// ------------------------------------------------------------------ аргументы

function parseArgs(argv) {
  const res = { list: false, bail: false, only: null, repo: null, help: false };
  for (const a of argv) {
    if (a === '--list') res.list = true;
    else if (a === '--bail') res.bail = true;
    else if (a === '--help' || a === '-h') res.help = true;
    else if (a.startsWith('--repo=')) res.repo = a.slice('--repo='.length).trim() || null;
    else if (a.startsWith('--only=')) {
      res.only = a
        .slice('--only='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return res;
}

function printHelp() {
  console.log(
    [
      'gates.js - прогон обязательных проверок по всем репозиториям, где есть изменения.',
      '',
      '  --list            показать выбранные гейты и выйти, ничего не запуская',
      '  --only=a,b        запустить только гейты с этими id',
      '  --repo=имя        взять только этот репозиторий',
      '  --bail            остановиться сразу после первого падения',
      '',
      'Список гейтов берётся из правил репозитория, поле gates.',
      'Гейт с when="always" запускается всегда, с when="glob:<шаблон>" - только если',
      'под шаблон подходит хотя бы один изменённый файл этого репозитория,',
      'с when="never" - только по прямому указанию в --only.',
    ].join('\n'),
  );
}

function files(n) {
  const last = n % 10;
  const two = n % 100;
  if (two >= 11 && two <= 14) return n + ' файлов';
  if (last === 1) return n + ' файл';
  if (last >= 2 && last <= 4) return n + ' файла';
  return n + ' файлов';
}

// ------------------------------------------------------------------ выбор гейтов

/** Разбор условия when: возвращает шаблон для glob:... или null для always. */
function whenGlob(when) {
  const w = String(when || 'always').trim();
  if (w.startsWith('glob:')) return w.slice('glob:'.length).trim();
  return null;
}

/**
 * Отбор гейтов. Для каждого - решение и причина человеческими словами.
 * Возвращает [{ gate, run, reason }] в исходном порядке.
 */
function selectGates(gates, changed, only) {
  const picked = only && only.length;
  return gates.map((gate) => {
    if (picked && only.indexOf(gate.id) === -1) {
      return { gate, run: false, reason: 'не выбран через --only' };
    }
    if (String(gate.when || '').trim() === 'never' && !picked) {
      return { gate, run: false, reason: 'помечен never - только руками, через --only' };
    }
    const glob = whenGlob(gate.when);
    if (!glob) return { gate, run: true, reason: 'запускается всегда' };
    const hit = changed.find((f) => L.matchGlob(glob, f));
    if (hit) {
      return { gate, run: true, reason: 'включил файл ' + hit + ' (шаблон ' + glob + ')' };
    }
    return { gate, run: false, reason: 'нет изменённых файлов под шаблон ' + glob };
  });
}

// ------------------------------------------------------------------ вывод команды

function secs(ms) {
  const s = ms / 1000;
  return (s < 10 ? s.toFixed(1) : String(Math.round(s))) + 'с';
}

/** Длинный вывод режем посередине, но полностью кладём в файл и говорим куда. */
function printOutput(text, logPath) {
  const raw = String(text == null ? '' : text).replace(/\s+$/, '');
  if (!raw) {
    console.log('  (команда ничего не вывела)');
    return;
  }
  const lines = raw.split(/\r?\n/);
  if (lines.length <= FULL_LIMIT) {
    console.log(raw);
    return;
  }
  const cut = lines.length - HEAD_LINES - TAIL_LINES;
  console.log(lines.slice(0, HEAD_LINES).join('\n'));
  console.log('... срезано ' + cut + ' строк ...');
  console.log(lines.slice(lines.length - TAIL_LINES).join('\n'));
  if (logPath) console.log('Полный вывод: ' + logPath);
}

function saveLog(id, text) {
  try {
    const safe = String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
    const p = path.join(os.tmpdir(), 'gates-' + safe + '-' + process.pid + '.log');
    fs.writeFileSync(p, text);
    return p;
  } catch (_) {
    return '';
  }
}

/** Запуск одной команды из папки её репозитория. stdin наследуем, вывод собираем целиком. */
function runGate(gate, root) {
  const started = Date.now();
  let r;
  try {
    r = cp.spawnSync(gate.cmd, {
      cwd: root,
      shell: true,
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (e) {
    return { code: 1, ms: Date.now() - started, text: 'не удалось запустить команду: ' + (e && e.message) };
  }
  const parts = [];
  if (r.stdout) parts.push(r.stdout);
  if (r.stderr) parts.push(r.stderr);
  let text = parts.join('\n');
  let code;
  if (r.error) {
    text = (text ? text + '\n' : '') + 'не удалось запустить команду: ' + r.error.message;
    code = 1;
  } else if (r.status === null) {
    text = (text ? text + '\n' : '') + 'команда прервана сигналом ' + (r.signal || 'неизвестно');
    code = 1;
  } else {
    code = r.status;
  }
  return { code, ms: Date.now() - started, text };
}

// --------------------------------------------------------------- какие репозитории

/**
 * Репозитории, по которым пойдём: те, где есть дифф. С --repo берём только названный,
 * и берём его даже без изменений - раз попросили прямо, прогоним хотя бы постоянные гейты.
 * Возвращает [{ repo, rules, files }].
 */
function pickRepos(wanted) {
  const changed = L.allChanged();
  if (!wanted) return changed;

  const found = changed.find((g) => g.repo.name === wanted);
  if (found) return [found];

  const repo = L.knownRepos().find((r) => r.name === wanted);
  if (!repo) {
    const names = L.knownRepos().map((r) => r.name);
    console.log(
      'Репозиторий ' + wanted + ' неизвестен. Есть: ' + (names.join(', ') || 'ни одного') + '.',
    );
    return null;
  }
  return [{ repo, rules: L.rulesFor(repo), files: [] }];
}

// ---------------------------------------------------------------------- запуск

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return { code: 0, ran: false };
  }

  const groups = pickRepos(args.repo);
  if (groups === null) return { code: 1, ran: false };

  if (!groups.length) {
    // 🔴 Прежде здесь стоял особый ход для обвязки: её не было в repos.json, поэтому дифф
    // из одних её правок давал «гонять нечего», отметка не ставилась, а замок её
    // требует - цикл не замыкался. С 02.09.2026 обвязка в repos.json наравне с
    // остальными (решение арбитра, decisions-log.md), её гейт описан в rules..claude.json,
    // и особый ход больше не нужен: сюда доходит только по-настоящему пустой дифф.
    console.log('Изменений нет ни в одном репозитории - гонять нечего.');
    console.log('Нужен прогон без диффа - укажи репозиторий: --repo=<имя>.');
    return { code: 0, ran: false };
  }

  console.log(
    'Пойдём по репозиториям: ' +
      groups.map((g) => g.repo.name + ' - ' + files(g.files.length)).join(', '),
  );
  for (const g of groups) {
    console.log('  ' + g.repo.name + '  ' + g.repo.path + '  база ' + (g.rules.baseBranch || 'main'));
  }

  // план по каждому репозиторию
  const plans = [];
  const knownIds = new Set();
  for (const g of groups) {
    const gates = Array.isArray(g.rules.gates) ? g.rules.gates.filter((x) => x && x.id && x.cmd) : [];
    gates.forEach((x) => knownIds.add(x.id));
    plans.push({ group: g, plan: selectGates(gates, g.files, args.only) });
  }

  if (args.only && args.only.length) {
    const unknown = args.only.filter((id) => !knownIds.has(id));
    if (unknown.length) {
      console.log('');
      console.log(
        'Неизвестные id в --only: ' + unknown.join(', ') +
          '. Есть: ' + (Array.from(knownIds).join(', ') || 'ни одного'),
      );
    }
  }

  const queue = [];
  for (const p of plans) {
    const toRun = p.plan.filter((x) => x.run);
    const skipped = p.plan.filter((x) => !x.run);

    console.log('');
    console.log(p.group.repo.name + ': будет запущено (' + toRun.length + '):');
    if (!p.plan.length) console.log('  в правилах этого репозитория гейтов нет');
    else if (!toRun.length) console.log('  ничего');
    for (const x of toRun) {
      console.log(
        '  ' + x.gate.id + '  ' + x.gate.cmd + '  - ' + x.reason + (x.gate.note ? '. ' + x.gate.note : ''),
      );
      queue.push({ group: p.group, gate: x.gate });
    }
    if (skipped.length) {
      console.log('  пропущено (' + skipped.length + '):');
      for (const x of skipped) console.log('    ' + x.gate.id + '  - ' + x.reason);
    }
  }

  if (args.list) {
    console.log('');
    console.log('Это был --list, ничего не запускалось.');
    return { code: 0, ran: false };
  }
  if (!queue.length) {
    console.log('');
    console.log('Запускать нечего.');
    return { code: 0, ran: false };
  }

  const results = [];
  let stopped = false;
  for (const item of queue) {
    const name = item.group.repo.name;
    if (stopped) {
      results.push({ repo: name, gate: item.gate, skippedAfterFail: true });
      continue;
    }
    console.log('');
    console.log('=== ' + name + ' / ' + item.gate.id + ': ' + item.gate.cmd + ' ===');
    const r = runGate(item.gate, item.group.repo.path);
    const logPath =
      r.text.split(/\r?\n/).length > FULL_LIMIT ? saveLog(name + '-' + item.gate.id, r.text) : '';
    printOutput(r.text, logPath);
    console.log(
      '--- ' + name + ' / ' + item.gate.id + ': ' +
        (r.code === 0 ? 'ok' : 'ПАДАЕТ, код ' + r.code) + ', ' + secs(r.ms) + ' ---',
    );
    results.push({ repo: name, gate: item.gate, code: r.code, ms: r.ms });
    if (r.code !== 0 && args.bail) stopped = true;
  }

  const failed = results.filter((r) => !r.skippedAfterFail && r.code !== 0);

  console.log('');
  console.log('Сводка:');
  const repoWidth = Math.max.apply(null, results.map((r) => r.repo.length));
  const idWidth = Math.max.apply(null, results.map((r) => r.gate.id.length));
  const cmdWidth = Math.max.apply(null, results.map((r) => r.gate.cmd.length));
  for (const r of results) {
    const repo = r.repo + ' '.repeat(repoWidth - r.repo.length);
    const id = r.gate.id + ' '.repeat(idWidth - r.gate.id.length);
    const cmd = r.gate.cmd + ' '.repeat(cmdWidth - r.gate.cmd.length);
    const status = r.skippedAfterFail
      ? 'не запускался (остановились на первом падении)'
      : r.code === 0
        ? 'ok (' + secs(r.ms) + ')'
        : 'ПАДАЕТ (код ' + r.code + ', ' + secs(r.ms) + ')';
    console.log('  ' + repo + '  ' + id + '  ' + cmd + '  ' + status);
  }

  if (failed.length) {
    const byRepo = new Map();
    for (const r of failed) byRepo.set(r.repo, (byRepo.get(r.repo) || 0) + 1);
    console.log('');
    console.log(
      'Упало гейтов: ' + failed.length + ' из ' + results.length + ' (' +
        Array.from(byRepo).map(([n, c]) => n + ' - ' + c).join(', ') +
        '). Чини и прогоняй заново.',
    );
    return { code: 1, ran: true, scoped: Boolean(args.repo || args.only) };
  }
  console.log('');
  console.log('Все гейты прошли.');
  return { code: 0, ran: true, scoped: Boolean(args.repo || args.only) };
}

let code = 1;
let result = null;
try {
  result = main();
  code = result.code;
} catch (e) {
  // скрипт-проверка не имеет права молча притвориться зелёным
  console.error('gates.js сломался: ' + (e && e.stack ? e.stack : e));
  code = 1;
  result = null;
}

// Отметка о прогоне в общем состоянии: код возврата вместе с отпечатком того диффа,
// по которому гоняли. Её читают commit-gate.js и report-honesty.js - без неё коммит
// не проходит, а слово «зелено» в отчёте не подтверждается. Код пишется честный,
// включая ненулевой: отметка «гейты падали» нужна не меньше, чем «гейты прошли».
//
// 🔴 Отметку ставит ТОЛЬКО настоящий полный прогон. Раньше здесь стояло «всё, кроме
// --list», и этого было мало: `main()` возвращает ноль ещё в четырёх местах, ничего
// не запустив, - `--help`, неизвестный репозиторий, «изменений нет ни в одном
// репозитории», пустая очередь. Один `node gates.js --help` писал `lastGates{code:0}`
// по текущему диффу, после чего замок пропускал коммит, а report-honesty молчал про
// «зелено» - при том что не выполнилась ни одна проверка. Отметка, которую можно
// поставить, не прогоняя проверок, отменяет обе защиты разом.
//
// Второе ограничение - `--repo` и `--only`. Отпечаток считается по всем репозиториям,
// поэтому частичный прогон штамповал бы зелёным весь кросс-репозиторный дифф:
// `--repo=books --only=lint` объявлял бы проверенным и фронт, и документацию.
// Частичный прогон полезен при работе, но отметку не ставит - её ставит только
// `node gates.js` без сужающих ключей.
if (result && result.ran && !result.scoped) {
  try {
    require('./diff-hash.js').markGates(code);
  } catch (_) {
    // состояние - не повод уронить проверку
  }
} else if (result && result.ran && result.scoped) {
  console.log('');
  console.log(
    'Прогон был частичным (--repo или --only), отметка о зелёных гейтах не поставлена.\n' +
      'Замок коммита её не увидит: перед коммитом прогони node .claude/hooks/gates.js целиком.',
  );
}

process.exit(code);
