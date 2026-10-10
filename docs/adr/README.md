# ADR - записи архитектурных решений

Одна запись - одно решение, которое меняет структуру пакетов, слой, способ хранения или внешний
контракт. Пишет исполнитель по требованию техлида (поле `Границы` его ответа) или оркестратор
при закрытии эпика (решения «по умолчанию» из `docs/3x_Ex_TASKS.md` становятся ADR, когда
реализованы).

Имя файла: `NNNN-<slug>.md`, номер - следующий по папке. Формат:

```
# ADR-NNNN: <решение одной строкой>

Дата: ГГГГ-ММ-ДД   Статус: принято | заменено ADR-MMMM   Задача: E?-??

## Контекст
<что решали и почему это важно; 3–6 строк>

## Решение
<что выбрали; чем отличается от альтернатив>

## Альтернативы
- <вариант> - <почему нет>

## Последствия
<что становится проще, что сложнее, что нельзя делать теперь>
```

| Запись | Решение | Задача |
| --- | --- | --- |
| `0001-config-server-entry.md` | два входа `@sf/config`: корневой для Node, `./server` с маркером `server-only` для Next; с E0-07 то же устройство у `@sf/api-client` (последний абзац «Последствий») | E0-03, E0-07 |
| `0002-db-connection-and-cli-config.md` | библиотека `@sf/db` принимает подключение параметром; `DATABASE_URL` читают только `packages/db/src/cli/**`, `packages/db/test/**` и `packages/db/vitest*.config.ts` | E0-04 |
| `0003-queue-switches.md` | `queues.enabled=false` = пауза очереди BullMQ; ставит её только воркер (старт + ресинк раз в минуту), api и E1-08 выражают намерение записью в `app_setting`: оператор - в `queues.enabled`, E1-08 - своим ключом `queues.autopaused` (`Record<очередь, причина>`), композиция двух ключей - в `queue-switches.ts` | E0-08 |
| `0004-env-file-single-reader.md` | корневой `.env` монтируется read-only в `/repo/.env` контейнеров `migrate`/`api`/`worker`/`web` и читается тем же `bootstrapEnv`/`util.parseEnv`, что под `pnpm dev`; `env_file` нет, контракт стережёт правило 10 гейта `compose` | E0-11 |
| `0005-source-only-packages-tsx-runtime.md` | пакеты воркспейса без своей сборки (`main: src/index.ts`), api/worker/CLI `@sf/db` исполняют TypeScript через `tsx` в dev и в образе (`tsx` в `dependencies`), воркер без watch, web - `transpilePackages` | E0-13 (решение 1 E0) |
| `0006-single-admin-password.md` | один `ADMIN_PASSWORD`: HTTP Basic в Node-middleware web и глобальным хуком api (без пароля только `/health`), api в Compose без `ports`, web ходит в api только с сервера по `API_INTERNAL_URL` | E0-13 (решение 2 E0) |
| `0007-api-contracts-zod.md` | контракты API - Zod-схемы `@sf/contracts`, общие для api (`fastify-type-provider-zod`, OpenAPI) и `@sf/api-client`; из `@sf/core` в `@sf/contracts` - только реестры значений `as const` и коды ошибок; ни функций, ни Zod-схем домена, ни классов | E0-13 (решение 3 E0) |
| `0008-dlq-system-queue.md` | окончательно упавший job копируется в очередь `system.dlq` (`attempts: 1`, `removeOnFail: false`), исходный `failed` остаётся (`removeOnFail: { count: 1_000 }`), у `system.dlq` нет процессора, retry/discard - E13-02 | E0-13 (решение 4 E0) |
| `0009-deterministic-job-ids.md` | `jobIdFrom(payload)` через именованные билдеры `jobIds.*` `@sf/core`; склейка `/`, в части запрещены `/` и `:`, число - только безопасное целое ≥ 0, id из одних цифр отвергается; вложенный id кодирует только `:` → `@` | E0-13 (решение 5 E0) |
| `0010-unit-and-integration-tests.md` | `*.test.ts` без инфраструктуры и `*.int.test.ts` против Compose; `pnpm test:int` без Compose красный, база `shorts_factory_test`, Redis db 1 (worker) и db 2 (api), стражи локального стека, Testcontainers не берём | E0-13 (решение 6 E0) |
