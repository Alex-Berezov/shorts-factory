# ADR-0002: библиотека `@sf/db` принимает подключение параметром, а `DATABASE_URL` читают только её CLI-входы

Дата: 2026-09-06   Статус: принято   Задача: E0-04

## Контекст

§6 System Design задаёт направление `db -> core`: пакет данных не знает про конфигурацию.
До E0-04 `packages/db/src/index.ts` импортировал `@sf/config` и открывал соединение прямо
на импорте модуля (D3), поэтому любой импортёр - `tsc`, vitest, drizzle-kit, сборка web -
требовал разобранного окружения и живой базы.

Одновременно действует hard rule «`process.env` читается только в `@sf/config`» (замок S05
закрывает `packages/db/src/**`), а команды `pnpm db:migrate` и `pnpm db:seed` должны откуда-то
взять строку подключения. Три источника исключают друг друга: своё чтение `process.env`
в `@sf/db` запрещено правилом, `@sf/config` во всём пакете нарушает §6, перенос команд
в `apps/*` привязывает миграции к приложению (E0-06 не сделана) и лишает пакет данных
собственной команды.

## Решение

Граница проходит не по пакету, а по слою внутри пакета:

- **Библиотека** (`src/client.ts`, `src/migrate.ts`, `src/migration-lock.ts`, `src/seed.ts`, `src/repos/**`,
  `src/schema/**`) конфигурации не знает: `createDb(url)`, `closeDb(db)`,
  `runMigrations(url)`, `seedAppSettings(db)` - соединение или его адрес приходит параметром.
  Здесь действует `db -> core`, импорт `@sf/config` запрещён.
- `packages/db/src/cli/**`, `packages/db/test/**` и `packages/db/vitest*.config.ts` -
  единственные места, где `@sf/db` знает про окружение: точки входа (`src/cli/migrate.ts`,
  `src/cli/seed.ts`) берут `env.DATABASE_URL` из `@sf/config` и зовут библиотеку; тесты
  пакета и их конфиги (`vitest.int.config.ts:setupFiles` ссылается на
  `@sf/config/vitest/setup`) читают ту же схему. Ребро `db -> config` существует только
  у них; тесты и их конфиги входят сюда потому, что адрес тестовой базы берётся из той же
  схемы, что и в рантайме, а другого способа не читать `process.env` (S05) у них нет.
- `packages/db/test-support/**` (дополнение 17.10.2026, E0-12A, ADR-0011) - туда же: общая
  фикстура int-наборов (`fixture.ts`) читает `env.DATABASE_URL`/`env.REDIS_URL` из
  `@sf/config` на тех же основаниях, что `test/**`, и отдаётся int-тестам api/worker
  подпутём `@sf/db/test-support/fixture`. Импортируется только из тестов; импорт из `src/**`
  - нарушение этого ADR (замок - `test/dependency-direction.test.ts`).
- Соединение открывается вызовом, а не импортом: у пакета больше нет модульного синглтона
  `db` (D3). Посадка - `test/no-side-effects.test.ts`: импорт `src/index.ts` не создаёт
  клиента и не падает без `DATABASE_URL`.
- `drizzle.config.ts` живёт вне `src` и обходится без строки подключения: из него запускается
  только `generate`, который читает схему.

## Альтернативы

- **`process.env.DATABASE_URL` в `@sf/db`.** Нарушает hard rule и замок S05, обходит fail-fast
  Zod: опечатка в имени переменной превращается в попытку соединения с `undefined`.
- **`@sf/config` во всём пакете (как было).** Тянет разбор окружения в каждого потребителя
  `@sf/db`, включая тесты и генератор миграций; §6 нарушается не в одной точке, а везде.
- **CLI в `apps/api` / `apps/worker`.** `pnpm db:migrate` перестаёт быть командой пакета
  данных; одноразовый сервис миграций в Compose (E0-11) вынужден тянуть образ приложения,
  а сама задача упирается в незакрытую E0-06.

## Последствия

