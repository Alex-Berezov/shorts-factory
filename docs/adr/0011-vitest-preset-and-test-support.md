# ADR-0011: корневой пресет vitest, корневой тестовый проект и test-support `@sf/db` с одним стражем стека

Дата: 2026-10-17   Статус: принято   Задача: E0-12A (решения техлида Р1-Р5 17.10.2026, `docs/DECISIONS.md`)

Уточняет ADR-0010 (виды тестов и изоляция от разработки остаются как есть); меняется то, где
записана тестовая политика и откуда наборы берут фикстуру и страж.

## Контекст

Тестовая политика была записана двенадцать раз: девять `vitest.config.ts` и три
`vitest.int.config.ts` почти дословно повторяли друг друга, и у `apps/api/vitest.int.config.ts`
не было `fileParallelism: false`, хотя его файлы делят одну базу и одну Redis-базу. Стражей
локального стека было три (`packages/db`, `apps/api`, `apps/worker`) с двумя литералами имени
тестовой базы и без проверки порта: `.env.test` с `localhost:5432` проходил хост и имя, и
`resetTestDatabase` ронял бы схемы в чужом локальном Postgres. Хелперы тестовой базы
(`openTestDb`, сброс) были скопированы в воркер. У корня репозитория не было своего тестового
места: тесты про то, что не принадлежит ни одному пакету, жили в `apps/worker/test`.

## Решение

- **Пресет** - корневой `vitest.preset.ts`, импортирует только `vitest/config`:
  `unitTestConfig({ setupFiles?, testDirs? })` (среда node, `test/**/*.test.ts` и
  `src/**/*.test.ts`, без `**/*.int.test.ts`; `testDirs` только сужает: `apps/web` ищет тесты
  в одном `test/`, как до пресета, - `*.test.ts` под `src/` у него модуль Next без setup) и
  `intTestConfig({ setupFiles, entryCheck, testTimeout?, hookTimeout? })` (`**/*.int.test.ts`;
  всегда, не опцией, - `fileParallelism: false` и `globalSetup` входной проверки стека, см.
  «Входная проверка» ниже; `entryCheck` обязателен и выбирает только какую проверку, а не
  будет ли она). Пакеты импортируют его
  относительным путём (`../../vitest.preset.js`), а не через пакет воркспейса: `@sf/core` не
  зависит ни от чего, кроме `zod` (§6), а пресет-пакет стал бы зависимостью каждого пакета.
  `vitest ^2.1.0` - в `devDependencies` корня (без него пресет не резолвит `vitest/config`).
- **Тонкие конфиги**: `vitest.config.ts` и `vitest.int.config.ts` пакетов - вызов пресета
  (int-конфиг - `intTestConfig`, остальные - `unitTestConfig`);
  `include`/`exclude`/`environment`/`fileParallelism`/`globalSetup` сами не задают. `apps/web` добавляет свои
  `resolve.alias` и `esbuild` через `mergeConfig` и сужает поиск до `test/` (`testDirs`). `setupFiles` int-конфига - литеральный массив
  в самом тонком конфиге: `harness-selftest` читает его из файла по `--config` скрипта `test:int`.
  Пакеты между собой идут по одному (`turbo run test:int --concurrency=1`), файлы пакета - по
  одному (пресет).
- **Корневой тестовый проект**: тесты в `test/*.test.ts` корня, конфиг `vitest.repo.config.mts`
  (не `vitest.config.*`, чтобы голый `vitest` в корне не собрал тесты всех пакетов; `.mts`, потому
  что корневой пакет - CommonJS ради хуков `.claude/hooks/*.js`), корневой `tsconfig.json`
  (`module: ESNext`, `moduleResolution: Bundler` - так тесты исполняет vitest). Скрипты корня
  `test:repo`/`typecheck:repo`; `pnpm test` = `turbo run test test:repo`, `pnpm typecheck` =
  `turbo run typecheck typecheck:repo`, задачи `//#test:repo`, `//#typecheck:repo` в `turbo.json`.
  Первый житель - `test/vitest-preset.test.ts`: замок «копий нет» (каждый `vitest*.config.*`
  пакета - `.ts`/`.mts`/`.cts`/`.js`/`.mjs`/`.cjs` - импортирует пресет, int-конфиг зовёт
  `intTestConfig`, остальные - `unitTestConfig`, ключей пресета не задаёт ни голыми, ни в
  кавычках, ни сокращённой записью `{ include }`; каждый int-конфиг, загруженный как его грузит
  vitest, стоит за своей входной проверкой с `fileParallelism: false` и `setupFiles`
  `@sf/config/vitest/setup`) и `--concurrency=1` у `test:int`.
