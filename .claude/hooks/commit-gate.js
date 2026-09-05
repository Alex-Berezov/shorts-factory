#!/usr/bin/env node
'use strict';
/**
 * commit-gate.js - PreToolUse на Bash. Замок перед коммитом и пушем.
 *
 * Человек больше не читает дифф перед коммитом, значит читать его обязана машина.
 * Хук смотрит на саму команду (tool_input.command) и вмешивается только тогда,
 * когда это git commit или git push - в любой форме: "git -C books commit",
 * "git -c core.quotepath=false commit", команда внутри && или |, кавычки.
 * Всё остальное проходит молча.
 *
 * Отказывает, если:
 *   - по текущему диффу не прогнан /qa (отметка от прошлой задачи не считается:
 *     сверяется отпечаток диффа из diff-hash.js);
 *   - гейты по текущему диффу не гонялись или упали;
 *   - в диффе есть то, чему в репозитории не место: .env*, node_modules, логи,
 *     tsbuildinfo, каталоги сборки (списки - commitGate.forbiddenPaths);
 *   - в ДОБАВЛЕННЫХ строках есть ослабление проверок (commitGate.weakenings)
 *     или понижение порога покрытия;
 *   - в команде есть --no-verify, --force, -f;
 *   - сообщение коммита не по conventional commits.
 *
 * Списки лежат в rules.common.json, разделы commitGate.* - чтобы правило можно было
 * поправить, не трогая код замка.
 *
 * Текст отказа называет причину и то, чем её устранить. Обход не предлагается никогда:
 * замок, который сам рассказывает, как его снять, не замок.
 */

const L = require('./lib.js');
const H = require('./diff-hash.js');
const { checkCross } = require('./diff-boundaries.js');

const MAX_SHOWN = 8;

const CONVENTIONAL_TYPES = [
  'feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert',
];

// ------------------------------------------------------------------ разбор команды