- Направление `db -> core` держится для всего, что импортируют другие пакеты; исключение
  задокументировано в §6 System Design и ограничено `packages/db/src/cli/**`,
  `packages/db/test/**`, `packages/db/test-support/**` (с 17.10.2026, ADR-0011) и
  `packages/db/vitest*.config.ts`. Любой новый импорт `@sf/config` вне этих четырёх мест -
  регресс этого ADR; проверка направления по манифестам (E0-12) обязана знать все четыре.
- Репозитории и раннер принимают `db`/`url` первым аргументом. Это же нужно E0-09
  (`createUsageLogger(db, …)`) и тестам, которые работают с изолированной базой.
- Валидация окружения остаётся одна - схема `@sf/config`; `pnpm db:migrate` наследует
  fail-fast и сообщения про поля.
- `src/cli/**` запускается через `tsx` (решение техлида 06.09, `docs/DECISIONS.md`), потому
  что пакеты воркспейса поставляют исходники. Тем же `tsx` запускается и `drizzle-kit generate`:
  его собственный загрузчик резолвит `require` буквально и спотыкается о NodeNext-импорт
  `./radar.js` в `src/schema/index.ts`.
- CLI молчит при успехе: структурные логи (pino) - слой приложений, а `console.*`
  в `packages/*/src/**` запрещён (S03). Результат команды - код возврата.
- Откат: удалить `src/cli/**`, вернуть `db:migrate` на `drizzle-kit migrate`
  (тогда строка подключения снова нужна в `drizzle.config.ts`) и снять строку исключения
  в §6 System Design.

## Дополнение (дополнено 10.10.2026, E0-11)

Пункт «CLI молчит при успехе» заменён: `db:migrate` и `db:seed` при успехе печатают ровно
одну строку в stdout (`migrations: applied N, M in total` / `migrations: nothing to apply,
M already applied`; `app settings seeded`), отказ - одну строку причины в stderr и код 1.

- Зачем: сервис `migrate` полного стека (`infra/docker-compose.app.yml`) - одноразовый
  контейнер, и `docker compose logs migrate` - единственное место, где оператор видит, что
  он сделал; без строки «применил» и «нечего применять» неразличимы без `psql`
  (TECH_DEBT :62). Подсказка «run db:migrate first» вместо сырого `relation does not exist`
  (:85) - тот же довод.
- Как это сочетается с S03: вывод пишет `process.stdout.write`/`process.stderr.write`
  (`packages/db/src/cli/run.ts`, `processOutput`), а не `console.*`, и только в слое
  `src/cli/**`; библиотечная часть `@sf/db` по-прежнему ничего не печатает и принимает
  подключение параметром. Структурные логи pino остаются слоем приложений.
- Что проверяет: `packages/db/test/cli-run.test.ts` (одна строка, порядок ошибок,
  подсказка). Удалить вывод - регресс этого дополнения, а не возврат к исходному ADR.
- Сопутствующее в том же слое: решение «какая ошибка наружу, если упали и тело, и закрытие»
  одно на пакет - `packages/db/src/cleanup.ts` (`withCleanup`); им пользуются точки входа
  `db:seed`, `db:migrate` и `runSetupCli` (`closeAfter`). `runMigrations` (раннер тестовых
  наборов) `withCleanup` не зовёт: он собирает сбой прогона, сбои шагов возврата и сбой
  закрытия сам и ни одного не теряет (§ E0-12I). Снятие advisory-лока в `migrateDb` под эту
  политику не подпадает (дополнено 10.10.2026, E0-11, /fix круг 2; шаги - по § E0-12I): шаги
  возврата сессии `unlock`, `client_min_messages` и `timeouts` идут по отдельности, ни один не
  бросает, отказ уходит в `onReleaseError` с именем шага (CLI пишет строку в stderr); при
  применённых миграциях раннер возвращает результат, а лок уходит вместе с сессией при закрытии
  соединения. Ожидание лока ограничено `lock_timeout` (`MIGRATION_LOCK_WAIT_MS`, 120 с) с
  понятным текстом отказа.

## Дополнение (дополнено 19.10.2026, E0-12D): `@sf/config` в манифесте `@sf/db`

