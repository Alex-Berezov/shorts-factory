# E2. Video Intelligence / Content DNA — декомпозиция на задачи

_Дата: 2026-09-05. Источник: `20_TZ_HIGH_LEVEL.md` (E2), `10_SYSTEM_DESIGN.md` §5 (Intelligence), §7.3, `01_ARCHITECTURE.md` §3, §5.2. Статус: ✅ декомпозирован. Зависит от E0; от E1 — только точка запуска (сигнал → кнопка/автозапуск), клиент Gemini независим._

## Цель эпика

Глубокий анализ любого публичного Short по URL → структурированная Content DNA.

**AC эпика:** по кнопке на любом сигнале в течение нескольких минут появляется валидная DNA-карточка; невалидный JSON от модели не роняет пайплайн; стоимость каждого анализа видна; повторный запуск создаёт новую версию, не перетирая старую.

## Внешние предусловия

1. Gemini API key (`GEMINI_API_KEY`) с включённым биллингом: анализ YouTube-URL на бесплатном тарифе ограничен по суммарной длительности видео в день, на платном — нет (актуальные лимиты уточняются в E2-01).
2. Только **публичные** видео: unlisted/private по URL Gemini не анализирует. Для своих видео — режим локального файла.

## Что уже есть

- `@sf/core`: `ContentDnaSchema` (поля 1:1 с blueprint §5.2, `dnaSchemaVersion: 1`).
- `@sf/gemini`: заглушка `VideoAnalysisClient` с `AnalysisRequest { source: youtube_url | local_file, pass: full | hook_pass, promptVersion }`.
- `@sf/db`: `video_analysis (video_id | local_file_path, kind, model, prompt_version, dna jsonb, cost_usd)`, `prompt_version`.
- Из E0/E1: `defineJob`, `BudgetGuard("gemini")`, `UsageLogger`, `LlmClient` (текстовый, E1-07), кнопка «Анализировать» и `POST /radar/videos/:id/analyze` (E1-09/E1-10), очереди `intel.analyze-video`, `intel.hook-pass`.

## Архитектурные решения E2

1. **Модель — параметр, а не константа.** `GEMINI_VIDEO_MODEL` и `GEMINI_HOOK_MODEL` в env; выбор конкретных моделей (flash-класс для полного прохода ради стоимости, более сильная — для hook pass) делается по результатам спайка E2-01 на 3–5 реальных Shorts и фиксируется в ADR. Цены за токены — в `app_setting.gemini.prices[model]`, чтобы менять без деплоя.
2. **Структурированный вывод — JSON-mode с `responseSchema`, Zod — последний судья.** JSON-schema для запроса генерируется из Zod (`zod-to-json-schema`) и урезается до подмножества, которое принимает Gemini (без `$ref`, без `additionalProperties`, ограниченная вложенность — точный список ограничений фиксируется в E2-01). Ответ всегда валидируется `ContentDnaSchema`; при провале — один repair-запрос с текстом ошибок Zod и исходным ответом; второй провал → job в DLQ, строка `video_analysis` со `status = invalid` и сырым ответом на диске для разбора.
3. **Промпты — файлы в репозитории, версия — часть имени.** `packages/integrations/gemini/prompts/<name>/<version>.md` (например `dna.full/1.0.0.md`), фронтматтер с описанием и совместимой `dnaSchemaVersion`. При старте worker синхронизирует их в таблицу `prompt_version`. Каждая строка `video_analysis` хранит `prompt_version` и `model` — это обязательное условие для Experiment Engine.
4. **Hook pass — тот же URL, обрезка 0–5 с и повышенная частота кадров.** Через `videoMetadata { startOffset, endOffset, fps }` (без скачивания видео). Своя схема `HookAnalysisSchema` (покадровый разбор первых 5 секунд: кадр → объект → текст → звук → что удерживает), свой промпт `dna.hook_pass`.
5. **Локальный файл — через Files API.** Для своих видео (`kind = own_video`): загрузка файла в Gemini Files API, ожидание `ACTIVE`, анализ с `mediaResolution: high` и повышенным `fps`, удаление файла после анализа. Файлы хранятся в `MEDIA_DIR` через интерфейс Storage (полноценный `@sf/storage` появляется в E9, здесь — минимальная реализация на локальной FS в `@sf/gemini`).
6. **Стоимость считается из `usageMetadata`, а не оценивается.** `cost_usd = tokens_in × price_in + tokens_out × price_out` по таблице цен модели; предварительная оценка (по длительности видео) используется только для гейта бюджета **до** вызова. Видео длиннее `intel.max_duration_sec` (по умолчанию 240) не анализируем — Shorts всегда короче.
7. **Версионирование: ручной запуск всегда создаёт новую версию, автозапуск дедуплицируется.** `jobId` авто = `intel.analyze:<videoId>:<promptVersion>:<model>` (одна DNA на связку), ручной = `…:<requestedAt>`. Ничего не обновляется — только insert.
8. **Автозапуск — по порогу сигнала с дневным лимитом.** `radar.score` после записи сигнала ставит `intel.analyze-video`, если `score >= intel.auto.min_score`, у видео нет DNA для текущего `promptVersion`, и не превышен `intel.auto.daily_max` (по умолчанию 20). Hook pass — авто только для `score >= intel.hook_pass.min_score` или вручную.

