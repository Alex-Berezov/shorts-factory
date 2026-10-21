# Гайд разработчика: новый роут, новый job, новая таблица

_Дата: 2026-10-10 (E0-13). Как поднять окружение - `README.md`, «Getting started». Почему всё
устроено именно так - раздел «ADR» ниже._

Рецепт - порядок правок и одна строка «почему» на шаг. Подробности живут в docblock'ах
названных файлов; здесь их не повторяем. Каждый шаг с поведением закрывается тестом, который
краснеет без правки (`CLAUDE.md`, hard rules).

## 1. Новый роут API (контракт → api → клиент)

Устройство - ADR-0007 (контракты), ADR-0006 (авторизация).

1. **Схема** запроса и ответа - в `packages/contracts/src/<модуль>.ts`, типы только через
   `z.infer`; реэкспорт строкой в `packages/contracts/src/index.ts`.
   _Почему:_ одну схему читают api (валидация, OpenAPI) и `@sf/api-client`, второго описания нет.
   Из `@sf/core` сюда можно брать только реестры значений `as const` и коды ошибок
   (ADR-0007).
2. **Модуль роутов** - `apps/api/src/routes/<модуль>/index.ts`, экспорт
   `registerRoutes(app: AppInstance, deps: AppDeps)`. Внутри:
   `const responses = { ...errorResponses(), [OK_STATUS]: Schema }` и
   `defineRoute(app, { method, url, responses, schema: { summary, tags, params, body }, ...options }, handler)`
   (`errorResponses`, `OK_STATUS`, `defineRoute` - из `apps/api/src/lib/route-schemas.ts`;
   образец - `apps/api/src/routes/system/index.ts`). Прямых `app.get`/`app.route` в модуле роутов нет:
   помощник сам кладёт `responses` в `schema.response` и выводит тип ответа хендлера
   (`SuccessReply<typeof responses>`), а `schema` с собственным `response` не компилируется.
   _Почему:_ конверт ошибки попадает в OpenAPI и в сериализатор, а тип ответа читается с той же
   схемы - обработчик не может вернуть конверт ошибки вместо ответа
   (`apps/api/src/routes/README.md`). Штатный не-2xx статус со своим телом - через
   `withErrorEnvelope()` из того же модуля.
   _Замки:_ стандарты S13/S14 (`.claude/hooks/rules.sf.json`) при записи файла в
   `apps/api/src/routes/` ловят регистрацию роута мимо `defineRoute` (`.get`/`.post`/… с `(` или `<`,
   `.route(`, `withTypeProvider` на любом получателе) и `defineRoute(` в файле без
   `...errorResponses()` в коде (упоминание в комментарии не в счёт); `apps/api/test/define-route.test.ts`
   держит типы помощника под `tsc`; `apps/api/test/route-shape.test.ts` в
   `pnpm test` проверяет каждый зарегистрированный роут: `4xx`/`5xx` и каждый точный статус
   400-599 несут конверт ошибки, ключ `200` есть. Новый роут попадает в его список «ровно эти
   роуты» отдельной строкой.
3. **Ошибки** - бросать `AppError` из `@sf/core` (`ValidationError`, `NotFoundError` и т.п.),
   а не собирать ответ руками: конверт `{ error: { code, message, requestId, details? } }`
   строит обработчик ошибок api.
4. **Зависимости роута** (база, Redis, проба) - полем в `AppDeps` (`apps/api/src/deps.ts`),
   а не импортом соединения в модуле роута. _Почему:_ юнит-тест подменяет их в `buildTestApp`.
5. **Регистрация** - строка в `apps/api/src/routes/index.ts`.
6. **Авторизация** - ничего не делать: глобальный хук `apps/api/src/plugins/auth.ts` закрывает
   паролем любой новый роут. Публичный роут - только явной строкой в `PUBLIC_ROUTES`, и это
   решение, а не правка (сегодня там только `/health`).
7. **Метод клиента** - в `ApiClient` и в возвращаемом объекте `createApiClient`
   (`packages/api-client/src/client.ts`) через внутренний `request(path, Schema, { authorized: true })`.
   Если роут штатно отвечает не-2xx со своим телом - `answerStatuses` из списка статусов
   контракта (как `HEALTH_STATUS_CODES` у `/health`), а не проверка `response.ok` (урок L-013).
   Web вызывает клиент только из серверного кода (`apps/web/src/lib/api.server.ts`).