Граница «Решения» проходит по импортам, а не по манифесту: `@sf/config` стоит в `dependencies`
`packages/db/package.json`, а не в `devDependencies`, и это не нарушение направления `db -> core`,
а его именованное исключение.

- Зачем `dependencies`: образ `migrate` (цель `migrate` в `infra/docker/app.Dockerfile`) ставит пакеты
  `pnpm install --prod --filter @sf/db...` и запускает `src/cli/**`, которым нужна схема
  окружения из `@sf/config`. В `devDependencies` пакет в образ не попадёт, и `db:migrate`
  упадёт на первом импорте. Перенос `@sf/config` в `devDependencies` «по этому ADR» - регресс,
  а не исправление.
- Что держит границу: корневой тест `test/dependency-direction.test.ts`. По манифесту ребро
  `@sf/db -> @sf/config` разрешено как исключение этого ADR (`DB_CONFIG_EXCEPTION`); по
  импортам `@sf/config` в `@sf/db` проходит только в `src/cli/**`, `test/**`,
  `test-support/**` и `vitest*.config.{ts,mts,cts}` - ровно четыре места из «Последствий»;
  импорт в библиотечной части, в `drizzle.config.ts` или упоминание, ставшее импортом, -
  красный тест.

## Дополнение (дополнено 20.10.2026, E0-12H): `createProbeDb` и `closeDb({ timeoutSec })`

Подключение по-прежнему открывается явным вызовом с URL параметром; к `createDb` добавлен второй
вид дескриптора - для проб, у которых каждый вызов кончается не позже предела.

- `createProbeDb(url, { limitMs, statementTimeoutMs, onLimit? })` (`packages/db/src/probe.ts`) -
  отдельный клиент postgres-js `max: 1` на каждую пробу, `connection: { statement_timeout:
  statementTimeoutMs }` и собственный таймер `run(fn)` на `limitMs`. `statementTimeoutMs < limitMs`
  проверяется в конструкторе (`RangeError` с обоими числами). Два предела - на два вида молчания:
  медленный запрос живого сервера снимает сам сервер первым (`57014` -> `timeout` на странице),
  соединение живёт и следующий вызов идёт по нему же; таймер `run` - только для сокета, который
  ответить не может (полуоткрытый): клиент завершается (`$client.end({ timeout: 0 })`: вызов освобождается, сокет закрывается FIN, полуоткрытый живёт до тайм-аута ОС), все
  вызовы на нём - и сработавший, и ждавший за ним на том же соединении - получают `ProbeLimitError`
  (`code: "PROBE_LIMIT"`), отказ висящего запроса и самого `end()` гасятся внутри, `onLimit`
  сообщает вызывающему (api пишет `warn`; своего логгера у `@sf/db` нет), следующий `run` идёт на
  новом клиенте. После `close()` `run` отказывает `ProbeClosedError` (на странице - `error`) и
  клиентов не открывает; `close()` снимает таймеры предела ожидающих вызовов (таймер `run` -
  `unref`, процесс не держит): запрос в полёте несёт предел `close` и отвечает своей работой,
  вызов без ответа после закрытия получает `ProbeClosedError`, клиент повторно не завершается. `close({ timeoutSec })` (предел обязателен) ждёт и
  уничтожаемых клиентов, даже если закрытие текущего отказало; исход один на все вызовы.
- Клиент открывает внутренний помощник `openDb(url, options)` (`packages/db/src/client.ts`) -
  его же зовёт `createDb`; в `index.ts` он не экспортируется (`public-surface.test.ts`), сквозной
  `connection` у `createDb` запрещён: сессионный параметр пробы не должен доехать до миграций.
- Граница: `statement_timeout` - только у probe-клиента, не в `clientOptions`/`createDb`;
  миграции и джобы воркера идут без него. `Query.cancel()` не используется: на полуоткрытом
  сокете ответ на отмену идёт тем же мёртвым путём, а промис отмены postgres-js до 3.4.9
  теряется в `unhandledRejection`. Потребитель - api (`apps/api/src/lib/probe-dbs.ts`,
  `openProbeDbs`: по дескриптору на db-пробу `/health` и на секцию `budget`, пределы
  `PROBE_DB_BOUNDS` - `statementTimeoutMs` = `DEPENDENCY_TIMEOUT_MS` (2 с), `limitMs` =
  `PROBE_QUERY_LIMIT_MS` (4 с)); закрытие набора ждёт все дескрипторы (`allSettled`) и
  отвечает первым отказом.
