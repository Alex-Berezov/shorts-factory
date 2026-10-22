# ADR-0015: модуль роутов получает `RouteRegistrar`, а не экземпляр Fastify

Дата: 2026-10-22   Статус: принято   Задача: E0-12P (решения техлида Р-1 A, Р-2 A, Р-3 A, Б1-Б3 и В1-В4 ревью, 22.10.2026; Р7/Р9 E0-12D, `docs/DECISIONS.md`, 19.10.2026)

## Контекст

С E0-12D роут модуля `apps/api/src/routes/**` регистрируется только `defineRoute`: помощник
кладёт `responses` в `schema.response` и выводит тип ответа хендлера из той же схемы. Но модуль
получал весь `AppInstance`, и регистрацию мимо помощника держало построчное правило S13
(`.claude/hooks/rules.sf.json`): регулярка по `.get(`/`.route(`/`withTypeProvider`. Оно ловило
`repo.get(` и `map.delete(` (ложный отказ), не видело `app["get"](`, `const { get } = app`,
`register`/`addHook`/`decorate`/`set*` на экземпляре, а модуль `src/lib/*.ts`, принявший
экземпляр, регистрировал роут с ручным `Reply` вне его масок. Хук роута `onSend`/
`preSerialization` мог переписать тело конверта после сериализатора. Сам помощник
импортировал тип `AppInstance` из `app.ts` - слой `lib` зависел от приложения.

## Решение

- **`AppInstance` - в `apps/api/src/lib/app-instance.ts`.** Единственное объявление;
  `app.ts`, `compose-app.ts`, `define-route.ts` и тесты импортируют отсюда, реэкспорта из
  `app.ts` нет. `lib` больше не импортирует `app.ts`.
- **Помощник - `apps/api/src/lib/define-route.ts`** (был `route-schemas.ts`, имя - по образцу
  `apps/worker/src/lib/define-job.ts`).
- **`RouteRegistrar` - непрозрачный токен.** Тип - интерфейс с одним брендом на `unique symbol`,
  без единого ключа экземпляра: нет `get`/`post`/`put`/`patch`/`delete`/`head`/`options`/`all`,
  `route`, `withTypeProvider`, `register`, `addHook`, `decorate`, `setErrorHandler`,
  `setSerializerCompiler`, `setValidatorCompiler`, `setSchemaErrorFormatter`. Значение -
  `Object.freeze({})`; экземпляр за ним лежит в модульном `WeakMap` `define-route.ts`, который
  не экспортируется. Единственный конструктор - `routeRegistrar(instance)`.
- **`defineRoute(registrar, definition, handler)`** достаёт экземпляр через `WeakMap.get` и
  регистрирует роут на нём; на объекте, которого `routeRegistrar` не делал (копия спредом,
  подделка), бросает `Error` до регистрации.
- **Подключение.** `app.ts` регистрирует дочерний контекст после плагинов (так `@fastify/swagger`
  видит роуты) и передаёт `registerRoutes(routeRegistrar(instance), deps)`. Сигнатура модуля -
  `registerRoutes(registrar: RouteRegistrar, deps: AppDeps)`.
- **Хуки и плагины без экземпляра.** Хук роута (`onRequest`, `preHandler`, `onError`,
  `onResponse` и прочие) - опция в определении `defineRoute`. `onSend` и `preSerialization`
  получают тело и могут вернуть другое - они запрещены в определении наравне с опциями
  приложения (`errorHandler`, компиляторы, `schemaErrorFormatter`, `attachValidation`): `Omit`
  в типе и бросок в рантайме на пришедшее спредом или приведением; запрещённые ключи и причина
  каждого - одна таблица `REFUSED_OPTIONS`. Заголовки ответа - декларативная опция `replyHeaders`
  (раздел «Заголовки ответа» ниже). Плагины и хуки уровня приложения живут в
  `apps/api/src/plugins/**` и `app.ts`.
