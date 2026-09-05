# E3. Idea Inbox — декомпозиция на задачи

_Дата: 2026-09-05. Источник: `20_TZ_HIGH_LEVEL.md` (E3), `10_SYSTEM_DESIGN.md` §4 (`inbox.build`), §5 (Idea flow), `01_ARCHITECTURE.md` §5.3. Статус: ✅ декомпозирован. Зависит от E1 (сигналы, кластеры) и E2 (DNA)._

## Цель эпика

Ежедневная ранжированная очередь идей с решением Approve / Reject / Later за минимальное время оператора.

**AC эпика:** утром в Inbox лежат свежие ранжированные карточки; решение по карточке — 1 клик; статусы и история решений сохраняются; повторных дублей решённых сюжетов нет.

## Что уже есть

- `@sf/core`: `IdeaStatusSchema`, `IdeaScoresSchema { velocity, acceleration, clusterScore, opportunity }`, `canTransition`.
- `@sf/db`: `idea (status, scores, card jsonb, source_cluster_id, decided_at)`, `idea_source_video`.
- Из E1/E2: `trend_signal`, `story_cluster` с моментумом, `video_analysis` (DNA), `LlmClient`, реестр промптов, очередь `inbox.build`.

## Архитектурные решения E3

1. **Единица идеи — сюжет.** Кандидат = активный `story_cluster`; одиночное видео без кластера становится кандидатом, только если его сигнал выше `inbox.solo.min_score`. Идея ссылается на `source_cluster_id` и на все исходные видео через `idea_source_video` (`role: primary | supporting`).
2. **Карточка = числа из кода + текст от LLM.** Метрики (velocity, acceleration, clusterScore, freshness) считаются детерминированно; LLM (промпт `inbox.card`) по кластеру, DNA исходных видео и метрикам пишет: `title`, `summary`, `whyNow`, `proposedHooks[3]` (оригинальные, не перефраз конкурентских), `targetDurationSec`, `category/subcategory`, `visualTreatment`, `researchStarters[]` (поисковые запросы и типы первоисточников — не ссылки, ссылки ищет E4), `confidence`. `IdeaCardSchema` в `@sf/core` — единственный формат `idea.card`.
3. **Ранжирование — чистая функция, веса в настройках.** `opportunityScore = Σ wᵢ·normalized(featureᵢ)` по velocity, acceleration, clusterScore (каналы × моментум), dnaCoverage (есть ли DNA у исходников), freshness (штраф за возраст сюжета), llmConfidence; веса — `app_setting.inbox.weights`. Все компоненты сохраняются в `idea.scores`, чтобы Experiment Engine мог потом связать «что мы думали» с «что получилось».
4. **Дедупликация по fingerprint и правило «нового всплеска».** `idea.fingerprint` = `cluster:<id>` или `video:<id>`. Новая карточка на тот же fingerprint не создаётся, если есть идея с решением за последние `inbox.dedupe_days` (30), **кроме** случая, когда текущий моментум кластера ≥ `inbox.resurface_factor` (2×) от моментума, зафиксированного в `scores` на момент решения. Тогда создаётся новая карточка с `resurfaced_from_id` и пометкой «повторный всплеск».
5. **Later — отложено на дату, с автоистечением.** `later_until` (по умолчанию +3 дня, оператор может выбрать); job возвращает идею в `new` с пересчитанными метриками; если сигнал за это время угас (`score < inbox.min_score`) — статус `expired`, в ленту не попадает. `expired` добавляется в `IdeaStatus` и таблицу переходов.
6. **История решений — отдельная append-only таблица.** `idea_decision (idea_id, from_status, to_status, reason, actor, scores_snapshot, created_at)`. `idea.status` — текущее состояние, история — здесь.
7. **Сборка — утром по TZ оператора, с потолком.** Cron `inbox.build` в `app_setting.inbox.build_time` (06:00, TZ `app_setting.timezone`), максимум `inbox.max_cards_per_day` (15) новых карточек; `jobId = inbox.build:<date>`, ручной «Пересобрать» — с суффиксом времени. Каждая карточка — отдельная попытка: ошибка LLM на одной не отменяет остальные.
8. **Approve запускает исследование.** Переход `approved` ставит `research.run` (E4). До реализации E4 job лежит в `waiting` — это ожидаемо. Ручное создание идеи оператором (`source: manual`, минимальная карточка без LLM) — поддерживается: свои идеи и идеи Phase 0 должны проходить тот же конвейер.

## Изменения схемы БД (миграция `0003_inbox`)

