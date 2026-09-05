# E7. Analytics Warehouse — декомпозиция на задачи

_Дата: 2026-09-05. Источник: `20_TZ_HIGH_LEVEL.md` (E7), `10_SYSTEM_DESIGN.md` §4 (`analytics.ingest`), §5 (Own channel), §7.2, §8 (безопасность), `01_ARCHITECTURE.md` §5.10. Статус: ✅ декомпозирован. Зависит от E0; независим от E1–E6, кроме моста «Опубликовано» из E6 и снапшотов из E1._

## Цель эпика

Собственная аналитика канала в своей БД.

**AC эпика:** после OAuth данные канала появляются в БД и дашборде; ежедневное пополнение без ручных действий; для каждого опубликованного Short видна динамика; ручной журнал фазы 0 импортируем (см. E12).

## Внешние предусловия

1. Google Cloud проект (тот же, что для E1): включить **YouTube Analytics API**, создать **OAuth client** (тип Web application), redirect URI = `GOOGLE_OAUTH_REDIRECT_URL`; в тестовом режиме OAuth-consent добавить свой аккаунт как test user (иначе refresh-token живёт 7 дней — важно).
2. `TOKEN_ENCRYPTION_KEY` (32 байта hex) в `.env`.
3. Scopes v1: `youtube.readonly`, `yt-analytics.readonly`. Монетизационный `yt-analytics-monetary.readonly` — только когда появится revenue (System Design §7.2). Scope `youtube.upload` добавит E11 (потребует повторного consent).

## Что уже есть

- `@sf/db`: `own_video`, `analytics_daily (own_video_id, day, country, метрики)`, `dub_track`, `oauth_token (encrypted_refresh_token, scopes)`.
- `@sf/youtube`: заглушка `AnalyticsApiClient`; рабочий `DataApiClient` (E1-01).
- Из E1: `tracked_channel`/`tracked_video`/снапшоты/сигналы; из E6: `own_video.createFromIdea`.

## Архитектурные решения E7

1. **Свой канал — это тоже `tracked_channel`.** Флаг `is_own = true`. Синк загрузок, снапшоты публичной статистики (1h…7d) и даже сигналы работают тем же кодом Radar — никакого дублирования. `own_video.tracked_video_id` связывает приватную аналитику с публичными снапшотами. Backfill своего канала — все видео (не 50).
2. **OAuth — offline flow одного пользователя, токен шифруется.** `/oauth/google/start` → consent → `/oauth/google/callback` сохраняет refresh token в `oauth_token` (AES-256-GCM, ключ из env, nonce в записи). Access token кэшируется в Redis до истечения. Потеря/отзыв токена → алерт на `/system` и понятная кнопка «Переподключить».
3. **Ingest — скользящее окно с перезаписью.** Ежедневно запрашиваем последние `analytics.maturity_days` (7) дней по всем своим видео и делаем upsert по `(own_video_id, day, country)`. Аналитика YouTube дозревает 2–3 дня, окно в 7 дней перекрывает это с запасом. Первый запуск — backfill от `published_at` самого раннего видео.
4. **Два отчёта на видео-день.** (a) `dimensions=video,day` — все метрики; (b) `dimensions=video,day,country` — только `views, estimatedMinutesWatched, averageViewDuration` (остальные по стране могут быть недоступны — уточнить в E7-03). Фильтр `video==id1,id2,…` батчами (лимит id на запрос уточняется в E7-03; ориентир — не более 200), `ids=channel==MINE`.
5. **Витрина `own_video_metrics` — для дашборда и E8.** Ежедневный job считает по каждому видео: `views24h` и `views48h` (из снапшотов Radar), `views7d`, `views28d`, `avgViewDurationSec`, `avgViewPct`, `engagedViewRate`, `likeRate`, `subsPer1kViews`, `retentionProxy` (`avgViewPct × views24h_ratio_to_baseline`), `baselineRatio24h` (относительно базлайна своего канала — E1-05). Одна строка на видео, перезаписывается. E8 читает только её.
6. **Дабы — ручной журнал, структурированный.** Analytics API не отдаёт разрез по аудиодорожкам (проверить в E7-03; если появится — добавить ingest). `dub_track` расширяется оценками 1–5 по критериям (voice, translation, timing, tone) и решением publish/unpublish; заполняется на этапе ревью дабов в Studio (E9 сделает удобную сетку, здесь — рабочая форма).
7. **Analytics API квота — отдельный счётчик.** У Analytics API своя квота (запросов/день), не units Data API. `UsageLogger` пишет `provider: youtube_analytics, units: 1` на запрос; soft cap `YT_ANALYTICS_DAILY_SOFT_CAP` в конфиге.

## Изменения схемы БД (миграция `0007_analytics`)

