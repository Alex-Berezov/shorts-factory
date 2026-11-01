'use strict';
/**
 * selftest-state-static.js - статические пробы записи .qa-state (docs/adr/0016-qa-state-writes.md, E0-12AE;
 * разрез selftest-state.js на статические пробы и пробы процессов - ревью E0-12AE, круг 2, architecture). Не хук:
 * модуль самопроверки. harness-selftest.js грузит его после пробы синтаксиса и зовёт registerStateStaticProbes(ctx)
 * рядом с пробами записи состояния (selftest-state.js).
 *
 * Пробы (каждая - отказ и пропуск на синтетике, затем живое дерево):
 *   - запись по пути состояния мимо L.updateState: хуки (с подкаталогами), .claude/commands/*.md,
 *     .claude/agents/*.md, scripts/ (рекурсивно); модули самопроверки вне сверки; lib.js сверяется, запись в нём
 *     разрешена только функциям механизма (LIB_STATE_WRITERS) и объекту экспорта;
 *   - реестр писателей: файлы, которые зовут API записи состояния, и реестр в ADR 0016 совпадают.
 * Что сверка видит и чего не видит - ровно в docblock directStateWrites и в ADR 0016 («Остаток»).
 */

const fs = require('fs');
const path = require('path');
const { codeOnly } = require('./selftest-source.js');

/** API записи состояния: вызов любого из них - писатель .qa-state (реестр ADR 0016). */
const WRITER_API = ['updateState', 'markQa', 'markGates', 'bumpEdits', 'noteHookHealth'];
/** Подстроки пути состояния в коде: путь .qa-state, его временного файла, блокировки, маркера поломки и каталога. */
const STATE_PATH_RE = /statePath|stateLockPath|stateTmpPath|hookMarkerPath|qa-state|SF_HOOK_STATE_DIR/;
/** Синхронные вызовы записи и удаления в ФС - по имени (fs.x(), x() после деструктуризации). */
const FS_SYNC_WRITERS = ['writeFileSync', 'appendFileSync', 'renameSync', 'copyFileSync', 'cpSync', 'linkSync', 'symlinkSync', 'openSync', 'truncateSync', 'createWriteStream', 'unlinkSync', 'rmSync', 'rmdirSync'];
/** Асинхронные - методом (fs.open, fsp.rename) или по имени после деструктуризации/псевдонима. */
const FS_ASYNC_WRITERS = ['writeFile', 'appendFile', 'rename', 'copyFile', 'open', 'truncate', 'unlink', 'rm'];
const FS_WRITERS = FS_SYNC_WRITERS.concat(FS_ASYNC_WRITERS);
/**
 * Функции lib.js, которым запись по пути состояния разрешена: механизм записи (ADR 0016) и запасной маркер
 * поломки (решение техлида Р-6). '<exports>' - объект module.exports (writeState в экспорте для updateState и проб).
 */
const LIB_STATE_WRITERS = ['writeState', 'updateState', 'takeStateLock', 'claimStateLock', 'dropStateLock', 'unlinkRetry', 'noteHookHealth', '<exports>'];
/**
 * Запись оболочки в путь состояния в командах и описаниях агентов (*.md): перенаправление (> и >> после
 * не-стрелки, не цитата «> » в начале строки) в путь с qa-state или команда записи/удаления с ним в той же
 * команде (до | ; &).
 */