- **S13 снят.** Регистрацию мимо помощника держит тип: каждая форма, которую ловила проба S13,
  и формы, которых она не видела, стоят под `@ts-expect-error` в
  `apps/api/test/define-route.test.ts` и краснеют, если регистратор снова отдаёт экземпляр;
  рантайм-кейсы там же - у регистратора нет ключей экземпляра, каждый обход бросает
  `TypeError` и ничего не регистрирует, а на приманке (`Proxy` с любым методом) тянется ровно к
  методу, который называет (текст `TypeError` движка не сверяется). Проба пропуска в
  `harness-selftest.js`: модуль роута с `repo.get(`, `map.delete(`, `searchParams.get(`,
  `this` в строке, `deps.config.server` и `defineRoute` не отказывается ни одним правилом
  standards. S14 (`defineRoute` без
  `...errorResponses()`) остаётся правилом до E0-12V.

## Кто держит регистрацию мимо `defineRoute`

- **`apps/api/src/routes/**` - тип.** Модуль получает `RouteRegistrar`, у которого нет ни одного
  метода экземпляра.
- **Любой другой регистрант - тест `apps/api/test/route-shape.test.ts`.** Функция `src/lib`,
  плагин или `app.ts`, которым передан `AppInstance`, по типу может зарегистрировать роут с
  ручным `Reply` и верной `schema.response` - тип этого не видит. `defineRoute` кладёт `config`
  каждого своего роута в неэкспортируемый `WeakSet` модуля; спросить можно только
  `isDefinedRoute(config)` (принимает `unknown`). Подделать нечем: ключа-метки нет, копия
  `config` - другой объект. Оговорка: хук `onRoute` плагина на корне видит `routeOptions.config`
  роута `defineRoute` и мог бы передать ту же ссылку своему роуту; в `app.ts` таких хуков нет,
  а роут корня мимо помощника держит `route-shape.test.ts`. `route-shape.test.ts` отказывает
  роуту, о котором `isDefinedRoute` говорит «нет»: «not defined through defineRoute».
- **Корень приложения виден.** `buildApp` - композиция двух шагов `app.ts`:
  `createInstance(options)` (экземпляр с опциями сервиса, ничего не зарегистрировано) и
  `assembleApp(app, deps, options)` (всё остальное). Тест вешает `onRoute` между ними, поэтому
  видит и роуты, которые приложение ставит прямо на корень (Fastify зовёт `onRoute` синхронно в
  `route()`), и роуты дочерних контекстов. Посадка - `app.get<{ Reply }>` прямо на корне после
  `assembleApp` (как вызов из `buildApp` рядом с `registerOpenapi(app)`) и
  `registerFromLib(app: AppInstance)` в дочернем контексте - оба красные.
- **Исключение - документация, вычисленным множеством.** Роуты плагинов документации (`/docs`,
  `/openapi.json` и их HEAD) тест не проверяет; их перечень он измеряет сам
  (`documentationRoutes()` - пустой экземпляр с одним `registerOpenapi`), а не пишет руками.
  `OPENAPI_ROUTE` (`plugins/openapi.ts`, `app.get` на корне) - единственный роут корня, которого
  `isDefinedRoute` не знает, и он в этом множестве; это держит отдельный кейс.
