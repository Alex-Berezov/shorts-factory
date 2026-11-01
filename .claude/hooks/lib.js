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
const crypto = require('crypto');

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

/**
 * session_id входа хука, если он похож на номер сессии, иначе ''. Номер становится ключом
 * в состоянии (lengthNotes), поэтому пропускаются только [A-Za-z0-9_-]{1,128} и не имена
 * свойств Object.prototype (__proto__, constructor и т.п.).
 */
function sessionIdOf(input) {
  const id = input && typeof input.session_id === 'string' ? input.session_id : '';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return '';
  return id in Object.prototype ? '' : id;
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
 * Читает её commit-gate.js (brokenHooks); чинится она сама, как только хук пройдёт без исключения.
 * Пишет через updateState; снимать нечего (отметки нет) - состояние не трогается. Запись состояния с
 * detail не удалась (блокировка занята, состояние недоступно) - пишется запасной маркер
 * hookMarkerPath(name) без блокировки (решение техлида Р-6 E0-12AE), его читает тот же brokenHooks();
 * снятие (null) удаляет маркер только после удачной записи состояния. Имя не из [a-z0-9-] (hookMarkerPath) - ошибка
 * сразу, ничего не пишется (Р-8). Возвращает null - отметка записана (в состояние или маркером) или снята, иначе
 * ошибку; не бросает: хук не падает ради отметки, потерю отметки guard называет в отказе Stop-хука, отказ снятия -
 * строкой в stderr.
 */
function noteHookHealth(name, detail) {
  try {
    const marker = hookMarkerPath(name);
    const firstLine = String(detail || '').split('\n')[0];
    const failed = updateState(
      (state) => {
        const broken = state.brokenHooks && typeof state.brokenHooks === 'object' ? state.brokenHooks : {};
        if (detail) broken[name] = { at: new Date().toISOString(), detail: firstLine };
        else delete broken[name];
        if (Object.keys(broken).length) state.brokenHooks = broken;
        else delete state.brokenHooks;
        return true;
      },
      { changes: (state) => Boolean(detail) || Boolean(state.brokenHooks && Object.prototype.hasOwnProperty.call(state.brokenHooks, name)) },
    );
    if (!detail) return failed || unlinkRetry(marker);
    if (!failed) return null;
    try {
      fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), detail: firstLine }) + '\n');
      return null;
    } catch (e) {
      return new Error(failed.message + '; маркер ' + marker + ' не записан: ' + (codeOf(e) || asError(e).message));
    }
  } catch (e) {
    return asError(e);
  }
}

/**
 * Запасной маркер поломки Stop-хука name (решение техлида Р-6 E0-12AE): <statePath(env)>.broken-<имя>. Имя -
 * часть пути: не строка из [a-z0-9-] - исключение, общего имени на все такие хуки нет (решение техлида Р-8 E0-12AE:
 * удачный проход одного снимал бы маркер другого). Путь только через statePath (SF_HOOK_STATE_DIR, refuseStatePath).
 */
const HOOK_MARKER_INFIX = '.broken-';
function hookMarkerPath(name, env = process.env) {
  if (typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name)) {
    throw new Error('имя Stop-хука ' + JSON.stringify(name === undefined ? null : name) + ' не из [a-z0-9-] - маркер поломки не построить');
  }
  return statePath(env) + HOOK_MARKER_INFIX + name;
}

/**
 * Отметки о поломке Stop-хуков для замка коммита: brokenHooks состояния и маркеры hookMarkerPath в каталоге
 * состояния - { имя: { detail } }. Каталога нет - маркеров нет; иной сбой чтения каталога или состояния -
 * исключение (fail-closed: замок, который не прочитал отметки, не пускает). Маркер не разобрать - он всё
 * равно отметка, с причиной вместо текста.
 */
