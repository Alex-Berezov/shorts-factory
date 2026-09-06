# Журнал работ

_Добавляется автоматически командами `node scripts/tasks.mjs done|block`. Хронологический порядок: старые записи сверху, новые снизу. Ручные заметки допустимы — добавлять в конец в том же формате._

- 2026-09-05 📝 Декомпозированы эпики E0–E13 (`docs/30_E0_TASKS.md` … `docs/43_E13_TASKS.md`), заведён трекер задач (`docs/tasks/tasks.json`, `scripts/tasks.mjs`, `docs/00_STATUS.md`).
- 2026-09-05 🛠 Собрана обвязка автономной разработки: `.claude/` (11 агентов, 10 команд, 8 хуков, правила, самопроверка), `docs/60_HARNESS.md`, `docs/61_HOW_TO_WORK.md`, `docs/DECISIONS.md`, `docs/TECH_DEBT.md`; репозиторий инициализирован (`git init`, ветка `main`).
- 2026-09-06 ➕ **E0-01A** Включить гейт build в rules.sf.json (добавлена в трекер)
- 2026-09-06 ✅ **E0-01** Установка тулчейна и зелёные `lint` + `typecheck` на скелете — тулчейн Node 22 + pnpm, lockfile, конфиги Next/Tailwind, зелёные lint/typecheck/build
- 2026-09-06 ⛔ **E0-01A** blocked — harness write blocked: session safety layer denies Write/Edit/Bash into .claude/** (task-current, unlock.txt, scope.txt) despite dontAsk mode and explicit allow rule in user global settings.json; not a project hook, unlock.txt cannot fix it
- 2026-09-06 ⛔ **E0-01A** blocked — внешнее предусловие: session permission layer запрещает Write/Edit/Bash-запись в .claude/.task-current, .claude/scope.txt, .claude/unlock.txt даже в режиме dontAsk/bypassPermissions - нужна ручная проверка режима разрешений сессии
- 2026-09-06 ⛔ **E0-02** blocked — внешнее предусловие: session permission layer запрещает Write/Edit/Bash-запись в .claude/.task-current, .claude/scope.txt, .claude/unlock.txt даже в bypassPermissions - та же блокировка, что у E0-01A; DoD требует правки защищённого rules.sf.json через unlock.txt
- 2026-09-06 ➕ **E0-02A** Включить гейты test и test:int в rules.sf.json (добавлена в трекер)
- 2026-09-06 ⛔ **E0-02A** blocked — внешнее предусловие: слой разрешений сессии отклоняет любую запись в .claude/** (Write/Edit/Bash) при bypassPermissions и явном allow - снимается только вручную владельцем; исполняется одним заходом с E0-01A
- 2026-09-06 ⛔ **E0-02** blocked — внешнее предусловие: (1) .env.test не создать - deny-правило Read(**/.env.*) закрывает и запись, файл требует DoD; (2) в рабочем дереве чужая незакоммиченная переделка обвязки (удалены protect-files/scope/qa-lock/diff-boundaries), коммит задачи затянул бы её
