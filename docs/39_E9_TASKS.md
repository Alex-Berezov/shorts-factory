# E9. Localization Layer — декомпозиция на задачи

_Дата: 2026-09-05. Источник: `20_TZ_HIGH_LEVEL.md` (E9), `10_SYSTEM_DESIGN.md` §4 (`localize.script`), §5 (`dub_track`), §7.5, `01_ARCHITECTURE.md` §5.7, `02_PRE_DEVELOPMENT_CHECKLIST.md` §C, §G. Статус: ✅ декомпозирован. Зависит от E5 (финальный скрипт), E7 (`own_video`, `dub_track`)._

## Цель эпика

Управляемая локализация: учёт Auto Dubbing (Mode A) сейчас и Custom Localization Factory (Mode B) в долгую.

**AC эпика:** по каждому опубликованному Short фиксируются оценки авто-дабов; для выбранного языка генерируется локализованный пакет (скрипт + метаданные + captions), проходящий QA-сверку фактов.

## Внешнее условие

Загрузка кастомных аудиодорожек (Multi-Language Audio) требует **Advanced Features** на канале (пока `Eligible`, не `Enabled`). Всё в E9, кроме фактической загрузки, от этого не зависит; handoff-пакет готовится заранее.

## Что уже есть

- `@sf/db`: `dub_track` с оценками (E7-06), `own_video`, `script` (сегменты с `claimIds`, таймингами), `research_brief` (allowed claims).
- Из E1–E5: `LlmClient`, реестр промптов, `estimateDurationSec`, `checkClaims`, очередь `localize.script`.

## Архитектурные решения E9

1. **Матрица языков — таблица, а не константа.** `language_config { code (BCP-47), name, priority int, strategy: auto | custom | off, wpm real, voice_profile_id FK nullable (E10), notes, is_active }`. Сид — 20 языков из приоритетного списка (de, es, pt-BR, fr, it, pl, ja, ko, hi, id, tr, ar, ru, nl, vi, th, zh-Hans, uk, ro, sv — корректируется оператором). Стратегия по умолчанию `auto`; `custom` включается по результатам ревью дабов и bake-off.
2. **Локализованный скрипт — сегменты 1:1 с мастером.** `LocalizedScriptSchema`: те же `segmentId`, локализованный текст, `claimIds` наследуются, `estStartSec/estEndSec` пересчитаны по `wpm` языка; плюс `title`, `description`, `hashtags[]`, `captions` (генерируются кодом из сегментов). Соответствие 1:1 позволяет проверять reveal-тайминг и трассировку фактов теми же функциями, что и для мастера.
3. **Тайминг — цикл до допуска.** После генерации: `revealSec_localized` vs `revealSec_master` и общая длительность — допуск ±2 с (`localization.timing_tolerance_sec`). При выходе — до 2 итераций `localize.tighten` («сократи сегменты 3–5 на N слов, не меняя фактов»). Оценка по `wpm` языка (сид — справочные значения, уточняются по факту после E10, где появятся реальные длительности аудио).
4. **QA — код проверяет структуру, модель проверяет смысл.** Код: `claimIds` ⊆ allowed, сегменты не потеряны/не добавлены, hedged-маркеры на месте, тайминг в допуске, запрещённые элементы (URL, упоминания брендов из `riskyToCopy`). Модель (промпт `localize.qa`): обратный пересказ на английском по сегментам + сверка фактов с allowed claims → список расхождений `{ segmentId, issue, severity }`. QA-отчёт хранится в версии; статус `qa: pass | warn | fail`.
5. **Captions — из сегментов, с уточнением по аудио.** `renderSrt/renderVtt(segments)` — чистые функции: разбивка на реплики ≤ 42 символа × 2 строки, тайминги из `est*`. Когда есть аудио (E10) с пословными таймстемпами — тайминги заменяются реальными (`captions.source: estimated | audio`).
6. **Mode A — сетка ревью и сравнение.** Страница ревью дабов на видео: языки матрицы × критерии (voice, translation, timing, tone 1–5) × решение publish/unpublish × заметки — пишет в `dub_track` (E7-06). Сводка по языкам за все видео: средние, доля `unpublish`, тренд → основание для перевода языка в `custom`.
7. **Handoff-пакет — файлы + инструкция.** `@sf/storage` (интерфейс `put/get/list/delete/url`, реализация — локальная FS в `MEDIA_DIR`; S3-совместимая — позже). Пакет: `handoff/<ytVideoId>/<lang>/` → `audio.mp3` (E10, если есть), `captions.srt`, `captions.vtt`, `metadata.json` (title/description/hashtags), `README.md` (пошаговая инструкция Studio, включая правило «удалить авто-даб перед загрузкой кастомного»); zip по запросу. Именование файлов — по конвенции, которую примет E11.

## Изменения схемы БД (миграция `0009_localization`)

