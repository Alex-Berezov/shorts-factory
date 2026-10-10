# ADR-0010: тесты двух видов - юнит без инфраструктуры и интеграционные против Compose, без пропуска

Дата: 2026-10-10   Статус: принято   Задача: E0-13 (решение 6 эпика E0; реализовано в E0-02, E0-04, E0-08, E0-09, E0-12)

## Контекст

Половина поведения системы живёт на границе с Postgres и Redis: миграции, агрегаты расхода,
очереди BullMQ, переключатели, DLQ. Моки этих границ проверяют ожидания автора, а не библиотеку.
При этом `pnpm test` должен идти на любой машине и в любом хуке без поднятой инфраструктуры,
а интеграционный прогон не должен уметь «зеленеть», когда инфраструктуры нет, и не должен
задевать данные разработки.

## Решение

- **Юнит-тесты** - `*.test.ts`, `vitest.config.ts` каждого пакета, `pnpm test`
  (`turbo run test`). Без Postgres, Redis и сети, всегда.
- **Интеграционные** - `*.int.test.ts`, отдельный `vitest.int.config.ts` в `apps/api`,
  `apps/worker` и `packages/db`, `pnpm test:int` (`turbo run test:int --concurrency=1`,
  корневой `package.json`). Ходят в настоящие Postgres 16 и Redis 7 из
  `infra/docker-compose.yml` (локально) или из `services` CI (`.github/workflows/ci.yml`).
- **Без Compose прогон красный, а не пропущенный** (`docs/DECISIONS.md`, 06.09.2026, E0-02):
  исходная формулировка решения 6 «запускаются, когда задан `DATABASE_URL`» отменена -
  скрипт, который выходит нулём без прогона, - гейт, зелёный без проверки (урок L-005).
  `passWithNoTests` не ставится нигде.
- **Изоляция от разработки**: `.env.test` (коммитится, только адреса локального Compose
  и заглушки) направляет прогон в отдельную базу `shorts_factory_test` (создаётся
  `infra/postgres/init/01-test-db.sql`, в CI - `POSTGRES_DB`) и в Redis того же стека, не в db `0`
  разработки. `.env.test` называет db `1`; набор `apps/worker` работает в ней, набор `apps/api`
  выводит из того же URL db `2` (`apiTestRedisUrl`, `apps/api/test/local-stack-guard.ts`), чтобы два
  набора не делили пространство ключей BullMQ. Загружает его
  `@sf/config/vitest/setup` (`setupFiles` конфигов), предварительно вычищая из `process.env`
  все ключи схемы env.
- **Стражи перед разрушительными шагами**: `packages/db/test/local-host-guard.ts`
  (`assertLocalHost`, `assertLocalTestDatabase`, `assertLocalRedisDatabase`) и
  `apps/{api,worker}/test/local-stack-guard.ts` поверх него - только `localhost`/`127.0.0.1`/`::1`,
  только `shorts_factory_test` и Redis, который в `.env.test` назван db `1` (страж api сверяет
  именно её и работает в db `2`). Стражи без зависимостей и проверяются юнит-тестами
  в `pnpm test`.
- **Порядок**: пакеты гоняют интеграционные тесты по одному (`--concurrency=1`): у них общие
  база и Redis. Внутри `apps/worker` и `packages/db` файлы тоже идут последовательно
  (`fileParallelism: false` в их `vitest.int.config.ts`); у `apps/api` этой настройки нет,
  его файлы идут параллельно на одной базе - пункт задачи E0-12A (`docs/TECH_DEBT.md`, строки
  по `apps/api/vitest.int.config.ts`; задача в трекере - `docs/tasks/tasks.json`).
- **Подготовка**: схема тестовой базы - миграция с `.env.test`; в CI шаг
  `node --env-file=../../.env.test --import tsx src/cli/migrate.ts` в `packages/db`
  (`.github/workflows/ci.yml:82-83`). Testcontainers не используем.

## Альтернативы

- **Testcontainers** - Docker в каждом прогоне и на каждой машине разработчика, время старта
  контейнеров на каждый пакет; Compose уже нужен для `pnpm dev`.
- **Пропуск интеграционных без `DATABASE_URL`** - зелёный гейт без проверки.
- **Моки Postgres/Redis/BullMQ** - не ловят ни формат id BullMQ, ни SQL агрегатов, ни поведение
  паузы очереди.
- **Общая с разработкой база** - тест чистит таблицы и очереди живого воркера.

## Последствия

- Перед `pnpm test:int` нужен поднятый `infra/docker-compose.yml` и мигрированная тестовая
  база (README, Getting started); без них прогон честно падает.
- Новый интеграционный тест с удалением данных идёт через стражи своего пакета, а не через
  собственную проверку.
- `pnpm test` остаётся быстрым и не зависит от окружения - его гоняют хуки и гейт `test`;
  `test:int` - гейт и шаг CI.
