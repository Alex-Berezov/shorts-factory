'use strict';
/**
 * selftest-graph-cases.js - синтетические кейсы машинерии графа turbo (E0-12U: раздел гейтов
 * harness-selftest.js по заботам): модулей графа selftest-turbo.js, selftest-graph.js и
 * selftest-stub.js и помощников пробы графа настоящего дерева (selftest-tree-graph.js: строка снимка,
 * детекторы манифестов и входов, trackedFiles; selftest-roots.js: текст отказа корней; relUnder
 * int-пробы - предикат «путь под каталогом» модуля графа). Одна забота - ветки отказа графа на
 * синтетическом dry и подменённом результате spawn, без turbo: каждый кейс ждёт точный текст отказа,
 * и ветка, заменённая на пропуск, краснит свой кейс (E0-12L, L-020). Не хук: модуль самопроверки.
 *
 * registerGraphCases(ctx, gates) зовёт selftest-gates.js в прежней точке прогона и только при
 * загруженном модуле графа (G); gates - эти помощники и снимок графа настоящего дерева GRAPH_GATE.
 */

const fs = require('fs');
const path = require('path');

function registerGraphCases(ctx, gates) {
  const {
    G, LISTING_MAX_BUFFER, ROOT, SKIPPED, check, refusalVerdict, refusedCheck, results, run, snapshotGate,
  } = ctx;
  const {
    GRAPH_GATE, graphVerdict, inputsGapBlind, manifestGapBlind, relUnder, rootsRefusal, trackedFiles,
    withTempRoot,
  } = gates;

  const refusedWith = (name, fn, want) => refusedCheck('граф turbo: ' + name, fn, want);
  // ослабленная команда стаба склеена из частей: модуль вне weakeningExempt (rules.common.json), и
  // замок коммита (W02) ловит в нём только настоящее ослабление
  const WEAK_BUILD = 'next build |' + '| true';
  const what = 'turbo run build --dry=json';
  // стаб-корень: обёртка turbo и бинари двух платформ (linux-64 без расширения, windows-64 - .exe)
  const FIXTURE = {
    'node_modules/turbo/package.json': '{"name":"turbo"}',
    'node_modules/@turbo/linux-64/package.json': '{"name":"@turbo/linux-64"}',
    'node_modules/@turbo/linux-64/bin/turbo': '',
    'node_modules/@turbo/windows-64/package.json': '{"name":"@turbo/windows-64"}',
    'node_modules/@turbo/windows-64/bin/turbo.exe': '',
  };
  const onFixture = (opts) => withTempRoot(FIXTURE, (root) => G.turboDry(['build'], Object.assign({ root, platform: 'linux', arch: 'x64' }, opts)));
  const spawned = (result) => () => onFixture({ spawn: () => result });
  // dry-JSON, который разбирается: ветка кода/сигнала, снятая целиком, даёт «отказа нет», а не
  // отказ соседней ветки (L-020)
  const EMPTY_DRY = '{"tasks":[],"globalCacheInputs":{"files":{}}}';
  refusedWith('нет пакета turbo - отказ «сначала pnpm install»', () => withTempRoot({}, (root) => G.turboDry(['build'], { root, platform: 'linux', arch: 'x64' })),
    what + ': нет turbo - сначала pnpm install');
  refusedWith('нет пакета платформы - отказ с его именем', () => withTempRoot({ 'node_modules/turbo/package.json': '{"name":"turbo"}' }, (root) => G.turboDry(['build'], { root, platform: 'win32', arch: 'x64' })),
    what + ': нет @turbo/windows-64 - сначала pnpm install');
  // require.resolve поднимается по предкам корня: turbo из node_modules каталога выше корня
  // (глобальный, соседний клон) - чужой, отказ «нет turbo», как и без пакета
  const onRepoBelow = (files) => withTempRoot(Object.assign({ 'repo/package.json': '{}' }, files), (dir) => G.turboDry(['build'], {
    root: path.join(dir, 'repo'), platform: 'linux', arch: 'x64', spawn: () => ({ pid: 4242, status: 0, signal: null, stdout: EMPTY_DRY, stderr: '' }),
  }));
  refusedWith('turbo только в node_modules выше корня - отказ «нет turbo»', () => onRepoBelow(FIXTURE), what + ': нет turbo - сначала pnpm install');
  refusedWith('пакет платформы только в node_modules выше корня - отказ с его именем', () => onRepoBelow({
    'repo/node_modules/turbo/package.json': '{"name":"turbo"}',
    'node_modules/@turbo/linux-64/package.json': '{"name":"@turbo/linux-64"}',
    'node_modules/@turbo/linux-64/bin/turbo': '',
  }), what + ': нет @turbo/linux-64 - сначала pnpm install');
  // underNodeModules: иная ошибка realpath, чем ENOENT, - не «сначала pnpm install», а причина с кодом
  check('граф turbo: underNodeModules - ошибка realpath node_modules не ENOENT (EACCES) пробрасывается с кодом', () => {
    const denied = (p) => {
      throw Object.assign(new Error('EACCES: permission denied, realpath ' + JSON.stringify(path.basename(p))), { code: 'EACCES' });
    };
    try {
      G.underNodeModules(path.join(ROOT, 'node_modules', 'turbo', 'package.json'), ROOT, { realpath: denied });
    } catch (e) {
      const got = (e && e.code) + ': ' + ((e && e.message) || String(e));
      const want = 'EACCES: EACCES: permission denied, realpath "node_modules"';
      return got === want || 'ожидалось «' + want + '», получено «' + got + '»';
    }
    return 'исключения нет, ожидалось EACCES';
  });
  // node_modules корня - ссылка на каталог (junction на Windows): путь модуля и через ссылку, и
  // реальный - под node_modules корня; без realpath одного из концов путь «вне» и отказ ложный
  check('граф turbo: underNodeModules - node_modules корня ссылкой на каталог, путь модуля через ссылку и реальный - под ним', () => withTempRoot({
    'store/turbo/package.json': '{"name":"turbo"}',
    'repo/package.json': '{}',
  }, (dir) => {
    const repo = path.join(dir, 'repo');
    fs.symlinkSync(path.join(dir, 'store'), path.join(repo, 'node_modules'), 'junction');
    const got = JSON.stringify([
      G.underNodeModules(path.join(repo, 'node_modules', 'turbo', 'package.json'), repo),
      G.underNodeModules(path.join(dir, 'store', 'turbo', 'package.json'), repo),
    ]);
    return got === JSON.stringify([true, true]) || 'ожидалось [true,true] (через ссылку, реальный), получено ' + got;
  }));
  // законный pnpm virtual-store-dir вне корня (TECH_DEBT 21.10.2026 E0-12L круг 4, `underNodeModules`): модуль под virtualStoreDir из
  // node_modules/.modules.yaml - под корнем; модуль в постороннем каталоге - нет; .modules.yaml,
  // который не разбирается, - отказ, а не молча «нет»
  check('граф turbo: underNodeModules - модуль под virtualStoreDir из .modules.yaml вне корня - под ним, посторонний каталог - нет', () => withTempRoot({
    'repo/node_modules/.keep': '',
    'store/.pnpm/turbo/package.json': '{"name":"turbo"}',
    'other/turbo/package.json': '{"name":"turbo"}',
  }, (dir) => {
    const repo = path.join(dir, 'repo');
    const yaml = 'virtualStoreDir: ' + JSON.stringify(path.join(dir, 'store', '.pnpm')) + '\n';
    // yaml - пакет репозитория: во временном корне его нет
    const parseYaml = require(require.resolve('yaml', { paths: [ROOT] })).parse;
    const at = (rel) => G.underNodeModules(path.join(dir, ...rel.split('/')), repo, { modulesYaml: yaml, parseYaml });
    const got = JSON.stringify([at('store/.pnpm/turbo/package.json'), at('other/turbo/package.json'), G.underNodeModules(path.join(dir, 'store', '.pnpm', 'turbo', 'package.json'), repo, { modulesYaml: null })]);
    if (got !== JSON.stringify([true, false, false])) return 'ожидалось [true,false,false] (хранилище, посторонний, без .modules.yaml), получено ' + got;
    return refusalVerdict(() => G.underNodeModules(path.join(dir, 'other', 'turbo', 'package.json'), repo, { modulesYaml: 'storeDir: x\n', parseYaml }), 'в node_modules/.modules.yaml нет строки virtualStoreDir');
  }));
  refusedWith('платформа без пакета turbo - отказ', () => onFixture({ platform: 'freebsd', arch: 'ia32' }),
    what + ': нет пакета turbo для платформы freebsd-ia32 (пакеты @turbo/<os>-<arch>: windows, darwin, linux x 64, arm64)');
  refusedWith('turbo не запустился - отказ с ошибкой запуска', spawned({ error: new Error('spawn EACCES'), pid: 0 }), what + ' не запустился: spawn EACCES');
  refusedWith('turbo прерван после запуска (ENOBUFS) - отказ «прерван», не «не запустился»',
    spawned({ error: Object.assign(new Error('spawnSync turbo ENOBUFS'), { code: 'ENOBUFS' }), pid: 4242, status: null, signal: 'SIGKILL', stdout: '', stderr: '' }),
    what + ': прерван после запуска: spawnSync turbo ENOBUFS');
  refusedWith('turbo не ответил за предел - отказ с пределом', spawned({ error: Object.assign(new Error('spawnSync turbo ETIMEDOUT'), { code: 'ETIMEDOUT' }), pid: 4242, status: null, signal: 'SIGKILL', stdout: '', stderr: '' }),
    what + ': не ответил за ' + G.TURBO_TIMEOUT_MS / 1000 + ' с - процесс убит');
  refusedWith('turbo вышел с кодом 1 - отказ с кодом и stderr', spawned({ pid: 4242, status: 1, signal: null, stdout: EMPTY_DRY, stderr: 'x  Missing tasks in project\n' }), what + ': код 1: x  Missing tasks in project');
  refusedWith('turbo убит сигналом - отказ с именем сигнала', spawned({ pid: 4242, status: null, signal: 'SIGTERM', stdout: EMPTY_DRY, stderr: '' }), what + ': сигнал SIGTERM: stderr пуст');
  const notJson = '• turbo 2.10.12';
  let parseError = '';
  try {
    JSON.parse(notJson);
  } catch (e) {
    parseError = e.message;
  }
  refusedWith('stdout turbo не JSON - отказ с причиной разбора', spawned({ pid: 4242, status: 0, signal: null, stdout: notJson, stderr: '' }), what + ': stdout не JSON (' + parseError + '): "• turbo 2.10.12"');
  refusedWith('в dry-JSON нет tasks - отказ', spawned({ pid: 4242, status: 0, signal: null, stdout: '{"packages":[]}', stderr: '' }), what + ': в выводе нет массива tasks - форма dry-JSON turbo неизвестна');
  // что получает spawn: бинарь платформы (не обёртка bin/turbo через node), аргументы, предел,
  // сигнал предела и окружение без TURBO_* оболочки
  const spawnSeen = (platform) => withTempRoot(FIXTURE, (root) => {
    let seen = null;
    const had = Object.prototype.hasOwnProperty.call(process.env, 'TURBO_FORCE');
    const prev = process.env.TURBO_FORCE;
    process.env.TURBO_FORCE = '1';
    try {
      G.turboDry(['build'], { root, platform, arch: 'x64', spawn: (cmd, args, opts) => { seen = { cmd, args, opts }; return { pid: 4242, status: 0, signal: null, stdout: EMPTY_DRY, stderr: '' }; } });
    } finally {
      if (had) process.env.TURBO_FORCE = prev;
      else delete process.env.TURBO_FORCE;
    }
    const bins = { linux: 'node_modules/@turbo/linux-64/bin/turbo', win32: 'node_modules/@turbo/windows-64/bin/turbo.exe' };
    return { seen, bin: fs.realpathSync(path.join(root, bins[platform])) };
  });
  for (const platform of ['linux', 'win32']) {
    check('граф turbo: ' + platform + ' - spawn зовёт бинарь пакета платформы напрямую', () => {
      const { seen, bin } = spawnSeen(platform);
      if (!seen) return 'spawn не вызван';
      if (seen.cmd !== bin) return 'spawn зовёт ' + seen.cmd + ', ожидался бинарь ' + bin;
      return JSON.stringify(seen.args) === JSON.stringify(['run', 'build', '--dry=json']) || 'аргументы spawn: ' + JSON.stringify(seen.args);
    });
  }
  check('граф turbo: turbo зовётся с пределом TURBO_TIMEOUT_MS', () => {
    const { seen } = spawnSeen('linux');
    return seen.opts.timeout === G.TURBO_TIMEOUT_MS || 'предел spawn: ' + seen.opts.timeout + ', ожидался ' + G.TURBO_TIMEOUT_MS;
  });
  check('граф turbo: по пределу turbo убивается SIGKILL', () => {
    const { seen } = spawnSeen('linux');
    return seen.opts.killSignal === 'SIGKILL' || 'сигнал предела spawn: ' + seen.opts.killSignal + ', ожидался SIGKILL';
  });
  check('граф turbo: turbo зовётся без TURBO_* оболочки, с выключенной телеметрией', () => {
    const { seen } = spawnSeen('linux');
    const leaked = Object.keys(seen.opts.env || {}).filter((k) => /^TURBO_/i.test(k) && k !== 'TURBO_TELEMETRY_DISABLED');
    if (leaked.length) return 'в окружение turbo ушли ' + leaked.join(', ');
    return seen.opts.env.TURBO_TELEMETRY_DISABLED === '1' || 'телеметрия turbo не выключена';
  });
  check('граф turbo: turboEnv снимает TURBO_* в любом регистре и выключает телеметрию, исходное окружение не правит', () => {
    const env = { PATH: 'p', TURBO_FORCE: '1', turbo_env_mode: 'loose', TURBO_TELEMETRY_DISABLED: '0' };
    const got = JSON.stringify(G.turboEnv(env));
    const want = JSON.stringify({ PATH: 'p', TURBO_TELEMETRY_DISABLED: '1' });
    if (env.TURBO_FORCE !== '1') return 'turboEnv правит исходное окружение';
    return got === want || 'ожидалось ' + want + ', получено ' + got;
  });

  // dry из двух пакетов и постороннего: a#build (next build) зависит от b#build, c#build вне графа
  const task = (id, extra) => Object.assign({
    taskId: id,
    directory: 'packages\\' + id.slice(4, id.indexOf('#')),
    command: G.NONEXISTENT,
    dependencies: [],
    inputs: { 'src/index.ts': 'h' },
    resolvedTaskDefinition: { inputs: [] },
  }, extra);
  const sample = () => ({
    globalCacheInputs: { files: { 'tsconfig.base.json': 'h', '.gitattributes': 'h' } },
    tasks: [
      task('@sf/a#build', { command: 'next build', dependencies: ['@sf/b#build'], inputs: { 'src/page.tsx': 'h', '../../vitest.preset.ts': 'h' } }),
      task('@sf/b#build'),
      task('@sf/c#build'),
    ],
  });
  const withTask = (id, patch) => {
    const dry = sample();
    dry.tasks = dry.tasks.map((t) => (t.taskId === id ? patch(Object.assign({}, t)) : t));
    return dry;
  };
  const withInput = (input) => G.taskGraph(withTask('@sf/b#build', (t) => Object.assign(t, { inputs: { [input]: 'h' } })), 'build');
  check('граф turbo: граф - замыкание dependencies от корней, посторонний пакет вне графа, входы от корня', () => {
    const g = G.taskGraph(sample(), 'build');
    const got = JSON.stringify(g.nodes.map((n) => [n.name, n.pkg, n.root, n.reads.map((r) => r.file + ' (' + r.why + ')')]));
    const want = JSON.stringify([
      ['@sf/a#build', '@sf/a', true, ['packages/a/src/page.tsx (корень @sf/a#build)', 'vitest.preset.ts (корень @sf/a#build)']],
      ['@sf/b#build', '@sf/b', false, ['packages/b/src/index.ts (узел @sf/b#build графа @sf/a#build)']],
    ]);
    return got === want || 'ожидалось ' + want + ', получено ' + got;
  });
  refusedWith('зависимость вне dry-JSON - отказ', () => G.taskGraph(withTask('@sf/b#build', (t) => Object.assign(t, { dependencies: ['@sf/x#build'] })), 'build'),
    'зависимость @sf/x#build задачи @sf/b#build вне dry-JSON - граф неполон');
  refusedWith('вход вне корня репозитория - отказ', () => withInput('../../../x.ts'), 'вход ../../../x.ts задачи @sf/b#build вне корня репозитория');
  refusedWith('вход ровно в родителя корня (..) - отказ', () => withInput('../../..'), 'вход ../../.. задачи @sf/b#build вне корня репозитория');
  refusedWith('абсолютный вход задачи пакета - отказ', () => withInput('/etc/x'), 'вход /etc/x задачи @sf/b#build - абсолютный путь, вне корня репозитория');
  refusedWith('вход с буквой диска - отказ', () => withInput('C:\\x.ts'), 'вход C:\\x.ts задачи @sf/b#build - абсолютный путь, вне корня репозитория');
  refusedWith('вход с буквой диска и прямым слешем - отказ', () => withInput('C:/x.ts'), 'вход C:/x.ts задачи @sf/b#build - абсолютный путь, вне корня репозитория');
  // имя файла с двоеточием - не буква диска там, где такое имя возможно (TECH_DEBT 21.10.2026
  // E0-12L круг 4, `inRoot`); на Windows имени с двоеточием нет, и `C:x.ts` - путь от текущего
  // каталога диска C, вне репозитория
  check('граф turbo: inRoot - вход a:b.json не на Windows - законное имя файла пакета, не абсолютный путь', () => {
    const got = G.inRoot('packages/b', 'a:b.json', '@sf/b#build', 'linux');
    return got === 'packages/b/a:b.json' || 'вход a:b.json на linux: ' + JSON.stringify(got);
  });
  check('граф turbo: inRoot - на Windows буква диска без слеша (C:x.ts, a:b.json) - отказ', () => {
    const bad = ['C:x.ts', 'a:b.json'].map((x) => refusalVerdict(() => G.inRoot('packages/b', x, '@sf/b#build', 'win32'),
      'вход ' + x + ' задачи @sf/b#build - абсолютный путь, вне корня репозитория')).filter((v) => v !== true);
    return !bad.length || bad.join('; ');
  });
  refusedWith('globalCacheInputs вне корня - отказ', () => G.globalReads({ tasks: [], globalCacheInputs: { files: { '../x.json': 'h' } } }),
    'вход ../x.json задачи globalCacheInputs вне корня репозитория');
  for (const field of ['directory', 'command', 'dependencies', 'inputs']) {
    refusedWith('у задачи нет ' + field + ' - отказ', () => G.taskGraph(withTask('@sf/c#build', (t) => { delete t[field]; return t; }), 'build'),
      'у задачи @sf/c#build нет ' + field + ' - форма dry-JSON turbo неизвестна');
  }
  refusedWith('у задачи нет resolvedTaskDefinition - отказ', () => G.taskGraph(withTask('@sf/c#build', (t) => { delete t.resolvedTaskDefinition; return t; }), 'build'),
    'у задачи @sf/c#build нет resolvedTaskDefinition.inputs - форма dry-JSON turbo неизвестна');
  refusedWith('resolvedTaskDefinition без inputs - отказ', () => G.taskGraph(withTask('@sf/c#build', (t) => Object.assign(t, { resolvedTaskDefinition: { cache: true } })), 'build'),
    'у задачи @sf/c#build нет resolvedTaskDefinition.inputs - форма dry-JSON turbo неизвестна');
  refusedWith('dependencies не массив строк - отказ', () => G.taskGraph(withTask('@sf/c#build', (t) => Object.assign(t, { dependencies: [1] })), 'build'),
    'у задачи @sf/c#build нет dependencies - форма dry-JSON turbo неизвестна');
  refusedWith('inputs - массив, а не объект - отказ', () => G.taskGraph(withTask('@sf/c#build', (t) => Object.assign(t, { inputs: ['src/index.ts'] })), 'build'),
    'у задачи @sf/c#build нет inputs - форма dry-JSON turbo неизвестна');
  refusedWith('задача без taskId - отказ', () => G.taskGraph(withTask('@sf/c#build', (t) => { delete t.taskId; return t; }), 'build'),
    'задача dry-JSON без taskId - форма dry-JSON turbo неизвестна');
  refusedWith('нет корней - отказ', () => G.taskGraph(withTask('@sf/a#build', (t) => Object.assign(t, { command: G.NONEXISTENT })), 'build'),
    'в dry-JSON нет задачи build с командой - ни у одного пакета нет scripts.build');
  // В2: inputs узла графа в turbo.json - ровно DECLARED_INPUTS его скрипта
  refusedWith('inputs узла графа сужены в turbo.json (src/**) - отказ с taskId и перечнем',
    () => G.taskGraph(G.stubNode(sample(), 'build', { resolvedTaskDefinition: { inputs: ['src/**'] } }), 'build'),
    'inputs задачи ' + G.stubTaskId('build') + ' в turbo.json: ["src/**"], ожидалось [] (DECLARED_INPUTS: build без inputs: turbo хеширует все файлы пакета, видимые git, - их и читает next build)');
  refusedWith('inputs test:int - $TURBO_ROOT$ разрешён от каталога задачи, иное - отказ',
    () => G.taskGraph(withTask('@sf/a#build', (t) => Object.assign(t, { taskId: '@sf/a#test:int', command: 'vitest run', dependencies: [], resolvedTaskDefinition: { inputs: ['../vitest.preset.ts'] } })), 'test:int'),
    'inputs задачи @sf/a#test:int в turbo.json: ["../vitest.preset.ts"], ожидалось ["../../vitest.preset.ts"] (DECLARED_INPUTS: файлы пакета и корневой vitest.preset.ts, который вызывает каждый vitest.int.config.ts (ADR-0011))');
  refusedWith('скрипт узла без ожидания inputs - отказ', () => G.taskGraph(withTask('@sf/a#build', (t) => Object.assign(t, { taskId: '@sf/a#lint', dependencies: [] })), 'lint'),
    'у задачи @sf/a#lint нет ожидания inputs в DECLARED_INPUTS selftest-graph.js');
  // inputsGap на графе со скриптом без ожидания - отказ с именем, а не TypeError (TECH_DEBT 21.10.2026 E0-12L круг 3, `inputsGap`)
  refusedWith('inputsGap: узел скрипта без ожидания в DECLARED_INPUTS - отказ с именем задачи',
    () => G.inputsGap({ roots: [], nodes: [{ name: '@sf/a#lint', pkg: '@sf/a', dir: 'packages/a', reads: [] }] }, ['packages/a/x.ts'], sample()),
    'у задачи @sf/a#lint нет ожидания inputs в DECLARED_INPUTS selftest-graph.js');
  // EXTRA_INPUTS (TECH_DEBT 21.10.2026 E0-12L круг 4, `checkDeclaredInputs`): законное расширение inputs одной задачи проходит, тот же вход
  // у соседней задачи - отказ; боевой перечень - объект с причиной на каждую задачу
  check('граф turbo: EXTRA_INPUTS - расширение inputs одной задачи проходит, тот же вход у соседа краснеет', () => {
    if (!G.EXTRA_INPUTS || typeof G.EXTRA_INPUTS !== 'object') return 'selftest-graph.js не экспортирует EXTRA_INPUTS';
    const noWhy = Object.entries(G.EXTRA_INPUTS).filter(([, x]) => !x || !Array.isArray(x.inputs) || typeof x.why !== 'string' || !x.why).map(([id]) => id);
    if (noWhy.length) return 'EXTRA_INPUTS без inputs или причины: ' + noWhy.join(', ');
    const extraInputs = { '@sf/a#build': { inputs: ['x.json'], why: 'кейс' } };
    const widened = (id) => withTask(id, (t) => Object.assign(t, { resolvedTaskDefinition: { inputs: ['x.json'] } }));
    try {
      G.taskGraph(widened('@sf/a#build'), 'build', { extraInputs });
    } catch (e) {
      return 'расширение своей задачи отвергнуто: ' + e.message;
    }
    // тот же вход и у своей задачи, и у соседа: свою пропускает расширение, соседа - нет
    const both = widened('@sf/b#build');
    both.tasks = both.tasks.map((t) => (t.taskId === '@sf/a#build' ? Object.assign({}, t, { resolvedTaskDefinition: { inputs: ['x.json'] } }) : t));
    return refusalVerdict(() => G.taskGraph(both, 'build', { extraInputs }),
      'inputs задачи @sf/b#build в turbo.json: ["x.json"], ожидалось [] (DECLARED_INPUTS: build без inputs: turbo хеширует все файлы пакета, видимые git, - их и читает next build)');
  });
  // В1: граф turbo не уже манифестов (workspace:-зависимости от корней)
  const manifests = (deps) => Object.fromEntries(Object.entries(deps).map(([name, d]) => [name, { dir: 'packages/' + name.slice(4), pkg: { name, dependencies: d.dependencies, devDependencies: d.devDependencies } }]));
  check('граф turbo: manifestGap - workspace:-зависимости корней (и dev), которых нет в графе, по алфавиту', () => {
    const ws = manifests({
      '@sf/a': { dependencies: { '@sf/b': 'workspace:*', zod: '3.0.0' }, devDependencies: { '@sf/d': 'workspace:^' } },
      '@sf/b': { dependencies: { '@sf/c': 'workspace:*' } },
      '@sf/c': {},
      '@sf/d': {},
    });
    const got = JSON.stringify([G.manifestGap(G.taskGraph(sample(), 'build'), ws), G.manifestGap(G.taskGraph(G.stubCut(sample(), '@sf/b#build'), 'build'), ws)]);
    const want = JSON.stringify([['@sf/c', '@sf/d'], ['@sf/b', '@sf/c', '@sf/d']]);
    return got === want || 'ожидалось ' + want + ', получено ' + got;
  });
  // turbo 2.10.12 строит ребро по optionalDependencies и не строит по peerDependencies (замер dry-JSON)
  check('граф turbo: manifestGap - workspace:-пакет только в optionalDependencies без ребра краснеет с именем, только в peerDependencies - нет', () => {
    const cut = G.taskGraph(G.stubCut(sample(), '@sf/b#build'), 'build');
    const only = (field) => ({
      '@sf/a': { dir: 'packages/a', pkg: { name: '@sf/a', [field]: { '@sf/b': 'workspace:*' } } },
      '@sf/b': { dir: 'packages/b', pkg: { name: '@sf/b' } },
    });
    const got = JSON.stringify([G.manifestGap(cut, only('optionalDependencies')), G.manifestGap(cut, only('peerDependencies'))]);
    const want = JSON.stringify([['@sf/b'], []]);
    return got === want || 'ожидалось ' + want + ' (optional, peer), получено ' + got;
  });
  check('граф turbo: детектор разницы с манифестами - на графе из одних корней отказ, на графе с узлом молчит', () => {
    const ws = manifests({ '@sf/a': { dependencies: { '@sf/b': 'workspace:*' } }, '@sf/b': {} });
    const lone = withTask('@sf/a#build', (t) => Object.assign(t, { dependencies: [] }));
    const got = manifestGapBlind(lone, 'build', G.taskGraph(lone, 'build'), ws);
    const want = 'у графа turbo run build нет узлов кроме корней из замыкания манифестов - детектор разницы с манифестами не построить';
    if (got !== want) return 'ожидалось «' + want + '», получено ' + JSON.stringify(got);
    const ok2 = manifestGapBlind(sample(), 'build', G.taskGraph(sample(), 'build'), ws);
    return ok2 === null || 'на графе с узлом: ' + JSON.stringify(ok2);
  });
  // первый некорневой узел пришёл явным dependsOn "@sf/x#build" без манифеста: срез идёт по узлу
  // из замыкания манифестов, ложного «проба не замечает» нет (TECH_DEBT 21.10.2026 E0-12L круг 3, `manifestGapBlind`)
  check('граф turbo: детектор разницы с манифестами - узел явного dependsOn вне манифестов не берётся для среза', () => {
    const dry = sample();
    dry.tasks = dry.tasks.map((t) => (t.taskId === '@sf/a#build' ? Object.assign({}, t, { dependencies: ['@sf/c#build', '@sf/b#build'] }) : t));
    const ws = manifests({ '@sf/a': { dependencies: { '@sf/b': 'workspace:*' } }, '@sf/b': {}, '@sf/c': {} });
    const graph = G.taskGraph(dry, 'build');
    const first = graph.nodes.find((n) => !n.root);
    if (!first || first.name !== '@sf/c#build') return 'первый некорневой узел кейса не @sf/c#build: ' + JSON.stringify(first && first.name);
    const got = manifestGapBlind(dry, 'build', graph, ws);
    return got === null || 'детектор срезал узел вне манифестов: ' + JSON.stringify(got);
  });
  // В2, $TURBO_DEFAULT$: файлы пакета, видимые git, - во входах узла
  check('граф turbo: inputsGap - файл пакета, видимый git, вне входов узла; вложенный пакет и чужой каталог не считаются', () => {
    const dry = sample();
    dry.tasks.push(task('@sf/n#build', { directory: 'packages\\b\\nested' }));
    const tracked = ['packages/a/src/page.tsx', 'packages/b/src/index.ts', 'packages/b/README.md', 'packages/b/nested/x.ts', 'packages/c/src/index.ts', 'vitest.preset.ts'];
    const got = JSON.stringify([G.inputsGap(G.taskGraph(dry, 'build'), tracked, dry),
      ((cut) => G.inputsGap(G.taskGraph(cut, 'build'), tracked, cut))(G.stubWithoutInput(dry, '@sf/a#build', 'packages/a/src/page.tsx'))]);
    const want = JSON.stringify([['@sf/b#build: packages/b/README.md'], ['@sf/a#build: packages/a/src/page.tsx', '@sf/b#build: packages/b/README.md']]);
    return got === want || 'ожидалось ' + want + ', получено ' + got;
  });
  check('граф turbo: inputsGap - больше пяти файлов: пять и «и ещё N»', () => {
    const tracked = Array.from({ length: 7 }, (_, i) => 'packages/b/f' + i + '.ts');
    const got = G.inputsGap(G.taskGraph(sample(), 'build'), tracked, sample());
    const want = ['@sf/b#build: ' + tracked.slice(0, 5).join(', ') + ' и ещё 2'];
    return JSON.stringify(got) === JSON.stringify(want) || 'получено ' + JSON.stringify(got);
  });
  // корневая задача: turbo пишет directory '' - каталог узла и каталоги пакетов dry - оба '.'
  // (packageDir), файл корня вне входов виден, файлы пакетов под корнем - не его
  check('граф turbo: inputsGap - корневая задача (directory \'\'): каталог \'.\', файлы пакетов под корнем не её', () => {
    const dry = {
      globalCacheInputs: { files: {} },
      tasks: [
        task('//#build', { directory: '', command: 'tsc -b', dependencies: ['@sf/b#build'], inputs: { 'a.ts': 'h' } }),
        task('@sf/b#build'),
      ],
    };
    const graph = G.taskGraph(dry, 'build');
    const dirs = JSON.stringify([graph.nodes.map((n) => n.dir), Array.from(G.dryPackages(dry).values())]);
    if (dirs !== JSON.stringify([['.', 'packages/b'], ['.', 'packages/b']])) return 'каталоги узлов и пакетов dry: ' + dirs;
    const got = JSON.stringify(G.inputsGap(graph, ['a.ts', 'README.md', 'packages/b/src/index.ts', 'packages/b/x.ts'], dry));
    const want = JSON.stringify(['//#build: README.md', '@sf/b#build: packages/b/x.ts']);
    return got === want || 'ожидалось ' + want + ', получено ' + got;
  });
  refusedWith('стаб без входа: входа нет - отказ', () => G.stubWithoutInput(sample(), '@sf/b#build', 'packages/b/none.ts'),
    'стаб: у задачи @sf/b#build нет входа packages/b/none.ts');
  check('граф turbo: детектор входов - на графе без файла пакета во входах отказ, на графе с ним молчит', () => {
    const bare = withTask('@sf/a#build', (t) => Object.assign(t, { dependencies: [], inputs: { '../../vitest.preset.ts': 'h' } }));
    const got = inputsGapBlind(bare, 'build', G.taskGraph(bare, 'build'), []);
    const want = 'у графа turbo run build ни у одного узла нет отслеживаемого входа своего пакета - детектор входов не построить';
    if (got !== want) return 'ожидалось «' + want + '», получено ' + JSON.stringify(got);
    const ok2 = inputsGapBlind(sample(), 'build', G.taskGraph(sample(), 'build'), ['packages/a/src/page.tsx', 'packages/b/src/index.ts']);
    return ok2 === null || 'на графе с файлом пакета: ' + JSON.stringify(ok2);
  });
  // вход для среза берётся только из tracked: неотслеживаемый файл (`??`) turbo хеширует, а
  // inputsGap его не сверяет - срез такого входа дал бы ложное «проба не замечает»
  check('граф turbo: детектор входов режет только отслеживаемый вход; входы узлов не в tracked - отказ «нет отслеживаемого входа»', () => {
    const skip = inputsGapBlind(sample(), 'build', G.taskGraph(sample(), 'build'), ['packages/b/src/index.ts']);
    if (skip !== null) return 'вход packages/a/src/page.tsx вне tracked взят для среза: ' + JSON.stringify(skip);
    const none = inputsGapBlind(sample(), 'build', G.taskGraph(sample(), 'build'), []);
    const want = 'у графа turbo run build ни у одного узла нет отслеживаемого входа своего пакета - детектор входов не построить';
    return none === want || 'входы узлов вне tracked: ожидалось «' + want + '», получено ' + JSON.stringify(none);
  });
  // граф только из корневой задачи (каталог '.'): её вход a.ts - вход «своего пакета», как в
  // inputsGap (G.under), детектор строится (TECH_DEBT 21.10.2026 E0-12L круг 4, `own` в пробе входов)
  check('граф turbo: детектор входов на графе из одной корневой задачи (каталог .) строится, а не отказ', () => {
    const dry = { globalCacheInputs: { files: {} }, tasks: [task('//#build', { directory: '', command: 'tsc -b', inputs: { 'a.ts': 'h', 'b.ts': 'h' } })] };
    const got = inputsGapBlind(dry, 'build', G.taskGraph(dry, 'build'), ['a.ts', 'b.ts']);
    return got === null || 'на корневой задаче: ' + JSON.stringify(got);
  });
  // вход корневой задачи (каталог '.') из вложенного пакета inputsGap не считает её файлом: срез
  // такого входа дал бы ложное «проба не замечает» - детектор берёт тот же отбор G.ownFiles
  check('граф turbo: детектор входов не режет у корневой задачи вход вложенного пакета (тот же отбор, что у inputsGap)', () => {
    const dry = {
      globalCacheInputs: { files: {} },
      tasks: [
        task('//#build', { directory: '', command: 'tsc -b', dependencies: ['@sf/b#build'], inputs: { 'packages/b/src/index.ts': 'h', 'a.ts': 'h' } }),
        task('@sf/b#build'),
      ],
    };
    const got = inputsGapBlind(dry, 'build', G.taskGraph(dry, 'build'), ['packages/b/src/index.ts', 'a.ts']);
    return got === null || 'на корневой задаче с входом вложенного пакета: ' + JSON.stringify(got);
  });
  // форма задач dry проверяется раз на объект dry (TECH_DEBT 21.10.2026 E0-12L круг 3,
  // `dryPackages` -> `tasksById`): второй вопрос к тому же снимку не перебирает его задачи, стаб -
  // новый объект - проверяется сам
  check('граф turbo: tasksById - форма задач проверяется раз на объект dry, стаб с задачей без taskId - отказ', () => {
    const base = sample();
    let reads = 0;
    const tasks = base.tasks;
    const dry = Object.assign({}, base);
    Object.defineProperty(dry, 'tasks', { get: () => { reads++; return tasks; }, enumerable: true });
    G.rootTasks(dry, 'build');
    G.rootTasks(dry, 'build');
    if (reads !== 1) return 'задачи dry перебраны ' + reads + ' раз(а) на двух вопросах к одному снимку';
    return refusalVerdict(() => G.rootTasks(Object.assign({}, base, { tasks: base.tasks.concat({}) }), 'build'),
      'задача dry-JSON без taskId - форма dry-JSON turbo неизвестна');
  });
  // workspace: только в peerDependencies (Р5 техлида E0-12T; TECH_DEBT 21.10.2026 E0-12L круг 4, peer-only workspace-зависимость): отказ с пакетом,
  // зависимостью и подсказкой; peer с дублем в devDependencies и peer не workspace: - пропуск
  check('граф turbo: peerOnly - workspace: только в peerDependencies - отказ с подсказкой; peer + dev и peer не workspace: - нет', () => {
    const ws = {
      '@sf/a': { dir: 'packages/a', pkg: { name: '@sf/a', peerDependencies: { '@sf/b': 'workspace:*', react: '^18' } } },
      '@sf/c': { dir: 'packages/c', pkg: { name: '@sf/c', peerDependencies: { '@sf/b': 'workspace:^' }, devDependencies: { '@sf/b': 'workspace:^' } } },
      '@sf/b': { dir: 'packages/b', pkg: { name: '@sf/b' } },
    };
    const got = JSON.stringify(G.peerOnly(ws));
    const want = JSON.stringify(['пакет @sf/a: @sf/b (workspace:*) только в peerDependencies - turbo не строит по нему ребро, добавь в devDependencies']);
    return got === want || 'ожидалось ' + want + ', получено ' + got;
  });
  refusedWith('manifestGap: workspace:-зависимость вне пакетов dry - отказ',
    () => G.manifestGap(G.taskGraph(sample(), 'build'), manifests({ '@sf/a': { devDependencies: { '@sf/x': 'workspace:*' } }, '@sf/b': {} })),
    'workspace:-зависимость @sf/x пакета @sf/a (devDependencies) вне пакетов dry-JSON');
  refusedWith('нет globalCacheInputs.files - отказ', () => G.globalReads({ tasks: [] }),
    'в dry-JSON нет globalCacheInputs.files - форма dry-JSON turbo неизвестна');
  check('граф turbo: globalCacheInputs - в чтениях, кроме названных в HASHED_NOT_READ с причиной', () => {
    const g = G.globalReads(sample());
    const got = JSON.stringify([g.reads.map((r) => r.file), g.skipped.map((r) => r.file)]);
    const want = JSON.stringify([['tsconfig.base.json'], ['.gitattributes']]);
    if (got !== want) return 'ожидалось ' + want + ', получено ' + got;
    return g.skipped.every((r) => r.why) || 'у исключения нет причины';
  });
  // turbo.jsonc рядом с turbo.json (TECH_DEBT 21.10.2026 E0-12L круг 4, `turbo.jsonc`); `**` - пакет и на первом, и на втором
  // уровне (TECH_DEBT 21.10.2026 E0-12L круг 3, `patternPackage`)
  check('граф turbo: graphSources - корень без ./, у пакета package.json, turbo.json и turbo.jsonc, новый пакет по шаблону (** - два уровня, и без пакетов), без повторов', () => {
    const dry = {
      globalCacheInputs: { files: {} },
      tasks: [
        task('//#lint', { directory: '.', command: 'biome check', inputs: {} }),
        task('@sf/a#build', { directory: 'apps\\a', inputs: {} }),
        task('@sf/a#test', { directory: 'apps\\a', inputs: {} }),
      ],
    };
    const got = JSON.stringify(G.graphSources(dry, ['apps/*', './tools/**/', '!apps/x']).map((x) => x.file));
    const N = G.NEW_SIBLING;
    const three = (dir) => [dir + '/package.json', dir + '/turbo.json', dir + '/turbo.jsonc'];
    const want = JSON.stringify(['package.json', 'pnpm-workspace.yaml', 'turbo.json', 'turbo.jsonc'].concat(
      three('apps/a'), three('apps/' + N), three('tools/' + N), three('tools/' + N + '/' + N)));
    return got === want || 'ожидалось ' + want + ', получено ' + got;
  });
  refusedWith('graphSources: шаблон с ? [ ] { } - отказ', () => G.graphSources(sample(), ['apps/{a,b}']),
    'шаблон apps/{a,b} pnpm-workspace.yaml не разбирается пробой (знаки ? [ ] { }) - разбери руками');
  // Разбор шаблонов workspace - пакетом yaml: без него отказ снимка (liveSnap зовёт тот же разбор),
  // и кейсы ниже не гоняются - одна красная строка графа, а не три (TECH_DEBT 21.10.2026 E0-12L круг 4, разбор шаблонов workspace без yaml).
  {
    const line = 'граф turbo: workspacePatterns - список packages pnpm-workspace.yaml';
    check(line, GRAPH_GATE.guard(line, () => {
      const got = JSON.stringify(G.workspacePatterns('packages:\n  - "apps/*"\n  - \'tools/*\'\n'));
      return got === JSON.stringify(['apps/*', 'tools/*']) || 'получено ' + got;
    }));
    const refused = 'граф turbo: workspacePatterns: нет списка строк packages - отказ';
    check(refused, GRAPH_GATE.guard(refused, () => refusalVerdict(() => G.workspacePatterns('packages:\n  - 1\n'),
      'в pnpm-workspace.yaml нет списка строк packages - шаблоны пакетов workspace неизвестны')));
  }
  check('граф turbo: rootTasks - задачи script с командой, без отказа на пустом списке', () => {
    const got = JSON.stringify([G.rootTasks(sample(), 'build'), G.rootTasks(sample(), 'test:int')]);
    const want = JSON.stringify([[{ name: '@sf/a#build', command: 'next build' }], []]);
    return got === want || 'ожидалось ' + want + ', получено ' + got;
  });
  refusedWith('стаб команды задачи вне dry-JSON - отказ', () => G.stubCommand(sample(), '@sf/x#build', 'x'),
    'стаб: задачи @sf/x#build нет в dry-JSON');
  refusedWith('стаб без рёбер к задаче вне dry-JSON - отказ', () => G.stubCut(sample(), '@sf/x#build'),
    'стаб: задачи @sf/x#build нет в dry-JSON');
  refusedWith('стаб глобального входа без globalCacheInputs.files - отказ', () => G.stubGlobal({ tasks: [] }),
    'в dry-JSON нет globalCacheInputs.files - форма dry-JSON turbo неизвестна');
  check('граф turbo: стабы (узел, команда, рёбра, глобальный вход) меняют свою часть, снимок не правят', () => {
    const dry = sample();
    const before = JSON.stringify(dry);
    const node = G.stubNode(dry, 'build');
    const cmd = G.stubCommand(dry, '@sf/a#build', WEAK_BUILD);
    const cut = G.stubCut(dry, '@sf/b#build');
    const glob = G.stubGlobal(dry);
    if (JSON.stringify(dry) !== before) return 'стаб правит исходный dry';
    const stubNodeOf = G.taskGraph(node, 'build').nodes.find((n) => n.name === G.stubTaskId('build'));
    if (!stubNodeOf) return 'узла стаба нет в графе';
    if (stubNodeOf.dir !== G.STUB_DIR || stubNodeOf.pkg !== G.STUB_PACKAGE) return 'стаб-узел не в STUB_DIR или не STUB_PACKAGE';
    if (G.rootTasks(cmd, 'build')[0].command !== WEAK_BUILD) return 'стаб команды не сменил команду';
    if (G.taskGraph(cut, 'build').nodes.some((n) => n.name === '@sf/b#build')) return 'стаб без рёбер оставил узел в графе';
    return G.globalReads(glob).reads.some((r) => r.file === G.STUB_GLOBAL) || 'стаб глобального входа не добавил STUB_GLOBAL';
  });
  check('граф turbo: файлы стабов - в STUB_DIR', () => {
    const stray = G.STUB_FILES.concat(G.STUB_PATTERN).filter((f) => !f.startsWith(G.STUB_DIR + '/'));
    return !stray.length || 'файлы стабов вне STUB_DIR: ' + stray.join(', ');
  });
  check('граф turbo: отказ снимка - одна строка, пробы графа не гоняются и названы в ней', () => {
    let called = 0;
    const g = snapshotGate(() => { throw new Error('boom'); });
    const r = g.guard('проба x', () => { called++; return true; })();
    if (r !== SKIPPED || called) return 'проба графа гонялась без графа (результат ' + String(r) + ', вызовов ' + called + ')';
    const v = graphVerdict(g);
    return v === 'boom; пробы графа не гонялись (1): проба x' || 'строка отказа: ' + JSON.stringify(v);
  });
  check('граф turbo: с графом пробы графа гоняются как есть', () => {
    const g = snapshotGate(() => ({ dry: { tasks: [] } }));
    const r = g.guard('проба x', (a) => a + 1)(1);
    if (r !== 2 || g.blocked.length) return 'проба с графом: результат ' + r + ', не гонялись ' + g.blocked.length;
    const v = graphVerdict(g);
    return (typeof v === 'object' && v.note === '0 задач') || 'строка графа: ' + JSON.stringify(v);
  });
  check('граф turbo: check не пишет строку пробы, которая вернула SKIPPED', () => {
    const before = results.length;
    check('граф turbo: проба SKIPPED', () => SKIPPED);
    const stray = results.splice(before);
    return !stray.length || 'check записал строку пробы, которая не гонялась: ' + stray.map((x) => (x.ok ? 'ok ' : 'FAIL ') + x.name).join(', ');
  });
  check('граф turbo: rootsRefusal - отказ корней называет перечень и как его расширить', () => {
    const dry = G.stubCommand(G.stubNode(sample(), 'build', { command: 'next build' }), '@sf/a#build', WEAK_BUILD);
    const got = rootsRefusal(dry, 'build', { roots: ['@sf/a#build'], command: 'next build' }, 'build');
    const want = 'корни turbo run build не ровно @sf/a#build с командой next build: лишний корень ' + G.stubTaskId('build') + ', @sf/a#build: "' + WEAK_BUILD + '"' +
      ' - перечень корней - roots в checkRootCommands(\'build\', …) внутри checkGateSelection(\'build\') (selftest-gates.js); новый пакет дописывается туда вместе с glob гейта build';
    return got === want || 'ожидалось «' + want + '», получено ' + JSON.stringify(got);
  });
  // trackedFiles (снимок liveSnap): сбой git - отказ, а не пустой список, с которым inputsGap
  // молча слепнет; файл, которого нет на диске, выпадает, файл, который не читается, - отказ
  const lsFiles = (stdout) => () => ({ pid: 4242, status: 0, signal: null, stdout, stderr: '' });
  const NO_GIT = 'sf-selftest-no-git';
  refusedWith('git ls-files не запустился - отказ с ошибкой запуска', () => trackedFiles({ git: NO_GIT }),
    'git ls-files не запустился: spawnSync ' + NO_GIT + ' ENOENT');
  refusedWith('git ls-files убит сигналом - отказ с именем сигнала', () => trackedFiles({ spawn: () => ({ pid: 4242, status: null, signal: 'SIGKILL', stdout: '', stderr: '' }) }),
    'git ls-files: сигнал SIGKILL: ');
  check('граф turbo: trackedFiles - файла нет на диске - не в списке, есть - в списке', () => {
    const got = JSON.stringify(trackedFiles({ spawn: lsFiles('package.json\0sf-selftest-gone.ts\0') }));
    return got === JSON.stringify(['package.json']) || 'получено ' + got;
  });
  refusedWith('trackedFiles: файл не читается (EACCES) - отказ, а не молча выпавший файл', () => trackedFiles({
    spawn: lsFiles('package.json\0sf-selftest-locked.ts\0'),
    stat: (p) => {
      if (path.basename(p) === 'sf-selftest-locked.ts') throw Object.assign(new Error('EACCES: permission denied, stat sf-selftest-locked.ts'), { code: 'EACCES' });
      return fs.statSync(p);
    },
  }), 'EACCES: permission denied, stat sf-selftest-locked.ts');
  check('граф turbo: trackedFiles - родитель пути стал файлом (ENOTDIR) - файла нет, а не отказ', () => {
    let got;
    try {
      got = JSON.stringify(trackedFiles({
        spawn: lsFiles('package.json\0package.json/sf-selftest-child.ts\0'),
        stat: (p) => {
          if (path.basename(p) === 'sf-selftest-child.ts') throw Object.assign(new Error('ENOTDIR: not a directory, stat sf-selftest-child.ts'), { code: 'ENOTDIR' });
          return fs.statSync(p);
        },
      }));
    } catch (e) {
      return 'отказ: ' + ((e && e.message) || String(e));
    }
    return got === JSON.stringify(['package.json']) || 'получено ' + got;
  });
  check('граф turbo: trackedFiles - отслеживаемый путь стал каталогом - не в списке', () => {
    const got = JSON.stringify(trackedFiles({ spawn: lsFiles('package.json\0.claude\0') }));
    return got === JSON.stringify(['package.json']) || 'получено ' + got;
  });
  // ENOBUFS - вывод больше maxBuffer, а не «не запустился» (TECH_DEBT 21.10.2026 E0-12L круг 4, `trackedFiles` и ENOBUFS)
  refusedWith('trackedFiles: вывод git больше maxBuffer (ENOBUFS) - своя причина, не «не запустился»',
    () => trackedFiles({ spawn: () => ({ pid: 4242, status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' }) }) }),
    'git ls-files: вывод больше maxBuffer (' + LISTING_MAX_BUFFER + ' байт)');
  // Ссылки выборки судятся по цели, как в близнеце scripts/lib/files.mjs (stat, решение ревью B13
  // E0-12T): ссылка на каталог и висячая ссылка - не файл. Корень кейса - временный каталог с
  // настоящими junction (на Windows ссылка на файл требует прав - её кейс не строит).
  const linkRoot = (fn) => withTempRoot({ 'package.json': '{}', 'dir/x.txt': 'x', 'gone/x.txt': 'x', '.claude/x.txt': 'x' }, (root) => {
    fs.symlinkSync(path.join(root, 'dir'), path.join(root, 'link-dir'), 'junction');
    fs.symlinkSync(path.join(root, 'gone'), path.join(root, 'link-gone'), 'junction');
    fs.rmSync(path.join(root, 'gone'), { recursive: true, force: true });
    return fn(root);
  });
  check('граф turbo: trackedFiles - отслеживаемая ссылка на каталог и висячая ссылка - не в списке (как files.mjs)', () => linkRoot((root) => {
    const got = JSON.stringify(trackedFiles({ root, spawn: lsFiles('package.json\0link-dir\0link-gone\0') }));
    return got === JSON.stringify(['package.json']) || 'получено ' + got;
  }));
  // Близнец trackedFiles с others и trackedFiles из scripts/lib/files.mjs (загружен в дочерний node)
  // на одном ответе git и одном корне со ссылками: одни аргументы git и один список - дубли путей
  // (конфликт) по разу, пропавший файл, каталог, ссылка на каталог и висячая ссылка выпадают (E0-12N,
  // К2-6 круга 2; образец - сверка isGone по Р4).
  check('граф turbo: близнец trackedFiles (others) зовёт git и отбирает файлы как trackedFiles из scripts/lib/files.mjs (и ссылки)', () => linkRoot((root) => {
    const stdout = 'package.json\0package.json\0sf-selftest-gone.ts\0.claude\0package.json\0link-dir\0link-gone\0';
    const module = require('url').pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'files.mjs')).href;
    const program = 'const { trackedFiles, LISTING_MAX_BUFFER } = await import(' + JSON.stringify(module) + ');' +
      'let args = null; let maxBuffer = null;' +
      'const spawn = (command, given, options) => { args = [command, ...given]; maxBuffer = options.maxBuffer; return { status: 0, stdout: ' + JSON.stringify(stdout) + ', stderr: "" }; };' +
      'const got = trackedFiles(' + JSON.stringify(root) + ', { spawn });' +
      'console.log(JSON.stringify({ args, got, maxBuffer, exported: LISTING_MAX_BUFFER }));';
    const r = run(process.execPath, ['--input-type=module', '--eval', program], { cwd: ROOT });
    if (r.error || r.status !== 0) return 'files.mjs не загрузился: ' + String((r.error && r.error.message) || r.stderr).slice(0, 160);
    const original = JSON.parse(String(r.stdout).trim());
    let args = null;
    let maxBuffer = null;
    const got = trackedFiles({ root, others: true, spawn: (command, given, options) => { args = [command, ...given]; maxBuffer = options.maxBuffer; return lsFiles(stdout)(); } });
    if (original.maxBuffer !== original.exported) {
      return 'files.mjs даёт git maxBuffer ' + original.maxBuffer + ', а LISTING_MAX_BUFFER ' + original.exported;
    }
    if (maxBuffer !== original.exported) {
      return 'maxBuffer близнеца ' + maxBuffer + ', LISTING_MAX_BUFFER files.mjs ' + original.exported;
    }
    if (JSON.stringify(args) !== JSON.stringify(original.args)) {
      return 'git близнеца ' + JSON.stringify(args) + ', у files.mjs ' + JSON.stringify(original.args);
    }
    if (JSON.stringify(got) !== JSON.stringify(original.got)) {
      return 'список близнеца ' + JSON.stringify(got) + ', у files.mjs ' + JSON.stringify(original.got);
    }
    return { note: original.got.length + ' файл из ' + stdout.split('\0').filter(Boolean).length + ' путей' };
  }));
  // «путь под каталогом» - один предикат G.strictlyUnder (решение ревью B3 E0-12T): каталог `..x`
  // внутри корня - под ним, родитель корня и сам корень - нет
  check('граф turbo: relUnder - каталог ..x внутри корня под ним, родитель и сам корень - отказ', () => withTempRoot({ 'root/..x/a.ts': 'x', 'out.ts': 'x' }, (dir) => {
    const base = fs.realpathSync(path.join(dir, 'root'));
    const got = relUnder(path.join(base, '..x', 'a.ts'), base, 'кейс');
    if (got !== '..x/a.ts') return 'путь в каталоге ..x: ' + JSON.stringify(got);
    const bad = [path.join(dir, 'out.ts'), base].map((abs) => refusalVerdict(() => relUnder(abs, base, 'кейс'), 'кейс: путь ' + abs + ' вне ' + base)).filter((v) => v !== true);
    return !bad.length || bad.join('; ');
  }));
  // «вне корня» для путей от корня - один предикат G.outsideRoot (замечание ревью C5 E0-12T): его
  // берут inRoot, резолв `./`/`../` и join/resolve(repoRoot, …) обхода int-наборов
  check('граф turbo: outsideRoot - .., ../a и /a вне корня; ..x/a, a/..b и a - внутри', () => {
    const paths = ['..', '../a', '/a', '..x/a', 'a/..b', 'a'];
    const got = JSON.stringify(paths.map(G.outsideRoot));
    const want = JSON.stringify([true, true, true, false, false, false]);
    return got === want || JSON.stringify(paths) + ': ожидалось ' + want + ', получено ' + got;
  });
}

module.exports = { registerGraphCases };
