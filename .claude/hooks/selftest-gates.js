'use strict';
/**
 * selftest-gates.js - пробы выбора гейтов rules.sf.json (E0-12U: раздел гейтов harness-selftest.js
 * по заботам). Не хук: модуль самопроверки. Выбор и пропуск по when у настоящего selectGates
 * (selects, gateProbe, checkGateSelection), пути note и их сверка с выборкой git, маски when и
 * пробы отказа на суженном when, соседи файлов выбора и файлы git вне выбора - и описание выбора
 * каждого гейта (compose, tracker, schema-drift, build, test, typecheck, test:int, harness-selftest)
 * в порядке строк прогона.
 *
 * registerGateProbes(ctx, deps) пишет строки через check из ctx в прежнем порядке. Пробы, которые
 * выбор гейта только называет, - в модулях своих забот, их передаёт harness-selftest.js в deps:
 * int - API createIntProbe (selftest-int.js), gateRun - gatesModule пробы запуска
 * (selftest-gates-run.js), treeGraph - граф turbo настоящего дерева (selftest-tree-graph.js), roots -
 * корни графа, корневые скрипты и гейты с when always (selftest-roots.js), intCases - int-проба
 * прогона (selftest-int-cases.js), cases - синтетические кейсы модулей графа (selftest-graph-cases.js).
 * Фабрики этих модулей (createTreeGraph, createIntRun, createRootProbes, registerGraphCases) зовёт
 * этот файл - в точках прогона, где стоят их строки: им нужны gateProbe, selects и снимок GRAPH_GATE
 * отсюда (второе место сборки, первое - раздел 2a harness-selftest.js). Отдаёт то, что сверяют пробы
 * в конце прогона.
 */

const fs = require('fs');
const path = require('path');

