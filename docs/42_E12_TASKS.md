# E12. Импорт ручной фазы и журнал Phase 0 — декомпозиция на задачи

_Дата: 2026-09-05. Источник: `20_TZ_HIGH_LEVEL.md` (E12), `02_PRE_DEVELOPMENT_CHECKLIST.md` §E4, §F, `10_SYSTEM_DESIGN.md` §5 (`own_video.manual_log`). Статус: ✅ декомпозирован. Зависит от E0; делается рано — сразу после E0, параллельно с E1. Маппинг на синхронизированные видео — после E7._

## Цель эпика

Данные ручного периода (4–7 Shorts/нед) не теряются и попадают в датасет Experiment Engine.

**AC эпика:** все ручные Shorts и наблюдения по дабам занесены в БД и видны в аналитике/экспериментах.

## Что уже есть

- `@sf/db`: `own_video (yt_video_id, idea_id nullable, published_at, title, language, experiment_features, manual_log)`, `dub_track`.
- Из E0: web-оболочка, api, контракты. Из E7 (позже): синк своего канала, `dub_track` с оценками (E7-06). Из E8 (позже): `buildFeatures` читает `manual_log`.

## Архитектурные решения E12

1. **Журнал — это `own_video.manual_log`, а не отдельная таблица.** Поля чек-листа §F: `workingTitle`, `topic`, `subtopic`, `hookType`, `durationSec`, `openingVisualType`, `revealTimingSec`, `publishDate`, `url/videoId` + необязательные `resultFirst`, `hasFace`, `hasBigText`, `endingType`, `notes`. `ManualLogSchema` в `@sf/core`; `hookType`/`openingVisualType`/`endingType` — те же enum'ы, что в DNA и `ExperimentTagsSchema`, чтобы E8 не переводил словари.
2. **Импорт — двухфазный: dry-run с построчными ошибками, затем commit.** CSV (UTF-8, `;` или `,` — автоопределение) → парсинг → валидация каждой строки Zod → отчёт (строка, поле, ошибка) → оператор правит файл или в UI → commit. Дедупликация по `yt_video_id` (из любого формата URL): существующая запись обновляется по полям `manual_log`, не дублируется.
3. **Форма для одной записи — тот же контракт, что и строка CSV.** Одна Zod-схема, два входа. Пока видео мало (единицы в неделю), форма — основной инструмент; CSV — для догонки истории.
4. **Оценки авто-дабов — в `dub_track` через ту же форму, что E7-06.** До E7 таблица уже существует (скелет), форма E12 пишет туда напрямую (`kind: auto`, оценки, решение); E7-06/E9-02 потом просто переиспользуют данные. Таблица результатов теста §E4 чек-листа = это.
5. **Маппинг после E7 — по `yt_video_id`.** Когда синк своего канала (E7-02) создаёт `own_video (source: sync)` для видео, у которого уже есть запись `source: manual_import`, записи сливаются: остаётся одна строка с обоими источниками данных (`tracked_video_id` от синка, `manual_log` от импорта). Правило слияния — в `ownVideoRepo.upsertBySource` (E7-02 обязан его учесть).

## Изменения схемы БД (миграция `0012_manual_import`)

| Таблица | Изменение |
|---|---|
| `own_video` | `manual_log jsonb` валидируется `ManualLogSchema`; `source enum(app, manual_import, sync)` (заложено в E6); `+ manual_log_imported_at` |
| `import_batch` | новая: `id, kind enum(manual_log, dub_review), filename, rows_total, rows_ok, rows_failed, report jsonb, committed bool, created_at` |
| `app_setting` | `manual_import.csv_template_version` |

---

## Задачи

Суммарно ≈ 3.5–4 дня.

### E12-01. `@sf/core`: схема журнала и CSV-парсер

**Сделать:**
- `ManualLogSchema` (решение 1) с `.describe()` и enum'ами, общими с DNA/тегами; `parseYoutubeVideoId(input)` (общая с E6-03 — реализовать здесь, E6 переиспользует).
- `parseManualLogCsv(text)` → `{ rows: Array<{ line, data | errors }> }`; поддержка заголовков на английском (шаблон) и русском (алиасы), дат в `YYYY-MM-DD` и `DD.MM.YYYY`, длительности `45` / `0:45`.
- `DubReviewRowSchema` и `parseDubReviewCsv` для таблицы §E4 (`videoId, language, generated, voiceScore, translationScore, timingScore, publishDecision, notes`).
- CSV-шаблоны как файлы в `docs/templates/manual_log.csv`, `dub_review.csv`.
- Юнит-тесты на форматы, ошибки, дубликаты внутри файла.

