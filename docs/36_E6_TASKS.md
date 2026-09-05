# E6. Production Package — декомпозиция на задачи

_Дата: 2026-09-05. Источник: `20_TZ_HIGH_LEVEL.md` (E6), `10_SYSTEM_DESIGN.md` §4 (`production.package`), §5 (`production_package`), `01_ARCHITECTURE.md` §5.6. Статус: ✅ декомпозирован. Зависит от E5._

## Цель эпика

Полный производственный пакет для ручного монтажа в CapCut.

**AC эпика:** для финального скрипта в 1 клик собирается пакет, по которому реально смонтирован хотя бы один Short; оператор отмечает выполнение пунктов.

## Что уже есть

- `@sf/db`: `production_package (script_id, shot_list, narration_timeline, overlays, notes, checklist)`.
- Из E5: финальный скрипт с сегментами и расчётными таймингами, `experimentTags`; DNA исходников с визуальными паттернами; `LlmClient`; очередь `production.package`.

## Архитектурные решения E6

1. **Таймлайн считает код, визуал предлагает модель.** Посекундный narration timeline строится детерминированно из сегментов скрипта и wpm (E5-01). LLM (промпт `production.package`) получает сегменты с таймингами и на каждый предлагает: `shots[]` (что в кадре, тип источника: стоковое видео / фото / скринкаст / текст на фоне / анимация), `overlays[]` (текст, момент появления, стиль — крупный/подпись), `sfx/music notes`, `editingRhythm` (частота смен кадра на этом отрезке). Явные `hookTimestamp` и `revealTimestamp` берутся из сегментов с ролями `hook`/`reveal`.
2. **Визуальные паттерны DNA — как вдохновение уровня приёма, не кадра.** В промпт передаются `openingVisualType`, `visualChangeDensity`, `textOverlayUsage` исходников агрегированно («в успешных видео на эту тему первый кадр — крупный объект без лица, смена кадра каждые 1.5–2 с»), без описаний конкретных кадров конкурентов.
3. **Пакет — версионированный AI-артефакт, чек-лист — мутабельное состояние оператора.** `production_package` append-only (`version`, `author`, `parent_id`); отметки выполнения хранятся отдельно в `checklist_state jsonb` на **последней** версии и переносятся при перегенерации по `itemId`.
4. **Media-чеклист генерируется из shot list.** Каждый shot → пункт «найти/снять X» с типом источника и подсказкой по правам (стоки с лицензией, собственная съёмка, публичные домены; **не** брать кадры конкурентов). Пункты общего характера (озвучка записана, субтитры проверены, обложка) — из шаблона `production.checklist_template` в настройках.
5. **Экспорт — Markdown из кода.** `renderPackageMarkdown(pkg)` — чистая функция в `@sf/core`; кнопка «Копировать» и печать (CSS `@media print`) используют одно представление. Никаких PDF-генераторов.
6. **Гипотеза эксперимента — из тегов скрипта по шаблону.** «Проверяем: {hookStrategy} + reveal на {revealPct}% против базы канала; держим постоянными: длительность {bucket}, тема {category}». Когда появится E8 — гипотезу подставляет активный эксперимент, если идея к нему привязана.
7. **Статусы идеи и мост к аналитике.** `scripted → in_production` при создании пакета; кнопка «Смонтировано» → `ready_to_publish`; кнопка «Опубликовано» с URL → `published` и создание `own_video (idea_id, yt_video_id, published_at)` — этот мост нужен уже сейчас, до E7/E11, чтобы связка идея → видео не терялась в ручной фазе.

## Изменения схемы БД (миграция `0006_production`)

| Таблица | Изменение |
|---|---|
| `production_package` | `+ version int`, `+ author enum(agent, operator)`, `+ parent_id FK`, `+ hook_timestamp_sec`, `+ reveal_timestamp_sec`, `+ editing_rhythm jsonb`, `+ sfx_notes jsonb`, `+ media_checklist jsonb`, `+ experiment_hypothesis text`, `+ checklist_state jsonb`, `+ prompt_version`, `+ model`, `+ cost_usd`, `+ created_at`; unique `(script_id, version)` |
| `own_video` | `+ source enum(app, manual_import, sync)`; `idea_id` уже nullable |
| `app_setting` | `production.checklist_template`, `production.default_prompt`, `production.shot_types` |

---

## Задачи

Суммарно ≈ 6 дней.

### E6-01. `@sf/core`: схема пакета, построитель таймлайна, Markdown-рендер

**Сделать:**
- `ProductionPackageSchema { timeline[] { segmentId, startSec, endSec, narration, shots[], overlays[], sfx?, rhythm }, shotList[] { id, segmentId, description, sourceType, rightsHint, durationSec }, mediaChecklist[] { id, shotId?, text, kind, done? }, hookTimestampSec, revealTimestampSec, experimentHypothesis, notes }` с `.describe()`.
- `buildTimelineSkeleton(script, wpm)` — каркас без визуала; `mergeLlmVisuals(skeleton, llmOutput)` с проверкой, что каждый сегмент покрыт хотя бы одним shot.
- `buildMediaChecklist(shotList, template)`; `experimentHypothesisFromTags(tags)`.
- `renderPackageMarkdown(pkg, script, idea)`.
- Юнит-тесты, snapshot-тест Markdown.