function registerGateProbes(ctx, deps) {
  const { G, L, LISTING_MAX_BUFFER, ROOT, ROUTE_FORMS, check, gitLive, outcome, put, readJson, refusalVerdict, releaseTemp, repoRules, run, snapshotGate, tempDir } = ctx;
  const { int, gateRun, treeGraph, roots, intCases, cases } = deps;
  const { gatesModule } = gateRun;
  const { intForbidden, INT_PROBE_STATIC, intProbeReads, relUnder } = int;
  const graph = treeGraph.createTreeGraph(ctx);
  const { graphVerdict, withTempRoot, trackedFiles, stubUnderGlob, manifestGapBlind, inputsGapBlind, checkTurboGraph } = graph;
  const intRun = intCases.createIntRun(ctx, int);
  const { intGuard, liveIntReads, intProbeStubBase, intCaseReads, INT_GRAPH_OPTS } = intRun;

  /**
   * Выбирает ли selectGates из самого gates.js (экспорт модуля, а не повтор функции, L-008:
   * правка обработки when там обязана краснеть здесь) гейт gate на одном изменённом файле file
   * при полном прогоне (без --only). Вызов selectGates в пробах выбора - только здесь: gateProbe и
   * пробы отказа на изменённом when зовут selects (проба --only в selftest-gates-run.js зовёт его со
   * списком only). Модуль - через gatesModule: gates.js не прошёл пробу require в selftest-gates-run.js -
   * исключение (красная строка).
   */
  function selects(gate, file) {
    const { selectGates } = gatesModule();
    if (typeof selectGates !== 'function') throw new Error('gates.js не экспортирует функцию selectGates');
    const picked = selectGates([gate], [file], null);
    return Boolean(picked && picked[0] && picked[0].run);
  }

  /**
   * Пробы выбора гейтов правил rules: gateProbe(id) - { gate, runs }, runs(file) - select(gate, file)
   * с мемо на гейт и файл: пробы графа и стабов спрашивают о тех же файлах много раз за прогон
   * (TECH_DEBT 21.10.2026 E0-12L круги 3 и 4, время прогона: `runs` без мемо); проба гейта - одна на
   * id. Нет гейта - исключение (красная строка check). select - источник ответа (боевой - selects);
   * мемо сверяет кейс на подменённом источнике со своим счётчиком, в рабочем коде счётчиков нет
   * (TECH_DEBT 23.10.2026 E0-12T C23).
   */
  function makeGateProbes(rules, select) {
    const probes = new Map();
    return (id) => {
      if (probes.has(id)) return probes.get(id);
      const gate = ((rules && rules.gates) || []).find((g) => g.id === id);
      if (!gate) throw new Error('гейта ' + id + ' нет в правилах');
      const seen = new Map();
      const res = {
        gate,
        runs: (file) => {
          if (!seen.has(file)) seen.set(file, select(gate, file));
          return seen.get(file);
        },
      };
      probes.set(id, res);
      return res;
    };
  }
  const gateProbe = makeGateProbes(repoRules, selects);
  // Мемо проб выбора (TECH_DEBT 23.10.2026 E0-12T C23): на подменённом источнике второй вопрос о
  // файле источник не спрашивает, проба гейта - одна на id
  check('gateProbe: мемо - второй вопрос о том же файле не спрашивает gates.js, проба гейта одна на id (подменённый источник со счётчиком)', () => {
    let calls = 0;
    const probeOf = makeGateProbes({ gates: [{ id: 'x' }] }, (gate, file) => {
      calls++;
      return file === 'a';
    });
    const p = probeOf('x');
    const got = [p.runs('a'), p.runs('a'), p.runs('b'), p.runs('b')];
    if (JSON.stringify(got) !== '[true,true,false,false]') return 'ответы ' + JSON.stringify(got);
    if (probeOf('x') !== p) return 'вторая проба того же гейта - новый объект, мемо потеряно';
    return calls === 2 || 'источник спрошен ' + calls + ' раз(а) на четырёх вопросах о двух файлах';
  });

  /** Пути файлов, названные в note гейта; шаблоны с * и каталоги (`scripts/lib/**`) - нет. */
  function notePaths(gate) {
    const note = String(gate.note || '');
    const named = note.match(/(?<![\w./*-])(?:test|scripts|apps|packages|infra|docs)\/[\w./-]*\.(?:ts|mjs|js|json|ya?ml|md)\b/g) || [];
    return [...new Set(named)];
  }

  /**
   * Гейты, чьи пути из note сверяются с диском (notePathsOnDisk): каждый гейт rules, в note которого
   * есть путь файла (notePaths). Выводом, а не списком: гейт, чей note начал называть файл, сверяется
   * сразу (E0-12N, docs/TECH_DEBT.md § E0-12N: прежний перечень пяти гейтов заменён этим выводом).
   */
  function noteCheckedGates(rules) {
    return ((rules && rules.gates) || []).filter((gate) => notePaths(gate).length > 0);
  }

  /**
   * Гейты, чьи пути из note (вне их when и cmd) обязаны выбирать сам harness-selftest (проба выбора
   * гейта harness-selftest ниже): переименование такого файла краснеет локально, а не только в CI.
   * Уже noteCheckedGates: пути из note test:int, build и самого harness-selftest сверяются с диском
   * на каждом прогоне, но их правка гейт не выбирает (E0-12N). Список из двух гейтов - решение Q12
   * техлида (docs/DECISIONS.md, 18.10.2026, E0-12F): пути, которые читает when/cmd гейта-владельца
   * note, selftest не выбирают, иначе selftest идёт на каждой задаче; подтверждено решением ОВ1
   * E0-12N (21.10.2026). Расширять список или when harness-selftest - только новым решением техлида.
   */
  const NOTE_SELECTING_GATES = ['compose', 'tracker'];

  /**
   * Причина отказа notePathsOnDisk: файла нет в выборке git - он удалён, переименован или
   * игнорируется (тогда он на этой машине на диске, а в CI его не будет).
   */
  const NOT_LISTED = 'нет в выборке git (удалён, переименован или игнорируется)';

  /**
   * Пути файлов, названные в note гейта (`test/x.test.ts`, `scripts/x.mjs`, ...), есть в дереве:
   * note - то, что читает человек о гейте, и опечатка в нём переживала бы selftest (L-021).
   * Дерево - выборка git (listedFiles: в индексе или новые и не игнорируемые), а не existsSync:
   * игнорируемый файл, который лежит только на этой машине, и сбой stat (EPERM) не сходят
   * за файл, которого в CI не будет. Шаблоны с * и каталоги (`scripts/lib/**`) не сверяются.
   * listed - выборка для пробы; по умолчанию - выборка настоящего дерева.
   */
  function notePathsOnDisk(gate, listed) {
    const files = notePaths(gate);
    if (!files.length) return 'в note гейта ' + gate.id + ' не найдено ни одного пути файла';
    const inTree = listed || listedFiles();
    const missing = files.filter((f) => !inTree.has(f));
    return missing.length ? 'в note гейта ' + gate.id + ' ' + NOT_LISTED + ': ' + missing.join(', ') : { note: files.length + ' путей' };
  }

  /** Отказы notePathsOnDisk по каждому гейту noteCheckedGates(rules); пусто - все пути на диске. */
  function notePathViolations(rules, listed) {
    return noteCheckedGates(rules).map((gate) => notePathsOnDisk(gate, listed)).filter((r) => typeof r === 'string');
  }

  /** Файлы настоящего дерева в выборке git (trackedFiles с новыми неигнорируемыми) - один раз за прогон. */
  let listedCache = null;
  function listedFiles() {
    if (!listedCache) listedCache = new Set(trackedFiles({ others: true }));
    return listedCache;
  }

  check('пути файлов в note каждого гейта rules.sf.json, где они есть, на диске', () => {
    const checked = noteCheckedGates(repoRules).map((gate) => gate.id);
    if (!checked.length) return 'ни в одном note гейта rules.sf.json нет пути файла - сверять нечего';
    const missing = notePathViolations(repoRules);
    return missing.length ? missing.join('; ') : { note: checked.join(', ') };
  });
  // Проба отказа (L-008): гейт, которого нет ни в одном списке, с путём в note, которого нет на
  // диске, - красный; без пути в note - не сверяется.
  check('пути note: гейт вне прежнего перечня с путём, которого нет на диске, - отказ', () => {
    const probe = { id: 'sf-selftest-note', note: 'читает scripts/sf-selftest-missing.mjs' };
    const quiet = { id: 'sf-selftest-quiet', note: 'без путей файлов' };
    const rules = { gates: [...((repoRules && repoRules.gates) || []), probe, quiet] };
    const ids = noteCheckedGates(rules).map((gate) => gate.id);
    if (ids.includes(quiet.id)) return 'гейт без пути в note попал в сверку';
    const got = notePathViolations(rules);
    const want = 'в note гейта sf-selftest-note нет в выборке git (удалён, переименован или игнорируется): scripts/sf-selftest-missing.mjs';
    return (got.length === 1 && got[0] === want) || 'ожидался один отказ «' + want + '», получено ' + JSON.stringify(got);
  });
  // Проба отказа (L-008): файл, который есть на диске, но не в выборке git (игнорируемый), - отказ.
  check('пути note: файл на диске, которого нет в выборке git, - отказ', () => {
    const real = 'scripts/check-no-search-list.mjs';
    if (!fs.existsSync(path.join(ROOT, real))) return 'нет ' + real + ' - пробе не на чем стоять';
    const probe = { id: 'sf-selftest-ignored', note: 'читает ' + real };
    const got = notePathViolations({ gates: [probe] }, new Set());
    const want = 'в note гейта sf-selftest-ignored нет в выборке git (удалён, переименован или игнорируется): ' + real;
    return (got.length === 1 && got[0] === want) || 'ожидался один отказ «' + want + '», получено ' + JSON.stringify(got);
  });

  /**
   * Общий каркас пробы гейта по glob (L-008): решение принимает настоящий selectGates,
   * своей копии разбора when нет. Выбор, пропуск и дополнительные проверки - отдельные
   * строки: отказ одной не скрывает состояние другой.
   *   spec.runWhat / spec.skipWhat - хвосты названий строк выбора и пропуска;
   *   spec.mustRun / spec.mustSkip - файлы, на которых гейт обязан выбираться / пропускаться;
   *   spec.extra - [{ name, fn({ gate, runs }, spec), graph, int }]: fn получает пробу гейта
   *     (gateProbe) и тот же spec вторым аргументом; результат fn - как у check; graph - fn читает
   *     граф turbo настоящего дерева (GRAPH_GATE) и без него не гоняется; int - ещё и test/imports.ts
   *     с дочерним vitest или require(esm) - та же граница Node (extraProbe по снимкам gateSnaps).
   * id - идентификатор гейта в правилах; spec - описание пробы выше; sink - приёмник строк (по
   * умолчанию check; кейс TDZ берёт свой).
   */
  function checkGateSelection(id, spec, sink = check) {
    sink('гейт ' + id + ': gates.js выбирает его на ' + spec.runWhat, () => {
      const { runs } = gateProbe(id);
      const missed = spec.mustRun.filter((f) => !runs(f));
      if (missed.length) return 'gates.js не выбирает его на ' + missed.join(', ');
      return { note: spec.mustRun.length + ' выбор' };
    });
    sink('гейт ' + id + ': gates.js пропускает его на ' + spec.skipWhat, () => {
      const { runs } = gateProbe(id);
      const stray = spec.mustSkip.filter((f) => runs(f));
      if (stray.length) return 'gates.js выбирает его на постороннем ' + stray.join(', ');
      return { note: spec.mustSkip.length + ' пропуск' };
    });
    // gates.js берёт изменённые файлы из git (L.changedFiles: diff и ls-files --exclude-standard):
    // файл из .gitignore туда не попадает никогда, и выбор на нём - обещание без покрытия (E0-12K, B1).
    sink('гейт ' + id + ': каждый файл выбора git показывает (не в .gitignore)', () =>
      checkIgnoreVerdict(gitLive(['check-ignore', '--', ...spec.mustRun], { cwd: ROOT }), spec.mustRun.length));
    // x.graph - проба графа turbo настоящего дерева: без графа она не гоняется (snapshotGate)
    for (const x of spec.extra || []) {
      const name = 'гейт ' + id + ': ' + x.name;
      const fn = () => x.fn(gateProbe(id), spec);
      sink(name, extraProbe(x, name, fn, gateSnaps));
    }
  }

  /**
   * Снимки прогона для extra-строк checkGateSelection: { graph, imports } (GRAPH_GATE и IMPORTS_GATE)
   * после graph.takeLive() и intRun.start ниже, до них - null. Объявлены здесь, до первого вызова
   * checkGateSelection (TECH_DEBT 23.10.2026 E0-12U круг 2: чтение GRAPH_GATE до его объявления - TDZ).
   */
  let gateSnaps = null;
  /**
   * Проба extra-строки x по снимкам s (E0-12AA; TECH_DEBT 23.10.2026 E0-12T F7): int - под guard графа
   * и test/imports.ts (как intGuard), graph - под guard графа, иначе fn как есть. Снимков нет (описание
   * гейта стоит до них, как compose, tracker, schema-drift) - строка пробы называет порядок, а не
   * ReferenceError.
   */
  function extraProbe(x, name, fn, s) {
    if (!x.int && !x.graph) return fn;
    if (!s) return () => 'проба ' + (x.int ? 'int' : 'графа') + ' в описании гейта до снимков графа turbo и test/imports.ts - перенеси описание гейта ниже graph.takeLive() (selftest-gates.js)';
    return x.int ? s.graph.guard(name, s.imports.guard(name, fn)) : s.graph.guard(name, fn);
  }

  // TDZ (TECH_DEBT 23.10.2026 E0-12U круг 2, E0-12T F4): описание гейта с graph: true и int: true до
  // снимков (там, где стоят compose, tracker, schema-drift) - строки проб с причиной, а не исключение
  check('checkGateSelection: проба graph и int в описании гейта до снимка графа (место compose, tracker, schema-drift) - строка с причиной, а не ReferenceError', () => {
    const rows = [];
    const extra = [{ name: 'g', graph: true, fn: () => true }, { name: 'i', int: true, fn: () => true }];
    try {
      checkGateSelection('compose', { runWhat: 'x', skipWhat: 'y', mustRun: [], mustSkip: [], extra }, (name, fn) => rows.push({ name, fn }));
    } catch (e) {
      return 'исключение вместо строк: ' + ((e && e.message) || String(e));
    }
    const got = rows.filter((r) => /: [gi]$/.test(r.name)).map((r) => outcome(r.name, r.fn));
    const why = (kind) => 'проба ' + kind + ' в описании гейта до снимков графа turbo и test/imports.ts - перенеси описание гейта ниже graph.takeLive() (selftest-gates.js)';
    const want = JSON.stringify([{ ok: false, name: 'гейт compose: g', note: why('графа') }, { ok: false, name: 'гейт compose: i', note: why('int') }]);
    return JSON.stringify(got) === want || 'ожидалось ' + want + ', получено ' + JSON.stringify(got);
  });
  // Диспетчер (TECH_DEBT 23.10.2026 E0-12T F7): на подменённых снимках с ошибкой проба int уходит в
  // перечень снимка test/imports.ts, проба graph - в перечень снимка графа; своей строки нет
  check('checkGateSelection: диспетчер - int под снимками графа и test/imports.ts, graph под снимком графа (снимок с ошибкой - проба в его перечне, своей строки нет)', () => {
    const ok = () => snapshotGate(() => ({}));
    const broken = () => snapshotGate(() => { throw new Error('boom'); });
    const cases = [
      ['int при ошибке test/imports.ts', { int: true }, { graph: ok(), imports: broken() }, 'imports'],
      ['int при ошибке графа', { int: true }, { graph: broken(), imports: ok() }, 'graph'],
      ['graph при ошибке графа', { graph: true }, { graph: broken(), imports: ok() }, 'graph'],
    ];
    const bad = [];
    for (const [label, x, s, owner] of cases) {
      const r = outcome(label, extraProbe(x, label, () => true, s));
      if (r !== null || s[owner].blocked.join() !== label) bad.push(label + ': строка ' + JSON.stringify(r) + ', перечень снимка ' + JSON.stringify(s[owner].blocked));
    }
    const live = outcome('с снимками', extraProbe({ int: true }, 'с снимками', () => true, { graph: ok(), imports: ok() }));
    if (!live || !live.ok) bad.push('со снятыми снимками: ' + JSON.stringify(live));
    return !bad.length || bad.join('; ');
  });

  /**
   * Вердикт пробы «каждый файл выбора git показывает» по результату `git check-ignore`
   * (spawnSync): результат - как у check. Отказ называется целиком: git не запустился -
   * его ошибка; упал - код (или сигнал по имени) и весь stderr.
   * r - результат run; count - число файлов выбора.
   */
  function checkIgnoreVerdict(r, count) {
    if (r.error) return 'git check-ignore не запустился: ' + r.error.message;
    if (r.status === 1) return { note: count + ' видны git' };
    if (r.status !== 0) {
      const ended = r.status === null ? 'сигнал ' + r.signal : 'код ' + r.status;
      return 'git check-ignore: ' + ended + ': ' + (String(r.stderr || '').trim() || 'stderr пуст');
    }
    const ignored = String(r.stdout || '').split(/\r?\n/).filter(Boolean);
    return 'в .gitignore, gates.js их не увидит: ' + ignored.join(', ');
  }

  // Ветка «убит сигналом» пробы git check-ignore на живом git не случается: прогоняется
  // здесь на готовом результате, сигнал называется по имени (E0-12K, D7).
  check('проба git check-ignore: git, убитый сигналом, назван по сигналу', () => {
    const got = checkIgnoreVerdict({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' }, 1);
    const want = 'git check-ignore: сигнал SIGKILL: stderr пуст';
    return got === want || 'ожидалось «' + want + '», получено ' + JSON.stringify(got);
  });

  /**
   * Маски верхнего уровня when вида `glob:{a,b/{c,d}}` - ['a', 'b/{c,d}']: запятые вложенных
   * скобок маску не делят. null - when не такого вида. Это только список масок верхнего уровня,
   * смысл самих масок разбирают gates.js и lib.js (E0-12K, B4).
   */
  function whenMasks(when) {
    const m = /^glob:\{([\s\S]*)\}$/.exec(String(when || '').trim());
    if (!m) return null;
    const masks = [];
    let depth = 0;
    let cur = '';
    for (const c of m[1]) {
      if (c === ',' && depth === 0) {
        masks.push(cur);
        cur = '';
        continue;
      }
      if (c === '{') depth++;
      if (c === '}') depth--;
      if (depth < 0) return null;
      cur += c;
    }
    if (depth !== 0) return null;
    masks.push(cur);
    return masks;
  }

  /**
   * extra-строка checkGateSelection, проба отказа: when без маски file не выбирает гейт на file,
   * и проба выбора на нём краснеет; control - файл выбора другой маской (сужение не сломало when).
   * Маска снимается из списка верхнего уровня (whenMasks) по точному равенству, а не подстрокой:
   * `scripts/lib/paths.mjs` не задевает маску `x-scripts/lib/paths.mjs`. Помощник общий для
   * compose и tracker (E0-12M).
   */
  function refusalExtra(file, control, name) {
    return {
      name,
      fn: ({ gate }, spec) => {
        if (!spec.mustRun.includes(file)) return 'mustRun гейта не держит ' + file + ' - проба выбора на нём не краснеет';
        const when = String(gate.when || '');
        const masks = whenMasks(when);
        if (!masks) return 'when гейта не вида glob:{…} - проба отказа не построена: ' + when;
        const own = masks.filter((x) => x === file).length;
        if (own !== 1) return 'в when гейта маска ' + file + ' не ровно одна (' + own + ') - проба отказа не построена: ' + when;
        const narrowed = { ...gate, when: 'glob:{' + masks.filter((x) => x !== file).join(',') + '}' };
        const runsNarrowed = (f) => selects(narrowed, f);
        if (!runsNarrowed(control)) return 'суженный when не выбирает гейт и на ' + control + ' - сужение сломало when, проба ничего не доказывает';
        if (runsNarrowed(file)) return 'суженный when всё ещё выбирает гейт на ' + file + ' - проба выбора не краснеет';
        return { note: 'отказ на ' + file };
      },
    };
  }

  // Список масок when - по структуре: вложенные скобки, точное равенство, не when вида glob:{…}.
  check('whenMasks: маски верхнего уровня when, вложенные скобки не делят', () => {
    const got = JSON.stringify([whenMasks('glob:{a/x.mjs,b/{c,d}.yml,x-a/x.mjs}'), whenMasks('glob:a/**'), whenMasks('glob:{a,{b}')]);
    const want = JSON.stringify([['a/x.mjs', 'b/{c,d}.yml', 'x-a/x.mjs'], null, null]);
    return got === want || 'ожидалось ' + want + ', получено ' + got;
  });

  /**
   * extra-строка checkGateSelection: каждый файл mustRun выбирается своей маской, а не более
   * широкой - ни один его сосед (то же имя с суффиксом, с префиксом, на каталог ниже) гейт не
   * выбирает (E0-12K, P2; общий помощник гейтов compose и tracker - E0-12M). exempt - маски
   * (`docs/*_TASKS.md`), которые when берёт по решению целиком: сосед под ними выбирает гейт законно.
   */
  function neighboursExtra(exempt) {
    return {
      name: 'каждый файл выбора выбирает его своей маской, соседи - нет' + (exempt.length ? ' (кроме масок целиком: ' + exempt.join(', ') + ')' : ''),
      fn: ({ runs }, spec) => {
        const neighbours = (f) => {
          const at = f.lastIndexOf('/') + 1;
          return [f + '.bak', f.slice(0, at) + 'x-' + f.slice(at), 'x/' + f];
        };
        const all = spec.mustRun.flatMap(neighbours).filter((f) => !exempt.some((g) => L.matchGlob(g, f)));
        const stray = all.filter((f) => !spec.mustRun.includes(f) && runs(f));
        if (stray.length) return 'when шире файлов, которые гейт читает: выбирает его на ' + stray.join(', ');
        return { note: all.length + ' соседей' };
      },
    };
  }

  /**
   * extra-строка checkGateSelection: ни один файл настоящего дерева, который видит git
   * (`git ls-files`), кроме mustRun, гейт не выбирает - when не шире файлов выбора пробы на
   * всём дереве, а не только на ручном mustSkip (E0-12M). Отказ - до 10 имён и их число.
   * exempt - маски каталогов, которые when берёт целиком (`packages/db/migrations/**`): файл
   * под ними выбирает гейт законно и в mustRun не перечисляется (E0-12S).
   */
  function trackedOutsideExtra(exempt = []) {
    return {
      name: 'ни один файл, который видит git, кроме файлов выбора' + (exempt.length ? ' и масок целиком (' + exempt.join(', ') + ')' : '') + ', его не выбирает',
      fn: ({ runs }, spec) => {
        const r = gitLive(['-c', 'core.quotepath=false', 'ls-files', '-z'], { cwd: ROOT, maxBuffer: LISTING_MAX_BUFFER });
        if (r.error) return 'git ls-files не запустился: ' + r.error.message;
        if (r.status !== 0) return 'git ls-files: ' + (r.status === null ? 'сигнал ' + r.signal : 'код ' + r.status) + ': ' + String(r.stderr || '').trim();
        const files = String(r.stdout || '').split('\0').filter(Boolean);
        if (!files.length) return 'git ls-files не вернул ни одного файла';
        const stray = files.filter((f) => !spec.mustRun.includes(f) && !exempt.some((g) => L.matchGlob(g, f)) && runs(f));
        if (stray.length) {
          return 'when шире файлов выбора: выбирает его на ' + stray.slice(0, 10).join(', ') +
            (stray.length > 10 ? ' и ещё ' + (stray.length - 10) : '') + ' (всего ' + stray.length + ')';
        }
        return { note: files.length + ' файлов git' };
      },
    };
  }

  /**
   * Граф импортов скрипта гейта (TECH_DEBT 21.10.2026 E0-12M круг 4, E3): от entry (путь от корня
   * root) - относительные пути после from, после import и в динамическом import с литералом (в том
   * числе export from и динамический import в JSDoc-типе); пакеты и `node:*` - концы. Разбор - регэксп
   * (решение техлида Р1 E0-12AA: AST - E0-12AD), fail-closed (L-028): динамический import с нелитералом и
   * путь, которого нет на диске, - исключение с модулем. Пробелы и перенос строки между скобкой и
   * литералом - тот же литерал (просмотр вперёд целиком, без отката \s*: скобка, пробел и кавычка - не
   * «нелитеральный», замечание ревью E0-12AA). Возвращает файлы графа от корня, по алфавиту.
   */
  const IMPORT_LITERAL = /\b(?:from|import)\s*\(?\s*(['"])([^'"]+)\1/g;
  const IMPORT_DYNAMIC = /\bimport\s*\((?!\s*['"])/g;
  function importGraph(entry, root = ROOT) {
    const seen = new Set();
    const queue = [entry];
    while (queue.length) {
      const file = queue.shift();
      if (seen.has(file)) continue;
      const abs = path.join(root, ...file.split('/'));
      if (!L.isFilePresent(abs)) throw new Error('граф импортов ' + entry + ': ' + file + ' нет на диске');
      seen.add(file);
      const text = fs.readFileSync(abs, 'utf8');
      for (const m of text.matchAll(IMPORT_DYNAMIC)) {
        throw new Error('граф импортов ' + entry + ': ' + file + ':' + text.slice(0, m.index).split('\n').length + ' - динамический import с нелитеральным аргументом, что грузит модуль, проба не знает');
      }
      for (const m of text.matchAll(IMPORT_LITERAL)) {
        const spec = m[2];
        if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
        const rel = path.posix.normalize(path.posix.dirname(file) + '/' + spec);
        if (rel.startsWith('../')) throw new Error('граф импортов ' + entry + ': ' + file + ' -> ' + spec + ' вне корня');
        queue.push(rel);
      }
    }
    return [...seen].sort();
  }
  /**
   * Вердикт графа импортов гейта gate со скриптом entry: каждый файл графа выбирает гейт (runs), каждый
   * scripts/lib/*.mjs вне графа - нет (автоматический mustSkip вместо ручного перечня), и файл
   * scripts/lib, которого нет (LIB_NEIGHBOR), - тоже нет: маска `scripts/lib/*` в when выбрала бы гейт на
   * любом будущем помощнике (прежние несуществующие соседи mustSkip, замечание ревью E0-12AA, L-027).
   * root и libFiles (файлы scripts/lib от корня) - подмена для кейса.
   */
  const LIB_NEIGHBOR = 'scripts/lib/sf-selftest-neighbor.mjs';
  function importGraphVerdict(runs, entry, root = ROOT, libFiles = null) {
    const graph = importGraph(entry, root);
    const lib = libFiles || fs.readdirSync(path.join(root, 'scripts', 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => 'scripts/lib/' + f);
    const missed = graph.filter((f) => !runs(f));
    const stray = lib.filter((f) => !graph.includes(f) && runs(f));
    const why = [];
    if (missed.length) why.push('when не выбирает гейт на файлах графа импортов ' + entry + ': ' + missed.join(', '));
    if (stray.length) why.push('when выбирает гейт на scripts/lib вне графа импортов ' + entry + ': ' + stray.join(', '));
    if (runs(LIB_NEIGHBOR)) why.push('when выбирает гейт на файле scripts/lib, которого нет (' + LIB_NEIGHBOR + ') - маска вместо файлов графа импортов ' + entry);
    return why.length ? why.join('; ') : { note: graph.length + ' файлов графа, ' + lib.filter((f) => !graph.includes(f)).length + ' scripts/lib вне графа' };
  }
  /** extra-строка checkGateSelection: граф импортов скрипта cmd гейта (importGraphVerdict). */
  function importGraphExtra(entry) {
    return {
      name: 'граф импортов ' + entry + ': каждый его файл выбирает гейт, scripts/lib/*.mjs вне графа - нет',
      fn: ({ runs }) => importGraphVerdict(runs, entry),
    };
  }
  // Кейсы графа импортов на временном дереве: файл графа вне when, лишний scripts/lib вне графа в
  // when, динамический import с нелитералом - отказ с именем; when ровно по графу - пропуск
  check('граф импортов скрипта гейта: файл графа вне when, scripts/lib вне графа в when, динамический import с нелитералом - отказ с именем; when по графу - пропуск', () => {
    const tmp = tempDir('imports');
    try {
      put(tmp, 'scripts/tasks.mjs', 'import { a } from "./lib/a.mjs";\nimport { join } from "node:path";\n');
      put(tmp, 'scripts/lib/a.mjs', 'export { b } from "./b.mjs";\n');
      put(tmp, 'scripts/lib/b.mjs', 'export const b = 1;\n');
      put(tmp, 'scripts/lib/c.mjs', 'export const c = 1;\n');
      const runsOf = (when) => (f) => selects({ id: 'sf-selftest-imports', cmd: 'x', when }, f);
      const lib = ['scripts/lib/a.mjs', 'scripts/lib/b.mjs', 'scripts/lib/c.mjs'];
      const verdict = (when) => importGraphVerdict(runsOf(when), 'scripts/tasks.mjs', tmp, lib);
      const got = [
        verdict('glob:{scripts/tasks.mjs,scripts/lib/a.mjs}'),
        verdict('glob:{scripts/tasks.mjs,scripts/lib/a.mjs,scripts/lib/b.mjs,scripts/lib/c.mjs}'),
        verdict('glob:{scripts/tasks.mjs,scripts/lib/a.mjs,scripts/lib/b.mjs}'),
      ];
      const want = [
        'when не выбирает гейт на файлах графа импортов scripts/tasks.mjs: scripts/lib/b.mjs',
        'when выбирает гейт на scripts/lib вне графа импортов scripts/tasks.mjs: scripts/lib/c.mjs',
        { note: '3 файлов графа, 1 scripts/lib вне графа' },
      ];
      if (JSON.stringify(got) !== JSON.stringify(want)) return 'ожидалось ' + JSON.stringify(want) + ', получено ' + JSON.stringify(got);
      const masked = verdict('glob:{scripts/tasks.mjs,scripts/lib/a.mjs,scripts/lib/b.mjs,scripts/lib/sf-*.mjs}');
      const maskWant = 'when выбирает гейт на файле scripts/lib, которого нет (' + LIB_NEIGHBOR + ') - маска вместо файлов графа импортов scripts/tasks.mjs';
      if (masked !== maskWant) return 'маска scripts/lib в when: ожидалось «' + maskWant + '», получено ' + JSON.stringify(masked);
      put(tmp, 'scripts/lib/b.mjs', 'const name = "./c.mjs";\nexport const b = await imp' + 'ort(name);\n');
      return refusalVerdict(() => importGraph('scripts/tasks.mjs', tmp), 'граф импортов scripts/tasks.mjs: scripts/lib/b.mjs:2 - динамический import с нелитеральным аргументом, что грузит модуль, проба не знает');
    } finally {
      releaseTemp(tmp);
    }
  });
  // Литерал после пробела или переноса строки за скобкой динамического import - ребро графа, а не
  // отказ «нелитеральный» (замечание ревью E0-12AA: \s* в IMPORT_DYNAMIC откатывался до нуля)
  check('граф импортов скрипта гейта: динамический import - пробел или перенос строки между скобкой и литералом - ребро графа, а не отказ «нелитеральный»', () => {
    const tmp = tempDir('imports-space');
    try {
      const imp = 'imp' + 'ort(';
      put(tmp, 'scripts/tasks.mjs', 'const a = await ' + imp + ' "./lib/a.mjs");\nconst b = await ' + imp + '\n  \'./lib/b.mjs\'\n);\n');
      put(tmp, 'scripts/lib/a.mjs', 'export const a = 1;\n');
      put(tmp, 'scripts/lib/b.mjs', 'export const b = 1;\n');
      let got;
      try {
        got = importGraph('scripts/tasks.mjs', tmp);
      } catch (e) {
        return 'отказ: ' + ((e && e.message) || String(e));
      }
      const want = ['scripts/lib/a.mjs', 'scripts/lib/b.mjs', 'scripts/tasks.mjs'];
      return JSON.stringify(got) === JSON.stringify(want) || 'граф ' + JSON.stringify(got) + ', ожидался ' + JSON.stringify(want);
    } finally {
      releaseTemp(tmp);
    }
  });

  // Гейт по glob, ошибка в шаблоне, в его разборе или в пути скрипта не краснеет,
  // а молча выключает гейт (E0-11).
  checkGateSelection('compose', {
    runWhat: 'файлах Compose',
    skipWhat: 'посторонних',
    mustRun: [
      // Граф стека: compose.yaml и два файла, которые он включает
      // (COMPOSE_SOURCES из scripts/compose-rules.mjs, правило 15). Правило 13
      // (`init: true` у migrate, E0-12J) на infra/docker-compose.app.yml держит
      // только гейт compose; container.test.ts файл читает, но `init: true`
      // не проверяет.
      'compose.yaml',
      'infra/docker-compose.yml',
      'infra/docker-compose.app.yml',
      // Четыре имени override, которые compose-go без -f подмешивает, в корне и
      // в infra/ (правило 14): гейт ищет каждое, и появление файла его запускает.
      'compose.override.yml',
      'compose.override.yaml',
      'docker-compose.override.yml',
      'docker-compose.override.yaml',
      'infra/compose.override.yml',
      'infra/compose.override.yaml',
      'infra/docker-compose.override.yml',
      'infra/docker-compose.override.yaml',
      // Прочие имена, которые Compose ищет без -f рядом с файлами графа
      // (правило 14, DEFAULT_FILES): infra/compose.yaml стал бы стеком
      // `cd infra && docker compose up`. infra/.env, который правило 14 тоже ищет,
      // здесь нет: он в .gitignore, и gates.js его изменения не видит
      // (E0-12K, B1).
      'compose.yml',
      'docker-compose.yml',
      'docker-compose.yaml',
      'infra/compose.yaml',
      'infra/compose.yml',
      'infra/docker-compose.yaml',
      'scripts/check-compose.mjs',
      'scripts/compose-rules.mjs',
      // Читатель графа и манифест, который закрепляет пин yaml, которым тот
      // разбирает файлы (E0-12K), и сам разбор YAML читателя (readYaml, E0-12N).
      'scripts/lib/compose-graph.mjs',
      'scripts/lib/yaml-doc.mjs',
      'package.json',
      // Гейт находит compose.yaml через корень из scripts/lib и читает через
      // scripts/lib/files.mjs (E0-12F) и scripts/lib/json.mjs.
      'scripts/lib/paths.mjs',
      'scripts/lib/files.mjs',
      'scripts/lib/json.mjs',
      '.dockerignore',
      'infra/docker/app.Dockerfile.dockerignore',
      // Правило 12 читает порты тестового стека из корневого .env.test
      // (E0-12C).
      '.env.test',
    ],
    // Манифесты приложений check-compose не читает: выбор на них обещал бы
    // проверку, которой нет (E0-11, круг 7-2).
    // when - ровно файлы, которые гейт читает (E0-12K): из scripts/lib только
    // files.mjs, json.mjs, paths.mjs, compose-graph.mjs и yaml-doc.mjs; только
    // корневой .env.test.
    mustSkip: [
      'apps/web/src/app/page.tsx',
      'apps/api/package.json',
      'apps/worker/package.json',
      'apps/web/package.json',
      'apps/api/src/package.json',
      'x.dockerignore',
      'docs/30_E0_TASKS.md',
      'README.md',
      'scripts/tasks.mjs',
      'xinfra/a.yml',
      'scripts/lib.mjs',
      'scripts/library/a.mjs',
      'apps/web/scripts/lib/a.mjs',
      'apps/api/.env.test',
      '.env.example',
      // Корневые скрипты, которые гейт не импортирует (E0-12C, Q16); scripts/lib вне графа импортов
      // check-compose.mjs - автоматически (importGraphExtra, E0-12AA)
      'scripts/probe-image.mjs',
      'scripts/check-no-search-list.mjs',
      // Не Compose-файл по имени или не под маской.
      'deploy/compose.yaml',
      'deploy/docker-compose.yml',
      'docker-compose.yml.bak',
      'apps/api/docker-compose.override.yml',
      // Вне графа и не читаются гейтом (E0-12K): файл вне графа не входит в стек,
      // а его включение - нарушение правила 15. Сам app.Dockerfile гейт не
      // читает - правило 11 ищет только .dockerignore рядом с ним.
      'infra/README.md',
      'infra/scripts/backup.sh',
      'infra/postgres/init/01-test-db.sql',
      'infra/docker/app.Dockerfile',
      'infra/docker-compose.yml.bak',
      'infra/deploy/extra.yaml',
      'infra/docker-compose.prod.yml',
      'docker-compose.prod.yaml',
      // Правило 11 читает .dockerignore только рядом с Dockerfile, который
      // называют сборки (test/compose-rules.test.ts держит when по сборкам).
      'infra/docker/other.Dockerfile.dockerignore',
    ],
    extra: [
      {
        name: 'его скрипт на месте',
        fn: ({ gate }) => {
          const m = /^node\s+(\S+)/.exec(String(gate.cmd || ''));
          if (!m) return 'cmd гейта compose не node <скрипт>: ' + gate.cmd;
          if (!fs.existsSync(path.join(ROOT, m[1]))) return 'скрипта ' + m[1] + ' нет на диске';
          return true;
        },
      },
      { name: 'пути файлов в его note на диске', fn: ({ gate }) => notePathsOnDisk(gate) },
      // Проба отказа (E0-12J, F15/G1; E0-12K): правило 13 (`init: true` у migrate) на
      // infra/docker-compose.app.yml держит только гейт; маски when берутся по одной, и файл
      // обязан оставаться в mustRun. app.Dockerfile в стек пробы не входит: гейт его не читает.
      refusalExtra('infra/docker-compose.app.yml', 'infra/docker-compose.yml', 'when без infra/docker-compose.app.yml не выбирает его на файле стека приложения (проба отказа)'),
      // Более широкая маска (infra/**, infra/docker/*.dockerignore, **/compose.yaml)
      // краснит пробу на первом же файле, который покрывает (E0-12K, P2).
      neighboursExtra([]),
      // Ручной mustSkip держит неотслеживаемые имена (compose.override.*, deploy/compose.yaml);
      // отслеживаемые сверяются все (E0-12M, TECH_DEBT 20.10.2026 E0-12K).
      trackedOutsideExtra(),
      importGraphExtra('scripts/check-compose.mjs'),
    ],
  });

  // Скрипт трекера берёт корень из scripts/lib/paths.mjs: правка любого из них
  // может сломать render --check так же, как правка tasks.json (E0-12F). when - ровно то,
  // что render --check читает (E0-12M, B11): tasks.json, 00_STATUS.md, doc каждой
  // задачи (сегодня docs/*_TASKS.md и docs/TECH_DEBT.md) и граф импортов scripts/tasks.mjs.
  // Журнал 90_WORKLOG.md render --check не читает: его дописывают done и add.
  checkGateSelection('tracker', {
    runWhat: 'трекере, документах задач и графе импортов его скрипта',
    skipWhat: 'посторонних',
    mustRun: [
      'docs/tasks/tasks.json',
      'docs/00_STATUS.md',
      'docs/30_E0_TASKS.md',
      'docs/43_E13_TASKS.md',
      'docs/TECH_DEBT.md',
      'scripts/tasks.mjs',
      'scripts/lib/paths.mjs',
      'scripts/lib/tracker-doc.mjs',
      'scripts/lib/files.mjs',
    ],
    mustSkip: [
      'scripts/check-compose.mjs',
      'scripts/lib.mjs',
      'apps/web/scripts/lib/a.mjs',
      // помощники scripts/lib, которые скрипт трекера не импортирует, - автоматически графом импортов
      // scripts/tasks.mjs (importGraphExtra, E0-12AA)
      // документы, которые render --check не читает: журнал, не doc ни одной задачи
      'docs/90_WORKLOG.md',
      'docs/60_HARNESS.md',
      'docs/DECISIONS.md',
      'docs/adr/README.md',
      'docs/tasks/other.json',
      'docsx/a.md',
      'apps/web/docs/a.md',
      'tasks/2026-10-18-E0-12F.md',
      'README.md',
    ],
    extra: [
      { name: 'пути файлов в его note на диске', fn: ({ gate }) => notePathsOnDisk(gate) },
      // Проба отказа: when без маски tracker-doc.mjs не выбирает гейт на этом файле (E0-12M).
      refusalExtra('scripts/lib/tracker-doc.mjs', 'scripts/tasks.mjs', 'when без scripts/lib/tracker-doc.mjs не выбирает его на этом файле (проба отказа)'),
      neighboursExtra(['docs/*_TASKS.md']),
      importGraphExtra('scripts/tasks.mjs'),
      // when - перечень документов задач на сегодня: doc новой задачи вне него краснеет здесь,
      // а не молчит до первого переименования этого документа (E0-12M, B11).
      {
        name: 'doc каждой задачи docs/tasks/tasks.json его выбирает',
        fn: ({ runs }) => {
          const docs = [...new Set(readJson(path.join(ROOT, 'docs', 'tasks', 'tasks.json')).map((t) => t.doc))];
          const missed = docs.filter((d) => !runs('docs/' + d));
          if (missed.length) return 'when не выбирает гейт на документе задачи: ' + missed.map((d) => 'docs/' + d).join(', ');
          return { note: docs.length + ' документов' };
        },
      },
      // Выбор на документе задачи обещает, что render --check его читает: на копии трекера с
      // удалённым документом задачи гейт красный и называет его, на полной копии - зелёный.
      {
        name: 'render --check краснеет на удалённом документе задачи и зелёный на полной копии',
        fn: () => {
          const tmp = tempDir('tracker');
          try {
            const tasks = readJson(path.join(ROOT, 'docs', 'tasks', 'tasks.json'));
            fs.mkdirSync(path.join(tmp, 'docs', 'tasks'), { recursive: true });
            fs.copyFileSync(path.join(ROOT, 'docs', 'tasks', 'tasks.json'), path.join(tmp, 'docs', 'tasks', 'tasks.json'));
            // doc из tasks.json не должен уводить запись и удаление за tmp (`..`, абсолютный путь)
            const outside = (d) => {
              if (typeof d !== 'string' || !d) return true;
              const rel = path.relative(path.join(tmp, 'docs'), path.resolve(tmp, 'docs', ...d.split('/')));
              return rel.startsWith('..') || path.isAbsolute(rel);
            };
            const bad = tasks.map((t) => t.doc).find(outside);
            if (bad !== undefined || tasks.some((t) => outside(t.doc))) return 'doc вне tmp: ' + JSON.stringify(bad);
            for (const d of new Set(tasks.map((t) => t.doc))) put(tmp, 'docs/' + d, '');
            const cli = (...args) => run(process.execPath, [path.join(ROOT, 'scripts', 'tasks.mjs'), '--root=' + tmp].concat(args), { cwd: ROOT });
            const said = (r) => 'код ' + r.status + ' ' + String(r.stderr || r.stdout || (r.error && r.error.message)).trim().slice(0, 160);
            const render = cli('render');
            if (render.status !== 0) return 'render на копии трекера: ' + said(render);
            const green = cli('render', '--check');
            if (green.status !== 0) return 'render --check на полной копии не зелёный: ' + said(green);
            // документ - doc задачи из самого tasks.json, а не имя из головы: смена doc не роняет пробу
            // по чужой причине; текст отказа - docProblem из scripts/lib/tracker-doc.mjs
            const doc = tasks[0] && tasks[0].doc;
            if (typeof doc !== 'string' || !doc) return 'у первой задачи tasks.json нет doc - удалять нечего';
            fs.rmSync(path.join(tmp, 'docs', ...doc.split('/')));
            const red = cli('render', '--check');
            const gone = new RegExp('docs/' + doc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' is not on disk');
            if (red.status === 0 || !gone.test(String(red.stderr))) return 'render --check без docs/' + doc + ': ' + said(red);
            return { note: 'красный: docs/' + doc };
          } finally {
            releaseTemp(tmp);
          }
        },
      },
    ],
  });

  // Гейт дрейфа схемы @sf/db (E0-12S): when - ровно то, что читает scripts/check-schema-drift.mjs
  // и запуск drizzle-kit через tsx (L-018). Схема и папка миграций - маски целиком: новая таблица
  // или миграция выбирает гейт без правки when.
  const SCHEMA_DRIFT_WHOLE = ['packages/db/src/schema/**', 'packages/db/migrations/**'];
  checkGateSelection('schema-drift', {
    runWhat: 'схеме, миграциях и том, что читает скрипт дрейфа',
    skipWhat: 'посторонних',
    mustRun: [
      'packages/db/src/schema/index.ts',
      'packages/db/src/schema/system.ts',
      'packages/db/migrations/0000_core.sql',
      'packages/db/migrations/meta/_journal.json',
      'packages/db/migrations/meta/0000_snapshot.json',
      'packages/db/drizzle.config.ts',
      // скрипты обхода db:generate/db:check и диапазон drizzle-kit
      'packages/db/package.json',
      // tsx читает их при запуске drizzle-kit: правка ломает запуск
      'packages/db/tsconfig.json',
      'tsconfig.base.json',
      // версии drizzle-kit и tsx
      'pnpm-lock.yaml',
      'scripts/check-schema-drift.mjs',
      'scripts/lib/files.mjs',
      'scripts/lib/json.mjs',
      'scripts/lib/paths.mjs',
    ],
    mustSkip: [
      'packages/db/src/migrate.ts',
      'packages/db/src/migration-lock.ts',
      'packages/db/src/repos/api-usage-log.ts',
      'packages/db/src/schema.ts',
      'packages/db/migrations.json',
      'packages/db/test/tsconfig.json',
      'packages/api/tsconfig.json',
      'tsconfig.json',
      'package.json',
      'scripts/check-compose.mjs',
      'scripts/lib/yaml-doc.mjs',
      'scripts/lib/manifest.mjs',
      'test/check-schema-drift.test.ts',
      'test/schema-drift-fixture.ts',
    ],
    extra: [
      {
        name: 'его скрипт на месте',
        fn: ({ gate }) => {
          const m = /^node\s+(\S+)$/.exec(String(gate.cmd || ''));
          if (!m) return 'cmd гейта schema-drift не node <скрипт>: ' + gate.cmd;
          if (!fs.existsSync(path.join(ROOT, m[1]))) return 'скрипта ' + m[1] + ' нет на диске';
          return true;
        },
      },
      { name: 'пути файлов в его note на диске', fn: ({ gate }) => notePathsOnDisk(gate) },
      // Проба отказа: when без packages/db/tsconfig.json (его читает tsx при запуске drizzle-kit)
      // не выбирает гейт на нём.
      refusalExtra('packages/db/tsconfig.json', 'packages/db/drizzle.config.ts', 'when без packages/db/tsconfig.json не выбирает его на этом файле (проба отказа)'),
      neighboursExtra(SCHEMA_DRIFT_WHOLE),
      trackedOutsideExtra(SCHEMA_DRIFT_WHOLE),
    ],
  });

  // Снимок графа настоящего дерева (selftest-tree-graph.js) и начало int-пробы прогона
  // (selftest-int-cases.js: снимок test/imports.ts, старт дочернего vitest) - здесь, до синтетических
  // кейсов графа: дочерний vitest идёт параллельно с ними.
  const GRAPH_GATE = graph.takeLive();
  const { IMPORTS_GATE, VITEST_GATE } = intRun.start(GRAPH_GATE);
  gateSnaps = { graph: GRAPH_GATE, imports: IMPORTS_GATE };
  const rootProbes = roots.createRootProbes(ctx, { gateProbe, selects, GRAPH_GATE });
  // Мемо корневого package.json (TECH_DEBT 23.10.2026 E0-12T C23): на подменённом источнике второй
  // вопрос не читает, ответ - тот же объект
  // Боевая сборка (замечание ревью E0-12AA T5): мемо не только у фабрики на подменённом источнике, но и
  // у собранных этим файлом gateProbe и rootPkg - второй вопрос отдаёт тот же объект, а не новое чтение
  check('gateProbe и rootPkg боевой сборки: второй вопрос - тот же объект (мемо на боевом источнике)', () => {
    const why = [];
    if (gateProbe('harness-selftest') !== gateProbe('harness-selftest')) why.push('gateProbe дал новую пробу гейта на втором вопросе');
    const a = rootProbes.rootPkg();
    if (rootProbes.rootPkg() !== a) why.push('rootPkg дал новый объект на втором вопросе - корневой package.json прочитан заново');
    return why.length ? why.join('; ') : true;
  });
  check('rootPkg: мемо - корневой package.json читается один раз, второй вопрос - тот же объект (подменённый источник со счётчиком)', () => {
    let reads = 0;
    const own = roots.createRootProbes(ctx, { gateProbe, selects, GRAPH_GATE }, { readRootPkg: () => { reads++; return { scripts: {} }; } });
    const a = own.rootPkg();
    const b = own.rootPkg();
    if (a !== b) return 'второй вопрос дал новый объект';
    return reads === 1 || 'источник прочитан ' + reads + ' раз(а) на двух вопросах';
  });
  const { rootsRefusal, rootScriptExtra, checkRootCommands, checkAlwaysScriptGate } = rootProbes;

  // Ветки отказа selftest-graph.js - на синтетическом dry и подменённом результате spawn, без
  // turbo: каждый кейс ждёт точный текст отказа, и ветка, заменённая на пропуск (`return []`,
  // `continue`), краснит свой кейс (E0-12L, L-020). Кейсы spawn идут на стаб-корне FIXTURE со
  // своими turbo и @turbo/<os>-<arch>, а не на node_modules репозитория: свежий клон без
  // pnpm install краснит одну строку «dry-JSON настоящего дерева», а не каждый кейс. Без модуля
  // графа кейсы не гоняются - их называет та же строка.
  if (G) {
    cases.registerGraphCases(ctx, {
      GRAPH_GATE, graphVerdict, inputsGapBlind, manifestGapBlind, relUnder, rootsRefusal, trackedFiles, withTempRoot,
    });
  } else {
    GRAPH_GATE.blocked.push('синтетические кейсы модуля графа');
  }

  // Сборка web (next build, ADR-0005) читает только apps/web и его пакеты; glob гейта
  // build сужен до них и корневых конфигов (E0-01A, docs/DECISIONS.md 11.10.2026).
  // Граф сборки берётся у turbo (E0-12L): каждый файл каждого узла графа выбирает гейт.
  checkGateSelection('build', {
    runWhat: 'apps/web, пакетах web и корневых конфигах',
    skipWhat: 'api, worker, db, integrations, вложенных конфигах и docs',
    mustRun: [
      'apps/web/src/app/page.tsx',
      'apps/web/package.json',
      'apps/web/next.config.ts',
      'apps/web/tsconfig.json',
      'packages/api-client/src/index.ts',
      'packages/config/src/server.ts',
      'packages/contracts/package.json',
      'packages/core/src/index.ts',
      'package.json',
      'pnpm-workspace.yaml',
      'pnpm-lock.yaml',
      'turbo.json',
      // turbo 2.10 читает и turbo.jsonc корня (TECH_DEBT 21.10.2026 E0-12L круг 4, `turbo.jsonc`)
      'turbo.jsonc',
      'tsconfig.base.json',
    ],
    mustSkip: [
      'apps/api/src/server.ts',
      'apps/api/package.json',
      'apps/worker/src/index.ts',
      'packages/db/src/index.ts',
      'packages/db/migrations/meta/_journal.json',
      'packages/integrations/youtube/src/index.ts',
      'apps/web-admin/x.ts',
      'scripts/tsconfig.json',
      'docs/package.json',
      'docs/30_E0_TASKS.md',
      'docs/tasks/tasks.json',
      'docs/apps/web/x.ts',
      'README.md',
      '.claude/hooks/rules.sf.json',
      'compose.yaml',
      'infra/docker-compose.yml',
      'scripts/tasks.mjs',
      'xapps/a.ts',
      'docs/turbo.jsonc',
    ],
    extra: [
      rootScriptExtra('build', 'turbo run build'),
      {
        name: 'каждый файл графа turbo run build (узлы от корней, globalCacheInputs) под glob',
        graph: true,
        fn: checkTurboGraph('build', { label: 'сборка читает' }),
      },
      {
        name: 'корни turbo run build - ровно @sf/web#build, команда - ровно next build (ADR-0005)',
        graph: true,
        fn: checkRootCommands('build', { roots: ['@sf/web#build'], command: 'next build' }),
      },
    ],
  });

  graph.checkStubDirCase(gateProbe, intRun);

  // Юнит-тесты читают и не-исходники (rules.sf.json, ci.yml, infra/docker/**), поэтому гейт test
  // always (E0-02A, L-014). cmd гейта - pnpm test, поэтому test:repo сверяется как скрипт,
  // точным равенством: echo или флаг «пропуск без тестов» vitest выключили бы корневые тесты (замок «копий нет»
  // пресета) при зелёном гейте.
  checkAlwaysScriptGate('test', 'turbo run test test:repo', 'test:repo', 'vitest run --config vitest.repo.config.mts');

  // Гейт typecheck гоняет и пакеты, и корневой проект (tsconfig.json корня: test/, vitest.preset.ts,
  // vitest.repo.config.mts - ADR-0011): выпавший typecheck:repo оставил бы корневые тесты без tsc.
  checkAlwaysScriptGate('typecheck', 'turbo run typecheck typecheck:repo', 'typecheck:repo', 'tsc -p tsconfig.json');

  // Int-тесты api, worker, db читают свои пакеты, их зависимости, @sf/config/vitest/setup,
  // корневой vitest.preset.ts (ADR-0011) и корневой .env.test; glob гейта test:int - по факту
  // чтения (docs/DECISIONS.md 11.10.2026, E0-02A, вопрос «Селектор гейта test:int: буква эпика,
  // glob по графу зависимостей или always»). Граф пакетов и корни - у turbo (E0-12L); конфиги,
  // setupFiles и globalSetup - у vitest (selftest-vitest.mjs), их импорты - test/imports.ts
  // (E0-12T): граф чтений int-наборов - intProbeReads.
  checkGateSelection('test:int', {
    runWhat: 'int-пакетах, их зависимостях, .env.test и корневых конфигах',
    skipWhat: 'web, api-client, вложенных конфигах и docs',
    mustRun: [
      'apps/api/src/index.ts',
      'apps/api/package.json',
      'apps/worker/src/index.ts',
      'apps/worker/package.json',
      'apps/worker/test/helpers.int.ts',
      'packages/db/src/index.ts',
      'packages/db/package.json',
      'packages/config/src/index.ts',
      'packages/config/package.json',
      'packages/core/src/index.ts',
      'packages/core/package.json',
      'packages/contracts/src/index.ts',
      'packages/contracts/package.json',
      'packages/integrations/youtube/src/index.ts',
      'packages/integrations/gemini/package.json',
      'packages/integrations/tts/src/index.ts',
      '.env.test',
      // Вложенные .env.test int-пакетов выбирает маска пакета: turbo хеширует файл как вход узла
      // (E0-12M, В1). Наборы их не читают: testEnvFilePath - только корень, это сверяет проба
      // «int-наборы не читают scripts/, infra/ и вложенный .env.test» ниже.
      'apps/api/.env.test',
      'packages/db/.env.test',
      'package.json',
      'pnpm-workspace.yaml',
      'pnpm-lock.yaml',
      'turbo.json',
      // turbo 2.10 читает и turbo.jsonc корня (TECH_DEBT 21.10.2026 E0-12L круг 4, `turbo.jsonc`)
      'turbo.jsonc',
      'tsconfig.base.json',
      'vitest.preset.ts',
    ],
    mustSkip: [
      'apps/web/src/app/page.tsx',
      'apps/web/package.json',
      'packages/api-client/src/index.ts',
      'docs/vitest.preset.ts',
      'vitest.repo.config.mts',
      'docs/30_E0_TASKS.md',
      'README.md',
      '.claude/hooks/rules.sf.json',
      // Стек Compose и его гейт int-наборы не читают (E0-12M, решение техлида Р4): адрес стека -
      // из корневого .env.test (testEnvFilePath - только корень), стек перезапускает человек;
      // что наборы их не читают, сверяет проба «int-наборы не читают …» ниже.
      'infra/docker-compose.yml',
      'infra/docker-compose.app.yml',
      'scripts/check-compose.mjs',
      'scripts/lib/paths.mjs',
      'scripts/tasks.mjs',
      'scripts/tsconfig.json',
      'apps/web/.env.test',
      'xapps/a.ts',
      'docs/apps/api/x.ts',
      'docs/turbo.jsonc',
    ],
    extra: [
      rootScriptExtra('test:int', 'turbo run test:int --concurrency=1'),
      {
        name: 'каждый файл графа turbo run test:int (узлы от корней, globalCacheInputs) и граф чтений int-наборов (конфиги --config, setupFiles, globalSetup, их импорты, фикстуры join(repoRoot, …)) под glob',
        int: true,
        fn: checkTurboGraph('test:int', INT_GRAPH_OPTS),
      },
      {
        // Р4 и В1 техлида E0-12M (TECH_DEBT 11.10.2026 E0-02A - `scripts/**`, `infra/**` и вложенные `.env.test`): граф чтений не заходит в
        // scripts/, infra/ и вложенный .env.test; имена из mustSkip под scripts/ и infra/ и
        // вложенные .env.test из mustRun в нём не встречаются; детектор - стаб с join(repoRoot,
        // "scripts/tasks.mjs") обязан покраснеть.
        name: 'int-наборы не читают scripts/, infra/ и вложенный .env.test (граф чтений; имена mustSkip и mustRun сверены; проба отказа - стаб с join(repoRoot, "scripts/tasks.mjs"))',
        int: true,
        fn: (_probe, spec) => {
          const reads = liveIntReads();
          const bad = intForbidden(reads);
          if (bad.length) return 'int-наборы читают то, на чём гейт не выбирается: ' + bad.join(', ');
          const files = new Set(reads.map((r) => r.file));
          const named = spec.mustSkip.filter((f) => /^(?:scripts|infra)\//.test(f)).concat(spec.mustRun.filter((f) => f !== '.env.test' && path.posix.basename(f) === '.env.test'));
          const read = named.filter((f) => files.has(f));
          if (read.length) return 'граф чтений int-наборов держит файлы из mustSkip/mustRun, которые наборы не читают: ' + read.join(', ');
          const planted = intForbidden(intCaseReads({ 'vitest/s.ts': 'import { join } from "node:path";\nconst repoRoot = "";\njoin(repoRoot, ".env.test");\njoin(repoRoot, "scripts/tasks.mjs");\n' }));
          const want = 'scripts/tasks.mjs (join(repoRoot, …) в ' + G.STUB_DIR + '/vitest/s.ts)';
          if (planted.join() !== want) return 'проба не замечает чтение scripts/ на стабе: ожидалось «' + want + '», получено ' + JSON.stringify(planted);
          return { note: reads.length + ' чтений, сверено имён ' + named.length };
        },
      },
      {
        // состав корней зафиксирован перечнем: пропавший scripts['test:int'] у api, worker или db
        // сузил бы граф и glob молча; новый int-пакет дописывается сюда вместе с glob гейта
        name: 'корни turbo run test:int - ровно api, db, worker, команда каждого - ровно vitest run --config vitest.int.config.ts',
        graph: true,
        fn: checkRootCommands('test:int', {
          roots: ['@sf/api#test:int', '@sf/db#test:int', '@sf/worker#test:int'],
          command: 'vitest run --config vitest.int.config.ts',
        }),
      },
    ],
  });

  intRun.registerCases();

  // Пробы графа build и test:int читают не только .claude/**, но и файлы проекта: то, из чего
  // turbo строит граф (корневые package.json, pnpm-workspace.yaml, turbo.json и turbo.jsonc;
  // package.json, turbo.json и turbo.jsonc каждого пакета и нового пакета по каждому шаблону
  // pnpm-workspace.yaml - graphSources), и входы пробы test:int (INT_PROBE_INPUT_KINDS и
  // INT_PROBE_STATIC: конфиги, setupFiles, globalSetup, модули с join(repoRoot, …), фикстуры,
  // vitest.preset.ts, test/imports.ts). Гейт самопроверки обязан выбираться на каждом из них, иначе
  // устаревший glob build или test:int уйдёт молча (docs/DECISIONS.md, 11.10.2026, E0-02A; E0-12L,
  // 21.10.2026; Р1 техлида E0-12T). Транзитивные модули обхода int и входы задач turbo (исходники
  // пакетов) самопроверку не выбирают: их сверяют с glob test:int и build сами пробы этих гейтов;
  // новый join(repoRoot, …) в глубине модуля ловит прогон selftest в CI. next.config.* ни одна
  // проба не читает (граф сборки - у turbo), на нём самопроверка не выбирается. Боевые формы роута
  // (ROUTE_FORMS) читают пробы S14 и пропуска standards в модуле роута - их сверка здесь же (E0-12D).
  /**
   * Близнец workspaceGlobs (Р4 техлида E0-12T) - под intGuard (int): require(esm) manifest.mjs -
   * та же граница Node, что у require test/imports.ts (IMPORTS_GATE), а не граф turbo (замечание
   * ревью E6 E0-12T: под одним GRAPH_GATE на Node ниже границы - лишняя красная ERR_REQUIRE_ESM).
   */
  const WORKSPACE_TWIN_PROBE = {
    // Р4 техлида E0-12T: шаблоны workspace пробы (workspacePatterns, пакет yaml) - близнец
    // workspaceGlobs из scripts/lib/manifest.mjs (ручной разбор): на настоящем
    // pnpm-workspace.yaml они равны, текст без packages: оба отвергают. На flow-списке
    // (`packages: [...]`) расхождение известно: workspaceGlobs бросает, workspacePatterns отдаёт
    // список (TECH_DEBT 23.10.2026 E0-12T «workspaceGlobs - ручной разбор YAML»); кейс фиксирует
    // его, а не красит; изменилось - строка красная с просьбой снять строку долга.
    name: 'шаблоны workspace пробы (workspacePatterns, yaml) - как workspaceGlobs из scripts/lib/manifest.mjs: равны на pnpm-workspace.yaml, оба отвергают текст без packages:, расхождение на flow-списке - известное',
    int: true,
    fn: () => {
      const { workspaceGlobs } = require(path.join(ROOT, 'scripts', 'lib', 'manifest.mjs'));
      const text = fs.readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
      const outcome = (fn, t) => {
        try {
          return JSON.stringify(fn(t));
        } catch (_) {
          return 'отказ';
        }
      };
      const both = (t) => [outcome(workspaceGlobs, t), outcome(G.workspacePatterns, t)];
      const [real1, real2] = both(text);
      if (real1 !== real2) return 'pnpm-workspace.yaml: workspaceGlobs ' + real1 + ', workspacePatterns ' + real2;
      const none = both('onlyBuiltDependencies:\n  - esbuild\n');
      if (none.join() !== 'отказ,отказ') return 'текст без packages: - workspaceGlobs ' + none[0] + ', workspacePatterns ' + none[1] + ' (ожидался отказ обоих)';
      const flow = both('packages: ["apps/*"]\n');
      if (flow.join() !== 'отказ,["apps/*"]') return 'flow-список: известное расхождение изменилось (workspaceGlobs ' + flow[0] + ', workspacePatterns ' + flow[1] + ') - сверь и сними строку TECH_DEBT «workspaceGlobs - ручной разбор YAML»';
      return { note: real1 };
    },
  };
  check('гейт harness-selftest: близнец workspaceGlobs (require(esm) manifest.mjs) - под intGuard, как test/imports.ts', () =>
    WORKSPACE_TWIN_PROBE.int === true || 'близнец не int - на Node ниже границы require(esm) он красный вместо SKIPPED');
  checkGateSelection('harness-selftest', {
    runWhat: '.claude/**, файлах, из которых turbo строит граф, входах пробы test:int и путях из note вне when',
    skipWhat: 'исходниках, lockfile, next.config.*, .env, docs и путях из when и cmd гейтов-владельцев note',
    mustRun: [
      '.claude/hooks/gates.js',
      '.claude/hooks/rules.sf.json',
      '.claude/hooks/selftest-graph.js',
      '.claude/hooks/selftest-vitest.mjs',
      '.claude/hooks/selftest-temp.js',
      '.claude/agents/worker.md',
      'package.json',
      'apps/web/package.json',
      'apps/api/package.json',
      'packages/core/package.json',
      'packages/integrations/youtube/package.json',
      'pnpm-workspace.yaml',
      'turbo.json',
      'turbo.jsonc',
      'packages/db/turbo.json',
      'packages/db/turbo.jsonc',
      'apps/api/turbo.json',
      'apps/web/turbo.json',
      // новый пакет по шаблону workspace (graphSources): без модуля графа имени нет, и строка
      // модуля уже красная
      ...(G ? ['apps/' + G.NEW_SIBLING + '/package.json', 'packages/integrations/' + G.NEW_SIBLING + '/turbo.json', 'apps/' + G.NEW_SIBLING + '/turbo.jsonc'] : []),
      'apps/api/vitest.int.config.ts',
      'apps/worker/vitest.int.config.ts',
      'packages/db/vitest.int.config.ts',
      'packages/config/src/paths.ts',
      'packages/config/vitest/setup.ts',
      'packages/db/test-support/entry-check/postgres.ts',
      'packages/db/test-support/entry-check/migrated-stack.ts',
      'vitest.preset.ts',
      'test/imports.ts',
      '.env.test',
      'test/container.test.ts',
    ],
    mustSkip: [
      'apps/web/next.config.ts',
      'apps/web/next.config.mjs',
      'packages/core/next.config.js',
      'docs/00_STATUS.md',
      'scripts/tasks.mjs',
      'scripts/compose-rules.mjs',
      'scripts/lib/paths.mjs',
      'scripts/lib/files.mjs',
      // проба-близнец workspacePatterns грузит его (Р4 техлида E0-12T), как files.mjs - близнец trackedFiles
      'scripts/lib/manifest.mjs',
      'apps/api/.env.test',
      // join(repoRoot, ".env") - не чтение (JOINED_NOT_READ, Р2 техлида E0-12T)
      '.env',
      'apps/api/vitest.config.ts',
      // транзитивные модули обхода int - под glob test:int, не входы пробы (Р1 техлида E0-12T)
      'packages/config/src/index.ts',
      'packages/config/src/env-file.ts',
      'packages/db/src/index.ts',
      'packages/db/test-support/fixture.ts',
      'test/imports.test.ts',
      'xapps/api/vitest.int.config.ts',
      'docs/apps/api/vitest.int.config.ts',
      'apps/web/src/app/page.tsx',
      'packages/core/src/index.ts',
      'pnpm-lock.yaml',
      'apps/api/src/server.ts',
      'apps/api/src/routes/index.ts',
      'apps/api/src/routes/README.md',
      'docs/30_E0_TASKS.md',
      'README.md',
      'scripts/check-no-search-list.mjs',
      'test/turbo-inputs.test.ts',
      'xapps/web/package.json',
      'docs/apps/web/package.json',
      'docs/turbo.json',
      'docs/turbo.jsonc',
      'xapps/api/turbo.json',
      'docs/apps/api/turbo.json',
    ],
    extra: [
      {
        // notePathsOnDisk сверяет эти пути с диском: переименование такого файла должно
        // выбирать самопроверку локально, а не краснеть только в CI (E0-12F). Путь из when
        // или cmd гейта-владельца note самопроверку не выбирает (решение техлида к кругу 3).
        name: 'его выбирает каждый путь из note гейтов ' + NOTE_SELECTING_GATES.join(' и ') + ' вне их when и cmd',
        fn: ({ runs }) => {
          const named = NOTE_SELECTING_GATES.flatMap((id) => {
            const owner = gateProbe(id);
            return notePaths(owner.gate).filter((f) => !owner.runs(f) && !String(owner.gate.cmd || '').includes(f));
          });
          if (!named.length) return 'в note гейтов ' + NOTE_SELECTING_GATES.join(' и ') + ' нет ни одного пути вне их when и cmd';
          const stray = named.filter((f) => !runs(f));
          if (stray.length) return 'пути из note вне glob harness-selftest: ' + stray.join(', ');
          return { note: named.length + ' путей' };
        },
      },
      {
        name: 'его выбирает каждая боевая форма роута, которую читают пробы S14 и пропуска standards',
        fn: ({ runs }) => {
          const stray = ROUTE_FORMS.filter((f) => !runs(f));
          if (stray.length) return 'пробы S14 и пропуска standards читают вне glob harness-selftest: ' + stray.join(', ');
          return { note: ROUTE_FORMS.length + ' файла' };
        },
      },
      {
        // Файл графа вне glob (пакет по шаблону tools/* в pnpm-workspace.yaml, turbo.json пакета)
        // меняет граф turbo, и без этой сверки его правка самопроверку не запускала бы (E0-12L;
        // TECH_DEBT, строки 11.10.2026 E0-01A «when harness-selftest знает только apps/**,
        // packages/**» и 11.10.2026 E0-02A «workspacePackages: шаблоны вне apps/, packages/»).
        // Новый пакет по каждому шаблону workspace (graphSources) - и по шаблону без единого
        // пакета - требует glob на шаблон каталога, а не на перечень сегодняшних пакетов.
        // Детектор: стаб-пакет и стаб-шаблон G.STUB_PATTERN дают свои G.STUB_SOURCES.
        name: 'его выбирает каждый файл, из которого turbo строит граф (корневые package.json, pnpm-workspace.yaml, turbo.json, turbo.jsonc; package.json, turbo.json и turbo.jsonc каждого пакета dry и нового пакета по каждому шаблону workspace)',
        graph: true,
        fn: ({ gate, runs }) => {
          const { dry, patterns } = GRAPH_GATE.snap;
          const sources = G.graphSources(dry, patterns);
          const bad = G.outsideGlob(runs, sources);
          if (bad.length) return G.refusal('граф turbo читает', gate.id, bad);
          const under = stubUnderGlob(runs, gate.id);
          if (under) return under;
          const stub = G.outsideGlob(runs, G.graphSources(G.stubNode(dry, 'build'), patterns.concat(G.STUB_PATTERN)));
          const blind = G.STUB_SOURCES.filter((f) => !stub.some((b) => b.startsWith(f + ' ')));
          if (blind.length) return 'проба не замечает ' + blind.join(', ') + ' вне glob ' + gate.id + ' на стабе';
          return { note: sources.length + ' файлов' };
        },
      },
      {
        // Р1 техлида E0-12T: входы пробы test:int (виды INT_PROBE_INPUT_KINDS и INT_PROBE_STATIC)
        // выбирают самопроверку; транзитивные модули обхода обязаны быть под glob test:int (иначе
        // их правка не выбирает ни тот гейт, ни этот). Детектор - стаб int-пробы: его входы вне glob.
        name: 'его выбирает каждый вход пробы test:int (конфиги --config, setupFiles, globalSetup, модули с join(repoRoot, …), фикстуры, манифесты exports, vitest.preset.ts, test/imports.ts); транзитивные модули обхода - под glob test:int',
        int: true,
        fn: ({ gate, runs }) => {
          const reads = liveIntReads();
          const inputs = reads.filter((r) => r.input).concat(INT_PROBE_STATIC.map((file) => ({ file, why: 'вход пробы test:int' })));
          const bad = G.outsideGlob(runs, inputs);
          if (bad.length) return G.refusal('проба test:int читает', gate.id, bad);
          const intRuns = gateProbe('test:int').runs;
          const deep = G.outsideGlob(intRuns, reads.filter((r) => !r.input));
          if (deep.length) return 'транзитивные модули обхода int-наборов вне glob test:int: ' + deep.join(', ') + ' - расширь glob test:int';
          const base = intProbeStubBase();
          const under = stubUnderGlob(runs, gate.id, base.files);
          if (under) return under;
          const stubInputs = intProbeReads([base.entry], GRAPH_GATE.snap.ws, base.src, IMPORTS_GATE.snap).filter((r) => r.input);
          if (!G.outsideGlob(runs, stubInputs).some((b) => b.startsWith(base.expect + ' '))) return 'проба не замечает вход ' + base.expect + ' вне glob ' + gate.id + ' на стабе';
          return { note: inputs.length + ' входов, ' + (reads.length - reads.filter((r) => r.input).length) + ' транзитивных модулей' };
        },
      },
      WORKSPACE_TWIN_PROBE,
      {
        // Р5 техлида E0-12T (TECH_DEBT 21.10.2026 E0-12L круг 4, peer-only workspace-зависимость): workspace:-пакет только в peerDependencies turbo
        // не упорядочивает - ребра нет, а сверка с манифестами (DEP_FIELDS) его не видит.
        name: 'ни у одного пакета dry workspace:-зависимости только в peerDependencies (без дубля в dependencies/devDependencies/optionalDependencies)',
        graph: true,
        fn: () => {
          const ws = GRAPH_GATE.snap.ws;
          const bad = G.peerOnly(ws);
          if (bad.length) return bad.join('; ');
          return { note: Object.keys(ws).length + ' манифестов' };
        },
      },
    ],
  });

  graph.checkLiveLine();
  intRun.checkImportsLine();

  return { intGuard, VITEST_GATE };
}

module.exports = { registerGateProbes };