## Изменения схемы БД (миграция `0002_intel`)

| Таблица | Изменение | Зачем |
|---|---|---|
| `video_analysis` | `dna` → `result jsonb` (для `hook_pass` там `HookAnalysis`, для остальных — `ContentDna`); `+ schema_version int`; `+ status enum(ok, invalid, failed)`; `+ tokens_in`, `+ tokens_out`; `+ duration_ms`; `+ raw_response_path text`; `+ trigger enum(manual, auto)`; `+ requested_by text`; `+ error text`; `+ own_video_id FK nullable`; индекс `(video_id, kind, created_at desc)` | разные схемы по kind, диагностика, разбор невалидных ответов |
| `prompt_version` | `+ description`, `+ schema_version`, `+ is_active`, `+ checksum` | синк из файлов, защита от правки без смены версии |
| `app_setting` | `gemini.prices`, `intel.auto.min_score`, `intel.auto.daily_max`, `intel.hook_pass.min_score`, `intel.max_duration_sec`, `intel.default_prompt.full`, `intel.default_prompt.hook_pass` | настройка без деплоя |

---

## Задачи

Суммарно ≈ 11 дней.

### E2-01. Спайк: Gemini video understanding по YouTube URL

**Цель:** проверенные ответы на вопросы, от которых зависит вся реализация, до написания продового кода.

**Сделать:**
- Скрипт `packages/integrations/gemini/spike/analyze-url.ts` (`@google/genai`): 3–5 реальных публичных Shorts × 2 кандидата модели; JSON-mode с `responseSchema`, сгенерированной из `ContentDnaSchema`.
- Зафиксировать: какие конструкции JSON-schema модель отвергает; долю валидных по Zod ответов с первого раза; латентность; `usageMetadata` и фактическую стоимость; поведение на unlisted/удалённом видео; работу `videoMetadata { startOffset, endOffset, fps }`; актуальные лимиты на YouTube-URL для платного тарифа.
- Оценить качество вручную по чек-листу: точность транскрипта, таймлайн, hook-разбор, «transferable vs risky».
- Результат — раздел «Результаты спайка» в этом документе + выбор моделей по умолчанию.

**DoD:** документ заполнен, выбраны модели, известен рабочий способ структурированного вывода и порядок стоимости одного анализа.
**Оценка:** 1.5 д. **Зависимости:** E0-03 (env), ключ Gemini.

### E2-02. Реестр промптов и синк `prompt_version`

