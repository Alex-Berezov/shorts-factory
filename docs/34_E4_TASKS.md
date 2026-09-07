# E4. Research Agent — декомпозиция на задачи

_Дата: 2026-09-05. Источник: `20_TZ_HIGH_LEVEL.md` (E4), `10_SYSTEM_DESIGN.md` §4 (`research.run`), §5 (`research_brief`), `01_ARCHITECTURE.md` §3, §5.4. Статус: ✅ декомпозирован. Зависит от E3._

## Цель эпика

Независимая фактическая проверка одобренной идеи → factual brief.

**AC эпика:** после approve в разумное время появляется бриф с разделением подтверждённого/неподтверждённого и ссылками на источники; рискованные темы помечены флагами; оператор может исключить любой claim.

## Что уже есть

- `@sf/db`: `research_brief (idea_id, verified_claims, uncertain_claims, sources, risk_flags, allowed_claims, status)`.
- Из E1–E3: `LlmClient`, реестр промптов, карточка идеи с `researchStarters`, DNA исходных видео (semanticTranscript как источник **утверждений для проверки**, не для копирования), очередь `research.run`, постановка job при approve.

## Архитектурные решения E4

1. **Провайдер поиска — Gemini с Google Search grounding.** `LlmClient` получает опцию `tools: googleSearch` (+ `urlContext` для чтения конкретных страниц); источники берутся из `groundingMetadata`. Один биллинг, один клиент. Anthropic API с web search — запасной провайдер через тот же интерфейс, не реализуем до необходимости. Стоимость grounded-запросов (тарифицируется отдельно от токенов) — в `gemini.prices`.
2. **Три шага вместо одного «сделай ресёрч».** (a) `plan`: из карточки идеи и DNA исходников извлечь список проверяемых утверждений (имена, даты, числа, последовательность событий) и поисковые запросы; (b) `verify`: для каждой группы утверждений — grounded-запрос, вердикт по каждому claim с источниками; (c) `brief`: сборка брифа, поиск противоречий между источниками, risk flags, список допущенных claims. Каждый шаг — отдельный промпт с версией, промежуточные результаты сохраняются в `trace` брифа.
3. **Верификация — правило по уровням источников, а не мнение модели.** Источник получает `tier`: `primary` (первоисточник: официальный сайт, документ, научная публикация, оригинальный репортаж с места), `secondary` (крупные СМИ, отраслевые издания), `tertiary` (агрегаторы, соцсети, форумы, конкурентские видео). Claim `verified`, если подтверждён ≥ 1 primary или ≥ 2 независимыми secondary; `uncertain` — иначе; `contradicted` — если источники расходятся. Правило — чистая функция в `@sf/core`, LLM даёт tier и подтверждение/опровержение по источнику, вердикт считает код.
4. **Бриф версионируется, правки оператора — новая версия.** `research_brief` append-only: `version`, `author (agent | operator)`, `parent_id`. Любое действие оператора (исключить claim, добавить источник, отредактировать формулировку) создаёт новую версию. Script Engine берёт последнюю версию; если она не `operator_reviewed`, UI E5 предупреждает.
5. **Допущенные claims по умолчанию = только `verified`.** `uncertain` можно допустить вручную с обязательной пометкой «сформулировать как предположение» (флаг `hedged: true`, который E5 обязан учесть). `contradicted` допустить нельзя.
6. **Risk flags — закрытый список с уровнем.** `legal` (клевета, частные лица), `copyright` (сюжет полностью завязан на чужом контенте), `safety` (опасные действия, медицина, самоповреждение), `sensitive` (трагедии, несовершеннолетние, политика/религия), `misinformation_risk` (сюжет уже опровергался). Уровень `low | medium | high`; `high` не блокирует, но требует явного подтверждения оператора при approve брифа.
7. **Бюджет на бриф ограничен.** `research.max_grounded_calls` (8) и `research.max_cost_usd` (0.5) на один запуск; при превышении — бриф завершается с тем, что есть, и флагом `budget_truncated`. Автозапуск для top-N по `inbox` (`research.auto.enabled`, по умолчанию выключен — сначала только по approve).

## Изменения схемы БД (миграция `0004_research`)