| Таблица | Изменение |
|---|---|
| `language_config` | новая (решение 1) |
| `localized_script` | новая: `id, script_id FK, language, version, author enum(agent, operator), parent_id, segments jsonb, title, description, hashtags jsonb, captions_srt text, captions_vtt text, captions_source enum, timing jsonb, qa jsonb, qa_status enum(pass, warn, fail), status enum(draft, approved, superseded), prompt_versions jsonb, model, cost_usd, created_at`; unique `(script_id, language, version)` |
| `handoff_package` | новая: `id, own_video_id FK, language, localized_script_id FK, audio_asset_id FK nullable (E10), files jsonb, status enum(prepared, uploaded_manually, replaced), created_at, uploaded_at` |
| `dub_track` | `+ localized_script_id FK nullable` (для `kind = custom`) |
| `app_setting` | `localization.timing_tolerance_sec`, `localization.max_tighten_iterations`, `localization.default_prompts`, `localization.caption_max_chars` |

---

## Задачи

Суммарно ≈ 9.5–10 дней.

### E9-01. Матрица языков

**Сделать:**
- Миграция `language_config` + сид 20 языков с приоритетами и справочными `wpm`.
- `GET /localization/languages`, `PATCH /localization/languages/:code { strategy, priority, isActive, wpm, notes }`.
- UI `/localization/languages`: таблица с инлайн-правкой стратегии/приоритета; сводные оценки авто-дабов по языку (из E7-06) рядом — чтобы решение `auto → custom` принималось на данных.
- E7-06 переключается на список языков из матрицы.

**DoD:** матрица редактируется; ревью дабов использует её языки.
**Оценка:** 0.5–1 д. **Зависимости:** E7-06.

### E9-02. Mode A: сетка ревью авто-дабов и сравнительная таблица

**Сделать:**
- `/analytics/videos/[id]/dubs`: сетка «язык × критерии» с клавиатурным вводом (1–5), решение publish/unpublish, заметки; чек-лист ревью (имена, идиомы, тайминг, тон, произношение — из чек-листа §E3) как подсказки в шапке.
- `/localization/dubs`: сравнительная таблица языков за период (средние оценки, n видео, доля unpublish, тренд за 4 недели), сортировка; кнопка «перевести в custom» → `language_config.strategy`.
- Напоминание на видео: «дабы не оценены» для видео старше 2 дней без записей — бейдж в `/analytics`.
- Тесты API-агрегатов.

**DoD:** оценка 10 языков по видео — ≤ 3 минуты; таблица показывает, какие языки стабильно слабые.
**Оценка:** 1.5 д. **Зависимости:** E9-01.

### E9-03. `@sf/core`: схема локализованного скрипта, тайминг, captions, QA-правила

**Сделать:**
- `LocalizedScriptSchema` (решение 2), `retimeSegments(segments, wpm)`, `timingReport(master, localized, tolerance)` → `{ totalDeltaSec, revealDeltaSec, ok }`.
- `renderSrt`, `renderVtt` с разбивкой реплик (решение 5), `parseSrt` (для обратной загрузки).
- `structuralQa(master, localized, brief, banned)` → issues; `mergeQa(structural, semantic)` → `qa_status`.
- Тесты: тайминг в/вне допуска, SRT формат (snapshot), потерянный сегмент → `fail`.

**DoD:** тесты зелёные.
**Оценка:** 1 д. **Зависимости:** E5-01.

### E9-04. Промпты `localize.script`, `localize.metadata`, `localize.tighten`, `localize.qa`

**Сделать:**
- `localize.script/1.0.0`: вход — сегменты мастера с ролями и `claimIds`, язык, целевые тайминги, культурные заметки языка (`language_config.notes`); правила: локализация, не перевод; факты и reveal неизменны; идиомы адаптировать; имена/числа — как в claims; вернуть сегменты 1:1.
- `localize.metadata/1.0.0`: title (≤ 100 симв.), description, hashtags (локальные, без кальки), с запретом на кликбейт, нарушающий политику.
- `localize.tighten/1.0.0`: сократить указанные сегменты на N слов, не меняя фактов.
- `localize.qa/1.0.0`: обратный пересказ + сверка с allowed claims → issues с severity.
- `responseSchema` из Zod; тесты формата.

**DoD:** четыре промпта в реестре; цепочка на одном реальном скрипте × 1 язык даёт валидный результат.
**Оценка:** 1 д. **Зависимости:** E9-03, E2-02.

### E9-05. Job `localize.script`