8. **Тесты:**
   - юнит api - `apps/api/test/<модуль>.test.ts`: `buildTestApp()` и `TEST_PASSWORD`/`AUTH_HEADER`
     из `apps/api/test/helpers.ts`, запросы через `app.inject`; кейс без пароля → 401;
   - интеграционный - `apps/api/test/<модуль>.int.test.ts`, если роут читает или пишет БД/Redis
     (образец - `apps/api/test/system-status.int.test.ts`; страж стека и Redis-база набора - через
     `apps/api/test/helpers.int.ts`, общий страж - `@sf/db/test-support/stack-guard`, ADR-0011;
     команда клиенту Redis - после `whenReady(redis)` оттуда же: без офлайн-очереди команда до
     `ready` отклоняется);
   - клиент - `packages/api-client/test/client.test.ts`: фейковый `fetch` из опций клиента,
     кейс на каждое состояние ответа, включая штатные не-2xx (L-013).

## 2. Новый job (`defineJob` → реестр → cron)

Устройство - ADR-0008 (DLQ), ADR-0009 (id), ADR-0003 (переключатели очередей).

1. **Имя очереди** - в `QUEUE_NAMES` (`packages/core/src/domain/queues.ts`); имена и смысл
   очередей - `docs/10_SYSTEM_DESIGN.md` §4.
   _Почему:_ реестр один на воркер, seed и контракты `/system`.
2. **Билдер id** - именованный метод в `jobIds` (`packages/core/src/domain/job-ids.ts`) и юнит-кейс
   в `packages/core/test/job-ids.test.ts` со строковым литералом ожидания.
   _Почему:_ `jobId()` из процессора - путь к расхождению формата; части проверяет `segment()`
   (без `/` и `:`, число - безопасное целое ≥ 0).
3. **Определение** - `apps/worker/src/jobs/<имя>.ts`:
   `export const xxxJob = defineJob({ queue, payloadSchema, jobIdFrom: (p) => jobIds.xxx(...), handler })`
   (`defineJob` - `apps/worker/src/lib/define-job.ts`; образец - `apps/worker/src/jobs/system-smoke.ts`).
   Payload - строгая Zod-схема (`.strict()`); числовое поле payload, которое идёт в `jobIds`, -
   `z.number().int().nonnegative().safe()` (правило `segment()`, ADR-0009), иначе отказ придёт
   из `jobIdFrom`, а не из схемы. Ретраи, `removeOnComplete`/`removeOnFail`
   и копия в DLQ приходят из `DEFAULT_JOB_OPTIONS` (`apps/worker/src/lib/job-policy.ts`) сами.
4. **Регистрация процессора** - строка в `JOB_PROCESSORS` (`apps/worker/src/jobs/index.ts`).
   _Почему:_ `Worker` стартует только для очередей с записью здесь; без неё очередь просто копит
   job'ы.
5. **Cron** (если нужен) - объявление `{ queue, id, pattern }` в `SCHEDULES`
   (`apps/worker/src/schedules.ts`). Воркер при старте сводит планировщики Redis к этому списку:
   удалённая строка удаляет планировщик.
6. **Переключатель** `queues.enabled` - отдельной правки нет: `packages/db/src/seed.ts`
   (`defaultQueueSwitches`) строит ключи из `QUEUE_NAMES`. На уже засеянной базе после
   добавления очереди - `pnpm db:seed`: seed дописывает недостающий ключ, значения оператора
   не трогает. Без ключа воркер пишет `warn` и состояние очереди не трогает (ADR-0003).
7. **Стоимость** внешнего вызова - `ctx.usage(entry)` до возврата из обработчика, в том числе
   на ветке ошибки (hard rule, урок L-006); `entry` разбирается `ApiUsageEntrySchema`
   из `@sf/core`, `jobId` логгер проставляет сам.
8. **Бюджет** - платный вызов предваряется `await ctx.budget.assert(provider)`: он бросает
   `BudgetExceededError` при достигнутом капе, и `defineJob` не тратит на него ретраи.
   Страж процесса строит `createWorkerBudgetGuard` (`apps/worker/src/lib/budget.ts`), привязку
   провайдера к капу - `budgetScopeFor` (`packages/core/src/domain/budget.ts`). У провайдера без
   капа `assert` бросает `ValidationError` - такой провайдер сначала получает кап.
