'use strict';
/**
 * Общие утилиты для хуков Claude Code. Node без внешних зависимостей.
 *
 * Один комплект хуков обслуживает несколько репозиториев, лежащих рядом:
 *   D:\newDev\.claude\hooks\*.js   - сами хуки
 *   D:\newDev\.claude\            - единое изменяемое состояние
 *   D:\newDev\books, books-front, books-app-docs - репозитории, у каждого свой .git
 *
 * Поэтому репозиторий определяется НЕ по текущему каталогу, а по пути затронутого файла:
 * агент может быть запущен и из родительской папки, и изнутри любого репозитория.
 *
 * Контракт хука: JSON на stdin, ответ через код выхода.
 *   deny(reason)    - запретить действие (только PreToolUse): stdout + exit 0
 *   complain(text)  - заставить агента отработать замечания: stderr + exit 2
 *   pass()          - пропустить: exit 0 без вывода
 *
 * Все проверки кода работают ТОЛЬКО по добавленным строкам относительно базовой ветки.
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const HOOKS_DIR = __dirname;
const STATE_DIR = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- ввод и вывод

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        resolve(buf.trim() ? JSON.parse(buf) : {});
      } catch (_) {
        resolve({});
      }
    };
    const timer = setTimeout(finish, 5000);
    timer.unref && timer.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      buf += c;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

function deny(reason, eventName) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName || 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: String(reason),
      },
    }),
  );
  process.exit(0);
}

function complain(text) {
  process.stderr.write(String(text));
  process.exit(2);
}

function pass() {
  process.exit(0);
}

/**
 * Хук никогда не должен ронять сессию своей ошибкой.
 *
 * По умолчанию ошибка внутри хука означает «пропустить»: для советующих хуков это верно -
 * сломанный советчик не должен мешать работать.
 *
 * 🔴 Для ЗАМКОВ это неверно, и цена ошибки здесь другая. Замок, упавший на исключении,
 * молча превращается в разрешение: агент видит ровно то же самое, что при успешной
 * проверке - пустой stdout и код 0. Так уже случилось 25.08.2026: одна опечатка
 * (`const i` там, где ниже `i += 2`) выключила commit-gate целиком, и заметила это
 * только матрица проб, а не работа.
 *
 * Поэтому `guard(fn, { failClosed: true })` при ошибке отказывает и называет причину.
 * Ложный отказ дёшев - агент читает сообщение и чинит хук; ложное разрешение стоит
 * коммита мимо проверок или миграции на боевой базе.
 */
/**
 * Отметка о здоровье Stop-хука: detail - текст падения, null - хук отработал.
 * Читает её commit-gate.js; чинится она сама, как только хук пройдёт без исключения.
 */
function noteHookHealth(name, detail) {
  try {
    const state = readState();
    const broken = state.brokenHooks && typeof state.brokenHooks === 'object' ? state.brokenHooks : {};
    if (detail) {
      broken[name] = { at: new Date().toISOString(), detail: String(detail).split('\n')[0] };
    } else {
      delete broken[name];
    }
    if (Object.keys(broken).length) state.brokenHooks = broken;
    else delete state.brokenHooks;
    writeState(state);
  } catch (_) {
    /* состояние недоступно - молчим, иначе сломаем хук ради отметки о поломке */
  }
}

