# E10. Voice Factory — декомпозиция на задачи

_Дата: 2026-09-05. Источник: `20_TZ_HIGH_LEVEL.md` (E10), `10_SYSTEM_DESIGN.md` §2 (TTS), §7.4, `01_ARCHITECTURE.md` §5.8, `02_PRE_DEVELOPMENT_CHECKLIST.md` §J. Статус: ✅ декомпозирован. Зависит от E9._

## Цель эпика

Абстракция TTS-провайдеров и bake-off для выбора голоса по языкам.

**AC эпика:** bake-off по 2–3 языкам проведён и задокументирован в системе; для выбранного языка кастомная дорожка генерируется в 1 действие и попадает в handoff-пакет E9.

## Внешние предусловия

- API-ключи провайдеров, участвующих в bake-off: `ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, `CARTESIA_API_KEY`, Google Cloud TTS (сервисный аккаунт или API key — уточнить в E10-03), Gemini TTS — через `GEMINI_API_KEY`. Провайдер без ключа просто не участвует.
- `ffmpeg`/`ffprobe` в образе worker (длительность, нормализация громкости, конвертация в mp3/wav).

## Что уже есть

- `@sf/tts`: интерфейс `TtsProvider { name, synthesize(req) }`, `SynthesizeRequest { text, language, voiceRef, instructions?, speakingRate? }`, `SynthesizeResult { audioPath, costUsd, meta }`, заглушки адаптеров (elevenlabs, openai-tts, google-chirp, gemini-tts, cartesia).
- Из E9: `localized_script` с сегментами, `language_config.voice_profile_id`, `handoff_package`, `@sf/storage`; из E0: `BudgetGuard("tts")`, `TTS_MONTHLY_BUDGET_USD`.

## Архитектурные решения E10

1. **Интерфейс — файл на выходе, посегментная генерация.** `synthesize` возвращает `{ storageKey, durationSec, costUsd, wordTimestamps?, meta }`. Озвучиваем **по сегментам** локализованного скрипта, затем склеиваем (`ffmpeg concat`) с паузами по ролям (`tts.pause_ms_by_role`). Так проще править один сегмент и получать таймстемпы для captions без пословных меток провайдера.
2. **Стоимость считается до вызова и после.** `estimateCost(text)` по прайсу провайдера (`app_setting.tts.prices[provider]`, за 1k символов) — для гейта бюджета; фактическая — из ответа провайдера, если он её отдаёт, иначе = оценке. `UsageLogger` (`provider: <tts provider>`, `operation: synthesize`, `cost_usd`).
3. **Реестр голосов — таблица `voice_profile`.** `{ id, language, provider, voice_ref, model, display_name, instructions, speaking_rate, price_per_1k_chars, status: candidate | approved | retired, notes }`. `language_config.voice_profile_id` → утверждённый голос языка. Bake-off работает с `candidate`, утверждение переводит в `approved`.
4. **Bake-off — матрица одним job'ом, оценки — вручную в UI.** `bakeoff { id, script_id, languages[], voice_profile_ids[], status }` → `bakeoff_sample { bakeoff_id, language, voice_profile_id, storage_key, duration_sec, cost_usd, scores jsonb (naturalness, emotion, pronunciation, timing 1–5), notes }`. Строка «YouTube Auto Dub» добавляется как `voice_profile` с `provider = youtube_auto_dub` без адаптера — оценки вносятся вручную после прослушивания в Studio (System Design §7.4).
5. **Финальная дорожка — версионируемый `audio_asset`.** `audio_asset { id, localized_script_id, voice_profile_id, storage_key, duration_sec, segments_timing jsonb, loudness_lufs, cost_usd, qa_status: pending | ok | rejected, qa_notes, created_at }`. Пересинтез — новая запись; handoff ссылается на конкретную.
6. **QA дорожки — автоматический + прослушивание.** Автомат: длительность vs мастер (±2 с, как в E9), reveal-тайминг по склейке, громкость нормализована до `−14 LUFS` (стандарт для платформ), нет клиппинга, нет тишины > 1.5 с. Прослушивание — чекбокс «прослушано, ок» оператором → `qa_status: ok`.
7. **Hard-cap TTS — месячный, с прогнозом.** `BudgetGuard("tts")` по сумме `cost_usd` всех TTS-провайдеров за календарный месяц против `TTS_MONTHLY_BUDGET_USD`; предоценка стоимости job'а прибавляется к текущему расходу до вызова; при 80 % — алерт, при 100 % — блок (кроме bake-off? нет — блок всех).

## Изменения схемы БД (миграция `0010_voice`)

| Таблица | Изменение |
|---|---|
| `voice_profile` | новая (решение 3) |
| `bakeoff`, `bakeoff_sample` | новые (решение 4) |
| `audio_asset` | новая (решение 5) |
| `handoff_package` | `audio_asset_id FK` (уже заложено в E9) |
| `localized_script` | `+ captions_source` уже есть; captions обновляются из `segments_timing` |
| `app_setting` | `tts.prices`, `tts.pause_ms_by_role`, `tts.target_lufs`, `tts.max_silence_ms`, `tts.default_format` |

---

## Задачи

Суммарно ≈ 10–11 дней.

### E10-01. Интерфейс провайдера, реестр адаптеров, аудио-утилиты

**Сделать:**
- Финализировать `TtsProvider` (решение 1): `synthesize(req) → { storageKey, durationSec, costUsd, meta }`, `estimateCost(text)`, `listVoices?()`, `capabilities { wordTimestamps, instructions, speakingRate, formats }`.
- `ProviderRegistry`: активные провайдеры по наличию ключей; общий `withRetry` (429/5xx), таймауты, `UsageLogger`.
- `@sf/tts/audio`: обёртки над `ffprobe` (длительность), `ffmpeg` (concat с паузами, loudnorm до целевого LUFS, конвертация в mp3 320k / wav), детектор тишины/клиппинга; тесты на маленьких фикстурах.
- Docker: `ffmpeg` в образе worker (E0-11 Dockerfile дополняется).

**DoD:** `concat` трёх тестовых wav даёт файл ожидаемой длительности; реестр показывает провайдеры с ключами.
**Оценка:** 1 д. **Зависимости:** E9-06 (storage), E0-11.

### E10-02. Адаптер ElevenLabs

**Сделать:**
- `synthesize` (multilingual модель, `voiceRef`, `speakingRate` через стабильность/стиль где применимо), опционально таймстемпы (эндпоинт with-timestamps → `wordTimestamps`), `listVoices`, прайс за символ, ошибки квоты.
- Тесты с подменённым HTTP; ручная проверка на 2 языках.

**DoD:** реальный синтез фразы на de/es, стоимость в логе.
**Оценка:** 1 д. **Зависимости:** E10-01.

### E10-03. Адаптеры Google Chirp 3 HD и Gemini TTS

**Сделать:**
- Google Cloud Text-to-Speech (`@google-cloud/text-to-speech`): голоса Chirp 3 HD по языкам, `speakingRate`, SSML-паузы при необходимости; аутентификация — уточнить (сервисный аккаунт JSON в env как base64 или ADC), задокументировать в `.env.example`.
- Gemini TTS через `@google/genai` (модель с аудио-выходом): `instructions` как стиль речи, выбор голоса; конвертация PCM → wav/mp3.
- Прайсы обоих в `tts.prices`; тесты с подменённым SDK; ручная проверка.

**DoD:** оба адаптера синтезируют на 2 языках; стоимость в логе.
**Оценка:** 1.5 д. **Зависимости:** E10-01.

### E10-04. Адаптеры OpenAI TTS и Cartesia

**Сделать:**
- OpenAI TTS: модель с поддержкой `instructions`, голоса, формат mp3/wav; прайс.
- Cartesia (Sonic): голоса по языкам, скорость/эмоции по возможностям API, таймстемпы если доступны; прайс.
- Тесты с подменённым HTTP; ручная проверка.

**DoD:** оба адаптера синтезируют на 2 языках; стоимость в логе.
**Оценка:** 1.5 д. **Зависимости:** E10-01.

### E10-05. Реестр голосов `voice_profile`

**Сделать:**
- Миграция `voice_profile` (+ остальные таблицы `0010_voice`); сид кандидатов: по 1–2 голоса на провайдер для 3 пилотных языков (E9-09) + строка `youtube_auto_dub` на каждый язык.
- API: CRUD `/voices`, `POST /voices/import { provider, language }` (через `listVoices`), `POST /voices/:id/approve` → `language_config.voice_profile_id`.
- UI `/localization/voices`: таблица по языкам с фильтром провайдера, статус, прайс, кнопка «прослушать пример» (короткий синтез фиксированной фразы — кэшируется в storage).
- Тесты.

**DoD:** голоса кандидатов заведены; пример прослушивается из UI.
**Оценка:** 1 д. **Зависимости:** E10-02…E10-04 (хотя бы один адаптер).

### E10-06. Bake-off: раннер и UI оценок

**Сделать:**
- Job `tts.bakeoff`: payload `{ bakeoffId }`; для каждого языка берётся утверждённая локализация (E9) или мастер (для en), для каждого `voice_profile` кандидата — посегментный синтез + склейка → `bakeoff_sample` (длительность, стоимость); `BudgetGuard("tts")` с предоценкой всей матрицы до старта; ошибки провайдера — sample со `status: failed`, остальные продолжаются.
- API: `POST /bakeoffs { scriptId, languages, voiceProfileIds }`, `GET /bakeoffs/:id`, `PATCH /bakeoffs/:id/samples/:sampleId { scores, notes }`.
- UI `/localization/bakeoffs/[id]`: матрица язык × голос с плеером, оценки 1–5 по 4 критериям + тайминг vs мастер + стоимость, сортировка по среднему, кнопка «утвердить голос для языка»; строка Auto Dub — с ручным вводом (ссылка на видео в Studio).
- Тесты раннера с фейковыми провайдерами.

**DoD:** bake-off на 1 скрипт × 3 языка × N голосов запускается одним действием, все сэмплы слушаются и оцениваются в UI.
**Оценка:** 2 д. **Зависимости:** E10-05, E9-07.

### E10-07. Job `tts.generate`: финальная дорожка Mode B

**Сделать:**
- Payload `{ localizedScriptId, voiceProfileId? }` (по умолчанию — утверждённый голос языка); посегментный синтез → склейка с паузами → loudnorm → `audio_asset` с `segments_timing` (по фактическим длительностям сегментов).
- Автопроверки QA (решение 6): длительность/reveal vs мастер, LUFS, клиппинг, тишина → `qa_status: pending` с отчётом (ok-кандидат) или `rejected` с причинами.
- Обновить captions локализации реальными таймингами (`captions_source: audio`).
- Пересинтез одного сегмента (`POST /audio/:id/resynthesize-segment { segmentId }`) — новая версия asset с заменённым сегментом.
- Привязка к handoff (E9-08): «Подготовить пакет» берёт `audio_asset` с `qa_status: ok`.
- UI на странице локализации: плеер, отчёт QA, чекбокс «прослушано», кнопка пересинтеза сегмента.
- Интеграционный тест с фейковым провайдером.

**DoD:** утверждённая локализация → дорожка в 1 действие; после «прослушано» дорожка в handoff-пакете.
**Оценка:** 1.5 д. **Зависимости:** E10-06, E9-08.

### E10-08. Бюджет TTS

**Сделать:**
- `BudgetGuard("tts")` — месячная агрегация по всем TTS-провайдерам, предоценка в гейте (решение 7); `/system`: $ за месяц / лимит, по провайдерам, прогноз до конца месяца; алерт при 80 %.
- Тесты порогов.

**DoD:** заниженный лимит блокирует `tts.generate` и `tts.bakeoff` до внешнего вызова; алерт виден.
**Оценка:** 0.5 д. **Зависимости:** E10-06.

### E10-09. Проведение bake-off и решение, ADR

**Сделать:**
- Bake-off на 1–2 реальных скриптах × 3 языка × все доступные провайдеры + Auto Dub; критерии из чек-листа §J (naturalness, emotion, pronunciation, multilingual consistency, timing control, API ergonomics, cost).
- Утвердить голоса для пилотных языков; языки со слабым Auto Dub и хорошим кастомом → `strategy: custom`.
- Раздел «Результаты bake-off» ниже; ADR по решениям 1–7; обновить System Design §7.4.

**DoD:** решение по голосам зафиксировано в системе (`approved`) и в документе.
**Оценка:** 1 д. **Зависимости:** E10-08.

---

## Порядок

```text
E10-01 ─┬─► E10-02 ─┐
        ├─► E10-03 ─┼─► E10-05 ─► E10-06 ─► E10-07 ─► E10-09
        └─► E10-04 ─┘                └─► E10-08 ─┘
```

Адаптеры E10-02…04 независимы и могут идти параллельно.

## Результаты bake-off (E10-09)

_Таблица язык × голос × критерии × стоимость; выбранные голоса._

## Вне скоупа E10

- Клонирование голоса / собственный голос бренда — после выбора провайдера, отдельным решением.
- Стриминговый синтез — не нужен для файлового пайплайна.
- Автоматическая оценка качества речи (MOS-модели) — нет, оценивает человек.

## Приёмка

| AC | Как проверяем | Статус |
|---|---|---|
| Bake-off по 2–3 языкам проведён и задокументирован в системе | `bakeoff` со всеми оценками, голоса `approved` | ⬜ |
| Кастомная дорожка в 1 действие → handoff | `tts.generate` → QA ok → пакет содержит `audio.mp3` | ⬜ |
