# E11. Publishing Layer — декомпозиция на задачи

_Дата: 2026-09-05. Источник: `20_TZ_HIGH_LEVEL.md` (E11), `10_SYSTEM_DESIGN.md` §7.1, §7.5, `01_ARCHITECTURE.md` §5.9, `02_PRE_DEVELOPMENT_CHECKLIST.md` §D, §G. Статус: ✅ декомпозирован. Зависит от E6 (пакет, готовое видео), E7 (OAuth, `own_video`); для локализованных метаданных и кастомного аудио — E9/E10._

## Цель эпика

Автоматизация публикации там, где это официально поддержано.

**AC эпика:** Short публикуется/планируется из приложения; квота учтена; после публикации видео автоматически появляется в E7-цикле.

## Внешние предусловия

- OAuth scope `youtube.upload` (+ `youtube.force-ssl` для captions) — повторный consent (E7-01 flow с расширенным списком scopes).
- Для загрузки через API приложение в Google Cloud должно пройти проверку (или оставаться в testing с test user) — иначе загруженные видео могут получить статус private до аудита; уточнить в E11-01 и зафиксировать.

## Что уже есть

- Из E7: OAuth, `own_video`, синк своих видео; из E6: `mark-published` вручную; из E9: локализованные `title/description/hashtags`, captions, handoff-пакеты; из E1: `DataApiClient`, `QUOTA_COST` (`videosInsert: 1600`, `captionsInsert: 400`), `BudgetGuard("youtube_data")`.

## Архитектурные решения E11

1. **Публикация — сущность `publish_item` с жизненным циклом.** `draft → uploading → scheduled → published | failed`. Одна запись на Short; хранит ссылку на идею/скрипт/пакет, файл видео и обложки в Storage, метаданные (en), план по локализациям и captions, `publish_at`, `yt_video_id` после загрузки.
2. **Финальный файл попадает в приложение через загрузку.** `POST /publishing/items/:id/video` (multipart/resumable, до 1 ГБ) → `@sf/storage`; `ffprobe` проверяет: вертикаль 9:16, длительность ≤ 180 с, кодеки. Обложка — опционально (для Shorts используется редко).
3. **Загрузка на YouTube — resumable, приватная, с `publishAt`.** `videos.insert` (1600 units) с `snippet { title, description, tags, categoryId, defaultLanguage: en, defaultAudioLanguage: en }`, `status { privacyStatus: private, publishAt, selfDeclaredMadeForKids: false }`. YouTube сам публикует в назначенное время; мы не держим job до момента публикации. Планирование слотов — календарь на 2 слота/день (`publishing.slots`, TZ оператора).
4. **Квота — резерв для публикации, локализации дёшево, captions дозированно.** Дневной бюджет units делится: `publishing.reserved_units` (по умолчанию 4 000) резервируется под публикацию, Radar получает `soft_cap − reserved`. Локализованные title/description для всех языков — одним `videos.update` с `localizations` (50 units). Captions — 400 units **каждый**: загружаем только для языков из `publishing.caption_languages` (по умолчанию 3–5 приоритетных), не более `publishing.captions_per_day`; остальные — в очередь на следующие дни. Планировщик отказывается ставить слот, если резерв на день исчерпан.
5. **Синхронизация статуса — опрос + синк E7.** Job `publish.sync-status` каждые 15 минут для `scheduled`: `videos.list part=status` (1 unit на батч) → `published` при `privacyStatus = public`; `own_video` создаётся/связывается сразу после `videos.insert` (с `published_at = publishAt`), чтобы E7/E8 видели связку идея → видео до фактической публикации. Синк своего канала (E7-02) — страховка.
6. **Кастомные аудиодорожки — только ручной шаг.** Публичного API нет: на странице `publish_item` — чек-лист Studio с ссылками на handoff-пакеты по языкам (E9-08), отметки «загружено» → `handoff_package.uploaded_manually` + `dub_track`. Статус «Advanced Features включены» — ручной чекбокс на `/system` (E13); без него шаг показывается как заблокированный.
7. **Никаких повторных `insert` при сбое после отправки.** Идемпотентность: `publish_item.upload_session` хранит resumable URI; при падении job'а загрузка продолжается, не начинается заново; если `yt_video_id` уже получен — повторный job только обновляет метаданные. Это защита от двойной траты 1600 units и дубликатов на канале.

## Изменения схемы БД (миграция `0011_publishing`)