- Один вызов пробы - один запрос. `statement_timeout` ограничивает каждый statement, таймер
  `run` - весь вызов: три запроса подряд получили бы по 2 с каждый и пережили бы предел 4 с на
  живой медленной базе. Поэтому секция `budget` читает все капы одним `select`:
  `apiUsageLogRepo.sumUsages(db, aggregates, { now })` - по скалярному подзапросу на агрегат,
  у каждого свои провайдеры, окно и часовой пояс, и каждый идёт по индексу
  `api_usage_provider_created_idx` своим диапазоном (`provider`, `created_at`) - без общего
  внешнего фильтра по объединению окон, который заставил бы месячный кап TTS тянуть месяц строк
  всех провайдеров (`sumUsage` - обёртка над ним). Чтение капов для страницы - модульная
  функция `countBudgetChecks(db, limits, providers, { now })` (`packages/db/src/budget.ts`,
  экспорт корня), всегда из базы, без кэша; на `BudgetGuard` её нет - интерфейс, который
  получает джоб, не несёт чтения мимо кэша. `check`/`assert` воркера не меняются. Клиент пробы
  открывается с `fetch_types: false`: по умолчанию postgres-js на каждом новом соединении
  запрашивает `pg_type` до первого запроса - второй statement в одном вызове. Соединение пробы
  по умолчанию ротируется, как у postgres-js (`max_lifetime` 30-60 мин): долгоживущие пробы api
  (`health`, `budget`) после смены узла за адресом или обрыва NAT получают свежее соединение.
  Опция `keepConnection: true` (E0-12O) открывает клиент с `max_lifetime: null` - соединение
  живёт, пока жив дескриптор; её передаёт только клиент проверок тестового прогона
  (`openSessionCheckClient`, `test-support/other-sessions.ts`), на сессии которого держится
  замок прогона: ротация унесла бы замок посреди прогона. Перед открытием
  проба снимает query-параметр `statement_timeout` с `url`: postgres-js раскладывает
  query-параметры DSN поверх `connection`, и параметр из `DATABASE_URL` перекрыл бы предел
  пробы; DSN с ним не запрещается. Оба предела - целые положительные миллисекунды
  (`RangeError` с именем поля), затем `statementTimeoutMs < limitMs`.
- Connect пробы ограничен тем же числом: клиент открывается с
  `clientOptions({ max: 1, connectTimeoutSec: statementTimeoutMs / 1000 })`. Хост, который
  принимает соединение и молчит («чёрная дыра»), даёт `CONNECT_TIMEOUT` раньше `limitMs`, без
  уничтожения клиента и `onLimit`. `createDb` и миграции живут с прежним `CONNECT_TIMEOUT_SEC`
  (10 с).
- «`CONNECT_TIMEOUT` раньше предела» - свойство дескриптора `@sf/db` (предел 4 с), а не страницы
  api. Дедлайн секции api (`withDeadline(DEPENDENCY_TIMEOUT_MS)`, 2 с) равен
  `statementTimeoutMs` и взводится раньше connect, поэтому на «чёрной дыре» api видит свой
  дедлайн первым: `/system/status` показывает `db: down (timeout)`, а не `unreachable`. Это
  принято (решение техлида 20.10.2026, открытый вопрос круга fix 2 E0-12H): `DEPENDENCY_TIMEOUT_MS`,
  `PROBE_QUERY_LIMIT_MS`, `PROBE_DB_BOUNDS`, коды и ранги не меняются. Что даёт connect-предел
  в api - отсутствие уничтожения: connect отказывает до предела, клиент живёт, `warn` о
  пределе не пишется, следующий опрос идёт по тому же клиенту
  (`apps/api/test/system-status.int.test.ts`).
