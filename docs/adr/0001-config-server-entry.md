# ADR-0001: у `@sf/config` два входа - корневой для Node и `@sf/config/server` с маркером `server-only`

Дата: 2026-09-06   Статус: принято   Задача: E0-03

## Контекст

`@sf/config` читает `process.env` и файл `.env`, то есть держит секреты: ключи провайдеров,
пароль администратора, ключ шифрования refresh-токена. Требование E0-03 - «попытка импортировать
`env` в клиентском компоненте Next даёт ошибку сборки», иначе секрет уезжает в браузерный чанк
и обнаруживается это поздно.

Ошибку именно сборки Next даёт только пакет-маркер `server-only`: его видит
`next-invalid-import-error-loader`. Но `server-only/index.js` бросает при любом условии резолва,
кроме `react-server`, поэтому маркер в корневом `src/index.ts` разом уронил бы `apps/api`,
`apps/worker`, `packages/db` и весь `pnpm test` - они импортируют тот же корень из обычного Node.

## Решение

Два модуля и условный корневой вход:

- `.` -> `{ "browser": "./src/server.ts", "default": "./src/index.ts" }`. Условия матчатся
  по порядку объявления, а `default` матчит всё, поэтому он стоит последним. Node, `tsx`,
  vitest (`environment: "node"`) и `tsc` (`moduleResolution: nodenext`) условие `browser`
  не берут и получают `src/index.ts` - обычный модуль, где env парсится один раз; отсюда
  импортируют `apps/api`, `apps/worker`, `packages/db` и тесты. Браузерная сборка Next берёт
  `browser` и приходит в модуль с маркером, то есть клиентский импорт корня упирается в тот же
  `next-invalid-import-error-loader`, что и клиентский импорт подвхода. Своих имён условий
  и модулей-заглушек нет - только стандартные `browser`/`default`.
- `./server` -> `src/server.ts` - `import "server-only"` плюс реэкспорт `env`, `limits`, `loadEnv`,
  `buildLimits` из корня, без второго парсинга. Явный вход для `apps/web` (серверные компоненты
  Node-runtime).
- Маркер `server-only` в `src/index.ts` не ставится **никогда**: он бросает при любом условии
  резолва, кроме `react-server`, и уронил бы api, worker, db и весь `pnpm test`.

`server-only` добавлен в `dependencies` `@sf/config`. Проводка web -> `@sf/config` состоит
из двух настроек `apps/web/next.config.ts`, и обе обязательны:

- `transpilePackages: ["@sf/config"]` - пакеты воркспейса поставляют исходники TypeScript,
  Next компилирует их сам;
- `experimental.extensionAlias: { ".js": [".ts", ".tsx", ".js"] }` - исходники ESM ссылаются
  друг на друга спецификаторами с `.js`, которых на диске нет (`server.ts` -> `./index.js`),
  и без этой пары webpack не резолвит ни ветку `default` корневого входа, ни подвход
  `./server`, то есть `transpilePackages` остаётся мёртвым. `.js` стоит в списке последним,
  чтобы настоящие `.js` в `node_modules` резолвились по-прежнему.

## Альтернативы

- **Маркер в корневом входе.** Ломает api, worker, db и vitest - см. «Контекст».
- **Свой модуль-заглушка с `throw`** за условием `exports` (`react-server` -> настоящий модуль,
  остальное -> модуль, который бросает). Отклонён именно `throw`: он даёт исключение в рантайме
  браузера, а требование - ошибка сборки. Условие `exports` как приём не отклонялось: ветка
  `browser`, указывающая на модуль с маркером `server-only`, даёт ту же ошибку сборки, что
  и подвход, и принята выше.
- **Отложить до E0-10.** Пункт DoD E0-03 остался бы незакрытым, а секрет - без замка на всё время.

## Последствия

- Клиентский импорт `@sf/config/server` валит `next build` (проверено пробой в E0-03,
  Next 15.5.25 на webpack): `You're importing a component that needs "server-only". That only
  works in a Server Component which is not supported in the pages/ directory.` - с указанием
  на `import "server-only"` в `packages/config/src/server.ts` и на файл клиентского компонента.
- Клиентский импорт **корневого** входа резолвится по условию `browser` в тот же
  `src/server.ts`, поэтому маркер закрывает и корень. Резолв условия проверен напрямую
  (`node --conditions=browser` приходит в `src/server.ts`, без флага - в `src/index.ts`)
  и юнит-тестом `packages/config/test/exports.test.ts`.
- Клиентский импорт **корня** даёт ту же ошибку `server-only` с трассой на
  `packages/config/src/server.ts` (проба E0-03, круг 4). Чтобы серверный компилятор Next,
  который идёт первым, дошёл до неё, `repoRoot` в `packages/config/src/paths.ts` собирается
  из `dirname(fileURLToPath(import.meta.url))`, а не из `new URL("../../../", import.meta.url)`:
  webpack читает второе как ссылку на ресурс и падает на
  `Module not found: Can't resolve '../../../'` раньше запуска клиентского компилятора.
  Оговорка: сборка проходит, но корректность корня после бандла не доказана - `import.meta.url`
  в собранном чанке указывает внутрь `.next/server/**`, поэтому запись про `import.meta.url`
  под webpack остаётся открытой в `docs/TECH_DEBT.md` (E0-10/E0-11).
- Правило S11 сформулировано по точному спецификатору и подвход `@sf/config/server` не видит;
  до включения гейта `build` клиентский импорт подвхода ловится только ручной сборкой -
  запись в `docs/TECH_DEBT.md` на E0-01A/E0-10.
- `@sf/config/server` читает файл через `node:fs`: в edge-runtime (middleware) он не работает,
  web импортирует подвход только в Node-runtime.
- Откат: удалить `src/server.ts`, строки `./server` и условный корневой вход `"."`
  (ветка `browser` -> `src/server.ts`) из `exports`, `server-only` из `dependencies`,
  а в `apps/web/next.config.ts` - обе опции, заведённые ради этой проводки:
  `transpilePackages: ["@sf/config"]` и `experimental.extensionAlias`. Без них откат
  оставит несобираемую проводку: web продолжит зависеть от пакета, исходники которого
  Next не транспилирует, а ESM-расширение `.js` не сопоставит исходнику `.ts`.