**Цель:** каждый AI-артефакт ссылается на воспроизводимую версию промпта.

**Сделать:**
- Формат файла промпта (фронтматтер: `name`, `version`, `description`, `schemaVersion`, `model_hint`), загрузчик `loadPrompt(name, version)` с подстановкой переменных `{{var}}`, юнит-тесты.
- Промпты `dna.full/1.0.0` (полный разбор по §5.2 с явным требованием: описывать паттерны абстрактно, отдельно выделять `riskyToCopyElements`), `dna.hook_pass/1.0.0`.
- Синк при старте worker: файлы → `prompt_version` (insert новых, `checksum` для обнаружения правки без смены версии → ошибка старта).
- `app_setting.intel.default_prompt.*` указывает активную версию; смена версии = новый файл.

**DoD:** промпты видны в БД после старта; изменение текста без смены версии ломает старт с понятной ошибкой; тесты зелёные.
**Оценка:** 0.5 д. **Зависимости:** E0-04.

### E2-03. `VideoAnalysisClient`: полный проход по URL

**Цель:** рабочий клиент, который из URL делает валидную `ContentDna` с учтённой стоимостью.

**Сделать:**
- Сборка запроса: `fileData { fileUri }` + промпт + `responseSchema` (из E2-01) + `generationConfig`; таймаут (`intel.timeout_ms`, по умолчанию 300 с).
- Постобработка: парсинг → `ContentDnaSchema.safeParse` → repair-ретрай (решение 2) → результат `{ dna, model, promptVersion, tokensIn, tokensOut, costUsd, durationMs, rawText }`.
- Расчёт стоимости из `usageMetadata` по `gemini.prices` (решение 6); запись `UsageLogger` (`provider: gemini`, `operation: video_analysis`).
- Ошибки: `VideoUnavailableError` (не ретраить), `SafetyBlockedError` (не ретраить, статус `failed`), `GeminiRateLimitError` (ретрай с backoff), `InvalidOutputError` (после repair → `invalid`).
- Тесты с подменённым SDK: валидный ответ, невалидный → repair → валидный, дважды невалидный, ошибки; фикстуры из спайка.

**DoD:** `pnpm --filter @sf/gemini smoke -- <url>` печатает валидную DNA и стоимость; тесты зелёные.
**Оценка:** 1.5 д. **Зависимости:** E2-01, E2-02, E0-09.

### E2-04. Hook pass и режим локального файла

**Цель:** второй, более детальный проход по первым 5 секундам и анализ собственных видео.

**Сделать:**
- `HookAnalysisSchema` в `@sf/core`: `frames[] { atSec, visual, onScreenText, audio, attentionDevice }`, `spokenHookExact`, `hookStrategy`, `firstCutSec`, `visualHookScore`, `whyItHolds[]`, `weaknesses[]`; тесты.
- `pass: hook_pass`: `videoMetadata { startOffset: "0s", endOffset: "5s", fps: intel.hook_pass.fps }`, промпт `dna.hook_pass`, отдельная модель.
- `source: local_file`: загрузка в Files API, polling до `ACTIVE`, анализ с `mediaResolution: high`, удаление файла в `finally`; лимиты размера файла проверяются до загрузки.
- Тесты с подменённым SDK; ручная проверка на одном своём видео.

**DoD:** hook pass на реальном Short даёт валидный `HookAnalysis`; локальный файл анализируется и удаляется из Files API; стоимость обоих режимов в логе.
**Оценка:** 1 д. **Зависимости:** E2-03.

### E2-05. БД: миграция `0002_intel`, репозиторий анализов

**Цель:** хранение всех версий анализов с диагностикой.

**Сделать:**
- Миграция по таблице выше; `videoAnalysisRepo`: `insert`, `latestByVideo(videoId, kind)`, `listByVideo`, `countAutoToday`, `costToday`.
- Сохранение сырого ответа при `invalid`/`failed` в `MEDIA_DIR/intel/raw/<analysisId>.txt` (`raw_response_path`).
- Zod-валидация `result` при чтении по `kind` (`ContentDnaSchema` | `HookAnalysisSchema`), при несовпадении `schema_version` — явная ошибка чтения, а не тихий мусор.