**DoD:** тесты зелёные; шаблоны лежат в репозитории.
**Оценка:** 0.5 д. **Зависимости:** E0-05.

### E12-02. API: импорт с dry-run, форма записи

**Сделать:**
- Миграция `0012_manual_import`; `importBatchRepo`.
- `POST /import/manual-log/dry-run` (multipart CSV) → `import_batch` с отчётом; `POST /import/manual-log/:batchId/commit` → upsert `own_video (source: manual_import)` по `yt_video_id`, `manual_log_imported_at`.
- `POST /import/manual-log/row` (форма одной записи, та же схема), `PATCH /analytics/videos/:id/manual-log`.
- `POST /import/dub-review/dry-run|commit` → upsert `dub_track (kind: auto)`.
- `GET /import/batches`, `GET /import/templates/:kind.csv`.
- Тесты: dry-run с ошибками не пишет в `own_video`; commit идемпотентен; дубликат URL обновляет, не дублирует.

**DoD:** тестовый CSV с 10 строками и 2 ошибками → отчёт; после правки — 10 записей.
**Оценка:** 1 д. **Зависимости:** E12-01, E0-06.

### E12-03. UI: форма и CSV-импорт

**Сделать:**
- `/analytics/import` (до E7 — доступна из навигации «Analytics»): форма одной записи с подсказками по полям (что считать `revealTimingSec`, список `hookType` с примерами); загрузка CSV → таблица предпросмотра с подсветкой ошибок по ячейкам → «Импортировать N строк» (ошибочные строки пропускаются с пометкой или блокируют — переключатель); история батчей.
- Список импортированных видео с быстрым редактированием `manual_log`.
- Ссылка на шаблоны CSV.

**DoD:** оператор заводит новый Short за ≤ 1 минуту; импорт истории — за один проход.
**Оценка:** 1 д. **Зависимости:** E12-02, E0-10.

### E12-04. Форма результатов теста авто-дабов

**Сделать:**
- На карточке импортированного видео — сетка «язык × generated? × voice/translation/timing 1–5 × publish? × notes» (языки — из `app_setting.languages.review_list`, позже из матрицы E9); сохранение в `dub_track`.
- Сводка по языкам на `/analytics/import` (средние оценки, n) — первый бенчмарк для будущего сравнения с кастомным TTS.
- Тесты.

**DoD:** результаты §E4 чек-листа заносятся в 2–3 минуты на видео; сводка по языкам считается.
**Оценка:** 0.5–1 д. **Зависимости:** E12-03.

### E12-05. Маппинг на синк и фичи для E8 (после E7)

**Сделать:**
- Правило слияния `manual_import` + `sync` в `ownVideoRepo.upsertBySource` (решение 5) — реализовать здесь, E7-02 использует; обратный проход: для уже существующих `sync`-записей подтянуть `manual_log` по `yt_video_id`.
- `buildFeatures` (E8-01) читает `manual_log` как источник `source: manual` для фич `hookType`, `openingVisualType`, `revealPct` (из `revealTimingSec / durationSec`), `resultFirst`, `hasFace`, `hasBigText`, `endingType`.
- Тесты слияния и маппинга фич.

**DoD:** все ручные Shorts имеют одну строку `own_video` со снапшотами/аналитикой и `manual_log`; фичи заполнены из журнала.
**Оценка:** 0.5 д. **Зависимости:** E7-02, E8-01.

---

## Порядок

```text
E12-01 ─► E12-02 ─► E12-03 ─► E12-04            (сразу после E0)
                                        E12-05  (после E7-02 и E8-01)
```

## Вне скоупа E12

- Импорт статистики из CSV-выгрузок Studio — не нужен: E7 заберёт через API за весь период.
- Google Sheets как источник — CSV достаточно.

## Приёмка

| AC | Как проверяем | Статус |
|---|---|---|
| Все ручные Shorts в БД | число записей `manual_import` = число опубликованных Shorts фазы 0 | ⬜ |
| Наблюдения по дабам в БД | `dub_track` заполнен по каждому видео фазы 0 | ⬜ |
| Видны в аналитике/экспериментах | после E7/E8: у ручных видео есть витрина и фичи из журнала | ⬜ |
