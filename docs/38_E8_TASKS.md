# E8. Experiment Engine — декомпозиция на задачи

_Дата: 2026-09-05. Источник: `20_TZ_HIGH_LEVEL.md` (E8), `10_SYSTEM_DESIGN.md` §4 (`experiment.recompute`), §5 (Experiments), `01_ARCHITECTURE.md` §5.11. Статус: ✅ декомпозирован. Зависит от E7 (витрина метрик), E5 (теги), E2 (DNA)._

## Цель эпика

Превращение каждого Short в структурированный эксперимент и генерация рекомендаций.

**AC эпика:** каждый Short имеет заполненные фичи; после ≥ 20–30 видео система выдаёт содержательные рекомендации с confidence; эксперимент можно завести, привязать видео и получить итоговое сравнение.

## Что уже есть

- `@sf/db`: `experiment (hypothesis, design, status, conclusion)`, `experiment_recommendation (body, confidence, based_on)`, `own_video.experiment_features jsonb`.
- Из E5: `ExperimentTagsSchema`; из E2: DNA (в т.ч. `own_video` kind); из E6: пакет с hook/reveal таймстемпами; из E7: `own_video_metrics`, дабы; из E1: DNA конкурентов + `baselineRatio` сигналов.

## Архитектурные решения E8

1. **Фичи — одна схема, несколько источников, провенанс на поле.** `ExperimentFeaturesSchema` (blueprint §5.11) объединяет: теги скрипта (E5), DNA собственного видео (E2 `own_video` — если сделан), пакет (E6: hook/reveal таймстемпы, ритм), публикацию (день недели, час, длительность фактическая, язык, auto-dub on/off), локализацию (E9: стратегия), голос (E10: провайдер). Каждое поле хранит `{ value, source: script | dna | package | publish | manual, updatedAt }`. Ручная правка переопределяет автоматику и не затирается пересчётом.
2. **Целевая метрика — относительная, не абсолютная.** Основная: `baselineRatio24h` (просмотры за 24 ч / ожидание базлайна канала на момент публикации) — устраняет рост канала во времени. Вторичные: `avgViewPct`, `views7d_ratio`, `engagedViewRate`. Список и приоритет — `app_setting.experiments.outcomes`. Видео моложе 3 дней в расчёты не входят (данные не дозрели).
3. **Статистика — честная и простая, в коде.** Категориальная фича: сравнение групп по медиане целевой метрики, критерий Манна–Уитни (p-value), размер эффекта — дельта Клиффа; числовая фича: корреляция Спирмена с доверительным интервалом (бутстрэп). Минимальный размер группы `experiments.min_group_size` (5). Поправка на множественные сравнения — Бенджамини–Хохберг по всем проверенным фичам за прогон. Confidence-бенды: `low` (n < 10 или q > 0.2), `medium` (q ≤ 0.2, |δ| ≥ 0.3), `high` (q ≤ 0.05, |δ| ≥ 0.5, n ≥ 20). Реализация — чистые функции в `@sf/core/stats` с тестами против табличных значений.
4. **Формулировки — модель, числа — код.** Рекомендация строится из значимых находок детерминированным шаблоном (фича, направление, эффект, n, confidence, предложенный контролируемый эксперимент); LLM только делает текст читаемым и **не имеет права** менять числа (проверка: все числа из шаблона присутствуют в тексте). `based_on` хранит находки и окно данных.
5. **Рынок и мы — два слоя находок.** `scope: own` — наши видео (фичи из скрипта/DNA/пакета, метрика — витрина); `scope: market` — конкурентские видео с DNA (фичи из DNA, метрика — `baselineRatio` сигнала на 24h). Рыночные находки помечаются как внешние и не смешиваются с нашими в статистике; в рекомендациях — как «на рынке наблюдается…».
6. **Эксперимент — контролируемый план, а не пост-фактум ярлык.** `experiment { hypothesis, feature, variants[] { label, featureValue }, targetPerVariant, controls[] (фичи, которые держим постоянными), outcome, status: planned | running | done | aborted }`. Привязка на уровне идеи (`idea.experiment_id`, `variant`) до генерации скрипта — E5 получает вариант как ограничение (например, `hookStrategy = result_first`); при публикации `own_video` наследует привязку. Отчёт по завершении — тот же статистический аппарат по видео эксперимента.
7. **Моментум тем — общая формула для Radar и своих данных.** По категории/теме: скользящая сумма моментума кластеров (E1) за 7 дней против предыдущих 7 (`marketMomentum`), медиана `baselineRatio24h` наших видео в категории за 30 дней против предыдущих 30 (`ownMomentum`). Хранится в `topic_momentum`, используется Inbox (веса категории) и рекомендациями.

## Изменения схемы БД (миграция `0008_experiments`)

