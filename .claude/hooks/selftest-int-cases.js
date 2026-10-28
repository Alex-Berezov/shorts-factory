'use strict';
/**
 * selftest-int-cases.js - int-проба прогона для проб гейтов test:int и harness-selftest (E0-12U:
 * раздел гейтов harness-selftest.js по заботам). Не хук: модуль самопроверки. Состояние прогона -
 * модуль test/imports.ts (IMPORTS_GATE), старт дочернего vitest (INT_VITEST_START) и его ответ
 * (VITEST_GATE), чтения int-наборов настоящего дерева и стаб int-пробы - и кейсы int-пробы: граница
 * Node, ветки отказа графа чтений, ответ vitest (startVitest/awaitVitest), pidGone и ветки самого
 * selftest-vitest.mjs. Механика пробы (граница Node, дочерний vitest, обход чтений) - selftest-int.js.
 *
 * createIntRun(ctx, int) только объявляет (int - API createIntProbe из selftest-int.js); start(GRAPH_GATE)
 * зовёт selftest-gates.js сразу после снимка графа настоящего дерева: снимок test/imports.ts, кейсы
 * до старта, старт дочернего vitest без ожидания и ленивый снимок его ответа - в прежнем порядке.
 * registerCases и checkImportsLine пишут строки, когда их зовёт selftest-gates.js.
 */

const fs = require('fs');
const path = require('path');
const { PROCESS_EXIT } = require('./selftest-children.js');