9. **Тесты:** юнит обработчика и `jobIdFrom` - `apps/worker/test/<имя>.test.ts` (фейки зависимостей -
   `apps/worker/test/job-deps.ts`); путь через настоящий Redis и Postgres -
   `apps/worker/test/<имя>.int.test.ts` (образец - `apps/worker/test/smoke.int.test.ts`);
   новый билдер id прогоняется через настоящий `queue.add` в `apps/worker/test/job-id.int.test.ts`.

## 3. Новая таблица (схема → generate → repo)

Устройство - ADR-0002 (подключение `@sf/db`).

1. **Схема** - `pgTable` в `packages/db/src/schema/<область>.ts` (`radar`, `intelligence`,
   `idea-flow`, `own-channel`, `experiments`, `system`); новый файл - реэкспорт в
   `packages/db/src/schema/index.ts`. Модель данных - `docs/10_SYSTEM_DESIGN.md` §5.
2. **Миграция** - `pnpm db:generate --name <epic>` (например `--name radar`), файл
   `packages/db/migrations/NNNN_<epic>.sql`.
   _Почему `--name`:_ без него drizzle-kit придумывает случайное имя, а переименование файла
   ломает раннер, который ищет миграцию по имени из `migrations/meta/_journal.json` (`README.md`).
   CI краснеет на схеме без миграции (`db:generate` + пустой `git status` папки миграций +
   `db:check`); локально папку миграций проверяет `pnpm --filter @sf/db db:check`.
3. **Применённую миграцию не править** - только новая миграция. Применить: `pnpm db:migrate`
   (база разработки) и миграция тестовой базы (`README.md`, «Getting started», шаг 7).
4. **Репозиторий** - `packages/db/src/repos/<таблица>.ts` объектом `xxxRepo` с функциями
   `(db: Db, ...)`, образец - `packages/db/src/repos/app-setting.ts`; экспорт - в
   `packages/db/src/index.ts`. _Почему `db` параметром:_ библиотека не открывает соединение
   сама (ADR-0002).
5. **Идемпотентность записи** держит уникальный индекс (`uniqueIndex` в схеме) и
   `onConflictDoNothing`, а не `select` перед `insert` (урок L-007). Для AI-выводов
   (Content DNA, ресёрч, скрипт и т.п.) только `insert` новой версии с `model`,
   `prompt_version`, `cost`: `onConflictDoUpdate` и `update` по существующей строке нарушают
   правило «ничего не перезаписывается» (`CLAUDE.md`, hard rules). `onConflictDoUpdate`
   допустим для счётчиков и настроек (`app_setting`), не для результатов модели.
   Требования к новой таблице (`created_at`, индекс под FK, partial unique, `pgEnum`,
   `numeric` для денег, `bigint` для счётчиков, Zod-схема на JSONB) - `docs/10_SYSTEM_DESIGN.md` §5
   и чек-лист `.claude/agents/review-data.md`, пункты 3-5.
6. **Время** сравнивается с тем же источником, что штамп: колонка с `defaultNow()` - значит
   `now()` базы в запросе, а не `new Date()` процесса (урок L-009).
7. **Тесты** - `packages/db/test/<таблица>.int.test.ts` против `shorts_factory_test` (хелперы -
   `packages/db/test-support/fixture.ts`: ручка файла - `const db = useTestDb({ beforeAll, afterAll })`,
   а не `let db` с `afterAll`; страж - `packages/db/test-support/stack-guard.ts`, ADR-0011);
   перечисление, совпадающее с union в `@sf/core`, сторожит
   `packages/db/test/enum-parity.test.ts`.

## 4. Новый процесс (CLI, служба) - каркас из `@sf/runtime`

Логгер, Redis, очереди, остановка и дедлайн - только из `@sf/runtime` (ADR-0012), копия в
`apps/*/src/lib` - находка ревью.