| Таблица | Изменение |
|---|---|
| `research_brief` | `+ version int`, `+ parent_id FK`, `+ author enum(agent, operator)`, `+ claims jsonb` (единый список `Claim { id, text, status, hedged, sources[], notes }` вместо трёх отдельных колонок — `verified_claims/uncertain_claims` остаются как денормализованные представления или удаляются, решить в E4-04), `+ contradictions jsonb`, `+ trace jsonb`, `+ prompt_versions jsonb`, `+ model`, `+ cost_usd`, `+ budget_truncated bool`, `+ reviewed_at`, `+ reviewed_by`; `status enum(draft, operator_reviewed)`; unique `(idea_id, version)` |
| `app_setting` | `research.max_grounded_calls`, `research.max_cost_usd`, `research.auto.enabled`, `research.auto.top_n`, `research.default_prompts` |

---

## Задачи

Суммарно ≈ 9 дней.

### E4-01. `@sf/core`: схемы брифа и правило верификации

**Сделать:**
- `ClaimSchema { id, text, kind: name | date | number | sequence | fact, status: verified | uncertain | contradicted, hedged, sourceIds[], evidence[] { sourceId, stance: supports | refutes | mentions, quote? } }`, `SourceSchema { id, url, title, publisher, tier, publishedAt?, accessedAt, note }`, `ContradictionSchema`, `RiskFlagSchema` (решение 6), `ResearchBriefSchema { claims, sources, contradictions, riskFlags, allowedClaimIds, summary, budgetTruncated, trace }`.
- `resolveClaimStatus(claim, sources)` по решению 3; `defaultAllowedClaims(claims)`; `isIndependent(sourceA, sourceB)` (разные publisher/домены).
- Юнит-тесты: 1 primary; 2 secondary одного издателя (не independent → uncertain); противоречие.

**DoD:** тесты зелёные; схемы снабжены `.describe()` для `responseSchema`.
**Оценка:** 1 д. **Зависимости:** E0-05.

### E4-02. `LlmClient`: grounding, urlContext, нормализация источников

**Сделать:**
- Опции `tools: { googleSearch?: true, urlContext?: string[] }`; парсинг `groundingMetadata` (chunks → `Source` с url/title, `groundingSupports` → привязка к фрагментам ответа); резолв редиректных URL grounding в конечные (для `publisher`).
- Учёт стоимости grounded-запроса (фикс за запрос + токены) → `api_usage_log` (`operation: research_grounded`).
- Тесты с записанными ответами SDK.

**DoD:** тестовый grounded-запрос возвращает ответ и ≥ 1 источник с URL; стоимость в логе.
**Оценка:** 1 д. **Зависимости:** E1-07.

### E4-03. Промпты `research.plan`, `research.verify`, `research.brief`

**Сделать:**
- `research.plan/1.0.0`: вход — карточка идеи, `storySummary` и ключевые утверждения из DNA исходников (явно: «это утверждения конкурентов, их нужно проверить, а не повторить»), `researchStarters`; выход — `claims[] (без статуса)`, `queries[]` (группы claims → запросы), `riskHints[]`.
- `research.verify/1.0.0`: grounded; вход — группа claims + запросы; выход — по каждому claim `evidence[]` с источниками и `stance`, `tier` для каждого источника с обоснованием.
- `research.brief/1.0.0`: вход — claims со статусами (уже посчитанными кодом), источники; выход — `summary`, `contradictions[]`, `riskFlags[]` с обоснованием, предложение формулировок для `hedged`.
- Каждый — с `responseSchema` из соответствующих Zod-схем; тесты формата на фейковом LLM.

**DoD:** три промпта в реестре; на одной реальной идее цепочка даёт валидный бриф.
**Оценка:** 1 д. **Зависимости:** E4-01, E4-02, E2-02.

### E4-04. БД: миграция `0004_research`, репозиторий версий

**Сделать:**
- Миграция по таблице выше (решить судьбу `verified_claims/uncertain_claims` — рекомендация: удалить, единый `claims`); `researchBriefRepo`: `insertVersion`, `latest(ideaId)`, `list(ideaId)`, `markReviewed`.
- Валидация `claims/sources/riskFlags` Zod на записи/чтении.

**DoD:** миграция применяется; тесты репозитория зелёные.
**Оценка:** 0.5 д. **Зависимости:** E4-01.

### E4-05. Job `research.run`: оркестрация plan → verify → brief