| Таблица | Изменение |
|---|---|
| `own_video` | `experiment_features jsonb` — по схеме с провенансом; `+ experiment_id FK`, `+ experiment_variant text`, `+ features_computed_at` |
| `idea` | `+ experiment_id FK`, `+ experiment_variant text` |
| `experiment` | `+ feature text`, `+ variants jsonb`, `+ target_per_variant int`, `+ controls jsonb`, `+ outcome text`, `+ report jsonb`, `+ created_at`, `+ updated_at`; `status enum(planned, running, done, aborted)` |
| `experiment_finding` | новая: `id, run_id, scope enum(own, market), feature, kind enum(categorical, numeric), outcome, groups jsonb, statistic jsonb (p, q, effect, ci, n), confidence enum, window jsonb, created_at` |
| `experiment_run` | новая: `id, started_at, finished_at, videos_count, findings_count, params jsonb, status` |
| `experiment_recommendation` | `+ run_id FK`, `+ findings jsonb (ids)`, `+ status enum(new, accepted, dismissed, converted)`, `+ experiment_id FK nullable`, `+ template_key`, `+ model`, `+ cost_usd` |
| `topic_momentum` | новая: `id, category, subcategory nullable, window_end date, market_momentum real, own_momentum real, market_n int, own_n int` |
| `app_setting` | `experiments.outcomes`, `experiments.min_group_size`, `experiments.min_video_age_days`, `experiments.recompute_time`, `experiments.features_list` |

---

## Задачи

Суммарно ≈ 11–12 дней.

### E8-01. `@sf/core`: схема фич с провенансом и автозаполнение

**Сделать:**
- `ExperimentFeaturesSchema` — полный набор из blueprint §5.11 + поля из решения 1, каждое как `FeatureValue<T> { value, source, updatedAt }`.
- `buildFeatures({ script, dna, pkg, ownVideo, dubStrategy, voice, manualOverrides })` — детерминированный маппинг с приоритетами (`manual` > `dna` > `script` > `package` > `publish`); `durationBucket`, `publishDayOfWeek`, `publishHourLocal` (TZ оператора) считаются здесь.
- `featuresFromCompetitorDna(dna, video)` — для рыночного слоя (подмножество фич, доступных из DNA).
- Тесты: конфликты источников, отсутствие DNA, ручная правка переживает пересчёт.

**DoD:** тесты зелёные; список фич согласован с E5 `ExperimentTagsSchema`.
**Оценка:** 1 д. **Зависимости:** E5-01, E2-04.

### E8-02. `@sf/core/stats`

**Сделать:**
- `median`, `percentile`, `mannWhitneyU(a, b)` (с нормальной аппроксимацией и поправкой на связи), `cliffsDelta(a, b)`, `spearman(x, y)` + бутстрэп-CI, `benjaminiHochberg(pValues)`, `confidenceBand({ n, q, effect })`.
- Тесты против известных значений (наборы из учебников/R): точность p до 1e-3.
- `analyzeFeature(videos, feature, outcome, settings)` → `Finding | null` (недостаточно данных → `null` с причиной).

**DoD:** тесты зелёные; функции чистые, без зависимостей.
**Оценка:** 1.5 д. **Зависимости:** E0-05.

### E8-03. БД: миграция `0008_experiments`, репозитории

**Сделать:**
- Миграция по таблице; репозитории `experimentRepo`, `findingRepo`, `recommendationRepo`, `topicMomentumRepo`, `ownVideoRepo.updateFeatures`.
- Zod-валидация всех jsonb.

**DoD:** миграция применяется; тесты репозиториев.
**Оценка:** 0.5–1 д. **Зависимости:** E8-01.

### E8-04. Job `experiment.features` и ручная правка

**Сделать:**
- Триггеры: создание `own_video` (E6/E7), новая DNA `own_video` (E2), публикация метаданных (E11), правка дабов (E7/E9), ручная правка. Job пересчитывает `experiment_features` через `buildFeatures` с сохранением `manual`.
- `PATCH /experiments/videos/:id/features { field, value }` → `source: manual`.
- Backfill-команда для уже существующих видео.
- Тесты.

**DoD:** у каждого `own_video` заполнены фичи с провенансом; ручная правка сохраняется после пересчёта.
**Оценка:** 0.5–1 д. **Зависимости:** E8-03, E7-05.

### E8-05. Job `experiment.recompute`

**Сделать:**
- Cron ежедневно после `analytics.materialize`; `experiment_run` открывается/закрывается; выборка: свои видео возрастом ≥ `min_video_age_days` с витриной и фичами; рыночная выборка: `tracked_video` с DNA и сигналом на 24h за 90 дней.
- По каждой фиче из `experiments.features_list` × каждая целевая метрика: `analyzeFeature` → `experiment_finding`; BH-поправка по прогону; `scope` по решению 5.
- `topic_momentum` по решению 7.
- Идемпотентность: один run на дату; лог: видео / фич / находок по бендам.
- Интеграционный тест на синтетических данных с заложенным эффектом: находка `high` по нужной фиче, отсутствие ложных `high` на шуме.

**DoD:** прогон на реальных данных завершается, находки записаны; синтетический тест зелёный.
**Оценка:** 1.5 д. **Зависимости:** E8-02, E8-04.

### E8-06. Рекомендации