1. **Логгер** - `pino(buildLoggerOptions(env))` в точке входа: вызов `pino()` остаётся в
   приложении (оттуда резолвится `pino-pretty`), опции - из пакета (`redact`, белый список
   `serializers.err`). Новое поле ошибки, которое нужно в логе, - строка в белом списке
   `packages/runtime/src/logger.ts` с кейсом в `packages/runtime/test/logger.test.ts`;
   `details` ошибки в лог не идут - только то, что вызывающий положил под `LOGGED_DETAILS`.
2. **Redis** - по политике, а не опциями: `createQueueRedis(url, { log })` для BullMQ и всего,
   что ставит job; `createRequestRedis(url, { commandTimeoutMs, log })` для запросов api;
   `createProbeRedis(url, { connectTimeoutMs })` для одноразовой проверки - только подпутём
   `@sf/runtime/redis` (в барреле её нет: процесс проверки не грузит bullmq и pino; дедлайн -
   `@sf/runtime/deadline`). Закрытие
   в остановке - стадия `redisStage(() => client)`, вне её - `closeRedis`.
3. **Очереди** - `createQueueFactory({ connection, log, readOnly, defaultJobOptions })`:
   писатель воркера - `createJobQueueFactory(connection, log)` из
   `apps/worker/src/lib/job-policy.ts` (`DEFAULT_JOB_OPTIONS` у писателя обязательны по типу),
   читатель - `readOnly: true` без политики; чтение, после которого `Queue` может оказаться сломанным, - через
   `use(name, read)`.
4. **Остановка** - `createShutdownHandler({ plan, log, startedMessage, repeatedSigint, timeoutMs })`:
   порядок плана - контракт процесса (образцы: `apps/worker/src/bootstrap.ts`,
   `apps/api/src/compose-app.ts`); сигналы подписываются (`subscribeToSignals`) до того, как
   что-то открыто; провал старта - тот же обработчик с `{ failed: true }`, не голый
   `process.exit(1)`; стадия ресурса - `stageOf(name, () => target, close)`: цель, которую
   старт не открыл (`undefined` или промис старта, разрешившийся без неё), даёт строку
   «not opened», а не `closed`.
5. **Обещание без ответа** - `withDeadline`/`settleWithin` с явным `unref`: `false` - когда
   дедлайн и есть вердикт (запрос, CLI, остановка), `true` - когда таймер не должен держать
   процесс (кэш, ожидание при закрытии).
6. **Тесты** - рекордер `@sf/runtime/test-support/recording-logger` (настоящий pino, уровни
   именами; `silentLogger()` для кейсов не про лог).

## Тесты и гейты

- `pnpm test` - юнит-тесты всех пакетов и корневого проекта `test/` (`turbo run test test:repo`),
  без инфраструктуры (ADR-0010). Конфиги vitest пакетов - тонкие вызовы корневого
  `vitest.preset.ts` (`unitTestConfig`/`intTestConfig`, ADR-0011); новый пакет с тестами заводит
  такой же, копию политики ловит `test/vitest-preset.test.ts`.