- **Входы turbo**. `$TURBO_DEFAULT$` корневых задач `//#...` хеширует весь репозиторий, а не
  только файлы вне пакетов (`turbo run test:repo --dry=json`, turbo 2.10: 440 входов, из них 181
  под `apps/` и 139 под `packages/`), поэтому у `//#test:repo` и `//#typecheck:repo` явных glob
  нет: они вводили бы в заблуждение (замок сканирует `.mts`, glob ловили только `.ts`). Новый
  `.mts`-конфиг пакета и правка `apps/web/vitest.config.ts` - cache miss у обеих корневых задач
  (пробы 17.10.2026, файл дела E0-12A). `vitest.preset.ts` - во входах задач `test`, `test:int`,
  `typecheck` (`$TURBO_ROOT$/vitest.preset.ts`), а не в `globalDependencies`: правка пресета -
  miss у всех `test`/`typecheck` пакетов и корня, новый хеш `test:int`, а кэш `build` web не
  сбрасывается (`lint` - `biome check .` вне turbo).
- **Переезд репо-тестов (E0-12F).** `ci-config`, `compose-rules`, `container`, `dockerfile`,
  `probe-image` и разборщик `dockerfile.ts` переехали из `apps/worker/test` в корневой `test/`;
  кейс образа migrate из `packages/db/test/cli-run.test.ts` - в `test/container.test.ts`
  (Dockerfile разбирает только `test/dockerfile.ts`). В `@sf/worker` осталось звено
  `scripts.dev == DEV_COMMAND` (`apps/worker/test/dev-command.test.ts`); образ сверяется со
  `scripts.dev` в корне. `.env.test` ушёл из корневого `test.inputs` к пакетам-читателям (config,
  db, runtime, api, worker; `.env.example` - только config) - их `turbo.json`; выигрыш - core,
  contracts, api-client, остальные сбрасываются через `^test`. Замки входов - функции нарушений
  в `test/turbo-inputs.test.ts`: точный корневой `test.inputs`, `extends`/`$TURBO_EXTENDS$` у
  каждого `turbo.json` пакета, `.env.test` ровно у читателей (скан исходников), корневые задачи
  без `!`-исключений, порядок `test:int` через `^test:int`.
- **test-support `@sf/db`** - каталог `packages/db/test-support/` вне `test/` (vitest не
  собирает его как тесты), подпути `exports`:
  - `@sf/db/test-support/stack-guard` - ничего не импортирует, проверяется в `pnpm test`:
    `TEST_STACK` (локальные хосты, порт Postgres `5442`, база `shorts_factory_test`, порт Redis
    `6389`, Redis-база `.env.test` - `1`), реестр `TEST_REDIS_DATABASE_OF = { worker:
    TEST_STACK.envRedisDatabase, api: "2" }` (новый набор добавляет строку, а не выбирает
    номер), **один страж на все наборы** - две функции, по одной на сервис,
    `assertLocalTestPostgres(databaseUrl)` и `assertLocalTestRedis(redisUrl)`: схема
    (`postgres:`/`postgresql:`, `redis:`), хост, порт и база у обоих URL, URL без порта (=
    5432/6379 по умолчанию) - отказ, строка запроса (`?host=` и любые другие параметры
    драйвера) - отказ; хост - так, как его прочтёт драйвер, а не только `new URL`: postgres-js
    3.4 берёт хост после первого `@`, раскодирует `%` и читает `,` как список хостов, `new URL` -
    после последнего `@`, поэтому второй `@`, `,` или `%` в хосте, пробел, управляющий символ,
    `\` и `#` - отказ до разбора, а `host` из `new URL` обязан буква в букву совпасть с хостом
    драйвера (`sf:sf@db.example.com,x@localhost:5442` - отказ; тест сверяет кейсы с
    `sql.options.host` самого postgres-js); URL, который не разбирается, - отказ без текста URL
    (в `TypeError` от `new URL` был бы пароль); `assertTestDatabaseName(name)` - для ответа
    `current_database()`; `suiteRedisUrl(redisUrl, suite)` - сначала `assertLocalTestRedis`
    по URL окружения, затем тот же сервер в базе набора: открыть Redis набора мимо стража нельзя;
  - `@sf/db/test-support/fixture` - только для int-наборов (читает `env` из `@sf/config`: ребро
    `db -> config` у `test-support/**` - то же исключение, что у `test/**`, записано в §6 System
    Design и ADR-0002; из `src/**` фикстура не импортируется, замок - E0-12D): `openTestDb`,
    `openTestSql` (оба сначала зовут Postgres-половину стража; Redis-URL их не касается),
    `emptyTestDatabase` (через свой `openTestSql`; страж по URL и по `current_database()`
    перед `DROP SCHEMA`), `resetTestDatabase` (`emptyTestDatabase` и миграции), `assertMigrated()` - проверка int-набора,
    который сам не мигрирует: страж всего стека (Redis тоже - процессы воркера читают
    `REDIS_URL` как есть), свой клиент через `openTestSql` и его закрытие, сверка миграций
    базы с папкой `migrationsFolder` (один экспорт пути из `src/migrate.ts`, не через баррель)
    по `when` и по `hash` (sha256 файла, как его считает `readMigrationFiles` drizzle: правка
    применённого `.sql` - отказ «edited after it was applied»; две строки одной миграции -
    отказ «applied more than once»), недоступная база - отказ с адресом из `.env.test`, а при
    `ECONNREFUSED`/`ECONNRESET`/`ETIMEDOUT`/`CONNECT_TIMEOUT` - и с подсказкой про Compose и
    `.env.test`; `defaultQueueSwitches` (реэкспорт из `src/seed.ts`, в баррель не входит);
  - **входная проверка** - `@sf/db/test-support/entry-check/postgres` и
    `.../entry-check/migrated-stack`, `globalSetup` vitest, который `intTestConfig` ставит
    безусловно (`entryCheck: "postgres"` у `@sf/db`, `"migrated-stack"` у api и worker): один
    раз на прогон пакета, до первого файла, сначала грузит `@sf/config/vitest/setup` (то же
    окружение, что увидят файлы), затем `assertLocalTestPostgres` или `assertMigrated()`.
    Отказ останавливает прогон до того, как любой файл откроет соединение, - каким бы хелпером
    он ни пользовался или ни одним (живая проба 17.10.2026: «no tests» и одна строка отказа).
    Хелперы `openTestDb`/`openTestSql`/`openTestRedis` проверяют свой URL ещё раз, int-файлы api
    и worker открывают базу только через `openTestDb`.
  Чистый сравнитель - `test-support/migration-check.ts`, вне `exports`, тесты -
  `packages/db/test/migration-check.test.ts`; порядок вызовов фикстуры и входных проверок
  (страж до клиента) - `packages/db/test/fixture.test.ts` на подменённых окружении и
  драйвере. Тихий логгер в
  `@sf/db` не переносится (`pino` в нём нет): один `silentLogger` на приложение, общий - E0-12B.
