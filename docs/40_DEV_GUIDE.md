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
   `app.get<{ Reply: SuccessReply<typeof responses> }>(path, { schema: { response: responses } }, handler)`
   (`errorResponses`, `OK_STATUS`, `SuccessReply` - из `apps/api/src/lib/route-schemas.ts`;
   образец - `apps/api/src/routes/system/index.ts`).
   _Почему:_ конверт ошибки попадает в OpenAPI и в сериализатор, а тип ответа читается с той же
   схемы - обработчик не может вернуть конверт ошибки вместо ответа
   (`apps/api/src/routes/README.md`). Штатный не-2xx статус со своим телом - через
   `withErrorEnvelope()` из того же модуля.
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
     (образец - `apps/api/test/system-status.int.test.ts`, стражи - `local-stack-guard.ts`);
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
   `packages/db/test/helpers.int.ts`); перечисление, совпадающее с union в `@sf/core`, сторожит
   `packages/db/test/enum-parity.test.ts`.

## Тесты и гейты

- `pnpm test` - юнит-тесты всех пакетов (`turbo run test`), без инфраструктуры (ADR-0010).
- `pnpm test:int` - интеграционные `apps/api`, `apps/worker`, `packages/db` по одному пакету
  (`--concurrency=1`). Нужны поднятый `infra/docker-compose.yml` и мигрированная база
  `shorts_factory_test`; без Compose прогон красный, а не пропущенный. Команды - `README.md`,
  «Getting started», шаг 7.
- `pnpm lint` (Biome), `pnpm typecheck`, `pnpm build` (собирает только `apps/web`, ADR-0005).
- `node .claude/hooks/gates.js` (выбор - `selectGates` в `.claude/hooks/gates.js`, правила - `.claude/hooks/rules.sf.json`):
  - всегда идут lint, typecheck и no-search-list (`when: always`);
  - compose, tracker и harness-selftest идут только при совпадении `when: glob:` с изменёнными
    файлами: compose - `compose.yaml`, `infra/**`, `scripts/check-compose.mjs`,
    `scripts/compose-rules.mjs`, `.dockerignore`; tracker - `docs/tasks/**`,
    `docs/00_STATUS.md`; harness-selftest - `.claude/**`. Нет совпадения - гейт молча пропущен,
    так что exit 0 не значит, что compose или tracker проверены;
  - test, test:int и build имеют `when: never` и сами не идут вплоть до E0-01A/E0-02A
    (exit 0 не значит, что тесты и сборка зелёные). Их прогоняют руками:
    `node .claude/hooks/gates.js --only=test,test:int,build` или напрямую `pnpm test`,
    `pnpm test:int`, `pnpm build`;
  - `--list` показывает выбор и причину каждого решения, `--only=<id>,<id>` - подмножество.
- CI (`.github/workflows/ci.yml`) гоняет `pnpm test`, `pnpm test:int`, `pnpm build` и сборку
  образов отдельными шагами.

## ADR

Перечень записей, номера и однострочные решения - `docs/adr/README.md`; новая запись берёт
следующий номер по папке.