- Корневой проект `test/` держит тесты репозитория, которые не принадлежат ни одному пакету: CI
  (`ci-config`), образы и Compose (`container`, `dockerfile`, `compose-rules`, `probe-image`),
  корневые скрипты (`check-no-search-list`, `tasks-cli`, `paths`), входы turbo (`turbo-inputs`).
  Корень репозитория скрипты и корневые тесты берут из `scripts/lib/paths.mjs` (`repoRoot`),
  пакеты - из `@sf/config/paths`; перекрёстных импортов нет. Файлы репозитория корневые тесты
  читают через `test/repo-files.ts` - только те, что входят в хеш: отслеживаемые git и
  неотслеживаемые, но не игнорируемые (`git ls-files --cached --others --exclude-standard`,
  `repoFilesUnder`); перечисляют - тоже через него, а не `readdirSync`. Выборка одна:
  `trackedFiles` из `scripts/lib/files.mjs` (её же берут гейты `scripts/` и `workspaceDirs`
  из `scripts/lib/manifest.mjs`); `test/repo-files.ts` - обёртка над ней с мемо и Zod. Замок -
  `test/enumeration.ts`: в `test/` его держит `test/repo-files.test.ts` (исключение с причиной -
  `DISK_CHECKS`), в `scripts/` - `test/scripts-files.test.ts` (`SCRIPT_DISK_READS`,
  `SCRIPT_DISK_CHECKS`). Игнорируемый файл
  (`coverage/`, сборка) в хеш `//#test:repo` не попадает, и чтение его переиграло бы старый
  результат из кэша. Ответ «путь исчез» у корневых скриптов один - `isGone` из
  `scripts/lib/files.mjs` (только `ENOENT`; там же `isNotFile` - ещё и `ENOTDIR` - и
  `readIfFile`). Корневые тесты, которые гоняют git на своём каталоге, берут дерево из
  `test/git-fixture.ts` (`gitScratch`: без `GIT_DIR`/`GIT_INDEX_FILE` и с потолком
  `GIT_CEILING_DIRECTORIES` - родителем своего каталога). YAML корневые скрипты и тесты
  читают одним разбором - `readYaml` из `scripts/lib/yaml-doc.mjs` (fail-closed: один
  документ, без ошибок и предупреждений парсера); тесты - через `parseRepoYaml`/`readRepoYaml`
  из `test/repo-files.ts` (рядом с `readRepoJson`), голый `parse` из `yaml` в тестах не
  зовётся; `ci.yml` - через `test/workflow.ts` на том же `parseRepoYaml`. Исключение -
  `workspaceGlobs` из `scripts/lib/manifest.mjs`: `pnpm-workspace.yaml` он разбирает
  построчно (строка в `docs/TECH_DEBT.md`). Что исходник пакета называет за пределами
  пакета (`repoRoot`, путь вверх от файла) - синтаксическим деревом `test/root-reads.ts`
  (`rootReads`; его берут правила входов turbo в `test/turbo-inputs.test.ts`), импорты -
  `test/imports.ts`.
- Типы `scripts/*.mjs` - JSDoc под `checkJs` корневого `tsconfig.json` (`pnpm typecheck:repo`),
  без `.d.mts`; скрипты остаются запускаемыми чистым `node`.
- Входы turbo: корневой `test.inputs` - только `$TURBO_DEFAULT$` и `vitest.preset.ts`; пакет,
  чьи юнит-тесты читают `.env.test` (`.env.example`), добавляет его в своём `turbo.json`
  (`extends: ["//"]`, `$TURBO_EXTENDS$`). Юнит-тест пакета, читающий файл корня (`repoRoot`,
  относительный путь, выходящий из пакета: `"../../.."`, `resolve(here, "..", "..", "..")`), не видит его правку в своём хеше: такие читатели - закреплённый список, новый
  краснит. Замок - `test/turbo-inputs.test.ts`.
- `pnpm test:int` - интеграционные `apps/api`, `apps/worker`, `packages/db` по одному пакету
  (`--concurrency=1`). Нужны поднятый `infra/docker-compose.yml` и мигрированная база
  `shorts_factory_test`; без Compose прогон красный, а не пропущенный. Каждый прогон пакета до
  первого файла проходит входную проверку стека (`globalSetup`, который ставит `intTestConfig`:
  `@sf/db/test-support/entry-check/*`, ADR-0011) - новый int-файл за ней без единой строки.
  Команды - `README.md`, «Getting started», шаг 7.