const SHELL_WRITE_RE = /[^\s\-=<>][ \t]*>>?[ \t]*["']?[^\s"'`|;&<>]*qa-state|\b(?:tee|cp|mv|rm|Copy-Item|Move-Item|Remove-Item|Set-Content|Add-Content|Out-File|New-Item)\b[^\n|;&]*qa-state/g;

/** Аргументы вызова: текст от открывающей скобки at (индекс '(') до парной, с учётом строк; многострочный - тоже. */
function argsAt(code, at) {
  let depth = 0;
  for (let j = at; j < code.length; j++) {
    const ch = code[j];
    if (ch === '"' || ch === "'" || ch === '`') {
      let k = j + 1;
      while (k < code.length && code[k] !== ch) k += code[k] === '\\' ? 2 : 1;
      j = k;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return code.slice(at + 1, j);
  }
  return code.slice(at + 1);
}

/** Номер строки (с 1) индекса at в тексте. */
const lineAt = (text, at) => text.slice(0, at).split('\n').length;
/** Имя name отдельным словом (не свойство x.name) в тексте. */
const nameRe = (name) => new RegExp('(^|[^\\w$.])' + name.replace(/\$/g, '\\$') + '(?![\\w$])');

/**
 * Имена, связанные с путём состояния: объявление или присваивание, правая часть которого содержит STATE_PATH_RE
 * или уже связанное имя (до неподвижной точки): const p = L.statePath(); const tmp = p + '.x' - оба.
 */
function statePathNames(code) {
  const binds = [];
  // правая часть - заглядыванием вперёд: в «a = x, p = y» связываются и a, и p
  const re = /\b([A-Za-z_$][\w$]*)\s*=(?![=>])(?=\s*([^;\n]*))/g;
  let m;
  while ((m = re.exec(code))) binds.push([m[1], m[2]]);
  const names = new Set();
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, rhs] of binds) {
      if (names.has(name)) continue;
      if (STATE_PATH_RE.test(rhs) || Array.from(names).some((n) => nameRe(n).test(rhs))) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
}

/**
 * Псевдонимы функций записи в ФС: const w = fs.writeFileSync (и fsp.writeFile, require('fs').rename) и
 * деструктуризация const { writeFileSync: w, writeFile } = fs (или = require('fs')). Имена, которые после этого
 * зовутся как функции записи.
 */
function writerAliases(code) {
  const out = new Set();
  const one = new RegExp('\\b([A-Za-z_$][\\w$]*)\\s*=\\s*[^;\\n=]*\\.(' + FS_WRITERS.join('|') + ')\\b(?!\\s*\\()', 'g');
  let m;
  while ((m = one.exec(code))) out.add(m[1]);
  const destr = /\{([^{}]*)\}\s*=\s*(?:require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)(?:\.promises)?|[A-Za-z_$][\w$.]*)/g;
  while ((m = destr.exec(code))) {
    for (const entry of m[1].split(',')) {
      const [key, alias] = entry.split(/[:=]/).map((x) => x.trim());
      if (FS_WRITERS.includes(key)) out.add(/^[A-Za-z_$][\w$]*$/.test(alias || '') ? alias : key);
    }
  }
  return out;
}

/**
 * Функции верхнего уровня кода code: [{ name, from, to }] - от «function name(» до парной фигурной скобки тела;
 * объект «module.exports = {» - под именем '<exports>'. Строки должны быть пустыми (codeOnly(…, true)).
 */