function createIntRun(ctx, int) {
  const {
    CLAUDE, G, HOOKS, LIVE_CHILDREN, LIVE_STATE, ROOT, SKIPPED, SYNTAX_OK, tempView, check, gateVerdict, killLiveChildren,
    killLiveChildrenOnExit, outcome, put, refusalVerdict, releaseTemp, run, snapshotGate, tempDir, unholdTemp, dropFailures, absent,
  } = ctx;
  const {
    NODE_LINES, NODE_NEED, nodeVerdict, importsGate, VITEST_CHILD, VITEST_MARK, SPAWN_CODE_UNKNOWN, VITEST_GONE_MS,
    INT_STUB_COMMAND, INT_STUB_PAIRS, startVitest, pidGone, VITEST_EXIT_MARK, awaitVitest, JOINED_NOT_READ,
    REPO_ROOT_REVIEWED, DISK, overlaySource, VITEST_CONDITIONS, intProbeWalk, intProbeReads, startIntVitest,
    readIntVitest, FAKE_VITEST_TIMEOUT_MS, FAKE_PAIRS, FAKE_VITEST, fakeVitest, fakeRefused,
  } = int;

  /**
   * Состояние прогона: граф настоящего дерева (GRAPH_GATE, selftest-tree-graph.js) - параметр start;
   * IMPORTS_GATE, INT_VITEST_START, VITEST_GATE ставит start. До start они null, и функции ниже до
   * него не зовутся.
   */
  let GRAPH_GATE = null;
  let IMPORTS_GATE = null;
  let INT_VITEST_START = null;
  let VITEST_GATE = null;

  /**
   * Начало int-пробы прогона - в точке, где selftest-gates.js снял граф настоящего дерева
   * (graphGate): снимок test/imports.ts, кейсы до старта, дочерний vitest без ожидания, ленивый
   * снимок его ответа, кейсы границы Node. Отдаёт { IMPORTS_GATE, VITEST_GATE }.
   */
  function start(graphGate) {
    GRAPH_GATE = graphGate;
    IMPORTS_GATE = importsGate(process.version);

    // Класс TDZ (TECH_DEBT 23.10.2026 E0-12T F4, кейс по образцу E2): функции createIntProbe,
    // вызванные сразу после её возврата, читают объявления фабрики (DISK, JOINED_NOT_READ,
    // REPO_ROOT_REVIEWED, VITEST_CONDITIONS) - ответ или отказ по сути, а не ReferenceError
    check('int-проба: функции createIntProbe сразу после её создания читают DISK, JOINED_NOT_READ, REPO_ROOT_REVIEWED, VITEST_CONDITIONS - отказ по сути, а не ReferenceError', () => {
      if (overlaySource({}).isFile('sf-selftest-none.ts') !== false) return 'DISK: несуществующий модуль назван файлом';
      const imports = {
        DYNAMIC_SPECIFIER: '?',
        repoRootUses: () => [{ kind: 'path', callee: 'join', path: '.env', line: 1 }],
        importSpecifiers: () => ['@sf/zz'],
      };
      const ws = { '@sf/zz': { dir: 'packages/zz', pkg: { name: '@sf/zz', exports: { '.': { browser: './x.js' } } } } };
      const entries = [{ name: 'r', config: 'c.ts', setupFiles: ['s.ts'], globalSetup: [] }];
      return refusalVerdict(() => intProbeWalk(entries, ws, overlaySource({ 's.ts': 'x' }), imports),
        's.ts: у @sf/zz нет строки exports["."] (условия ' + VITEST_CONDITIONS.join(', ') + ')');
    });

    // Боевой путь «pid нет, повтор запустился» до первого вызова startVitest (замечание ревью E2
    // E0-12T): всё, что он читает, обязано быть инициализировано здесь - кейс ниже по файлу шёл после
    // всех const и TDZ не видел. Программы нет - процесса нет, повтор подменён (ошибки нет).
    check('ответ vitest: «pid нет, повтор запустился» до INT_VITEST_START - отказ «код ошибки неизвестен», а не ReferenceError', () => {
      const dir = tempDir('vitest-early');
      try {
        const h = startVitest([['/a', 'vitest run --config x.ts']], dir, { bin: 'sf-selftest-no-node', spawnSync: () => ({ status: 0 }) });
        return refusalVerdict(() => awaitVitest(h), 'selftest-vitest.mjs не запустился: ' + SPAWN_CODE_UNKNOWN);
      } finally {
        releaseTemp(dir);
      }
    });
    /** Дочерний vitest пробы test:int стартует здесь, без ожидания (startIntVitest). */
    INT_VITEST_START = startIntVitest({ graph: GRAPH_GATE, imports: IMPORTS_GATE, syntax: SYNTAX_OK });
    // Причина «не стартовал» - своя на каждую из трёх (замечание ревью E4 E0-12T): красный граф или
    // test/imports.ts не объясняется пробой синтаксиса. Подменённые снимки - процесс не стартует.
    check('дочерний vitest: не стартовал - причина названа (граф, test/imports.ts, синтаксис selftest-vitest.mjs), null нет', () => {
      const ok = { error: null };
      const syntax = (v) => new Map([['selftest-vitest.mjs', v]]);
      const cases = [
        [{ graph: { error: 'g' }, imports: ok, syntax: syntax(true) }, 'дочерний vitest не стартовал: нет графа turbo (g)'],
        [{ graph: ok, imports: { error: 'i' }, syntax: syntax(true) }, 'дочерний vitest не стартовал: test/imports.ts не загружен (i)'],
        [{ graph: ok, imports: ok, syntax: syntax(false) }, 'дочерний vitest не стартовал: selftest-vitest.mjs не прошёл пробу синтаксиса'],
      ];
      const bad = cases.map(([gates, want]) => {
        const got = startIntVitest(gates);
        const text = got && got.error && got.error.message;
        return text === want ? null : 'ожидалось «' + want + '», получено ' + (got === null ? 'null' : JSON.stringify(text));
      }).filter(Boolean);
      return !bad.length || bad.join('; ');
    });
    /** Ответ дочернего vitest - ленивый снимок: его ждёт первая проба, которой он нужен (intVitest). */
    VITEST_GATE = snapshotGate(takeIntVitest, { lazy: true });
    // Ленивый снимок (замечание ревью C10 E0-12T): снимается первым take(), один раз; проба, чей take()
    // упал (и внутри refusalVerdict), не гонялась - она в перечне снимка, своей строки нет.
    check('снимок: ленивый снимок не снят - пробы, которые его взяли (и через refusalVerdict), не гонялись и названы одной строкой', () => {
      let calls = 0;
      const g = snapshotGate(() => {
        calls++;
        throw new Error('boom');
      }, { lazy: true });
      if (calls) return 'ленивый снимок снят до первой пробы';
      const got = [outcome('a', () => g.take() && true), outcome('b', () => refusalVerdict(() => g.take(), 'x'))];
      if (got.some((r) => r !== null)) return 'проба без снимка дала строку: ' + JSON.stringify(got);
      if (calls !== 1) return 'getSnap вызван ' + calls + ' раз(а)';
      const line = gateVerdict(g, () => '');
      return line === 'boom; пробы не гонялись (2): a; b' || 'строка снимка: ' + JSON.stringify(line);
    });

    // Граница Node - на подменённой версии: ниже 22.18 - отказ с версией, пробы за ней не гоняются.
    check('граница Node: отказ на v21.9.0, v22.17.0, v23.1.0, v23.5.1; пропуск на v22.18.0, v23.6.0, v24.0.0; без модуля пробы не гоняются', () => {
      const versions = ['v21.9.0', 'v22.17.0', 'v23.1.0', 'v23.5.1', 'v22.18.0', 'v23.6.0', 'v24.0.0'];
      const got = JSON.stringify(versions.map(nodeVerdict));
      const want = JSON.stringify(versions.map((v, i) => (i < 4 ? NODE_NEED + ', у тебя ' + v : null)));
      if (got !== want) return 'ожидалось ' + want + ', получено ' + got;
      const low = importsGate('v22.17.0');
      let called = 0;
      const r = low.guard('проба x', () => { called++; return true; })();
      if (r !== SKIPPED || called) return 'проба гонялась без модуля (результат ' + String(r) + ', вызовов ' + called + ')';
      const line = gateVerdict(low, () => '');
      const wantLine = NODE_NEED + ', у тебя v22.17.0 (require test/imports.ts и дочерний vitest пробы test:int); пробы не гонялись (1): проба x';
      return line === wantLine || 'строка отказа: ' + JSON.stringify(line);
    });
    // Живой модуль судится на версии этого процесса, а не на подставленной: подмена версии в
    // IMPORTS_GATE выключила бы границу на настоящем прогоне при зелёном кейсе выше.
    check('граница Node: модуль test/imports.ts этого прогона судился на process.version', () =>
      IMPORTS_GATE.version === process.version || 'IMPORTS_GATE на версии ' + JSON.stringify(IMPORTS_GATE.version) + ', процесс ' + process.version);
    // Граница Node в четырёх местах (TECH_DEBT 23.10.2026 E0-12T, E11): NODE_LINES пробы, Test-NodeFloor
    // установщика, engines.node корневого package.json и .nvmrc - одна; отказ называет источник
    check('граница Node: Test-NodeFloor в install.ps1, engines.node в package.json и .nvmrc - как NODE_LINES (проба отказа - сдвиг в каждом источнике, неразобранный терм install.ps1)', () => {
      const read = (p) => fs.readFileSync(p, 'utf8');
      const live = nodeFloorViolations({
        ps1: read(path.join(CLAUDE, 'install.ps1')),
        engines: JSON.parse(read(path.join(ROOT, 'package.json'))).engines,
        nvmrc: read(path.join(ROOT, '.nvmrc')),
      });
      if (live.length) return live.join('; ');
      const ps1 = 'function Test-NodeFloor([string]$version) {\n    return ($major -gt 23) -or ($major -eq 22 -and $minor -ge 18) -or ($major -eq 23 -and $minor -ge 6)\n}\n';
      const engines = { node: '>=22.18 <23 || >=23.6' };
      const cases = [
        [{ ps1: ps1.replace('-ge 18', '-ge 17'), engines, nvmrc: '22.18\n' }, 'install.ps1 Test-NodeFloor: {"22":17,"23":6} и мажор выше 23, у NODE_LINES {"22":18,"23":6} и мажор выше 23'],
        [{ ps1: ps1.replace(') -or ($major -eq 23', ') -or ($major -ge 23'), engines, nvmrc: '22.18\n' }, 'install.ps1 Test-NodeFloor: не разобрано «($major -ge 23 -and $minor -ge 6)» - сверка по шаблонам ($major -eq N -and $minor -ge M) и ($major -gt T)'],
        [{ ps1, engines: { node: '>=22.17 <23 || >=23.6' }, nvmrc: '22.18\n' }, 'package.json engines.node: ">=22.17 <23 || >=23.6", по NODE_LINES ">=22.18 <23 || >=23.6"'],
        [{ ps1, engines, nvmrc: '22.17\n' }, '.nvmrc 22.17: ' + NODE_NEED + ', у тебя v22.17.0'],
      ];
      const bad = cases.map(([src, want]) => [nodeFloorViolations(src).join('; '), want]).filter(([got, want]) => got !== want);
      return !bad.length || 'сверка слепа: ' + bad.map(([got, want]) => 'ожидалось «' + want + '», получено «' + got + '»').join('; ');
    });
    return { IMPORTS_GATE, VITEST_GATE };
  }

  /**
   * Расхождения границы Node с NODE_LINES (TECH_DEBT 23.10.2026 E0-12T, E11): src - { ps1 (текст
   * install.ps1), engines (поле engines корневого package.json), nvmrc (текст .nvmrc) }. install.ps1 -
   * тело Test-NodeFloor разбирается по шаблонам `($major -eq N -and $minor -ge M)` и `($major -gt T)`,
   * остаток, кроме return и -or, - отказ (fail-closed, L-028); engines.node - ровно диапазоны по
   * NODE_LINES (`>=22.18 <23 || >=23.6`); .nvmrc - версия не ниже границы своей линии (nodeVerdict).
   * Строки отказа с источником; пусто - сходится.
   */
  function nodeFloorViolations(src) {
    const bad = [];
    const majors = Object.keys(NODE_LINES).map(Number).sort((a, b) => a - b);
    const top = majors[majors.length - 1];
    const want = JSON.stringify(NODE_LINES) + ' и мажор выше ' + top;
    const body = /function Test-NodeFloor\b[^{]*\{([\s\S]*?)\n\}/.exec(String(src.ps1));
    if (!body) bad.push('install.ps1: нет функции Test-NodeFloor');
    else {
      const ret = /^\s*return\s+(.+)$/m.exec(body[1]);
      const text = ret ? ret[1].trim() : '';
      const lines = {};
      let above = null;
      const rest = text
        .replace(/\(\$major -eq (\d+) -and \$minor -ge (\d+)\)/g, (_, m, n) => { lines[m] = Number(n); return ''; })
        .replace(/\(\$major -gt (\d+)\)/g, (_, t) => { above = Number(t); return ''; })
        .replace(/\s*-or\s*/g, ' ').trim();
      if (!ret || rest) bad.push('install.ps1 Test-NodeFloor: не разобрано «' + (ret ? rest : 'нет return') + '» - сверка по шаблонам ($major -eq N -and $minor -ge M) и ($major -gt T)');
      else {
        const got = JSON.stringify(lines) + ' и мажор выше ' + above;
        if (got !== want) bad.push('install.ps1 Test-NodeFloor: ' + got + ', у NODE_LINES ' + want);
      }
    }
    const engines = src.engines && src.engines.node;
    const ranges = majors.map((m) => '>=' + m + '.' + NODE_LINES[m] + (m === top ? '' : ' <' + (m + 1))).join(' || ');
    if (typeof engines !== 'string' || engines.replace(/\s+/g, ' ').trim() !== ranges) bad.push('package.json engines.node: ' + JSON.stringify(engines) + ', по NODE_LINES ' + JSON.stringify(ranges));
    const nv = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(String(src.nvmrc).trim());
    if (!nv) bad.push('.nvmrc: не версия ' + JSON.stringify(String(src.nvmrc).trim()));
    else {
      const verdict = nodeVerdict('v' + nv[1] + '.' + (nv[2] || '0') + '.' + (nv[3] || '0'));
      if (verdict) bad.push('.nvmrc ' + String(src.nvmrc).trim() + ': ' + verdict);
    }
    return bad;
  }

  /** Обёртка пробы, которой нужны и граф, и test/imports.ts: без любого из них - SKIPPED. */
  function intGuard(name, fn) {
    return GRAPH_GATE.guard(name, IMPORTS_GATE.guard(name, fn));
  }

  /**
   * Ответ дочернего vitest (INT_VITEST_START), разобранный один раз за прогон - снимок VITEST_GATE
   * (ленивый snapshotGate, замечание ревью C10 E0-12T): { live, stub }. live - entries корней графа (пути от корня
   * через realpath) или ошибка их отображения; stub - стаб int-пробы: entry корня стаба (пути
   * стаба отображены на G.STUB_DIR - stubUnderGlob и детекторы видят его, как любой стаб-файл),
   * pairs - ответы пар INT_STUB_PAIRS по ключам как есть, entries - они же как entries
   * intProbeReads (пути стаба; ошибка пары - { error }), globalRan - метки globalSetup, которые
   * нашлись (absent: недоступная метка - отказ, а не «нет»), src - наложенный источник с текстами
   * стаба, files - стаб-файлы от корня, expect - setup, который детектор обязан назвать вне glob.
   * Каталог стаба снимается после разбора (releaseTemp: сбой снятия не подменяет ответ). Отказ
   * (не стартовал, не ответил, ответ иной формы) - одна красная строка снимка «дочерний vitest пробы
   * test:int», пробы, которым нужен ответ, - в её перечне (GateBlocked), а не каскад одинаковых строк.
   */
  function intVitest() {
    return VITEST_GATE.take();
  }
  /** Снимок VITEST_GATE: ответ INT_VITEST_START, каталог стаба снимается после разбора. */
  function takeIntVitest() {
    const launched = INT_VITEST_START;
    try {
      if (launched.error) throw launched.error;
      return readIntVitest(launched);
    } finally {
      if (launched.dir) releaseTemp(launched.dir);
    }
  }

  /**
   * Чтения int-наборов на настоящем дереве - ленивое поле снимка GRAPH_GATE (snap.int): один
   * обход за прогон по ответу intVitest; их сверяют пробы test:int и harness-selftest. Отказ
   * запоминается тоже. snap.int.reviewedHit - модули REPO_ROOT_REVIEWED, которые обход встретил.
   */
  function liveIntWalk() {
    const snap = GRAPH_GATE.snap;
    if (!snap.int) {
      try {
        const live = intVitest().live;
        if (live.error) throw live.error;
        snap.int = { value: intProbeWalk(live.value, snap.ws, DISK, IMPORTS_GATE.snap) };
      } catch (e) {
        snap.int = { error: e };
      }
    }
    if (snap.int.error) throw snap.int.error;
    return snap.int.value;
  }
  /** Чтения int-наборов настоящего дерева (liveIntWalk().reads). */
  function liveIntReads() {
    return liveIntWalk().reads;
  }

  /** Стаб int-пробы (intVitest().stub). */
  function intProbeStubBase() {
    return intVitest().stub;
  }

  /**
   * Стаб для детектора чтений int на G.stubNode: задача test:int с командой INT_STUB_COMMAND в
   * STUB_DIR (вне glob гейта, корень графа рядом с настоящими) и чтения графа int со стабом.
   * Возвращает { dry, reads, expect, files }: reads - чтения настоящих корней и корня стаба,
   * expect - setup стаба, который детектор обязан назвать; files - стаб-файлы (их glob гейта
   * покрывать не должен). Снимок dry не правится.
   */
  function intProbeStub(dry, ws) {
    const base = intProbeStubBase();
    const stub = G.stubNode(dry, 'test:int', { command: INT_STUB_COMMAND });
    const reads = intProbeReads([base.entry], ws, base.src, IMPORTS_GATE.snap).concat(liveIntReads());
    return { dry: stub, reads, expect: base.expect, files: base.files };
  }

  /** Проба графа test:int: сверх графа - чтения int-наборов (liveIntReads) и их стаб (intProbeStub). */
  const INT_GRAPH_OPTS = {
    label: 'int-тесты читают',
    liveExtra: liveIntReads,
    extraStub: intProbeStub,
  };

  /**
   * Обход int-наборов на наложенном источнике без дочернего vitest (ветки отказа - TECH_DEBT
   * 11.10.2026 E0-02A круг 3 «у веток throw нет красной посадки»; детектор чтений scripts/): один
   * корень стаба с setup STUB_DIR/vitest/s.ts. files - { путь от STUB_DIR: текст }; extraWs - пакеты
   * сверх манифестов dry; rootFiles - тексты по путям от корня; reviewed - перечень модулей,
   * разобранных руками (по умолчанию REPO_ROOT_REVIEWED). Возвращает intProbeWalk.
   */
  function intCaseWalk(files, extraWs, rootFiles, reviewed) {
    const texts = Object.assign({}, rootFiles || {});
    for (const [f, body] of Object.entries(files)) texts[G.STUB_DIR + '/' + f] = body;
    const entry = { name: G.stubTaskId('test:int'), config: G.STUB_DIR + '/vitest.selftest.config.mjs', setupFiles: [G.STUB_DIR + '/vitest/s.ts'], globalSetup: [] };
    return intProbeWalk([entry], Object.assign({}, GRAPH_GATE.snap.ws, extraWs || {}), overlaySource(texts), IMPORTS_GATE.snap, reviewed);
  }
  /** Чтения intCaseWalk. */
  function intCaseReads(files, extraWs, rootFiles) {
    return intCaseWalk(files, extraWs, rootFiles).reads;
  }

  /** Кейсы int-пробы: ветки отказа графа чтений, ответ дочернего vitest, ветки selftest-vitest.mjs. */
  function registerCases() {
    // Ветки отказа графа чтений int-наборов (E0-12T; TECH_DEBT 11.10.2026 E0-02A круг 3 «у веток throw
    // нет красной посадки»; L-020): каждая ждёт точный текст отказа, ветка, заменённая на пропуск,
    // краснит свой кейс. Конфиг и флаги - на ответе дочернего vitest по стабу (одним запуском со
    // стабом, intProbeStubBase), обход - на наложенном источнике.
    const S = (f) => G ? G.STUB_DIR + '/' + f : f;
    // want - функция: текст отказа строится от модуля графа, его зовёт только проба под intGuard
    const intRefused = (name, fn, want) => {
      const line = 'граф чтений int: ' + name;
      check(line, intGuard(line, () => refusalVerdict(fn, want())));
    };
    const stubName = () => G.stubTaskId('test:int');
    const refusalOf = (key) => intProbeReads([intProbeStubBase().entries[key]], {}, DISK, IMPORTS_GATE.snap);
    intRefused('команда без --config - отказ с именем корня', () => refusalOf('noConfig'),
      () => stubName() + ': команда "vitest run" не называет конфиг через --config или -c');
    intRefused('конфига из --config нет на диске - отказ', () => refusalOf('missingConfig'),
      () => stubName() + ': конфига vitest.missing.config.ts (--config команды "vitest run --config vitest.missing.config.ts") нет на диске');
    intRefused('оператор оболочки в команде (&&) - отказ, команда не разбирается как вызов vitest', () => refusalOf('shell'),
      () => stubName() + ': команда "vitest run --config vitest.selftest.config.mjs && rm -rf x" - не простой вызов vitest (оператор оболочки в «&&»)');
    const setupImporting = (spec) => ({ 'vitest/s.ts': 'import "' + spec + '";\nimport { join } from "node:path";\nconst repoRoot = "";\njoin(repoRoot, ".env.test");\n' });
    intRefused('@sf/x вне пакетов dry - отказ', () => intCaseReads(setupImporting('@sf/selftest-missing/x')),
      () => S('vitest/s.ts') + ': @sf/selftest-missing нет среди пакетов dry-JSON turbo (вне workspace)');
    intRefused('нет строки exports для подпути - отказ', () => intCaseReads(setupImporting('@sf/selftest-case/nothing'), { '@sf/selftest-case': { dir: S('case'), pkg: { name: '@sf/selftest-case', exports: { '.': './index.ts' } } } }),
      () => S('vitest/s.ts') + ': у @sf/selftest-case нет строки exports["./nothing"] (условия ' + VITEST_CONDITIONS.join(', ') + ')');
    // ОВ1 техлида E0-12T: пакет без поля exports (как @sf/core, @sf/contracts) - корень через main,
    // как у Node; подпуть у такого пакета и корень без main - отказ с именем
    const mainOnly = (pkg) => ({ '@sf/selftest-main': { dir: S('main'), pkg: Object.assign({ name: '@sf/selftest-main' }, pkg) } });
    {
      const line = 'граф чтений int: пакет без exports - корень @sf/x разрешается через main (модуль и манифест в чтениях)';
      check(line, intGuard(line, () => {
        const reads = intCaseReads(Object.assign(setupImporting('@sf/selftest-main'), { 'main/src/index.ts': 'export const x = 1;\n' }), mainOnly({ main: './src/index.ts' }), { '.env.test': 'X=1\n' });
        const kindOf = (file) => (reads.find((r) => r.file === file) || {}).kind;
        if (kindOf(S('main/src/index.ts')) !== 'module') return 'модуль main не в чтениях: ' + JSON.stringify(reads.map((r) => r.file));
        return kindOf(S('main/package.json')) === 'manifest' || 'манифест пакета не в чтениях: ' + JSON.stringify(reads.map((r) => r.file));
      }));
    }
    // Голый спецификатор (замечание ревью E7 E0-12T): `#…` - отказ; имя пакета dry вне @sf (другой
    // scope, без scope) - пакет workspace, его модуль и манифест в чтениях; имени нет среди пакетов -
    // внешний пакет, конец обхода
    intRefused('импорт #… (поле imports) - отказ «разбери руками»', () => intCaseReads(setupImporting('#selftest/x')),
      () => S('vitest/s.ts') + ': импорт #selftest/x по полю imports пакета - разбери руками');
    {
      const line = 'граф чтений int: пакет workspace вне @sf (другой scope и без scope) - модуль и манифест в чтениях, имя не из dry - внешний пакет';
      check(line, intGuard(line, () => {
        const pkg = (name, dir) => ({ [name]: { dir: S(dir), pkg: { name, exports: { '.': './i.ts' } } } });
        const ws = Object.assign(pkg('@selftest/scoped', 'scoped'), pkg('selftest-bare', 'bare'));
        const setup = { 'vitest/s.ts': 'import "@selftest/scoped";\nimport "selftest-bare";\nimport "selftest-external";\nimport { join } from "node:path";\nconst repoRoot = "";\njoin(repoRoot, ".env.test");\n' };
        const reads = intCaseReads(Object.assign(setup, { 'scoped/i.ts': '', 'bare/i.ts': '' }), ws, { '.env.test': 'X=1\n' });
        const files = reads.map((r) => r.kind + ' ' + r.file);
        const want = ['module ' + S('scoped/i.ts'), 'manifest ' + S('scoped/package.json'), 'module ' + S('bare/i.ts'), 'manifest ' + S('bare/package.json')];
        const missing = want.filter((w) => !files.includes(w));
        if (missing.length) return 'нет в чтениях: ' + missing.join(', ') + '; получено ' + JSON.stringify(files);
        const stray = files.filter((x) => x.includes('selftest-external'));
        return !stray.length || 'внешний пакет в чтениях: ' + stray.join(', ');
      }));
    }
    // DISK.present - absent, не existsSync (замечание ревью C6/E10 E0-12T): ошибка lstat не ENOENT и не
    // ENOTDIR (здесь - путь с NUL) - исключение, а не «фикстуры нет»
    check('граф чтений int: DISK.present - ошибка lstat не ENOENT/ENOTDIR (путь с NUL) - исключение, а не «нет»', () => {
      try {
        return 'ответ ' + DISK.present('selftest\0x') + ' вместо исключения';
      } catch (e) {
        return (e && e.code === 'ERR_INVALID_ARG_VALUE') || 'иное исключение: ' + ((e && e.message) || String(e));
      }
    });
    intRefused('пакет без exports - подпуть - отказ', () => intCaseReads(setupImporting('@sf/selftest-main/x'), mainOnly({ main: './src/index.ts' })),
      () => S('vitest/s.ts') + ': у @sf/selftest-main нет строки exports["./x"] (условия ' + VITEST_CONDITIONS.join(', ') + ')');
    intRefused('пакет без exports и без main - корень - отказ', () => intCaseReads(setupImporting('@sf/selftest-main'), mainOnly({})),
      () => S('vitest/s.ts') + ': у @sf/selftest-main нет строки exports["."] (условия ' + VITEST_CONDITIONS.join(', ') + ') и main');
    // Условный exports (замечание ревью C7 E0-12T): первое в порядке ключей условие из набора vitest
    // (VITEST_CONDITIONS), вложенный объект - так же; ни одного совпавшего - отказ
    {
      const line = 'граф чтений int: условный exports - первое по порядку ключей условие vitest (browser мимо, node раньше default, вложенный import, default первым), ни одного - отказ';
      check(line, intGuard(line, () => {
        const pkg = (exports) => ({ '@sf/selftest-cond': { dir: S('cond'), pkg: { name: '@sf/selftest-cond', exports } } });
        const texts = Object.assign(setupImporting('@sf/selftest-cond'), { 'cond/b.ts': '', 'cond/n.ts': '', 'cond/d.ts': '', 'cond/i.ts': '' });
        const moduleOf = (exports) => intCaseReads(texts, pkg(exports), { '.env.test': 'X=1\n' }).filter((r) => r.kind === 'module').map((r) => r.file);
        const got = [
          moduleOf({ browser: './b.ts', node: './n.ts', default: './d.ts' }),
          moduleOf({ '.': { require: './b.ts', node: { browser: './b.ts', import: './i.ts', default: './d.ts' }, default: './d.ts' } }),
          moduleOf({ default: './d.ts', node: './n.ts' }),
        ];
        const want = [[S('cond/n.ts')], [S('cond/i.ts')], [S('cond/d.ts')]];
        if (JSON.stringify(got) !== JSON.stringify(want)) return 'ожидалось ' + JSON.stringify(want) + ', получено ' + JSON.stringify(got);
        return refusalVerdict(() => intCaseReads(texts, pkg({ browser: './b.ts', require: './b.ts' })),
          S('vitest/s.ts') + ': у @sf/selftest-cond нет строки exports["."] (условия ' + VITEST_CONDITIONS.join(', ') + ')');
      }));
    }
    intRefused('нет файла модуля - отказ', () => intCaseReads(setupImporting('./missing.js')),
      () => S('vitest/s.ts') + ': файла ' + S('vitest/missing.js') + ' нет на диске');
    intRefused('относительный импорт вне корня репозитория (../../../x.js) - отказ', () => intCaseReads(setupImporting('../../../x.js')),
      () => S('vitest/s.ts') + ': ../../../x.js - вне корня репозитория');
    // абсолютный спецификатор - три формы одной ветки: без неё каждая молча выпала бы из графа как
    // внешний пакет
    for (const spec of ['/etc/selftest-x.js', 'C:/selftest-x.js', 'file:///selftest-x.js']) {
      intRefused('абсолютный спецификатор ' + spec + ' - отказ «разбери руками»', () => intCaseReads(setupImporting(spec)),
        () => S('vitest/s.ts') + ': абсолютный спецификатор ' + spec + ' - разбери руками');
    }
    const withRoot = (...lines) => ({ 'vitest/s.ts': 'import { join, relative, resolve } from "node:path";\nconst repoRoot = "";\n' + lines.join('\n') + '\n' });
    intRefused('нет фикстуры join(repoRoot, …) - отказ', () => intCaseReads(withRoot('join(repoRoot, "selftest-missing.env");')),
      () => 'фикстуры selftest-missing.env (join(repoRoot, …) в ' + S('vitest/s.ts') + ') нет в корне');
    intRefused('join(repoRoot, "../x") вне корня - отказ', () => intCaseReads(withRoot('join(repoRoot, ".env.test");', 'join(repoRoot, "../selftest-x");')),
      () => S('vitest/s.ts') + ': join(repoRoot, "../selftest-x") - вне корня репозитория');
    intRefused('ноль фикстур у корня - отказ', () => intCaseReads({ 'vitest/s.ts': 'export const x = 1;\n' }),
      () => 'у корня ' + stubName() + ' ноль фикстур join(repoRoot, …) в setupFiles, globalSetup и их импортах - что читают наборы, проба не знает');
    intRefused('нестроковый спецификатор (DYNAMIC_SPECIFIER) - отказ', () => intCaseReads({ 'vitest/s.ts': 'const name = "x";\nawait import(name);\n' }),
      () => S('vitest/s.ts') + ': нестроковый спецификатор (<dynamic>) - что грузит модуль, проба не знает');
    // Употребления repoRoot (решение техлида B5 E0-12T): resolve - чтение, как join; нелитерал и
    // любое иное употребление - отказ с модулем и строкой, кроме модулей REPO_ROOT_REVIEWED.
    const byHand = (line, what) => () => S('vitest/s.ts') + ':' + line + ': ' + what + ' - что читает модуль, проба не знает; разбери руками (REPO_ROOT_REVIEWED)';
    intRefused('join(repoRoot, …) с нелитералом - отказ с модулем и строкой', () => intCaseReads(withRoot('const f = "x";', 'join(repoRoot, f);')),
      byHand(4, 'join(repoRoot, …) с нелитералом'));
    intRefused('resolve(repoRoot, "<файл>") - чтение: файла нет - отказ', () => intCaseReads(withRoot('resolve(repoRoot, "selftest-missing.json");')),
      () => 'фикстуры selftest-missing.json (resolve(repoRoot, …) в ' + S('vitest/s.ts') + ') нет в корне');
    // путь не posix-формы (замечание ревью E5 E0-12T): поздний абсолютный сегмент resolve, обратный
    // слеш, буква диска - «разбери руками», а не склейка в путь под корнем или мимо outsideRoot
    for (const [call, joined] of [['resolve(repoRoot, "cfg", "/etc/x")', 'cfg//etc/x'], ['join(repoRoot, "..\\\\x")', '..\\x'], ['join(repoRoot, "C:/x")', 'C:/x'], ['join(repoRoot, "/x")', '/x'], ['join(repoRoot, "a/C:/x")', 'a/C:/x']]) {
      intRefused(call + ' - отказ «разбери руками»', () => intCaseReads(withRoot('join(repoRoot, ".env.test");', call + ';')),
        byHand(4, call.slice(0, call.indexOf('(')) + '(repoRoot, …) с путём ' + JSON.stringify(joined) + ' (обратный слеш, абсолютный сегмент или буква диска)'));
    }
    intRefused('relative(repoRoot, …) вне перечня - отказ «разбери руками»', () => intCaseReads(withRoot('join(repoRoot, ".env.test");', 'relative(repoRoot, "x");')),
      byHand(4, 'repoRoot не первым аргументом join/resolve'));
    intRefused('import { repoRoot as root } - отказ «разбери руками»', () => intCaseReads({ 'vitest/s.ts': 'import { repoRoot as root } from "./selftest-paths.js";\nimport { join } from "node:path";\njoin(root, ".env.test");\n', 'vitest/selftest-paths.ts': 'export const repoRoot = "";\n' }),
      byHand(1, 'repoRoot не первым аргументом join/resolve'));
    {
      const line = 'граф чтений int: модуль из перечня REPO_ROOT_REVIEWED - иное употребление repoRoot не отказ, литеральный join в нём - чтение, попадание записано';
      check(line, intGuard(line, () => {
        const reviewed = { [S('vitest/s.ts')]: 'кейс' };
        const walk = intCaseWalk(withRoot('join(repoRoot, ".env.test");', 'relative(repoRoot, "x");', 'resolve(repoRoot, dir);'), {}, {}, reviewed);
        if (!walk.reads.some((r) => r.file === '.env.test' && r.kind === 'fixture')) return 'литеральный join модуля перечня не в чтениях: ' + JSON.stringify(walk.reads.map((r) => r.file));
        return walk.reviewedHit.has(S('vitest/s.ts')) || 'попадание модуля перечня не записано';
      }));
    }
    {
      // запись перечня, которую обход настоящего дерева не встретил, - красная: устаревшая запись
      // молча разрешала бы новое употребление repoRoot в своём модуле
      const line = 'граф чтений int: перечень REPO_ROOT_REVIEWED - у каждой записи причина, каждую встретил обход настоящего дерева (проба отказа - запись без попадания)';
      check(line, intGuard(line, () => {
        const noWhy = Object.entries(REPO_ROOT_REVIEWED).filter(([, why]) => typeof why !== 'string' || !why).map(([mod]) => mod);
        if (noWhy.length) return 'запись без причины: ' + noWhy.join(', ');
        const hit = liveIntWalk().reviewedHit;
        const missed = (keys) => keys.filter((mod) => !hit.has(mod));
        const stale = missed(Object.keys(REPO_ROOT_REVIEWED));
        if (stale.length) return 'запись перечня без попадания в обходе настоящего дерева: ' + stale.join(', ');
        const planted = S('selftest-never.ts');
        return missed(Object.keys(REPO_ROOT_REVIEWED).concat(planted)).join() === planted || 'запись без попадания не названа - сверка слепа';
      }));
    }
    // Р2 техлида E0-12T: join '.env' - не чтение по JOINED_NOT_READ (точное имя, не маска:
    // '.env.local' - уже чтение и проверка наличия); второй файл окружения (.env.int - TECH_DEBT
    // 11.10.2026 E0-02A круг 3, `intProbeReads`) - чтение наравне с .env.test; setup без
    // testEnvFilePath законен, если фикстура есть где-то в обходе.
    {
      const line = 'граф чтений int: join(repoRoot, ".env") - не чтение (JOINED_NOT_READ с причиной), ".env.local" - не под исключением, второй файл окружения .env.int - чтение';
      check(line, intGuard(line, () => {
        if (typeof JOINED_NOT_READ['.env'] !== 'string' || !JOINED_NOT_READ['.env']) return 'у JOINED_NOT_READ[".env"] нет причины';
        const joins = (...names) => withRoot(...names.map((n) => 'join(repoRoot, "' + n + '");'));
        const files = intCaseReads(joins('.env', '.env.test', '.env.int'), {}, { '.env.int': 'X=1\n' }).map((r) => r.file);
        if (files.includes('.env')) return '.env попал в чтения: ' + JSON.stringify(files);
        if (!files.includes('.env.test') || !files.includes('.env.int')) return '.env.test и .env.int не оба в чтениях: ' + JSON.stringify(files);
        const local = refusalVerdict(() => intCaseReads(joins('.env.test', '.env.local')), 'фикстуры .env.local (join(repoRoot, …) в ' + G.STUB_DIR + '/vitest/s.ts) нет в корне');
        if (local !== true) return '.env.local: ' + local;
        return { note: '.env - ' + JOINED_NOT_READ['.env'] };
      }));
    }
    // Ответ дочернего vitest по стабу (TECH_DEBT 11.10.2026 E0-02A круг 3 «-c и путь в кавычках»):
    // конфиг и setup стаба - пути стаба; globalSetup не исполнен; кавычки и --root разобраны.
    const stubEntry = (dir) => ({ name: stubName(), config: S(dir + 'vitest.selftest.config.mjs'), setupFiles: [S(dir + 'vitest/selftest-setup.ts')], globalSetup: [S(dir + 'vitest/selftest-global.mjs')] });
    const stubLine = (name, fn) => {
      const line = 'граф чтений int: дочерний vitest - ' + name;
      check(line, intGuard(line, fn));
    };
    stubLine('конфиг, setupFiles и globalSetup стаба на месте', () => {
      const want = JSON.stringify(stubEntry(''));
      return JSON.stringify(intProbeStubBase().entry) === want || 'ожидалось ' + want + ', получено ' + JSON.stringify(intProbeStubBase().entry);
    });
    stubLine('globalSetup при чтении конфига не исполнен (меток стаба нет)', () => {
      const ran = intProbeStubBase().globalRan;
      return !ran.length || 'globalSetup стаба исполнился при чтении конфига: метки ' + ran.join(', ');
    });
    stubLine('-c "конфиг" и -c \'конфиг\' (и с пробелом в имени) - один конфиг стаба', () => {
      const e = intProbeStubBase().entries;
      const spaced = Object.assign(stubEntry(''), { config: S('vitest space.config.mjs') });
      const want = { quoted: stubEntry(''), spacedDouble: spaced, spacedSingle: spaced };
      const bad = Object.keys(want).filter((k) => JSON.stringify(e[k]) !== JSON.stringify(want[k])).map((k) => INT_STUB_PAIRS[k] + ': ' + JSON.stringify(e[k]));
      return !bad.length || bad.join('; ');
    });
    stubLine('--root: конфиг и setupFiles разрешены от корня из флага, как у настоящего запуска', () => {
      const want = JSON.stringify({ name: stubName(), config: S('rooted/vitest.selftest.config.mjs'), setupFiles: [S('rooted/vitest/rooted-setup.ts')], globalSetup: [S('rooted/vitest/rooted-global.mjs')] });
      return JSON.stringify(intProbeStubBase().entries.rooted) === want || 'ожидалось ' + want + ', получено ' + JSON.stringify(intProbeStubBase().entries.rooted);
    });

    const what = 'selftest-vitest.mjs';
    const line = (name) => 'граф чтений int: ответ vitest (startVitest/awaitVitest) - ' + name;
    check(line('законный ответ разобран'), () => {
      const r = fakeVitest().ok;
      const want = JSON.stringify([{ dir: '/a', config: '/a/x.ts', setupFiles: ['/a/s.ts'], globalSetup: [] }]);
      return (r.error === undefined && JSON.stringify(r.value) === want) || 'получено ' + JSON.stringify(r);
    });
    check(line('вышел с кодом 1 - отказ с кодом и stderr'), () => fakeRefused('code1', what + ': код 1: boom'));
    check(line('stdout без строки ответа - отказ'), () => fakeRefused('empty', what + ': в stdout не ровно одна строка «' + VITEST_MARK.trim() + ' <JSON>»: ' + JSON.stringify(VITEST_EXIT_MARK + '0\n')));
    check(line('ответ не JSON - отказ'), () => {
      let why = '';
      try {
        JSON.parse('{oops');
      } catch (e) {
        why = e.message;
      }
      return fakeRefused('notJson', what + ': ответ не JSON (' + why + ')');
    });
    check(line('ответ не по числу пар - отказ'), () => fakeRefused('count', what + ': ответ не массив из 1 элементов: []'));
    check(line('элемент чужого каталога - отказ'), () => fakeRefused('foreign', what + ': ответ пары 1 (/a) иной формы: {"dir":"/b","config":"/b/x.ts","setupFiles":[],"globalSetup":[]}'));
    check(line('нет строки выхода за предел - отказ, процесс снят SIGKILL'), () => {
      const verdict = fakeRefused('hang', what + ': не ответил за ' + FAKE_VITEST_TIMEOUT_MS / 1000 + ' с - процесс убит');
      if (verdict !== true) return verdict;
      const pid = fakeVitest().hang.pid;
      return pidGone(pid, VITEST_GONE_MS) || 'процесс ' + pid + ' жив через 2 с после отказа по пределу';
    });
    check(line('программа не запустилась - отказ «не запустился: ENOENT» без ожидания предела'), () => {
      const verdict = fakeRefused('noSpawn', what + ' не запустился: ENOENT');
      if (verdict !== true) return verdict;
      const ms = fakeVitest().noSpawn.ms;
      return ms < 5000 || 'отказ через ' + Math.round(ms) + ' мс - ждал предела';
    });
    // замечание ревью C12 E0-12T: Number('') = 0 сделал бы обрезанную строку выхода успехом
    check(line('строка выхода без кода и с нецелым кодом - отказ «без целого кода»'), () => {
      const bad = [['exitEmpty', ''], ['exitText', '1x']]
        .map(([key, code]) => fakeRefused(key, what + ': строка выхода без целого кода: ' + JSON.stringify(VITEST_EXIT_MARK + code)))
        .filter((v) => v !== true);
      return !bad.length || bad.join('; ');
    });
    // Ветка «pid нет, а повтор той же программы запустился» (замечание ревью C2 E0-12T): подменённые
    // spawn (ребёнок без pid) и spawnSync (повтор без ошибки) - отказ SPAWN_CODE_UNKNOWN сразу, без
    // ожидания предела и без kill процесса, которого нет
    check(line('pid нет, повтор запустился - отказ «не запустился: код ошибки неизвестен» без ожидания предела'), () => {
      const dir = tempDir('vitest-nopid');
      try {
        const killed = [];
        const fake = { pid: undefined, on: () => fake, unref: () => {}, kill: (sig) => killed.push(sig) };
        const t0 = performance.now();
        const h = startVitest(FAKE_PAIRS, dir, { spawn: () => fake, spawnSync: () => ({ status: 0 }), timeoutMs: FAKE_VITEST_TIMEOUT_MS });
        const verdict = refusalVerdict(() => awaitVitest(h), what + ' не запустился: ' + SPAWN_CODE_UNKNOWN);
        if (verdict !== true) return verdict;
        if (killed.length) return 'kill процесса без pid: ' + killed.join(', ');
        if (LIVE_CHILDREN.has(fake)) return 'процесс без pid в LIVE_CHILDREN';
        const ms = performance.now() - t0;
        return ms < FAKE_VITEST_TIMEOUT_MS || 'отказ через ' + Math.round(ms) + ' мс - ждал предела';
      } finally {
        releaseTemp(dir);
      }
    });
    // LIVE_CHILDREN (замечание ревью C3 E0-12T): запущенный без ожидания ребёнок - в наборе до ответа,
    // killLiveChildren снимает его SIGKILL и чистит набор, обработчик exit процесса зовёт её раньше
    // снятия каталогов реестра (tempView.dropAll). Набор кейса - свой: общий держит дочерний vitest пробы.
    check(line('ребёнок без ответа - в LIVE_CHILDREN, killLiveChildren снимает его до снятия каталогов на exit'), () => {
      const exits = process.listeners('exit');
      const kill = exits.indexOf(killLiveChildrenOnExit);
      if (kill === -1) return 'killLiveChildren не в обработчиках exit';
      if (kill > exits.indexOf(tempView.dropAll)) return 'killLiveChildren на exit позже TEMP.dropAll';
      const dir = tempDir('vitest-live');
      try {
        fs.writeFileSync(path.join(dir, 'child.js'), FAKE_VITEST.hang);
        const h = startVitest(FAKE_PAIRS, dir, { child: path.join(dir, 'child.js') });
        const had = LIVE_CHILDREN.delete(h.child);
        const own = new Set([h.child]);
        killLiveChildren(own);
        if (!had) {
          h.child.kill('SIGKILL');
          return 'запущенный ребёнок не в LIVE_CHILDREN';
        }
        if (own.size) return 'набор после killLiveChildren не пуст';
        return pidGone(h.child.pid, VITEST_GONE_MS) || 'процесс ' + h.child.pid + ' жив через 2 с после killLiveChildren';
      } finally {
        releaseTemp(dir);
      }
    });
    // Строку выхода пишет обработчик exit ребёнка, процесс ещё жив (замечание ревью E3 E0-12T):
    // awaitVitest ждёт его конца до снятия из LIVE_CHILDREN и каталога. Ребёнок кейса пишет ответ и
    // строку выхода сам и живёт ещё 300 мс - после awaitVitest его нет с первой сверки.
    check(line('строка выхода, процесс ещё жив - awaitVitest ждёт его конца до ответа'), () => {
      const dir = tempDir('vitest-linger');
      try {
        const answer = VITEST_MARK + JSON.stringify([{ dir: '/a', config: '/a/x.ts', setupFiles: [], globalSetup: [] }]) + '\n' + VITEST_EXIT_MARK + '0\n';
        fs.writeFileSync(path.join(dir, 'child.js'), 'process.stdout.write(' + JSON.stringify(answer) + ');\nsetTimeout(() => {}, 300);\n');
        const h = startVitest(FAKE_PAIRS, dir, { child: path.join(dir, 'child.js') });
        try {
          awaitVitest(h);
        } catch (e) {
          return 'ответ ребёнка кейса отвергнут: ' + ((e && e.message) || String(e));
        }
        return pidGone(h.child.pid, 0) || 'процесс ' + h.child.pid + ' жив после ответа awaitVitest';
      } finally {
        releaseTemp(dir);
      }
    });
    // Linux (замечание ревью E1 E0-12T): процесс-зомби (Z в /proc/<pid>/stat) - нет, хотя kill(pid, 0)
    // отвечает; файла stat нет - нет; иное состояние - по kill. Источник подменён, процессов нет.
    check('pidGone: Linux - зомби (Z, имя со скобками и пробелом) и снятый /proc/<pid>/stat - процесса нет, S при живом kill - есть', () => {
      const alive = () => true;
      const linux = (readStat) => pidGone(4242, 0, { platform: 'linux', readStat, kill: alive });
      // нет stat процесса при смонтированном /proc (свой stat читается)
      const enoent = (p) => {
        if (p === 'self') return '1 (node) R 0 1';
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      };
      const got = [linux(() => '4242 (node (x) y) Z 1 4242'), linux(enoent), linux(() => '4242 (node) S 1 4242')];
      return JSON.stringify(got) === '[true,true,false]' || 'ожидалось [true,true,false] (Z, нет stat, S), получено ' + JSON.stringify(got);
    });
    // Решение техлида (круг 3): иная ошибка kill/readStat - «жив», а не исключение поверх готового
    // ответа; ENOENT без читаемого /proc/self/stat (/proc не смонтирован) - не «нет», ветка kill
    check('pidGone: kill и readStat с EACCES - «жив» без исключения; ENOENT на всё (/proc нет) при живом kill - «жив»', () => {
      const fail = (code) => () => {
        throw Object.assign(new Error(code), { code });
      };
      let got;
      try {
        got = [
          pidGone(4242, 0, { platform: 'win32', kill: fail('EACCES') }),
          pidGone(4242, 0, { platform: 'linux', readStat: fail('EACCES'), kill: () => true }),
          pidGone(4242, 0, { platform: 'linux', readStat: fail('ENOENT'), kill: () => true }),
        ];
      } catch (e) {
        return 'исключение вместо «жив»: ' + ((e && e.message) || String(e));
      }
      return JSON.stringify(got) === '[false,false,false]' || 'ожидалось [false,false,false] (kill EACCES, stat EACCES, нет /proc), получено ' + JSON.stringify(got);
    });
    // Решение техлида (круг 3): ребёнок, не вышедший за goneMs после строки выхода, снимается SIGKILL
    // до снятия из LIVE_CHILDREN; goneMs 0 - без ожидания
    check(line('строка выхода, процесс не вышел за goneMs - снят SIGKILL'), () => {
      const dir = tempDir('vitest-stuck');
      try {
        const answer = VITEST_MARK + JSON.stringify([{ dir: '/a', config: '/a/x.ts', setupFiles: [], globalSetup: [] }]) + '\n' + VITEST_EXIT_MARK + '0\n';
        fs.writeFileSync(path.join(dir, 'child.js'), 'process.stdout.write(' + JSON.stringify(answer) + ');\nsetTimeout(() => {}, 1000);\n');
        const h = startVitest(FAKE_PAIRS, dir, { child: path.join(dir, 'child.js'), goneMs: 0 });
        try {
          awaitVitest(h);
        } catch (e) {
          return 'ответ ребёнка кейса отвергнут: ' + ((e && e.message) || String(e));
        }
        const killed = h.child.killed;
        pidGone(h.child.pid, VITEST_GONE_MS);
        return killed === true || 'процесс ' + h.child.pid + ' не снят SIGKILL после строки выхода';
      } finally {
        releaseTemp(dir);
      }
    });
    // Fix 3a (TECH_DEBT 23.10.2026 E0-12T): после SIGKILL awaitVitest ждёт конца процесса до ответа и
    // снятия из LIVE_CHILDREN. Ребёнок кейса пишет ответ и строку выхода и живёт, пока не придёт
    // «SIGKILL» - файл-отметка, которую пишет подменённое снятие; получив её, он живёт ещё 500 мс и
    // выходит. Окно считается от события (отметки), а не от старта ребёнка: на занятой машине ребёнок не
    // выйдет раньше снятия, и ветка SIGKILL пройдена всегда; после ответа awaitVitest процесса нет
    check(line('после SIGKILL awaitVitest ждёт конца процесса до ответа и снятия из LIVE_CHILDREN'), () => {
      const dir = tempDir('vitest-killwait');
      try {
        const answer = VITEST_MARK + JSON.stringify([{ dir: '/a', config: '/a/x.ts', setupFiles: [], globalSetup: [] }]) + '\n' + VITEST_EXIT_MARK + '0\n';
        const killMark = path.join(dir, 'killed');
        fs.writeFileSync(path.join(dir, 'child.js'), [
          'process.stdout.write(' + JSON.stringify(answer) + ');',
          'const cap = setTimeout(() => {}, 30000);',
          'const poll = setInterval(() => {',
          '  if (!require("fs").existsSync(' + JSON.stringify(killMark) + ')) return;',
          '  clearInterval(poll);',
          '  clearTimeout(cap);',
          '  setTimeout(() => {}, 500);',
          '}, 20);',
        ].join('\n'));
        const killed = [];
        const h = startVitest(FAKE_PAIRS, dir, {
          child: path.join(dir, 'child.js'),
          goneMs: 0,
          kill: (c) => {
            killed.push(c.pid);
            fs.writeFileSync(killMark, 'kill');
          },
        });
        try {
          awaitVitest(h);
        } catch (e) {
          return 'ответ ребёнка кейса отвергнут: ' + ((e && e.message) || String(e));
        }
        if (!killed.length) return 'снятие не вызвано - ветка SIGKILL не пройдена';
        if (LIVE_CHILDREN.has(h.child)) return 'ребёнок остался в LIVE_CHILDREN';
        return pidGone(h.child.pid, 0) || 'процесс ' + h.child.pid + ' жив после ответа awaitVitest - снят из набора до своего конца';
      } finally {
        releaseTemp(dir);
      }
    });
    // Предел ожидания после SIGKILL не дождался - отказ с именем программы ребёнка и pid, не молчаливое
    // снятие (Fix 3a); ребёнок остаётся в LIVE_CHILDREN, каталог его вывода держится (holdTemp):
    // releaseTemp вызывающего его не трогает и сбоем снятия не пишет (замечание ревью E0-12AA C2); вывод
    // ребёнка - в подкаталоге корня, как у fakeVitest: держится корень, который снимает вызывающий (Р9 E0-12AA)
    check(line('процесс жив после SIGKILL дольше предела - отказ с pid, ребёнок в LIVE_CHILDREN, каталог держится до выхода прогона'), () => {
      const dir = tempDir('vitest-killfail');
      let h = null;
      try {
        const sub = path.dirname(put(dir, 'hang/child.js', FAKE_VITEST.hang));
        h = startVitest(FAKE_PAIRS, sub, { hold: dir, child: path.join(sub, 'child.js'), timeoutMs: FAKE_VITEST_TIMEOUT_MS, killGoneMs: 0, kill: () => {} });
        const refused = refusalVerdict(() => awaitVitest(h), 'child.js: процесс ' + h.child.pid + ' жив через 0 с после SIGKILL - каталог его вывода не снять');
        if (refused !== true) return refused;
        if (!LIVE_CHILDREN.has(h.child)) return 'ребёнок снят из LIVE_CHILDREN при отказе - выход прогона его не снимет';
        const failures = dropFailures();
        if (releaseTemp(dir) !== false || absent(dir)) return 'каталог живого ребёнка снят или снимался releaseTemp - он держится до выхода прогона';
        if (dropFailures() !== failures) return 'releaseTemp каталога живого ребёнка записал сбой снятия';
        return true;
      } finally {
        if (h) {
          LIVE_CHILDREN.delete(h.child);
          h.child.kill('SIGKILL');
          pidGone(h.child.pid, VITEST_GONE_MS);
        }
        unholdTemp(dir);
        releaseTemp(dir);
      }
    });
    // F10 (TECH_DEBT 23.10.2026 E0-12T): состояние X (dead) в /proc/<pid>/stat - процесса нет
    check('pidGone: Linux - состояние X (dead) в /proc/<pid>/stat при живом kill - процесса нет', () =>
      pidGone(4242, 0, { platform: 'linux', readStat: () => '4242 (node) X 1 4242', kill: () => true }) === true || 'состояние X принято за живой процесс');
    // F10: не-linux ветка (kill(pid, 0)) на настоящем процессе - этот процесс есть, вышедший ребёнок - нет
    check('pidGone: win32 и darwin - настоящий kill(pid, 0): живой процесс есть, вышедший ребёнок - нет', () => {
      const done = run(process.execPath, ['-e', ''], { cwd: ROOT });
      if (done.status !== 0 || !done.pid) return 'ребёнок кейса не отработал: код ' + done.status;
      const got = ['win32', 'darwin'].map((platform) => [pidGone(process.pid, 0, { platform }), pidGone(done.pid, 0, { platform })]);
      return JSON.stringify(got) === '[[false,true],[false,true]]' || 'ожидалось [[false,true],[false,true]] (живой, вышедший), получено ' + JSON.stringify(got);
    });
    // F10: имя пакета constructor, __proto__, toString среди пакетов dry ищется только как своё
    // свойство: через прототип объекта ws оно не находится, импорт - внешний пакет, не TypeError
    for (const name of ['constructor', '__proto__', 'toString']) {
      check('граф чтений int: импорт ' + name + ' - не пакет workspace (своё свойство ws, не прототип), внешний пакет', () => {
        const imports = {
          DYNAMIC_SPECIFIER: '?',
          repoRootUses: () => [{ kind: 'path', callee: 'join', path: '.env.test', line: 1 }],
          importSpecifiers: () => [name],
        };
        const entries = [{ name: 'r', config: 'c.ts', setupFiles: ['s.ts'], globalSetup: [] }];
        let reads;
        try {
          reads = intProbeWalk(entries, {}, overlaySource({ 's.ts': 'x', '.env.test': '' }), imports).reads.map((r) => r.file);
        } catch (e) {
          return 'исключение: ' + ((e && e.message) || String(e));
        }
        return JSON.stringify(reads) === JSON.stringify(['c.ts', 's.ts', '.env.test']) || 'чтения ' + JSON.stringify(reads);
      });
    }
    // E9 (TECH_DEBT 23.10.2026 E0-12T): тело обработчика exit исполняется - дочерний node берёт набор
    // детей из selftest-children.js (одно тело с самопроверкой), кладёт туда внука (detached: на Windows
    // иначе его снимает job object libuv вместе с ребёнком) и выходит exit процесса; после выхода внука
    // нет. Сторона отказа - тот же ребёнок с пустым снятием (deps.kill): внук жив
    // pid внуков кейса обработчика exit: их снимает finally кейса, сверяет строка после него
    const grandchildren = [];
    // Внук - через точку запуска selftest-children.js (makeLauncher: его окружение проходит
    // hookStateGuard). Каждый внук, чей pid кейс получил, снимается в finally при любом исходе - и при
    // раннем отказе (замечание ревью E0-12AA T9: detached-внук с setInterval иначе жил бы вечно)
    check('killLiveChildrenOnExit: exit процесса снимает внука из набора детей (тело обработчика исполняется); пустое снятие - внук жив', () => {
      const code = [
        'const { makeChildRegistry, makeLauncher } = require(' + JSON.stringify(path.join(HOOKS, 'selftest-children.js')) + ');',
        "const reg = makeChildRegistry(process.argv[1] === 'empty' ? { kill: () => {} } : undefined);",
        "process.on('exit', reg.onExit);",
        'const g = makeLauncher({ liveState: ' + JSON.stringify(LIVE_STATE) + " }).spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true });",
        'g.unref();',
        'reg.live.add(g);',
        'process.stdout.write(String(g.pid));',
        PROCESS_EXIT + '(0);',
      ].join('\n');
      const child = (mode) => {
        const r = run(process.execPath, ['-e', code, mode], { cwd: ROOT, timeout: 30000, killSignal: 'SIGKILL' });
        const pid = Number(String(r.stdout || '').trim()) || null;
        if (pid) grandchildren.push(pid);
        return { code: r.status, pid, err: String(r.stderr || '').slice(0, 160) };
      };
      try {
        const real = child('real');
        if (real.code !== 0 || !real.pid) return 'ребёнок: код ' + real.code + ', pid внука ' + real.pid + ' ' + real.err;
        if (!pidGone(real.pid, VITEST_GONE_MS)) return 'внук ' + real.pid + ' жив после exit процесса - обработчик не снял набор детей';
        const empty = child('empty');
        if (empty.code !== 0 || !empty.pid) return 'ребёнок с пустым снятием: код ' + empty.code + ' ' + empty.err;
        return !pidGone(empty.pid, 300) || 'с пустым снятием внук ' + empty.pid + ' тоже мёртв - кейс не видит тела обработчика';
      } finally {
        for (const pid of grandchildren) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (_) {
            // внук уже вышел
          }
          pidGone(pid, VITEST_GONE_MS);
        }
      }
    });
    // T9 (замечание ревью E0-12AA): после кейса обработчика exit ни одного его внука нет - finally снял
    // каждого, чей pid получен, и при раннем отказе; живой - отказ с pid (и снятие здесь)
    check('killLiveChildrenOnExit: после кейса ни одного его внука нет (снятие в finally при любом исходе)', () => {
      const alive = grandchildren.filter((pid) => !pidGone(pid, VITEST_GONE_MS));
      for (const pid of alive) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (_) {
          // внук уже вышел
        }
      }
      if (!grandchildren.length) return 'кейс не получил ни одного pid внука - сверять нечего';
      return !alive.length || 'внуки живы после кейса: ' + alive.join(', ');
    });
    // Ветки самого selftest-vitest.mjs, которые selftest-int.js не вызывает: нечётное число
    // аргументов (до загрузки vitest) и vitest/node, который не грузится (копия модуля и его lib.js вне
    // репозитория, где пакета vitest нет), - ошибка каждой пары в JSON, выход с кодом 0.
    check('selftest-vitest.mjs: нечётное число аргументов - ошибка пары в ответе, без загрузки vitest', () => {
      const r = run(process.execPath, [VITEST_CHILD, 'a', 'b', 'c'], { cwd: ROOT, timeout: 30000, killSignal: 'SIGKILL' });
      const want = VITEST_MARK + JSON.stringify([{ dir: 'a', error: 'аргументы - не пары <dir> <command>: 3 слов' }]);
      const got = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith(VITEST_MARK));
      return (r.status === 0 && got === want) || 'код ' + r.status + ', строка ' + JSON.stringify(got) + ', ожидалась ' + JSON.stringify(want);
    });
    check('selftest-vitest.mjs: vitest/node не загрузился - ошибка каждой пары в ответе, код 0', () => {
      const dir = tempDir('vitest-alone');
      try {
        const copy = path.join(dir, 'selftest-vitest.mjs');
        fs.copyFileSync(VITEST_CHILD, copy);
        // модуль берёт isFilePresent из соседнего lib.js и строки протокола из соседнего модуля протокола
        fs.copyFileSync(path.join(HOOKS, 'lib.js'), path.join(dir, 'lib.js'));
        fs.copyFileSync(path.join(HOOKS, 'selftest-vitest-protocol.cjs'), path.join(dir, 'selftest-vitest-protocol.cjs'));
        const r = run(process.execPath, [copy, 'a', 'vitest run -c x.ts', 'b', 'vitest run -c y.ts'], { cwd: dir, timeout: 30000, killSignal: 'SIGKILL' });
        const got = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith(VITEST_MARK));
        let out = null;
        try {
          out = JSON.parse(String(got).slice(VITEST_MARK.length));
        } catch (_) {
          // строки ответа нет или она не JSON - отказ ниже
        }
        const prefix = 'vitest/node не загрузился: ';
        const ok = r.status === 0 && Array.isArray(out) && out.length === 2 && out.every((x, i) => x.dir === ['a', 'b'][i] && typeof x.error === 'string' && x.error.startsWith(prefix));
        return ok || 'код ' + r.status + ', ответ ' + JSON.stringify(got) + ' ' + String(r.stderr || '').slice(0, 160);
      } finally {
        releaseTemp(dir);
      }
    });
  }

  /** Строка модуля test/imports.ts (IMPORTS_GATE): после всех проб, которые его читают. */
  function checkImportsLine() {
    // Строка модуля разбора импортов: граница Node или сбой require test/imports.ts - здесь один раз,
    // с перечнем проб, которые без модуля не гонялись.
    check('test/imports.ts: require .ts (Node 22.18+, 23.6+ или 24+) для пробы test:int', () => gateVerdict(IMPORTS_GATE, () => 'Node ' + process.version));
  }

  return {
    start, intGuard, liveIntReads, intProbeStubBase, intCaseReads, INT_GRAPH_OPTS, registerCases, checkImportsLine,
  };
}

module.exports = { createIntRun };