/** Команда режется на куски по &&, ||, ;, | и переводам строк - кавычки при этом целы. */
function segments(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    // экранированная кавычка; одинокий обратный слэш оставляем как есть - это путь Windows
    if (c === '\\' && (cmd[i + 1] === '"' || cmd[i + 1] === "'" || cmd[i + 1] === '\\')) {
      cur += c + cmd[i + 1];
      i++;
      continue;
    }
    if (c === '&' || c === '|' || c === ';' || c === '\n' || c === '\r') {
      out.push(cur);
      cur = '';
      if ((c === '&' || c === '|') && cmd[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Кусок команды в слова: кавычки снимаются, но границы слов по ним считаются. */
function tokenize(seg) {
  const out = [];
  let cur = '';
  let started = false;
  let quote = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (quote) {
      if (c === quote) {
        quote = null;
        continue;
      }
      cur += c;
      started = true;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    // экранированная кавычка; путь Windows "D:\newDev\books" обратные слэши сохраняет
    if (c === '\\' && (seg[i + 1] === '"' || seg[i + 1] === "'" || seg[i + 1] === '\\')) {
      cur += seg[i + 1];
      started = true;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/** Глобальные ключи git, у которых значение идёт отдельным словом. */
const GIT_OPTS_WITH_VALUE = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'];

/**
 * Вызовы git в команде: [{ sub, args }].
 * Пропускаются присваивания переменных окружения впереди команды и env.
 */
/**
 * Оболочки, которые уносят команду в свой аргумент: `bash -c "git commit ..."`.
 *
 * 🔴 Без раскрытия замок обходится одной обёрткой. Проверено прогоном:
 * `bash -c "git -C books commit -m плохое-сообщение"` возвращал пустой ответ, то есть
 * разрешение, - мимо `/qa`, гейтов, мусора, ослаблений и conventional commits разом.
 * Первым словом здесь стоит `bash`, а не `git`, и разбор просто не включался.
 */
const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ash', 'pwsh', 'powershell', 'cmd']);

/**
 * Ключ оболочки, за которым идёт команда. Учитываются склейки: `-lc`, `-ic`, `-xc`
 * - это те же `-c` с дополнительными буквами, и `bash -lc "git commit"` проходил мимо
 * разбора, знавшего только голое `-c`.
 */


/**
 * Слова, которые стоят перед настоящей командой и ничего о ней не говорят.
 * `sudo git commit`, `command git commit`, `nohup git push`, `time git commit` -
 * во всех первым словом оказывается не git, и разбор не включался.
 */
/**
 * Ключ оболочки, за которым идёт команда. Регуляркой, а не списком: `-lc`, `-ic`, `-xc` -
 * это те же `-c` с дополнительными буквами, и точное сравнение их не ловило.
 */
function isShellCmdFlag(tok) {
  const t = String(tok || '').toLowerCase();
  if (t === '/c' || t === '/k' || t === '-command' || t === '-encodedcommand') return true;
  return /^-[a-z]*c$/.test(t);
}

/**
 * Слова, стоящие перед настоящей командой и ничего о ней не говорящие.
 * `sudo git commit`, `command psql`, `nohup npx prisma`, `time yarn db:reset`.
 */
const TRANSPARENT_PREFIXES = new Set([
  'env', 'sudo', 'doas', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice',
  'stdbuf', 'setsid', 'xargs', 'then', 'do', 'else', 'elif',
]);

/** Ключи прозрачных префиксов, уносящие значение: `sudo -u me`, `nice -n 10`, `xargs -n1`. */
const PREFIX_FLAGS_WITH_VALUE = new Set(['-u', '--user', '-n', '--adjustment', '-g', '--group', '-P', '-I']);

/**
 * Пропустить всё, что стоит перед командой: присваивания переменных, прозрачные префиксы
 * вместе с их ключами, открывающие скобки группировки.
 *
 * 🔴 Прежний цикл рвался на первом же ключе: `sudo -u me git commit` давал бинарь `-u`,
 * и разбор не включался. Скобки и ключевые слова тоже не снимались - `( git commit )`
 * и `if true; then git commit; fi` проходили замок целиком.
 */
function skipPrefixes(toks) {
  let i = 0;
  for (;;) {
    if (i >= toks.length) return i;
    const t = toks[i];
    if (t === '(' || t === '{' || t === ')' || t === '}' || t === '!') { i++; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    if (TRANSPARENT_PREFIXES.has(t)) {
      i++;
      while (i < toks.length && toks[i].startsWith('-')) {
        const flag = toks[i].split('=')[0];
        const takesValue = PREFIX_FLAGS_WITH_VALUE.has(flag) && toks[i].indexOf('=') === -1;
        i += takesValue ? 2 : 1;
      }
      continue;
    }
    return i;
  }
}

/** Текст, унесённый в аргумент оболочки, либо null. */
function shellPayload(toks) {
  const i = skipPrefixes(toks);
  const bin = (toks[i] || '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');

  // `eval "git commit ..."` - оболочка та же самая, только текущая
  if (bin === 'eval') return i + 1 < toks.length ? toks.slice(i + 1).join(' ') : null;

  if (!SHELL_WRAPPERS.has(bin)) return null;
  for (let j = i + 1; j < toks.length; j++) {
    if (isShellCmdFlag(toks[j])) return j + 1 < toks.length ? toks[j + 1] : null;
  }
  return null;
}

/**
 * Подстановки команд: `$(git commit ...)` и обратные кавычки.
 *
 * 🔴 Разбор идёт по словам, а подстановка живёт внутри слова, поэтому `echo $(git commit -m x)`
 * до разбора не доходил вовсе. Команда при этом выполняется по-настоящему - оболочка её
 * запускает, чтобы подставить вывод.
 */
function substitutions(cmd) {
  const out = [];
  const dollar = /\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  let m;
  while ((m = dollar.exec(cmd))) out.push(m[1]);
  const back = /`([^`]+)`/g;
  while ((m = back.exec(cmd))) out.push(m[1]);
  return out;
}

function gitCalls(cmd, depth) {
  const calls = [];
  const level = depth || 0;

  // подстановки разбираются до всего остального: они живут внутри слова, и словесный
  // разбор их не видит, а оболочка выполняет по-настоящему
  if (level < 3) {
    for (const inner of substitutions(cmd)) {
      calls.push.apply(calls, gitCalls(inner, level + 1));
    }
  }

  for (const seg of segments(cmd)) {
    const toks = tokenize(seg);

    // команда внутри оболочки разбирается тем же кодом, но не глубже трёх обёрток:
    // дальше это уже не рабочая форма записи, а попытка запутать разбор
    const inner = level < 3 ? shellPayload(toks) : null;
    if (inner) {
      calls.push.apply(calls, gitCalls(inner, level + 1));
      continue;
    }

    let i = skipPrefixes(toks);
    if (i >= toks.length) continue;
    const bin = toks[i].split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
    if (bin !== 'git') continue;
    i++;
    // -C запоминается, а не просто пропускается: по нему видно, в КАКОЙ репозиторий коммитят.
    // Без этого проверка парных правок жаловалась бы на открытую пару в чужом репозитории
    // при коммите в третий - хотя до той пары работа ещё просто не дошла.
    let cwd = null;
    while (i < toks.length) {
      const t = toks[i];
      if (GIT_OPTS_WITH_VALUE.indexOf(t) !== -1) {
        if (t === '-C' && i + 1 < toks.length) cwd = toks[i + 1];
        i += 2;
        continue;
      }
      if (t.startsWith('-')) {
        i++;
        continue;
      }
      break;
    }
    if (i >= toks.length) continue;
    calls.push({ sub: toks[i], args: toks.slice(i + 1), cwd: cwd });
  }
  return calls;
}

/** Имя репозитория по `-C <путь>`. Путь не указан или чужой - null, и тогда сужения нет. */
function repoNameOf(call) {
  if (!call || !call.cwd) return null;
  const repo = L.repoFor(require('path').resolve(call.cwd));
  return repo ? repo.name : null;
}

/**
 * Сообщение коммита из аргументов. Возвращает:
 *   { kind: 'text', value }   - сообщение видно в команде, его можно проверить
 *   { kind: 'hidden' }        - сообщение придёт мимо команды: -F <файл>, -F - со stdin,
 *                               редактор, --amend без -m. Хук его не видит и молчит про формат;
 *                               остальные проверки при этом остаются в силе.
 */
function commitMessage(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-m' || a === '--message') {
      if (i + 1 < args.length) return { kind: 'text', value: args[i + 1] };
      continue;
    }
    if (a.startsWith('--message=')) return { kind: 'text', value: a.slice('--message='.length) };
    // склеенные короткие ключи: -am "текст", -m"текст"
    const glued = /^-([a-zA-Z]*)m(.*)$/.exec(a);
    if (glued && !a.startsWith('--')) {
      if (glued[2]) return { kind: 'text', value: glued[2] };
      if (i + 1 < args.length) return { kind: 'text', value: args[i + 1] };
      continue;
    }
  }
  // -F <файл> / --file=<файл>: сообщение на диске, путь запоминаем - его можно прочесть.
  // `-F -` означает stdin, и вот его действительно не видно.
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '-F' || a === '--file') && i + 1 < args.length && args[i + 1] !== '-') {
      return { kind: 'hidden', file: args[i + 1] };
    }
    if (a.startsWith('--file=')) {
      const v = a.slice('--file='.length);
      if (v && v !== '-') return { kind: 'hidden', file: v };
    }
  }

  return { kind: 'hidden' };
}

// ------------------------------------------------------------------ правила и дифф

function makeRe(pattern, flags) {
  if (typeof pattern !== 'string' || !pattern) return null;
  try {
    return new RegExp(pattern, typeof flags === 'string' ? flags : '');
  } catch (_) {
    return null;
  }
}

function hits(re, text) {
  if (!re) return false;
  re.lastIndex = 0;
  try {
    return re.test(String(text == null ? '' : text));
  } catch (_) {
    return false;
  }
}

/** Подходит ли путь под шаблон - и с именем репозитория, и без него. */
function matchesAny(globs, repo, relPath) {
  const withRepo = L.label(repo, relPath);
  return (globs || []).some((g) => L.matchGlob(g, relPath) || L.matchGlob(g, withRepo));
}

function firstMatch(globs, repo, relPath) {
  const withRepo = L.label(repo, relPath);
  return (globs || []).find((g) => L.matchGlob(g, relPath) || L.matchGlob(g, withRepo)) || null;
}

/** УДАЛЁННЫЕ строки файла относительно базы - нужны, чтобы увидеть понижение числа. */
function removedLines(repo, rules, relPath) {
  const d = L.sh(
    'git',
    ['diff', '--unified=0', '--no-color', L.baseRef(repo, rules), '--', relPath],
    repo.path,
  );
  if (!d.ok || !d.out) return [];
  return d.out
    .split('\n')
    .filter((l) => l.startsWith('-') && !l.startsWith('---'))
    .map((l) => l.slice(1));
}

const COVERAGE_KEYS = /['"]?(branches|functions|lines|statements)['"]?\s*:\s*(\d+(?:\.\d+)?)/gi;
const COVERAGE_VARS = /\b([A-Z_]*COVERAGE[A-Z_]*)\s*=\s*(\d+(?:\.\d+)?)/g;

/** Числа порогов покрытия из набора строк: имя порога -> список значений. */
function coverageNumbers(lines) {
  const map = new Map();
  const add = (key, num) => {
    const k = String(key).toLowerCase();
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(Number(num));
  };
  for (const text of lines) {
    let m;
    COVERAGE_KEYS.lastIndex = 0;
    while ((m = COVERAGE_KEYS.exec(text))) add(m[1], m[2]);
    COVERAGE_VARS.lastIndex = 0;
    while ((m = COVERAGE_VARS.exec(text))) add(m[1], m[2]);
  }
  return map;
}

// ------------------------------------------------------------------ проверки


/**
 * Похожее на настоящий секрет значение в добавленных строках шаблонного файла.
 *
 * Шаблон (`.env.example`, `.env.prod.template`) хранит имена ключей, а не их значения.
 * Значение в нём либо пустое, либо заведомо ненастоящее: `<описание>`, `changeme`,
 * `your-key-here`. Всё остальное длиной от двадцати знаков - это ключ, который кто-то
 * скопировал из рабочего окружения, и в публичном репозитории ему не место.
 *
 * Возвращает { line, why } или null.
 */
function secretsInAdded(group, relPath, cfg) {
  const minLen = Number(cfg.secretMinLength) || 20;
  const placeholder = /^(<.*>|\{\{.*\}\}|\$\{.*\}|your[-_].*|change[-_]?me|xxx+|\.\.\.|example|placeholder|todo|тут.*|секрет)$/i;
  for (const a of L.addedLines(group.repo, group.rules, relPath)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=\s*(.*)$/.exec(a.text);
    if (!m) continue;
    let value = m[2].trim().replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '').trim();
    if (!value || value.length < minLen) continue;
    if (placeholder.test(value)) continue;
    // строка подключения к localhost - законный пример
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && /(localhost|127\.0\.0\.1|::1)/.test(value)) continue;
    // выглядит как настоящий ключ: длинное значение без пробелов
    if (/\s/.test(value)) continue;
    return { line: a.line, why: m[1] + ', ' + value.length + ' знаков без пробелов' };
  }
  return null;
}

/** Мусор в диффе. */
function checkGarbage(groups, cfg, problems) {
  const globs = cfg.forbiddenPaths || [];
  if (!globs.length) return;
  for (const g of groups) {
    for (const f of g.files) {
      const hit = firstMatch(globs, g.repo, f);
      if (!hit) continue;

      // 🔴 Исключение узкое и поимённое, а не «всё, что уже отслеживается».
      //
      // ТЗ §6 требует отказа на `.env*` в диффе без оговорок, и это правильно. Но под
      // шаблон подпадают шаблонные файлы, которые репозиторий обязан хранить и править:
      // `check-env.mjs` прямо ТРЕБУЕТ документировать новый ключ в `.env.example`, то есть
      // замок и гейт противоречили друг другу и выиграть было нельзя.
      //
      // Прежняя оговорка «пропускать всё отслеживаемое» это чинила, но снимала проверку
      // с любого пути под шаблоном - в том числе с `cp books/.env books/.env.example`,
      // после которого боевые ключи уезжают в публичный репозиторий, а замок молчит.
      // Это ровно то ослабление ради гладкости цикла, которое запрещает §12.
      //
      // Поэтому исключение - список имён, и к нему добавлена проверка содержимого:
      // шаблон, в котором появилось похожее на настоящий секрет значение, отказывается
      // так же, как непрошеный `.env`.
      if (matchesAny(cfg.templateFiles || [], g.repo, f) && L.isTracked(g.repo, f)) {
        const leaked = secretsInAdded(g, f, cfg);
        if (!leaked) continue;
        problems.push({
          why: L.label(g.repo, f) + ':' + leaked.line + ' - в шаблоне появилось значение, ' +
            'похожее на настоящий секрет (' + leaked.why + ')',
          how: 'в шаблонных файлах значения пустые или заведомо ненастоящие: KEY= или ' +
            'KEY=<описание>. Если ключ попал сюда из рабочего .env - считай его утёкшим ' +
            'и меняй на боевой машине, а не только в файле',
        });
        continue;
      }
      problems.push({
        why: L.label(g.repo, f) + ' - такому файлу в коммите не место (шаблон ' + hit + ')',
        how: 'убери его из индекса и из рабочего дерева либо впиши в .gitignore, потом коммить заново',
      });
    }
  }
}

/** Ослабления проверок в добавленных строках. */
function checkWeakenings(groups, cfg, problems) {
  const rulesList = (cfg.weakenings || [])
    .map((w) => ({
      id: w.id || 'без номера',
      re: makeRe(w.pattern, w.flags),
      skipIf: makeRe(w.skipIf, w.flags),
      message: w.message || 'ослабление проверки',
    }))
    .filter((w) => w.re);
  const exempt = cfg.weakeningExempt || [];
  const coverageFiles = cfg.coverageFiles || [];

  for (const g of groups) {
    for (const f of g.files) {
      if (matchesAny(exempt, g.repo, f)) continue; // сама обвязка: иначе замок не даст закоммитить себя
      const added = L.addedLines(g.repo, g.rules, f);
      if (!added.length) continue;

      for (const w of rulesList) {
        for (const a of added) {
          if (!hits(w.re, a.text)) continue;
          if (w.skipIf && hits(w.skipIf, a.text)) continue;
          problems.push({
            why: L.label(g.repo, f) + ':' + a.line + '  [' + w.id + '] ' + w.message,
            how: 'верни проверку на место: правь код так, чтобы она проходила честно',
          });
          break; // одного примера на файл и правило достаточно
        }
      }

      if (!matchesAny(coverageFiles, g.repo, f)) continue;
      const was = coverageNumbers(removedLines(g.repo, g.rules, f));
      const now = coverageNumbers(added.map((a) => a.text));
      for (const [key, values] of now) {
        if (!was.has(key)) continue;
        const before = Math.max.apply(null, was.get(key));
        const after = Math.min.apply(null, values);
        if (after >= before) continue;
        problems.push({
          why: L.label(g.repo, f) + ' - порог покрытия ' + key + ' понижен с ' + before + ' до ' + after,
          how: 'верни прежнее число и допиши недостающие тесты: порог двигается только вверх',
        });
      }
    }
  }
}

/** Опасные ключи самой команды. */
function checkFlags(call, problems) {
  for (const a of call.args) {
    // 🔴 Короткие и склеенные формы. `-n` - штатное сокращение `--no-verify` у commit,
    // `git push -fu origin main` - тот же `--force`, слипшийся с `-u`. Проверка,
    // знающая только длинную форму, обходится одной буквой.
    const short = /^-([a-zA-Z]+)$/.exec(a);
    if (short && !a.startsWith('--')) {
      const letters = short[1];
      if (call.sub === 'commit' && letters.indexOf('n') !== -1) {
        problems.push({
          why: 'в команде есть -n - это короткая форма --no-verify, отключение локальных проверок',
          how: 'убери ключ и почини то, на что ругаются проверки',
        });
      }
      if (letters.indexOf('f') !== -1) {
        problems.push({
          why: 'в команде есть -' + letters + ' - в нём ключ -f, переписывание опубликованной истории',
          how: 'не переписывай историю базовой ветки: заведи новый коммит поверх, а разошедшуюся ветку сведи слиянием',
        });
      }
    }
    if (a === '--no-verify') {
      problems.push({
        why: 'в команде есть --no-verify - это отключение локальных проверок',
        how: 'убери ключ и почини то, на что ругаются проверки',
      });
    }
    if (a === '-f' || a === '--force' || a === '--force-with-lease' || /^--force-if-includes$/.test(a)) {
      problems.push({
        why: 'в команде есть ' + a + ' - это переписывание уже опубликованной истории',
        how: 'не переписывай историю базовой ветки: заведи новый коммит поверх, а разошедшуюся ветку сведи слиянием',
      });
    }
  }
}

/** Conventional commits. */
function checkMessage(call, types, problems, rawCommand) {
  let msg = commitMessage(call.args);

  // 🔴 `-F -` означает «сообщение придёт на stdin», и раньше проверка формата на этом
  // молча выключалась. Форма не экзотическая: ровно она прописана в `allow` самой обвязки
  // (`git -c core.quotepath=false commit -q -F -`), то есть требование ТЗ про conventional
  // commits не действовало ни в одном реальном коммите. Текст при этом лежит в той же
  // строке команды - в heredoc, - и разобрать его можно.
  if (msg.kind !== 'text' && rawCommand) {
    const here = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*\r?\n([\s\S]*?)\r?\n\1\b/.exec(rawCommand);
    if (here) msg = { kind: 'text', value: here[2] };
    else {
      const echoed = /(?:echo|printf)\s+(?:-e\s+)?(["'])([\s\S]*?)\1\s*\|\s*git\b/.exec(rawCommand);
      if (echoed) msg = { kind: 'text', value: echoed[2] };
    }
  }

  // `-F <файл>`: сообщение лежит на диске, и прочитать его хук может - значит обязан.
  // Отказывать здесь без попытки прочесть означало бы запретить многострочные сообщения
  // вовсе, а они и есть нормальная форма для заметного коммита.
  if (msg.kind !== 'text' && msg.file) {
    try {
      const text = require('fs').readFileSync(msg.file, 'utf8');
      if (text.trim()) msg = { kind: 'text', value: text };
    } catch (_) {
      /* не прочиталось - разберёмся ниже как с невидимым */
    }
  }

  if (msg.kind !== 'text') {
    // текст добыть не удалось - но и молчать нельзя: это единственная дыра, через которую
    // формат не проверяется вовсе
    problems.push({
      why: 'сообщение коммита приходит мимо команды (-F <файл> или редактор), проверить его формат нечем',
      how: 'передай сообщение через -m "тип(область): текст" либо heredoc в той же команде - ' +
        'тогда замок увидит формат и пропустит',
    });
    return;
  }
  const list = (types && types.length ? types : CONVENTIONAL_TYPES).join('|');
  const re = new RegExp('^(?:' + list + ')(?:\\([^)\\n]+\\))?!?: \\S');
  const first = String(msg.value).split(/\r?\n/)[0].trim();
  if (re.test(first)) return;
  problems.push({
    why: 'сообщение коммита не по conventional commits: "' + first.slice(0, 60) + '"',
    how: 'формат - тип(область): текст, где тип один из ' + (types && types.length ? types : CONVENTIONAL_TYPES).join(', ') +
      '; в тексте назови идентификатор задачи, например "feat(db): E0-04 connection factory and core migration"',
  });
}

// ------------------------------------------------------------------ запуск

function render(kind, problems) {
  const shown = problems.slice(0, MAX_SHOWN);
  const lines = [
    (kind === 'push' ? 'Пуш' : 'Коммит') + ' не пропущен. Причины:',
    '',
  ];
  for (const p of shown) {
    lines.push('- ' + p.why);
    lines.push('  чем устранить: ' + p.how);
  }
  const rest = problems.length - shown.length;
  if (rest > 0) lines.push('- и ещё ' + rest + ' того же рода');
  lines.push('');
  lines.push('Разберись с каждой строкой и повтори команду. Пока причина жива, ответ будет тот же.');
  return lines.join('\n');
}

/**
 * Первый коммит репозитория: у него нет HEAD, а значит нет ни базовой точки, ни диффа,
 * по которому могли бы пройти /qa и гейты. Требовать их здесь - требовать невозможного:
 * отметки считаются от отпечатка диффа, а отпечаток без базы не определён.
 *
 * 🔴 Послабление узкое и одноразовое по построению: условие «в репозитории нет ни одного
 * коммита» после первого коммита не повторится никогда. Остальные проверки (флаги, формат
 * сообщения, мусор в диффе, ослабления в добавленных строках) действуют и здесь.
 */
function isBootstrap(root) {
  return !L.sh('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], root).ok;
}

function main() {
  L.guard(async () => {
  const input = await L.readStdin();
  const cmd = input && input.tool_input && typeof input.tool_input.command === 'string'
    ? input.tool_input.command
    : '';
  if (!cmd) return;

  const calls = gitCalls(cmd).filter((c) => c.sub === 'commit' || c.sub === 'push');
  if (!calls.length) return; // не про нас

  const cfg = L.commonRules().commitGate || {};
  const problems = [];
  let kind = 'commit';

  // Сломанный Stop-хук жалуется ровно один раз за цепочку остановок (дальше его глушит
  // stop_hook_active, иначе петля), поэтому его падение доезжает сюда отметкой в состоянии.
  // Здесь петли нет: каждая команда разбирается заново.
  const broken = L.readState().brokenHooks;
  for (const name of Object.keys(broken || {})) {
    problems.push({
      why: 'проверка «' + name + '» упала на последней сдаче: ' + (broken[name].detail || 'без текста'),
      how: 'почини хук и добейся зелёной самопроверки: node ' +
        '.claude/hooks/harness-selftest.js - отметка снимется сама, ' +
        'как только хук отработает без исключения',
    });
  }

  for (const call of calls) {
    if (call.sub === 'push') kind = 'push';
    checkFlags(call, problems);
    if (call.sub === 'commit') checkMessage(call, cfg.commitTypes, problems, cmd);
  }

  // 🔴 Условие двойное, и вторая половина не лишняя.
  //
  // С 02.09.2026 обвязка стоит в repos.json наравне с остальными (решение арбитра,
  // decisions-log.md), поэтому её правки приходят в `groups` сами и проходят проверку
  // на мусор и на ослабление - прежде не проходили вовсе, и заход, внёсший в правила
  // два ослабления, замок миновал молча.
  //
  // Но `L.allChanged()` считает от HEAD, а `H.diffLabels()` - от origin/<база>. После
  // коммита всех затронутых репозиториев первый пуст, второй нет: заход не кончился,
  // впереди пуш. Проверки состояния (`/qa` и гейты) обязаны идти и тогда - они считаются
  // по отпечатку захода, а не по группам.
  const groups = L.allChanged();
  const stillInFlight = !groups.length && H.diffLabels().length > 0;
  if (groups.length || stillInFlight) {
    const hash = H.diffHash();
    const state = L.readState();

    const labels = H.diffLabels();
    const repoRoot = (L.knownRepos()[0] || {}).path;
    const bootstrap = Boolean(repoRoot) && isBootstrap(repoRoot);
    const qa = bootstrap ? null : H.qaProblem(state, hash, labels);
    if (qa) {
      problems.push({
        why: 'по текущему диффу не пройден /qa: ' + qa,
        how: 'прогони /qa целиком и разбери его находки, отметка встанет сама',
      });
    }

    const gates = bootstrap ? null : H.gatesProblem(state, hash, labels);
    if (gates) {
      problems.push({
        why: 'гейты по текущему диффу не подтверждены: ' + gates,
        how: 'прогони /gates по всем затронутым репозиториям и добейся зелёного - настоящего, а не пересказанного',
      });
    }

    checkGarbage(groups, cfg, problems);
    checkWeakenings(groups, cfg, problems);

    // 🔴 Парные правки через границу репозиториев проверяются и здесь, а не только
    // в diff-boundaries.js. Тот хук висит на Stop и обязан молчать при stop_hook_active,
    // иначе получится петля: замечание выдаётся один раз за цепочку остановок, и агенту
    // достаточно закончить ход второй раз, чтобы сдать работу с открытой парой. Коммит -
    // точка, где эта уловка не работает: каждая команда разбирается заново.
    //
    // Считается от origin/<база>, поэтому первый коммит пары своей половины не теряет,
    // а второй закрывает её и снимает замечание сам.
    //
    // 🔴 Только на коммите, не на пуше. Пуш ПЕРЕДВИГАЕТ origin/<база> того репозитория,
    // который отправили: его половина уходит из диффа, вторая остаётся одна, и встречное
    // правило отклоняет пуш второго репозитория - тот самый пуш, который пару и закрывает.
    // Проверять пару на пуше нечем и незачем: к этому моменту она уже проверена на обоих
    // коммитах, а пуш ничего нового в дифф не добавляет.
    //
    // 🔴 Повод сужается до репозитория, в который коммитят. Иначе коммит в books-app-docs
    // отклонялся бы из-за незакоммиченной правки dto в books: пара там действительно открыта,
    // но до неё работа ещё не дошла, а замок уже говорит «нельзя». Отказ, который нельзя
    // устранить в рамках текущего действия, - это не проверка, а тупик.
    // Закрытие по-прежнему ищется по всему диффу: вторая половина на то и в другом
    // репозитории. Не видно, куда коммитят (нет -C), - проверяем всё, как раньше.
    const only = repoNameOf(calls.find((c) => c.sub === 'commit'));
    const scoped = only ? labels.filter((f) => f.indexOf(only + '/') === 0) : labels;

    if (kind !== 'push') for (const p of checkCross(labels, null, null, scoped)) {
      problems.push({
        why: 'парная правка через границу репозиториев не закрыта:\n  ' +
          p.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join('\n  '),
        how: 'правь вторую сторону пары; считаешь замечание ложным - строка в unlock.txt ' +
          'с номером правила и решение техлида в docs/DECISIONS.md',
      });
    }
  }

  if (problems.length) L.deny(render(kind, problems));
  }, { failClosed: true });
}

module.exports = { isBootstrap, gitCalls, commitMessage };

if (require.main === module) main();