**DoD:** тесты зелёные.
**Оценка:** 1 д. **Зависимости:** E5-01.

### E6-02. Промпт `production.package` и job

**Сделать:**
- `production.package/1.0.0`: вход — сегменты с таймингами, целевая длительность, агрегированные визуальные паттерны (решение 2), список допустимых `sourceType`; выход — shots/overlays/sfx/rhythm по сегментам (без права менять текст нарратива).
- Job: payload `{ scriptId, mode: generate | regenerate }`; `BudgetGuard`; `buildTimelineSkeleton` → LLM → `mergeLlmVisuals` (непокрытый сегмент → repair-запрос) → `buildMediaChecklist` → гипотеза → insert версии; перенос `checklist_state` с предыдущей версии по `itemId`; идея `scripted → in_production`.
- Стоимость в `api_usage_log` (`operation: production_package`).
- Интеграционный тест с фейковым LLM: покрытие сегментов, перенос отметок.

**DoD:** финальный скрипт → пакет за ≤ 2 минуты, все сегменты покрыты.
**Оценка:** 1.5 д. **Зависимости:** E6-01, E5-05, E2-02.

### E6-03. БД: миграция `0006_production`, репозитории

**Сделать:**
- Миграция по таблице; `productionPackageRepo` (`insertVersion`, `latest(scriptId)`, `updateChecklistState`), `ownVideoRepo.createFromIdea(ideaId, url)` с парсингом `yt_video_id` из любых форм URL Shorts (`youtube.com/shorts/<id>`, `youtu.be/<id>`, `watch?v=`), уникальность `yt_video_id`.

**DoD:** миграция применяется; тесты парсера URL и репозиториев.
**Оценка:** 0.5 д. **Зависимости:** E6-01.

### E6-04. API и контракты Production

**Сделать:**
- `GET /production/:scriptId` (последняя версия + состояние чек-листа), `GET /production/packages/:id`, `POST /production/generate { scriptId }`, `POST /production/packages/:id/regenerate`, `PATCH /production/packages/:id/checklist { itemId, done }`, `GET /production/packages/:id/markdown` (text/markdown), `POST /ideas/:id/mark-edited` (→ `ready_to_publish`), `POST /ideas/:id/mark-published { url, publishedAt? }` (→ `published`, own_video).
- Контракты, клиент, тесты (в т.ч. невалидный URL → 400, дубликат `yt_video_id` → 409).

**DoD:** OpenAPI; тесты зелёные.
**Оценка:** 0.5–1 д. **Зависимости:** E6-02, E6-03.

### E6-05. UI: страница пакета

**Сделать:**
- `/ideas/[id]/production`: шапка (версия, стоимость, гипотеза эксперимента, hook @ s, reveal @ s), кнопки «Копировать Markdown», «Печать», «Перегенерировать», «Смонтировано», «Опубликовано» (модал с URL).
- Таблица таймлайна: `сек | нарратив | кадры | оверлеи | sfx | ритм`; shot list с типом источника и подсказкой по правам; media-чеклист с чекбоксами (сохранение по клику, оптимистично); заметки.
- Печатная версия: `@media print` — без навигации, компактные таблицы, крупные таймстемпы.
- На мобильном (телефон рядом с монтажным столом): чек-лист удобен для тапов.

**DoD:** пакет читается с телефона и печатается на 1–2 страницы; отметки сохраняются и переживают перегенерацию.
**Оценка:** 1.5 д. **Зависимости:** E6-04, E5-06.

### E6-06. Первый реальный Short по пакету

**Сделать:**
- Смонтировать в CapCut один Short строго по пакету; фиксировать трение: чего не хватило, что лишнее, где тайминги разошлись с реальной озвучкой.
- Правки шаблона чек-листа, промпта (`1.1.0`), полей пакета по итогам.
- Отметить «Опубликовано» через приложение → проверить `own_video`.
- ADR по решениям 1–7; обновление System Design.

**DoD:** один опубликованный Short с `own_video`, привязанным к идее и финальному скрипту; список правок внесён.
**Оценка:** 1 д (без учёта времени монтажа). **Зависимости:** E6-05.

---

## Порядок

```text
E6-01 ─► E6-02 ─► E6-04 ─► E6-05 ─► E6-06
      └► E6-03 ─┘
```

## Вне скоупа E6

- Автоматический монтаж, генерация видео/картинок — нет (CapCut вручную по принципу проекта).
- Поиск стоковых материалов по API — возможное расширение после E11.
- Генерация обложки — нет.

## Приёмка

| AC | Как проверяем | Статус |
|---|---|---|
| Пакет в 1 клик | кнопка на финальном скрипте → пакет ≤ 2 мин | ⬜ |
| Реально смонтирован Short | E6-06 выполнен, ссылка на видео в `own_video` | ⬜ |
| Отметки выполнения | чекбоксы сохраняются, переживают перегенерацию | ⬜ |
