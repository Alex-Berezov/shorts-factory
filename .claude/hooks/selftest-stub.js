'use strict';
/**
 * selftest-stub.js - стабы графа turbo для детекторов проб гейтов build и test:int в
 * selftest-tree-graph.js (E0-12U: разрез selftest-graph.js по заботам). Не хук: модуль самопроверки,
 * верхний в цепочке require lib.js <- selftest-turbo.js <- selftest-graph.js <- selftest-stub.js:
 * берёт у selftest-graph.js узлы (taskGraph, globalReads), входы (DECLARED_INPUTS, resolvedInputs),
 * пути пакетов и NONEXISTENT; формат отказа - тоже там. harness-selftest.js грузит модуль только
 * поверх загруженного selftest-graph.js (loadGraphChain): без него строки «selftest-stub.js
 * загружается require» нет - отказ называет строка синтаксиса или require selftest-graph.js.
 *
 * Стаб - копия dry-JSON с одной правкой (новый узел, команда, срез ребра, снятый вход, глобальный
 * вход): детектор пробы обязан её заметить. Снимок dry не правится никогда - каждый стаб строит
 * новый объект. Задачи, которой стаб касается, нет в dry - исключение «стаб: …».
 */

const {
  NONEXISTENT,
  NEW_SIBLING,
  TURBO_CONFIGS,
  DECLARED_INPUTS,
  resolvedInputs,
  packageDir,
  inRoot,
  taskGraph,
  globalReads,
} = require('./selftest-graph.js');

/**
 * Стаб проб графа: пакет STUB_PACKAGE в каталоге STUB_DIR - вне glob любого гейта и вне шаблонов
 * workspace, поэтому законное расширение glob гейта (packages/db, docs, tools/*) детектор не
 * ломает. Все файлы стабов - в STUB_DIR: STUB_GLOBAL (глобальный вход), STUB_PATTERN (шаблон
 * workspace); STUB_SOURCES - файлы графа, которые стаб-пакет и стаб-шаблон добавляют в
 * graphSources (собраны здесь напрямую, не через graphSources: детектор сверяет её с ними);
 * STUB_FILES - все файлы стабов, по которым проба проверяет, что стаб вне glob гейта.
 */
const STUB_DIR = 'selftest-stub';
const STUB_PACKAGE = '@sf/selftest-stub';
const STUB_GLOBAL = STUB_DIR + '/selftest-global.json';
const STUB_PATTERN = STUB_DIR + '/*';
const STUB_SOURCES = ['package.json', ...TURBO_CONFIGS, NEW_SIBLING + '/package.json', ...TURBO_CONFIGS.map((f) => NEW_SIBLING + '/' + f)].map((f) => STUB_DIR + '/' + f);
const STUB_FILES = STUB_SOURCES.concat(STUB_GLOBAL);

/** taskId стаб-задачи script. */
function stubTaskId(script) {
  return STUB_PACKAGE + '#' + script;
}

/** Задача taskId есть в dry - иначе исключение «стаб: задачи ... нет». */
function requireTask(dry, taskId) {
  if (!dry.tasks.some((t) => t.taskId === taskId)) throw new Error('стаб: задачи ' + taskId + ' нет в dry-JSON');
}

/**
 * Стаб: копия dry с задачей script пакета STUB_PACKAGE в STUB_DIR (без команды, рёбер и входов,
 * inputs по DECLARED_INPUTS; fields - поля поверх) и ребром к ней от первого корня графа script.
 * Снимок не правится.
 */
function stubNode(dry, script, fields) {
  const from = taskGraph(dry, script).roots[0].name;
  const decl = DECLARED_INPUTS[script];
  const task = Object.assign({
    taskId: stubTaskId(script),
    directory: STUB_DIR,
    command: NONEXISTENT,
    dependencies: [],
    inputs: {},
    resolvedTaskDefinition: { inputs: decl ? resolvedInputs(decl.inputs, STUB_DIR) : [] },
  }, fields);
  return Object.assign({}, dry, {
    tasks: dry.tasks
      .map((t) => (t.taskId === from ? Object.assign({}, t, { dependencies: t.dependencies.concat(task.taskId) }) : t))
      .concat(task),
  });
}

/** Стаб: копия dry с командой command у задачи taskId. taskId нет в dry - исключение. */
function stubCommand(dry, taskId, command) {
  requireTask(dry, taskId);
  return Object.assign({}, dry, { tasks: dry.tasks.map((t) => (t.taskId === taskId ? Object.assign({}, t, { command }) : t)) });
}

/** Стаб: копия dry без рёбер к задаче taskId (её зависимые её не видят). taskId нет в dry - исключение. */
function stubCut(dry, taskId) {
  requireTask(dry, taskId);
  return Object.assign({}, dry, {
    tasks: dry.tasks.map((t) => Object.assign({}, t, { dependencies: t.dependencies.filter((d) => d !== taskId) })),
  });
}

/**
 * Стаб: копия dry без входа задачи taskId, который разрешается в file (путь от корня).
 * taskId нет в dry или такого входа нет - исключение.
 */
function stubWithoutInput(dry, taskId, file) {
  requireTask(dry, taskId);
  const t = dry.tasks.find((x) => x.taskId === taskId);
  const dir = packageDir(t);
  const keys = Object.keys(t.inputs).filter((k) => inRoot(dir, k, taskId) !== file);
  if (keys.length === Object.keys(t.inputs).length) throw new Error('стаб: у задачи ' + taskId + ' нет входа ' + file);
  const inputs = Object.fromEntries(keys.map((k) => [k, t.inputs[k]]));
  return Object.assign({}, dry, { tasks: dry.tasks.map((x) => (x === t ? Object.assign({}, x, { inputs }) : x)) });
}

/** Стаб: копия dry с файлом STUB_GLOBAL в globalCacheInputs.files. Нет globalCacheInputs.files - исключение. */
function stubGlobal(dry) {
  globalReads(dry);
  const g = dry.globalCacheInputs;
  return Object.assign({}, dry, { globalCacheInputs: Object.assign({}, g, { files: Object.assign({}, g.files, { [STUB_GLOBAL]: 'stub' }) }) });
}

module.exports = {
  STUB_DIR,
  STUB_PACKAGE,
  STUB_GLOBAL,
  STUB_PATTERN,
  STUB_SOURCES,
  STUB_FILES,
  stubTaskId,
  stubNode,
  stubCommand,
  stubCut,
  stubWithoutInput,
  stubGlobal,
};
