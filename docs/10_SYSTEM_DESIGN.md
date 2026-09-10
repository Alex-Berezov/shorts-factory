# AI Shorts Factory — System Design (v1)

_Дата: 2026-09-05. Статус: базовая версия для старта разработки. Язык кода и комментариев — английский, язык проектных документов — русский._

Этот документ переводит продуктовый blueprint (`01_ARCHITECTURE.md`) в конкретный технический дизайн: стек, топология сервисов, модель данных, интеграции, фоновые процессы, наблюдаемость и ограничения.

---

## 1. Принципы проектирования

1. **Internal-first.** Один пользователь-оператор (владелец), один канал. Никакого мультитенантства, биллинга, публичной регистрации в MVP. Но границы модулей держим чистыми, чтобы SaaS-выделение позже не потребовало переписывания.
2. **Модульный монолит, а не микросервисы.** Один деплой API + один деплой worker'а. Модули (Radar, Intelligence, Inbox, Research, Script, Analytics, Experiments, Localization, Publishing) — это пакеты/каталоги с явными интерфейсами, а не отдельные сервисы.
3. **Пайплайн = очередь задач.** Всё асинхронное (синк каналов, снапшоты, Gemini-анализ, ресёрч, скрипты, TTS) — это jobs в очереди с ретраями, идемпотентностью и dead-letter. UI никогда не ждёт LLM синхронно дольше нескольких секунд.
4. **Все AI-выводы — версионированные артефакты.** Каждый ответ Gemini/LLM сохраняется как JSON c указанием модели, промпт-версии, стоимости и времени. Ничего не перезаписывается — только новые версии. Это фундамент Experiment Engine.
5. **Квоты и бюджет — first-class citizens.** YouTube Data API (10 000 units/день по умолчанию) и бюджет $500–700/3 мес — жёсткие ограничения. Каждый интеграционный клиент считает units/токены/доллары и пишет их в БД.
6. **Человек в контуре.** Approve/Reject/Later, ревью скриптов и дабов — обязательные ручные шаги. Автоматизация готовит, человек решает.

---

## 2. Технологический стек

| Слой | Выбор | Обоснование |
|---|---|---|
| Язык | **TypeScript 5.x (strict)** везде | одно ядро типов от БД до UI |
| Runtime | **Node.js 22 LTS** | LTS, нативный fetch, стабильный ESM |
| Монорепо | **pnpm workspaces + Turborepo** | инкрементальные билды, общие пакеты |
| Web (dashboard) | **Next.js 15 (App Router) + React 19** | быстрый внутренний дашборд, server components для данных |
| UI-kit | **Tailwind CSS + shadcn/ui + Recharts** | скорость сборки внутреннего UI, графики аналитики |
| API | **Fastify 5 + Zod** (zod-типизированные роуты) | лёгкий, быстрый, схемы = валидация = типы = OpenAPI |
| Общение web↔api | REST + генерируемый typed-client из Zod-схем | просто, отлаживаемо; tRPC не нужен при отдельном API |
| Очереди/джобы | **BullMQ + Redis 7** | cron-джобы (снапшоты), ретраи, приоритеты, rate-limit |
| БД | **PostgreSQL 16** | реляционка + JSONB для AI-артефактов; одна БД на всё |
| ORM/миграции | **Drizzle ORM + drizzle-kit** | SQL-близкий, лёгкий, отличная типизация |
| Кэш | Redis (тот же инстанс) | кэш квот, локи, дедупликация джобов |
| Файлы (аудио/видео/медиа) | локальная FS в MVP (`/data/media`), интерфейс Storage с прицелом на S3-совместимое хранилище | бюджет; абстракция позволит переехать на R2/S3 |
| LLM-анализ видео | **Gemini API** (`@google/genai`), модель тек. поколения с video understanding по публичному YouTube URL | единственный API с нативным анализом публичных YouTube-ссылок |
| Ресёрч/скрипты | Gemini (+ опционально Anthropic API) через общий `LlmClient`-интерфейс | сменяемость провайдера, bake-off |
| YouTube | **googleapis** (Data API v3, Analytics API v2) + OAuth2 | официальные клиенты |
| TTS | адаптеры: ElevenLabs, OpenAI TTS, Google Chirp 3 HD, Gemini TTS, Cartesia | bake-off по плану, общий интерфейс `TtsProvider` |
| Валидация/конфиг | Zod-схемы `.env` в `@sf/config` | fail-fast при старте |
| Тесты | **Vitest** (+ supertest для API) | быстрые, TS-нативные |
| Линт/формат | **Biome** | один инструмент вместо ESLint+Prettier |
| Логи | **pino** (+ pino-pretty в dev) | структурные JSON-логи |
| Контейнеры | **Docker Compose** (postgres, redis, api, worker, web) | локально = прод-подобно |
| CI | GitHub Actions: lint → typecheck → test → build | базовая гигиена |
| Деплой (MVP) | один VPS (Docker Compose) или Fly.io/Railway | внутренний инструмент, минимум затрат |