**Сделать:**
- Payload `{ scriptId, language, mode: generate | regenerate }`; `jobId = localize:<scriptId>:<lang>:<version>`; предусловие — `language_config.strategy = custom` или явный ручной запуск.
- Цепочка: `localize.script` → `retimeSegments` → `timingReport` → до `max_tighten_iterations` × `localize.tighten` → `localize.metadata` → `renderSrt/Vtt` → `structuralQa` + `localize.qa` → insert версии со статусом `draft` и `qa_status`.
- `BudgetGuard.assert("gemini")`; стоимость всех вызовов в `api_usage_log` (`operation: localize_*`).
- Массовый запуск: `POST /localization/scripts/:scriptId/localize-all` → по всем `custom`-языкам матрицы (отдельные job'ы).
- Интеграционный тест с фейковым LLM: тайминг вне допуска → tighten → в допуске; потерянный сегмент → `fail`.

**DoD:** реальный скрипт × 2 языка → локализованные версии с QA за ≤ 5 минут на язык.
**Оценка:** 1.5 д. **Зависимости:** E9-04, E5-05.

### E9-06. БД: миграция `0009_localization`, репозитории, `@sf/storage`

**Сделать:**
- Миграция по таблице (кроме `language_config` — E9-01); `localizedScriptRepo`, `handoffPackageRepo`.
- Пакет `packages/storage` (`@sf/storage`): интерфейс `Storage { put(key, stream|buffer, meta), get, list(prefix), delete, publicPath }`, реализация `LocalFsStorage(MEDIA_DIR)`, тесты; `apps/api` отдаёт файлы по `/media/*` за basic auth.

**DoD:** миграция применяется; storage round-trip тест зелёный; файл скачивается через api.
**Оценка:** 0.5–1 д. **Зависимости:** E9-03.

### E9-07. API, контракты и UI локализации по видео

**Сделать:**
- `GET /localization/scripts/:scriptId` (языки × последняя версия × qa_status × handoff), `GET /localization/localized/:id`, `POST /localization/localized/:id/edit` (правка сегментов/метаданных → новая версия `operator`, QA пересчитывается структурно), `POST /localization/localized/:id/approve`, `POST /localization/localized/:id/regenerate`, `GET /localization/localized/:id/captions.(srt|vtt)`.
- UI `/ideas/[id]/localization`: матрица языков со статусами (нет / draft / warn / fail / approved / handoff prepared), запуск по языку или всем; страница языка — сегменты мастер ↔ локализация рядом, тайминг-индикаторы, QA-issues с переходом к сегменту, метаданные, превью captions, кнопки approve/regenerate/edit.
- Тесты роутов.

**DoD:** оператор просматривает, правит и утверждает локализацию; QA-проблемы видны у сегмента.
**Оценка:** 2 д. **Зависимости:** E9-05, E9-06, E5-06.

### E9-08. Handoff-пакет

**Сделать:**
- `buildHandoffPackage(ownVideoId, language)`: файлы по решению 7 в Storage, `README.md` из шаблона (шаги Studio → Languages → Add language → Dub → Add; правило удалить авто-даб; проверка переключения дорожек зрителем), `metadata.json`; `handoff_package` запись; zip по `GET /localization/handoff/:id.zip`.
- Кнопка «Подготовить пакет» на утверждённой локализации; «Загружено вручную» → `uploaded_manually` + `dub_track (kind: custom, status: published)`.
- Тесты сборки и содержимого zip.

**DoD:** пакет скачивается одним zip, инструкция читается без контекста приложения.
**Оценка:** 1 д. **Зависимости:** E9-07.

### E9-09. Пилот: 2 языка × 2 видео, ADR

**Сделать:**
- Локализовать 2 опубликованных Short на 2 языка с наибольшей аудиторией/худшими авто-дабами; по возможности — проверка носителем (или обратный перевод другой моделью как суррогат); зафиксировать расхождения QA vs человек.
- Тюнинг `wpm`, промптов (`1.1.0`), допусков.
- ADR по решениям 1–7; обновить System Design §4, §5, §7.5.

**DoD:** QA не пропустил фактических ошибок, найденных человеком; документы обновлены.
**Оценка:** 1 д. **Зависимости:** E9-08.

---

## Порядок

```text
E9-01 ─► E9-02
E9-03 ─► E9-04 ─► E9-05 ─► E9-07 ─► E9-08 ─► E9-09
      └► E9-06 ─┘
```

Mode A (E9-01/02) можно делать сразу после E7, задолго до Mode B.

## Вне скоупа E9

- Генерация аудио — E10; загрузка дорожек через API — нет публичного API (E11 — ручной чек-лист).
- Локализация визуальных оверлеев в видео — заметка в handoff, не автоматизируется.
- Отдельные каналы по языкам — решено не делать (checklist §G).

## Приёмка

| AC | Как проверяем | Статус |
|---|---|---|
| Оценки авто-дабов по каждому Short | нет опубликованных видео старше 7 дней без записей `dub_track` | ⬜ |
| Локализованный пакет с QA | 2 языка × 2 видео: скрипт + метаданные + captions, `qa_status ≠ fail`, zip скачан | ⬜ |