- PgBouncer и другие пулеры. `statement_timeout` уходит startup-параметром сессии. Пулер в
  transaction mode такой параметр отвергает: понадобится `ignore_startup_parameters =
  statement_timeout` в его конфиге или `SET statement_timeout` после connect. `options=` в DSN
  проба перекрывает своим значением. Сейчас пулера в стеке нет; долг не заводится.
- `closeDb(db, { timeoutSec })` передаёт предел в `$client.end({ timeout })`: запрос в полёте
  через `timeoutSec` уничтожается. Без опции поведение прежнее - драйвер ждёт запросы в полёте
  (воркер дожидается джобов, CLI `migrate` держит advisory lock). С пределом зовёт только
  стадия `db` остановки api (`DB_CLOSE_TIMEOUT_SEC` меньше `SHUTDOWN_TIMEOUT_MS`).
- Что проверяет: `packages/db/test/probe.test.ts`, `packages/db/test/probe.int.test.ts`
  (полуоткрытый сокет через `freeze()` реле `packages/db/test-support/relay.ts`; `pg_sleep`
  дольше `statementTimeoutMs` - `57014` на том же соединении),
  `packages/db/test/client.test.ts` (`closeDb`), `packages/db/test/budget.int.test.ts`
  (`countBudgetChecks` - один statement), `apps/api/test/entry-point.int.test.ts`
  (SIGTERM при висящей пробе - код 0). Решение - `docs/TECH_DEBT.md § E0-12H`, п.5, п.6
  (Р3 техлида, 20.10.2026).

## Дополнение (дополнено 20.10.2026, E0-12I): классы сбоев migrate, шаги возврата, migrate-and-seed, дрейф схемы в CI

Сбои CLI `migrate` различимы по классу и тексту, ни один сбой возврата сессии или закрытия не
теряется.

- **Занятый лок - `MigrationLockTimeoutError`** (`packages/db/src/migration-lock.ts` с E0-12S, поле `waitMs` =
  `lockWaitMs`, `cause` - ошибка драйвера, текст - `migrationLockTimeoutMessage(waitMs)`). Ожидание
  лока ограничено одним `lock_timeout`: шаг `lock_wait` ставит `lock_timeout = lockWaitMs` и
  `statement_timeout = 0` (ровно 0), исходные значения сессии читаются заранее (`read_session`) и
  возвращаются сразу после взятия лока одним statement (шаг `timeouts_after_lock`) - миграции идут
  под своими таймаутами сессии. Поэтому занятый лок - только `55P03`: сессия с
  коротким `statement_timeout` всё равно ждёт `lockWaitMs` и получает `MigrationLockTimeoutError`, а
  `57014` на ожидании - только настоящая отмена (`pg_cancel_backend` оператора) и бросается как есть,
  без подсказки про держателя лока (Р4 E0-12I; классификация `57014` «после факта» с замером ожидания и
  вторым текстом снята). Отмена самой миграции (`57014` внутри `migrate`) - тоже как есть. Упавшая
  попытка взять лок перед броском идёт двумя шагами: `unlock` - снимает лок, если сессия его держит
  (отмена может прийти в момент выдачи; условие по `pg_locks`, чтобы не снимать невыданный лок с
  предупреждением сервера в stdout), затем `timeouts` - возвращает оба таймаута; первый упавший шаг
  уходит в `onReleaseError` и останавливает уборку (Р5 E0-12I: на мёртвом соединении каждый
  следующий statement ждал бы `connect_timeout` и печатал следствие раньше причины). Сессия, которая
  держала лок до прогона (`read_session` читает это тем же statement), его не снимает: лок её, а не
  выданный попытке. Текст `unlock` один на оба пути (после прогона и после упавшей попытки);
  ключ в `pg_locks` собирается из обеих половин - `(classid::bigint << 32) | objid::bigint`, `objsubid
  = 1` - раскладка по документации `pg_locks`; прогоном не проверена - ключ < 2^32. CLI печатает класс одной строкой без стека, как `CliError`
  (`runEntry`), код 1.