Сознательно **не** берём в MVP: Kubernetes, микросервисы, Kafka, ClickHouse, векторные БД (эмбеддинги для story-кластеров можно хранить в Postgres + pgvector, если понадобится — расширение уже заложено в схему как опция), собственную auth-систему (достаточно одного admin-логина/basic auth за VPN).

---

## 3. Топология системы

```text
┌────────────────────────────────────────────────────────────────────┐
│                          Docker Compose                            │
│                                                                    │
│  ┌──────────┐   REST/JSON   ┌──────────┐    jobs    ┌───────────┐  │
│  │ apps/web │ ────────────► │ apps/api │ ─────────► │  Redis    │  │
│  │ Next.js  │               │ Fastify  │ ◄───────── │  BullMQ   │  │
│  └──────────┘               └────┬─────┘            └─────┬─────┘  │
│                                  │                        │        │
│                                  ▼                        ▼        │
│                          ┌──────────────┐         ┌─────────────┐  │
│                          │ PostgreSQL16 │ ◄────── │ apps/worker │  │
│                          └──────────────┘         └──────┬──────┘  │
│                                                          │         │
└──────────────────────────────────────────────────────────┼─────────┘
                                                           ▼
                       Внешние API: YouTube Data v3 / Analytics v2,
                       Gemini API, TTS-провайдеры
```