| Таблица | Изменение |
|---|---|
| `publish_item` | новая: `id, idea_id FK nullable, script_id FK nullable, package_id FK nullable, own_video_id FK nullable, status enum, video_storage_key, thumbnail_storage_key, video_probe jsonb, title, description, tags jsonb, category_id, publish_at timestamptz, slot_id, yt_video_id, upload_session text, localizations_plan jsonb, localizations_status jsonb, captions_plan jsonb, captions_status jsonb, custom_audio_checklist jsonb, error text, units_spent int, created_at, updated_at` |
| `publish_slot` | новая: `id, date, slot_index, time_local, publish_item_id FK nullable` (unique `(date, slot_index)`) |
| `own_video` | `+ publish_item_id FK nullable` |
| `oauth_token` | `scopes` — расширяются; `+ scopes_version` |
| `app_setting` | `publishing.slots` (`["09:00","18:00"]`), `publishing.reserved_units`, `publishing.caption_languages`, `publishing.captions_per_day`, `publishing.default_category_id`, `publishing.default_tags` |

---

## Задачи

Суммарно ≈ 9–9.5 дней.

### E11-01. Расширение OAuth scopes и загрузка медиа в приложение

**Сделать:**
- E7-01: список scopes из конфига, `scopes_version`; при недостающих scopes — баннер «требуется переподключение» и повторный consent; проверка статуса приложения в Google Cloud (testing/production) — результат в раздел «Проверки» ниже.
- `POST /publishing/items` (создание draft из идеи/скрипта/пакета или пустого), `POST /publishing/items/:id/video` — загрузка файла чанками (tus-подобно или простой multipart с лимитом), сохранение в Storage, `ffprobe` → `video_probe`, валидация формата (решение 2), `POST …/thumbnail`.
- Миграция `0011_publishing` (обе таблицы), репозитории.
- Тесты валидации probe на фикстурах.

**DoD:** файл mp4 загружается в приложение и проверяется; неверный формат — понятная ошибка.
**Оценка:** 1 д. **Зависимости:** E7-01, E9-06 (storage).

### E11-02. Операции записи Data API

**Сделать:**
- `@sf/youtube`: `insertVideo(stream, meta, status)` — resumable upload с сохранением/возобновлением session URI (решение 7), прогресс; `updateLocalizations(videoId, localizations)`; `setThumbnail(videoId, image)`; `insertCaption(videoId, language, srt, name)`; `listVideoStatus(ids)`.
- Учёт units по `QUOTA_COST` (`videosInsert 1600`, `videosUpdate 50`, `thumbnailsSet 50`, `captionsInsert 400`, `videosList 1`); OAuth-аутентификация (не API key).
- Резерв квоты: `BudgetGuard` получает понятие `bucket: radar | publishing` с раздельными лимитами (решение 4); Radar soft cap пересчитывается.
- Тесты с подменённым транспортом: возобновление после обрыва не делает второй `insert`.

**DoD:** тестовое видео загружено на канал как private через клиент; units записаны; обрыв и возобновление — один `yt_video_id`.
**Оценка:** 1.5 д. **Зависимости:** E11-01, E1-01, E1-08.

### E11-03. Планировщик и job'ы `publish.upload`, `publish.sync-status`

**Сделать:**
- Слоты: генерация `publish_slot` на 14 дней вперёд по `publishing.slots`; `POST /publishing/items/:id/schedule { slotId | publishAt }` → проверка резерва units на день загрузки → `status: scheduled` (загрузка выполняется сразу, публикация — по `publishAt`) или сообщение «резерв исчерпан, ближайший слот …».
- Job `publish.upload`: `jobId = publish:<itemId>`; `BudgetGuard("youtube_data", bucket: publishing)`; insert (или продолжение сессии) → `yt_video_id` → создать/связать `own_video (source: app, publish_item_id, idea_id, script_id)` → обложка → пометка `scheduled`; ошибки → `failed` с текстом, повтор только вручную (кроме сетевых внутри resumable).
- Job `publish.sync-status` (каждые 15 мин): `scheduled` → `published` по статусу; при `published` — идея `→ published` (если ещё нет), запуск `experiment.features` (E8-04).
- Опция «опубликовать сейчас» (`privacyStatus: public` без `publishAt`).
- Интеграционный тест с фейковым клиентом: schedule → upload → sync → published; резерв квоты блокирует лишний слот.

**DoD:** Short планируется из приложения и выходит в назначенное время; `own_video` привязан заранее.
**Оценка:** 1.5 д. **Зависимости:** E11-02, E6-04, E7-02.

### E11-04. Публикация локализованных метаданных и captions