**DoD:** миграция применяется; интеграционный тест на insert/чтение/валидацию по kind.
**Оценка:** 0.5 д. **Зависимости:** E2-04 (схема Hook).

### E2-06. Джобы `intel.analyze-video` и `intel.hook-pass`, автозапуск

**Цель:** анализ запускается вручную и автоматически, идемпотентно и в рамках бюджета.

**Сделать:**
- `intel.analyze-video`: payload `{ videoId | ownVideoId, source, trigger, promptVersion?, model?, requestedAt? }`; `jobId` по решению 7; `BudgetGuard.assert("gemini")` + предоценка стоимости по длительности; вызов клиента; insert строки (в т.ч. `invalid`/`failed`); обновление `trend_signal`/`tracked_video` не требуется — UI читает `video_analysis`.
- `intel.hook-pass`: аналогично, `kind = hook_pass`; авто-постановка после успешного полного прохода при `score >= intel.hook_pass.min_score`.
- Автозапуск из `radar.score` (решение 8) — вынести в функцию `maybeEnqueueAnalysis(signal)` с проверкой `countAutoToday < daily_max`.
- Ретраи: только на rate-limit/сетевые (3 попытки); `invalid` после repair — не ретрай, а фиксация.
- Прогресс для UI: состояние job'а (`waiting | active | completed | failed`) читается из BullMQ по `jobId`; эндпоинт в E2-07.
- Интеграционные тесты с фейковым клиентом: успешный, invalid, budget exceeded (job не вызывает клиент), дедупликация авто-запуска.

**DoD:** ручной запуск с UI (кнопка из E1-10) даёт строку `video_analysis` за минуты; два ручных запуска — две версии; авто-запуски ограничены дневным лимитом; невалидный ответ не роняет worker.
**Оценка:** 1.5 д. **Зависимости:** E2-05, E0-08, E1-06 (сигналы, для авто).

### E2-07. API и контракты Intelligence

**Цель:** UI получает всё для карточки DNA и управления анализом.

**Сделать:**
- `POST /intel/analyses { videoId | ownVideoId, kind, promptVersion?, model? }` → `{ jobId, analysisId? }` (заменяет `POST /radar/videos/:id/analyze` из E1-09 или проксирует его).
- `GET /intel/analyses?videoId=&kind=` (все версии с метаданными без тяжёлого `result`), `GET /intel/analyses/:id` (полный результат), `GET /intel/jobs/:jobId` (состояние).
- `GET /intel/summary` — сегодня: количество, $ потрачено, доля invalid, средняя стоимость (для `/system`).
- `GET /intel/prompts` — версии промптов и активные.
- Контракты в `@sf/contracts/intel/*`, клиент, тесты роутов.

**DoD:** OpenAPI показывает роуты; клиент типизирован; тесты зелёные.
**Оценка:** 0.5–1 д. **Зависимости:** E2-06.

### E2-08. UI: карточка Content DNA

**Цель:** оператор читает разбор видео быстрее, чем смотрит само видео.

**Сделать:**
- Блок DNA на странице видео (`/radar/videos/[id]`, заглушка из E1-10) и отдельная страница `/intel/analyses/[id]`.
- Вкладки: **Обзор** (topic/subtopic, storySummary, hookType, structure, emotionalDriver, reveal @ sec/%, ending/CTA); **Транскрипт** (semantic transcript); **Таймлайн** (таблица `startSec–endSec | visual | narration | overlay`, клик — открыть YouTube на этой секунде); **Hook 0–5s** (first1s…first5s + `HookAnalysis` покадрово, если есть); **Паттерны** (whyItMayWork, transferablePatterns — зелёные, riskyToCopyElements — красные с явной подписью «не копировать»).
- Шапка: бейджи `model`, `prompt_version`, `cost`, `duration`, статус; переключатель версий; кнопки «Переанализировать», «Hook pass».
- Состояние ожидания: polling `GET /intel/jobs/:jobId` каждые 5 с, прогресс-индикатор, отображение `invalid`/`failed` с ссылкой на сырой ответ.
- Список `/intel` — последние анализы с фильтрами (kind, status, канал) и суммой $ за день.