- **Шаги возврата сессии названы, их три:** `ReleaseStep` = `unlock` | `client_min_messages` |
  `timeouts` (`lock_timeout` и `statement_timeout` одним statement, Р5 E0-12I),
  `onReleaseError(step, error)`. Текст - один источник
  `releaseStepFailure(step, error)` в `src/migration-lock.ts` (Р3 E0-12I, модуль - E0-12S): `releasing the migration lock
  failed: …` для `unlock`, `restoring client_min_messages failed: …`, `restoring lock_timeout and
  statement_timeout failed: …` для `timeouts`; его печатает CLI и им же
  названа ошибка `runMigrations`. Имя шага - открывающий комментарий текста statement (`/* step:lock
  */ select pg_advisory_lock(...)`): его видит лог Postgres, по нему тесты находят шаг; реестра
  объектов в рантайме нет. `MIGRATION_LOCK_KEY` экспортирован из `src/migration-lock.ts`, но не из баррели
  (`public-surface.test.ts`): int-кейс «лок, взятый сессией раньше, переживает упавшую попытку» берёт
  его так, как мог бы вызывающий (Р5 E0-12I). Сбои шагов упавшей попытки взять лок (`unlock`,
  `timeouts`) не проглатываются: первый упавший уходит в `onReleaseError`, брошена по-прежнему
  ошибка попытки.
- **Код выхода при сбое шага возврата (Р1 E0-12I, уточняет Р6 E0-12C):** миграции применены,
  упал шаг возврата - exit 0 и строка в stderr с именем шага: лок кончается вместе с сессией,
  которую CLI закрывает следом, повторный прогон ничего не применит. Exit 1 - лок, миграция,
  любой сбой до возврата результата и сбой закрытия.
- **Порядок «итог -> закрытие»:** строка итога печатается до закрытия соединения. Закрытие,
  упавшее после успешного прогона, - сбой прогона одной строкой, которая говорит, что прогон успел:
  `closing the database connection failed after the run applied 2 migrations: …` / `… after the run
  found no migrations to apply: …`, у `runSetupCli` - с `… and seeded the settings`; код 1. Упала миграция - соединение
  закрывается, сбой закрытия уходит строкой «closing the database connection also failed: …»,
  наружу - сбой миграции.
- **`runMigrations(url)`** (test-support, `resetTestDatabase`) журнал не считает и не теряет
  сбоев: сбой прогона, сбои шагов возврата (`Error` с текстом `releaseStepFailure(step, error)` и
  `cause`) и сбой закрытия собираются по порядку; один бросается как есть (код SQLSTATE виден),
  несколько - `AggregateError`, в тексте которого каждый сбой с кодом (`3 failures: … [42710];
  …`) - стек на границе процесса не теряет второй и третий сбой (`throwFailures`); брошенный
  `undefined` - тоже сбой. В отличие от CLI (Р1) сбой шага возврата здесь - отказ: потребители -
  тестовые наборы, где полувозвращённая сессия - дефект, а не выкладка.
- **Одна политика закрытия:** `withCleanup` (`src/cleanup.ts`) - у `db:seed`, `db:migrate` и
  `runSetupCli`; четвёртый параметр `afterBody(closeError, result)` формулирует сбой закрытия после
  успешного тела по тому, что тело вернуло: CLI миграций называет в нём итог прогона (`MigrationOutcome`)
  и seed.
- **`src/cli/migrate-and-seed.ts` - `runSetupCli`:** миграции и seed в одном процессе на одном
  соединении `max: 1`; seed не идёт после упавшей миграции, сбой шага возврата его не
  останавливает; строки итога миграций и `app settings seeded` печатаются до одного закрытия.
  Таблицу `app_setting` перед seed не спрашивает (в отличие от `db:seed`): миграции, которые её
  создают, только что прошли, и «run db:migrate first» послал бы оператора по кругу; если таблицы
  всё же нет, наружу идёт ошибка драйвера.
  Точка входа образа `migrate`; переключение `CMD` Dockerfile - E0-12J, `pnpm db:migrate` и
  `pnpm db:seed` не меняются.
