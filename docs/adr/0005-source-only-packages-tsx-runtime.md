# ADR-0005: пакеты воркспейса без своей сборки, api/worker/migrate исполняют TypeScript через `tsx`

Дата: 2026-10-10   Статус: принято   Задача: E0-13 (решение 1 эпика E0; реализовано в E0-01, E0-04, E0-08, E0-10, E0-11)

## Контекст

Монорепо из трёх приложений и восьми пакетов, все на ESM TypeScript. Собирать каждый пакет
в `dist` значит держать для каждого `outDir`, пути `exports` на собранные файлы, `.js`-суффиксы
в импортах, совпадающие с выходом `tsc`, и порядок сборки в turbo. Для внутреннего инструмента
на одной машине это целый класс поломок (ESM-резолв, рассинхрон `dist` и исходников) без
выигрыша: холодный старт процесса не критичен, а пакеты потребляются только внутри репозитория.

## Решение

- **Пакеты source-only.** У всех `packages/*` и `packages/integrations/*` `"main": "src/index.ts"`
  (в `package.json` каждого) и нет скрипта `build`. Потребитель получает исходники.
- **api, worker и CLI `@sf/db` исполняются через `tsx`, без шага компиляции**, одинаково
  в разработке и в образе:
  - `apps/api`: `dev` = `tsx watch src/server.ts` (`apps/api/package.json:7`), в образе
    `CMD ["node", "--import", "tsx", "src/server.ts"]` (`infra/docker/api.Dockerfile:56`);
  - `apps/worker`: `dev` = `node --import tsx src/index.ts` (`apps/worker/package.json:7`),
    в образе тот же запуск (`infra/docker/worker.Dockerfile:36`);
  - `packages/db`: `db:migrate`/`db:seed` = `tsx src/cli/*.ts`, в образе `migrate`
    `node --import tsx src/cli/migrate.ts && node --import tsx src/cli/seed.ts`
    (`infra/docker/migrate.Dockerfile:39`).
- **`tsx` - рантайм-зависимость**: `tsx ^4.19.0` в `dependencies` `@sf/api`, `@sf/worker`
  и `@sf/db`; образ ставит прод-зависимости `pnpm install --offline --frozen-lockfile --prod
  --filter <pkg>...` (`docs/DECISIONS.md`, 10.10.2026, E0-11: «как tsx попадает в рантайм-образ»
  и запись круга 4 о замене `pnpm deploy`).
- **Воркер запускается без watch** (`docs/DECISIONS.md`, 10.09.2026, E0-08): перезапуск
  по сохранению файла убивает активную джобу, а `tsx watch` добивает дочерний процесс раньше,
  чем истекает 25-секундный дедлайн мягкой остановки. Подробно - `README.md`, § Worker.
- **`apps/web` компилирует пакеты сам**: `transpilePackages: ["@sf/config", "@sf/api-client",
  "@sf/contracts", "@sf/core"]` и `experimental.extensionAlias` в `apps/web/next.config.ts`
  (механизм и почему нужны обе настройки - ADR-0001). `pnpm build` собирает только web
  (`docs/DECISIONS.md`, 06.09.2026, E0-01: скрипт `build` убран из api и worker).

Следствие для образа web - решение 8 эпика: `output: "standalone"` включается только флагом
`NEXT_OUTPUT_STANDALONE=1` в `infra/docker/web.Dockerfile:27` (условие в `apps/web/next.config.ts`),
обычная сборка локально и в CI trace-копию `node_modules` не делает.

## Альтернативы

- **`tsc` в `dist` у каждого пакета** - порядок сборки, `outDir`, расхождение `dist`
  и исходников при разработке; без `rootDir` `tsc` тянул исходники пакетов в `dist`
  приложений (E0-01).
- **Бандл приложений (esbuild/tsup)** - лишний инструмент и второй путь исполнения, отличный
  от `pnpm dev`; образ проверял бы не то, что запускает разработчик.
- **`node --experimental-strip-types`** - не резолвит `./schema/index.js` в `.ts` (E0-04),
  импорты воркспейса с `.js`-спецификаторами не работают.

## Последствия

- Нет шага сборки у api/worker/db: правка пакета видна приложению сразу, в образе исполняются
  те же исходники, что под `pnpm dev`.
- `tsx` нельзя переносить в `devDependencies` api/worker/db: прод-установка образа его не
  поставит, и контейнер не стартует (это ловит проба `scripts/probe-image.mjs` в job
  `docker-build` CI).
- Новый пакет воркспейса, который импортирует web, добавляется в `transpilePackages`
  (список - граф импорта web, а не прямые зависимости), иначе `next build` падает на его
  исходниках.
- Цена - компиляция на лету при каждом старте процесса. Пересматривается, если холодный старт
  станет заметной стоимостью (исходная оговорка решения 1).