- Старые адреса (`@sf/db/test/local-host-guard.js`, `packages/db/test/helpers.int.ts`,
  `apps/{api,worker}/test/local-stack-guard.ts`) удалены; старый подпуть отвечает
  `ERR_PACKAGE_PATH_NOT_EXPORTED` (`packages/db/test/public-surface.test.ts`).
- **Границы** (решение техлида 17.10.2026, круг 2): корень репозитория пакеты берут только из
  `@sf/config/paths` (`repoRoot`, `testEnvFilePath`), корневые тесты и `scripts/*.mjs` - только
  из `scripts/lib/paths.mjs` (E0-12F); перекрёстных импортов нет. Подпуть `./paths` держит
  явный кейс `packages/config/test/exports.test.ts`.

## Альтернативы

- **Пресет в `@sf/config/vitest/preset`** или отдельный пакет `@sf/vitest-preset` - `@sf/core`
  и `contracts` получили бы зависимость от `@sf/*` (§6, S07, решение 06.09.2026); core остался
  бы с копией, и «копий нет» не выполнялось бы.
- **Корневой проект как пакет воркспейса `tooling/repo-tests`** - новая сущность, а пресету в
  корне `vitest` всё равно нужен.
- **`setupFiles` внутри пресета** - `harness-selftest` не видит, что читает `test:int`, и гейт
  перестаёт выбираться по факту чтения.
- **Страж в каждом приложении поверх общих проверок** (как было) - два имени одного понятия,
  литералы номеров Redis-баз в двух файлах, третий набор выбирает номер наугад.

## Последствия

- Правка тестовой политики - одна строка в `vitest.preset.ts`; она выбирает гейт `test:int`
  (`.claude/hooks/rules.sf.json`, проба в `harness-selftest`) и входит в хеш задач `test`,
  `test:int`, `typecheck` и корневых задач, но не `build`.
- Новый int-набор получает входную проверку вместе с `intTestConfig`: забыть хелпер со стражем
  больше нельзя; проверка миграций идёт один раз на прогон пакета, а не на каждый int-файл.
- Новый пакет с тестами добавляет тонкий конфиг; без пресета его поймает
  `test/vitest-preset.test.ts`.
- Разработчик с Compose на нестандартных портах получает отказ всех int-наборов с названием
  порта и `.env.test` - намеренно.
- `pnpm --filter @sf/api test:int` или `@sf/worker` на немигрированной базе или с правленым
  применённым файлом миграции красный до первого файла, с причиной («run `pnpm db:migrate`
  against .env.test or `pnpm --filter @sf/db test:int` first»); без поднятого Compose - «is the
  local Compose stack up ... and .env.test pointing at it?».
- `@sf/config` получил подпуть `./paths` (`repoRoot`, `testEnvFilePath`; `browser` - на модуль
  с маркером, как у остальных подпутей): тест стража сверяет `TEST_STACK` с `.env.test` тем же
  путём и тем же `parseEnv`, что и загрузчик.
- Типы Node в корневом проекте приходят транзитивно через `vitest` -> `vite`; явного
  `@types/node` в корне нет (решение 06.09.2026, E0-01: корневой `@types/node` протекает в
  `@sf/core`).
