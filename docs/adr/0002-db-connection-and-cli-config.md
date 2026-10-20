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

- **Библиотека** (`src/client.ts`, `src/migrate.ts`, `src/seed.ts`, `src/repos/**`,
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
  одно на пакет - `packages/db/src/cleanup.ts` (`withCleanup`); им пользуются раннер
  (`runMigrations`) и точки входа (`closeAfter`). Снятие advisory-лока в `migrateDb` под эту
  политику не подпадает (дополнено 10.10.2026, E0-11, /fix круг 2): unlock и возврат
  `client_min_messages` идут отдельными шагами, ни один не бросает, отказ уходит в
  `onReleaseError` (CLI пишет строку в stderr); при применённых миграциях раннер возвращает
  результат, а лок уходит вместе с сессией при закрытии соединения. Ожидание лока ограничено
  `lock_timeout` (`MIGRATION_LOCK_WAIT_MS`, 120 с) с понятным текстом отказа.

## Дополнение (дополнено 19.10.2026, E0-12D): `@sf/config` в манифесте `@sf/db`

Граница «Решения» проходит по импортам, а не по манифесту: `@sf/config` стоит в `dependencies`
`packages/db/package.json`, а не в `devDependencies`, и это не нарушение направления `db -> core`,
а его именованное исключение.

- Зачем `dependencies`: образ `migrate` (`infra/docker/migrate.Dockerfile`) ставит пакеты
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
  запрашивает `pg_type` до первого запроса - второй statement в одном вызове. Перед открытием
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