- `pnpm lint` (Biome), `pnpm typecheck`, `pnpm build` (собирает только `apps/web`, ADR-0005).
- `node .claude/hooks/gates.js` (выбор - `selectGates` в `.claude/hooks/gates.js`, правила - `.claude/hooks/rules.sf.json`):
  - всегда идут lint, typecheck и no-search-list (`when: always`);
  - compose, tracker и harness-selftest идут только при совпадении `when: glob:` с изменёнными
    файлами: compose - ровно то, что гейт читает (ADR-0014): три файла графа (`compose.yaml`, `infra/docker-compose.yml`,
    `infra/docker-compose.app.yml`), имена override и прочие имена по умолчанию Compose в корне и в `infra/`, `.dockerignore`,
    `infra/docker/app.Dockerfile.dockerignore`, корневой `.env.test`, `package.json`, `scripts/check-compose.mjs`,
    `scripts/compose-rules.mjs`, `scripts/lib/compose-graph.mjs`, `scripts/lib/paths.mjs`, `scripts/lib/files.mjs`,
    `scripts/lib/json.mjs`
    (Docker Compose 5.x, `infra/README.md`); новый Compose-файл стека - в `include`, `COMPOSE_SOURCES` и `when` сразу;
    tracker - `docs/tasks/tasks.json`, `docs/00_STATUS.md`, `docs/*_TASKS.md`, `docs/TECH_DEBT.md`,
    `scripts/tasks.mjs`, `scripts/lib/paths.mjs`, `scripts/lib/tracker-doc.mjs`, `scripts/lib/files.mjs`; harness-selftest - `.claude/**`,
    файлы, названные в `note` гейтов compose и tracker, но не выбирающие сам этот гейт (его
    `when`/`cmd`; сегодня - `test/compose-rules.test.ts`, `test/container.test.ts`), и файлы проекта, которые читают пробы
    гейтов build и test:int (манифесты, конфиги сборки и int-тестов, `.env.test`; точный glob -
    гейт `harness-selftest` в `rules.sf.json`, E0-01A, E0-02A; `turbo.json` пробы не читают, на нём
    гейт не выбирается). Нет совпадения - гейт молча пропущен,
    так что exit 0 не значит, что compose или tracker проверены;
  - build выбирается по glob (дословно - `rules.sf.json`, гейт `build`):
    `{apps/web/**,packages/api-client/**,packages/config/**,packages/contracts/**,packages/core/**,package.json,pnpm-workspace.yaml,pnpm-lock.yaml,turbo.json,tsconfig*.json}`
    - только то, что читает `next build` (E0-01A); правка `apps/api`, `apps/worker`, `packages/db`
    его не выбирает. Пакет со `scripts.build` и всё, что он читает из workspace, обязаны быть под
    glob - иначе краснеет harness-selftest (он выбирается и на правке корневого `package.json`, манифестов и `next.config.*`; корневой
    `scripts.build` обязан быть ровно `turbo run build`);
  - test идёт всегда; test:int - при правке того, что читают int-тесты: граф int-пакетов, корневые конфиги
    и `.env.test` (точный glob - гейт `test:int` в `.claude/hooks/rules.sf.json`, E0-02A). test:int нужен поднятый Compose (`docker compose -f infra/docker-compose.yml up -d`):
    без него гейт красный, и это не повод его выключать. Руками - `pnpm test` и, при поднятом Compose,
    `pnpm test:int`. Гейт, названный в `--only`, идёт при любом `when` (E0-12M): `--only=test:int`
    гонит int-тесты и без изменённых файлов под шаблоном, `--only=build` - сборку на диффе без `apps/web/**`
    и на чистом дереве после коммита (там, где гейт объявлен, `--repo` сужает); опечатка в `--only`, пустой
    `--only=` и гейт только репозитория без изменений при диффе в другом (нужен `--repo=<имя>`) - код 1,
    ничего не запускается;
  - `--list` показывает выбор и причину каждого решения, `--only=<id>,<id>` - подмножество;
  - у каждого гейта предел `timeoutSec` (секунды, поле гейта в `rules.sf.json`, от замера с запасом,
    не меньше 60 с): не завершившийся за предел гейт снимается вместе с деревом процессов и красный
    («снят по пределу»; снятие отказало или вывод после него не закрылся - `ПРЕДЕЛ N с, СНЯТЬ РУКАМИ`),
    оболочка вышла, а её остаток держит вывод, - `ОСТАТОК ЖИВ, СНЯТЬ РУКАМИ`; зелёный - только оболочка
    вышла с 0 и вывод закрылся сам; гейт без поля не запускается и красный; Ctrl+C снимает дерево идущего гейта;
  - stdin гейту не даётся (E0-12M): команда гейта не интерактивна, ждущая ввода сразу получает конец
    ввода. Скрипт гейта, которому нужен ответ (подтверждение, пароль), так не работает - ввод берётся
    из флагов или файла, а не с клавиатуры.
- CI - `.github/workflows/ci.yml` (состав шагов - там). Локальный кэш turbo (`.turbo/cache`)
  job `ci` сохраняет между прогонами: ключ - ISO-неделя без коммита и без `restore-keys`, архив
  пишет первый зелёный прогон недели, остальные восстанавливают его как есть; удалённого кэша нет.
  Замок - `test/ci-config.test.ts`.

## ADR

Перечень записей, номера и однострочные решения - `docs/adr/README.md`; новая запись берёт
следующий номер по папке.
