#!/usr/bin/env node
'use strict';
/**
 * harness-selftest.js - самопроверка обвязки. Запускается руками, гейтом `harness-selftest`
 * (rules.sf.json, when: glob:.claude/**) и установщиком install.ps1.
 *
 * Зачем: у обвязки нет ни типов, ни тестов, а сломанный хук ничего не запрещает - его отказ
 * неотличим от разрешения. Поэтому здесь не только синтаксис и разбор правил, но и живые пробы
 * замков: каждый обязан показать отказ на нарушении И пропуск на чистом входе. Проба только
 * на отказ ничего не доказывает (сторож, отвергающий всё, её пройдёт), проба только на пропуск -
 * тем более.
 *
 * Код выхода 1, если красна хоть одна строка. Последняя строка вывода - счёт.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const HOOKS = __dirname;
const CLAUDE = path.resolve(HOOKS, '..');
const ROOT = path.resolve(CLAUDE, '..');

const ALLOWED_MODELS = new Set(['opus', 'sonnet', 'haiku', 'fable', 'inherit']);
const HOOK_FILES = [
  'lib.js', 'diff-hash.js', 'protect-files.js', 'scope.js', 'standards.js', 'commit-gate.js',
  'diff-boundaries.js', 'qa-lock.js', 'answer-length.js', 'report-honesty.js', 'remind-format.js',
  'gates.js',
];

const results = [];
function ok(name, note) { results.push({ ok: true, name, note }); }
function fail(name, note) { results.push({ ok: false, name, note }); }
function check(name, fn) {
  try {
    const r = fn();
    if (r === false) fail(name, '');
    else if (typeof r === 'string') fail(name, r);
    else ok(name, typeof r === 'object' && r && r.note ? r.note : '');
  } catch (e) {
    fail(name, (e && e.message) || String(e));
  }
}

function run(cmd, args, opts) {
  return cp.spawnSync(cmd, args, Object.assign({ encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, opts || {}));
}

/** Запуск хука с JSON на stdin. Возвращает { code, out, err }. */
function probe(hook, input, cwd) {
  const r = run(process.execPath, [path.join(HOOKS, hook)], { input: JSON.stringify(input), cwd: cwd || ROOT });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function frontmatter(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

// ------------------------------------------------------------------ 1. синтаксис хуков
for (const f of HOOK_FILES) {
  check('синтаксис ' + f, () => {
    const p = path.join(HOOKS, f);
    if (!fs.existsSync(p)) return 'файла нет';
    const r = run(process.execPath, ['--check', p]);
    return r.status === 0 ? true : String(r.stderr).split('\n')[0];
  });
}

// ------------------------------------------------------------------ 2. правила и репозитории
let common = null;
let repoRules = null;
check('repos.json разбирается и путь существует', () => {
  const j = readJson(path.join(HOOKS, 'repos.json'));
  if (!Array.isArray(j.repos) || !j.repos.length) return 'нет списка repos';
  for (const r of j.repos) {
    const p = path.resolve(HOOKS, r.path);
    if (!fs.existsSync(path.join(p, '.git'))) return r.name + ': по пути ' + p + ' нет .git';
  }
  return { note: j.repos.map((r) => r.name).join(', ') };
});
check('rules.common.json разбирается', () => { common = readJson(path.join(HOOKS, 'rules.common.json')); return true; });
check('rules.sf.json разбирается', () => { repoRules = readJson(path.join(HOOKS, 'rules.sf.json')); return true; });

function compileAll(list, label) {
  let n = 0;
  for (const st of list || []) {
    for (const key of ['pattern', 'skipIf', 'absentInFile', 'nearby']) {
      if (typeof st[key] === 'string') { new RegExp(st[key], st.flags || ''); n++; }
    }
  }
  return { note: label + ': ' + n + ' регулярок' };
}
check('регулярки standards компилируются', () => compileAll([].concat((common && common.standards) || [], (repoRules && repoRules.standards) || []), 'standards'));
check('регулярки commitGate.weakenings компилируются', () => compileAll((common && common.commitGate && common.commitGate.weakenings) || [], 'weakenings'));
check('глобы правил компилируются', () => {
  const L = require('./lib.js');
  const globs = [].concat(
    (repoRules && repoRules.protected) || [], (repoRules && repoRules.createOnly) || [],
    (common && common.protected) || [], (common && common.scope && common.scope.alwaysAllowed) || [],
    (common && common.commitGate && common.commitGate.forbiddenPaths) || [],
    (common && common.afterReviewAllowed) || [],
  );
  for (const st of (repoRules && repoRules.standards) || []) globs.push.apply(globs, st.files || []);
  for (const g of globs) L.matchGlob(g, 'x/y.ts');
  return { note: globs.length + ' глобов' };
});
check('у каждого гейта есть id, cmd и when', () => {
  const gates = (repoRules && repoRules.gates) || [];
  if (!gates.length) return 'гейтов нет';
  for (const g of gates) {
    if (!g.id || !g.cmd) return 'гейт без id или cmd';
    const w = String(g.when || 'always');
    if (!(w === 'always' || w === 'never' || w.startsWith('glob:'))) return g.id + ': непонятный when ' + w;
  }
  return { note: gates.map((g) => g.id).join(', ') };
});

// ------------------------------------------------------------------ 3. шапки агентов и команд
for (const kind of ['agents', 'commands']) {
  const dir = path.join(CLAUDE, kind);
  check('шапки ' + kind, () => {
    if (!fs.existsSync(dir)) return 'папки нет';
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    if (!files.length) return 'пусто';
    const bad = [];
    for (const f of files) {
      const fm = frontmatter(path.join(dir, f));
      if (!fm) { bad.push(f + ': нет фронтматтера'); continue; }
      if (!fm.description) bad.push(f + ': нет description');
      if (!fm.model) bad.push(f + ': нет model');
      else if (!ALLOWED_MODELS.has(fm.model)) bad.push(f + ': model ' + fm.model + ' вне ' + Array.from(ALLOWED_MODELS).join('/'));
      if (kind === 'agents' && !fm.name) bad.push(f + ': нет name');
    }
    return bad.length ? bad.join('; ') : { note: files.length + ' файлов' };
  });
}

// ------------------------------------------------------------------ 3a. скрипты PowerShell
check('install.ps1 / otkat.ps1 начинаются с UTF-8 BOM', () => {
  // Windows PowerShell 5.1 читает .ps1 без BOM в системной кодировке и ломается на кириллице
  // в строках; поймано владельцем при первом запуске установщика 05.09.2026.
  const bad = [];
  for (const f of ['install.ps1', 'otkat.ps1']) {
    const p = path.join(CLAUDE, f);
    if (!fs.existsSync(p)) { bad.push(f + ': нет файла'); continue; }
    const b = fs.readFileSync(p);
    if (!(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)) bad.push(f + ': без BOM');
  }
  return bad.length ? bad.join('; ') : true;
});

// ------------------------------------------------------------------ 4. settings.json
check('settings.json: все хуки существуют на диске', () => {
  const s = readJson(path.join(CLAUDE, 'settings.json'));
  const missing = [];
  let n = 0;
  for (const ev of Object.keys(s.hooks || {})) {
    for (const group of s.hooks[ev]) {
      for (const h of group.hooks || []) {
        const m = /\.claude\/hooks\/([A-Za-z0-9_.-]+\.js)/.exec(h.command || '');
        if (!m) { missing.push(ev + ': команда без пути к хуку'); continue; }
        n++;
        if (!fs.existsSync(path.join(HOOKS, m[1]))) missing.push(ev + ': ' + m[1]);
      }
    }
  }
  return missing.length ? missing.join('; ') : { note: n + ' регистраций' };
});

// ------------------------------------------------------------------ 5. живые пробы замков
const CWD = ROOT;
check('protect-files: отказ на .env', () => {
  const r = probe('protect-files.js', { tool_input: { file_path: path.join(ROOT, '.env') } }, CWD);
  return /"permissionDecision":"deny"/.test(r.out) ? true : 'нет отказа: ' + (r.out || r.err).slice(0, 120);
});
check('protect-files: отказ на pnpm-lock.yaml', () => {
  const r = probe('protect-files.js', { tool_input: { file_path: path.join(ROOT, 'pnpm-lock.yaml') } }, CWD);
  return /"permissionDecision":"deny"/.test(r.out) ? true : 'нет отказа';
});
check('protect-files: пропуск обычного файла', () => {
  const r = probe('protect-files.js', { tool_input: { file_path: path.join(ROOT, 'packages/core/src/index.ts') } }, CWD);
  return r.code === 0 && !r.out ? true : 'неожиданный ответ: ' + (r.out || r.err).slice(0, 120);
});
check('protect-files: createOnly - правка миграции запрещена, новая разрешена', () => {
  const dir = path.join(ROOT, 'packages/db/migrations');
  const existed = fs.existsSync(dir);
  const existing = path.join(dir, '0000_selftest_probe.sql');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(existing, '-- probe');
  try {
    const edit = probe('protect-files.js', { tool_input: { file_path: existing } }, CWD);
    const create = probe('protect-files.js', { tool_input: { file_path: path.join(dir, '0001_selftest_new.sql') } }, CWD);
    if (!/deny/.test(edit.out)) return 'правка существующей миграции прошла';
    if (create.out) return 'создание новой миграции отбито: ' + create.out.slice(0, 100);
    return true;
  } finally {
    fs.unlinkSync(existing);
    if (!existed) { try { fs.rmdirSync(dir); } catch (_) { /* не пуста */ } }
  }
});
check('commit-gate: отказ на --no-verify', () => {
  const r = probe('commit-gate.js', { tool_input: { command: 'git commit --no-verify -m "feat: x"' } }, CWD);
  return /deny/.test(r.out) && /no-verify/.test(r.out) ? true : 'нет отказа: ' + (r.out || r.err).slice(0, 120);
});
check('commit-gate: отказ на неконвенциональное сообщение', () => {
  const r = probe('commit-gate.js', { tool_input: { command: 'git commit -m "поправил всё"' } }, CWD);
  return /deny/.test(r.out) && /conventional/.test(r.out) ? true : 'нет отказа: ' + (r.out || r.err).slice(0, 120);
});
check('commit-gate: отказ на push --force', () => {
  const r = probe('commit-gate.js', { tool_input: { command: 'git push --force origin main' } }, CWD);
  return /deny/.test(r.out) && /истори/.test(r.out) ? true : 'нет отказа';
});
check('commit-gate: bash -c обёртка не обходит замок', () => {
  const r = probe('commit-gate.js', { tool_input: { command: 'bash -c "git commit -n -m \'feat: x\'"' } }, CWD);
  return /deny/.test(r.out) ? true : 'обёртка прошла';
});
check('commit-gate: isBootstrap - true без коммитов, false после первого', () => {
  const { isBootstrap } = require('./commit-gate.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-boot-'));
  const env = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@x', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@x' });
  try {
    run('git', ['init', '-q', '-b', 'main'], { cwd: tmp });
    if (!isBootstrap(tmp)) return 'репозиторий без коммитов не опознан как bootstrap';
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'a');
    run('git', ['add', 'a.txt'], { cwd: tmp, env });
    run('git', ['commit', '-q', '-m', 'chore: init'], { cwd: tmp, env });
    if (isBootstrap(tmp)) return 'репозиторий с коммитом всё ещё bootstrap';
    return true;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
check('commit-gate: пропуск не-git команды', () => {
  const r = probe('commit-gate.js', { tool_input: { command: 'pnpm typecheck && ls -la' } }, CWD);
  return r.code === 0 && !r.out ? true : 'неожиданный ответ: ' + (r.out || r.err).slice(0, 120);
});
check('standards: замечание на any и console в новом файле, тишина на чистом', () => {
  const dir = path.join(ROOT, 'packages/core/src');
  const bad = path.join(dir, 'zz_selftest_bad.ts');
  const good = path.join(dir, 'zz_selftest_good.ts');
  fs.writeFileSync(bad, 'export const x: any = 1;\nconsole.log(x);\n');
  fs.writeFileSync(good, 'export const y: number = 1;\n');
  try {
    const r1 = probe('standards.js', { tool_input: { file_path: bad } }, CWD);
    const r2 = probe('standards.js', { tool_input: { file_path: good } }, CWD);
    if (r1.code !== 2 || !/S01/.test(r1.err) || !/S03/.test(r1.err)) return 'any/console не пойманы: код ' + r1.code + ' ' + r1.err.slice(0, 160);
    if (r2.code !== 0 || r2.err) return 'чистый файл получил замечание: ' + r2.err.slice(0, 120);
    return true;
  } finally {
    fs.unlinkSync(bad);
    fs.unlinkSync(good);
    // счётчик правок вырос на две пробы - вернуть
    try {
      const L = require('./lib.js');
      const st = L.readState();
      st.edits = Math.max(0, (st.edits || 0) - 2);
      L.writeState(st);
    } catch (_) { /* состояние - не повод падать */ }
  }
});
check('answer-length: отказ на простыню, пропуск на коротком', () => {
  const tmp = path.join(os.tmpdir(), 'sf-selftest-' + process.pid + '.jsonl');
  const mk = (text) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';
  try {
    fs.writeFileSync(tmp, mk(Array.from({ length: 30 }, (_, i) => 'Строка рассуждений номер ' + i + ' про то, как шла работа и что было прочитано.').join('\n')));
    const r1 = probe('answer-length.js', { transcript_path: tmp }, CWD);
    fs.writeFileSync(tmp, mk('Задача: E0-01 закрыта\nПроверки: gates ok\nДальше: /clear, затем /auto'));
    const r2 = probe('answer-length.js', { transcript_path: tmp }, CWD);
    if (r1.code !== 2) return 'простыня прошла (код ' + r1.code + ')';
    if (r2.code !== 0) return 'короткий ответ отбит: ' + r2.err.slice(0, 120);
    return true;
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* уже нет */ }
  }
});
check('report-honesty: «зелено» без прогона отбивается', () => {
  const tmp = path.join(os.tmpdir(), 'sf-selftest-rh-' + process.pid + '.jsonl');
  const statePath = path.join(CLAUDE, '.qa-state');
  const saved = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null;
  const mk = (text) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';
  try {
    fs.writeFileSync(statePath, JSON.stringify({ edits: 0, strayFiles: [] }));
    fs.writeFileSync(tmp, mk('Сделано. Все проверки зелёные.\nЗадача: E0-01 закрыта\nОбвязка: не менялась'));
    const r = probe('report-honesty.js', { transcript_path: tmp }, CWD);
    return r.code === 2 && /зелён|зелен/.test(r.err) ? true : 'неподтверждённое «зелено» прошло (код ' + r.code + ')';
  } finally {
    if (saved === null) { try { fs.unlinkSync(statePath); } catch (_) { /* нет */ } }
    else fs.writeFileSync(statePath, saved);
    try { fs.unlinkSync(tmp); } catch (_) { /* нет */ }
  }
});
check('gates.js --list отрабатывает', () => {
  const r = run(process.execPath, [path.join(HOOKS, 'gates.js'), '--list', '--repo=sf'], { cwd: ROOT });
  return r.status === 0 && /lint/.test(String(r.stdout)) ? true : 'код ' + r.status + ': ' + String(r.stderr || r.stdout).slice(0, 160);
});

// ------------------------------------------------------------------ итог
let red = 0;
for (const r of results) {
  if (!r.ok) red++;
  console.log((r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.note ? '  - ' + r.note : ''));
}
console.log(red ? 'Самопроверка обвязки: КРАСНАЯ, ' + red + ' из ' + results.length : 'Самопроверка обвязки: зелёная, ' + results.length + ' проверок');
process.exit(red ? 1 : 0);
