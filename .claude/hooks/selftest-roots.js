'use strict';
/**
 * selftest-roots.js - корни графа turbo и корневые скрипты для проб гейтов (E0-12U: раздел гейтов
 * harness-selftest.js по заботам). Не хук: модуль самопроверки. Корни turbo run <скрипт> - ровно
 * перечень с командой каждого (rootsVerdict, checkRootCommands), скрипт корневого package.json -
 * ровно ожидание (rootScriptVerdict, checkRootScriptLines, rootScriptExtra; одно чтение файла за
 * прогон - rootPkg), гейты с when always, которые гоняют корневой скрипт (checkAlwaysGate,
 * checkAlwaysScriptGate).
 *
 * createRootProbes(ctx, sel) только объявляет: sel - проба выбора гейта (gateProbe, selects из
 * selftest-gates.js) и снимок графа настоящего дерева GRAPH_GATE (selftest-tree-graph.js); строки
 * пишет checkAlwaysScriptGate, когда её зовёт selftest-gates.js.
 */

const path = require('path');

function createRootProbes(ctx, sel) {
  const { G, ROOT, check, readJson } = ctx;
  const { gateProbe, selects, GRAPH_GATE } = sel;
  /** Ключ скрипта в тексте отказа: из модуля графа, без модуля - имя скрипта как есть. */
  const scriptKey = (script) => (G ? G.scriptKey(script) : script);
  // Литералы проб отказа склеены из частей: модуль вне weakeningExempt (rules.common.json), и замок
  // коммита (W02, W03) ловит в нём только настоящее ослабление.
  /** Хвост, ослабляющий команду корня: её ошибка не роняет сборку. */
  const WEAK_TAIL = ' |' + '| true';
  /** Лишний флаг корневого скрипта тестов: зелёный прогон без единого теста. */
  const EXTRA_FLAG = ' --pass' + 'WithNoTests';

  /**
   * Корневой package.json - одно чтение за прогон (TECH_DEBT 21.10.2026 E0-12L круг 3,
   * `checkRootScriptLines`, `rootScriptExtra`): пробы скриптов корня берут его отсюда. Сбой чтения -
   * исключение в каждой пробе, которой он нужен (их строки красные с причиной), запомненное, как и
   * текст. ROOT_PKG_READS - сколько раз файл прочитан с диска: его сверяет проба в конце прогона.
   */
  let rootPkgMemo = null;
  let ROOT_PKG_READS = 0;
  function rootPkg() {
    if (!rootPkgMemo) {
      try {
        ROOT_PKG_READS++;
        rootPkgMemo = { value: readJson(path.join(ROOT, 'package.json')) };
      } catch (e) {
        rootPkgMemo = { error: e };
      }
    }
    if (rootPkgMemo.error) throw rootPkgMemo.error;
    return rootPkgMemo.value;
  }

  /**
   * Расхождения корней графа script с want ({ roots, command }): корни - ровно want.roots
   * (пропавший скрипт пакета сужает граф молча, лишний корень - новый пакет мимо перечня), команда
   * каждого - ровно want.command (команда с хвостом «или true» и `; exit 0` - ослабленная
   * сборка, не она). Строки отказа; пусто - совпадает.
   */
  function rootsVerdict(dry, script, want) {
    const roots = G.rootTasks(dry, script);
    const names = roots.map((r) => r.name);
    return [
      ...want.roots.filter((n) => !names.includes(n)).map((n) => 'нет корня ' + n),
      ...names.filter((n) => !want.roots.includes(n)).map((n) => 'лишний корень ' + n),
      ...roots.filter((r) => r.command !== want.command).map((r) => r.name + ': ' + JSON.stringify(r.command)),
    ];
  }

  /**
   * Текст отказа пробы корней гейта gateId (rootsVerdict) или null: называет, где перечень корней
   * и что новый пакет дописывается в него вместе с glob гейта - иначе законное расширение
   * оператор чинил бы ослаблением пробы.
   */
  function rootsRefusal(dry, script, want, gateId) {
    const bad = rootsVerdict(dry, script, want);
    if (!bad.length) return null;
    return 'корни turbo run ' + script + ' не ровно ' + want.roots.join(', ') + ' с командой ' + want.command + ': ' + bad.join(', ') +
      ' - перечень корней - roots в checkRootCommands(\'' + script + '\', …) внутри checkGateSelection(\'' + gateId + '\') (selftest-gates.js); новый пакет дописывается туда вместе с glob гейта ' + gateId;
  }

  /**
   * Проба корней графа script (extra-строка checkGateSelection с graph): корни - ровно
   * want.roots, команда каждого - ровно want.command. Детекторы не слепые: на стабах первого
   * корня с командой want.command и хвостом «или true» (WEAK_TAIL) и без команды и на лишнем стаб-корне с верной
   * командой - каждый обязан дать свою строку отказа.
   */
  function checkRootCommands(script, want) {
    return ({ gate }) => {
      const dry = GRAPH_GATE.snap.dry;
      const refused = rootsRefusal(dry, script, want, gate.id);
      if (refused) return refused;
      const first = want.roots[0];
      const detectors = [
        [G.stubCommand(dry, first, want.command + WEAK_TAIL), first + ': ' + JSON.stringify(want.command + WEAK_TAIL)],
        [G.stubCommand(dry, first, G.NONEXISTENT), 'нет корня ' + first],
        [G.stubNode(dry, script, { command: want.command }), 'лишний корень ' + G.stubTaskId(script)],
      ];
      const blind = detectors.filter(([stub, line]) => !rootsVerdict(stub, script, want).includes(line)).map(([, line]) => line);
      if (blind.length) return 'проба не замечает на стабе: ' + blind.join('; ');
      return { note: want.roots.join(', ') + ': ' + want.command };
    };
  }

  /**
   * Скрипт корневого package.json (pkg) script - ровно expected: результат как у check. Точное
   * равенство: лишний флаг (--dry, --filter, флаг «пропуск без тестов» vitest) выключил бы проверку при зелёном гейте.
   */
  function rootScriptVerdict(pkg, script, expected) {
    const actual = pkg.scripts && pkg.scripts[script];
    return actual === expected || scriptKey(script) + ' в корневом package.json не ' + expected + ': ' + JSON.stringify(actual);
  }

  /**
   * Две строки «скрипт корня = ровно expected»: на настоящем package.json (rootPkg - одно чтение за
   * прогон) и проба отказа - тот же скрипт с лишним флагом обязан краснеть. label - начало названия.
   */
  function checkRootScriptLines(label, script, expected) {
    check(label + ': ' + scriptKey(script) + ' = ' + expected + ' в корневом package.json', () => rootScriptVerdict(rootPkg(), script, expected));
    check(label + ': ' + scriptKey(script) + ' с лишним флагом краснеет (проба отказа)', () => {
      const r = rootScriptVerdict({ scripts: { [script]: expected + EXTRA_FLAG } }, script, expected);
      return typeof r === 'string' || 'скрипт с лишним флагом принят за ' + expected;
    });
  }

  /**
   * extra-строка гейта, который гоняет корневой скрипт: cmd гейта - ровно `pnpm <script>`,
   * scripts[script] корневого package.json (rootPkg) - ровно expected (rootScriptVerdict).
   */
  function rootScriptExtra(script, expected) {
    return {
      name: 'cmd pnpm ' + script + ' и ' + scriptKey(script) + ' = ' + expected + ' в корневом package.json',
      fn: ({ gate }) => {
        if (gate.cmd !== 'pnpm ' + script) return 'cmd гейта ' + gate.id + ' не pnpm ' + script + ': ' + gate.cmd;
        return rootScriptVerdict(rootPkg(), script, expected);
      },
    };
  }

  /**
   * Пробы гейта с when always: правило сверяется прямо, а выбор - на файле вне glob всех
   * остальных гейтов (на одном файле always от glob иначе не отличить). Каждая сверка - с пробой
   * отказа: тот же гейт с when glob обязан её краснить (E0-12L; TECH_DEBT, строка 17.10.2026 E0-12A
   * «красная проба when в typecheck, inline-чеки»).
   */
  function checkAlwaysGate(id) {
    // файл вне glob всех остальных гейтов: выбор на нём даёт только when always
    const OUTSIDE_ALL = 'docs/30_E0_TASKS.md';
    const narrowed = (gate) => Object.assign({}, gate, { when: 'glob:{apps/**}' });
    const whenAlways = (gate) => gate.when === 'always' || 'when гейта ' + gate.id + ' не always: ' + gate.when;
    check('гейт ' + id + ': when always', () => whenAlways(gateProbe(id).gate));
    check('гейт ' + id + ': сверка when always краснеет на when glob (проба отказа)', () =>
      typeof whenAlways(narrowed(gateProbe(id).gate)) === 'string' || 'when glob:{apps/**} принят за always');
    check('гейт ' + id + ': gates.js выбирает его на файле вне всех glob (' + OUTSIDE_ALL + ')', () =>
      gateProbe(id).runs(OUTSIDE_ALL) || 'gates.js не выбирает его на ' + OUTSIDE_ALL);
    check('гейт ' + id + ': с when glob gates.js на ' + OUTSIDE_ALL + ' его не выбирает (проба отказа)', () =>
      !selects(narrowed(gateProbe(id).gate), OUTSIDE_ALL) || 'gates.js выбирает гейт с when glob:{apps/**} на ' + OUTSIDE_ALL + ' - проба выбора не краснеет');
  }

  /**
   * Пробы гейта id с when always (checkAlwaysGate), который гоняет корневой скрипт id: cmd гейта -
   * ровно `pnpm <id>`, scripts[id] корневого package.json - ровно expected, scripts[repoScript] -
   * ровно repoExpected (checkRootScriptLines, с пробой отказа).
   */
  function checkAlwaysScriptGate(id, expected, repoScript, repoExpected) {
    checkAlwaysGate(id);
    const cmd = rootScriptExtra(id, expected);
    check('гейт ' + id + ': ' + cmd.name, () => cmd.fn(gateProbe(id)));
    checkRootScriptLines('гейт ' + id, repoScript, repoExpected);
  }

  return { rootsRefusal, rootScriptExtra, checkRootCommands, checkAlwaysScriptGate, rootPkgReads: () => ROOT_PKG_READS };
}

module.exports = { createRootProbes };