function guard(fn, opts) {
  const failClosed = Boolean(opts && opts.failClosed);
  // 🔴 Событие важно: deny() понимает только PreToolUse. На Stop его JSON никто не читает,
  // и failClosed молча превратился бы обратно в fail-open. Там отказ - это complain (код 2).
  const onStop = Boolean(opts && opts.stop);
  // Имя хука в тексте падения: общая guard() не должна утверждать, что упало
  // именно то, что упало у первого из них.
  const who = (opts && opts.name) || 'Проверка';
  Promise.resolve()
    .then(fn)
    .then((verdict) => {
      // 🔴 Отметка о поломке снимается только когда хук ДЕЙСТВИТЕЛЬНО отработал, то есть
      // вернул true. Ранний выход по stop_hook_active - это молчание, а не работа: он
      // завершается успешно, и снятие отметки на нём стирало бы память о падении ровно
      // на следующей же остановке, то есть всегда.
      if (onStop && opts.name && verdict === true) noteHookHealth(opts.name, null);
      pass();
    })
    .catch((e) => {
      const detail = (e && (e.stack || e.message)) || String(e);
      if (process.env.CLAUDE_HOOK_DEBUG) process.stderr.write('hook error: ' + detail + '\n');
      if (!failClosed) process.exit(0);
      if (onStop) {
        // 🔴 Отказ на Stop живёт один заход, и это не лечится здесь: stop_hook_active
        // проверяется раньше любого кода, который может упасть, иначе получится петля.
        // Поэтому падение записывается в состояние, а отвечает за него commit-gate -
        // он висит на PreToolUse, разбирает каждую команду заново и петли не образует.
        // Несданный ход безвреден, закоммиченная работа - нет; замок и есть та точка,
        // где сломанная проверка обязана остановить, а не просто пожаловаться.
        noteHookHealth(opts.name || 'stop-hook', detail);
        complain(
          who + ' сломалась и не смогла вынести решение, поэтому работа не закрыта.\n\n' +
            String(detail).split('\n').slice(0, 4).join('\n') +
            '\n\nЭто ошибка в самом хуке, а не в твоей работе. Почини хук и повтори:\n' +
            '  node ' + HOOKS_DIR.replace(/\\/g, '/') + '/harness-selftest.js\n' +
            'Молча пропустить нельзя: проверка, упавшая на исключении, неотличима от снятой.\n',
        );
      }
      deny(
        'Проверка сломалась и не смогла вынести решение, поэтому действие не пропущено.\n\n' +
          String(detail).split('\n').slice(0, 4).join('\n') +
          '\n\nЭто ошибка в самом хуке, а не в твоей команде. Почини хук и повтори:\n' +
          '  node ' + HOOKS_DIR.replace(/\\/g, '/') + '/harness-selftest.js\n' +
          'Молча пропустить нельзя: замок, упавший на исключении, неотличим от снятого.',
      );
    });
}

// ------------------------------------------------------------------------ git

function sh(cmd, args, cwd) {
  try {
    const r = cp.spawnSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  } catch (_) {
    return { ok: false, out: '', err: '' };
  }
}

// ------------------------------------------------------------------ репозитории

let _repos = null;

/**
 * Список репозиториев: [{ name, path }].
 * Сначала repos.json рядом с хуками, иначе - соседние папки с .git.
 */
function knownRepos() {
  if (_repos) return _repos;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, 'repos.json'), 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.repos;
    if (Array.isArray(list) && list.length) {
      _repos = list
        .map((r) => ({ name: r.name, path: path.resolve(HOOKS_DIR, r.path) }))
        .filter((r) => r.name && fs.existsSync(r.path));
      if (_repos.length) return _repos;
    }
  } catch (_) {
    /* ищем сами */
  }
  const parent = path.resolve(STATE_DIR, '..');
  const out = [];
  if (fs.existsSync(path.join(parent, '.git'))) {
    out.push({ name: path.basename(parent), path: parent });
  } else {
    let names = [];
    try {
      names = fs.readdirSync(parent);
    } catch (_) {
      names = [];
    }
    for (const n of names) {
      const p = path.join(parent, n);
      try {
        if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, '.git'))) {
          out.push({ name: n, path: p });
        }
      } catch (_) {
        /* пропускаем */
      }
    }
  }
  _repos = out;
  return _repos;
}

/** Репозиторий, которому принадлежит файл. null - файл вне наших репозиториев. */
function repoFor(absPath) {
  if (!absPath) return null;
  const abs = path.resolve(absPath);
  let best = null;
  for (const r of knownRepos()) {
    const withSep = r.path.endsWith(path.sep) ? r.path : r.path + path.sep;
    if (abs === r.path || abs.startsWith(withSep)) {
      if (!best || r.path.length > best.path.length) best = r;
    }
  }
  return best;
}

