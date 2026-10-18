# ADR-0012: общий пакет `@sf/runtime` - каркас процессов api и worker

Дата: 2026-10-17   Статус: принято   Задача: E0-12B (решения техлида Р1-Р5 17.10.2026, `docs/DECISIONS.md`)

## Контекст

Логгер, Redis-клиенты с `closeRedis`, обработчик остановки, фабрика `Queue` и «промис с
дедлайном» жили копиями в `apps/api/src/lib` и `apps/worker/src/lib` - импорт между
приложениями запрещён §6. Копии разошлись: список `redact` у worker уже, чем у api;
`closeRedis` api не смотрел на статус клиента; `Queue` воркера был без `error`-слушателя
(обрыв Redis ронял процесс); форма исхода остановки у api таргет-независимая, у worker нет;
пять копий дедлайна разошлись по `unref()`. `redact` не доставал `err.cause.command.args`
(пароль Redis во вложенной ошибке), а сериализатор pino копировал любые поля ошибки
(`config.url` с ключом, `response.data`, `query`/`parameters` postgres-js). Третий
потребитель (E13-02, DLQ replay; новые CLI) завёл бы третью копию.

## Решение

Новый пакет `packages/runtime` (`@sf/runtime`), форма как у `@sf/db`/`@sf/config`:
`main: src/index.ts`, баррель только реэкспортов, `./test-support/recording-logger` для тестов;
подпути `./redis` и `./deadline` - для процесса, которому не нужны bullmq и pino корня
(healthcheck воркера: каждая загрузка модуля - из его 5 с).
Направление: `apps -> runtime -> config, core` (плюс `pino`, `ioredis`, `bullmq` в тех же
диапазонах, что в apps). `process.env` и `console` в `src/**` запрещены (S03, S05),
`src/**` не импортирует `test-support/**`.

Что в пакете:

- **дедлайн** - `withDeadline` (реджект `DeadlineError` или ошибкой вызывающего) и
  `settleWithin` (fallback) над одним ядром; `unref` - обязательный параметр без умолчания,
  таймер снимается в `finally` всегда;
- **логгер** - `buildLoggerOptions(env)`: один список `redact` и `serializers.err` по **белому
  списку** полей (`type`, `message`, `stack`, `code`, `errno`, `syscall`, `address`, `port`,
  `httpStatus`, `statusCode` Fastify, `command.name`; `details` - только то, что лежит под
  ключом `LOGGED_DETAILS` (его кладёт `loggableError` api), поле `details` самой ошибки не
  пишется никогда), рекурсивно по `cause` и
  `errors` с пределом глубины и защитой от цикла; вызов `pino()` остаётся в приложении
  (оттуда pino резолвит транспорт `pino-pretty`);
- **Redis** - три фабрики с именованной политикой вместо опций, ослабляющих соединение:
  `createQueueRedis` (BullMQ: `maxRetriesPerRequest: null`, offline queue, затухающие уровни
  лога), `createRequestRedis` (fail-fast, `commandTimeout` передаёт вызывающий, `log` -
  те же затухающие уровни),
  `createProbeRedis` (одна попытка, без переподключения); `error`-слушатель внутри каждой;
  один `closeRedis`: не `ready` -> `disconnect()`, иначе `quit()` с `catch -> disconnect()`,
  исход `{ kind: "quit" } | { kind: "disconnected"; err? }`; `redisStage` - один перевод
  исхода в стадию остановки для api и worker (`disconnected` -> `warn` «closed by disconnect»
  с отказом QUIT, если он был);
- **фабрика `Queue`** - ленивый кэш по имени, `isQueueName`, флаг закрытия, `error`-слушатель
  на каждом `Queue` (ошибка общего клиента, которую bullmq пересылает каждому `Queue`, и
  отказ соединения молчат - их пишет клиент, прочие ошибки - строка лога; пересылка узнаётся
  по тому же объекту ошибки, что клиент эмитнул чуть раньше; признак отказа соединения
  `connectionFailure` - тот же, что у `/system/status`),
  `use()` забывает `Queue` только при отклонённом `init()` (признак - публичный
  `waitUntilReady()`; отклонённый `init()` любого рода `error`-слушатель `Queue` не пишет -
  его получает чтение), `close()` ждёт чтения в полёте ограниченно и закрывает все `Queue`,
  даже если одна отказала (отказ - `AggregateError` после всех), и дожидается закрытий `Queue`,
  забытых `use()` (их отказы в `AggregateError` не входят) - стадия `redis` начинается после всех; режим чтения
  (`readOnly: true`: `skipMetasUpdate` + `skipWaitingForReady`) и писатель
  (`readOnly: false` с обязательным по типу `defaultJobOptions`) - параметрами; предохранителя по статусу клиента нет (решение 11.10.2026, Р4);
- **остановка** - `createShutdownHandler` на плане из стадий и параллельных
  последовательностей (`{ parallel: [[db], [queues, redis]] }` у api, линия у worker), исход
  `CloseWarning` -> строка `warn` без порчи кода, `NOT_OPENED` -> строка «not opened»
  вместо `closed` у цели, до которой старт не дошёл (стадии ресурсов строятся одной
  `stageOf`, у api и worker одинаково), липкий `failed`, живой дедлайн, один выход
  с `log.flush()` перед `exit` (предел 1 с); форс-выход по повторному SIGINT - явный параметр
  `repeatedSigint` без умолчания: у worker включён, у api выключен (Р3); `subscribeToSignals` -
  одна подписка на SIGINT/SIGTERM, которую оба процесса ставят до того, как что-то открыто.

Чего в пакете нет: политика джобов (`DEFAULT_JOB_OPTIONS`, `queueConcurrency` - в
`apps/worker/src/lib/job-policy.ts`), пороги приложений (`DEPENDENCY_TIMEOUT_MS` api, сроки
остановки 10 с/25 с, тексты строк остановки), домен (счётчики очередей и `QueueCountersError`
api, классы SQLSTATE `/system/status`, DLQ, переключатели очередей).

## Альтернативы

- подпути `@sf/config` - пакет с входом `browser`/`server-only` и одной зависимостью `zod`
  получил бы pino/ioredis/bullmq, web тянул бы их транзитивно;
- `@sf/db` - ломает `db -> core` (ADR-0002) и тащит pino в пакет данных;
- одна Redis-фабрика с опциями - клиент очередей можно ослабить, передав не тот объект;
  три функции делают политику выбором по имени.

## Последствия

- Правка каркаса процесса - в одном месте; третий потребитель берёт пакет, а не копию.
- `packages/runtime/**` выбирает гейт `test:int` (наборы api/worker от него зависят), гейт
  `build` - нет (web его не импортирует).
- Тестовый рекордер pino один - `@sf/runtime/test-support/recording-logger`, уровни именами.
- Новый процесс (CLI, DLQ replay E13-02) строит логгер, клиента и остановку из пакета:
  рецепт - `docs/40_DEV_GUIDE.md`.
- Нельзя: читать `process.env` в пакете, класть туда пороги и политику приложений, вызывать
  `pino()` в `src/**` пакета (транспорт `pino-pretty` - devDependency приложений).