- **apps/web** — дашборд: Idea Inbox, Radar, карточки Content DNA, аналитика, эксперименты, статусы пайплайна.
- **apps/api** — REST API + OAuth-коллбэки Google + отдача медиафайлов.
- **apps/worker** — все фоновые процессы (cron + event-driven jobs).
- **packages/** — общий код (см. §6 и структуру репозитория).

---

## 4. Фоновые процессы (BullMQ queues)

| Очередь | Триггер | Что делает |
|---|---|---|
| `radar.sync-channels` | cron (каждые 30–60 мин, конфиг) | по каждому tracked_channel: новые видео через Data API (playlistItems uploads), запись tracked_video |
| `radar.snapshot` | cron-тик каждые 5 мин: выбор из БД пар (video, point) с наступившей точкой 1h/3h/6h/12h/24h/48h/7d без снапшота (см. `31_E1_TASKS.md`, решение 1) | videos.list (батчами до 50 id = 1 unit/батч), запись video_stats_snapshot; опоздавшие точки помечаются is_late |
| `radar.score` | после каждого снапшота | views/hour, ускорение, отклонение от базлайна канала, trend_signal |
| `radar.cluster` | cron (2–4 раза/день) | группировка одинаковых сюжетов между каналами → story_cluster |
| `radar.baseline` | cron (ежедневно) | пересчёт базлайна канала: медиана/перцентили финальных просмотров + кривая роста по точкам |
| `intel.analyze-video` | вручную из UI / автоматически для top trend_signal | Gemini whole-video анализ по публичному URL → video_analysis (Content DNA JSON) |
| `intel.hook-pass` | для приоритетных победителей | второй проход по 0–5 сек |
| `inbox.build` | cron (1 раз/день, утро) | генерация ранжированных idea-карточек из сигналов+DNA |
| `research.run` | approve идеи (или авто для top-N) | Research Agent → factual brief |
| `script.generate` | после research | хуки ×3–5, мастер-скрипт, experiment tags |
| `production.package` | после выбора скрипта | shot list, таймлайн, чек-лист |
| `analytics.ingest` | cron (ежедневно) | YouTube Analytics API по своему каналу → analytics_daily |
| `experiment.recompute` | cron (ежедневно, после ingest) | winners/losers, корреляции, рекомендации |
| `localize.script` / `tts.generate` / `tts.bakeoff` | Phase 4 | локализация + генерация кастомных дорожек + bake-off голосов |
| `analytics.materialize` | после `analytics.ingest` и снапшотов своих видео | витрина `own_video_metrics` (E7) |
| `experiment.features` | публикация / новая DNA / правка | автозаполнение фич видео с провенансом (E8) |
| `inbox.later-return` | cron (ежечасно) | возврат отложенных идей, истечение угасших (E3) |
| `publish.upload` / `publish.sync-status` / `publish.localizations` / `publish.captions` | Phase 5 | загрузка, статусы, локализованные метаданные, captions по квоте (E11) |
| `system.usage-rollup` | cron (ежедневно + инкремент) | витрина `api_usage_daily` (E13) |
| `system.quota-guard` | каждый job косвенно | учёт units/токенов/стоимости, стоп при превышении дневных лимитов |
| `system.quota-reset` | cron 00:05 America/Los_Angeles | после сброса дневной квоты YouTube удаляет записи с причинами `youtube_quota` (Data API) и `youtube_analytics_quota` (Analytics API) из `app_setting.queues.autopaused` (операторский `queues.enabled` не трогает); саму паузу снимает ресинк воркера (ADR-0003) |
| `system.dlq` | окончательно упавший job любой очереди | хранит копию job'а (очередь, id, payload, ошибка, попытки) до разбора оператором в E13-02; обработчика нет, записи не удаляются автоматически |
| `system.heartbeat` | cron (каждую минуту) | пишет `worker:heartbeat` в Redis (ISO-метка, TTL 180 с) - признак живого воркера для `/system` (E0-09) и healthcheck контейнера (E0-11) |
| `system.smoke` | вручную (`pnpm --filter @sf/worker smoke`), int-тесты | сквозная проверка конвейера: job проходит Redis, выполняется воркером и пишет строку в `api_usage_log` (`provider: system`, `units: 0`) |

Требования ко всем джобам: идемпотентность (уникальные jobId), экспоненциальные ретраи, DLQ, лог стоимости в `api_usage_log`.

**Бюджет квоты YouTube Data API (10 000 units/день):** снапшоты батчами — при 100 отслеживаемых видео в активном окне это ~2–3 units за проход; синк каналов через uploads-playlist — 1 unit на канал за проход. Поиск (`search.list`, 100 units) не используем вообще. Планируемый расход < 1 500 units/день с большим запасом.

---

## 5. Модель данных (PostgreSQL, ядро v1)

Черновая схема уже заложена в `packages/db/src/schema/`. Ключевые таблицы:

**Radar**
- `tracked_channel` (yt_channel_id, title, uploads_playlist_id, baseline_stats JSONB, is_active)
- `tracked_video` (yt_video_id, channel_id FK, published_at, duration_sec, title, description, is_short)
- `video_stats_snapshot` (video_id FK, captured_at, views, likes, comments, snapshot_point enum '1h'…'7d')
- `trend_signal` (video_id FK, computed_at, views_per_hour, acceleration, baseline_ratio, score, status)
- `story_cluster` (label, first_seen_at, momentum) + `story_cluster_video` (m2m)

**Intelligence**
- `video_analysis` (video_id FK nullable / local_file_path, kind enum 'full'|'hook_pass'|'own_video', model, prompt_version, dna JSONB — полная структура Content DNA из `01_ARCHITECTURE.md` §5.2, cost_usd, created_at)

**Idea flow**
- `idea` (title, summary, status enum 'new'|'approved'|'rejected'|'later'|'in_research'|'scripted'|'in_production'|'published', scores JSONB, source_cluster_id FK, decided_at)
- `idea_source_video` (idea_id, video_id, role)
- `research_brief` (idea_id FK, verified_claims JSONB, uncertain_claims JSONB, sources JSONB, risk_flags JSONB, status)
- `script` (idea_id FK, version, language='en', hooks JSONB, body TEXT, structure JSONB, target_duration_sec, experiment_tags JSONB, status)
- `production_package` (script_id FK, shot_list JSONB, narration_timeline JSONB, overlays JSONB, notes, checklist JSONB)

**Own channel**
- `own_video` (yt_video_id, idea_id FK nullable — для ручной фазы допускается NULL, published_at, title, language, experiment_features JSONB — фичи из §5.11 blueprint, manual_log JSONB — для импорта ручного журнала фазы 0)
- `analytics_daily` (own_video_id FK, date, country nullable, views, engaged_views, avg_view_duration_sec, avg_view_pct, est_minutes_watched, likes, comments, shares, subs_gained, subs_lost, revenue nullable)
- `dub_track` (own_video_id FK, language, kind enum 'auto'|'custom', provider nullable, status enum 'generated'|'reviewed'|'published'|'rejected', quality_notes, file_path nullable)

**Experiments**
- `experiment` (hypothesis, design JSONB, status, started_at, ended_at)
- `experiment_recommendation` (generated_at, body, confidence, based_on JSONB)

**System**
- `api_usage_log` (provider, operation, units, tokens_in/out, cost_usd, job_id, created_at)
- `prompt_version` (name, version, template, created_at)
- `app_setting` (key, value JSONB)

Все AI-JSONB валидируются Zod-схемами из `@sf/core` на записи и чтении.

**Дополнения по итогам декомпозиции (2026-09-05).** Детали колонок — в таблицах «Изменения схемы БД» соответствующих `docs/3x_Ex_TASKS.md`; миграции нумеруются по эпикам (`0001_radar` … `0013_system`).
- Radar (E1): `tracked_video.radar_status`, `is_backfill`, `is_available`; `video_stats_snapshot.is_late`; `trend_signal` — числа `real`, append-only; `tracked_channel.is_own` (E7).
- Intelligence (E2): `video_analysis.result` (вместо `dna`; для `hook_pass` — `HookAnalysis`), `status`, токены, `raw_response_path`.
- Idea flow (E3–E6): `idea.fingerprint`, `later_until`, `source`, статус `expired`; новая `idea_decision` (append-only история решений); `research_brief` версионируется (`version`, `author`, единый `claims`); `script` — `segments`, `checks`, `is_final`, `author`; `production_package` — версии + `checklist_state`.
- Own channel (E7, E12): `own_video_metrics` (витрина для дашборда и E8), `own_video.source`, `tracked_video_id`, `publish_item_id`; `dub_track` — оценки 1–5 и `publish_decision`; `import_batch`.
- Experiments (E8): `experiment_run`, `experiment_finding`, `topic_momentum`; `experiment_features` — с провенансом по полю; `idea.experiment_id/variant`.
- Localization / Voice (E9–E10): `language_config`, `localized_script`, `handoff_package`, `voice_profile`, `bakeoff`, `bakeoff_sample`, `audio_asset`.
- Publishing (E11): `publish_item`, `publish_slot`.
- System (E13): `alert`, `audit_log`, `api_usage_daily`, `external_condition`; `oauth_token` — nonce, scopes_version.

---

## 6. Границы модулей и структура монорепозитория

```text
shorts-factory/
├── apps/
│   ├── web/        # Next.js dashboard (Inbox, Radar, Analytics, Experiments)
│   ├── api/        # Fastify REST API + Google OAuth callback + media serving
│   └── worker/     # BullMQ workers: все очереди из §4
├── packages/
│   ├── core/       # доменные типы, Zod-схемы (ContentDNA, Idea, Script...), чистая бизнес-логика скоринга
│   ├── db/         # Drizzle-схема, миграции, репозитории
│   ├── config/     # типизированный .env (Zod), константы квот/бюджета
│   ├── contracts/  # Zod-схемы запросов/ответов API, общие для api и web (E0-07)
│   ├── api-client/ # типизированный fetch-клиент по контрактам (E0-07)
│   ├── storage/    # интерфейс Storage + локальная FS (E9-06), позже S3-совместимое
│   └── integrations/
│       ├── youtube/  # DataApiClient, AnalyticsApiClient, OAuth, учёт квоты
│       ├── gemini/   # VideoAnalysisClient (public URL + local file), LlmClient
│       └── tts/      # интерфейс TtsProvider + адаптеры провайдеров
├── infra/          # docker-compose, Dockerfile'ы, деплой-заметки
└── docs/           # проектная документация (этот файл, ТЗ и исходные 01–06)
```

Правило зависимостей: `apps/* → packages/*`; `integrations → core, config`; `db → core`;
`contracts → core` (только доменные коды ошибок и `zod`); `api-client → contracts` (и больше
ни на что: ни `core`, ни `config`, ни `db` — клиент знает форму провода и адрес, а не домен);
`core` ни от чего не зависит. Скоринг (velocity/acceleration/ranking) — чистые функции в `core`,
покрытые юнит-тестами.

`@sf/api-client` собирает `Authorization` из `ADMIN_PASSWORD` и потому серверный: два входа
(`.` с условием `browser` и `./server`), оба ведут в модуль с маркером `server-only`, как
у `@sf/config` (ADR-0001). Импорт клиента из клиентского компонента web — ошибка сборки,
а не пароль в браузерном чанке.

Единственное исключение: `packages/db/src/cli/**`, `packages/db/test/**` и `packages/db/vitest*.config.ts` импортируют `@sf/config`, чтобы взять `DATABASE_URL` (команды `db:migrate`, `db:seed`, тесты пакета и их конфиги, включая `setupFiles` в `vitest.int.config.ts`). Библиотечная часть `@sf/db` (`client`, `migrate`, `seed`, `repos`, `schema`) конфигурации не знает и принимает подключение параметром — см. `docs/adr/0002-db-connection-and-cli-config.md`.

---

## 7. Интеграции: ключевые решения

### 7.1 YouTube Data API
- Синк новых видео **только** через uploads-playlist (`playlistItems.list`, 1 unit), не через `search.list` (100 units).
- Снапшоты — `videos.list` батчами id (до 50 за вызов).
- Учёт units на каждый вызов → `api_usage_log`; мягкий лимит в конфиге (например 8 000/день), при достижении — очереди Radar автопаузятся записью `{<очередь>: "youtube_quota"}` в `app_setting.queues.autopaused` (операторский ключ `queues.enabled` при этом не меняется); на паузу их ставит воркер (ADR-0003, в течение минуты).

### 7.2 YouTube Analytics API (свой канал)
- OAuth2 offline-flow, refresh-token в БД (шифрованно) — единственный пользователь.
- Ежедневный ingest с шириной окна 3–7 дней назад (данные аналитики дозревают).
- Scope монетизации добавляется только когда появится revenue.

### 7.3 Gemini video understanding
- Вход: публичный YouTube URL (конкуренты) или локальный файл (свои видео, повышенная детализация кадров).
- Выход строго структурированный: response_schema/JSON-mode + Zod-валидация; при невалидном JSON — 1 ретрай с repair-промптом.
- Промпты версионируются в `prompt_version`; DNA всегда содержит `prompt_version` и `model`.
- Двухпроходность: полный анализ → отдельный Hook Pass (0–5 сек) для приоритетных.

### 7.4 TTS (Phase 4)
- Общий интерфейс: `synthesize({ text, language, voiceRef, instructions, rate }) → { audioPath, costUsd, meta }`.
- Bake-off-раннер: один скрипт × N языков × M провайдеров → таблица сравнения в UI.
- YouTube Auto Dub — baseline в сравнении, но не провайдер в коде.

### 7.5 Публикация
- Upload/schedule/метаданные/captions — через Data API (`videos.insert` дорог по квоте: 1600 units — учитывать в планере, при 2 видео/день это приемлемо).
- Кастомные multi-language аудиодорожки: публичного API нет → генерируем правильно именованный пакет файлов + чек-лист ручной загрузки в Studio.

---

## 8. Нефункциональные требования

- **Надёжность:** падение worker'а не теряет задачи (BullMQ persistence); все джобы идемпотентны; ежедневный `pg_dump` в бэкап.
- **Наблюдаемость:** pino-логи со сквозным `jobId`/`requestId`; страница `/system` в дашборде: статусы очередей, расход квот, расход бюджета ($) за день/месяц, ошибки DLQ.
- **Безопасность:** секреты только в env; refresh-token Google шифруется (AES-256-GCM ключом из env); web-доступ за basic auth/одним admin-паролем; никакие ключи не попадают в web-бандл.
- **Стоимость:** hard-caps в конфиге: Gemini $/день, TTS $/мес, YT units/день (Data и Analytics API считаются раздельно); при превышении — соответствующие очереди автопаузятся записью с причиной (`youtube_quota`, `youtube_analytics_quota`, `gemini_budget`, `tts_budget`) в `app_setting.queues.autopaused`, отдельно от операторского `queues.enabled` (паузу ставит воркер по композиции двух ключей, ADR-0003) + алерт в дашборде.
- **Производительность:** масштаб MVP крошечный (≤50 каналов, ≤5000 видео, ≤200 своих Shorts) — Postgres справляется без оптимизаций; индексы по FK и `(video_id, captured_at)`.

---

## 9. Риски и что за ними следить

| Риск | Митигция |
|---|---|
| Gemini перестанет принимать публичные YouTube URL / изменит лимиты | абстракция `VideoAnalysisClient`; fallback: скачивание → анализ локального файла (юр. осторожно, только как запасной путь) |
| Квота Data API | учёт units + отказ от search.list + батчинг |
| Auto Dubbing изменит поведение/качество | dub_track фиксирует наблюдения; Mode B — стратегический путь |
| Нет API для кастомных аудиодорожек | ручной handoff-пакет (заложено) |
| Advanced Features не включатся | не блокер (см. blueprint §6), архитектура не зависит |
| Бюджет $500–700 | api_usage_log + hard caps + страница расходов |

---

## 10. Что дальше

Верхнеуровневое ТЗ с эпиками E0–E13 — в `docs/20_TZ_HIGH_LEVEL.md`. Каждый эпик мы декомпозируем отдельными итерациями на задачи размером 0.5–2 дня.