/** Путь относительно корня репозитория, всегда через прямые слэши. */
function rel(repoPath, p) {
  if (!p) return '';
  const root = typeof repoPath === 'string' ? repoPath : repoPath && repoPath.path;
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
  return path.relative(root, abs).split(path.sep).join('/');
}

/** Подпись файла в сообщениях: "sf/apps/api/src/server.ts". */
function label(repo, relPath) {
  return (repo && repo.name ? repo.name + '/' : '') + relPath;
}

// -------------------------------------------------------------------- правила

const _rulesCache = new Map();

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** Общие пороги: qaLock, answerFormat. */
function commonRules() {
  return (
    readJson(path.join(HOOKS_DIR, 'rules.common.json')) || {
      qaLock: { threshold: 10 },
      answerFormat: { maxProse: 2200 },
      baseBranch: 'main',
    }
  );
}

/** Правила конкретного репозитория. Нет своих - общие. */
function rulesFor(repo) {
  const name = repo && repo.name;
  if (!name) return commonRules();
  if (_rulesCache.has(name)) return _rulesCache.get(name);
  const own =
    readJson(path.join(HOOKS_DIR, 'rules.' + name + '.json')) ||
    readJson(path.join(repo.path, '.claude', 'hooks', 'rules.json'));
  const base = commonRules();
  const merged = own ? Object.assign({}, base, own) : base;
  if (!merged.repo) merged.repo = name;
  _rulesCache.set(name, merged);
  return merged;
}

// -------------------------------------------------------------------- шаблоны

/** glob -> RegExp. Поддержаны ** / * / ? и списки {a,b}. */
function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

const _reCache = new Map();
function matchGlob(glob, relPath) {
  let re = _reCache.get(glob);
  if (!re) {
    re = globToRe(glob);
    _reCache.set(glob, re);
  }
  return re.test(relPath);
}

function matchAny(globs, relPath) {
  return (globs || []).some((g) => matchGlob(g, relPath));
}

// ---------------------------------------------------------------------- ввод

/** Все файлы, которых касается текущий вызов инструмента. */
function targetFiles(input) {
  const ti = (input && input.tool_input) || {};
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim()) out.push(v);
  };
  push(ti.file_path);
  push(ti.notebook_path);
  push(ti.path);
  if (Array.isArray(ti.edits)) ti.edits.forEach((e) => e && push(e.file_path));
  if (Array.isArray(ti.files)) ti.files.forEach((e) => push(typeof e === 'string' ? e : e && e.file_path));
  return Array.from(new Set(out));
}

// ------------------------------------------------------- дифф и добавленные строки

/**
 * Точка отсчёта. Сначала merge-base с базовой веткой; если её нет или она совпала
 * с HEAD (работаем прямо в базовой ветке) - берём HEAD, то есть незакоммиченные правки.
 */
function baseRef(repo, rules) {
  const root = repo.path;
  const base = (rules && rules.baseBranch) || 'main';
  const head = sh('git', ['rev-parse', 'HEAD'], root);
  for (const ref of [base, 'origin/' + base]) {
    const mb = sh('git', ['merge-base', 'HEAD', ref], root);
    if (mb.ok && mb.out && !(head.ok && mb.out === head.out)) return mb.out;
  }
  return 'HEAD';
}

/** Файлы текущего диффа репозитория: изменённые относительно базы плюс новые неотслеживаемые. */
function changedFiles(repo, rules) {
  const root = repo.path;
  const base = baseRef(repo, rules || rulesFor(repo));
  const set = new Set();
  const d = sh('git', ['diff', '--name-only', base], root);
  if (d.ok) d.out.split('\n').filter(Boolean).forEach((f) => set.add(f));
  const u = sh('git', ['ls-files', '--others', '--exclude-standard'], root);
  if (u.ok) u.out.split('\n').filter(Boolean).forEach((f) => set.add(f));
  return Array.from(set);
}