**Сделать:**
- Шаблоны по типам находок (категориальная своя / числовая своя / рыночная / моментум темы) → черновик с числами; LLM (промпт `experiments.recommendation/1.0.0`) — читаемая формулировка, проверка сохранности чисел (решение 4).
- Отбор: только `medium`/`high`; не более `experiments.max_recommendations_per_run` (5); дедупликация с ещё активными рекомендациями (та же фича + направление → обновить `based_on`, не плодить).
- Предложение эксперимента внутри рекомендации: фича, варианты, `targetPerVariant` (по формуле от размера эффекта, минимум 5/5), контролируемые фичи.
- Действия: `accept` (→ создать эксперимент, `converted`), `dismiss` (с причиной).
- Тесты шаблонов и дедупликации.

**DoD:** после прогона на ≥ 20 видео появляются рекомендации с confidence и предложением эксперимента; числа совпадают с находками.
**Оценка:** 1 д. **Зависимости:** E8-05, E1-07.

### E8-07. Планировщик экспериментов

**Сделать:**
- CRUD эксперимента (решение 6); привязка идей: `POST /experiments/:id/assign { ideaId, variant }` (до генерации скрипта); E5 при генерации читает `idea.experiment_variant` и добавляет ограничение в промпт (`script.master` получает `constraints`), тег фиксируется.
- Прогресс: сколько видео на вариант опубликовано и дозрело; автопереход `planned → running` при первой публикации, `→ done` по достижении `targetPerVariant` во всех вариантах и дозревании.
- Отчёт (`report jsonb`): тот же `analyzeFeature` только по видео эксперимента + таблица вариантов (медианы, n, эффект, p, confidence) + текст-вывод (LLM, с проверкой чисел).
- Тесты переходов и отчёта на синтетике.

**DoD:** эксперимент «5/5 result_first vs context_first» заводится, идеи привязываются, отчёт формируется по завершении.
**Оценка:** 1.5 д. **Зависимости:** E8-06, E5-04 (ограничение в промпте).

### E8-08. API и контракты Experiments

**Сделать:**
- `GET /experiments/recommendations` (status), `POST /experiments/recommendations/:id/accept|dismiss`, `GET /experiments/findings` (scope, feature, confidence, run), `GET /experiments/runs`, CRUD `/experiments`, `GET /experiments/:id/report`, `GET /experiments/momentum`, фичи видео (E8-04).
- Контракты `@sf/contracts/experiments/*`, клиент, тесты.

**DoD:** OpenAPI; тесты зелёные.
**Оценка:** 0.5–1 д. **Зависимости:** E8-07.

### E8-09. UI Experiments

**Сделать:**
- `/experiments`: лента рекомендаций (текст, confidence-бейдж, находки-основания разворачиваются, кнопки «Принять → эксперимент» / «Отклонить»), активные эксперименты с прогрессом по вариантам, история выводов.
- `/experiments/findings`: таблица находок с фильтрами (scope, фича, confidence), мини-график распределения групп (Recharts, box/strip).
- `/experiments/[id]`: план, привязанные идеи/видео по вариантам, прогресс, отчёт с таблицей и выводом.
- `/experiments/momentum`: категории с рыночным и собственным моментумом.
- На странице видео (E7-08): блок фич с провенансом и инлайн-правкой; бейдж эксперимента/варианта.
- В Inbox (E3-07): подсказка «подходит под эксперимент X, вариант Y» для карточек с совпадающей категорией — кнопка привязать при approve.

**DoD:** сценарий «рекомендация → принять → эксперимент → привязать 10 идей → отчёт» проходит на тестовых данных.
**Оценка:** 2 д. **Зависимости:** E8-08.

### E8-10. Валидация на реальных данных, ADR

**Сделать:**
- После ≥ 20 опубликованных видео с фичами: прогон, ручная проверка правдоподобия находок; проверка на ложные срабатывания перестановочным тестом (перемешать outcome → не должно быть `high`).
- Тюнинг `min_group_size`, бендов, списка фич.
- ADR по решениям 1–7; обновление System Design §4/§5.

**DoD:** перестановочный тест не даёт `high`; ≥ 1 содержательная рекомендация принята в реальный эксперимент.
**Оценка:** 1 д. **Зависимости:** E8-09, накопленные данные.

---

## Порядок

```text
E8-01 ─► E8-03 ─► E8-04 ─► E8-05 ─► E8-06 ─► E8-07 ─► E8-08 ─► E8-09 ─► E8-10
E8-02 ──────────────────────┘
```

## Вне скоупа E8

- Причинный вывод, байесовские модели, uplift — нет; только описательная статистика с честными оговорками.
- Автоматическое изменение весов Inbox по находкам — рекомендация может это предложить, применяет оператор.
- Мультиармед-бандиты для выбора хука — нет.

## Приёмка

| AC | Как проверяем | Статус |
|---|---|---|
| Каждый Short имеет фичи | 0 `own_video` без `experiment_features` | ⬜ |
| Рекомендации с confidence после 20–30 видео | ≥ 1 `medium+` рекомендация, числа сверены с находками | ⬜ |
| Эксперимент: завести, привязать, сравнить | E8-07 DoD на реальном эксперименте | ⬜ |