| Таблица | Изменение |
|---|---|
| `idea` | `+ fingerprint text` (index), `+ source enum(radar, manual)`, `+ later_until timestamptz`, `+ resurfaced_from_id FK`, `+ category text`, `+ subcategory text`, `+ card_prompt_version text`, `+ card_model text`, `+ card_cost_usd numeric`, `+ updated_at`; `status` enum `+ expired` |
| `idea_decision` | новая: `id, idea_id FK, from_status, to_status, reason text, actor text, scores_snapshot jsonb, created_at` |
| `idea_source_video` | `+ role enum(primary, supporting)` вместо text, unique `(idea_id, video_id)` |
| `app_setting` | `inbox.build_time`, `timezone`, `inbox.max_cards_per_day`, `inbox.weights`, `inbox.min_score`, `inbox.solo.min_score`, `inbox.dedupe_days`, `inbox.resurface_factor`, `inbox.later_default_days` |

---

## Задачи

Суммарно ≈ 9–10 дней.

### E3-01. `@sf/core`: схема карточки, ранжирование, дедупликация, статусы

**Сделать:**
- `IdeaCardSchema` (решение 2) с `.describe()` для генерации `responseSchema`; расширенная `IdeaScoresSchema` (все компоненты + `opportunity` + `computedAt` + `clusterMomentumAtDecision`).
- `rankIdeas(candidates, weights)` с нормализацией (min-max внутри дневной выборки, лог-сжатие velocity); детерминированный порядок при равенстве.
- `shouldSkipDuplicate(existingDecidedIdea, currentMomentum, settings)` и `isResurface(...)` (решение 4).
- `IdeaStatus + expired`, переходы: `later → expired`, `new → expired`; `canTransition` обновлён.
- Юнит-тесты на всё, включая веса с нулями и отсутствие DNA.

**DoD:** тесты зелёные; схема карточки согласована с промптом E3-03.
**Оценка:** 1 д. **Зависимости:** E0-05.

### E3-02. БД: миграция `0003_inbox`, репозитории

**Сделать:**
- Миграция по таблице выше. `ideaRepo`: `create`, `listByStatus` (сортировка по `scores.opportunity`, фильтры category/source/дата), `findDecidedByFingerprint(fp, sinceDays)`, `transition(id, to, reason, actor)` — в одной транзакции обновляет `idea` и пишет `idea_decision`; `dueLater(now)`.
- `idea.card`/`idea.scores` валидируются Zod на записи и чтении.
- Интеграционные тесты: transition с недопустимым переходом → ошибка и нет записи в истории.

**DoD:** миграция применяется; тесты зелёные.
**Оценка:** 0.5–1 д. **Зависимости:** E3-01, E0-04.

### E3-03. Отбор кандидатов и генерация карточки через LLM

**Сделать:**
- `selectCandidates(date)`: активные кластеры (`status = active`, моментум обновлён за 24 ч) + одиночные видео выше `inbox.solo.min_score`; исключение по fingerprint (решение 4); ограничение `max_cards_per_day` по предварительному числовому скору (без LLM) — LLM зовём только для финалистов, экономим бюджет.
- Сбор контекста: кластер (label, summary, channel_count, momentum), 3–5 исходных видео (title, channel, метрики сигнала), DNA исходников, если есть (topic, storySummary, hookType, transferablePatterns, riskyToCopyElements — последние передаём как «чего избегать»).
- Промпт `inbox.card/1.0.0`: правила оригинальности хуков, запрет на копирование формулировок, требование `whyNow` опираться на факты кластера (несколько каналов, скорость), `researchStarters` как запросы.
- `generateCard(context)` через `LlmClient` с `responseSchema` из `IdeaCardSchema`, repair-ретрай, стоимость в `api_usage_log` (`operation: inbox_card`).
- Тесты: сборка контекста на сид-данных; фейковый LLM.

**DoD:** для реального кластера генерируется валидная карточка; стоимость записана.
**Оценка:** 1.5 д. **Зависимости:** E3-01, E1-07, E2-05.

### E3-04. Job `inbox.build`

**Сделать:**
- Cron по решению 7; `BudgetGuard.assert("gemini")`; кандидаты → карточки (каждая в `try/catch`, ошибки в лог и счётчик) → `rankIdeas` → insert идей со `status = new`, `idea_source_video`, `fingerprint`.
- Пересчёт `scores` для уже лежащих в `new` идей (сюжет мог разогнаться или угаснуть) без повторного вызова LLM; угасшие ниже `inbox.min_score` → `expired`.
- Итоговый лог: кандидатов / создано / пропущено дублей / resurfaced / ошибок / $.
- Ручной запуск `POST /inbox/rebuild`.
- Интеграционный тест: кандидаты с дублем и с resurface → корректный набор карточек; повторный запуск того же дня идемпотентен.

**DoD:** утренний запуск создаёт карточки в пределах потолка; дублей решённых сюжетов нет; ошибки одной карточки не мешают остальным.
**Оценка:** 1 д. **Зависимости:** E3-03, E3-02.

### E3-05. Job `inbox.later-return` и истечение

**Сделать:**
- Repeatable-job каждый час: идеи с `later_until <= now` → пересчёт метрик → `new` (с записью в `idea_decision`, actor `system`) или `expired`, если сигнал угас.
- Тесты на обе ветки.

