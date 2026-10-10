# ADR-0007: контракты API - общие Zod-схемы в `@sf/contracts`, без кодогенерации

Дата: 2026-10-10   Статус: принято   Задача: E0-13 (решение 3 эпика E0; реализовано в E0-06, E0-07, E0-09, E0-10)

## Контекст

Форму каждого ответа api знают три места: валидация и сериализация в Fastify, документ OpenAPI
(`/docs`, `/openapi.json`) и потребитель - серверный код web. Описанная трижды, она расходится
молча: роут меняет поле, клиент продолжает читать старое, и ошибка всплывает на экране оператора.
Кодогенерация клиента по OpenAPI добавляет шаг сборки и сгенерированные файлы в репозиторий,
не устраняя второй источник истины.

## Решение

- **Одна Zod-схема на запрос и ответ** каждого роута, в `packages/contracts/src/<модуль>.ts`,
  реэкспорт из `packages/contracts/src/index.ts`. Сейчас: `errors.ts` (`ErrorBodySchema` -
  конверт ошибки), `health.ts`, `system.ts`. Типы - только `z.infer` от схемы, отдельно
  написанных типов рядом нет.
- **api** валидирует и сериализует по тем же схемам через `fastify-type-provider-zod`:
  `validatorCompiler`/`serializerCompiler` и `transform: jsonSchemaTransform` для OpenAPI
  в `apps/api/src/plugins/openapi.ts`, `ZodTypeProvider` в `apps/api/src/app.ts`. Правила роута
  (`...errorResponses()` до статусов успеха, `SuccessReply<typeof responses>` в generic,
  `withErrorEnvelope()` для статуса, который роут отдаёт штатно) - в `apps/api/src/routes/README.md`
  и `apps/api/src/lib/route-schemas.ts`.
- **web** читает api через `@sf/api-client` (`packages/api-client/src/client.ts`,
  `createApiClient`): клиент разбирает ответ схемой из `@sf/contracts`, отказ api возвращает
  исключением `ApiError` с полями конверта, а ответ, который api не строило (сбой транспорта,
  не-JSON, тело вне схемы), - `ApiContractError` (`packages/api-client/src/errors.ts`).
  `@sf/api-client` зависит только от `@sf/contracts` (`docs/10_SYSTEM_DESIGN.md` §6).
- **Что `@sf/contracts` вправе брать из `@sf/core`** (`docs/DECISIONS.md`, 10.10.2026, E0-13,
  развилка 2): из `@sf/core` в `@sf/contracts` - только реестры значений `as const`
  (`QUEUE_NAMES`, `BUDGET_SCOPE_KEYS` / `BUDGET_MEASURES` / `BUDGET_PERIODS` и подобные)
  и коды ошибок; ни функций, ни Zod-схем домена, ни классов. Правило проверяется по строке
  импорта: сегодня `packages/contracts/src/errors.ts` берёт три кода ошибок,
  `packages/contracts/src/system.ts` - четыре реестра. Потребность эпика в доменной Zod-схеме
  в ответе API (Content DNA и т.п.) решается отдельной строкой в `docs/DECISIONS.md` того эпика.

## Альтернативы

- **Кодогенерация клиента по OpenAPI** - шаг сборки, сгенерированные файлы, второй источник
  истины; Zod-схема уже даёт и рантайм-проверку, и тип.
- **Схемы рядом с роутами в `apps/api`** - web не может импортировать из `apps/*`
  (направление зависимостей `apps → packages`).
- **Перечень разрешённых импортов из `@sf/core` поимённо** (каждое новое значение - строка
  решения) - правка §6 и поход к техлиду на каждый эпик; правило по категории проверяемо так же.
- **Разрешить и доменные Zod-схемы `@sf/core`** - удобно E2/E3, но тянет в web-бандл код
  домена; отложено до явной потребности.

## Последствия

- Изменение формы ответа - одна правка схемы; api, OpenAPI и клиент меняются вместе, а
  `tsc` и тесты клиента краснеют там, где ответ читается по-старому.
- Новый роут = схема в `@sf/contracts` + модуль в `apps/api/src/routes/` + метод клиента
  (рецепт - `docs/40_DEV_GUIDE.md`).
- Штатный не-2xx ответ (503 у `/health`) объявляется в схеме роута и в списке статусов
  контракта (`HEALTH_STATUS_CODES`), а клиент различает ответ и отказ по этому списку, не по
  `response.ok` (урок L-013).
- Функция, класс или доменная Zod-схема `@sf/core` в импорте `@sf/contracts` - находка ревью
  без строки решения.
