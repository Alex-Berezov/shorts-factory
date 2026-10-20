# ADR-0013: один `app.Dockerfile` с целью на каждый образ

Дата: 2026-10-20   Статус: принято   Задача: E0-12J (решения техлида Р1/Р2 E0-12C 18.10.2026; Р1, В1 - `init: true` у `migrate`, правило 13 гейта compose - и «Круг 3» - один `ARG NODE_IMAGE` без переопределения - E0-12J 20.10.2026, `docs/DECISIONS.md`)

## Контекст

Четыре образа приложения (`api`, `worker`, `migrate`, `web`) собирались из четырёх файлов
`infra/docker/*.Dockerfile`. Преамбула - `node:22-alpine`, corepack, `pnpm fetch
--frozen-lockfile` - была скопирована в каждый: версии node и pnpm могли разъехаться между
образами, а CI четырежды делал `pnpm fetch` без кэша слоёв. Список образов тесты брали из
имён файлов, Compose называл в каждом сервисе свой файл и стадию `runtime`. Кроме того,
`migrate` стартовал shell-формой (`sh` - PID 1), рантайм tsx-образов не нёс
`tsconfig.base.json`, на который делает `extends` `tsconfig.json` каждого пакета, web ставил
все пакеты воркспейса, а тесты пакетов попадали в каждый образ.

## Решение

- **Один файл, цели по имени.** `infra/docker/app.Dockerfile`: образ node назван один раз -
  `ARG NODE_IMAGE=node:22-alpine` до первого `FROM`; общие стадии `base` (`FROM
  ${NODE_IMAGE}`, corepack, `WORKDIR /repo`) и `fetch` (`pnpm fetch --frozen-lockfile` по
  lockfile); стадии установки `api-deps`, `worker-deps`, `migrate-deps` (`pnpm install
  --offline --frozen-lockfile --prod --filter <pkg>...` в чистый `node_modules`) и
  `web-build` (`--filter @sf/web...`, сборка standalone); цели-листья `api`, `worker`,
  `migrate`, `web` - тоже `FROM ${NODE_IMAGE}`, каждая копирует только из своей стадии
  установки. Что `ARG NODE_IMAGE` объявлен ровно один раз и каждая стадия от образа (а не
  от стадии) берёт именно `${NODE_IMAGE}`, держит `test/container.test.ts` («node image»);
  переопределить его снаружи нечем: `build.args` Compose - только `APP_VERSION` и
  `GIT_COMMIT` (там же), у шага сборки CI нет `build-args` (`test/ci-config.test.ts`).
- **Образ = цель = лист.** Образы приложения - стадии, на которые не ссылается ни один
  `FROM <stage>`, ни один `COPY --from=<stage>` и ни один `RUN --mount=...,from=<stage>`
  (`imagesOf()` в `test/dockerfile.ts`); стадии образа - цель и её предки
  (`stagesOfImage`). Безымянная стадия-лист - ошибка.
- **Compose и CI выбирают цель.** У каждого сервиса со сборкой `dockerfile:
  infra/docker/app.Dockerfile` и `target: <имя сервиса>`; `test/container.test.ts` сверяет
  множество целей с `build.target` Compose в обе стороны. CI (`docker-build`) собирает
  матрицу целей через `docker/build-push-action` с `load: true`, тегом `imageTag(цель)`
  пробы и кэшем слоёв `type=gha` со `scope` по цели (`mode=max` - в кэш идут и
  промежуточные стадии; `ignore-error=true` - сбой записи кэша не краснит сборку). Между
  коммитами переиспользуются только `base` и `fetch` (вход - lockfile): стадии установки
  идут после `COPY . .`, и любая правка исходников пересобирает их. Порядок «манифесты ->
  install -> исходники» - долг в `docs/TECH_DEBT.md`.
- **`migrate` - exec-форма** `CMD ["node", "--import", "tsx", "src/cli/migrate-and-seed.ts"]`:
  миграции и seed одним процессом на одном подключении, без оболочки между движком и node.
  Одной exec-формы для остановки мало: node как PID 1 без обработчика SIGTERM сигнал
  игнорирует (ядро не применяет к PID 1 действие по умолчанию), и `docker compose stop
  migrate` кончается SIGKILL (137). Поэтому сервис `migrate` в Compose запускается с
  `init: true` (В1 E0-12J): PID 1 - init Docker, node - его потомок, SIGTERM останавливает
  его с кодом 143. Замок - правило 13 гейта compose (`scripts/compose-rules.mjs`). Образ,
  запущенный `docker run` без `--init`, по-прежнему останавливается SIGKILL.
- **`tsconfig.base.json` в рантайме** каждой tsx-цели (`COPY --from=<цель>-deps
  /repo/tsconfig.base.json /repo/`): tsx в контейнере читает те же опции, что в dev.
- **Тесты вне образов** (Р1 E0-12J): маски `**/test`, `**/test-support`, `**/*.test.ts`,
  `**/vitest*.config.*` в корневом `.dockerignore`, после масок `.env`, без строк `!`
  (правило 11 гейта compose). Рантайм их не импортирует; правка теста не сбрасывает слой
  `COPY . .`. В образах остаётся `packages/config/vitest/`: это экспорт `@sf/config`
  (`./vitest/setup`), он едет вместе с пакетом и бросает при импорте вне прогона vitest
  (`assertVitestRun`); расширять маски до него Р1 запрещает. Что в собранном образе нет
  `test/`, `test-support/`, `*.test.ts` и `vitest*.config.*` в каталогах пакетов, проверяет
  проба образа (`scripts/probe-image.mjs`, `TEST_NAMES`) в каждом прогоне `docker-build` -
  свой вид отказа «carries the tests of its packages».

## Последствия

- Версии node (`NODE_IMAGE`) и pnpm (`packageManager`) меняются в одном месте для всех
  образов.
- Новый образ - новая цель-лист и сервис Compose с тем же `target`; без сервиса (или с
  сервисом без цели) `container.test.ts` красный, матрица CI сверяется с `imagesOf()`.
- Вспомогательная стадия, на которую никто не ссылается, становится «образом» и краснит
  сверку с Compose - так и задумано.
- Кэш `type=gha` четырёх scope делит квоту кэша Actions (10 ГБ) с pnpm и `.turbo`; замер -
  E0-12O.
- Сборка руками: `docker build --target api -f infra/docker/app.Dockerfile -t sf-api:ci .`
  (`infra/README.md`).

## Отвергнуто

- **`ARG PKG` и одна tsx-цель на все сервисы** (Р2 E0-12C): цель с аргументом нельзя назвать
  в Compose и в матрице CI по имени сервиса, а у `api` свои build args, у api/worker - каталог
  `/data/media`, у `migrate` - другой каталог запуска.
- **Четыре файла с общим кэшем по совпадению инструкций** (как было): общий слой держится
  только на том, что тексты преамбулы совпадают буква в букву; правка одной копии мимо
  других тихо разводит образы.