function functionRanges(code) {
  const out = [];
  const closeAt = (open) => {
    let depth = 0;
    for (let j = open; j < code.length; j++) {
      if (code[j] === '{') depth++;
      else if (code[j] === '}' && --depth === 0) return j;
    }
    return code.length;
  };
  const re = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(|\bmodule\.exports\s*=\s*\{/g;
  let m;
  while ((m = re.exec(code))) {
    if (m[1]) {
      const params = m.index + m[0].length - 1;
      const open = code.indexOf('{', params + argsAt(code, params).length + 1);
      if (open === -1) continue;
      out.push({ name: m[1], from: m.index, to: closeAt(open) });
    } else {
      const open = m.index + m[0].length - 1;
      out.push({ name: '<exports>', from: m.index, to: closeAt(open) });
    }
  }
  return out;
}

/** Самая внутренняя функция ranges, в которой лежит индекс at; '' - верхний уровень. */
function enclosing(ranges, at) {
  let best = null;
  for (const r of ranges) if (at >= r.from && at <= r.to && (!best || r.from > best.from)) best = r;
  return best ? best.name : '';
}

/**
 * Запись .qa-state мимо L.updateState в текстах texts ({ путь от корня: текст }): «путь:строка: вызов». Файлы из
 * exempt (модули самопроверки) не сверяются; allowed - { путь: [функции] }: запись внутри этих функций файла
 * разрешена (lib.js - LIB_STATE_WRITERS). JS - без комментариев (codeOnly), *.md - как есть. Отказ:
 *   (а) любое упоминание writeState;
 *   (б) вызов записи или удаления в ФС (FS_SYNC_WRITERS по имени, FS_ASYNC_WRITERS методом, псевдоним или имя
 *       после деструктуризации - writerAliases), аргументы которого (до парной скобки, многострочно) содержат
 *       путь состояния (STATE_PATH_RE) или имя, связанное с ним (statePathNames);
 *   (в) в *.md - запись оболочки в путь с qa-state (SHELL_WRITE_RE: > и >>, tee, cp, mv, rm, Set-Content,
 *       Add-Content, Out-File, Copy-Item, Move-Item, Remove-Item, New-Item).
 * Не видит: путь через параметры функций и require другого модуля, вызов через fs[имя] и Reflect, запись
 * дочерним процессом (cp.exec* с командой оболочки) из JS, PowerShell-скрипты (*.ps1) - остаток ADR 0016.
 */
function directStateWrites(texts, exempt, allowed) {
  const bad = [];
  for (const [name, text] of Object.entries(texts)) {
    if (exempt.has(name)) continue;
    const md = /\.md$/.test(name);
    const code = md ? String(text) : codeOnly(text);
    const ranges = allowed && allowed[name] ? functionRanges(codeOnly(text, true)) : null;
    const ok = (at) => Boolean(ranges && allowed[name].includes(enclosing(ranges, at)));
    const names = statePathNames(code);
    const tainted = (args) => STATE_PATH_RE.test(args) || Array.from(names).some((n) => nameRe(n).test(args));
    const ws = /\bwriteState\b/g;
    let m;
    while ((m = ws.exec(code))) if (!ok(m.index)) bad.push(name + ':' + lineAt(code, m.index) + ': writeState');
    const callees = FS_SYNC_WRITERS.concat(Array.from(writerAliases(code)));
    const call = new RegExp('(?:\\b(' + callees.join('|') + ')|\\.(' + FS_ASYNC_WRITERS.join('|') + '))\\s*\\(', 'g');
    while ((m = call.exec(code))) {
      const args = argsAt(code, m.index + m[0].length - 1);
      if (tainted(args) && !ok(m.index)) bad.push(name + ':' + lineAt(code, m.index) + ': ' + (m[1] || m[2]) + '(' + args.replace(/\s+/g, ' ').trim().slice(0, 80) + ')');
    }
    if (md) {
      SHELL_WRITE_RE.lastIndex = 0;
      while ((m = SHELL_WRITE_RE.exec(code))) bad.push(name + ':' + lineAt(code, m.index) + ': shell ' + m[0].trim().slice(0, 80));
    }
  }
  return bad;
}

/**
 * Писатели состояния в текстах texts: множество «путь api» - вызовы WRITER_API (не определения function api(...)).
 * Файлы exempt (модули самопроверки) не сверяются; lib.js - сверяется: noteHookHealth и bumpEdits - писатели.
 */
function stateWriterCalls(texts, exempt) {
  const out = new Set();
  const re = new RegExp('(\\bfunction\\s+)?\\b(' + WRITER_API.join('|') + ')\\s*\\(', 'g');
  for (const [name, text] of Object.entries(texts)) {
    if (exempt.has(name)) continue;
    const code = /\.md$/.test(name) ? String(text) : codeOnly(text, true);
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(code))) if (!m[1]) out.add(name + ' ' + m[2]);
  }
  return out;
}

/**
 * Реестр писателей из ADR 0016 (раздел «### Реестр писателей»): строки «- `<путь>` зовёт `<api>`[, `<api>`] - …» ->
 * множество «путь api»; строка раздела «- …» не этой формы - в bad (реестр не разобрать - не сверка).
 */