/** Дифф по всем известным репозиториям: [{ repo, rules, files }], только непустые. */
function allChanged() {
  const out = [];
  for (const repo of knownRepos()) {
    const rules = rulesFor(repo);
    const files = changedFiles(repo, rules);
    if (files.length) out.push({ repo, rules, files });
  }
  return out;
}

/** Отслеживается ли файл гитом. */
function isTracked(repo, relPath) {
  return sh('git', ['ls-files', '--error-unmatch', relPath], repo.path).ok;
}

/**
 * Только ДОБАВЛЕННЫЕ строки файла относительно базы: [{ line, text }].
 * Новый файл целиком считается добавленным.
 */
function addedLines(repo, rules, relPath) {
  const root = repo.path;
  if (!isTracked(repo, relPath)) {
    try {
      const txt = fs.readFileSync(path.join(root, relPath), 'utf8');
      return txt.split(/\r?\n/).map((text, i) => ({ line: i + 1, text }));
    } catch (_) {
      return [];
    }
  }
  const base = baseRef(repo, rules || rulesFor(repo));
  const d = sh('git', ['diff', '--unified=0', '--no-color', base, '--', relPath], root);
  if (!d.ok || !d.out) return [];
  const out = [];
  let cur = 0;
  for (const line of d.out.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) {
      cur = parseInt(m[1], 10);
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      out.push({ line: cur, text: line.slice(1) });
      cur++;
    }
  }
  return out;
}

// ------------------------------------------------------------------ состояние

function statePath() {
  return path.join(STATE_DIR, '.qa-state');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch (_) {
    return { edits: 0, strayFiles: [], lastQa: null };
  }
}

function writeState(obj) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(obj, null, 2));
  } catch (_) {
    /* состояние - не повод падать */
  }
}

function bumpEdits(n) {
  const s = readState();
  s.edits = (s.edits || 0) + (n || 1);
  writeState(s);
  return s.edits;
}

// ------------------------------------------------------------------ транскрипт

/** Текст последнего сообщения ассистента из transcript_path (jsonl). */
function lastAssistantText(transcriptPath) {
  if (!transcriptPath) return '';
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch (_) {
    return '';
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch (_) {
      continue;
    }
    const msg = rec && (rec.message || rec);
    const role = (msg && msg.role) || rec.type;
    if (role !== 'assistant') continue;
    const content = msg && msg.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}

/** Сколько ходов пользователя было в сессии. */
function userTurnCount(transcriptPath) {
  if (!transcriptPath) return 0;
  try {
    return fs
      .readFileSync(transcriptPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((l) => {
        try {
          const r = JSON.parse(l);
          const m = r.message || r;
          return (m.role || r.type) === 'user';
        } catch (_) {
          return false;
        }
      }).length;
  } catch (_) {
    return 0;
  }
}

/** Объём прозы: без блоков кода, таблиц и служебных строк. */
function proseLength(text) {
  if (!text) return 0;
  const noFence = String(text).replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const kept = noFence
    .split(/\r?\n/)
    .filter((l) => !/^\s*\|/.test(l))
    .filter((l) => !/^\s*[-=]{3,}\s*$/.test(l))
    .join('\n');
  return kept.replace(/\s+/g, ' ').trim().length;
}

module.exports = {
  HOOKS_DIR,
  STATE_DIR,
  readStdin,
  deny,
  complain,
  pass,
  guard,
  sh,
  knownRepos,
  repoFor,
  rel,
  label,
  commonRules,
  rulesFor,
  targetFiles,
  matchGlob,
  matchAny,
  baseRef,
  changedFiles,
  allChanged,
  isTracked,
  addedLines,
  readState,
  writeState,
  bumpEdits,
  statePath,
  lastAssistantText,
  userTurnCount,
  proseLength,
};
