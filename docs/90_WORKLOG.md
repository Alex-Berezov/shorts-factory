# Журнал работ

_Добавляется автоматически командами `node scripts/tasks.mjs done|block`. Хронологический порядок: старые записи сверху, новые снизу. Ручные заметки допустимы — добавлять в конец в том же формате._

- 2026-09-05 📝 Декомпозированы эпики E0–E13 (`docs/30_E0_TASKS.md` … `docs/43_E13_TASKS.md`), заведён трекер задач (`docs/tasks/tasks.json`, `scripts/tasks.mjs`, `docs/00_STATUS.md`).
- 2026-09-05 🛠 Собрана обвязка автономной разработки: `.claude/` (11 агентов, 10 команд, 8 хуков, правила, самопроверка), `docs/60_HARNESS.md`, `docs/61_HOW_TO_WORK.md`, `docs/DECISIONS.md`, `docs/TECH_DEBT.md`; репозиторий инициализирован (`git init`, ветка `main`).
- 2026-09-06 ➕ **E0-01A** Включить гейт build в rules.sf.json (добавлена в трекер)
- 2026-09-06 ✅ **E0-01** Установка тулчейна и зелёные `lint` + `typecheck` на скелете — тулчейн Node 22 + pnpm, lockfile, конфиги Next/Tailwind, зелёные lint/typecheck/build
- 2026-09-06 ⛔ **E0-01A** blocked — harness write blocked: session safety layer denies Write/Edit/Bash into .claude/** (task-current, unlock.txt, scope.txt) despite dontAsk mode and explicit allow rule in user global settings.json; not a project hook, unlock.txt cannot fix it
- 2026-09-06 ⛔ **E0-01A** blocked — внешнее предусловие: session permission layer запрещает Write/Edit/Bash-запись в .claude/.task-current, .claude/scope.txt, .claude/unlock.txt даже в режиме dontAsk/bypassPermissions - нужна ручная проверка режима разрешений сессии