**Сделать:**
- Payload `{ ideaId, trigger, requestedAt? }`, `jobId = research.run/<ideaId>/<version>`; переход идеи `approved → in_research` в начале, `→ researched` в конце (через `ideaRepo.transition`, actor `system`).
- Шаги по решению 2 с сохранением промежуточных результатов в `trace` после каждого шага (при падении на verify — plan не теряется); группировка claims в ≤ `max_grounded_calls` запросов; контроль `max_cost_usd` (решение 7).
- После verify — `resolveClaimStatus` по каждому claim; brief; `allowedClaimIds = defaultAllowedClaims`.
- Ошибки: провайдер недоступен → ретрай; бюджет → `budget_truncated`; невалидный вывод после repair → job в DLQ, идея остаётся `in_research` с видимой ошибкой в UI.
- Повторный запуск (`POST /research/:ideaId/rerun`) — новая версия с `author = agent`.
- Автозапуск для top-N из `inbox.build` при `research.auto.enabled`.
- Интеграционный тест с фейковым LLM: полная цепочка, обрыв на verify с восстановлением trace.

**DoD:** approve реальной идеи → бриф через ≤ 10 минут; стоимость и число grounded-вызовов в логе; идея в `researched`.
**Оценка:** 2 д. **Зависимости:** E4-03, E4-04, E3-06.

### E4-06. API и контракты Research

**Сделать:**
- `GET /research/:ideaId` (последняя версия), `GET /research/:ideaId/versions`, `GET /research/briefs/:id`.
- `POST /research/briefs/:id/edit { claims?, sources?, allowedClaimIds?, riskFlagsAck? }` → новая версия `author = operator`; валидация: `contradicted` нельзя в allowed; `uncertain` в allowed → `hedged` обязателен.
- `POST /research/briefs/:id/review` → `operator_reviewed` (при `high` risk — требуется `riskFlagsAck`).
- `POST /research/:ideaId/rerun`.
- Контракты `@sf/contracts/research/*`, клиент, тесты роутов.

**DoD:** OpenAPI; тесты зелёные; правила допуска claims проверяются на сервере.
**Оценка:** 1 д. **Зависимости:** E4-05.

### E4-07. UI: страница брифа

**Сделать:**
- `/ideas/[id]/research`: шапка (статус, версия, автор, стоимость, `budget_truncated`), summary.
- Таблица claims: текст, тип, вердикт (бейдж), источники (иконка tier, домен, ссылка), тумблер «в скрипт», для `uncertain` — обязательный чекбокс «как предположение»; инлайн-редактирование текста claim.
- Блок источников с tier и возможностью добавить свой (URL + tier + заметка).
- Противоречия — парами с цитатами; risk flags — карточки с уровнем, для `high` — чекбокс подтверждения.
- Кнопки: «Сохранить как версию», «Отметить проверенным», «Перезапустить агент», переключатель версий с diff по claims (добавлено/убрано из allowed).
- Состояние `in_research`: прогресс по шагам (plan → verify → brief) из `trace`.

**DoD:** оператор исключает claim, добавляет источник, отмечает бриф проверенным — всё сохраняется версиями; сценарий проходит вручную.
**Оценка:** 2 д. **Зависимости:** E4-06, E3-07.

### E4-08. Оценка качества на 10 идеях

**Сделать:**
- 10 одобренных идей → брифы; ручная проверка: доля claims с корректным вердиктом, доля источников с верным tier, пропущенные риски, «галлюцинированные» источники (URL не открывается / не содержит утверждения).
- По итогам — правки промптов (`1.1.0`), правила tier, лимиты бюджета.
- ADR по решениям 1–7; обновление `10_SYSTEM_DESIGN.md` §4, §5.

**DoD:** точность вердиктов ≥ 85 % на наборе; 0 несуществующих источников в allowed claims; документы обновлены.
**Оценка:** 1 д. **Зависимости:** E4-07.

---

## Порядок

```text
E4-01 ─┬─► E4-03 ─► E4-05 ─► E4-06 ─► E4-07 ─► E4-08
E4-02 ─┘      E4-04 ─┘
```

## Вне скоупа E4

- Собственный веб-скрейпер/парсер страниц — только grounding + `urlContext`.
- Архивирование копий источников — нет (храним URL и цитату).
- Мультиязычный ресёрч — источники на любом языке допустимы, бриф на английском.

## Приёмка

| AC | Как проверяем | Статус |
|---|---|---|
| Бриф после approve за разумное время | 5 идей, медиана < 10 мин | ⬜ |
| Разделение verified/uncertain + источники | каждая строка claims имеет вердикт и ≥ 1 источник или пометку «не найдено» | ⬜ |
| Рискованные темы помечены | тестовая идея с юр. риском получает `legal` flag | ⬜ |
| Оператор может исключить claim | тумблер → новая версия, E5 видит обновлённый allowed | ⬜ |