**DoD:** отложенная идея возвращается в ленту вовремя или помечается истёкшей.
**Оценка:** 0.5 д. **Зависимости:** E3-04.

### E3-06. API и контракты Inbox

**Сделать:**
- `GET /inbox` (status по умолчанию `new`, фильтры category/source/date, сортировка по opportunity, курсорная пагинация), `GET /ideas/:id` (карточка, источники со ссылками на DNA, история решений, кластер), `POST /ideas/:id/decision { to: approved | rejected | later, reason?, laterUntil? }`, `POST /inbox/rebuild`, `POST /ideas { title, summary, category?, sourceVideoIds? }` — ручная идея, `GET /ideas` — все статусы для страницы Ideas (E3-08).
- `approved` → постановка `research.run` (решение 8) внутри той же транзакции/после коммита.
- Контракты `@sf/contracts/inbox/*`, клиент, тесты роутов (в т.ч. недопустимый переход → 409).

**DoD:** OpenAPI показывает роуты; тесты зелёные.
**Оценка:** 1 д. **Зависимости:** E3-05.

### E3-07. UI Inbox

**Сделать:**
- `/inbox`: лента карточек (заголовок, summary, whyNow, 3 хука, категория, целевая длительность, opportunity с разбивкой по компонентам в тултипе, бейдж кластера «N каналов», бейдж «повторный всплеск»), кнопки **Approve / Reject / Later**, горячие клавиши `A / R / L`, `J / K` для навигации.
- Reject — необязательная причина (быстрые пресеты: «не наша тема», «риск/юр», «уже было», «слабый сюжет» + свободный текст); Later — выбор даты (пресеты +1/+3/+7 дней).
- Фильтры: категория, источник (radar/manual), дата сборки; счётчик «сегодня: N новых».
- Карточка идеи `/ideas/[id]`: полный контекст — исходные видео с метриками и ссылками на DNA-карточки (E2-08), кластер и соседи, researchStarters, история решений.
- Форма ручной идеи.
- Пустое состояние: «Inbox собирается ежедневно в 06:00; собрать сейчас».

**DoD:** решение по карточке — один клик или одна клавиша; после решения карточка уходит из ленты без перезагрузки; сценарий «утро → 10 решений за 3 минуты» проходит вручную.
**Оценка:** 2 д. **Зависимости:** E3-06, E0-10.

### E3-08. Страница Ideas (конвейер) и переходы статусов

**Сделать:**
- `/ideas`: таблица всех идей с текущим статусом, фильтр по статусам (approved / in_research / researched / scripted / in_production / …), сортировка по дате решения; из строки — переход к брифу/скрипту/пакету, когда появятся (E4–E6; до этого — ссылки-заглушки).
- Индикация ожидания: для `approved` показывать состояние job'а `research.run` (`waiting` — «ждёт Research Agent»).
- Бейдж в навигации: число `new` в Inbox.

**DoD:** все идеи и их статусы видны в одном месте; approve из Inbox виден здесь сразу.
**Оценка:** 0.5–1 д. **Зависимости:** E3-07.

### E3-09. Обкатка: 5 утренних сборок, тюнинг весов

**Сделать:**
- 5 рабочих дней: фиксировать количество карточек, доля approve/reject/later, время на разбор, качество хуков и whyNow (ручная оценка 1–5), дубли.
- Тюнинг `inbox.weights`, `min_score`, `max_cards_per_day`, правок промпта (`inbox.card/1.1.0`).
- ADR по решениям 1–8, обновление `10_SYSTEM_DESIGN.md` §4/§5.

**DoD:** доля approve в диапазоне 20–40 % (если ниже — карточки шумные, выше — потолок мал); дублей нет; документы обновлены.
**Оценка:** 1 д. **Зависимости:** E3-08.

---

## Порядок

```text
E3-01 ─► E3-02 ─► E3-03 ─► E3-04 ─► E3-05 ─► E3-06 ─► E3-07 ─► E3-08 ─► E3-09
```

## Вне скоупа E3

- Уведомления о новых карточках (Telegram/email) — позже, при необходимости.
- Автоapprove по порогу — нет: человек в контуре обязателен (System Design §1.6).
- Персонализация ранжирования по истории решений оператора — E8 может предложить веса, но не здесь.

## Приёмка

| AC | Как проверяем | Статус |
|---|---|---|
| Утром свежие ранжированные карточки | 5 дней подряд сборка отработала до 06:15, карточки отсортированы по opportunity | ⬜ |
| Решение — 1 клик | клик/клавиша → статус и `idea_decision` записаны, карточка исчезла | ⬜ |
| История сохраняется | `/ideas/[id]` показывает все переходы с причинами | ⬜ |
| Нет дублей решённых сюжетов | за 5 дней ни одной карточки с fingerprint, решённым ранее, кроме помеченных «повторный всплеск» | ⬜ |