- **Дрейф схемы в CI** (переписано E0-12S, Р1-Р8 техлида 22.10.2026): правила живут в
  `scripts/check-schema-drift.mjs`; job `ci` зовёт его одним шагом `Schema drift`
  (`timeout-minutes: 5`, после `pnpm test`, до шага `db:migrate`), локально - гейт `schema-drift`
  (`.claude/hooks/rules.sf.json`, та же команда, `timeoutSec` 150 - выше двух прогонов drizzle-kit
  по 60 с и запаса 30 с, так что причину называет скрипт, а не хук). Порядок прогона: версия
  установленного drizzle-kit (`packages/db/node_modules/drizzle-kit/package.json`) равна
  `DRIZZLE_KIT_VERSION` (`0.28.1`), иначе exit 2 - признаки вывода записаны для неё
  (`test/schema-drift-fixture.ts`, юнит запирает равенство версий); `packages/db/migrations` как на
  диске (с незакоммиченной миграцией) копируется во временный каталог
  `packages/db/node_modules/.cache/schema-drift-*` (`COPY_PARENT`; `.cache` создаётся при отсутствии;
  на диске пакета и вне индекса git - `node_modules` в `.gitignore`; не `os.tmpdir()`, который на
  машине разработки лежит на другом диске, Р5 E0-12S; копии `schema-drift-*` старше `STALE_COPY_MS`
  (30 мин - выше `timeoutSec` гейта и предела шага CI, юниты запирают) - остаток прогона, снятого
  снаружи до `finally`, - удаляются при старте, младшие не трогаются: их может держать параллельный прогон);
  `drizzle-kit generate --dialect postgresql --schema ./src/schema/index.ts --out <копия>` пишет
  только в копию (один процесс `process.execPath --import tsx ./node_modules/drizzle-kit/bin.cjs`,
  Р6 E0-12S: загрузчик `tsx` вместо его CLI, так что предел 60 с снимает сам процесс drizzle-kit;
  `cwd: packages/db` от корня репозитория, без оболочки, stdin закрыт - тот же обход через `tsx`,
  что у `db:generate`, Р4 E0-12C; `--config` 0.28.1
  с `--out` не принимает, поэтому значения - константа `DRIZZLE_CONFIG`, юнит требует равенства
  `drizzle.config.ts` целиком: ключ, добавленный в файл, а generate в копии не переданный, краснит юнит; `--out` drizzle-kit читает от рабочего каталога, поэтому копия названа
  относительным путём от `packages/db`); разбор вывода построчно (`classifyGenerate`); сравнение
  файлов копии до и после generate по пути и sha256 - любой добавленный, изменённый или удалённый
  файл - дрейф; копия удаляется в `finally` при любом исходе; затем `drizzle-kit check` по самой
  папке через `drizzle.config.ts` (`classifyCheck`). Исходы generate: `clean`, `wrote`,
  `rename_question` (неоднозначное переименование: при закрытом stdin generate сдаётся на вопросе
  «created or renamed», ничего не пишет и выходит с 0), `snapshot_collision` (две ветки добавили по
  миграции: generate печатает `... which is a collision.` и выходит с 0), `unfinished` (нет
  завершающей строки, сигнал, предел, ненулевой код без известного признака). Исходы check: `fine`
  (код 0 и `Everything's fine`), `inconsistent` (код 1 и коллизия или `data is malformed`),
  `unfinished` (всё прочее, в т.ч. модуль не загрузился). Коды: 0 - чисто; 1 - дрейф (generate
  изменил копию или сказал, что пишет миграцию, вопрос о переименовании, коллизия, `check` нашёл
  папку несогласованной), подсказка и изменённые файлы копии в stderr; 2 - проверка не состоялась
  (сбой запуска, переполнение буфера, предел, нераспознанный вывод generate или check, копия не
  сделана или лежит на другом диске, чем `packages/db`, другая версия drizzle-kit, исключение из
  прогона - `runEntry` переводит его в 2 с текстом, а не в 1 необработанного броска). Дерево прогон
  не трогает: верная незакоммиченная миграция копируется вместе с папкой и гейт не красит, а
  повторный прогон после красного - снова красный (прошлый ничего в дереве не оставил).
  С закрытым stdin generate на вопросе выходит сам за секунды, предел - страховка. Поведение
  drizzle-kit 0.28.1 записано живьём 22.10.2026 (Windows) запуском `--import tsx` и совпадает,
  кроме путей копии и случайного имени миграции, с записью через CLI tsx того же дня и с записанным
  20.10.2026 на Windows и в Linux-контейнере `node:22` (E0-12I). Как перезаписать вывод на новой
  версии drizzle-kit - докблок `test/schema-drift-fixture.ts` (в журнале `DECISIONS.md` Р3 E0-12S
  фикстура названа прежним именем `test/schema-drift-output.ts`).
