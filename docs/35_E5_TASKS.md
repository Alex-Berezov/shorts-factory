# E5. Script Engine — декомпозиция на задачи

_Дата: 2026-09-05. Источник: `20_TZ_HIGH_LEVEL.md` (E5), `10_SYSTEM_DESIGN.md` §4 (`script.generate`), §5 (`script`), `01_ARCHITECTURE.md` §3, §5.5. Статус: ✅ декомпозирован. Зависит от E4 (бриф) и E2 (DNA)._

## Цель эпика

Мастер-скрипт на английском из factual brief + паттернов Content DNA, без клонирования конкурентов.

**AC эпика:** по researched-идее генерируются валидные варианты; финальный скрипт фиксируется отдельной версией с experiment tags; правки оператора не теряются; в скрипте нет заимствованных дословных пассажей из DNA-транскриптов (выборочная проверка).

## Что уже есть

- `@sf/db`: `script (idea_id, version, language, hooks, body, structure, target_duration_sec, experiment_tags, status)`.
- Из E2–E4: DNA исходников (`transferablePatterns`, `riskyToCopyElements`, `semanticTranscript`), бриф с `allowedClaimIds` и `hedged`, `LlmClient`, реестр промптов, очередь `script.generate`.

## Архитектурные решения E5

1. **Скрипт — структурированный, не «простыня».** `ScriptSchema`: `segments[] { id, role: hook | setup | escalation | reveal | payoff | ending | cta, text, claimIds[], estStartSec, estEndSec }`, `hooks[] { id, text, strategy, rationale }`, `selectedHookId`, `targetDurationSec`, `ctaJustification | null`, `experimentTags`. `body` (плоский текст) — производная от сегментов для чтения/копирования.
2. **Две стадии генерации, мастер — один.** `script.hooks` даёт 3–5 хуков с разной стратегией (question / result_first / bold_claim / story_open / visual_shock …); `script.master` пишет мастер под выбранный хук (по умолчанию — рекомендованный моделью). Мастер под другой хук — по запросу оператора («перегенерировать с хуком #3»), чтобы не платить за 5 мастеров.
3. **Трассируемость фактов обязательна.** Каждый сегмент с фактическим содержанием ссылается на `claimIds` из брифа. Код проверяет: все `claimIds` ∈ `allowedClaimIds`; сегменты с `hedged` claims содержат маркер предположения (модель обязана, код проверяет по списку формулировок); фактический сегмент без `claimIds` → предупреждение `unreferenced_fact`. Промпт получает **только** допущенные claims, остальные ему не показываются.
4. **Анти-плагиат — три слоя.** (a) Промпт: DNA-транскрипты не передаются в генерацию мастера вовсе — только абстрактные `transferablePatterns` и `riskyToCopyElements` как запреты; (b) код: шинглы из 6 слов между скриптом и `semanticTranscript` всех исходных видео, метрика `overlapRatio` и список совпавших фрагментов, порог `script.plagiarism.max_overlap` (0.02) → `checks.plagiarism = flagged`; (c) UI подсвечивает совпадения, финализация при `flagged` требует явного подтверждения. Проверка — чистая функция в `@sf/core`.
5. **Длительность оценивается по словам.** `estimateDurationSec(words, wpm)` с `app_setting.script.wpm_en` (160); целевая длительность из карточки идеи, допуск ±10 %; сегменты получают `estStartSec/estEndSec` — это же черновой таймлайн для E6 и ориентир `revealPct` для тегов.
6. **Experiment tags — общая схема с E8.** `ExperimentTagsSchema` в `@sf/core`: `hookStrategy`, `structure`, `resultFirst`, `contextDelaySec`, `revealPct`, `durationBucket`, `ctaType`, `emotionalDriver`, `topic/category`, `narrativePerson`, `openLoopType`. Автозаполнение из сегментов, ручная правка в UI. E8 читает именно эту схему.
7. **Версии: каждая правка — новая строка.** `author: agent | operator`, `parent_id`, `is_final` — ровно один финал на идею (финализация новой версии снимает флаг с предыдущей, история остаётся). `status` идеи: `researched → scripted` при первом финале.
8. **Ревизия по инструкции.** `script.revise` — новая версия от модели по свободной инструкции оператора («короче на 5 секунд», «мягче хук») с сохранением `claimIds`; проверки прогоняются заново.

## Изменения схемы БД (миграция `0005_script`)

| Таблица | Изменение |
|---|---|
| `script` | `+ segments jsonb`, `+ selected_hook_id text`, `+ author enum(agent, operator)`, `+ parent_id FK`, `+ is_final bool`, `+ checks jsonb` (`{ claims: ok|warn|fail, plagiarism: ok|flagged, duration: ok|over|under, details }`), `+ brief_id FK` (версия брифа, на которой построен), `+ prompt_versions jsonb`, `+ model`, `+ cost_usd`, `+ operator_note text`; `status enum(draft, final, superseded)`; unique `(idea_id, version)`; partial unique `(idea_id) where is_final` |
| `app_setting` | `script.wpm_en`, `script.plagiarism.max_overlap`, `script.plagiarism.shingle_size`, `script.duration_tolerance`, `script.default_prompts`, `script.hooks_count` |

---

## Задачи

Суммарно ≈ 8.5–9 дней.

### E5-01. `@sf/core`: схема скрипта, теги, оценка длительности, анти-плагиат, проверка claims

**Сделать:**
- `ScriptSchema`, `HookVariantSchema`, `ExperimentTagsSchema` (решения 1, 6) с `.describe()`.
- `estimateDurationSec`, `assignSegmentTimings(segments, wpm)`, `revealPct(segments)`.
- `shingleOverlap(scriptText, transcripts[], size)` → `{ ratio, matches[] { scriptSpan, transcriptId, text } }` с нормализацией (lowercase, пунктуация, стоп-слова не удаляем — иначе ложные совпадения).
- `checkClaims(segments, brief)` → `ok | warn | fail` с деталями (решение 3); `deriveExperimentTags(script, idea)`.
- Юнит-тесты, включая заведомо скопированный абзац (ratio высокий) и перефраз (ratio низкий).

**DoD:** тесты зелёные; пороги вынесены параметрами.
**Оценка:** 1.5 д. **Зависимости:** E4-01 (схемы брифа), E0-05.

### E5-02. Промпты `script.hooks`, `script.master`, `script.revise`

**Сделать:**
- `script.hooks/1.0.0`: вход — карточка идеи, summary брифа, допущенные claims, `transferablePatterns` (абстрактно), `riskyToCopyElements` (как «запрещено»); выход — 3–5 хуков с `strategy`, `rationale`, `recommendedId`.
- `script.master/1.0.0`: вход — то же + выбранный хук + целевая длительность + wpm; правила: структура hook → setup → escalation → reveal → payoff → ending; CTA только с `ctaJustification`; каждый фактический сегмент с `claimIds`; hedged-формулировки; запрет на цитирование конкурентов; язык — английский, разговорный.
- `script.revise/1.0.0`: вход — текущие сегменты + инструкция; выход — новые сегменты с сохранёнными `claimIds`.
- `responseSchema` из Zod; тесты формата на фейковом LLM.

**DoD:** три промпта в реестре; на реальной researched-идее цепочка даёт валидный скрипт.
**Оценка:** 1 д. **Зависимости:** E5-01, E2-02.

### E5-03. БД: миграция `0005_script`, репозиторий

**Сделать:**
- Миграция по таблице; `scriptRepo`: `insertVersion`, `latest(ideaId)`, `final(ideaId)`, `list(ideaId)`, `setFinal(id)` (транзакция: снять старый флаг, поставить новый, `superseded`).
- Валидация `segments/hooks/experiment_tags/checks` Zod.

**DoD:** миграция применяется; тест на единственность финала.
**Оценка:** 0.5 д. **Зависимости:** E5-01.

### E5-04. Job `script.generate` (+ regenerate / revise)

**Сделать:**
- Payload `{ ideaId, mode: generate | regenerate_with_hook | revise, hookId?, instruction?, baseScriptId? }`; `jobId` по `ideaId:mode:version`.
- `generate`: последний бриф (предупреждение в `checks`, если не `operator_reviewed`) → `script.hooks` → `script.master` → `assignSegmentTimings` → `checkClaims` → `shingleOverlap` против транскриптов исходников → `deriveExperimentTags` → insert `draft`.
- `regenerate_with_hook`: только `script.master` с указанным хуком, хуки наследуются.
- `revise`: `script.revise` + все проверки.
- `BudgetGuard.assert("gemini")`, стоимость обоих вызовов в `api_usage_log` (`operation: script_*`).
- Интеграционный тест с фейковым LLM: generate → revise → проверки пересчитаны; фейковый «скопированный» текст → `plagiarism: flagged`.

**DoD:** реальная идея → скрипт с хуками, тегами и результатами проверок за ≤ 3 минуты.
**Оценка:** 2 д. **Зависимости:** E5-02, E5-03, E4-06.

### E5-05. API и контракты Script

**Сделать:**
- `GET /scripts?ideaId=` (версии), `GET /scripts/:id`, `POST /scripts/generate { ideaId }`, `POST /scripts/:id/regenerate { hookId }`, `POST /scripts/:id/revise { instruction }`, `POST /scripts/:id/edit { segments, selectedHookId, experimentTags, operatorNote }` → новая версия `operator` с пересчётом проверок, `POST /scripts/:id/finalize { acknowledgePlagiarism? }` → `is_final`, идея `→ scripted`, `POST /scripts/:id/to-production` → постановка `production.package` (E6).
- Правила на сервере: finalize при `checks.claims = fail` → 409; при `plagiarism = flagged` — только с `acknowledgePlagiarism`.
- Контракты `@sf/contracts/scripts/*`, клиент, тесты.

**DoD:** OpenAPI; тесты зелёные.
**Оценка:** 1 д. **Зависимости:** E5-04.

### E5-06. UI: редактор скрипта

**Сделать:**
- `/ideas/[id]/script`: выбор хука (карточки со стратегией и обоснованием, «перегенерировать с этим хуком»), редактор сегментов (роль, текст, привязанные claims — выбор из allowed, расчётные секунды), плоский вид для чтения/копирования.
- Правая панель: длительность (оценка vs цель, индикатор допуска), проверка claims (список предупреждений с переходом к сегменту), анти-плагиат (ratio, совпадения с подсветкой в тексте и ссылкой на транскрипт источника), теги эксперимента (редактируемые).
- Кнопки: «Сохранить версию», «Ревизия по инструкции» (поле ввода), «Финализировать» (модал с подтверждением при flagged), «В production».
- История версий с diff по сегментам; бейдж «бриф не проверен оператором», если так.

**DoD:** сценарий «сгенерировать → выбрать хук → поправить два сегмента → финализировать → в production» проходит; правки не теряются между версиями.
**Оценка:** 2 д. **Зависимости:** E5-05, E4-07.

### E5-07. Проверка качества на 5 идеях

**Сделать:**
- 5 researched-идей → скрипты; ручная оценка: оригинальность (сравнение с транскриптами вручную поверх авточек), соблюдение структуры, естественность английского, соответствие claims брифу, длительность.
- Тюнинг порогов шинглов (ложные срабатывания на устойчивых выражениях), wpm, промптов (`1.1.0`).
- ADR по решениям 1–8; обновление System Design.

**DoD:** 0 дословных заимствований в 5 скриптах при ручной проверке; все фактические сегменты трассируются к claims.
**Оценка:** 1 д. **Зависимости:** E5-06.

---

## Порядок

```text
E5-01 ─► E5-02 ─► E5-04 ─► E5-05 ─► E5-06 ─► E5-07
      └► E5-03 ─┘
```

## Вне скоупа E5

- Локализация скрипта — E9.
- Генерация нескольких мастеров сразу для A/B — E8 планирует эксперимент, E5 исполняет по одному.
- Озвучка черновика для прослушивания — E10 (bake-off) может дать такую возможность позже.

## Приёмка

| AC | Как проверяем | Статус |
|---|---|---|
| Валидные варианты по researched-идее | 5 идей, все прошли Zod и checks без `fail` | ⬜ |
| Финал — отдельная версия с тегами | `is_final` ровно у одной, `experiment_tags` заполнены | ⬜ |
| Правки не теряются | правка → новая версия, предыдущая читается | ⬜ |
| Нет дословных заимствований | ручная проверка 5 скриптов + `plagiarism: ok` | ⬜ |