function brokenHooks() {
  const p = statePath();
  const state = readState();
  const out = Object.assign({}, state.brokenHooks && typeof state.brokenHooks === 'object' ? state.brokenHooks : {});
  let names = [];
  try {
    names = fs.readdirSync(path.dirname(p));
  } catch (e) {
    if (!isGone(e)) throw e;
  }
  const prefix = path.basename(p) + HOOK_MARKER_INFIX;
  for (const n of names) {
    if (!n.startsWith(prefix) || n.length === prefix.length) continue;
    const name = n.slice(prefix.length);
    if (Object.prototype.hasOwnProperty.call(out, name)) continue;
    let detail;
    try {
      detail = String(JSON.parse(fs.readFileSync(path.join(path.dirname(p), n), 'utf8')).detail || '');
    } catch (e) {
      detail = 'маркер ' + n + ' не прочитан (' + (codeOf(e) || asError(e).message) + ')';
    }
    out[name] = { detail: detail || 'без текста' };
  }
  return out;
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
      // Снять не удалось - одна строка в stderr, не отказ: хук отработал, а отметка и маркер остаются, и замок
      // коммита отказывает по ним до следующего удачного прохода (решение техлида Р-8 E0-12AE)
      if (onStop && opts.name && verdict === true) {
        const left = noteHookHealth(opts.name, null);
        if (left) process.stderr.write(who + ': отметку о поломке не снять (' + left.message.split('\n')[0] + ') - замок коммита отказывает по ней до следующего удачного прохода\n');
      }
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
        // Отметку не записать ни в состояние, ни запасным маркером - замок коммита о поломке не узнает:
        // это сказано в том же отказе, который читает агент (ревью E0-12AE, круг 1, Б2; решение техлида Р-6)
        const lost = noteHookHealth(opts && opts.name, detail);
        complain(
          who + ' сломалась и не смогла вынести решение, поэтому работа не закрыта.\n\n' +
            String(detail).split('\n').slice(0, 4).join('\n') +
            '\n\nЭто ошибка в самом хуке, а не в твоей работе. Почини хук и повтори:\n' +
            '  node ' + HOOKS_DIR.replace(/\\/g, '/') + '/harness-selftest.js\n' +
            'Молча пропустить нельзя: проверка, упавшая на исключении, неотличима от снятой.\n' +
            (lost
              ? '\nОтметка о поломке не записана ни в .qa-state, ни маркером (' + lost.message + '): замок коммита о ней не узнает.\n'
              : ''),
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

/**
 * Команда без оболочки: { ok, out, err }. out обрезан по краям (trim), с opts.raw - нет: вывод с
 * разделителем NUL (git -z) несёт имена файлов, у которых пробел в начале или в конце - часть имени.
 */
function sh(cmd, args, cwd, opts) {
  try {
    const r = cp.spawnSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    const out = r.stdout || '';
    return { ok: r.status === 0, out: opts && opts.raw ? out : out.trim(), err: (r.stderr || '').trim() };
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

/**
 * Обратное к label: репозиторий из repos и путь от его корня, null - метка ни одного из repos. Имя
 * репозитория бывает префиксом другого ("sf" и "sf/x"): берётся самое длинное подошедшее.
 */
function unlabel(repos, text) {
  let best = null;
  for (const repo of repos || []) {
    if (!repo || !repo.name || !String(text).startsWith(repo.name + '/')) continue;
    if (!best || repo.name.length > best.repo.name.length) best = { repo, rel: String(text).slice(repo.name.length + 1) };
  }
  return best;
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

/**
 * Список standards репозитория: общие правила первыми, затем свои; общее правило
 * с id, который есть в своём списке, уступает своему. Не массив - пустой список.
 */
function mergeStandards(common, own) {
  const mine = Array.isArray(own) ? own : [];
  // В множество - только строковые id: правило без id не вытесняет общие правила без id.
  const ids = new Set(mine.map((rule) => rule && rule.id).filter((id) => typeof id === 'string'));
  const shared = (Array.isArray(common) ? common : []).filter((rule) => !(rule && typeof rule.id === 'string' && ids.has(rule.id)));
  return shared.concat(mine);
}

/** Правила конкретного репозитория. Нет своих - общие; standards - склейка (mergeStandards). */
function rulesFor(repo) {
  const name = repo && repo.name;
  if (!name) return commonRules();
  if (_rulesCache.has(name)) return _rulesCache.get(name);
  const own =
    readJson(path.join(HOOKS_DIR, 'rules.' + name + '.json')) ||
    readJson(path.join(repo.path, '.claude', 'hooks', 'rules.json'));
  const base = commonRules();
  const merged = own ? Object.assign({}, base, own) : base;
  // standards склеиваются, а не заменяются: общие правила (W..) действуют и
  // в репозитории со своим списком; одинаковый id - побеждает правило репозитория.
  if (own) merged.standards = mergeStandards(base.standards, own.standards);
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

/**
 * Путь к .qa-state. SF_HOOK_STATE_DIR - служебная переменная самопроверки обвязки:
 * harness-selftest.js ставит её во временную папку на весь прогон, чтобы пробы не трогали
 * боевое состояние (решение техлида 03.10.2026). Читается только здесь.
 * Путь, закрытый refuseStatePath в этом процессе, - исключение, а не путь: readState и writeState
 * его не читают и не пишут (writeState зовёт statePath до своего try). env - окружение (по умолчанию
 * процесса): самопроверка берёт боевой путь как statePath({}) до refuseStatePath, без своей копии
 * правила пути (решение техлида Р6 E0-12AA).
 */
function statePath(env = process.env) {
  const override = env.SF_HOOK_STATE_DIR;
  const p = path.join(override ? path.resolve(override) : STATE_DIR, '.qa-state');
  if (refusedState !== null && foldPath(p) === refusedState) {
    throw new Error('путь состояния ' + p + ' закрыт в этом процессе (refuseStatePath): боевой .qa-state пишут только хуки сессии');
  }
  return p;
}

/**
 * Путь состояния, закрытый в этом процессе (refuseStatePath), в сравнимой форме (foldPath); null - не
 * закрыт. Хуки сессии refuseStatePath не зовут - у них statePath прежний.
 */
let refusedState = null;
/**
 * Абсолютный путь p для сравнения: на Windows без учёта регистра. Единственная нормализация путей
 * состояния обвязки (решение техлида Р6 E0-12AA): statePath, samePath и hookStateGuard самопроверки
 * сравнивают через неё, своей копии нет.
 */
function foldPath(p) {
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}
/**
 * Закрыть путь состояния file в этом процессе: statePath на нём - исключение до конца процесса
 * (самопроверка обвязки закрывает боевой .qa-state в начале прогона, решение техлида Р3 E0-12AA:
 * запись в боевое состояние из процесса самопроверки - отказ, а не тихая запись).
 */
function refuseStatePath(file) {
  refusedState = foldPath(file);
}

function defaultState() {
  return { edits: 0, strayFiles: [], lastQa: null };
}

/**
 * Код упавшего системного вызова (`ENOENT`, ...); undefined для любого другого значения.
 */
function codeOf(error) {
  return error instanceof Error && typeof error.code === 'string' ? error.code : undefined;
}

/**
 * Ошибка как Error: брошенное не-Error (строка, число) - Error с его текстом. Одна нормализация обвязки
 * (ревью E0-12AE, Б13): writeState, updateState и gates.js (writeRed) берут её, своей копии нет.
 */
function asError(e) {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Путь пропал: `ENOENT` и ничего больше. Близнец `isGone` из `scripts/lib/files.mjs` для хуков
 * (CJS не импортирует ESM без флага на Node 22.0-22.11, решение Р4 техлида E0-12N): EPERM, EBUSY,
 * EACCES - путь не прочитать, а не его нет. Что близнец отвечает так же, как оригинал, на ENOENT,
 * ENOTDIR, EPERM и EACCES, сверяет проба harness-selftest.js.
 */
function isGone(error) {
  return codeOf(error) === 'ENOENT';
}

/**
 * По пути нет файла: его нет (`isGone`) или на месте каталога в пути лежит файл (`ENOTDIR`).
 * Для вопросов «файл ли это», где сломанный путь - тоже «не файл»; прочие сбои - не ответ.
 */
function isNotFile(error) {
  return isGone(error) || codeOf(error) === 'ENOTDIR';
}

/**
 * stat пути p или null, если пути нет (`isNotFile`: ENOENT, ENOTDIR); иной сбой (EACCES, EPERM) -
 * исключение, а не «нет». Один помощник «путь есть» обвязки (TECH_DEBT 23.10.2026 E0-12T, E15):
 * его берут absent самопроверки, DISK.isFile int-пробы и проверка конфига selftest-vitest.mjs.
 * stat - fs.statSync (через ссылку), fs.lstatSync (сама запись) или подмена для кейса.
 */
function statIfPresent(p, stat = fs.statSync) {
  try {
    return stat(p);
  } catch (e) {
    if (isNotFile(e)) return null;
    throw e;
  }
}

/** По пути p - файл (stat через ссылку): пути нет - false, каталог - false, иной сбой - исключение. */
function isFilePresent(p, stat = fs.statSync) {
  const st = statIfPresent(p, stat);
  return Boolean(st && st.isFile());
}

/**
 * Дефолт - только когда файла нет (ENOENT), он не разбирается (SyntaxError) или разобран
 * не в объект (null, массив, строка). Любая другая ошибка чтения пробрасывается: дефолт
 * на ней ушёл бы обратно в файл первым же писателем и стёр lastQa/lastGates. Испорченный
 * файл здесь не чинится записью (решение техлида 03.10.2026).
 */
function readState() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch (e) {
    if (isGone(e) || e instanceof SyntaxError) return defaultState();
    throw e;
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : defaultState();
}

/**
 * Синхронная пауза потока на ms миллисекунд (Atomics.wait): одна на обвязку - повтор rename здесь, повтор
 * чтения файла диффа (diff-hash.js), ожидание ребёнка int-пробы (selftest-int.js).
 */
function pauseSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Первые n элементов списка через запятую и «и ещё K», если их больше: один помощник списка в строке вывода
 * обвязки (решение техлида Р7 E0-12AB) - потребители diff-hash.js (отказы замка коммита) и gates.js (строка
 * «Дифф изменился»).
 */
function shortList(list, n = 6) {
  return list.slice(0, n).join(', ') + (list.length > n ? ' и ещё ' + (list.length - n) : '');
}

/** Коды, на которых rename на win32 падает эпизодически (файл держит антивирус или читатель). */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 3;
const RENAME_PAUSE_MS = 25;

/**
 * fn() с повтором на RENAME_RETRY_CODES (на win32 файл держит антивирус или читатель): до RENAME_ATTEMPTS
 * попыток с паузой RENAME_PAUSE_MS; прочий сбой и сбой последней попытки бросаются. Один цикл повтора у
 * rename/unlink/чтения блокировки и writeState (ревью E0-12AE, круг 2, CR9; решение техлида Р-7 п.3).
 */
function retrySync(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (!RENAME_RETRY_CODES.has(codeOf(e)) || attempt >= RENAME_ATTEMPTS) throw e;
      pauseSync(RENAME_PAUSE_MS);
    }
  }
}

/** Временный файл атомарной записи состояния этого процесса: <statePath(env)>.<pid>.tmp. */
function stateTmpPath(env = process.env) {
  return statePath(env) + '.' + process.pid + '.tmp';
}

/**
 * Запись целиком через временный файл и rename: читатель видит либо старый файл, либо новый,
 * но не недописанный. rename повторяется (retrySync), после последней неудачи на RENAME_RETRY_CODES
 * файл пишется напрямую - отметка важнее атомарности. Read-modify-write состояния писатели делают не
 * здесь, а через updateState (под блокировкой .qa-state.lock, docs/adr/0016-qa-state-writes.md);
 * writeState зовут updateState и пробы самопроверки.
 * Возвращает null - записано, или ошибку записи: хуку сессии состояние - не повод падать, и он
 * её не смотрит, а отметки (diff-hash.js markQa, markGates) обязаны её увидеть - иначе прежняя
 * отметка молча осталась бы под словами «записана» (решение техлида Р9 E0-12AB, п.8).
 */
function writeState(obj) {
  const p = statePath();
  const tmp = stateTmpPath();
  const body = JSON.stringify(obj, null, 2);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, body);
    try {
      retrySync(() => fs.renameSync(tmp, p));
      return null;
    } catch (e) {
      if (!RENAME_RETRY_CODES.has(codeOf(e))) throw e;
    }
    fs.writeFileSync(p, body);
    return null;
  } catch (e) {
    return asError(e);
  } finally {
    /* недописанный или не переименованный временный файл не оставляем */
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_e) {
      /* нечего убирать */
    }
  }
}

/*
 * Блокировка read-modify-write состояния (docs/adr/0016-qa-state-writes.md, решение техлида Р-3 E0-12AE):
 * файл <statePath()>.lock, взятый openSync(lock, 'wx'); в нём токен владельца (pid и случайная часть) и время.
 * Занята - пауза RENAME_PAUSE_MS и повтор до waitMs по монотонным часам процесса; старше staleMs (mtimeMs файла
 * против Date.now(): часы локальной ФС и ОС одни) - её оставил упавший процесс, она снимается и берётся заново.
 * Снимает блокировку только claimStateLock: rename в сторону, сверка отодвинутого, возврат на место, если это
 * не та блокировка (ревью E0-12AE, круг 1, Б4): свежую чужую не снимает ни снятие протухшей, ни finally владельца.
 */
const STATE_LOCK_WAIT_MS = 1000;
const STATE_LOCK_STALE_MS = 5000;
/**
 * Пределы, которые читает takeStateLock; в бою - STATE_LOCK_WAIT_MS и STATE_LOCK_STALE_MS. Меняет их только
 * предзагрузка проб самопроверки (node -r в дочернем процессе пробы), чтобы пробы не держались на часах
 * нагруженной машины (ревью E0-12AE, круг 1, Б11); переменной окружения у них нет. Значение - не конечное
 * число или меньше нуля - при чтении заменяется константой (решение техлида Р-7): отрицательный staleMs
 * сделал бы протухшей любую блокировку.
 */
const stateLockLimits = { waitMs: STATE_LOCK_WAIT_MS, staleMs: STATE_LOCK_STALE_MS };
/** Предел value из stateLockLimits, если это конечное неотрицательное число, иначе константа fallback. */
function lockLimit(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}
/** Коды openSync(lock, 'wx'), на которых блокировку берут заново: занята (EEXIST), на win32 - EBUSY/EPERM от антивируса и читателя. */
const STATE_LOCK_RETRY_CODES = new Set(['EEXIST', 'EBUSY', 'EPERM']);
/**
 * Сколько раз за один вызов takeStateLock после снятия протухшей (или пропавшей) блокировки её берут заново
 * без сверки с пределом ожидания; счёт за вызов не обнуляется - дальше каждая попытка сверяется с пределом.
 */
const STATE_LOCK_FREE_RETRIES = 3;

/**
 * Путь блокировки состояния: рядом с .qa-state, через statePath(env) (SF_HOOK_STATE_DIR, refuseStatePath).
 * env - как у statePath: пробы строят путь блокировки своего каталога им же, а не своей склейкой имени.
 */
function stateLockPath(env = process.env) {
  return statePath(env) + '.lock';
}

/** Уникальный токен владельца блокировки: pid и 8 случайных байт. */
function lockToken() {
  return process.pid + '-' + crypto.randomBytes(8).toString('hex');
}

/** Токен владельца из текста файла блокировки (первое слово); '' - его нет. */
function tokenIn(text) {
  return String(text).split(/\s/)[0] || '';
}

/** Токен в файле блокировки f сейчас (чтение через retrySync); файла нет - ''. */
function tokenAt(f) {
  try {
    return tokenIn(retrySync(() => fs.readFileSync(f, 'utf8')));
  } catch (e) {
    if (isGone(e)) return '';
    throw e;
  }
}

/** unlink файла f с повтором (retrySync); ENOENT - уже нет. null или ошибка последней попытки. */
function unlinkRetry(f) {
  try {
    retrySync(() => fs.unlinkSync(f));
    return null;
  } catch (e) {
    return isGone(e) ? null : asError(e);
  }
}

/**
 * Отодвинутая блокировка lock: <lock>-<токен>.tmp рядом с ней - из самого lock, а не из statePath() процесса:
 * у вызывающего с чужим env rename в другой каталог дал бы EXDEV (ревью E0-12AE, круг 2, CR7). token - для
 * проб самопроверки (форма имени из одного места).
 */
function asidePath(lock, token = lockToken()) {
  return lock + '-' + token + '.tmp';
}

/**
 * Снять блокировку lock, только если она та, что можно снимать: rename lock -> asidePath(lock) (атомарно:
 * отодвинут ровно тот файл, что лежал), removable(отодвинутый) - и unlink его, иначе возврат на место linkSync
 * (не перезаписывает блокировку, взятую за это время). Итог: 'removed' - снята; 'gone' - её уже нет; 'kept' -
 * не та, возвращена; ошибка - rename не удался, или не та и вернуть не удалось: тогда отодвинутый файл
 * остаётся (под .gitignore, .claude/.qa-state.*.tmp) - удалить его значило бы снять чужую блокировку
 * (решение техлида Р-7 п.2).
 */
function claimStateLock(lock, removable) {
  const aside = asidePath(lock);
  try {
    retrySync(() => fs.renameSync(lock, aside));
  } catch (e) {
    return isGone(e) ? 'gone' : asError(e);
  }
  let ok = false;
  try {
    ok = Boolean(removable(aside));
  } catch (_) {
    ok = false; // не разобрать - не снимаем
  }
  if (ok) {
    unlinkRetry(aside);
    return 'removed';
  }
  try {
    fs.linkSync(aside, lock);
  } catch (e) {
    return new Error('блокировку ' + lock + ' не вернуть на место (' + (codeOf(e) || asError(e).message) + '): её место заняла другая, отодвинутая оставлена в ' + aside);
  }
  unlinkRetry(aside);
  return 'kept';
}

/**
 * Отказ взять блокировку за waitMs: протухшую снять не удалось (claimFail - ошибка последнего снятия; ревью
 * E0-12AE, круг 2, Н4; причина - в её тексте: отказ ФС или место заняла другая), иначе - по коду последней
 * ошибки e: EEXIST - занята другим писателем, иной код - отказ ФС (ревью E0-12AE, круг 3, CR3-7; решение Р-8).
 */
function lockRefusal(lock, e, waitMs, claimFail) {
  if (claimFail) {
    return new Error('блокировка ' + lock + ' протухла, но снять её за ' + waitMs + ' мс не удалось: ' + claimFail.message + ' - см. причину');
  }
  if (codeOf(e) === 'EEXIST') {
    let holder = '';
    try {
      holder = String(fs.readFileSync(lock, 'utf8')).split(/\r?\n/)[0].slice(0, 80);
    } catch (_) {
      holder = ''; // снята в этот миг
    }
    return new Error('блокировка ' + lock + ' занята дольше ' + waitMs + ' мс - её держит другой писатель .qa-state' + (holder ? ' (' + holder + ')' : ''));
  }
  return new Error(
    'блокировку ' + lock + ' не взять за ' + waitMs + ' мс: ' + (codeOf(e) || asError(e).message) +
      ' - это отказ файловой системы, а не другой писатель: проверь права на каталог состояния и антивирус',
  );
}

/**
 * Взять блокировку lock: { token, staleMs } - взята (токен записан в файл), { error } - нет: занята дольше
 * waitMs или сбой. Протухшая (старше staleMs) снимается через claimStateLock, только если отодвинутый файл
 * тоже протух; после снятия берётся заново сразу, без сверки с пределом ожидания (Б7), но не больше
 * STATE_LOCK_FREE_RETRIES раз за вызов.
 */
function takeStateLock(lock) {
  const waitMs = lockLimit(stateLockLimits.waitMs, STATE_LOCK_WAIT_MS);
  const staleMs = lockLimit(stateLockLimits.staleMs, STATE_LOCK_STALE_MS);
  const from = performance.now();
  const stale = (st) => Boolean(st && Date.now() - st.mtimeMs > staleMs);
  let claimFail = null;
  let freeRetries = 0;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (e) {
      const code = codeOf(e);
      if (!STATE_LOCK_RETRY_CODES.has(code)) return { error: asError(e) };
      let again = false;
      if (code === 'EEXIST') {
        claimFail = null;
        let st;
        try {
          st = retrySync(() => statIfPresent(lock));
        } catch (_) {
          st = undefined; // не прочитать - ждём как занятую
        }
        if (st === null) again = true; // снята между open и stat
        else if (stale(st)) {
          const r = claimStateLock(lock, (aside) => stale(retrySync(() => statIfPresent(aside))));
          again = r === 'removed' || r === 'gone';
          if (r instanceof Error) claimFail = r;
        }
      }
      if (again && freeRetries++ < STATE_LOCK_FREE_RETRIES) continue;
      if (performance.now() - from >= waitMs) return { error: lockRefusal(lock, e, waitMs, claimFail) };
      pauseSync(RENAME_PAUSE_MS);
      continue;
    }
    const token = lockToken();
    let failed = null;
    try {
      fs.writeSync(fd, token + ' ' + new Date().toISOString() + '\n');
    } catch (e) {
      failed = asError(e);
    }
    try {
      fs.closeSync(fd);
    } catch (_) {
      /* дескриптор закроет выход процесса; блокировку держит сам файл */
    }
    if (failed) {
      // без токена её снимет только протухание: файл создан этим вызовом мгновение назад - снимаем сразу
      unlinkRetry(lock);
      return { error: failed };
    }
    return { token, staleMs };
  }
}

/** Снять свою блокировку: только если в ней токен token (claimStateLock); чужую - вернуть на место. */
function dropStateLock(lock, token) {
  const r = claimStateLock(lock, (aside) => tokenAt(aside) === token);
  if (r === 'removed' || r === 'gone') return null;
  return r === 'kept' ? new Error('блокировка ' + lock + ' не своя - её сочли протухшей и взяли, оставлена владельцу') : r;
}

/**
 * Read-modify-write состояния под блокировкой .qa-state.lock - единственный путь записи для писателей
 * (docs/adr/0016-qa-state-writes.md). mutate(state) меняет объект, прочитанный под блокировкой, и возвращает
 * истину («изменилось»); writeState - только если изменилось. opts.changes(state) - предикат «изменится?» на
 * своей копии, прочитанной без блокировки: ложь - блокировка не берётся и файл не пишется (Stop-хук без
 * замечания не конкурирует за блокировку на каждом ходу; ревью E0-12AE, круг 1, Б10). Без предиката - одно
 * чтение, сразу под блокировкой: писатель, который пишет всегда (отметки, edits), не читает файл дважды
 * (круг 2, CR8). Побочное действие вне объекта (вывод) вызывающий делает после updateState (CR10).
 * Перед записью токен в блокировке сверяется со своим: блокировку увели как протухшую - запись отменена
 * (решение техлида Р-7 п.1). Медленное (git) вызывающий считает до вызова: под блокировкой - только файл.
 * Возвращает null - записано или менять нечего, или ошибку - не записано: блокировка занята дольше предела
 * или уведена, каталог состояния не создать, путь закрыт (refuseStatePath), чтение, mutate или запись
 * упали. Отказ снять свою блокировку итог не меняет (запись сделана, блокировка протухнет сама) - он одной
 * строкой в stderr (Р-7 п.6).
 */
function updateState(mutate, opts) {
  const changes = opts && opts.changes;
  let lock = null;
  let held = null;
  try {
    lock = stateLockPath();
    if (changes && !changes(readState())) return null;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    held = takeStateLock(lock);
    if (held.error) return held.error;
    const state = readState();
    if (!mutate(state)) return null;
    const now = tokenAt(lock);
    if (now !== held.token) {
      return new Error('токен в блокировке ' + lock + ' не свой (' + (now || 'пусто') + '): её увели как протухшую или место занял другой писатель, запись отменена');
    }
    return writeState(state);
  } catch (e) {
    return asError(e);
  } finally {
    if (held && held.token) {
      const left = dropStateLock(lock, held.token);
      if (left) {
        try {
          fs.writeSync(2, 'updateState: ' + left.message + '\n');
        } catch (_) {
          /* некуда писать - блокировка протухнет сама */
        }
      }
    }
  }
}

/*
 * Замечания answer-length о длине ответа: lengthNotes[sessionId] = { text, at } в объекте
 * состояния (решение техлида 03.10.2026). У каждой сессии своё замечание, соседние друг другу
 * его не стирают; карта держит не больше LENGTH_NOTES_CAP записей, лишние вытесняются
 * по старейшему at. Без sessionId операции ничего не делают; номер сессии хуки берут
 * через sessionIdOf. Функции меняют переданный объект и говорят, изменился ли он, -
 * читать и писать состояние вызывающему.
 */
const LENGTH_NOTES_CAP = 8;

function lengthNotesOf(s) {
  const m = s.lengthNotes;
  return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
}

/** Записать замечание своей сессии. true - объект изменился. */
function putLengthNote(s, sessionId, text, at) {
  if (!sessionId) return false;
  let changed = false;
  let notes = lengthNotesOf(s);
  if (!notes) {
    notes = {};
    s.lengthNotes = notes;
    changed = true;
  }
  const held = notes[sessionId];
  if (held && held.text === text) return changed;
  notes[sessionId] = { text, at };
  const keys = Object.keys(notes);
  if (keys.length > LENGTH_NOTES_CAP) {
    keys
      .sort((a, b) => (Number(notes[a] && notes[a].at) || 0) - (Number(notes[b] && notes[b].at) || 0))
      .slice(0, keys.length - LENGTH_NOTES_CAP)
      .forEach((k) => { delete notes[k]; });
  }
  return true;
}

/** Снять замечание своей сессии; чужие не трогает. true - объект изменился. */
function dropLengthNote(s, sessionId) {
  if (!sessionId) return false;
  const notes = lengthNotesOf(s);
  if (!notes || !Object.prototype.hasOwnProperty.call(notes, sessionId)) return false;
  delete notes[sessionId];
  return true;
}

/** Взять замечание своей сессии и снять его. { text: '' если нет, changed }. */
function takeLengthNote(s, sessionId) {
  if (!sessionId) return { text: '', changed: false };
  const notes = lengthNotesOf(s);
  const held = notes && notes[sessionId];
  const text = held && typeof held.text === 'string' ? held.text : '';
  return { text, changed: dropLengthNote(s, sessionId) };
}

/**
 * Счётчик правок edits + n (по умолчанию 1) под блокировкой; зовёт standards.js (PostToolUse) на каждую
 * правку файла. Возвращает новое значение или null - не записано (блокировка занята, состояние недоступно):
 * этот шаг счёта пропал, и отказ - null, а не 0 (ревью E0-12AE, круг 1, Б12). До E0-12AF отпечаток qaDiffHash
 * считается по именам файлов (diff-hash.js diffHash), правку уже проверенного файла ловит только edits; при
 * занятой блокировке шаг теряется, строка stderr PostToolUse оператору не видна - edits = 0 не доказательство,
 * edits > 0 - правки были (решение техлида Р-8 E0-12AE). Вызывающий называет null в stderr (standards.js; ревью
 * E0-12AE, круг 2, data Н2). Одно чтение - под блокировкой.
 */
function bumpEdits(n) {
  let edits = null;
  const failed = updateState((s) => {
    s.edits = (s.edits || 0) + (n || 1);
    edits = s.edits;
    return true;
  });
  return failed ? null : edits;
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
  sessionIdOf,
  deny,
  complain,
  pass,
  guard,
  sh,
  knownRepos,
  repoFor,
  rel,
  label,
  unlabel,
  commonRules,
  rulesFor,
  mergeStandards,
  targetFiles,
  matchGlob,
  matchAny,
  baseRef,
  changedFiles,
  allChanged,
  isTracked,
  addedLines,
  codeOf,
  asError,
  isGone,
  isNotFile,
  statIfPresent,
  isFilePresent,
  pauseSync,
  shortList,
  readState,
  writeState,
  updateState,
  stateLockPath,
  stateTmpPath,
  asidePath,
  hookMarkerPath,
  brokenHooks,
  stateLockLimits,
  STATE_LOCK_STALE_MS,
  STATE_LOCK_FREE_RETRIES,
  bumpEdits,
  statePath,
  refuseStatePath,
  foldPath,
  LENGTH_NOTES_CAP,
  putLengthNote,
  dropLengthNote,
  takeLengthNote,
  lastAssistantText,
  userTurnCount,
  proseLength,
};