| Таблица | Изменение |
|---|---|
| `tracked_channel` | `+ is_own bool default false` (partial unique: не более одного own) |
| `own_video` | `+ tracked_video_id FK nullable`, `+ script_id FK nullable`, `+ duration_sec`, `+ thumbnail_url`, `+ privacy_status`, `+ original_language`, `+ auto_dub_enabled bool`, `+ updated_at` |
| `analytics_daily` | `+ ingested_at`; индекс `(own_video_id, day)`; `country` nullable уже есть |
| `own_video_metrics` | новая: `own_video_id PK, views24h, views48h, views7d, views28d, avg_view_duration_sec, avg_view_pct, engaged_view_rate, like_rate, subs_per_1k_views, retention_proxy, baseline_ratio_24h, computed_at` |
| `dub_track` | `+ voice_score int`, `+ translation_score int`, `+ timing_score int`, `+ tone_score int`, `+ publish_decision enum(publish, unpublish, undecided)`, `+ reviewed_at`; `status` остаётся |
| `oauth_token` | `+ nonce`, `+ expires_hint`, `+ email`, `+ channel_id`, `+ last_refresh_at`, `+ last_error` |
| `app_setting` | `analytics.maturity_days`, `analytics.ingest_time`, `analytics.country_metrics` |

---

## Задачи

Суммарно ≈ 10.5–11 дней.

### E7-01. Google OAuth2 offline flow и шифрование токена

**Сделать:**
- `@sf/youtube/oauth`: `buildAuthUrl(state)`, `exchangeCode(code)`, `refreshAccessToken(refreshToken)` поверх `google-auth-library`; `TokenStore` (шифрование AES-256-GCM в `@sf/core/crypto` — чистые функции `encrypt/decrypt(key, plaintext)` с тестами).
- Роуты api: `GET /oauth/google/start` (state в Redis, TTL 10 мин), `GET /oauth/google/callback` (проверка state, обмен, сохранение, редирект на `/system`), `GET /oauth/google/status`, `POST /oauth/google/disconnect`.
- `getAccessToken()` с кэшем в Redis и защитой от параллельного refresh (lock).
- Ошибки `invalid_grant` → `oauth_token.last_error`, алерт `oauth_expired`.
- Тесты: crypto round-trip, state mismatch → 400, подменённый обмен кода.

**DoD:** consent проходит с реального аккаунта; refresh token в БД зашифрован; `/system` показывает «подключено: <email>, канал <id>».
**Оценка:** 1.5 д. **Зависимости:** E0-06, E0-09.

### E7-02. Свой канал как `tracked_channel`, реестр `own_video`

**Сделать:**
- После OAuth: `channels.list mine=true` (через OAuth, не API key) → создать/пометить `tracked_channel.is_own`, backfill всех загрузок через E1-03 (лимит backfill для own — без ограничения).
- Job `analytics.sync-own-videos` (после каждого синка своего канала): для каждого `tracked_video` своего канала — upsert `own_video (yt_video_id, tracked_video_id, published_at, title, duration, source: sync)`; если уже есть запись из E6 (`source: app`) — связать, не дублировать.
- Привязка к идее: `PATCH /analytics/videos/:id { ideaId, scriptId }` для видео, опубликованных вне приложения; снятие привязки.
- Тесты слияния `app` + `sync`.

**DoD:** все опубликованные Shorts канала есть в `own_video` с публичными снапшотами; ручная привязка к идее работает.
**Оценка:** 1 д. **Зависимости:** E7-01, E1-03.

### E7-03. `AnalyticsApiClient`

**Сделать:**
- `reports.query` обёртка: `queryVideoDaily({ videoIds, startDate, endDate })`, `queryVideoDailyByCountry(...)`; Zod-схемы ответа (columnHeaders → типизированные строки); батчинг по id; `UsageLogger` (решение 7).
- Спайк внутри задачи: фактический лимит id в фильтре `video==`, доступность метрик по `country`, наличие разреза по аудиодорожкам/`audioTrack` — результаты в раздел «Результаты проверки API» ниже.
- Ошибки: 401 → refresh и повтор один раз; 403 quota → пауза `analytics.*`; 400 на неподдерживаемую комбинацию метрик → понятная ошибка, не ретрай.
- Тесты на фикстурах реальных ответов.

**DoD:** запрос по 2–3 реальным видео возвращает строки с метриками из blueprint §5.10.
**Оценка:** 1 д. **Зависимости:** E7-01.

### E7-04. Job `analytics.ingest`

**Сделать:**
- Cron ежедневно в `analytics.ingest_time` (по умолчанию 09:00 TZ оператора — данные за вчера уже частично есть); `jobId = analytics.ingest:<date>`; ручной запуск.
- Окно `[today − maturity_days, today − 1]`, для первого запуска — от самого раннего `published_at`, чанками по 30 дней.
- Upsert `analytics_daily` (video,day) и (video,day,country); `ingested_at`.
- Итог в лог: видео / дней / строк / запросов; ошибки по отдельным батчам не отменяют остальные.
- Интеграционный тест с фейковым клиентом: перезапись дозревших значений, backfill чанками.

**DoD:** после первого запуска история канала в БД; на следующий день значения за последние дни обновились без ручных действий.
**Оценка:** 1.5 д. **Зависимости:** E7-03, E7-02.

