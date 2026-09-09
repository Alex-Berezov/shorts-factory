# E0. Каркас проекта и инфраструктура — декомпозиция на задачи

_Дата: 2026-09-05. Источник: `20_TZ_HIGH_LEVEL.md` (E0), `10_SYSTEM_DESIGN.md` §2–§6, §8. Статус эпика: ✅ декомпозирован, реализация не начата._

## Цель эпика

Рабочий монорепозиторий, в котором можно разрабатывать все последующие эпики.
**AC эпика:** `docker compose up` поднимает всё; `pnpm dev` работает; тестовый job проходит через очередь и пишет запись в Postgres; CI зелёный.

## Что уже есть в скелете (на что опираемся)

- Конфиги монорепо: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `biome.json`, `.gitignore`, `.env.example`.
- `packages/config` — Zod-схема env и `limits` (черновик).
- `packages/db` — Drizzle-схема всех таблиц из System Design §5 (черновик), `drizzle.config.ts`; миграций нет.
- `packages/core` — `ContentDnaSchema` (совпадает с blueprint §5.2), `scoring.ts` с юнит-тестом, `idea.ts`.
- `packages/integrations/{youtube,gemini,tts}` — заглушки клиентов и `QUOTA_COST`.
- `apps/api` — Fastify с одним `/health`; `apps/worker` — пустые процессоры (реестр имён очередей переехал в `@sf/core`, `src/domain/queues.ts`: `QUEUE_NAMES`/`QueueName`, решение 5 и E0-04); `apps/web` — страницы-заглушки без `next.config`, Tailwind и типов.
- `infra/docker-compose.yml` — только postgres + redis; `.github/workflows/ci.yml` — lint → typecheck → test → build.

## Замеченные дефекты скелета (закрываются задачами ниже)

| # | Проблема | Где лечим |
|---|---|---|
| D1 | `pnpm install` не запускался: нет `pnpm-lock.yaml`, а CI использует `--frozen-lockfile` → CI красный | E0-01 |
| D2 | `TOKEN_ENCRYPTION_KEY=` в `.env.example` даёт пустую строку, а схема `z.string().length(64).optional()` пустую строку не принимает → падение при старте с примером конфига | E0-03 |
| D3 | `@sf/db` открывает соединение при импорте модуля — ломает тесты и любой импорт схемы без БД | E0-04 |
| D4 | `apps/web`: нет `next.config`, `tailwind/postcss`, `@types/node`, `@types/react-dom`, `next-env.d.ts`; `transpilePackages` для `@sf/*` не настроен | E0-01, E0-10 |
| D5 | Тип `UsageLogger` лежит в `@sf/youtube`, хотя нужен всем интеграциям → место ему в `@sf/core` | E0-05 |
| D6 | `docker compose up` не поднимает api/worker/web — AC эпика не выполняется | E0-11 |
| D7 | Скрипт `pnpm test` в `apps/api` и `apps/worker` объявлен, но тестов и конфигов Vitest нет — turbo упадёт на `vitest run` без файлов | E0-02 |

## Архитектурные решения, фиксируемые в E0

Принимаем по умолчанию (задача E0-13 оформляет их как ADR). Если что-то не подходит — меняем до старта соответствующей задачи.

