'use strict';
/**
 * selftest-state-runner.js - тело дочернего node проб записи .qa-state (selftest-state.js; ревью E0-12AE, круг 1,
 * Б16: stateRunner вынесен по образцу selftest-gate-runner.js). Не хук: модуль самопроверки, который исполняет
 * только дочерний процесс: `node -e` пробы берёт stateRunner этого файла и зовёт его с настройками; загрузка
 * модуля ничего не исполняет и процесс не завершает.
 *
 * Что делает stateRunner(cfg):
 *   cfg.parallel - писатели, которые идут все одновременно ({ key, args, env, input }): занятая блокировка,
 *     отказ ФС, проход без изменения; итог - { [key]: { code, signal, out, err } };
 *   cfg.scenarios - сценарии гонок ({ key, children, steps }), все одновременно с cfg.parallel; шаги сценария
 *     идут по порядку: { start: имя } - запустить ребёнка children[имя]; { wait: [файлы], as } - ждать первого
 *     появившегося файла-сигнала (не таймер: таймер - только предел CASE_CAP_MS); { write: файл } - записать
 *     файл-сигнал; { join: имя } - дождаться выхода ребёнка; { exists: файл, as } - есть ли файл сейчас. Итог -
 *     { [key]: { children: { имя: итог }, waits: { as: имя файла | null }, exists: { as: bool } } }.
 * Дети - через точку запуска makeLauncher (liveState: SF_HOOK_STATE_DIR не боевой) с окружением по белому
 * списку (envByList, L-030). Итог - строка RESULT_PREFIX + JSON последней строкой stdout.
 */

const fs = require('fs');
const path = require('path');
const { envByList, makeLauncher } = require('./selftest-children.js');

/** Строка итога дочернего процесса проб: 'state-probe <JSON>' последней строкой stdout. */
const RESULT_PREFIX = 'state-probe ';
/** Предел одного ребёнка и одного ожидания файла-сигнала, мс. */
const CASE_CAP_MS = 20000;

function stateRunner(cfg) {
  const launch = makeLauncher({ liveState: cfg.liveState });
  const start = (c) =>
    new Promise((resolve) => {
      let child;
      try {
        child = launch.spawn(process.execPath, c.args, { cwd: cfg.cwd, env: envByList(process.env, c.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (e) {
        resolve({ code: null, signal: null, out: '', err: 'точка запуска: ' + ((e && e.message) || String(e)) });
        return;
      }
      let out = '';
      let err = '';
      child.stdout.on('data', (b) => { out += b; });
      child.stderr.on('data', (b) => { err += b; });
      const cap = setTimeout(() => child.kill('SIGKILL'), CASE_CAP_MS);
      child.on('close', (code, signal) => {
        clearTimeout(cap);
        resolve({ code, signal, out: out.slice(-2000), err: err.slice(-2000) });
      });
      child.stdin.end(c.input || '');
    });
  // первый появившийся файл из files или null после CASE_CAP_MS (предел, а не ожидание)
  const waitFile = (files) =>
    new Promise((resolve) => {
      const from = Date.now();
      const t = setInterval(() => {
        const hit = files.find((f) => fs.existsSync(f)) || null;
        if (hit || Date.now() - from >= CASE_CAP_MS) {
          clearInterval(t);
          resolve(hit);
        }
      }, 5);
    });
  const parallel = async () => {
    const list = cfg.parallel || [];
    const done = await Promise.all(list.map(start));
    const out = {};
    list.forEach((c, i) => { out[c.key] = done[i]; });
    return out;
  };
  const scenario = async (sc) => {
    const running = {};
    const res = { children: {}, waits: {}, exists: {} };
    for (const step of sc.steps) {
      if (step.start) running[step.start] = start(sc.children[step.start]);
      else if (step.wait) {
        const hit = await waitFile(step.wait);
        res.waits[step.as] = hit ? path.basename(hit) : null;
      } else if (step.write) fs.writeFileSync(step.write, 'go');
      else if (step.join) res.children[step.join] = running[step.join] ? await running[step.join] : null;
      else if (step.exists) res.exists[step.as] = fs.existsSync(step.exists);
    }
    // ребёнок, которого сценарий не дождался шагом join, - всё равно до итога
    for (const name of Object.keys(running)) if (!res.children[name]) res.children[name] = await running[name];
    return res;
  };
  (async () => {
    const scenarios = cfg.scenarios || [];
    const [p, ...s] = await Promise.all([parallel()].concat(scenarios.map(scenario)));
    const out = { parallel: p, scenarios: {} };
    scenarios.forEach((sc, i) => { out.scenarios[sc.key] = s[i]; });
    process.stdout.write(RESULT_PREFIX + JSON.stringify(out));
  })();
}

module.exports = { stateRunner, RESULT_PREFIX, CASE_CAP_MS };