- **Экземпляр из хендлера и хука роута.** `request.server`, `reply.server` и `this` в хендлере и
  хуке роута - весь экземпляр, по типу без приведения. Замерено под `inject` после `ready`
  (кейсы `apps/api/test/instance-after-ready.test.ts`, сверка по `code` и по отсутствию следа на
  том контексте, которому звонили, - дочернем, где зарегистрирован роут: роута `/late` нет - 404,
  хук не вызывается и на повторном запросе, у дочернего контекста нет декорации; тот же вызов до
  старта след оставляет - кейс краснеет):

  | Форма на `request.server` | Исход |
  | --- | --- |
  | `route`, `get` | `FST_ERR_INSTANCE_ALREADY_LISTENING` |
  | `addHook` | `FST_ERR_INSTANCE_ALREADY_LISTENING` |
  | `register` | `AVV_ERR_ROOT_PLG_BOOTED` (avvio) |
  | `decorate` | `FST_ERR_DEC_AFTER_START` |
  | `setErrorHandler`, `setValidatorCompiler`, `setSerializerCompiler`, `setSchemaErrorFormatter` | `FST_ERR_INSTANCE_ALREADY_LISTENING` |

  Все девять форм рантайм отклоняет после старта; формы без броска замер не нашёл. Не замерены
  и ничем не держатся `close()` и `inject()` из хендлера (`close()` гасит сервис без броска), а
  также `setNotFoundHandler`, `addContentTypeParser`, `decorateRequest`/`decorateReply`,
  `addSchema` - долг `docs/TECH_DEBT.md`, открыто -> E0-12V.
- **Имена в модулях роутов - тест на гейте `test`.** `apps/api/test/route-modules.test.ts`
  разбирает по AST (`apps/api/test/source-ast.ts`) каждый исходник `apps/api/src/routes/**`
  (`.ts`, `.mts`, `.cts`, `.tsx`) на любой глубине и отказывает на любой `this` и на слово
  `server` в любой позиции: как имя (свойство, и `?.`, и на новой строке; binding, в том числе
  элемент массива; shorthand и присваивание деструктуризацией `({ server: s } = request)`;
  объявление `const server = …`; ключ литерала; `#server`) и как строковый литерал или шаблон
  без подстановок (`request["server"]`, `Reflect.get(request, "server")`,
  `const { ["server"]: s } = request`) - без исключений и для `deps.*`; `this` в строке, `server`
  в комментарии и внутри более длинной строки или имени (`serverless`) - не слово. Остаток, которого
  разбор не видит: ключ, вычисленный в рантайме, - `request[key]`, `Object.values(request)`,
  `Object.entries(request)`, `for … in`; request, переданный функции из src/lib, которая читает
  .server, разбор не видит. Регистрацию, хуки, декорации и компиляторы, дошедшие так до
  экземпляра, держит старт приложения (таблица выше) и `isDefinedRoute` в
  `route-shape.test.ts`; `close()`/`inject()` из хендлера не держит ничто (долг выше).
  Построчное правило S17 (`\.server\b|\bthis\s*\.`), которым это держалось в круге fix 1, снято
  (В1): оно не видело `const self = this`, `.call(this)`, `request["server"]`, `.server` на
  новой строке и ложно отказывало на `this` в строке и на `deps.config.server`. Номера S13 и
  S17 не переиспользуются.

## Заголовки ответа

- `replyHeaders` - декларативная опция определения: `defineRoute` ставит заголовки собственным
  `onSend` роута и отдаёт `payload` нетронутым. Они есть на ответах, прошедших `onSend` роута:
  обработчика, его хуков (503 закрытия у `/health`), обработчика ошибок приложения и - замер в
  `apps/api/test/instance-after-ready.test.ts` - обработчика Fastify по умолчанию, когда обработчик
  приложения сам бросает (500 `FST_ERR_FAILED_ERROR_SERIALIZATION`, `cache-control: no-store` на
  месте); бросающий обработчик ошибок контекста отдаёт ошибку обработчику приложения - заголовок
  тоже на месте. Ответов, ушедших до выбора роута (404 неизвестного url, отказ роутера), этот
  хук не видит. Второго места установки заголовка нет.