**DoD:** сценарий «сигнал → Анализировать → через 1–3 минуты карточка → переключение версий → hook pass» проходит вручную; risky-элементы визуально отделены.
**Оценка:** 2 д. **Зависимости:** E2-07, E1-10.

### E2-09. Бюджет Gemini на `/system`

**Цель:** расход на анализ виден ежедневно, лимит останавливает автозапуск до перерасхода.

**Сделать:**
- `/system`: карточка Gemini — $ сегодня / лимит, количество анализов (manual/auto), доля invalid, средняя стоимость, прогноз до конца дня.
- При `>= 80 %` лимита — отключение автозапуска (ручной остаётся до 100 %), алерт в `app_setting.alerts.gemini_budget`; при 100 % — `BudgetGuard` блокирует и ручной.
- Тесты порогов.

**DoD:** искусственно низкий лимит отключает авто, затем ручной; алерт виден.
**Оценка:** 0.5 д. **Зависимости:** E2-06, E0-09.

### E2-10. Оценочный набор и проверка качества

**Цель:** уверенность, что DNA достаточно точна, чтобы на неё опираться в Inbox и Script Engine.

**Сделать:**
- 10 реальных Shorts из сигналов Radar (разные каналы/типы хуков); прогон полного прохода и hook pass.
- Рубрика ручной оценки (1–5): транскрипт, таймлайн, hook-разбор, reveal-тайминг, полезность паттернов, корректность risky. Результаты — в раздел «Оценка качества» ниже.
- По результатам — правки промпта (`dna.full/1.1.0`) и/или смена модели; повторный прогон на том же наборе для сравнения версий.
- ADR по решениям 1–8; обновление `10_SYSTEM_DESIGN.md` §7.3.

**DoD:** средняя оценка по рубрике ≥ 4 по транскрипту и reveal-таймингу; набор и оценки сохранены для регрессии будущих версий промпта.
**Оценка:** 1 д. **Зависимости:** E2-08.

---

## Порядок

```text
E2-01 ─► E2-02 ─► E2-03 ─► E2-04 ─► E2-05 ─► E2-06 ─► E2-07 ─► E2-08 ─► E2-10
                                                 └────► E2-09
```

E2-01…E2-05 не зависят от E1 и могут идти параллельно с E1-04…E1-08.

## Вне скоупа E2

- Скачивание видео как fallback при отказе Gemini от YouTube-URL — только как задокументированный запасной путь (System Design §9), не реализуем.
- Сравнение DNA между видео / агрегаты по каналам — E3 (Inbox) и E8 (Experiment Engine).
- Анализ комментариев — нет.

## Результаты спайка (E2-01)

_Заполняется по итогам E2-01: модели, ограничения schema, стоимость/латентность, лимиты URL._

## Оценка качества (E2-10)

_Таблица: видео × критерий × версия промпта._

## Приёмка

| AC | Как проверяем | Статус |
|---|---|---|
| Кнопка → валидная DNA за минуты | 5 запусков с UI, время до карточки < 5 мин | ⬜ |
| Невалидный JSON не роняет пайплайн | подменить промпт на ломающий → строка `invalid`, worker жив, DLQ содержит job | ⬜ |
| Стоимость каждого анализа видна | карточка и `/system` совпадают с `api_usage_log` | ⬜ |
| Повторный запуск создаёт новую версию | две строки, переключатель версий в UI | ⬜ |