### E7-05. Витрина `own_video_metrics` и миграция `0007_analytics`

**Сделать:**
- Миграция по таблице выше; репозитории `analyticsDailyRepo`, `ownVideoMetricsRepo`.
- Чистые функции в `@sf/core/analytics`: `viewsAtHours(snapshots, h)` (интерполяция между ближайшими снапшотами, `null`, если нет данных в окне), `engagedViewRate`, `likeRate`, `retentionProxy`, `baselineRatio24h(views24h, baseline)`; тесты.
- Job `analytics.materialize` после `analytics.ingest` и после каждого снапшота своих видео моложе 7 дней: пересчёт витрины.

**DoD:** у каждого `own_video` строка витрины; для свежего видео `views24h` появляется через ~24 ч из снапшотов, аналитические поля — по мере ingest.
**Оценка:** 1 д. **Зависимости:** E7-04, E1-05.

### E7-06. Журнал дабов `dub_track`: форма и API

**Сделать:**
- `GET /analytics/videos/:id/dubs`, `PUT /analytics/videos/:id/dubs/:language { kind, status, scores, publishDecision, qualityNotes }` (upsert по `(own_video_id, language, kind)`), `GET /analytics/dubs/summary` (средние оценки по языкам).
- Форма на странице видео: сетка «язык × критерии 1–5 × решение × заметка», языки из `app_setting.languages.review_list` (E9 заменит на матрицу языков).
- Тесты.

**DoD:** оператор после ревью в Studio за 2–3 минуты заносит оценки по 10 языкам.
**Оценка:** 1 д. **Зависимости:** E7-02.

### E7-07. API и контракты Analytics

**Сделать:**
- `GET /analytics/videos` (витрина + идея/скрипт, фильтры по периоду публикации, сортировки), `GET /analytics/videos/:id` (карточка: витрина, `analytics_daily` серия, top-страны, снапшоты Radar, DNA своего видео если есть), `GET /analytics/compare?ids=` (2–5 видео, выровненные по дню от публикации), `GET /analytics/channel/summary` (последние 7/28 дней), `POST /analytics/ingest/run`.
- Контракты `@sf/contracts/analytics/*`, клиент, тесты.

**DoD:** OpenAPI; тесты зелёные.
**Оценка:** 0.5–1 д. **Зависимости:** E7-05, E7-06.

### E7-08. UI Analytics

**Сделать:**
- `/analytics`: сводка канала (views 7/28д, подписчики, средний AVD/%), таблица видео (миниатюра, дата, идея, views24h/7d, AVD, %, engaged rate, ×базлайн, флаг эксперимента — позже E8), сортировки, период.
- `/analytics/videos/[id]`: графики (Recharts) — просмотры по дням, накопительно от публикации, AVD/%, страны (топ-10), публичные снапшоты первых 48 ч; блок идеи/скрипта/DNA; форма дабов (E7-06); кнопки привязки к идее.
- `/analytics/compare`: до 5 видео, кривые от дня публикации, таблица метрик рядом.
- Пустые состояния: «Подключите YouTube (OAuth)» с кнопкой; «данные дозревают».

**DoD:** динамика каждого опубликованного Short видна; сравнение 2–5 видео работает.
**Оценка:** 2 д. **Зависимости:** E7-07, E0-10.

### E7-09. Сверка с YouTube Studio, ADR

**Сделать:**
- Для 5 видео сравнить цифры за один день с Studio: views, AVD, %; расхождения задокументировать (Studio показывает часть метрик в другой TZ/агрегации).
- Проверить, что 7 дней подряд ingest прошёл без ручного вмешательства.
- ADR по решениям 1–7; обновить `10_SYSTEM_DESIGN.md` §4, §5, §7.2.

**DoD:** расхождения ≤ 2 % по views или объяснены; документы обновлены.
**Оценка:** 1 д. **Зависимости:** E7-08.

---

## Порядок

```text
E7-01 ─► E7-02 ─┬─► E7-04 ─► E7-05 ─► E7-07 ─► E7-08 ─► E7-09
       └► E7-03 ─┘         E7-06 ─┘
```

E7 можно вести параллельно с E3–E6 (нужен только E0 и E1-01/E1-03/E1-05).

## Результаты проверки API (E7-03)

_Лимит id в фильтре, метрики по country, разрез по аудиодорожкам._

## Вне скоупа E7

- Revenue и монетизационный scope — до появления монетизации.
- Аналитика комментариев/аудитории (демография) — не в MVP.
- Экспорт в внешние BI — нет.

## Приёмка

| AC | Как проверяем | Статус |
|---|---|---|
| После OAuth данные в БД и дашборде | consent → backfill → `/analytics` показывает все Shorts | ⬜ |
| Ежедневное пополнение без ручных действий | 7 дней логов `analytics.ingest` без ошибок | ⬜ |
| Динамика каждого Short | карточка видео с графиками | ⬜ |
| Импорт ручного журнала | E12 выполнен, ручные видео связаны с `own_video` | ⬜ |