- **`errorCode` (Р2 E0-12I):** чтение `code` у `unknown` - в `@sf/core`, свой модуль
  `packages/core/src/domain/error-code.ts` (экспорт через `index.ts`, тест
  `packages/core/test/error-code.test.ts`); `domain/errors.ts` - только `AppError` и наследники.
  Владелец - `@sf/core`: ядро без зависимостей видно всем пакетам, кроме `@sf/config`; копии
  в `@sf/runtime` и `@sf/db` сняты, копии в `@sf/config` остаются строкой долга (ребро
  `config -> core` закрыто S15/S16). Модуль `src/failures.ts` в `@sf/db` - `describeError` и
  `throwFailures` - не импортирует ни `migrate.ts`, ни `migration-lock.ts` (Р3 E0-12I): имена шагов лока
  (`LockStatement`) и тексты шагов возврата живут в `migration-lock.ts`, шаг журнала `count_journal`
  (`MigrateStatement` = `LockStatement | "count_journal"`) - в `migrate.ts`; оба называют шаги через
  `stepNamer` и не знают имён друг друга.
- Что проверяет: `packages/db/test/cli-run.test.ts` (тексты по шагу, итог до закрытия, текст
  сбоя закрытия по итогу прогона, коды выхода Р1, класс без стека, `runSetupCli`, точки входа),
  `packages/db/test/failures.test.ts` (`throwFailures`), `packages/db/test/cleanup.test.ts`
  (`afterBody`), `packages/db/test/migrate.int.test.ts` (подмена шага по имени `failStep` из
  `test/migrate-steps.ts`, `statement_timeout` 0 на ожидании и свой под локом, короткий
  `statement_timeout` сессии -> `55P03`, `pg_cancel_backend` ожидающей сессии -> `57014` как есть,
  снятие лока, выданного упавшей попытке, лок, взятый сессией до прогона (`held`), переживает упавшую
  попытку, `57014` внутри миграции, шаг `lock_wait`, шаги возврата `unlock`/`client_min_messages`/`timeouts` по имени, `runMigrations` бросает `42710` как есть, точка входа
  `migrate-and-seed.ts` с пустой базы), `packages/db/test/run-migrations.int.test.ts` (проводка
  сбоев возврата и закрытия в `runMigrations`, лок на момент закрытия, `resetTestDatabase` без подсчёта
  журнала), помощники `heldAdvisoryLocks`/`waitForAdvisoryWaiter` - `packages/db/test-support/advisory-locks.ts`
  (фильтр по базе соединения), `test/ci-config.test.ts` («checks that the
  migrations match the schema»: один шаг `Schema drift`, старые три не вернулись, путь бинаря
  drizzle-kit и загрузчик `--import` скрипта равны скриптам манифеста, предел шага выше двух прогонов
  drizzle-kit и ниже `STALE_COPY_MS`), `test/check-schema-drift.test.ts` (исход на каждый случай на записанном выводе
  drizzle-kit 0.28.1 `test/schema-drift-fixture.ts`, копия во временном каталоге, повторный прогон
  после красного, `DRIZZLE_CONFIG` равен `drizzle.config.ts`, копия на другом диске, удаление
  остатков старше `STALE_COPY_MS`, `runEntry`, число запусков = `DRIZZLE_KIT_RUNS`, проба `when` и `timeoutSec` гейта
  `schema-drift` через `test/gate-choice.ts`), проба гейта в `.claude/hooks/harness-selftest.js`. Решение - `docs/TECH_DEBT.md § E0-12I`, § E0-12S.
