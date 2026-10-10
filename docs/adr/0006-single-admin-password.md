# ADR-0006: один admin-пароль - HTTP Basic на web и api, api наружу не публикуется

Дата: 2026-10-10   Статус: принято   Задача: E0-13 (решение 2 эпика E0; реализовано в E0-06, E0-07, E0-10, E0-11)

## Контекст

Инструмент внутренний, оператор один. Учётные записи, сессии и роли - отдельная подсистема
со своей схемой и своими дырами, а защищать нужно ровно две поверхности: страницы панели (web)
и REST API, у которого есть право ставить джобы и тратить квоты. Секрет при этом не должен
попасть в браузерный бандл: web обращается к api с паролем, и этот вызов обязан жить на сервере.

## Решение

- **Один секрет `ADMIN_PASSWORD`** из `@sf/config` (не короче 8 символов - `packages/config/src/schema.ts:96`,
  и не короче 16 вне `development`/`test` - `packages/config/src/load-env.ts:6`). Имя пользователя не проверяется
  (`docs/DECISIONS.md`, 08.09.2026).
- **web**: `apps/web/src/middleware.ts` - HTTP Basic на всех путях, кроме `_next/static/`,
  `_next/image` и `favicon.ico` (`config.matcher`). Middleware работает в Node-runtime
  (`config.runtime = "nodejs"`), а не на edge: только так пароль читается из
  `@sf/config/server`, без `process.env` в `apps/web/src` (`docs/DECISIONS.md`, 10.10.2026,
  E0-10; исходный текст решения 2 эпика о «Next middleware» здесь уточнён по коду).
  Отказ - `401` с `WWW-Authenticate: Basic realm="shorts-factory", charset="UTF-8"`;
  и отказ, и пропущенная страница несут `Cache-Control: private, no-store`
  (`apps/web/src/lib/basic-auth.ts`, урок L-017). Сравнение - SHA-256 обеих сторон
  и `timingSafeEqual`.
- **api**: `apps/api/src/plugins/auth.ts` - `@fastify/basic-auth` глобальным хуком `onRequest`,
  поэтому роут нового эпика защищён в момент регистрации. Без пароля отвечает только
  `PUBLIC_ROUTES = new Set(["/health"])`; `/docs`, `/openapi.json` и `/system/*` - за паролем.
  Сравнение - тем же приёмом SHA-256 + `timingSafeEqual`.
- **api не публикуется**: у сервиса `api` в `infra/docker-compose.app.yml` нет `ports`; единственный
  опубликованный порт стека - web (`${WEB_PORT:-3000}:3000`). Это правило 1 гейта `compose`
  (`scripts/compose-rules.mjs`: api, worker и migrate не публикуют ничего).
- **web ходит в api только с сервера**: `apps/web/src/lib/api.server.ts` строит клиент
  `@sf/api-client/server` с `baseUrl = env.API_INTERNAL_URL` (в Compose - `http://api:3001`)
  и паролем из `@sf/config/server`. Оба серверных входа (`@sf/config`, `@sf/api-client`)
  помечены `server-only`, их импорт из клиентского компонента - ошибка `next build`.
  Механизм двух входов - ADR-0001, здесь не повторяется.

## Альтернативы

- **Учётные записи и сессии (NextAuth, cookie-сессии)** - схема пользователей, ротация, CSRF;
  для одного оператора избыточно.
- **Edge-middleware с `process.env.ADMIN_PASSWORD`** - обходит Zod-валидацию `@sf/config`
  и правило «`process.env` только в `@sf/config`» (`docs/DECISIONS.md`, 10.10.2026, E0-10).
- **Проверка пароля в `layout.tsx`** - не закрывает route handlers и статику страниц, меняет
  смысл решения 2.
- **Браузер ходит в api напрямую** - пароль уезжает в клиентский код, а api приходится
  публиковать.

## Последствия

- Новый роут api защищён без единой строки; публичный роут - явная правка `PUBLIC_ROUTES`,
  которую видит ревью.
- Новая страница web защищена middleware; данные из api она получает только в серверном коде
  через `apps/web/src/lib/api.server.ts`.
- Публикация порта api в Compose валит гейт `compose`.
- Смена пароля - правка `.env` и перезапуск сервисов; сессий, которые надо сбрасывать, нет.
- Basic auth передаёт пароль в каждом запросе: вне localhost web обязан стоять за TLS
  (выкладка на VPS - после E1, вне скоупа E0).