1. **Пакеты source-only, приложения запускаются через `tsx`.** `packages/*` остаются с `main: src/index.ts` без своего build. `apps/api` и `apps/worker` в dev и в Docker работают через `tsx` (без шага компиляции), `apps/web` подключает пакеты через `transpilePackages`. Для внутреннего инструмента это убирает целый класс проблем с ESM/`.js`-расширениями и dist-путями. Пересмотрим, если появится заметная стоимость холодного старта.
2. **Auth: один admin-пароль.** Web защищён Next `middleware.ts` (HTTP Basic против `ADMIN_PASSWORD`), API — `@fastify/basic-auth` на всех роутах, кроме `/health`. API в Compose не публикуется наружу; web ходит в API только с сервера (server components / route handlers) по `API_INTERNAL_URL`. В браузерный бандл секреты не попадают.
3. **Контракты API = общие Zod-схемы в `@sf/contracts`.** Запрос/ответ каждого роута описываются в пакете, который импортируют и api (валидация + OpenAPI через `fastify-type-provider-zod`), и web (типизированный fetch-клиент). Кодогенерация по OpenAPI не нужна.
4. **DLQ = отдельная очередь `system.dlq`.** BullMQ не имеет встроенного DLQ: при исчерпании `attempts` обработчик `failed` копирует job (очередь, jobId, payload, ошибка, число попыток) в `system.dlq`. Оригинальные failed-записи тоже сохраняем (`removeOnFail: { count: 1000 }`), `/system` читает и то и другое.
5. **Идемпотентность через детерминированный `jobId`.** Каждый тип job объявляет функцию `jobIdFrom(payload)`; повторная постановка с тем же id BullMQ игнорирует. Чистые билдеры id живут в `@sf/core`; реестр имён очередей — там же (`src/domain/queues.ts`, `QUEUE_NAMES`/`QueueName`): имена нужны и воркеру, и `@sf/db` (ключи `queues.enabled`). Сегменты id склеиваются через `/`, а не `:` (E0-05): BullMQ 5 отвергает custom id с `:` в `Job.addJob → validateOptions` и обещает полный запрет в следующем мажоре, поэтому `:` внутри части запрещён билдером. Часть, чьё значение само содержит `/` или `:`, кодируется билдером: версия промпта пишется как `<name>@<version>` (`dna.full@1.0.0`), любой момент времени — epoch ms (`<requestedAtMs>`); см. решение от 07.09.2026 в `DECISIONS.md`. `jobId` содержит `/` и в URL передаётся только query-параметром, сегментом пути — никогда.
6. **Тесты двух видов.** Юнит-тесты (`*.test.ts`) — без инфраструктуры, всегда. Интеграционные (`*.int.test.ts`) — против настоящих Postgres/Redis из Compose, запускаются, когда задан `DATABASE_URL`/`REDIS_URL` (локально и в CI через services). Testcontainers не берём.
7. **Локальная разработка на Windows.** Скрипты в `package.json` кросс-платформенные (никакого bash). Docker Desktop + WSL2 backend. Bash-скрипты допустимы только в `infra/scripts` (запуск на VPS).
8. **`apps/web` собирается как обычное Next-приложение по умолчанию.** `output: "standalone"` включается только флагом `NEXT_OUTPUT_STANDALONE=1` при сборке образа (`web.Dockerfile`, решает `next.config.ts`) — обычная сборка (локально, CI) не создаёт trace-копию `node_modules` и не требует прав на symlink.

---

## Задачи

Формат: цель → что сделать → DoD → оценка → зависимости. Оценки в рабочих днях, суммарно ≈ 11–13 дней.

### E0-01. Установка тулчейна и зелёные `lint` + `typecheck` на скелете

**Цель:** репозиторий собирается и проверяется одной командой на чистой машине.