- Разрешённое - таблица `REPLY_HEADERS` в `define-route.ts`, имя -> значения:

  | Имя | Значения |
  | --- | --- |
  | `cache-control` | `no-store` |

  Тип опции выводится из таблицы (значение - литерал из перечня своего имени). Имя или значение
  вне таблицы (спредом, приведением, `Cache-Control` с заглавной, `undefined`, перевод строки,
  `public, max-age=…`, пустая строка) - бросок до регистрации, одно сообщение на имя и на
  значение. Никогда не входят: `content-type`, `content-length`, `content-encoding`,
  `transfer-encoding` (описывают тело, которое написал сериализатор), `set-cookie` и
  `x-request-id` (`REQUEST_ID_HEADER`) - заголовки приложения: поставленные роутом последними, они
  перекрыли бы его значения на тех самых ответах, где идёт конверт ошибки. `public`/`max-age`
  положили бы ответ за basic auth в общий кэш; перевод строки роняет каждый ответ роута в Node.
- Опция не задана или пуста - свой `onSend` не ставится. Заголовки читаются при регистрации один
  раз: проверяется и уходит в `onSend` один и тот же снимок, так что ни правка объекта после
  `defineRoute`, ни геттер или `Proxy`, отдающие на втором чтении другое значение, ответ не меняют.
- Запрет выше - про опцию `replyHeaders`: «не компилируется и бросает» только там.
  `reply.header`/`removeHeader`/`type`/`serializer` из хендлера и разрешённых хуков роута
  (`onRequest`, `preValidation`, `preHandler`, `onError`) открыты - держит ревью, долг
  `docs/TECH_DEBT.md`, открыто -> E0-12V; рантайм-обёртки `reply` нет.
- Новое имя или значение в таблице и динамические заголовки - только новым ADR.

## Альтернативы

- Брендированный тип над тем же экземпляром (`instance as RouteRegistrar`) - проще, но
  приведение в любом файле возвращает всю поверхность экземпляра, и класс «регистрация из
  `src/lib/*.ts`» закрыт только типом, без рантайма (Р-1 B).
- Оставить `onSend`, обернув его хуком `(request, reply) => void` без `payload` - гибче
  (динамические заголовки), но имя хука Fastify с чужой сигнатурой путает (Р-2 B).
- Оставить S13 и расширять регулярку - ложные отказы на `Map`/`URLSearchParams` и слепота к
  скобкам и деструктуризации остаются свойствами построчного правила.
- Перевести S14 в тип (`Responses` требует `4xx`/`5xx` типа `typeof ErrorBodySchema`) в этой же
  задаче - пересекается с E0-12V, отложено туда (Р-3 A).

## Последствия

- Модуль роутов не может ни зарегистрировать роут мимо `defineRoute`, ни подключить плагин,
  хук уровня контекста или декорацию через регистратор: этого нет ни в типе, ни в рантайме
  регистратора. Путь к экземпляру через `request.server`/`reply.server`/`this` по типу открыт;
  его держат разбор по AST в `route-modules.test.ts` и старт приложения (замер выше), а роут,
  которого `isDefinedRoute` не знает, откуда бы он ни пришёл - модуль, `src/lib`, плагин, корень
  в `app.ts`, - не пройдёт `route-shape.test.ts`, кроме роутов документации.
- `buildApp` - композиция `createInstance` и `assembleApp`; `server.ts` и `compose-app.ts` зовут
  `buildApp` как прежде, шаги по отдельности нужны тесту формы роутов.
- Расширение регистратора (хук на группу роутов, плагин модуля, если понадобится в E1+) и
  расширение `replyHeaders` (новое имя или значение в `REPLY_HEADERS`, динамические заголовки) -
  только новым ADR.
- Тест, регистрирующий роут через `defineRoute`, оборачивает контекст `routeRegistrar(child)`;
  тестовые роуты вне `src/routes` (`test/error-routes.ts`) по-прежнему пишутся на экземпляре.
- `defineRoute` и `routeRegistrar` должны импортироваться из одного модуля
  (`src/lib/define-route.js`): вторая копия модуля - второй `WeakMap`, и регистратор одной
  копии будет «чужим» для другой.
