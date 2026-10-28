'use strict';
/**
 * selftest-tree-graph.js - граф turbo настоящего дерева для проб гейтов build, test:int и
 * harness-selftest (E0-12U: раздел гейтов harness-selftest.js по заботам). Не хук: модуль
 * самопроверки. Снимок графа прогона (GRAPH_GATE: dry-JSON, манифесты пакетов dry, шаблоны
 * pnpm-workspace.yaml, файлы, видимые git), его строка, проба графа гейта (checkTurboGraph) и
 * детекторы, которые доказывают, что проба не слепа (стабы узла, глобального входа, среза ребра,
 * снятого входа); временный корень кейсов (withTempRoot). Разбор dry и стабы - модуль графа G
 * (selftest-turbo.js, selftest-graph.js, selftest-stub.js).
 *
 * createTreeGraph(ctx) только объявляет; снимок снимает takeLive() в той точке прогона, где его
 * зовёт selftest-gates.js (один раз), строки пишут checkStubDirCase и checkLiveLine.
 */

const fs = require('fs');
const path = require('path');

function createTreeGraph(ctx) {
  const {
    G, L, LISTING_MAX_BUFFER, ROOT, check, gateVerdict, git, gitLive, inLiveTree, put, readJson, releaseTemp, run, snapshotGate, tempDir,
  } = ctx;

  /**
   * Граф задач turbo (selftest-graph.js, E0-12L, решение техлида Р1 21.10.2026): один dry-JSON
   * на прогон для проб build, test:int и harness-selftest. Своего разбора pnpm-workspace.yaml
   * и next.config.* нет: корни, их зависимости и файлы, которые хеширует каждая задача, даёт turbo.
   */
  const GRAPH_SCRIPTS = ['build', 'test:int'];

  /** Строка пробы графа state (snapshotGate). */
  function graphVerdict(state) {
    return gateVerdict(state, (snap) => snap.dry.tasks.length + ' задач', 'пробы графа');
  }

  /** Граф настоящего дерева (snapshotGate): один снимок на прогон; без модуля графа - отказ снимка. */
  let GRAPH_GATE = null;
  /** Снимает GRAPH_GATE (liveSnap) и отдаёт его; зовёт selftest-gates.js один раз, в прежней точке прогона. */
  function takeLive() {
    GRAPH_GATE = snapshotGate(liveSnap);
    return GRAPH_GATE;
  }

  /**
   * Временный корень кейса: файлы files ({ путь: текст }) во временном каталоге реестра; каталог
   * снимается releaseTemp (ссылки и junction внутри - unlink до удаления; TECH_DEBT 21.10.2026 E0-12L круг 4, `withTempRoot`).
   */
  function withTempRoot(files, fn) {
    const dir = tempDir('turbo');
    try {
      for (const [rel, body] of Object.entries(files)) put(dir, rel, body);
      return fn(dir);
    } finally {
      releaseTemp(dir);
    }
  }

  /**
   * Файлы, которые git видит в дереве (`git ls-files -z`, пути от корня) и которые есть на диске:
   * удалённый в рабочем дереве файл turbo не хеширует. Для G.inputsGap; git зовёт только
   * самопроверка (живое дерево - gitLive с конфигом оператора, как у files.mjs, решение техлида Р8
   * E0-12AA; временный корень кейса - git(); признак - ctx.inLiveTree, как у repoSnapshot), модуль графа получает список параметром. git не запустился или
   * упал - исключение; вывод больше maxBuffer (ENOBUFS) - своя причина, а не «не запустился».
   * Наличие на диске - stat, как у близнеца trackedFiles из scripts/lib/files.mjs: ссылка судится по
   * цели - на файл в списке, на каталог и висячая - нет; ENOENT и ENOTDIR (родитель стал файлом) -
   * файла нет, путь стал каталогом - файла нет, иная ошибка (EACCES) - исключение, а не молча
   * выпавший файл. opts - подмена для кейсов: root (корень дерева; по умолчанию репозиторий), git
   * (имя команды), spawn (вместо run), stat (вместо fs.statSync); others - ещё и новые
   * неигнорируемые файлы (--others --exclude-standard, сверка путей note). С others - близнец trackedFiles из scripts/lib/files.mjs без keep: аргументы git,
   * дедуп путей и отбор файлов сверяет проба «близнец trackedFiles» в selftest-graph-cases.js (правка флагов там без
   * правки здесь - красная), она же - maxBuffer git с LISTING_MAX_BUFFER из files.mjs (К3-6 E0-12N).
   */
  function trackedFiles(opts) {
    const o = opts || {};
    const stat = o.stat || fs.statSync;
    const root = o.root || ROOT;
    const others = o.others ? ['--others', '--exclude-standard'] : [];
    const call = inLiveTree(root) ? gitLive : git;
    const r = call(['ls-files', '-z', '--cached', ...others], { cwd: root, maxBuffer: LISTING_MAX_BUFFER, spawn: o.spawn, bin: o.git });
    if (r.error && r.error.code === 'ENOBUFS') throw new Error('git ls-files: вывод больше maxBuffer (' + LISTING_MAX_BUFFER + ' байт)');
    if (r.error) throw new Error('git ls-files не запустился: ' + r.error.message);
    if (r.status !== 0) throw new Error('git ls-files: ' + (r.status === null ? 'сигнал ' + r.signal : 'код ' + r.status) + ': ' + String(r.stderr || '').trim());
    // «файл есть» - один помощник обвязки (L.isFilePresent: нет пути - false, иной сбой - исключение)
    const isFile = (f) => L.isFilePresent(path.join(root, f), stat);
    // --cached --others даёт файл с конфликтом по строке на стадию - один раз, как в files.mjs.
    return [...new Set(r.stdout.split('\0'))].filter((f) => f && isFile(f));
  }

  /**
   * Снимок настоящего дерева для GRAPH_GATE: dry (dry-JSON turbo), ws (манифесты пакетов dry), patterns
   * (шаблоны pnpm-workspace.yaml), tracked (файлы, видимые git) и int - ленивое поле: обход чтений
   * int-наборов (liveIntWalk), null до первой пробы, которой он нужен. Корневой package.json - не здесь,
   * а в rootPkg; ответ дочернего vitest - в VITEST_GATE. Без модуля графа снимка нет: отказ называет
   * строка графа.
   */
  function liveSnap() {
    if (!G) throw new Error('модуль графа selftest-graph.js не загружен (строка синтаксиса или require выше)');
    // turbo - через точку запуска самопроверки (ctx.run), а не свою (замечание ревью E0-12AA); общий
    // кэш dry - только у этого вызова (shared): кейсы с подменённым run идут мимо него (Р9 E0-12AA)
    const dry = G.turboDry(GRAPH_SCRIPTS, { run, shared: true });
    return {
      dry,
      ws: dryManifests(dry),
      patterns: G.workspacePatterns(fs.readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8')),
      tracked: trackedFiles(),
      int: null,
    };
  }

  /**
   * Манифесты пакетов dry: { имя: { dir, pkg } } - workspace:-зависимости для G.manifestGap и
   * G.peerOnly, exports для резолва `@sf/<пакет>[/<подпуть>]` в обходе int-наборов (intModule).
   * Читаются один раз за прогон, в снимке liveSnap.
   */
  function dryManifests(dry) {
    const ws = {};
    for (const [name, dir] of G.dryPackages(dry)) ws[name] = { dir, pkg: readJson(path.join(ROOT, dir, 'package.json')) };
    return ws;
  }

  /**
   * Чтения графа гейта, который гоняет turbo run <script>: входы каждого узла taskGraph,
   * globalCacheInputs (без HASHED_NOT_READ) и extra ([{ file, why }] сверх графа) - outsideGlob
   * по пробе гейта runs. Возвращает { graph, outside }.
   */
  function graphOutside(runs, dry, script, extra) {
    const graph = G.taskGraph(dry, script);
    const reads = graph.nodes.flatMap((n) => n.reads).concat(G.globalReads(dry).reads, extra);
    return { graph, outside: G.outsideGlob(runs, reads) };
  }

  /**
   * Стаб-файлы под glob гейта: детектор на них не построить, и «проба не замечает» свалило бы вину
   * на пробу. Сверяются все файлы стабов модуля (G.STUB_FILES: стаб-пакет, его turbo.json, пакет
   * стаб-шаблона, глобальный вход) и extra (файлы стаба пробы сверх модуля). Строка отказа с именем
   * STUB_DIR и файлами под glob или null. runs - проба гейта.
   */
  function stubUnderGlob(runs, gateId, extra) {
    const under = G.STUB_FILES.concat(extra || []).filter((f) => runs(f));
    return under.length ? 'стаб-каталог ' + G.STUB_DIR + ' под glob ' + gateId + ' (' + under.join(', ') + ') - детектор не построить, смени STUB_DIR в selftest-stub.js' : null;
  }

  /**
   * Детектор разницы графа с манифестами (G.manifestGap) не слепой: граф script без рёбер к
   * некорневому узлу graph (G.stubCut) обязан назвать его пакет. Узел для среза - первый некорневой,
   * чей пакет в замыкании workspace:-зависимостей манифестов от корней (G.manifestClosure): узел,
   * пришедший явным `dependsOn "@sf/x#build"` без манифеста, разницы с манифестами не даёт, и срез
   * его давал бы ложное «проба не замечает» (TECH_DEBT 21.10.2026 E0-12L круг 3, `manifestGapBlind`). Таких узлов нет - детектор не
   * построить, это отказ, а не пропуск. Строка отказа или null.
   */
  function manifestGapBlind(dry, script, graph, ws) {
    const closure = G.manifestClosure(graph, ws);
    const cut = graph.nodes.find((n) => !n.root && closure.has(n.pkg));
    if (!cut) return 'у графа turbo run ' + script + ' нет узлов кроме корней из замыкания манифестов - детектор разницы с манифестами не построить';
    if (G.manifestGap(G.taskGraph(G.stubCut(dry, cut.name), script), ws).includes(cut.pkg)) return null;
    return 'проба не замечает граф без ' + cut.name + ' (стаб без рёбер к узлу): ' + cut.pkg + ' не назван разницей с манифестами';
  }

  /**
   * Детектор G.inputsGap не слепой: граф без одного файла пакета во входах первого узла, у которого
   * такой вход есть и он среди tracked (G.stubWithoutInput), обязан назвать этот файл. «Файл пакета» -
   * тот же отбор G.ownFiles, что у inputsGap: под каталогом узла (каталог `.` корневой задачи - весь
   * корень), не во вложенном пакете, не в TRACKED_NOT_HASHED - срез файла, который inputsGap не
   * считает, дал бы ложное «проба не замечает». Вход только из tracked: turbo хеширует и
   * неотслеживаемые файлы, а inputsGap сверяет лишь tracked - срез нового `??`-файла дал бы то же
   * ложное «проба не замечает». Строка отказа или null.
   */
  function inputsGapBlind(dry, script, graph, tracked) {
    const seen = new Set(tracked);
    const dirs = Array.from(G.dryPackages(dry).values());
    const own = (n) => G.ownFiles(n, n.reads.map((r) => r.file), dirs).filter((f) => seen.has(f));
    const node = graph.nodes.find((n) => own(n).length);
    if (!node) return 'у графа turbo run ' + script + ' ни у одного узла нет отслеживаемого входа своего пакета - детектор входов не построить';
    const file = own(node)[0];
    const stub = G.stubWithoutInput(dry, node.name, file);
    if (G.inputsGap(G.taskGraph(stub, script), tracked, stub).includes(node.name + ': ' + file)) return null;
    return 'проба не замечает вход ' + file + ', снятый у ' + node.name + ' (стаб без входа)';
  }

  /**
   * Проба графа гейта, который гоняет turbo run <script> (extra-строка checkGateSelection с
   * graph): каждый файл, который хеширует задача графа (узлы - замыкание от корней),
   * globalCacheInputs и чтения opts.liveExtra() (сверх графа, на настоящем дереве) обязаны
   * выбирать гейт; граф не уже манифестов (G.manifestGap). Детекторы не слепые: стаб-узел в
   * STUB_DIR (G.stubNode) обязан дать отказ со своим package.json, стаб глобального входа - со
   * своим файлом, граф без рёбер к узлу из замыкания манифестов (G.stubCut) - разницу с манифестами
   * с его пакетом; при opts.extraStub - и стаб opts.extraStub(dry, ws) ({ dry, reads, expect, files }):
   * его expect обязан попасть в отказ. Стаб-каталог под glob - первым: это условие детекторов, и
   * проба стаб-каталога не гоняет весь граф ради него. opts.label - кто читает, с глаголом.
   */
  function checkTurboGraph(script, opts) {
    return ({ gate, runs }) => {
      const { dry, ws, tracked } = GRAPH_GATE.snap;
      const s = opts.extraStub ? opts.extraStub(dry, ws) : null;
      const under = stubUnderGlob(runs, gate.id, s ? s.files : []);
      if (under) return under;
      const extra = opts.liveExtra ? opts.liveExtra() : [];
      const real = graphOutside(runs, dry, script, extra);
      if (real.outside.length) return G.refusal(opts.label, gate.id, real.outside);
      const gap = G.manifestGap(real.graph, ws);
      if (gap.length) {
        return 'граф turbo run ' + script + ' уже манифестов: ' + gap.join(', ') + ' (workspace:-зависимости корней вне графа) - проверь dependsOn задачи ' + script + ' в turbo.json';
      }
      const unhashed = G.inputsGap(real.graph, tracked, dry);
      if (unhashed.length) {
        return 'входы графа turbo run ' + script + ' не покрывают файлы пакетов, видимые git: ' + unhashed.join('; ') + ' - inputs в turbo.json без $TURBO_DEFAULT$?';
      }
      const inputsBlind = inputsGapBlind(dry, script, real.graph, tracked);
      if (inputsBlind) return inputsBlind;
      const want = G.STUB_DIR + '/package.json ';
      const stub = graphOutside(runs, G.stubNode(dry, script, { inputs: { 'package.json': 'stub' } }), script, extra);
      if (!stub.outside.some((b) => b.startsWith(want))) return 'проба не замечает узел ' + G.STUB_DIR + ' вне glob ' + gate.id + ' на стабе';
      // globalCacheInputs сверяются наравне со входами задач: посторонний глобальный вход - отказ
      if (!graphOutside(runs, G.stubGlobal(dry), script, extra).outside.some((b) => b.startsWith(G.STUB_GLOBAL + ' '))) {
        return 'проба не замечает глобальный вход ' + G.STUB_GLOBAL + ' вне glob ' + gate.id + ' на стабе';
      }
      const gapBlind = manifestGapBlind(dry, script, real.graph, ws);
      if (gapBlind) return gapBlind;
      if (s && !graphOutside(runs, s.dry, script, s.reads).outside.some((b) => b.startsWith(s.expect + ' '))) {
        return 'проба не замечает ' + s.expect + ' вне glob ' + gate.id + ' на стабе чтений сверх графа';
      }
      const files = real.graph.nodes.reduce((n, x) => n + x.reads.length, 0);
      const skipped = G.globalReads(dry).skipped.map((r) => r.file);
      return {
        note: script + ': корни ' + real.graph.roots.map((r) => r.name).join(', ') + '; узлов ' + real.graph.nodes.length + ', файлов ' + files +
          (extra.length ? ' и ' + extra.length + ' чтений сверх графа' : '') + (skipped.length ? '; не сверяются (HASHED_NOT_READ): ' + skipped.join(', ') : ''),
      };
    };
  }

  /**
   * Стаб-каталог под glob гейта (строка пробы графа): gateProbe - проба выбора гейта
   * (selftest-gates.js), intRun - int-проба прогона (selftest-int-cases.js: intGuard, стаб int-пробы,
   * опции графа test:int).
   */
  function checkStubDirCase(gateProbe, intRun) {
    const { intGuard, intProbeStubBase, INT_GRAPH_OPTS } = intRun;
    // Стаб-каталог под glob гейта - отказ с именем STUB_DIR, а не «проба не замечает» (вина не
    // на пробе): проба графа на glob, который выбирает всё, на glob, который выбирает только
    // глобальный стаб-вход, и на glob test:int, который выбирает setup int-стаба.
    const name = 'граф turbo: стаб-каталог под glob гейта - отказ с именем STUB_DIR';
    check(name, intGuard(name, () => {
      const gate = { id: 'build-all' };
      const fileUnder = (files) => 'стаб-каталог ' + G.STUB_DIR + ' под glob build-all (' + files.join(', ') + ') - детектор не построить, смени STUB_DIR в selftest-stub.js';
      const all = checkTurboGraph('build', { label: 'сборка читает' })({ gate, runs: () => true });
      if (all !== fileUnder(G.STUB_FILES)) return 'glob на всё: ожидалось «' + fileUnder(G.STUB_FILES) + '», получено ' + JSON.stringify(all);
      const runs = (f) => f === G.STUB_GLOBAL || gateProbe('build').runs(f);
      const global = checkTurboGraph('build', { label: 'сборка читает' })({ gate, runs });
      if (global !== fileUnder([G.STUB_GLOBAL])) return 'glob со STUB_GLOBAL: ожидалось «' + fileUnder([G.STUB_GLOBAL]) + '», получено ' + JSON.stringify(global);
      const setup = intProbeStubBase().expect;
      const intRuns = (f) => f === setup || gateProbe('test:int').runs(f);
      const int = checkTurboGraph('test:int', INT_GRAPH_OPTS)({ gate, runs: intRuns });
      return int === fileUnder([setup]) || 'glob test:int с setup int-стаба: ожидалось «' + fileUnder([setup]) + '», получено ' + JSON.stringify(int);
    }));
  }

  /** Последняя строка графа (GRAPH_GATE): после всех проб, которые его читают. */
  function checkLiveLine() {
    // Последняя строка графа: отказ снимка (dry-JSON, манифесты, шаблоны workspace, tracked - git ls-files
    // с файлами на диске; сбой git ls-files или stat файла - тоже здесь) называется здесь один раз,
    // с перечнем проб графа, которые без него не гонялись (snapshotGate).
    check('граф turbo: dry-JSON настоящего дерева (turbo run ' + GRAPH_SCRIPTS.join(' ') + ' --dry=json)', () => graphVerdict(GRAPH_GATE));
  }

  return {
    graphVerdict, takeLive, withTempRoot, trackedFiles, stubUnderGlob, manifestGapBlind, inputsGapBlind, checkTurboGraph,
    checkStubDirCase, checkLiveLine,
  };
}

module.exports = { createTreeGraph };