**Сделать:**
- Зафиксировать Node 22 (`.nvmrc`/`.node-version`), corepack + `packageManager` (уже есть), `.editorconfig`.
- `pnpm install`, закоммитить `pnpm-lock.yaml` (закрывает D1).
- Починить `.github/workflows/ci.yml`: `pnpm/action-setup@v4` падает с «Multiple versions of pnpm specified» - убрать `with: { version: 9 }`, версию задаёт `packageManager` в `package.json` (первый прогон CI 05.09.2026, run #1). Правка конвейера идёт по решению техлида; ни один шаг не снимается.
- Довести `biome.json`: JSX/TSX, `organizeImports`, игнор `migrations/**`.
- Добавить недостающее в `apps/web`: `next.config.ts` (`output` по `NEXT_OUTPUT_STANDALONE=1`), `next-env.d.ts`, `@types/node`, `@types/react-dom`, `postcss.config`, `tailwind.config` (часть D4; сам UI — в E0-10).
- Убрать из `turbo.json` зависимость `typecheck`/`test` от `^build` (у пакетов нет build — см. решение 1) или оставить с пояснением; добавить `lint` как turbo-task не нужно — Biome запускается из корня.
- Убедиться, что `pnpm lint` и `pnpm typecheck` проходят по всем workspace-пакетам.
- Включение гейта `build` — отдельная задача E0-01A (внешнее предусловие: разрешение владельца на правку `.claude/hooks/**`).

**DoD:** на чистом клоне `pnpm install && pnpm lint && pnpm typecheck && pnpm build` зелёные; lockfile в репозитории. Гейт `build` — см. E0-01A.
**Оценка:** 0.5 д. **Зависимости:** нет.

### E0-01A. Включить гейт build в rules.sf.json

**Цель:** усилить обвязку так, чтобы любая правка `apps/**`/`packages/**`/корневых конфигов, ломающая `next build`, не уходила в коммит без сборки.

**Сделать:**
- `.claude/hooks/rules.sf.json`: у гейта `build` `when: "never"` → `"glob:{apps/**,packages/**,package.json,pnpm-lock.yaml,turbo.json,tsconfig*.json}"`, текст `note` переписать (сейчас он обещает включение в E0-01 — обещание не выполнено, гейт остался выключен).
- `.claude/hooks/harness-selftest.js`: две пробы L-008 — на выбор гейта `build` при изменённом файле под glob и на пропуск при изменении только `docs/**`.

**DoD:** `node .claude/hooks/harness-selftest.js` зелёный со включёнными пробами L-008; полный `node .claude/hooks/gates.js` при изменении файлов под glob запускает `build`.
**Оценка:** 0.1 д. **Зависимости:** E0-01.

Причина отдельной задачи: внешнее предусловие — разрешение владельца на правку `.claude/hooks/**`; правка отклоняется системой разрешений сессии.

### E0-02. Vitest: конфигурация, `.env.test`, разделение unit / integration

**Цель:** `pnpm test` работает во всех пакетах, включая те, где тестов пока нет.

**Сделать:**
- Единая `vitest.config.ts` на пакет (или общий пресет в `packages/config/vitest`), `passWithNoTests: true` (закрывает D7) - отменено, см. DECISIONS 06.09 (развилка A): вместо этого в каждом пакете со скриптом `test` есть содержательная канарейка.
- Конвенция `*.test.ts` (unit) и `*.int.test.ts` (integration); проект-ы Vitest или отдельный скрипт `test:int`, который пропускается без `DATABASE_URL` - пункт про пропуск отменён, см. DECISIONS 06.09 (развилка B): `test:int` = `turbo run test:int`, без Compose честно красный, база отдельная `shorts_factory_test`.
- `.env.test` (не секретный, коммитится) с локальными URL Compose; `setupFiles` подгружает его до импорта `@sf/config`.
- Существующий `scoring.test.ts` проходит; добавить тест-«канарейку» в `apps/api` и `apps/worker`.
- Включение гейтов `test` и `test:int` в `.claude/hooks/rules.sf.json` - отдельная задача E0-02A (внешнее предусловие: разрешение владельца на правку `.claude/hooks/**`, тот же блок, что в E0-01A).

**DoD:** `pnpm test` зелёный без запущенной инфраструктуры; `pnpm test:int` зелёный при поднятом Compose. Гейты `test`/`test:int` - см. E0-02A.
**Оценка:** 0.5 д. **Зависимости:** E0-01.

### E0-02A. Включить гейты `test` и `test:int` в `rules.sf.json`

**Цель:** усилить обвязку так, чтобы правка, ломающая `pnpm test`/`pnpm test:int`, не уходила в коммит без прогона.

**Сделать:**
- `.claude/hooks/rules.sf.json`: у гейта `test` `when: "never"` → `"always"`; у гейта `test:int` `"never"` → `"glob:{packages/db/**,apps/**}"`; текст `note` переписать под факт.
- `.claude/hooks/rules.sf.json`: `note` правила про `.env*` привести к формулировке CLAUDE.md
  темы владельца 1 (исключение для корневых `.env.example`/`.env.test`) - в E0-02 недостижимо
  слоем разрешений сессии.
- `.claude/hooks/harness-selftest.js`: пробы L-008 на выбор и на пропуск обоих гейтов.

**DoD:** `node .claude/hooks/harness-selftest.js` зелёный со включёнными пробами; `node .claude/hooks/gates.js --list` показывает `test` и `test:int` в списке запускаемого.
**Оценка:** 0.1 д. **Зависимости:** E0-02.

Причина отдельной задачи: внешнее предусловие - разрешение владельца на правку `.claude/hooks/**`; правка отклоняется системой разрешений сессии (тот же блок, что в E0-01A).

### E0-03. `@sf/config`: надёжный парсинг env и константы лимитов

**Цель:** fail-fast конфиг, который не падает на легитимном `.env.example` и не утекает в браузер.

**Сделать:**
- Препроцессинг: пустая строка → `undefined` для всех optional-полей (закрывает D2).
- Добавить переменные: `API_PORT` (3001), `WEB_PORT` (3000), `API_INTERNAL_URL` (для web → api), `LOG_LEVEL`, `WORKER_CONCURRENCY`; синхронизировать `.env.example` и README.
- Разделить экспорт: `env` (серверный, помечен `import "server-only"`-совместимым образом, чтобы Next не затащил его в клиент) и `limits` (YT units/день, Gemini $/день, TTS $/мес — константы + значения из env).
- `loadEnv(source?)` для тестов (парсинг произвольного объекта без `process.env`).
- Юнит-тесты: валидный пример, пустые строки, невалидный URL, отсутствующий `ADMIN_PASSWORD`.

**DoD:** копия `.env.example` в `.env`, в которой оператор задал только `ADMIN_PASSWORD`, запускает api/worker без ошибок парсинга; нетронутая копия падает ровно одной ошибкой с именем поля `ADMIN_PASSWORD` — шаблон не везёт рабочих секретов; тесты схемы зелёные; попытка импортировать `env` в клиентском компоненте Next даёт ошибку сборки.
**Оценка:** 0.5 д. **Зависимости:** E0-02.

### E0-04. `@sf/db`: фабрика подключения, ревизия схемы, миграция 0000, первые репозитории

**Цель:** схема ядра применяется к пустой базе одной командой, к БД можно подключаться из api, worker и тестов без побочных эффектов.

**Сделать:**
- Заменить import-time подключение на `createDb(url)` / `closeDb()` (закрывает D3); экспортировать типы `Db`.
- Ревизия схемы против System Design §5: статусы `trend_signal.status`, `research_brief.status`, `script.status`, `experiment.status` перевести с `text` на `pgEnum` (единообразно с `idea_status`); добавить `created_at`/`updated_at`, где их нет (`tracked_channel.updated_at`, `idea.updated_at`, `experiment.created_at`); индексы по всем FK и `(video_id, captured_at)` (уже есть); `api_usage_log` — индекс `(provider, created_at)` для дневных агрегатов.
- `drizzle-kit generate` → `migrations/0000_core.sql`; программный раннер `migrate.ts` (используется одноразовым сервисом в Compose и в CI).
- `seed.ts`: дефолтные `app_setting` (веса скоринга, включённость очередей), без данных.
- Репозитории (тонкие функции над Drizzle, без бизнес-логики): `apiUsageLogRepo.insert / sumUnitsToday(provider) / sumCostUsdToday(provider) / sumCostUsdThisMonth(provider)`, `appSettingRepo.get/set`.
- Интеграционный тест: миграция на чистую БД → insert в `api_usage_log` → агрегаты корректны.

**DoD:** `pnpm db:migrate` на пустом Postgres создаёт все таблицы из §5; `drizzle-kit generate` после этого не находит дрейфа; `*.int.test.ts` зелёные.
**Оценка:** 1.5 д. **Зависимости:** E0-03.

### E0-05. `@sf/core`: базовые доменные типы, схема Content DNA, чистые хелперы

**Цель:** единый пакет типов без зависимостей (кроме Zod), которым пользуются db, integrations, api, worker, web.

**Сделать:**
- Сверить `ContentDnaSchema` с blueprint §5.2 (набор полей совпадает; добавить `.describe()` к полям — пригодится для `response_schema` Gemini в E2) и `IdeaScoresSchema` с `idea.scores`.
- Вынести общие enum-ы и типы: `Provider` (`youtube_data | youtube_analytics | gemini | elevenlabs | openai_tts | google_tts | cartesia | system`), `IdeaStatus`, `SnapshotPoint`, `AnalysisKind`; `ApiUsageEntry` и тип `UsageLogger` (перенос из `@sf/youtube`, закрывает D5).
- Чистые функции бюджета: `budgetState({ spent, cap }) → { ratio, exceeded, warn }` с порогами предупреждения (80 %).
- Чистые билдеры `jobId`: `jobId(prefix, ...parts)` через `/`, `intervalSlot(now, intervalMin)`, `jobIds.radarSync(channelId, slot)` → `radar.sync/<channelId>/<slot>`, `jobIds.radarScore(videoId, point)` → `radar.score/<videoId>/<point>` (решение 5) — для E1 уже готовые. `jobIds.snapshot` не заводится: решение 1 эпика E1 заменило job на пару (video, point) батчевым тиком `radar.snapshot`. Состав билдеров и разделитель заданы решением техлида от 07.09.2026 (`DECISIONS.md`), а не переписаны задачей.
- Ошибки домена: `AppError` (`code`, `httpStatus`, `details`) и наследники `ValidationError`, `NotFoundError`, `BudgetExceededError`.
- Юнит-тесты на всё перечисленное; `@sf/core` по-прежнему не зависит ни от чего, кроме `zod`.

**DoD:** тесты зелёные; `@sf/youtube` импортирует `UsageLogger` из core; `pnpm typecheck` по всем пакетам зелёный.
**Оценка:** 1 д. **Зависимости:** E0-02 (параллельно с E0-04).

### E0-06. `apps/api`: Fastify-скелет с auth, ошибками, логами и OpenAPI

**Цель:** API-каркас, к которому эпики добавляют только модули роутов.

**Сделать:**
- `buildApp(deps)` (без `listen`) для тестов через `app.inject`; `server.ts` — только запуск и graceful shutdown (SIGINT/SIGTERM → закрыть Fastify, БД, Redis).
- pino: уровень из `LOG_LEVEL`, `pino-pretty` в dev, `requestId` в каждом логе и в ответах об ошибках.
- `fastify-type-provider-zod` + `@fastify/swagger` + `@fastify/swagger-ui`: OpenAPI по Zod-схемам на `/docs` и `/openapi.json`.
- `@fastify/basic-auth` глобально, исключение — `/health` (решение 2).
- Единый error handler: ошибка валидации запроса (`ZodError`, обёрнутый `fastify-type-provider-zod`) → 400 с деталями; `AppError` → его `httpStatus` и `code` при любом статусе 4xx/5xx, текст сообщения наружу только у 4xx (у 5xx - типовой по статусу: `new AppError("GEMINI_FAILED", err.message, 502)` унёс бы клиенту url провайдера с ключом); голый `ZodError` из хендлера - это разбор чужого ответа, а не входа клиента, и уходит в 500 наравне с прочим - без утечки stack и текста в ответ, всё логируется с `requestId`. Отдельный класс - отказ самого роутера до того, как запрос дошёл до маршрута (`FST_ERR_BAD_URL` и соседние): тот же конверт, но без basic auth перед ним и с кодом, не входящим в доменный набор.
- Структура `src/routes/<module>/index.ts` с `registerRoutes(app)`; в E0 модули `health` и `system`.
- `/health` (без пароля): ping Postgres и Redis, ответ `{status: ok|degraded}`, 200 или 503 - и ничего об отпечатке сборки (SEC4). Версия, коммит, uptime и разбивка по зависимостям - в `/system/status` под паролем; очереди, DLQ и расход бюджета добавляет туда E0-09.
- Тесты через `app.inject`: 401 без пароля, 200 `/health`, форма ошибки валидации, форма 500.

**DoD:** `pnpm --filter @sf/api dev` поднимает API; `/docs` показывает схему; тесты зелёные.
**Оценка:** 1.5 д. **Зависимости:** E0-04, E0-05.

### E0-07. `@sf/contracts` и типизированный API-клиент

**Цель:** web и api делят одни Zod-схемы запросов/ответов (решение 3).

**Сделать:**
- Пакет `packages/contracts` (`@sf/contracts`, зависит только от `@sf/core` и `zod`): по файлу на модуль (`health.ts`, `system.ts`), экспорт схем и `z.infer`-типов; соглашение о нумерации/версионировании ошибок.
- api использует схемы из контрактов в `schema: { response, body, querystring }`.
- Пакет `packages/api-client` (`@sf/api-client`): `createApiClient({ baseUrl, basicAuth })` с методами, типизированными контрактами, парсинг ответа тем же Zod (ловим дрейф на границе).
- Юнит-тест клиента с мок-`fetch`.

**DoD:** web-страница `/system` (E0-10) получает данные только через `@sf/api-client`; несовпадение схем ловится typecheck-ом.
**Оценка:** 0.5–1 д. **Зависимости:** E0-06.

### E0-08. `apps/worker`: BullMQ-каркас, DLQ, cron-реестр, graceful shutdown, smoke-job

**Цель:** рабочий конвейер задач, соответствующий требованиям к джобам из System Design §4: идемпотентность, ретраи, DLQ, лог стоимости.

**Сделать:**
- `createRedis(url)` (ioredis, `maxRetriesPerRequest: null`), фабрика `Queue` по реестру `QUEUE_NAMES` из `@sf/core` (ленивое создание, кэш); служебные очереди (`system.dlq`, `system.heartbeat`, `system.smoke`) добавляются здесь.
- Настройка `queues.enabled` (`app_setting`, засеяна в E0-04 на весь `QUEUE_NAMES`, все `true`): решить и реализовать, **что означает `false` в рантайме** (не создавать `Worker`? не ставить джобы? пауза очереди BullMQ?) и **где ключ читается** — вопрос техлиду, открытый с E0-04 (решение PM Р8, `docs/DECISIONS.md` 06.09); ответ записать строкой в `DECISIONS.md`. Служебные очереди, добавленные здесь, попадают в реестр и в настройку тем же `pnpm db:seed`: повторный seed дописывает недостающие переключатели, не трогая изменённые оператором.
- Условие, на котором PM принял «все 26 очередей засеяны `true`»: каждый эпик, добавляющий обработчик платной или публикующей очереди, приносит свой предохранитель **в той же задаче**, не позже (переключатели очередей предохранителем не считаются). Для E0-08 это значит: обработчиков платных очередей здесь не заводить, а `system.*` — бесплатные.
- Хелпер `defineJob({ queue, payloadSchema, jobIdFrom, handler, opts })`: валидирует payload Zod, создаёт child-логгер с `jobId`/`queue`, дефолтные опции `attempts: 5`, `backoff: exponential 5s`, `removeOnComplete: { count: 1000 }`, `removeOnFail: { count: 1000 }`.
- `Worker` на каждую очередь с `concurrency` из env; регистрация процессоров через реестр `src/jobs/index.ts` (текущие пустые файлы — под будущие эпики).
- DLQ по решению 4: очередь `system.dlq`, обработчик `failed` при `attemptsMade >= attempts`.
- Cron-реестр `src/schedules.ts`: объявление repeatable-jobs (BullMQ Job Schedulers) и синхронизация при старте — удаление тех, что больше не объявлены. В E0 объявлен один: `system.heartbeat` раз в минуту (пишет `worker:heartbeat` в Redis — используется `/system`).
- Graceful shutdown: SIGINT/SIGTERM → `worker.close()` всех воркеров (дожидаясь активных), закрытие Redis и БД.
- Smoke-job `system.smoke`: пишет строку в `api_usage_log` (`provider: system`, `operation: smoke`, `units: 0`) — это AC эпика. Скрипт `pnpm --filter @sf/worker smoke` ставит job и ждёт результата.
- Интеграционный тест: поставить `system.smoke` → дождаться `completed` → строка в БД; job с падающим handler-ом после исчерпания попыток оказывается в `system.dlq`.

**DoD:** `pnpm --filter @sf/worker dev` регистрирует все очереди; smoke-тест и DLQ-тест зелёные; `Ctrl+C` завершает воркер без потери активной задачи (ручная проверка).
**Оценка:** 2 д. **Зависимости:** E0-04, E0-05.

### E0-09. Учёт стоимости внешних API и проверка бюджета

**Цель:** каждая интеграция обязана логировать стоимость, а job — уметь спросить, не превышен ли лимит. Автопауза очередей и алерты — в E1/E13, здесь только фундамент.

**Сделать:**
- `createUsageLogger(db, { jobId })` в `@sf/db` (реализует `UsageLogger` из core), пробрасывается в клиенты интеграций через контекст job (`ctx.usage`).
- `BudgetGuard` (в `apps/worker/src/lib/budget.ts` или `@sf/db`): `check(provider)` → агрегаты из `apiUsageLogRepo` + `limits` из config → `budgetState`; `assert(provider)` бросает `BudgetExceededError`. Job с этой ошибкой не ретраится (фейлится сразу, попадает в DLQ с понятным кодом).
- Кэш агрегатов в Redis на 60 с, чтобы не бить БД на каждом вызове.
- `/system/status` (api, контракт из E0-07): состояние очередей (waiting/active/failed/delayed) по каждому имени, размер `system.dlq`, `worker:heartbeat`, расход за сегодня (YT units, Gemini $) и месяц (TTS $) с процентом от лимита.
- Тесты: юнит на агрегацию/пороги; интеграционный на `assert` при заранее записанном расходе выше лимита.

**DoD:** запись в `api_usage_log` из job видна в `/system/status`; превышение лимита останавливает job до внешнего вызова.
**Оценка:** 1 д. **Зависимости:** E0-08 (и E0-07 для контракта).

### E0-10. `apps/web`: Next.js-скелет, layout с навигацией, basic auth, страница `/system`

**Цель:** дашборд, защищённый паролем, с единой оболочкой и первой живой страницей.

**Сделать:**
- Tailwind + shadcn/ui (инициализация, компоненты `button`, `card`, `table`, `badge`); базовые токены темы.
- `RootLayout` с боковой навигацией по разделам из E13 (Radar / Inbox / Ideas / Production / Analytics / Experiments / Localization / System); существующие заглушки страниц остаются.
- `middleware.ts`: HTTP Basic против `ADMIN_PASSWORD` (только серверный env), исключение для статических ассетов (решение 2).
- Серверный `apiClient` (`@sf/api-client`) с `API_INTERNAL_URL` и паролем — вызывается только из server components / route handlers.
- `/system`: карточки «API health», «Worker heartbeat», таблица очередей (waiting/active/failed/delayed), DLQ count, расход бюджета за день/месяц с процентами — из `/system/status`. Revalidate 15 с.
- Проверка, что `next build` не включает `ADMIN_PASSWORD`/`API_INTERNAL_URL` в клиентские чанки (grep по `.next/static`).

**DoD:** `pnpm --filter @sf/web dev` → браузер запрашивает пароль → `/system` показывает живые данные api/worker; `next build` проходит.
**Оценка:** 1.5 д. **Зависимости:** E0-07, E0-09.

### E0-11. Docker: Dockerfile'ы api/worker/web, полный Compose, миграции, бэкап

**Цель:** `docker compose up` поднимает весь стек с нуля (AC эпика, закрывает D6).

**Сделать:**
- `infra/docker/api.Dockerfile`, `worker.Dockerfile` (multi-stage: `pnpm fetch` → `pnpm install --frozen-lockfile --prod=false` → `pnpm deploy --filter <app>` → runtime `node:22-alpine` с `tsx`, решение 1), `web.Dockerfile` (Next standalone, `NEXT_OUTPUT_STANDALONE=1`).
- Compose: сервисы `migrate` (одноразовый, `depends_on: postgres healthy`), `api`, `worker`, `web` (`depends_on: migrate completed`), `env_file: .env`, volume `media:/data/media`; наружу только web `:3000` (api — только внутри сети). У api, worker и web объявить `NODE_ENV=production` явно (`environment:`), не полагаясь на fail-safe дефолт схемы: решение от 06.09 (E0-03) записывает дефолт только в `env`, а `process.env.NODE_ENV` остаётся пустым, и сторонние библиотеки уходят в dev-ветку.
- Разделение: `docker-compose.yml` (полный стек) и профиль/override для dev, когда api/worker/web запускаются через `pnpm dev`, а в Docker — только postgres + redis (текущий сценарий).
- Healthcheck-и api (`/health`) и worker (свежесть `worker:heartbeat`).
- `infra/scripts/backup.sh`: ежедневный `pg_dump` с ротацией 14 дней + инструкция cron на VPS в `infra/README.md`.
- Проверка на Windows (Docker Desktop + WSL2): перенос строк LF в скриптах (`.gitattributes`).

**DoD:** на чистой машине `cp .env.example .env`, задать `ADMIN_PASSWORD` длиной не меньше 16 символов (Compose объявляет `NODE_ENV=production` явно, поэтому более короткий пароль роняет контейнеры на парсинге конфига), `docker compose up --build` → `http://localhost:3000` просит пароль, `/system` зелёный, миграции применены; `docker compose down && up` не теряет данные.
**Оценка:** 1.5 д. **Зависимости:** E0-06, E0-08, E0-10.

### E0-12. CI: сервисы Postgres/Redis, кэш, интеграционные тесты, сборка образов

**Цель:** CI проверяет то же, что и локальная проверка, включая интеграционные тесты и сборку Docker-образов.

**Сделать:**
- `services: postgres, redis` в workflow с healthcheck; env для тестов из `.env.test`. Хостовые порты сервисов публикуются те же, что в `.env.test` (`5442` и `6389`, разведены с дефолтными в E0-04), иначе тесты не найдут базу.
- Шаги: `install --frozen-lockfile` → `lint` → `typecheck` → `test` → `db:migrate` → `test:int` → `build`.
- Кэш pnpm store и `.turbo` (`actions/cache`).
- Отдельный job `docker-build`: сборка трёх образов без push (ловим сломанные Dockerfile'ы).
- Concurrency-группа по ветке (отмена устаревших прогонов).

**DoD:** workflow зелёный на `main` и в PR; падение интеграционного теста или Dockerfile ломает CI.
**Оценка:** 0.5 д. **Зависимости:** E0-11.

### E0-13. Документация разработчика, ADR, закрытие эпика

**Цель:** новый разработчик (или Claude Code в новой сессии) поднимает окружение по README без вопросов; решения E0 зафиксированы.

**Сделать:**
- README «Getting started» проверен на чистом клоне (Windows и Linux): установка, `.env`, Compose, `pnpm dev`, smoke-job, тесты.
- `docs/adr/0001…0006` — решения 1–6 из этого документа (кратко: контекст, решение, последствия).
- `docs/40_DEV_GUIDE.md`: как добавить новый роут (контракт → api → клиент), новый job (`defineJob` → реестр → cron), новую таблицу (схема → generate → repo).
- Обновить `CLAUDE.md` («Current state»), `00_DOCS_INDEX.md`, статусы в `20_TZ_HIGH_LEVEL.md`.
- Прогон AC эпика целиком и фиксация результата в этом документе (раздел «Приёмка»).

**DoD:** все пункты AC эпика выполнены и отмечены ниже; документы обновлены.
**Оценка:** 0.5 д. **Зависимости:** E0-12.

---

## Порядок и параллелизм

```text
E0-01 ─► E0-02 ─► E0-03 ─┬─► E0-04 ─┬─► E0-06 ─► E0-07 ─┐
                         │          │                    ├─► E0-09 ─► E0-10 ─► E0-11 ─► E0-12 ─► E0-13
                         └─► E0-05 ─┴─► E0-08 ──────────┘
```

- E0-04 и E0-05 делаются параллельно; E0-06 и E0-08 — тоже (оба зависят только от db + core).
- Первый зелёный CI появляется уже после E0-02 (существующий workflow + lockfile), дальше CI расширяется в E0-12.
- Всё, что относится к конкретным интеграциям (YouTube, Gemini, TTS), в E0 не трогаем, кроме переноса типа `UsageLogger`.

## Вне скоупа E0 (сознательно)

- Реальные роуты и джобы модулей (Radar, Intel и далее) — свои эпики.
- Автопауза очередей при превышении лимита и алерты — E1 (YouTube) и E13 (`/system`).
- Полноценный `/system` с историей расхода и управлением DLQ (retry/discard) — E13.
- Google OAuth и шифрование refresh-token — E7 (в E0 только переменные env и таблица).
- Деплой на VPS/Fly.io — после E1, когда есть что деплоить; Compose уже прод-подобный.

## Приёмка (заполняется при закрытии эпика)

| AC | Как проверяем | Статус |
|---|---|---|
| `docker compose up` поднимает всё | E0-11 DoD на чистой машине | ⬜ |
| `pnpm dev` работает | api, worker, web стартуют из одного `pnpm dev`, `/system` зелёный | ⬜ |
| Тестовый job проходит очередь и пишет в Postgres | `pnpm --filter @sf/worker smoke` + строка в `api_usage_log` + видно в `/system` | ⬜ |
| CI зелёный | workflow на `main` после E0-12 | ⬜ |