**Сделать:**
- `localizations_plan` формируется из утверждённых локализаций E9 (языки × title/description); job `publish.localizations` после получения `yt_video_id`: один `videos.update` с `localizations` (50 units) → `localizations_status`.
- `captions_plan` — языки из `publishing.caption_languages` ∩ утверждённые локализации; job `publish.captions` ежедневно: до `captions_per_day` загрузок (400 units каждая) в пределах резерва, приоритет — по `language_config.priority`; статус по языкам; captions на en — из мастер-скрипта (E9-03 `renderSrt` по сегментам мастера или из `audio_asset` таймингов, если есть).
- Повторный запуск при появлении новых утверждённых локализаций.
- Тесты планов и лимитов.

**DoD:** у опубликованного видео локализованные title/description на всех утверждённых языках; captions загружаются по расписанию в пределах квоты.
**Оценка:** 1 д. **Зависимости:** E11-03, E9-07.

### E11-05. Чек-лист кастомного аудио (ручной шаг Studio)

**Сделать:**
- На странице `publish_item`: блок «Кастомные дорожки» — по языкам со `strategy: custom` и готовым handoff (E9-08): ссылка на zip, шаги Studio (Languages → Add language → Dub → Add; предварительно удалить авто-даб), чекбокс «загружено» → `uploaded_manually`, `dub_track(custom, published)`; блок заблокирован с пояснением, пока `/system` не отмечает «Advanced Features: Enabled».
- Тесты статусов.

**DoD:** оператор проходит шаги по списку и фиксирует результат; состояние видно в E9 сводке.
**Оценка:** 0.5 д. **Зависимости:** E11-03, E9-08, E13-05.

### E11-06. API и контракты Publishing

**Сделать:**
- `GET /publishing/items` (статус, период), `GET /publishing/items/:id`, `PATCH /publishing/items/:id { title, description, tags, categoryId }`, `POST …/schedule`, `POST …/publish-now`, `POST …/retry`, `DELETE` (только draft/failed), `GET /publishing/calendar?from&to` (слоты + items), `GET /publishing/quota` (резерв/расход/прогноз дня).
- Контракты `@sf/contracts/publishing/*`, клиент, тесты.

**DoD:** OpenAPI; тесты зелёные.
**Оценка:** 0.5–1 д. **Зависимости:** E11-04.

### E11-07. UI: календарь и страница публикации

**Сделать:**
- `/publishing`: календарь на 2 недели с 2 слотами/день (занят / свободен / резерв квоты исчерпан), drag-and-drop item в слот (или выбор из списка), список `draft/failed`.
- `/publishing/items/[id]`: загрузка видео (прогресс, результат probe, превью), метаданные en (из идеи/скрипта по умолчанию, редактируемые, счётчик длины title), локализации (таблица языков и статусов), captions (план и статус, квота), кастомное аудио (E11-05), кнопки «Запланировать», «Опубликовать сейчас», «Повторить», лог ошибок, `units_spent`.
- Из пакета E6: кнопка «К публикации» создаёт `publish_item` с предзаполнением (заменяет ручной `mark-published`, который остаётся для внешних публикаций).

**DoD:** сценарий «пакет → загрузить mp4 → выбрать слот → запланировать → в назначенное время видео публично → `/analytics` видит его» проходит.
**Оценка:** 2 д. **Зависимости:** E11-06, E6-05.

### E11-08. Первая реальная публикация через приложение, ADR

**Сделать:**
- Опубликовать 1–2 реальных Short через приложение; сверить units с Google Cloud Console; проверить локализованные метаданные в Studio; убедиться, что видео попало в E7 ingest.
- Зафиксировать статус приложения Google (testing/production) и ограничения.
- ADR по решениям 1–7; обновить System Design §7.1, §7.5, §4.

**DoD:** реальный Short опубликован из приложения; расход units совпал; документы обновлены.
**Оценка:** 1 д. **Зависимости:** E11-07.

---

## Порядок

```text
E11-01 ─► E11-02 ─► E11-03 ─► E11-04 ─► E11-06 ─► E11-07 ─► E11-08
                          └─► E11-05 ─┘
```

## Проверки (E11-01)

_Статус OAuth-приложения в Google Cloud, ограничения на загрузку в testing-режиме._

## Вне скоупа E11

- Автозагрузка кастомных аудиодорожек — нет публичного API.
- Публикация на TikTok/Reels — вне MVP.
- Автогенерация обложек и A/B-тест обложек — нет.
- Комментарии, закреплённые комментарии, плейлисты — при необходимости позже (дёшево по квоте).

## Приёмка

| AC | Как проверяем | Статус |
|---|---|---|
| Short публикуется/планируется из приложения | E11-08: реальная публикация по слоту | ⬜ |
| Квота учтена | `units_spent` = 1600 + 50 + 400 × captions; Radar не пострадал (резерв) | ⬜ |
| Видео автоматически в E7-цикле | `own_video` с `publish_item_id`, `analytics_daily` появляется через 2–3 дня | ⬜ |