function writerRegistry(adrText) {
  const text = String(adrText);
  const at = text.indexOf('### Реестр писателей');
  const entries = new Set();
  const bad = [];
  if (at === -1) return { entries, bad: ['в ADR нет раздела «### Реестр писателей»'] };
  const rest = text.slice(at).split(/\r?\n/).slice(1);
  for (const line of rest) {
    if (/^#/.test(line)) break;
    if (!/^- /.test(line)) continue;
    const m = /^- `([^`]+)` зовёт ((?:`[A-Za-z]+`(?:, )?)+)(?: - .*)?$/.exec(line);
    if (!m) {
      bad.push('строка реестра не разобрана: ' + line.slice(0, 100));
      continue;
    }
    for (const api of m[2].match(/`([A-Za-z]+)`/g).map((x) => x.slice(1, -1))) {
      if (!WRITER_API.includes(api)) bad.push(m[1] + ': ' + api + ' - не API записи состояния (' + WRITER_API.join(', ') + ')');
      else entries.add(m[1] + ' ' + api);
    }
  }
  return { entries, bad };
}

function registerStateStaticProbes(ctx) {
  const { HOOKS, CLAUDE, ROOT, SELFTEST_FILES, check, tempDir, put, releaseTemp } = ctx;

  /**
   * Тексты, где может жить писатель состояния: хуки (с подкаталогами), команды, агенты, scripts/ (рекурсивно) -
   * { путь от корня: текст }. root - корень дерева (по умолчанию репозиторий; проба охвата - временное дерево).
   */
  function writerTexts(root = ROOT) {
    const claude = root === ROOT ? CLAUDE : path.join(root, '.claude');
    const hooks = root === ROOT ? HOOKS : path.join(claude, 'hooks');
    const texts = {};
    const take = (dir, rel, re) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && e.name !== 'node_modules') take(path.join(dir, e.name), rel + e.name + '/', re);
        else if (e.isFile() && re.test(e.name)) texts[rel + e.name] = fs.readFileSync(path.join(dir, e.name), 'utf8');
      }
    };
    take(hooks, '.claude/hooks/', /\.(js|mjs|cjs)$/);
    take(path.join(claude, 'commands'), '.claude/commands/', /\.md$/);
    take(path.join(claude, 'agents'), '.claude/agents/', /\.md$/);
    take(path.join(root, 'scripts'), 'scripts/', /\.(js|mjs|cjs)$/);
    return texts;
  }
  const probeFiles = new Set(SELFTEST_FILES.map((f) => '.claude/hooks/' + f));
  const LIB = '.claude/hooks/lib.js';

  check('запись .qa-state: мимо L.updateState (хуки с подкаталогами, .claude/commands/*.md, .claude/agents/*.md, scripts/; в lib.js - только функции механизма) - отказ: writeState в любой форме, запись и удаление в ФС (writeFileSync, renameSync, unlinkSync, rmSync, openSync, псевдоним и деструктуризация fs, многострочный вызов) по пути состояния или переменной с ним, запись оболочки (>, >>, tee, cp, mv, Set-Content, Out-File) в .qa-state в командах и агентах; комментарии не считаются', () => {
    const live = directStateWrites(writerTexts(), probeFiles, { [LIB]: LIB_STATE_WRITERS });
    if (live.length) return 'запись .qa-state мимо L.updateState: ' + live.join('; ');
    const ex = new Set(['.claude/hooks/selftest-x.js']);
    const allow = { [LIB]: LIB_STATE_WRITERS };
    const h = '.claude/hooks/h.js';
    const cmd = '.claude/commands/c.md';
    const cases = [
      ['L.writeState', { [h]: 'const s = 1;\n  if (changed) L.writeState(s);\n' }, [h + ':2: writeState']],
      ['writeState через ссылку и пробел', { [h]: 'const w = L.writeState;\nL.writeState (s);\n' }, [h + ':1: writeState', h + ':2: writeState']],
      ['writeFileSync(statePath)', { [h]: "fs.writeFileSync(L.statePath(), '{}');\n" }, [h + ":1: writeFileSync(L.statePath(), '{}')"]],
      ['переменная пути', { [h]: "const p = L.statePath();\nconst tmp = p + '.x';\nfs.writeFileSync(tmp, '{}');\n" }, [h + ":3: writeFileSync(tmp, '{}')"]],
      ['renameSync в путь состояния', { [h]: 'fs.renameSync(tmp, L.statePath());\n' }, [h + ':1: renameSync(tmp, L.statePath())']],
      ['многострочный вызов', { [h]: 'fs.appendFileSync(\n  path.join(dir, ".qa-state"),\n  body,\n);\n' }, [h + ':1: appendFileSync(path.join(dir, ".qa-state"), body,)']],
      ['openSync и writeSync', { [h]: "const fd = fs.openSync(L.statePath(), 'w');\nfs.writeSync(fd, x);\n" }, [h + ":1: openSync(L.statePath(), 'w')"]],
      ['unlinkSync блокировки и rmSync маркера', { [h]: 'fs.unlinkSync(L.stateLockPath());\nfs.rmSync(L.hookMarkerPath(n), { force: true });\n' }, [h + ':1: unlinkSync(L.stateLockPath())', h + ':2: rmSync(L.hookMarkerPath(n), { force: true })']],
      ['псевдоним и деструктуризация fs', { [h]: "const w = fs.writeFileSync;\nconst { writeFile: wf, unlink } = require('fs/promises');\nw(L.statePath(), x);\nawait wf(L.statePath(), x);\nawait unlink(L.stateLockPath());\n" }, [h + ':3: w(L.statePath(), x)', h + ':4: wf(L.statePath(), x)', h + ':5: unlink(L.stateLockPath())']],
      ['scripts/, хук selftest-* вне перечня, подкаталог хуков', { 'scripts/x.mjs': 'await fsp.writeFile(statePath(), x);\n', '.claude/hooks/selftest-y.js': "fs.writeFileSync('.claude/.qa-state', x);\n", '.claude/hooks/sub/z.js': "fs.writeFileSync('.claude/.qa-state', x);\n" }, ['scripts/x.mjs:1: writeFile(statePath(), x)', ".claude/hooks/selftest-y.js:1: writeFileSync('.claude/.qa-state', x)", ".claude/hooks/sub/z.js:1: writeFileSync('.claude/.qa-state', x)"]],
      ['прежняя строка qa.md', { '.claude/commands/qa.md': "node -e \"const fs=require('fs'),p='.claude/.qa-state';fs.writeFileSync(p,'{}')\"\n" }, [".claude/commands/qa.md:1: writeFileSync(p,'{}')"]],
      ['оболочка в командах и агентах', { [cmd]: 'echo {} > .claude/.qa-state\ncat x >> .claude/.qa-state\njq . s | tee .claude/.qa-state\ncp /tmp/s .claude/.qa-state\n', '.claude/agents/a.md': "Set-Content .claude/.qa-state '{}'\n" }, [cmd + ':1: shell } > .claude/.qa-state', cmd + ':2: shell x >> .claude/.qa-state', cmd + ':3: shell tee .claude/.qa-state', cmd + ':4: shell cp /tmp/s .claude/.qa-state', '.claude/agents/a.md:1: shell Set-Content .claude/.qa-state']],
      ['lib.js: запись вне функций механизма', { [LIB]: 'function bumpX(s) {\n  return writeState(s);\n}\nfunction writeState(o) {\n  fs.writeFileSync(statePath(), o);\n}\n' }, [LIB + ':2: writeState']],
      ['пропуск: комментарии, регулярное выражение с //, чужой путь, функции механизма lib.js, экспорт, модуль самопроверки, updateState, стрелка и цитата в *.md', {
        [h]: "/**\n * зовут writeState(s) пробы\n */\n// fs.writeFileSync(L.statePath(), x)\nconst re = /\\/\\//; /* L.writeState(x) */\nfs.writeFileSync(logFile, 'qa'); L.updateState(f);\n",
        [LIB]: 'function updateState(m) {\n  return writeState(m);\n}\nfunction noteHookHealth(n) {\n  fs.writeFileSync(hookMarkerPath(n), x);\n}\nmodule.exports = {\n  writeState,\n};\n',
        '.claude/hooks/selftest-x.js': 'L.writeState(s);\n',
        [cmd]: 'отметка -> `.claude/.qa-state` пишет markQa\n> цитата: .qa-state не правится руками\n',
      }, []],
    ];
    const miss = cases.map(([form, t, want]) => [form, directStateWrites(t, ex, allow), want]).filter(([, got, want]) => JSON.stringify(got) !== JSON.stringify(want));
    if (miss.length) return 'сверка слепа: ' + miss.map(([form, got]) => form + ' -> ' + JSON.stringify(got)).join('; ');
    // охват обхода: подкаталог хуков, агенты, вложенный scripts/ - в текстах; node_modules и чужое расширение - нет
    const dir = tempDir('state-static');
    try {
      for (const rel of ['.claude/hooks/sub/z.js', '.claude/hooks/node_modules/m.js', '.claude/hooks/x.txt', '.claude/agents/a.md', '.claude/commands/c.md', 'scripts/lib/s.mjs']) put(dir, rel, 'x\n');
      const got = Object.keys(writerTexts(dir)).sort();
      const want = ['.claude/agents/a.md', '.claude/commands/c.md', '.claude/hooks/sub/z.js', 'scripts/lib/s.mjs'];
      return JSON.stringify(got) === JSON.stringify(want) || 'обход текстов: ' + JSON.stringify(got) + ', ждали ' + JSON.stringify(want);
    } finally {
      releaseTemp(dir);
    }
  });

  check('запись .qa-state: реестр писателей ADR 0016 («### Реестр писателей») совпадает с вызовами updateState, markQa, markGates, bumpEdits, noteHookHealth в хуках, командах, агентах и scripts/ - писатель вне реестра и запись реестра без вызова - отказ', () => {
    const adr = fs.readFileSync(path.join(ROOT, 'docs', 'adr', '0016-qa-state-writes.md'), 'utf8');
    const reg = writerRegistry(adr);
    if (reg.bad.length) return reg.bad.join('; ');
    const live = stateWriterCalls(writerTexts(), probeFiles);
    const missing = Array.from(live).filter((x) => !reg.entries.has(x));
    const stale = Array.from(reg.entries).filter((x) => !live.has(x));
    if (missing.length || stale.length) return (missing.length ? 'писатели вне реестра ADR 0016: ' + missing.join(', ') : '') + (missing.length && stale.length ? '; ' : '') + (stale.length ? 'в реестре без вызова: ' + stale.join(', ') : '');
    const t = { '.claude/hooks/h.js': "function bumpEdits(n) {}\n// L.markQa()\nthrow new TypeError('markGates(code, labels): x');\nL.bumpEdits(1);\n", '.claude/hooks/selftest-x.js': 'L.updateState(f);\n' };
    const got = Array.from(stateWriterCalls(t, new Set(['.claude/hooks/selftest-x.js'])));
    const regGot = writerRegistry('### Реестр писателей\n- `.claude/hooks/h.js` зовёт `bumpEdits`, `markQa` - описание `x`\n- `a.js` пишет сам\n## Дальше\n- `b.js` зовёт `updateState`\n');
    const want = { calls: ['.claude/hooks/h.js bumpEdits'], entries: ['.claude/hooks/h.js bumpEdits', '.claude/hooks/h.js markQa'], bad: ['строка реестра не разобрана: - `a.js` пишет сам'] };
    const gotAll = { calls: got, entries: Array.from(regGot.entries), bad: regGot.bad };
    return JSON.stringify(gotAll) === JSON.stringify(want) || 'сверка слепа: ' + JSON.stringify(gotAll);
  });
}

module.exports = { registerStateStaticProbes };
