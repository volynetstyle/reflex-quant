# Reflex Quant: анатомия реактивной машины

Глубокое архитектурное исследование · 10 ноября 2026 · [Версия 1.1.2, commit a2b0a52](https://github.com/volynetstyle/reflex-quant/tree/a2b0a52e9e09918d617ae27d1b02ae0ff729c07b?utm_source=chatgpt.com)

# Сложность, которую удалось не создавать

От семантических инвариантов Reflex к компактной машине исполнения, где граф зависимостей, распространение изменений, валидация и динамический трекинг оказываются частями одного механизма.

В реактивном программировании существует почти незаметная архитектурная ловушка. Сначала мы хотим, чтобы выражение автоматически пересчитывалось при изменении его зависимостей. Затем обнаруживаем, что зависимости могут меняться, вычисления могут бросать исключения, наблюдатели могут уничтожать себя, обновления могут происходить во время исполнения, а граф может содержать тысячи узлов.

И для каждого обнаруженного случая возникает соблазн добавить ещё одно состояние, ещё один индекс, ещё одну очередь, ещё одну фазу обработки.

Постепенно библиотека перестаёт быть реализацией простой идеи. Она становится системой управления последствиями собственных предыдущих решений.

Reflex Quant исследует обратное направление: какое минимальное количество механизмов действительно необходимо, если сначала зафиксировать семантику, а потом вывести из неё реализацию?

Это важнее, чем просто написать быструю библиотеку сигналов.

Quant пытается отделить сложность самой задачи от сложности конкретного способа её решения.

И любопытнее всего то, что удаление механизмов здесь не обязательно сопровождается потерей выразительности. В некоторых местах оно позволяет сохранить довольно сложное поведение, которое было бы значительно труднее реализовать набором независимых подсистем.

АРХИТЕКТУРНАЯ ФОРМУЛА

Концептуальная схема. Четыре аспекта не исчезают, но используют общие факты графа, контекст и рабочую память.

Главная идея Quant не в том, чтобы сделать все алгоритмы одинаковыми. Это было бы не минимализмом, а насилием над абстракциями. Смысл в другом: если два алгоритма требуют одних и тех же сведений, возможно, эти сведения не нужно постоянно хранить в двух местах.

Поэтому архитектура особенно интересна в местах, где один инвариант позволяет уничтожить целый класс дополнительного состояния.

## I. Что именно представляет собой Quant

Production ESM

# ≈2.28 KB

gzip, по отчёту сборки 1.1.2

Публичные операции

# 10

Без runtime-обёрток для handles

Production Node / Edge

# 9 / 8

Полей в двух типах графовых объектов

Эти цифры показывают масштаб реализации, но почти ничего не говорят о её сложности.

Библиотеку можно сделать маленькой, просто отказавшись от обработки неприятных случаев. Можно убрать поддержку динамических зависимостей, восстановление после исключений, корректное уничтожение узлов. Получится замечательная миниатюра, которая перестанет работать именно тогда, когда программа перестанет быть миниатюрной.

Quant делает более трудную вещь: удерживает достаточно строгий контракт и уменьшает количество внутренних механизмов, необходимых для его исполнения.

### Три операционных слоя

Kernel реализует реактивную причинность: что от чего зависит, какой источник изменился, кому необходимо проверить актуальность, когда можно признать результат вычисления действительным.

Host отвечает за доставку работы наблюдателям: очередь, batching, cleanup, порядок повторного исполнения. Он не решает, существует ли зависимость. Эту истину определяет ядро.

Surface предоставляет TypeScript API. Характерная деталь: публичный handle является самим `Node`, только с типовой маркировкой. Обёртка не создаётся.

Это не просто разделение файлов.

Представим, что Quant используется внутри UI-фреймворка. Фреймворк может захотеть привязать эффекты к компонентам, выполнять DOM-операции в другой фазе или управлять асинхронными ресурсами. Эти решения не обязаны становиться внутренними правилами графа.

Таким образом, Quant не пытается заранее решить все проблемы приложения. Он сохраняет достаточно чистое основание, чтобы другие системы могли решать собственные проблемы сверху.

В этом смысле отсутствие части функций у Quant является сознательной архитектурной границей, а не обязательно недоработкой.

Основание: [ARCHITECTURE.md](https://github.com/volynetstyle/reflex-quant/blob/a2b0a52/ARCHITECTURE.md?utm_source=chatgpt.com), [src/](https://github.com/volynetstyle/reflex-quant/tree/a2b0a52/src?utm_source=chatgpt.com).

## II. Граф, который одновременно хранит два разных порядка

В основе находятся только два вида объектов: `Node` и `Edge`.

Сигнал, вычисляемое значение и наблюдатель используют одну форму узла. Их различают функция вычисления и флаги.

Ребро же принадлежит одновременно двум двусвязным спискам.

Одно ребро, два представления графа

Разные логические проекции одних и тех же `Edge`: consumer → его источники и source → его подписчики.

Зачем два порядка?

Потому что у этих списков разные задачи.

Порядок зависимостей потребителя нужен для трекинга и валидации. Порядок подписчиков источника нужен для распространения invalidation и предсказуемой очередности доставки.

Одно ребро содержит:

```
interface Edge {
  readonly from: Node;
  readonly to: Node;

  ver: number;
  gen: number;

  prev: Edge | null;
  next: Edge | null;

  prevSub: Edge | null;
  nextSub: Edge | null;
}
```

Именно отсюда возникает первое архитектурное соединение:

Изменение зависимости, проверка версии и восстановление после исключения работают с одним и тем же объектом, но используют разные сведения о нём.

`from` и `to` определяют отношение. `prev/next` и `prevSub/nextSub` определяют его положение в двух направлениях. `ver` сообщает, какую версию источника видел потребитель. `gen` позволяет отличить ранее подтверждённое отношение от возникшего в неуспешной попытке вычисления.

Вместо того чтобы отдельно вести граф, историю чтений, таблицу инвалидированных узлов и журнал неудачных исполнений, Quant помещает часть этих фактов непосредственно в отношения.

Это не бесплатно. Восемь полей на одно ребро не выглядят рекордом компактности.

Но минимальность здесь измеряется не размером отдельного объекта. Она измеряется тем, сколько независимых структур приходится поддерживать и синхронизировать.

### Почему единая форма Node важна для V8

Текущий `Node` содержит девять полей:

| Поле      | Что оно хранит                                                   |
| --------- | ---------------------------------------------------------------- |
| `flags`   | Состояние узла и политика наблюдателя                            |
| `value`   | Последнее зафиксированное значение или cleanup                   |
| `ver`     | Версию результата                                                |
| `fn`      | Функцию computed/effect, `null` у сигнала или уничтоженного узла |
| `deps`    | Список источников                                                |
| `subs`    | Список подписчиков                                               |
| `lastSub` | Хвост списка подписчиков                                         |
| `slot`    | Временную ячейку точного поиска отношений                        |
| `gen`     | Поколение успешного исполнения                                   |

Отсутствует даже специальный класс `SignalNode` с оптимизированным layout. Каждый узел создаётся через один конструктор-литерал `node()`.

Это полезно для стабильности форм объектов в JavaScript-движке. Однако тут надо различать два понятия: единый hidden class может уменьшать полиморфизм доступа, но не делает автоматически быстрее все операции и не гарантирует конкретную физическую раскладку памяти.

Числовые версии и поколения ограничены маской `0x3fffffff`, чтобы оставаться в диапазоне Smi. Модуль старается избегать неожиданных переходов представления чисел.

Довольно характерная особенность Quant: там, где высокоуровневая библиотека может надеяться на оптимизатор, этот runtime пытается предоставить оптимизатору предсказуемую структуру. Не обещая, что V8 обязательно исполнит наши пожелания.

## III. Трекинг: как помнить точные зависимости, ничего не записывая заново

Это один из наиболее содержательных механизмов во всей системе.

Рассмотрим простое вычисление:

```
const full = signal(false);
const first = signal("Ada");
const last = signal("Lovelace");

const name = computed(() =>
  get(full)
    ? `${get(first)} ${get(last)}`
    : get(first)
);
```

Математически это функция от трёх переменных. Реактивно же она зависит не от всех переменных, упомянутых в её исходном коде.

Она зависит от того, какие значения были действительно прочитаны во время последнего успешного исполнения.

Интерактивный граф зависимости `name`

full = falsefull = true

Активны только full → name и first → name. Изменение last не запускает пересчёт.

Здесь точность зависимостей превращается в вычислительную экономию. Изменение `last`, пока ветка выключена, не должно даже будить `name`.

Но возникает более сложный случай.

Что если порядок чтений изменился, а набор источников остался прежним?

Перестановка 256 зависимостей

Quant

## 0 / 0

Созданных / удалённых рёбер за шаг

Alien Signals 3.2.1

## 255 / 255

Созданных / удалённых связей за шаг

Структурные счётчики для `reorder.rotate-256`, зафиксированные в исследовательском отчёте Quant. Сравниваются именно операции с отношениями, не объём памяти в байтах.

Это принципиальное различие.

Для реализации, которая удаляет и создаёт отношения при изменении порядка чтений, перестановка означает мутацию графа.

Для Quant это преимущественно перемещение существующих рёбер в списке потребителя.

И теперь можно понять, почему его трекинг выглядит сложнее, чем элементарный `Set` зависимостей.

### Горячий путь: курсор, который предсказывает следующий read

`active` указывает на исполняемый потребитель. `cursor` указывает на последнее принятое ребро.

При чтении источника `s` достаточно проверить, является ли следующим ребром отношение к `s`.

Упрощённая форма:

```
const last = cursor;
const next = last === null
  ? consumer.deps
  : last.next;

if (next !== null && next.from === source) {
  cursor = next;
  next.ver = source.ver;
} else {
  miss(consumer, source, last, next);
}
```

При неизменном порядке чтений никаких поисков не происходит. Ни хеширования, ни создания новых `Edge`, ни полного прохода зависимостей.

Цена стабильного отслеживаемого чтения включает сравнение следующего источника и обновление курсора и наблюдённой версии. Само чтение значения и проверка необходимости `pull` остаются обязательными.

А вот `miss()` начинается только при нарушении ожидаемого порядка.

### Три способа доказать, что отношение уже существует

Можно представить `miss()` как небольшой движок доказательств. Он пытается установить точный факт: существует ли уже ребро между данным источником и данным потребителем?

Причём доказательства упорядочены по стоимости.

\#chatgpt-mermaid-\_r_13c\_{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;fill:rgb(255, 255, 255);}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#chatgpt-mermaid-\_r_13c\_ .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_13c\_ .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_13c\_ .error-icon{fill:rgba(255, 255, 255, 0.067);}#chatgpt-mermaid-\_r_13c\_ .error-text{fill:rgb(255, 255, 255);stroke:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_13c\_ .edge-thickness-normal{stroke-width:1px;}#chatgpt-mermaid-\_r_13c\_ .edge-thickness-thick{stroke-width:3.5px;}#chatgpt-mermaid-\_r_13c\_ .edge-pattern-solid{stroke-dasharray:0;}#chatgpt-mermaid-\_r_13c\_ .edge-thickness-invisible{stroke-width:0;fill:none;}#chatgpt-mermaid-\_r_13c\_ .edge-pattern-dashed{stroke-dasharray:3;}#chatgpt-mermaid-\_r_13c\_ .edge-pattern-dotted{stroke-dasharray:2;}#chatgpt-mermaid-\_r_13c\_ .marker{fill:rgba(255, 255, 255, 0.72);stroke:rgba(255, 255, 255, 0.72);}#chatgpt-mermaid-\_r_13c\_ .marker.cross{stroke:rgba(255, 255, 255, 0.72);}#chatgpt-mermaid-\_r_13c\_ svg{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;}#chatgpt-mermaid-\_r_13c\_ p{margin:0;}#chatgpt-mermaid-\_r_13c\_ .label{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";color:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_13c\_ .cluster-label text{fill:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_13c\_ .cluster-label span{color:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_13c\_ .cluster-label span p{background-color:transparent;}#chatgpt-mermaid-\_r_13c\_ .label text,#chatgpt-mermaid-\_r_13c\_ span{fill:rgb(255, 255, 255);color:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_13c\_ .node rect,#chatgpt-mermaid-\_r_13c\_ .node circle,#chatgpt-mermaid-\_r_13c\_ .node ellipse,#chatgpt-mermaid-\_r_13c\_ .node polygon,#chatgpt-mermaid-\_r_13c\_ .node path{fill:rgb(99, 57, 0);stroke:rgb(255, 218, 166);stroke-width:1px;}#chatgpt-mermaid-\_r_13c\_ .rough-node .label text,#chatgpt-mermaid-\_r_13c\_ .node .label text,#chatgpt-mermaid-\_r_13c\_ .image-shape .label,#chatgpt-mermaid-\_r_13c\_ .icon-shape .label{text-anchor:middle;}#chatgpt-mermaid-\_r_13c\_ .node .katex path{fill:#000;stroke:#000;stroke-width:1px;}#chatgpt-mermaid-\_r_13c\_ .rough-node .label,#chatgpt-mermaid-\_r_13c\_ .node .label,#chatgpt-mermaid-\_r_13c\_ .image-shape .label,#chatgpt-mermaid-\_r_13c\_ .icon-shape .label{text-align:center;}#chatgpt-mermaid-\_r_13c\_ .node.clickable{cursor:pointer;}#chatgpt-mermaid-\_r_13c\_ .root .anchor path{fill:rgba(255, 255, 255, 0.72)!important;stroke-width:0;stroke:rgba(255, 255, 255, 0.72);}#chatgpt-mermaid-\_r_13c\_ .arrowheadPath{fill:rgba(255, 255, 255, 0.72);}#chatgpt-mermaid-\_r_13c\_ .edgePath .path{stroke:rgba(255, 255, 255, 0.72);stroke-width:1px;}#chatgpt-mermaid-\_r_13c\_ .flowchart-link{stroke:rgba(255, 255, 255, 0.72);fill:none;}#chatgpt-mermaid-\_r_13c\_ .edgeLabel{background-color:rgb(2, 3, 4);text-align:center;}#chatgpt-mermaid-\_r_13c\_ .edgeLabel p{background-color:rgb(2, 3, 4);}#chatgpt-mermaid-\_r_13c\_ .edgeLabel rect{opacity:0.5;background-color:rgb(2, 3, 4);fill:rgb(2, 3, 4);}#chatgpt-mermaid-\_r_13c\_ .labelBkg{background-color:rgba(2, 3, 4, 0.5);}#chatgpt-mermaid-\_r_13c\_ .cluster rect{fill:rgba(255, 255, 255, 0.067);stroke:rgba(255, 255, 255, 0.153);stroke-width:1px;}#chatgpt-mermaid-\_r_13c\_ .cluster text{fill:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_13c\_ .cluster span{color:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_13c\_ div.mermaidTooltip{position:absolute;text-align:center;max-width:200px;padding:2px;font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:12px;background:rgba(255, 255, 255, 0.067);border:1px solid rgba(255, 255, 255, 0.153);border-radius:2px;pointer-events:none;z-index:100;}#chatgpt-mermaid-\_r_13c\_ .flowchartTitleText{text-anchor:middle;font-size:18px;fill:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_13c\_ rect.text{fill:none;stroke-width:0;}#chatgpt-mermaid-\_r_13c\_ .icon-shape,#chatgpt-mermaid-\_r_13c\_ .image-shape{background-color:rgb(2, 3, 4);text-align:center;}#chatgpt-mermaid-\_r_13c\_ .icon-shape p,#chatgpt-mermaid-\_r_13c\_ .image-shape p{background-color:rgb(2, 3, 4);padding:2px;}#chatgpt-mermaid-\_r_13c\_ .icon-shape .label rect,#chatgpt-mermaid-\_r_13c\_ .image-shape .label rect{opacity:0.5;background-color:rgb(2, 3, 4);fill:rgb(2, 3, 4);}#chatgpt-mermaid-\_r_13c\_ .label-icon{display:inline-block;height:1em;overflow:visible;vertical-align:-0.125em;}#chatgpt-mermaid-\_r_13c\_ .node .label-icon path{fill:currentColor;stroke:revert;stroke-width:revert;}#chatgpt-mermaid-\_r_13c\_ .node .neo-node{stroke:rgb(255, 218, 166);}#chatgpt-mermaid-\_r_13c\_ [data-look="neo"].node rect,#chatgpt-mermaid-\_r_13c\_ [data-look="neo"].cluster rect,#chatgpt-mermaid-\_r_13c\_ [data-look="neo"].node polygon{stroke:url(#chatgpt-mermaid-\_r_13c\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_13c\_ [data-look="neo"].swimlane.cluster rect{filter:none;}#chatgpt-mermaid-\_r_13c\_ [data-look="neo"].node path{stroke:url(#chatgpt-mermaid-\_r_13c\_-gradient);stroke-width:1px;}#chatgpt-mermaid-\_r_13c\_ [data-look="neo"].node .outer-path{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_13c\_ [data-look="neo"].node .neo-line path{stroke:rgb(255, 218, 166);filter:none;}#chatgpt-mermaid-\_r_13c\_ [data-look="neo"].node circle{stroke:url(#chatgpt-mermaid-\_r_13c\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_13c\_ [data-look="neo"].node circle .state-start{fill:#000000;}#chatgpt-mermaid-\_r_13c\_ [data-look="neo"].icon-shape .icon{fill:url(#chatgpt-mermaid-\_r_13c\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_13c\_ [data-look="neo"].icon-shape .icon-neo path{stroke:url(#chatgpt-mermaid-\_r_13c\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_13c\_ .node text{font-size:14px;font-weight:600;letter-spacing:normal;fill:rgb(255, 218, 166);}#chatgpt-mermaid-\_r_13c\_ .edgeLabels text{font-size:13px;font-weight:600;letter-spacing:-0.08px;fill:rgb(255, 218, 166);}#chatgpt-mermaid-\_r_13c\_ .node tspan[font-weight="normal"],#chatgpt-mermaid-\_r_13c\_ .edgeLabels tspan[font-weight="normal"]{font-weight:600;}#chatgpt-mermaid-\_r_13c\_ .edgeLabel .label rect{opacity:1;rx:13px;ry:13px;fill:rgb(2, 3, 4);stroke:rgb(255, 218, 166);stroke-width:1px;}#chatgpt-mermaid-\_r_13c\_ .node rect,#chatgpt-mermaid-\_r_13c\_ .node circle,#chatgpt-mermaid-\_r_13c\_ .node ellipse,#chatgpt-mermaid-\_r_13c\_ .node polygon,#chatgpt-mermaid-\_r_13c\_ .node path{fill:rgb(99, 57, 0);stroke:rgba(255, 255, 255, 0.1);stroke-width:1px;}#chatgpt-mermaid-\_r_13c\_ .node rect{rx:16px;ry:16px;}#chatgpt-mermaid-\_r_13c\_ .mermaid-decision .label-container{fill:rgb(2, 3, 4);stroke:rgb(255, 218, 166);stroke-dasharray:2,2;}#chatgpt-mermaid-\_r_13c\_ .edgePaths .flowchart-link{stroke:rgba(255, 255, 255, 0.72);stroke-width:1px;stroke-linecap:round;stroke-linejoin:round;}#chatgpt-mermaid-\_r_13c\_ .marker{fill:rgba(255, 255, 255, 0.72);stroke:rgba(255, 255, 255, 0.72);}#chatgpt-mermaid-\_r_13c\_ :root{--mermaid-font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";}Read не совпал с курсоромТот же источник, что ипредыдущий?Повторное чтениеУже есть индекс текущегопрохода?Поиск в source.slotУ источника нетподписчиков?Создать EdgeОграниченные поиски, SCAN= 8Отношение найдено?Использовать илипереместить EdgeНайти через подписчиковМожно доказать точно?Один индексирующийпроходДаНетДаНетДаНетДаДоказано отсутствиеЕщё неизвестноДаНет

Здесь особенно важно слово «точно».

Quant не делает вывод, что отношения нет, просто потому, что не нашёл его за восемь сравнений.

Ограниченные сканирования дают один из трёх результатов: отношение найдено, отсутствие доказано или данных пока недостаточно.

Если данных недостаточно, включается индексирование.

`SCAN = 8` не является ограничением точности. Это лишь граница дешёвого поиска.

### `slot`: временный индекс вместо постоянной таблицы

У каждого источника уже есть поле `slot`.

Когда потребителю требуется индексировать свои зависимости, Quant проходит его список рёбер и размещает ссылки на них в `slot` соответствующих источников.

После этого поиск пары `(source, consumer)` становится константным:

```
const e = source.slot;

if (e !== null && e.to === consumer) {
  // Existing relation
} else {
  // No relation for this consumer
}
```

Однако индекс временный. Он существует только в рамках прохода.

Зачем это нужно?

Постоянный индекс потребовал бы дополнительного состояния, а также обновления при создании, удалении и изменении отношений. Quant платит за индекс преимущественно тогда, когда трекинг становится достаточно хаотичным, чтобы дешёвые доказательства перестали работать.

После одного линейного прохода точный поиск доступен за O(1) на последующих промахах курсора.

Для уже существующей связи производится перемещение, а не повторная аллокация.

### `UNREAD`: временное состояние без отдельного поля

Во время индексированного или помеченного прохода необходимо отличить уже принятые отношения от тех, которые ещё можно использовать.

Для этого используется `UNREAD = -1`, записываемый в `Edge.ver` непрочитанной части списка.

Здесь обнаруживается второе соединение механизмов.

Версия ребра обычно говорит, какую версию источника видел потребитель. Но во время исполнения ещё не принятые рёбра могут временно использовать это же поле для состояния `UNREAD`.

Ребро остаётся тем же. Дополнительного флага на нём не появляется.

При первом успешном наблюдении реальная версия источника записывается обратно.

При повторном чтении уже принятого источника версия, напротив, не перезаписывается. Почему это критично, разберём на P5.

### Почему нет `Indexed` и `Marked`

В версии 1.1.2 произошёл особенно интересный архитектурный поворот.

Раньше были отдельные биты, определявшие режим прохода. Теперь используются два факта:

Свидетельство индексированного прохода

`cursor !== null && cursor.from.slot === cursor`

Текущий потребитель владеет слотом источника своего курсора. Значит, индекс этого прохода уже установлен.

Свидетельство помеченного прохода

`next !== null && next.ver === UNREAD`

Непрочитанные отношения образуют непрерывный суффикс. Если его начало помечено, проход уже находится в режиме такого поиска.

Именно это я считаю одним из самых сильных моментов новой версии.

Состояние больше не нужно хранить, если структура сама является его доказательством.

Это не магическая оптимизация и не универсальный рецепт. Она работает потому, что Quant сохраняет достаточно строгие инварианты порядка и владения слотами.

Если бы `UNREAD` мог встречаться в произвольных местах списка, второго свидетельства не существовало бы. Если бы вложенные проходы не восстанавливали слоты, первое свидетельство было бы недействительным.

Следовательно, удаление двух флагов является не локальным сокращением кода, а следствием согласованности трёх механизмов: порядка рёбер, временного индексирования и вложенного исполнения.

Это тот редкий случай, когда отлаженный алгоритм начинает сам объяснять, какие состояния больше не нужны.

## IV. Распространение изменений: Quant не пересчитывает весь граф

Представим классический ромб зависимостей.

\#chatgpt-mermaid-\_r_13t\_{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;fill:rgb(255, 255, 255);}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#chatgpt-mermaid-\_r_13t\_ .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_13t\_ .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_13t\_ .error-icon{fill:rgba(255, 255, 255, 0.067);}#chatgpt-mermaid-\_r_13t\_ .error-text{fill:rgb(255, 255, 255);stroke:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_13t\_ .edge-thickness-normal{stroke-width:1px;}#chatgpt-mermaid-\_r_13t\_ .edge-thickness-thick{stroke-width:3.5px;}#chatgpt-mermaid-\_r_13t\_ .edge-pattern-solid{stroke-dasharray:0;}#chatgpt-mermaid-\_r_13t\_ .edge-thickness-invisible{stroke-width:0;fill:none;}#chatgpt-mermaid-\_r_13t\_ .edge-pattern-dashed{stroke-dasharray:3;}#chatgpt-mermaid-\_r_13t\_ .edge-pattern-dotted{stroke-dasharray:2;}#chatgpt-mermaid-\_r_13t\_ .marker{fill:rgba(255, 255, 255, 0.72);stroke:rgba(255, 255, 255, 0.72);}#chatgpt-mermaid-\_r_13t\_ .marker.cross{stroke:rgba(255, 255, 255, 0.72);}#chatgpt-mermaid-\_r_13t\_ svg{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;}#chatgpt-mermaid-\_r_13t\_ p{margin:0;}#chatgpt-mermaid-\_r_13t\_ .label{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";color:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_13t\_ .cluster-label text{fill:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_13t\_ .cluster-label span{color:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_13t\_ .cluster-label span p{background-color:transparent;}#chatgpt-mermaid-\_r_13t\_ .label text,#chatgpt-mermaid-\_r_13t\_ span{fill:rgb(255, 255, 255);color:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_13t\_ .node rect,#chatgpt-mermaid-\_r_13t\_ .node circle,#chatgpt-mermaid-\_r_13t\_ .node ellipse,#chatgpt-mermaid-\_r_13t\_ .node polygon,#chatgpt-mermaid-\_r_13t\_ .node path{fill:rgb(99, 57, 0);stroke:rgb(255, 218, 166);stroke-width:1px;}#chatgpt-mermaid-\_r_13t\_ .rough-node .label text,#chatgpt-mermaid-\_r_13t\_ .node .label text,#chatgpt-mermaid-\_r_13t\_ .image-shape .label,#chatgpt-mermaid-\_r_13t\_ .icon-shape .label{text-anchor:middle;}#chatgpt-mermaid-\_r_13t\_ .node .katex path{fill:#000;stroke:#000;stroke-width:1px;}#chatgpt-mermaid-\_r_13t\_ .rough-node .label,#chatgpt-mermaid-\_r_13t\_ .node .label,#chatgpt-mermaid-\_r_13t\_ .image-shape .label,#chatgpt-mermaid-\_r_13t\_ .icon-shape .label{text-align:center;}#chatgpt-mermaid-\_r_13t\_ .node.clickable{cursor:pointer;}#chatgpt-mermaid-\_r_13t\_ .root .anchor path{fill:rgba(255, 255, 255, 0.72)!important;stroke-width:0;stroke:rgba(255, 255, 255, 0.72);}#chatgpt-mermaid-\_r_13t\_ .arrowheadPath{fill:rgba(255, 255, 255, 0.72);}#chatgpt-mermaid-\_r_13t\_ .edgePath .path{stroke:rgba(255, 255, 255, 0.72);stroke-width:1px;}#chatgpt-mermaid-\_r_13t\_ .flowchart-link{stroke:rgba(255, 255, 255, 0.72);fill:none;}#chatgpt-mermaid-\_r_13t\_ .edgeLabel{background-color:rgb(2, 3, 4);text-align:center;}#chatgpt-mermaid-\_r_13t\_ .edgeLabel p{background-color:rgb(2, 3, 4);}#chatgpt-mermaid-\_r_13t\_ .edgeLabel rect{opacity:0.5;background-color:rgb(2, 3, 4);fill:rgb(2, 3, 4);}#chatgpt-mermaid-\_r_13t\_ .labelBkg{background-color:rgba(2, 3, 4, 0.5);}#chatgpt-mermaid-\_r_13t\_ .cluster rect{fill:rgba(255, 255, 255, 0.067);stroke:rgba(255, 255, 255, 0.153);stroke-width:1px;}#chatgpt-mermaid-\_r_13t\_ .cluster text{fill:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_13t\_ .cluster span{color:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_13t\_ div.mermaidTooltip{position:absolute;text-align:center;max-width:200px;padding:2px;font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:12px;background:rgba(255, 255, 255, 0.067);border:1px solid rgba(255, 255, 255, 0.153);border-radius:2px;pointer-events:none;z-index:100;}#chatgpt-mermaid-\_r_13t\_ .flowchartTitleText{text-anchor:middle;font-size:18px;fill:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_13t\_ rect.text{fill:none;stroke-width:0;}#chatgpt-mermaid-\_r_13t\_ .icon-shape,#chatgpt-mermaid-\_r_13t\_ .image-shape{background-color:rgb(2, 3, 4);text-align:center;}#chatgpt-mermaid-\_r_13t\_ .icon-shape p,#chatgpt-mermaid-\_r_13t\_ .image-shape p{background-color:rgb(2, 3, 4);padding:2px;}#chatgpt-mermaid-\_r_13t\_ .icon-shape .label rect,#chatgpt-mermaid-\_r_13t\_ .image-shape .label rect{opacity:0.5;background-color:rgb(2, 3, 4);fill:rgb(2, 3, 4);}#chatgpt-mermaid-\_r_13t\_ .label-icon{display:inline-block;height:1em;overflow:visible;vertical-align:-0.125em;}#chatgpt-mermaid-\_r_13t\_ .node .label-icon path{fill:currentColor;stroke:revert;stroke-width:revert;}#chatgpt-mermaid-\_r_13t\_ .node .neo-node{stroke:rgb(255, 218, 166);}#chatgpt-mermaid-\_r_13t\_ [data-look="neo"].node rect,#chatgpt-mermaid-\_r_13t\_ [data-look="neo"].cluster rect,#chatgpt-mermaid-\_r_13t\_ [data-look="neo"].node polygon{stroke:url(#chatgpt-mermaid-\_r_13t\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_13t\_ [data-look="neo"].swimlane.cluster rect{filter:none;}#chatgpt-mermaid-\_r_13t\_ [data-look="neo"].node path{stroke:url(#chatgpt-mermaid-\_r_13t\_-gradient);stroke-width:1px;}#chatgpt-mermaid-\_r_13t\_ [data-look="neo"].node .outer-path{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_13t\_ [data-look="neo"].node .neo-line path{stroke:rgb(255, 218, 166);filter:none;}#chatgpt-mermaid-\_r_13t\_ [data-look="neo"].node circle{stroke:url(#chatgpt-mermaid-\_r_13t\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_13t\_ [data-look="neo"].node circle .state-start{fill:#000000;}#chatgpt-mermaid-\_r_13t\_ [data-look="neo"].icon-shape .icon{fill:url(#chatgpt-mermaid-\_r_13t\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_13t\_ [data-look="neo"].icon-shape .icon-neo path{stroke:url(#chatgpt-mermaid-\_r_13t\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_13t\_ .node text{font-size:14px;font-weight:600;letter-spacing:normal;fill:rgb(255, 218, 166);}#chatgpt-mermaid-\_r_13t\_ .edgeLabels text{font-size:13px;font-weight:600;letter-spacing:-0.08px;fill:rgb(255, 218, 166);}#chatgpt-mermaid-\_r_13t\_ .node tspan[font-weight="normal"],#chatgpt-mermaid-\_r_13t\_ .edgeLabels tspan[font-weight="normal"]{font-weight:600;}#chatgpt-mermaid-\_r_13t\_ .edgeLabel .label rect{opacity:1;rx:13px;ry:13px;fill:rgb(2, 3, 4);stroke:rgb(255, 218, 166);stroke-width:1px;}#chatgpt-mermaid-\_r_13t\_ .node rect,#chatgpt-mermaid-\_r_13t\_ .node circle,#chatgpt-mermaid-\_r_13t\_ .node ellipse,#chatgpt-mermaid-\_r_13t\_ .node polygon,#chatgpt-mermaid-\_r_13t\_ .node path{fill:rgb(99, 57, 0);stroke:rgba(255, 255, 255, 0.1);stroke-width:1px;}#chatgpt-mermaid-\_r_13t\_ .node rect{rx:16px;ry:16px;}#chatgpt-mermaid-\_r_13t\_ .mermaid-decision .label-container{fill:rgb(2, 3, 4);stroke:rgb(255, 218, 166);stroke-dasharray:2,2;}#chatgpt-mermaid-\_r_13t\_ .edgePaths .flowchart-link{stroke:rgba(255, 255, 255, 0.72);stroke-width:1px;stroke-linecap:round;stroke-linejoin:round;}#chatgpt-mermaid-\_r_13t\_ .marker{fill:rgba(255, 255, 255, 0.72);stroke:rgba(255, 255, 255, 0.72);}#chatgpt-mermaid-\_r_13t\_ :root{--mermaid-font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";}#chatgpt-mermaid-\_r_13t\_ .source rect{fill:rgb(100, 116, 139)!important;color:rgb(255, 255, 255)!important;stroke:rgb(100, 116, 139)!important;}#chatgpt-mermaid-\_r_13t\_ .source polygon{fill:rgb(100, 116, 139)!important;color:rgb(255, 255, 255)!important;stroke:rgb(100, 116, 139)!important;}#chatgpt-mermaid-\_r_13t\_ .source ellipse{fill:rgb(100, 116, 139)!important;color:rgb(255, 255, 255)!important;stroke:rgb(100, 116, 139)!important;}#chatgpt-mermaid-\_r_13t\_ .source circle{fill:rgb(100, 116, 139)!important;color:rgb(255, 255, 255)!important;stroke:rgb(100, 116, 139)!important;}#chatgpt-mermaid-\_r_13t\_ .source path{fill:rgb(100, 116, 139)!important;color:rgb(255, 255, 255)!important;stroke:rgb(100, 116, 139)!important;}#chatgpt-mermaid-\_r_13t\_ .source tspan{fill:rgb(255, 255, 255)!important;}#chatgpt-mermaid-\_r_13t\_ .derived rect{fill:rgb(13, 148, 136)!important;color:rgb(255, 255, 255)!important;stroke:rgb(13, 148, 136)!important;}#chatgpt-mermaid-\_r_13t\_ .derived polygon{fill:rgb(13, 148, 136)!important;color:rgb(255, 255, 255)!important;stroke:rgb(13, 148, 136)!important;}#chatgpt-mermaid-\_r_13t\_ .derived ellipse{fill:rgb(13, 148, 136)!important;color:rgb(255, 255, 255)!important;stroke:rgb(13, 148, 136)!important;}#chatgpt-mermaid-\_r_13t\_ .derived circle{fill:rgb(13, 148, 136)!important;color:rgb(255, 255, 255)!important;stroke:rgb(13, 148, 136)!important;}#chatgpt-mermaid-\_r_13t\_ .derived path{fill:rgb(13, 148, 136)!important;color:rgb(255, 255, 255)!important;stroke:rgb(13, 148, 136)!important;}#chatgpt-mermaid-\_r_13t\_ .derived tspan{fill:rgb(255, 255, 255)!important;}#chatgpt-mermaid-\_r_13t\_ .watcher rect{fill:rgb(180, 83, 9)!important;color:rgb(255, 255, 255)!important;stroke:rgb(180, 83, 9)!important;}#chatgpt-mermaid-\_r_13t\_ .watcher polygon{fill:rgb(180, 83, 9)!important;color:rgb(255, 255, 255)!important;stroke:rgb(180, 83, 9)!important;}#chatgpt-mermaid-\_r_13t\_ .watcher ellipse{fill:rgb(180, 83, 9)!important;color:rgb(255, 255, 255)!important;stroke:rgb(180, 83, 9)!important;}#chatgpt-mermaid-\_r_13t\_ .watcher circle{fill:rgb(180, 83, 9)!important;color:rgb(255, 255, 255)!important;stroke:rgb(180, 83, 9)!important;}#chatgpt-mermaid-\_r_13t\_ .watcher path{fill:rgb(180, 83, 9)!important;color:rgb(255, 255, 255)!important;stroke:rgb(180, 83, 9)!important;}#chatgpt-mermaid-\_r_13t\_ .watcher tspan{fill:rgb(255, 255, 255)!important;}signal Acomputed Bcomputed Ccomputed Deffect E

При изменении `A` нельзя просто последовательно запускать всех подписчиков. Иначе `D` может вычислиться после обновления `B`, но до обновления `C`.

Получится glitch: один временный результат, составленный из значений разных логических состояний.

Quant разделяет две операции.

Push распространяет информацию, что нижележащие вычисления могли устареть.

Pull восстанавливает актуальные значения тогда, когда они понадобились.

При этом push и pull не являются независимыми очередями исполнения. Они используют один граф и одну систему состояний.

### Два вида инвалидированности

STALE

Возможно, результат неактуален.

Необходимо проверить версии источников. Сам callback может оказаться ненужным.

DIRTY

Исполнение уже необходимо.

Повторная проверка не нужна для решения, надо ли запускать callback.

Различие фундаментальное.

Прямой подписчик изменившегося сигнала точно знает, что его источник изменился. Поэтому его можно сделать `DIRTY`.

Но вычисление на два уровня ниже не знает, изменился ли результат промежуточного computed. Возможно, промежуточное вычисление вернёт прежнее значение.

Такой узел становится `STALE`.

### От `write` к `verify` и `exec`

\#chatgpt-mermaid-\_r_14a\_{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;fill:rgb(255, 255, 255);}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#chatgpt-mermaid-\_r_14a\_ .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_14a\_ .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_14a\_ .error-icon{fill:rgba(255, 255, 255, 0.067);}#chatgpt-mermaid-\_r_14a\_ .error-text{fill:rgb(255, 255, 255);stroke:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_14a\_ .edge-thickness-normal{stroke-width:1px;}#chatgpt-mermaid-\_r_14a\_ .edge-thickness-thick{stroke-width:3.5px;}#chatgpt-mermaid-\_r_14a\_ .edge-pattern-solid{stroke-dasharray:0;}#chatgpt-mermaid-\_r_14a\_ .edge-thickness-invisible{stroke-width:0;fill:none;}#chatgpt-mermaid-\_r_14a\_ .edge-pattern-dashed{stroke-dasharray:3;}#chatgpt-mermaid-\_r_14a\_ .edge-pattern-dotted{stroke-dasharray:2;}#chatgpt-mermaid-\_r_14a\_ .marker{fill:rgba(255, 255, 255, 0.72);stroke:rgba(255, 255, 255, 0.72);}#chatgpt-mermaid-\_r_14a\_ .marker.cross{stroke:rgba(255, 255, 255, 0.72);}#chatgpt-mermaid-\_r_14a\_ svg{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;}#chatgpt-mermaid-\_r_14a\_ p{margin:0;}#chatgpt-mermaid-\_r_14a\_ .label{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";color:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_14a\_ .cluster-label text{fill:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_14a\_ .cluster-label span{color:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_14a\_ .cluster-label span p{background-color:transparent;}#chatgpt-mermaid-\_r_14a\_ .label text,#chatgpt-mermaid-\_r_14a\_ span{fill:rgb(255, 255, 255);color:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_14a\_ .node rect,#chatgpt-mermaid-\_r_14a\_ .node circle,#chatgpt-mermaid-\_r_14a\_ .node ellipse,#chatgpt-mermaid-\_r_14a\_ .node polygon,#chatgpt-mermaid-\_r_14a\_ .node path{fill:rgb(99, 57, 0);stroke:rgb(255, 218, 166);stroke-width:1px;}#chatgpt-mermaid-\_r_14a\_ .rough-node .label text,#chatgpt-mermaid-\_r_14a\_ .node .label text,#chatgpt-mermaid-\_r_14a\_ .image-shape .label,#chatgpt-mermaid-\_r_14a\_ .icon-shape .label{text-anchor:middle;}#chatgpt-mermaid-\_r_14a\_ .node .katex path{fill:#000;stroke:#000;stroke-width:1px;}#chatgpt-mermaid-\_r_14a\_ .rough-node .label,#chatgpt-mermaid-\_r_14a\_ .node .label,#chatgpt-mermaid-\_r_14a\_ .image-shape .label,#chatgpt-mermaid-\_r_14a\_ .icon-shape .label{text-align:center;}#chatgpt-mermaid-\_r_14a\_ .node.clickable{cursor:pointer;}#chatgpt-mermaid-\_r_14a\_ .root .anchor path{fill:rgba(255, 255, 255, 0.72)!important;stroke-width:0;stroke:rgba(255, 255, 255, 0.72);}#chatgpt-mermaid-\_r_14a\_ .arrowheadPath{fill:rgba(255, 255, 255, 0.72);}#chatgpt-mermaid-\_r_14a\_ .edgePath .path{stroke:rgba(255, 255, 255, 0.72);stroke-width:1px;}#chatgpt-mermaid-\_r_14a\_ .flowchart-link{stroke:rgba(255, 255, 255, 0.72);fill:none;}#chatgpt-mermaid-\_r_14a\_ .edgeLabel{background-color:rgb(2, 3, 4);text-align:center;}#chatgpt-mermaid-\_r_14a\_ .edgeLabel p{background-color:rgb(2, 3, 4);}#chatgpt-mermaid-\_r_14a\_ .edgeLabel rect{opacity:0.5;background-color:rgb(2, 3, 4);fill:rgb(2, 3, 4);}#chatgpt-mermaid-\_r_14a\_ .labelBkg{background-color:rgba(2, 3, 4, 0.5);}#chatgpt-mermaid-\_r_14a\_ .cluster rect{fill:rgba(255, 255, 255, 0.067);stroke:rgba(255, 255, 255, 0.153);stroke-width:1px;}#chatgpt-mermaid-\_r_14a\_ .cluster text{fill:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_14a\_ .cluster span{color:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_14a\_ div.mermaidTooltip{position:absolute;text-align:center;max-width:200px;padding:2px;font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:12px;background:rgba(255, 255, 255, 0.067);border:1px solid rgba(255, 255, 255, 0.153);border-radius:2px;pointer-events:none;z-index:100;}#chatgpt-mermaid-\_r_14a\_ .flowchartTitleText{text-anchor:middle;font-size:18px;fill:rgb(255, 255, 255);}#chatgpt-mermaid-\_r_14a\_ rect.text{fill:none;stroke-width:0;}#chatgpt-mermaid-\_r_14a\_ .icon-shape,#chatgpt-mermaid-\_r_14a\_ .image-shape{background-color:rgb(2, 3, 4);text-align:center;}#chatgpt-mermaid-\_r_14a\_ .icon-shape p,#chatgpt-mermaid-\_r_14a\_ .image-shape p{background-color:rgb(2, 3, 4);padding:2px;}#chatgpt-mermaid-\_r_14a\_ .icon-shape .label rect,#chatgpt-mermaid-\_r_14a\_ .image-shape .label rect{opacity:0.5;background-color:rgb(2, 3, 4);fill:rgb(2, 3, 4);}#chatgpt-mermaid-\_r_14a\_ .label-icon{display:inline-block;height:1em;overflow:visible;vertical-align:-0.125em;}#chatgpt-mermaid-\_r_14a\_ .node .label-icon path{fill:currentColor;stroke:revert;stroke-width:revert;}#chatgpt-mermaid-\_r_14a\_ .node .neo-node{stroke:rgb(255, 218, 166);}#chatgpt-mermaid-\_r_14a\_ [data-look="neo"].node rect,#chatgpt-mermaid-\_r_14a\_ [data-look="neo"].cluster rect,#chatgpt-mermaid-\_r_14a\_ [data-look="neo"].node polygon{stroke:url(#chatgpt-mermaid-\_r_14a\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_14a\_ [data-look="neo"].swimlane.cluster rect{filter:none;}#chatgpt-mermaid-\_r_14a\_ [data-look="neo"].node path{stroke:url(#chatgpt-mermaid-\_r_14a\_-gradient);stroke-width:1px;}#chatgpt-mermaid-\_r_14a\_ [data-look="neo"].node .outer-path{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_14a\_ [data-look="neo"].node .neo-line path{stroke:rgb(255, 218, 166);filter:none;}#chatgpt-mermaid-\_r_14a\_ [data-look="neo"].node circle{stroke:url(#chatgpt-mermaid-\_r_14a\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_14a\_ [data-look="neo"].node circle .state-start{fill:#000000;}#chatgpt-mermaid-\_r_14a\_ [data-look="neo"].icon-shape .icon{fill:url(#chatgpt-mermaid-\_r_14a\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_14a\_ [data-look="neo"].icon-shape .icon-neo path{stroke:url(#chatgpt-mermaid-\_r_14a\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_14a\_ .node text{font-size:14px;font-weight:600;letter-spacing:normal;fill:rgb(255, 218, 166);}#chatgpt-mermaid-\_r_14a\_ .edgeLabels text{font-size:13px;font-weight:600;letter-spacing:-0.08px;fill:rgb(255, 218, 166);}#chatgpt-mermaid-\_r_14a\_ .node tspan[font-weight="normal"],#chatgpt-mermaid-\_r_14a\_ .edgeLabels tspan[font-weight="normal"]{font-weight:600;}#chatgpt-mermaid-\_r_14a\_ .edgeLabel .label rect{opacity:1;rx:13px;ry:13px;fill:rgb(2, 3, 4);stroke:rgb(255, 218, 166);stroke-width:1px;}#chatgpt-mermaid-\_r_14a\_ .node rect,#chatgpt-mermaid-\_r_14a\_ .node circle,#chatgpt-mermaid-\_r_14a\_ .node ellipse,#chatgpt-mermaid-\_r_14a\_ .node polygon,#chatgpt-mermaid-\_r_14a\_ .node path{fill:rgb(99, 57, 0);stroke:rgba(255, 255, 255, 0.1);stroke-width:1px;}#chatgpt-mermaid-\_r_14a\_ .node rect{rx:16px;ry:16px;}#chatgpt-mermaid-\_r_14a\_ .mermaid-decision .label-container{fill:rgb(2, 3, 4);stroke:rgb(255, 218, 166);stroke-dasharray:2,2;}#chatgpt-mermaid-\_r_14a\_ .edgePaths .flowchart-link{stroke:rgba(255, 255, 255, 0.72);stroke-width:1px;stroke-linecap:round;stroke-linejoin:round;}#chatgpt-mermaid-\_r_14a\_ .marker{fill:rgba(255, 255, 255, 0.72);stroke:rgba(255, 255, 255, 0.72);}#chatgpt-mermaid-\_r_14a\_ :root{--mermaid-font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol";}set(signal, next)Object.is(old, next)?Ничего не делатьЗаписать значение,увеличить verПрямые подписчики: DIRTY /WOKENДальние потомки: STALEВозник спрос: get илиwatcherDIRTY?execverify: версии источниковНайдено изменение?Оставить вычисление беззапускаObject.is результата?Cutoff: версия не растётЗафиксировать value и verДаНетДаНет, STALEДаНетРавныРазличаются

Это важнее обычной схемы «сигнал уведомляет подписчиков».

Здесь вычисления могут быть инвалидированы, но фактически не выполняться. А выполненное вычисление может не передавать изменение дальше, если его значение осталось прежним.

### Версия вместо сравнения значения с историческим значением

У каждого `Node` есть `ver`. У каждого отношения `Edge` также есть `ver`.

Допустим:

```
Источник A: value = 1, ver = 10
Отношение A → B:      ver = 10

set(A, 2) → A.ver = 11
set(A, 1) → A.ver = 12
```

Теперь значение снова равно единице, но версия отношения по-прежнему равна десяти.

`B` видит, что источник изменялся после его наблюдения.

Это свойство называется ABA: значение прошло через другое состояние и вернулось к исходному.

Quant считает изменение событием фиксации нового значения, определяемым через `Object.is`, а не просто неравенством начального и конечного значения.

Однако для computed используется и другая сторона механизма: если после реального исполнения его выходное значение `Object.is`-равно предыдущему, версия computed не увеличивается.

Поэтому одновременно выполняются два свойства:

- Изменение наблюдаемого источника не теряется из-за A→B→A.
- Неизменный результат computed может остановить распространение изменения.

Одно свойство требует помнить историю наблюдения, другое позволяет не распространять несущественные изменения результата.

Их совместная реализация через версии избавляет от необходимости использовать целый набор специальных флагов изменения.

### Почему pull экзистенциальный

Если computed имеет источники `A`, `B`, `C`, а первый из них уже доказанно изменился, запуск callback необходим.

Проверять все остальные источники только для принятия решения о запуске бессмысленно.

Поэтому `verify` проверяет зависимости в порядке чтения и может прекратить проверку на первом отличии версии.

Это D1: existential validation.

Но возникает тонкость. Если `A` изменился, а чтение `C` бросило бы исключение, D1 позволяет computed перейти непосредственно к исполнению, не бросая исключение из проверки `C`. Во время нового исполнения `C` вообще может не понадобиться из-за сменившейся ветки.

Следовательно, экзистенциальность влияет не только на скорость. Она изменяет наблюдаемое поведение на путях с исключениями.

И Quant делает этот выбор явно частью собственного контракта.

Для watcher правило другое.

## V. Наблюдатель обязан проверять больше, чем computed

Это на первый взгляд странная асимметрия.

Computed достаточно одного изменившегося источника, чтобы решить, что его надо исполнить.

А watcher, согласно P4, должен проверить весь набор ранее подтверждённых источников до начала необратимых действий собственного жизненного цикла.

Почему?

Допустим, effect ранее вернул cleanup. При повторном запуске cleanup должен быть выполнен до callback.

Но если один из computed-источников watcher бросает исключение при валидации, прежний cleanup нельзя считать уже израсходованным.

Иначе получается ситуация, в которой watcher не смог даже установить, нужно ли корректно исполнить новую итерацию, но уже разрушил ресурсы предыдущей.

Поэтому его цикл выглядит так:

1. Проверка всех committed-источников

   Их актуальность устанавливается до выполнения lifecycle-действий. Исключение останавливает этот проход.
2. Проверка существования обязанности исполниться

   `DIRTY` означает, что повторный callback требуется. Если результат промежуточных computed не изменился, watcher может остаться без повторного исполнения.
3. Поглощение предыдущего cleanup

   Cleanup запускается без отслеживания зависимостей. Его собственные записи и исключения не должны приводить к потере уже существующей обязанности.
4. Новое исполнение callback

   Выполняется `exec`, заново формируется точный набор чтений, а возвращённый cleanup становится следующим сохранённым значением.

Это также объясняет, зачем наблюдателю одновременно нужны `STALE` и `WOKEN`.

Если watcher пробуждён непосредственно сигналами и его computed-источники не требуют проверки, валидационный проход может быть пропущен. Для такого случая используется `WOKEN`.

Если пробуждение прошло через computed, требуется проверка возможных изменений, и работает `STALE`.

Этот маленький флаг `WOKEN` имеет весьма ощутимые последствия. В предыдущих версиях Quant сценарий с широким набором источников мог повторно проверять тысячу отношений при обновлении сигнала. После специализации это исчезает на соответствующем пути.

Иными словами, здесь допускается избыточность состояния ровно там, где она позволяет избежать доказанно ненужной работы.

Это хороший контрпример примитивному минимализму, который требовал бы удалить вообще все флаги.

## VI. P5: самое тонкое семантическое свойство Quant

Теперь вернёмся к `Edge.ver` и повторным чтениям.

Пусть вычисление читает источник, затем изменяет его, а затем читает снова.

```
const a = signal(1);

const c = computed(() => {
  const first = get(a);

  if (first === 1) set(a, 2);

  return first + get(a);
});
```

В первом исполнении будут прочитаны два разных состояния `a`.

Первое чтение вернёт `1`, второе `2`, а вычисление вернёт `3`.

Но является ли этот результат актуальным по отношению к состоянию источника после исполнения?

Нет. Он был вычислен с использованием прежнего значения единицы.

Если второе чтение обновит версию отношения до новой, в графе исчезнет свидетельство того, что результат использовал старое состояние.

Quant сохраняет версию первого успешного наблюдения источника в данном проходе.

Временная линия одного исполнения

Первый get(c)

## 3

Второй get(c)

## 4

Третий get(c)

## 4

Свойство P5 формулируется шире.

Если computation уже наблюдал источник, последующее подтверждённое изменение этого источника во время того же исполнения оставляет долг на ещё одно вычисление. Даже если источник будет прочитан повторно.

А если запись произошла до первого чтения, такого долга не возникает.

Это различие необходимо, чтобы не создавать бесконечных повторных исполнений на каждый write внутри callback.

Ещё интереснее случай A→B→A между двумя чтениями. Даже если в итоге источник вернулся к прежнему значению, первое наблюдение не отменяет факт изменения между чтениями.

### Почему P5 изменяет не только tracking

Наивная реализация может корректно сохранить первую версию в ребре, но всё равно потерять изменение, если считать computed актуальным на момент завершения исполнения.

Поэтому в D6 есть две связанные части: сохранить версию первого наблюдения и считать результат проверенным относительно состояния на начало исполнения, а не относительно всех изменений, произошедших внутри него.

Это семантическая коррекция, а не просто ускорение повторных `get()`.

Показательно, что тестовый язык основного differential-корпуса не умеет выражать запись внутри вычисления. Поэтому P5 нельзя считать доказанным этим корпусом. Для него существуют отдельные тесты через публичный API.

Такая честность в границах проверки принципиальна: отсутствие расхождений на ста тысячах программ ничего не говорит о поведении, которое ни одна из них не умеет выразить.

## VII. Ошибка исполнения не должна переписывать историю графа

Реактивный runtime сравнительно просто написать, если все callback всегда успешно завершаются.

Исключения сразу делают модель гораздо интереснее.

Представим, что вычисление раньше читало источники:

`A → B → C`

Затем при следующем запуске оно прочитало `A`, впервые прочитало `D` и бросило исключение до чтения `B` и `C`.

Какой набор зависимостей должен сохраниться?

Удалить `B` и `C` нельзя. Они относились к последнему успешно подтверждённому исполнению.

Но потерять `D` тоже нельзя, поскольку именно он мог стать причиной следующего восстановления.

Quant хранит два вида свидетельств.

Подтверждённые отношения

Новое временное отношение

Если после этого произойдёт ещё одна неудачная попытка, которая вместо `D` прочитает `E`, старое временное отношение `D` не должно накапливаться бесконечно.

Но committed-отношения `A`, `B`, `C` по-прежнему нельзя забывать.

Это требует отличать последнюю удачную конфигурацию графа от свидетельств текущей неудачной попытки.

### Поколения вместо журнала rollback

Для этого существуют `Node.gen` и `Edge.gen`.

При создании ребро получает поколение следующего успешного прохода:

```
edge.gen = (consumer.gen + 1) & MASK;
```

Пока успешный проход не завершён, ребро является tentative.

На успешном завершении `Node.gen` увеличивается, и новые отношения становятся подтверждёнными. Их не нужно отдельно обходить, чтобы менять каждый флаг.

При ошибке можно удалить временные рёбра предыдущих неудачных попыток, сохраняя committed-отношения и то, что было прочитано в последней попытке.

Есть важная асимметрия: tentative-отношение может разбудить watcher, но оно не считается полноценной committed-зависимостью для валидации.

Это предотвращает ситуацию, когда неудачное исполнение начинает предъявлять к графу гарантии успешного.

### F1, F2, F3, F4 как единая система восстановления

В Quant исключения покрываются не одним обработчиком `catch`, а несколькими связанными обязательствами.

| Обязательство | Поведение                                                                                |
| ------------- | ---------------------------------------------------------------------------------------- |
| F1            | Ошибка computed ничего не фиксирует; следующий спрос вызывает новую попытку исполнения   |
| F2            | Чтение, завершившееся исключением, не становится успешным наблюдением                    |
| F3            | У уже созданного watcher ошибочная попытка сохраняет нужный набор источников пробуждения |
| F4            | Обязанность исполниться не исчезает из-за исключения                                     |

Особенно важен F4.

Условно говоря, `DIRTY` означает не просто «данные изменились», а «существует ещё не исполненная обязанность».

Если callback бросил исключение, эта обязанность не должна внезапно исчезнуть потому, что какой-то внутренний флаг был очищен перед вызовом.

Именно здесь версии и `DIRTY` дополняют друг друга: одно сохраняет доказательство изменения источников, другое сохраняет необходимость исполнения, если она уже установлена.

### Зачем нужен `SETTLE`

Поколения ограничены тридцатью битами. Значит, рано или поздно они переполняются.

Тогда старое committed-ребро теоретически могло бы иметь номер поколения, совпадающий с номером следующего tentative-поколения.

Система ошибочно сочла бы старое подтверждённое отношение новым временным.

Для защиты используется `SETTLE = 0x1fffffff`. Дважды за цикл счётчика узел переписывает поколения всех своих committed-рёбер на актуальное.

Редкий линейный проход предотвращает ошибку из-за переполнения счётчика.

Это интересный компромисс: вместо бесконечного счётчика или отдельного флага на каждом ребре достаточно периодически нормализовать существующие свидетельства.

И такое поведение тоже закреплено тестами перехода через границу поколения.

## VIII. Один стек для трёх разных подсистем

Здесь Quant особенно интересен как работа по организации исполнения.

В типичном runtime распространение invalidation, валидация и tracking часто развиваются как отдельные механизмы. Каждый может обзавестись своим стеком, рекурсивным обходом или состоянием возобновления.

Quant обнаруживает общий знаменатель: все три подсистемы должны временно запоминать место, куда необходимо вернуться.

И во всех трёх случаях это место можно обозначить существующим `Edge`.

Три задачи, одна рабочая память

### Push: стек содержит отложенных соседей

В глубоком графе рекурсивный DFS может переполнить JavaScript call stack.

Quant использует итеративный обход. Когда необходимо уйти по одной ветке, следующий sibling сохраняется в общей рабочей памяти.

Так сохраняется возможность вернуться к остальным подписчикам после обработки глубокой ветки.

### Pull: стек содержит путь возвращения

При проверке stale computed необходимо спуститься по зависимостям, а затем вернуться к потребителю и продолжить проверку его следующих источников.

В стеке сохраняется ребро, через которое можно подняться.

Если в глубине произошло исключение, проход поднимается обратно и помечает затронутые вычисления как требующие исполнения, сохраняя F4.

Используется тот же стек, но другой логический вид продолжения.

### Tracking: стек сохраняет вытесненные slot

Здесь связь ещё тоньше.

Во время индексированного прохода внешний computed может временно положить своё ребро в `source.slot`.

Затем во время его вычисления запускается вложенный computed, которому необходим индекс по тем же источникам.

Вложенный проход вытесняет слоты внешнего.

Если после завершения вложенного исполнения внешние слоты просто очистить, внешний проход продолжится с повреждённым индексом. Возникнет риск дублирования отношений или пропуска уже существующего ребра.

Поэтому предыдущие slot-ячейки нужно восстановить.

И тут оказалось, что сохранять пару `(source, oldEdge)` не нужно.

Каждое `Edge` уже содержит неизменяемое `from`, которое идентифицирует источник.

```
function claim(source: Node, edge: Edge): void {
  const old = source.slot;

  if (old !== null) stack[top++] = old;

  source.slot = edge;
}
```

Восстановление:

```
const old = stack[--top] as Edge;

stack[top] = null;
old.from.slot = old;
```

Сведения об источнике уже были в сохраняемом ребре.

Так общая рабочая память становится полностью `Edge`-only.

Влияние Edge-only на вложенное индексирование

До оптимизации

# 1 542

Пиковых элементов стека, width 256

После оптимизации

# 771

Пиковых элементов стека, тот же граф

Локальный структурный эксперимент из LOG 38. Это двукратное уменьшение пиковой длины рабочего стека, а не всей памяти реактивного графа.

Но главное здесь даже не двукратное сокращение.

Внутренняя архитектура показывает, что три на первый взгляд разных процесса используют одинаковую элементарную операцию: сохранить ребро, выполнить вложенную работу, восстановить контекст.

Получается небольшая машина продолжений, хотя Quant не вводит полноценную continuation abstraction.

### Исполнение и состояние теперь живут в разных местах

Раньше `Node.last` хранил курсор трекинга в самом узле. Теперь существуют только два регистра контекста:

`active`: текущий потребитель.

`cursor`: последнее принятое ребро его прохода.

При вложенном исполнении оба сохраняются и восстанавливаются. `untracked()` временно отключает `active`, но не уничтожает курсор внешнего исполнения.

И здесь возникает ещё одна неожиданная выгода.

Раньше уже уничтоженный computed мог удерживать свой последний cursor, а через него всю цепочку бывших зависимостей. Хотя `deps` был очищен, оставалась скрытая ссылка.

Удалив `Node.last`, Quant уничтожил саму возможность такого пути удержания через persistent node cursor.

Это хороший пример оптимизации, одновременно улучшающей модель ресурсов: состояние исчезает из объекта, поскольку его реальный срок жизни ограничен исполнением.

### После глубокой работы стек не должен навсегда оставаться большим

Общий массив выделяется с начальной длиной 256.

Если глубокий обход увеличил его за 512 элементов и все активные владельцы освободили свои элементы, `trim()` сокращает массив обратно до 256.

Политика ёмкости рабочего стека

Сокращение выполняется на выходах трёх производителей стека: mark, verify и unindex, включая пути ошибок.

Зачем на трёх выходах?

Потому что проверять только завершение `pull` недостаточно. Глубокий push может произойти без последующего чтения. Индексированный watcher может исполниться напрямую. Валидация может оборваться исключением.

Именно такие случаи были обнаружены регрессионными тестами.

При этом не требуется отдельный счётчик глубины пользовательских вызовов. Достаточно того, что `top === 0` удостоверяет отсутствие занятых ячеек самого массива.

Это более узкое утверждение, чем «никакой JavaScript callback сейчас не исполняется». И именно поэтому оно корректно.

## IX. Уничтожение узла: граница между графом и памятью

`dispose` в Quant не сводится к выставлению флага `disposed`.

При уничтожении вычисления необходимо разорвать связи с его источниками, исключить будущие исполнения и не оставить скрытых путей удержания памяти.

Но есть важное усложнение: узел может вызвать `dispose` самого себя во время своего исполнения.

Если немедленно очистить всю структуру `deps`, оставшаяся часть текущего callback способна попытаться продолжить tracking на уже разрушенном графе.

Quant использует deferred disposal.

У исполняемого узла `fn` сначала становится `null`, что означает терминальное состояние. Физическое отсоединение откладывается до завершения его текущего прохода.

При этом после успешного или неуспешного выхода сначала восстанавливаются временные индексы, а затем удаляются отношения.

Таким образом, уничтожение не требует отдельного сложного протокола для каждого вида выхода из callback. Точки нормального завершения и ошибки уже существуют в `exec`.

### Почему важно очищать указатели даже у удалённых рёбер

В двусвязном списке недостаточно обновить соседей. Само удалённое ребро может продолжать хранить ссылки `prevSub` и `nextSub`.

Если такое ребро останется достижимым через какой-то объект, оно сможет удерживать живые узлы и их замыкания, хотя логически больше не принадлежит списку.

Поэтому `unsub` очищает собственные связи удаляемого ребра со списком подписчиков, а `cut` и обработка ошибок разрывают соответствующие цепочки зависимостей.

Это отличает логическую корректность графа от корректности достижимости памяти.

Граф может выглядеть совершенно правильным при обходе от живых `deps` и `subs`, но удалённое ребро, оставшееся доступным через другой путь, может удерживать целую сеть объектов.

В исследовательских тестах Quant проверяется не только число рёбер, но и достижимость бывших зависимостей от сохранённого disposed-handle. Есть и отдельные локальные проверки с `WeakRef` и принудительной сборкой мусора.

Однако здесь нет обещания, что уничтожение автоматически освобождает всё. Если cached value содержит ссылку на объект, или остаётся другой живой путь, сборщик мусора вполне законно сохранит объект.

`dispose` удаляет принадлежащие узлу upstream-подписки. Он не отменяет нормальные правила достижимости JavaScript.

### Что остаётся после dispose

У computed сохраняется последнее зафиксированное значение, и оно остаётся доступным для чтения. Сам callback больше не исполняется.

У effect выполняется заключительный cleanup в рамках правил host, после отсоединения его зависимостей.

`dispose` идемпотентен: повторное уничтожение не запускает второй жизненный цикл.

Эта семантика особенно удобна для построения слоя управления lifetime поверх Quant. Но сам Quant не начинает автоматически уничтожать вложенные эффекты или создавать component scopes.

## X. Host: почему очередь существует, а планировщика почти нет

В реальном приложении одна запись может пробудить множество наблюдателей.

Если каждый watcher будет запускаться непосредственно из `write`, возникнут вложенные и потенциально рекурсивные цепочки исполнений.

Вместо этого reference host использует FIFO-очередь и один drain-loop.

Доставка наблюдателей при одном изменении

При повторном пробуждении уже поставленного в очередь watcher флаг `QUEUED` предотвращает дублирование.

Это позволяет ядру уведомлять host даже в некоторых случаях, когда watcher уже считается stale. Повторная доставка является ответственностью host, а не отдельной подсистемой retry внутри kernel.

Раньше существовавший специальный `RETRY` удалось удалить, используя эту границу ответственности.

### Почему `effect()` не всегда сразу ставит watcher в очередь

Первое исполнение нового effect в обычном состоянии может открыть drain непосредственно на этом watcher, минуя запись в очередь.

Это экономит операцию над очередью на пути создания короткоживущих наблюдателей.

Но если уже открыт drain или batch, новое исполнение откладывается.

Таким образом, запуск нового эффекта является синхронным там, где это допустимо, но не нарушает правило невложенной доставки.

### `batch()` не является транзакцией

Это важная отличительная черта Quant.

```
batch(() => {
  set(a, 1);
  set(a, 2);
  set(a, 3);

  console.log(get(a)); // 3
});
```

Каждая запись фиксируется сразу.

Каждая следующая операция видит актуальное значение.

Откладывается только исполнение watchers до закрытия самого внешнего batch.

Это означает, что batch не обеспечивает rollback, изоляцию изменений или атомарную публикацию состояния.

Он управляет доставкой эффектов.

Если callback batch бросает исключение, уже произведённые записи не отменяются. `finally` всё равно инициирует flush при завершении внешнего batch.

Такую семантику нельзя без последствий заменить на «соберём все изменения и применим потом»: это был бы другой реактивный контракт.

### Ошибки не останавливают остальных наблюдателей

Drain перехватывает исключения отдельных watchers, продолжает выполнять оставшуюся очередь, а после завершения передаёт первое возникшее исключение вызывающему коду.

Это очень полезная гарантия.

Один упавший effect не превращает остальных подписчиков в заложников своего исключения.

Но и сами ошибки не прячутся: пользователь получает исключение, а runtime сохраняет возможность последующего восстановления.

## XI. Атомарность создания effect: W5

Это небольшая деталь с большими последствиями.

Рассмотрим:

```
effect(() => {
  get(a);
  throw new Error("failed");
});
```

Если первый запуск выполняется синхронно и бросает исключение, вызов `effect()` не возвращает handle.

Но если watcher при этом остался подписанным на `a`, возникает проблема: в графе живёт наблюдатель, которым пользователь уже не может управлять.

Его handle никогда не был передан вызывающему коду.

Это своего рода ресурс-сирота.

Quant вводит правило W5: если создание effect завершилось исключением, новый watcher должен быть полностью отсоединён.

Причём сюда входит более сложный случай. Новый watcher может успешно завершить собственный callback, а затем другой watcher в открытом им drain бросит исключение. Вызов `effect()` всё равно не вернёт handle.

Поэтому rollback создания привязан к исходу вызова API, а не только к исходу первого callback.

В реализации это достигается через существующий `stop()` на пути ошибки `effect()`. Дополнительного состояния в ядре не появляется.

Есть принципиальная граница: если первый запуск был отложен batch или уже открытым drain, `effect()` успевает вернуть handle. Такой watcher уже считается созданным. Его последующее исключение обрабатывается по F3, а не W5.

В одном примере видна разница между жизненным циклом объекта и жизненным циклом его исполнения. Это две разные вещи, хотя в простых библиотеках они часто смешиваются.

## XII. Публичный API: небольшая поверхность с довольно богатой семантикой

Все десять операций доступны без добавления новых реактивных сущностей.

| Операция                 | Реальное свойство                                                   |
| ------------------------ | ------------------------------------------------------------------- |
| `signal(value)`          | Создаёт записываемый источник с `Object.is`-семантикой              |
| `computed(fn, initial?)` | Ленивое вычисление с доступом к последнему committed-значению       |
| `effect(fn)`             | Наблюдатель с cleanup, доставкой и восстановлением после исключений |
| `get(x)`                 | Актуализирует значение и регистрирует зависимость                   |
| `peek(x)`                | Актуализирует без регистрации зависимости                           |
| `set(s, value)`          | Фиксирует изменение и распространяет invalidation                   |
| `update(s, fn)`          | Вычисляет новое значение без tracking и записывает его              |
| `dispose(x)`             | Терминально отсоединяет computed или effect                         |
| `batch(fn)`              | Откладывает исполнение watchers                                     |
| `untracked(fn)`          | Временно приостанавливает наблюдение зависимостей                   |

Особенно интересны здесь `computed`, `peek` и `update`.

### `computed(prev => next, initial)`

Функция получает последнее успешно зафиксированное значение.

Если исполнение упало, `prev` не меняется.

Если несколько записей схлопнулись в один пересчёт, `prev` тоже продвинется ровно на одно успешное вычисление.

Это позволяет реализовывать накопители, инкрементальные вычисления и пользовательскую эквивалентность без отдельного comparator в ядре.

Например:

```
const rounded = computed((prev) => {
  const next = Math.round(get(source));

  return prev === next ? prev : next;
}, 0);
```

Возврат `prev` обеспечивает cutoff через существующий `Object.is`.

В общем случае пользователь может возвращать прежнюю ссылку для сложной структурной эквивалентности, даже если новый результат вычислялся отдельно.

Здесь нет новой подсистемы equality. Возможность возникает из уже существующего механизма фиксации значения.

### `peek` не означает «прочитать устаревший кеш»

`peek(x)` выполняет refresh, как `get(x)`, но не регистрирует отношение между текущим потребителем и `x`.

Это эквивалент `untracked(() => get(x))` без необходимости создавать callback-обёртку.

Разница важна: некоторые реактивные библиотеки называют `peek` операцию, которая просто возвращает кешированное значение. Quant гарантирует актуализацию.

### `update` не превращает write в read

```
update(counter, (current) => current + get(step));
```

Здесь callback исполняется без tracking.

Поэтому ни `counter`, ни `step` не становятся автоматически зависимостями внешнего вычисления, внутри которого вызван `update`.

Если callback бросит исключение, запись не произойдёт.

Это логично: `update` относится к стороне изменения состояния, а не к стороне наблюдения.

### Типовая система не подменяет runtime

`Readable<out T>` ковариантен по прочитанному значению.

`Computed<out T>` также только читается.

`Signal<in out T>` инвариантен, поскольку значение сигнала можно и прочитать, и записать.

Эти различия выражены через уникальные символы TypeScript. В работающей JavaScript-программе публичные handles остаются непосредственно узлами.

С точки зрения интеграции это сохраняет минимальную цену API-обёрток.

При этом типы не могут гарантировать отсутствие всех динамических циклов или reentrant-demand. Именно поэтому существует отдельная граница C1.

## XIII. Две независимые шкалы времени внутри одного графа

Есть свойство, которое легко пропустить, рассматривая версии и поколения отдельно.

В Quant существуют две принципиально разные истории.

`Node.ver` отвечает на вопрос: изменилось ли наблюдаемое значение?

`Node.gen` отвечает на вопрос: сколько успешных исполнений подтвердило конфигурацию зависимостей?

Они не обязаны изменяться одновременно.

Версия значения и поколение исполнения

| Событие                                | ver | gen |
| -------------------------------------- | --- | --- |
| Успешный computed, результат изменился |     |     |
| Успешный computed, результат прежний   |     |     |
| Computed бросил исключение             |     |     |
| Запись нового значения в signal        |     |     |

Стрелка означает изменение счётчика. У обычного сигнала нет исполняемого callback, поэтому его `gen` не продвигается.

Эти две шкалы позволяют Quant разделить два вопроса, которые многие системы пытаются выразить одним состоянием «актуально/неактуально».

Результат может не измениться, хотя вычисление успешно прошло и изменило конфигурацию зависимостей.

И наоборот: выполнение может закончиться ошибкой, но во время него появились важные новые зависимости, способные впоследствии запустить восстановление.

Это объясняет, почему нельзя просто удалить `gen`, объявив его избыточным по отношению к `ver`.

`ver` фиксирует историю наблюдаемых результатов. `gen` фиксирует историю подтверждения графа.

Их независимость является одной из причин, почему Quant одновременно поддерживает cutoff и точное восстановление после ошибок.

## XIV. Цена корректности: что остаётся в hot path

Здесь нужно отделить архитектурную экономию от времени исполнения конкретных инструкций.

У Quant нет обещания, что каждое чтение сигнала быстрее, чем у любого конкурента.

Даже самый простой untracked read должен загрузить состояние узла и его значение. Для отслеживаемого чтения добавляются доступ к активному потребителю, курсору, очередному ребру и версии источника.

По аудиту кода 1.1.2 стабильный tracked hit требует пяти чтений полей объектов, не считая доступа к регистрам контекста. При этом не происходит ни поиска отношения, ни выделения памяти.

В свежем cost-probe из CI на AMD EPYC 9V74 получились следующие показатели:

Leaf costs, Node 22.23.4, CI 1.1.2

| Операция                     | Quant   | Alien 3.2.1 |
| ---------------------------- | ------- | ----------- |
| Публичное чтение             | 1.48 нс | 1.30 нс     |
| Публичная запись             | 2.21 нс | 1.39 нс     |
| Kernel write без вызова host | 1.38 нс | —           |

Из [Benchmark run 42794143933](https://github.com/volynetstyle/reflex-quant/actions/runs/42794143933?utm_source=chatgpt.com), cost leaf. Наносекундные цифры зависят от CPU, V8 и устройства измерения.

Неприятная, но полезная деталь: разница между kernel write и публичным `set` здесь составляет примерно 0.83 нс.

В существенной мере это стоимость проверки, требуется ли запуск host-drain.

При этом она покупает вполне реальную функциональность: доставка observers и соблюдение выбранных правил исполнения.

У этой системы нет бесплатного волшебства. Её преимущество должно проявляться не только в минимальной цене отдельной инструкции, но и в количестве работы, которое не пришлось выполнить на сложном графе.

### Модель стоимости гораздо интереснее сравнения `get()` и `set()`

Внутри Quant существуют несколько режимов нагрузки.

| Режим                             | Структурная цена                                          |
| --------------------------------- | --------------------------------------------------------- |
| Стабильный порядок чтений         | O(1) на tracked read                                      |
| Непосредственный повтор чтения    | O(1), без нового отношения                                |
| Небольшая перестановка            | Ограниченный поиск, часто без индексирования              |
| Широкая произвольная перестановка | Линейная подготовка индекса, затем O(1) поиск пары        |
| Изменение состава зависимостей    | Создание и удаление только реально изменившихся отношений |
| Глубокое распространение          | Итеративный обход, не ограниченный глубиной JS call stack |
| Успешный проход                   | Удаление непрочитанного суффикса                          |
| Неудачный проход                  | Сохранение committed и последней tentative-информации     |

Смысл этих границ состоит не в том, что каждая возможная операция занимает постоянное время.

Смысл в том, что алгоритм не должен внезапно переходить к квадратичному tracking только потому, что пользователь изменил порядок чтения нескольких сотен зависимостей.

У текущего механизма существует контролируемый переход от дешёвого cursor-hit к более дорогому, но линейному построению точного индекса.

Именно этот переход является одной из главных инженерных заслуг Quant.

### Работа с V8: оптимизация уже не по исходному коду

В исследовании проверялись формы доступа к объектам, байткод, inline-решения и деоптимизации.

И там обнаружилось несколько неприятных, но полезных фактов.

Уменьшение количества обращений к полям в TypeScript не обязательно уменьшает количество машинных загрузок. Оптимизатор мог уже устранить повторный доступ.

Вынос переменной из условия не обязательно ускоряет код. Он может изменить компиляцию функции и ухудшить отдельный hot path.

Более короткий `verify` не обязательно будет встроен в вызывающую функцию. Maglev и TurboFan принимают разные решения.

Поэтому Quant сохраняет в исследовательских материалах и отклонённые оптимизации.

Например, передача уже загруженных флагов в `pull` сохраняла корректность и экономила обращение к объекту, но замедляла узкий сценарий стабильного трекинга примерно на 16% в локальном измерении.

Её не приняли.

Это правильная дисциплина. Иначе можно очень быстро построить runtime, исходный код которого выглядит идеально оптимизированным, а V8 на практике исполняет его хуже. Оптимизатор, к сожалению, не читает архитектурные манифесты.

Основание: [ACCESS-AUDIT.md](https://github.com/volynetstyle/reflex-quant/blob/main/research/ACCESS-AUDIT.md?utm_source=chatgpt.com), [ENGINE-FEEDBACK.md](https://github.com/volynetstyle/reflex-quant/blob/main/research/ENGINE-FEEDBACK.md?utm_source=chatgpt.com).

## XV. Производительность: свежая картина 1.1.2

Последний доступный запуск на рассматриваемом коммите завершился успешно 10 ноября 2026 года.

Он сравнивает Quant с фиксированным Reflex `bf71877` и Alien Signals `3.2.1` на 18 собственных сценариях проекта.

Geomean к лучшему сопернику

# 1.03×

Меньше лучше

Быстрее обоих

# 7/18

Сценариев

В пределах +25%

# 17/18

От лучшего

Мой пересчёт по опубликованным медианам 18 сценариев CI, с округлением. Это не результат внешнего JS Reactivity Benchmark.

Где Quant выигрывает, а где платит за свою архитектуру

0×0,4×0,8×1,2×1,6×batch.writesshared-chaoticbranch.switchfan-out.effectsreplace-halfdiamondfan-inlifecycle.mountstable.wide-256reorder.rotatelong-reorderstatic.read-cleanvalue-sort

Избранные сценарии CI 1.1.2. Значения ниже 1.00 означают преимущество Quant; выше 1.00 означают преимущество лучшего из двух соперников. Все результаты измерялись внутри соответствующих jobs, не сравнением абсолютного времени разных runners.

Что показывают эти данные?

На `batch.writes-32` Quant примерно на 45% быстрее лучшего конкурента по времени сценария. На `shared-chaotic.64x32` преимущество около 22%.

На `branch.switch-100` он также впереди, что особенно важно для библиотеки с динамическими зависимостями.

Но на `value-sort.256x32` Quant в этом запуске оказался примерно на 43% медленнее Reflex. Произвольные перестановки и некоторые стабильные чтения тоже остаются дорогими относительно лучшего конкурента.

Общий геометрический коэффициент Quant к Reflex составил приблизительно 0.994, практически паритет на этой выборке. К Alien Signals он составил около 0.455, то есть суммарный профиль существенно быстрее на выбранных нагрузках.

Самое интересное: обе картины могут быть правдой одновременно.

Alien Signals имеет очень дешёвые элементарные операции, но на этих динамических перестановках выполняет значительно больше структурной работы. Quant может проиграть отдельный `get`, но выиграть графовое обновление благодаря повторному использованию отношений.

Reflex, в свою очередь, имеет специализированные алгоритмы для перестановок, и они действительно иногда обходят Quant. Поэтому утверждение «все механизмы Reflex были избыточны» неверно.

Некоторые из них дают вполне измеримые преимущества, просто цена этих преимуществ выражается в архитектурной сложности.

### Почему результат изменился относительно старого отчёта

В `research/REPORT.md` сохранился исторический снимок `241a3b7` с геометрическим коэффициентом 0.97 к лучшему сопернику и восемью победами из 18.

Свежий запуск 1.1.2 показывает 1.03 и семь побед.

Это не доказывает, что новая версия в целом стала медленнее.

Бенчмарки выполнялись на разных процессорах; часть нагрузок и сборочной конфигурации менялась; абсолютные времена нельзя корректно сравнивать между разными runners.

Для оценки именно изменений 1.1.1 → 1.1.2 необходим контролируемый A/B на одной машине и одинаковом наборе нагрузок.

Внутренние локальные эксперименты по удалению лишних полей и сокращению стека показывают положительные результаты на отдельных сценариях, но переносить их на всю систему без измерения было бы неправильно.

Проверенные источники: [Benchmark 1.1.2](https://github.com/volynetstyle/reflex-quant/actions/runs/42794143933?utm_source=chatgpt.com) и [история измерений](https://github.com/volynetstyle/reflex-quant/blob/main/research/HISTORY.md?utm_source=chatgpt.com).

## XVI. Доказательная база: что именно проверено

Здесь Quant отличается от многих небольших экспериментальных библиотек.

Обычно у новой реализации имеется набор unit-тестов и несколько бенчмарков. Если она проходит тесты и быстро исполняет `signal.set`, автор объявляет архитектуру удачной.

В Quant применяется более строгая схема.

### Семантика не выводится из поведения конкурента

Контракт Quant зафиксирован отдельно от реализации.

Он был получен из исполняемой спецификации Reflex, но после этого стал самостоятельным исследовательским объектом.

В него внесены три явно документированных решения: D1, D2 и D6.

D1 разрешает экзистенциальную валидацию computed.

D2 разрешает не проверять старый frontier неудачного computed перед новой попыткой.

D6 задаёт P5, то есть сохраняет факт изменения источника после первого наблюдения внутри прохода.

Это не скрытые несовместимости. Их происхождение и свидетели указаны в контракте.

### Дифференциальное тестирование

В документированном основном корпусе содержится:

## 27 061

Bounded programs

## 18 660

Recovery programs

## 100 000

Generated programs

Всего 145 721 программы основного корпуса без обнаруженных расхождений Quant с его executable contract oracle.

Проверяются не только результаты вычисления. После операций также проверяется целостность графа: согласованность двусвязных списков, единственность отношений, отсутствие потерянных слотов и другие структурные свойства.

Дополнительно существуют генераторы для широких вложенных индексов, ошибок, recovery, disposal и линейности повторных попыток.

Это гораздо содержательнее простого «все тесты зелёные».

### Мутационное исследование

В исследовательском отчёте зафиксированы 34 абляции механизмов, каждая из которых ломает хотя бы один тест. Семь дополнительных абляций относятся к development-диагностике C1.

В более позднем состоянии репозитория документация говорит о 46 проверяемых mutation anchors после добавления новых механизмов и исправлений.

Но здесь есть важное логическое ограничение.

Если удаление механизма приводит к падению теста, это доказывает, что данная реализация без этого механизма и без замены нарушает требование.

Это не доказывает, что любая мыслимая реализация обязана иметь точно такой же механизм.

Именно поэтому `WITNESS-AUDIT.md` разделяет семантические обязательства, структурные ограничения, соглашения порядка и детали конкретной конструкции.

В научном смысле это гораздо более сильная постановка, чем заявление об абсолютной минимальности.

Минимальность Quant означает «наименьший известный набор механизмов для данного контракта и выбранной машинной модели», а не математически доказанную единственную возможную архитектуру.

### Проверка текущего релиза

Для 1.1.2 опубликованы:

Development

# 172/172

Тесты пройдены

Production

# 165

Пройдены; 7 dev-only тестов пропущены

Текущая [CI-сборка прошла успешно](https://github.com/volynetstyle/reflex-quant/actions/runs/42794143769?utm_source=chatgpt.com). Проверены также typecheck, lint, release build и совпадение минифицированной и неминифицированной сборок на 18 сценариях и 5 400 шагах.

Релиз доступен в ESM и CommonJS, с отдельными development-вариантами.

## XVII. C1: граница, которую нельзя выдавать за гарантию

Самое важное ограничение безопасности текущей архитектуры связано с demand на вычисление, которое уже находится в процессе исполнения или валидации.

Простейший пример:

```
let a: Computed<number>;

a = computed(() => get(a) + 1);

get(a);
```

Такой цикл не может иметь обычного конечного результата.

Но существует более сложная разновидность: computed ещё не закончил валидацию, а другое вычисление повторно пытается прочитать его.

Тогда опасность состоит не только в бесконечной рекурсии. Можно незаметно вернуть старое cached-значение, принять его за актуальное и оставить узел в ложном чистом состоянии.

Quant определяет C1 как предусловие: программа не должна требовать значение вычисления, пока его собственная оценка или проверка ещё продолжается.

Development build обнаруживает нарушение и бросает `Cycle detected`.

В production build полноценная диагностика валидационного цикла сознательно не гарантируется. Проверка непосредственно исполняемого `BUSY`-узла остаётся, но не все формы reentrant-demand обязаны диагностироваться.

Это не мелочь.

В production нарушение C1 находится за пределами определённой семантики, кроме сохранения целостности графа и заявленных структурных ограничений.

Здесь сделан вполне конкретный компромисс: дополнительные проверки ради диагностики неправильных программ не должны постоянно нагружать корректные программы.

А наиболее любопытная реализационная деталь в том, что dev-only `CHECKING` использует тот же бит, что production `WOKEN`, поскольку computed и watcher не могут одновременно быть одним и тем же типом узла.

Не добавляется новый битовый разряд в маски, а диагностические записи компилируются из production.

И это снова тот же мотив: поиск уже существующего взаимно исключающегося состояния.

## XVIII. Чего у Quant нет, и почему это важно

Теперь стоит перечислить границы системы. Здесь легко переоценить её возможности.

Quant не предоставляет полноценные effect scopes, ownership tree для компонентов, DOM scheduler, асинхронные ресурсы, транзакционное состояние, автоматическую приостановку неиспользуемых подграфов или управление компонентным жизненным циклом.

Он не обещает, что unwatched computed автоматически удалится из памяти или что retained dependency frontier будет освобождён без явного disposal.

Также он не пытается быть совместимым со всеми правилами чужих signal-runtime.

Это не недостаток полноты исследования. Это выбранная граница его контракта.

Но отсутствие этих возможностей имеет последствия.

Например, если приложение создаёт тысячи effects на протяжении жизни компонентов, ему потребуется собственная система владения, которая гарантирует их disposal.

Если требуется асинхронная транзакция с атомарной публикацией нескольких значений, существующего `batch()` недостаточно.

Если нужен scheduler с фазами render/commit/after, reference host придётся заменить или расширить поверх kernel.

И здесь появляется интересная перспектива.

Quant не является маленьким фреймворком. Он является сравнительно самостоятельной семантической машиной, на которой фреймворк может быть построен.

Разница огромная.

Фреймворк, у которого жизненный цикл компонентов прошит в структуру reactive edges, постепенно превращает каждое изменение ownership в изменение алгоритма графа.

Система с отдельным kernel может оставить отношение зависимости отношением зависимости, а компонентное владение реализовать отдельно.

Однако это архитектурная возможность, а не уже доказанная интеграция с любым будущим фреймворком.

## XIX. Что Quant обнаружил в самом Reflex

Одна из наиболее ценных сторон исследования заключается в том, что оно начиналось не с конкуренции бенчмарков.

Вопрос был не «как сделать Reflex быстрее?».

Вопрос был «какие механизмы действительно следуют из его семантических обязательств?».

В результате удалось удалить целые категории внутренней инфраструктуры: tape, tracking stamps, глобальные часы трекинга, finger/lockstep-механизмы и ряд специальных runtime-состояний.

При этом сохранились более фундаментальные свойства: двунаправленные связи, два уровня инвалидированности, точное отслеживание, отложенный disposal, валидация и выполнение без рекурсивных обходов.

Но также обнаружились разногласия между executable spec и фиксированной реализацией Reflex.

Особенно интересен D5.

После ошибки watcher может сохранить обязанность на повторное исполнение. В некоторых сценариях Reflex, по результатам исследования на зафиксированном baseline, теряет эту обязанность, если промежуточный computed при последующей проверке не изменил своё значение.

Quant в таком случае следует собственному контракту и сохраняет долг исполнения.

Важно, что это не автоматическое доказательство неправильности всех версий Reflex. Это конкретное расхождение между определённым контрактом R2 и проверенным снимком реализации.

Получается неожиданная ситуация: попытка реконструировать более компактную реализацию исходной модели обнаруживает, что сама исходная реализация местами отклоняется от своей декларативной семантики.

Quant здесь выступает не просто альтернативой, а инструментом проверки архитектурных предположений Reflex.

Именно поэтому нельзя рассматривать его отдельно от истории исследования. Без неё сокращение числа полей кажется косметической оптимизацией. С ней становится видно, какие факты оказались независимыми, а какие были просто разными представлениями одной информации.

## XX. Главная неочевидная связь: Quant минимизирует не код, а количество независимых истин

Теперь можно собрать все механизмы в одну картину.

Какие факты повторно используются внутри машины

Рассмотрим получившиеся зависимости между решениями.

Версии отношений позволяют выполнять cutoff и валидацию, но одновременно сохраняют свидетельство изменения внутри исполнения.

Поколения помогают точно разделять committed и tentative-отношения, поэтому не требуется отдельный журнал подтверждения каждого ребра.

Положение курсора и непрерывный суффикс позволяют вычислять режим tracking, не сохраняя его отдельными флагами.

Слот источника позволяет искать пары за O(1) после индексирования, а его прежнее значение можно восстановить по `Edge.from`, не сохраняя ещё одну ссылку на Node.

Общий work stack используется для push, pull и tracking, но его размер контролируется на выходах всех трёх производителей.

Host уже владеет фактом queued/not queued, поэтому kernel не обязан поддерживать вторую самостоятельную систему подтверждения доставки.

И всё это приводит к одной мысли.

Хороший runtime может становиться проще не потому, что решает меньше задач, а потому, что перестаёт хранить одну и ту же истину в нескольких местах.

Но у этого подхода есть и обратная сторона.

Чем больше логических свойств выводится из общих структурных инвариантов, тем сильнее корректность отдельных операций зависит от сохранения этих инвариантов.

Удаление `Marked` становится возможным лишь пока непрочитанные рёбра действительно образуют непрерывный суффикс.

Удаление `Indexed` становится возможным лишь пока ownership слотов восстанавливается строго.

Объединение стеков остаётся корректным лишь пока каждый вложенный проход возвращает `top` к своему сохранённому основанию.

Иными словами, Quant уменьшает количество явного состояния, но повышает роль локальных доказательств о представлении.

Это не бесплатная простота. Это перенос сложности из множества синхронизируемых полей в небольшое количество более сильных инвариантов.

Именно в этой точке проект становится интересен исследователю языков программирования, а не только автору UI-библиотек.

## XXI. Моя оценка архитектуры

У Quant есть три особенно сильные стороны.

Первая: он рассматривает семантику как самостоятельный объект. Корректность определяется не тем, что библиотека проходит тесты конкурента, и не тем, что ей удалось выиграть бенчмарк. Сначала выбираются обязательства, потом выводятся механизмы, затем измеряется цена.

Вторая: он действительно проверяет необходимость внутренней сложности. Удаление `Node.last`, `Indexed`, `Marked`, старого `RETRY` и дублирующего элемента displaced stack возникло не из желания сделать код короче, а из обнаружения эквивалентной информации, уже присутствующей в машине.

Третья: у него появились достаточно убедительные структурные результаты. Отсутствие аллокаций при перестановках, линейные верхние границы tracking, ограниченная рабочая память после глубоких проходов, сохранение корректности после исключений и самоуничтожения наблюдателей являются гораздо более содержательными характеристиками, чем один рекорд скорости `signal.get()`.

Слабые стороны тоже видны.

Точный tracking остаётся сравнительно сложным и требует аккуратного поддержания локальных сертификатов. Его механизмы нельзя бездумно переносить в другую структуру графа. Широкие хаотичные перестановки всё ещё могут стоить дороже, чем специализированные механизмы Reflex.

Reference host предельно конкретен. Для производственного UI-окружения может потребоваться собственная политика scheduling и ownership, которую ещё нужно проверить на совместимость и стоимость.

C1 в production является предусловием, а не полной гарантией безопасного поведения произвольных реентерабельных программ.

Наконец, минимальность пока является экспериментально обоснованной архитектурной позицией, но не доказанной глобальной нижней границей для всех возможных реактивных машин.

Последнее, однако, открывает наиболее интересную исследовательскую возможность.

Сейчас Quant показывает, что конкретная машина с небольшой системой инвариантов способна реализовать довольно богатую реактивную семантику. Следующий уровень теории заключался бы в установлении того, какие сведения нужны любой машине, удовлетворяющей этим обязательствам, независимо от её представления.

Например, можно ли доказать минимальное количество независимых фактов на отношение для точного recovery? Какие гарантии требуют постоянного дополнительного состояния, а какие могут выводиться из положения ребра в графе? При каких ограничениях однослотовая индексация является асимптотически оптимальной?

Здесь уже начинается не соревнование библиотек, а исследование вычислительных моделей.

## Эпилог. Что Quant на самом деле представляет собой

Quant не является сокращённым Reflex.

И не является Alien Signals с дополнительными проверками.

Он представляет собой результат более необычного эксперимента: взять достаточно богатую семантику, удалить архитектурную историю её реализации и попробовать восстановить машину, исходя только из необходимых обязательств.

В таком эксперименте особенно ценны не выигранные наносекунды.

Ценны моменты, когда выясняется, что целая подсистема была необходима лишь потому, что другая подсистема не использовала уже существовавшее свидетельство.

Именно это произошло с несколькими флагами трекинга, дублированием стека, обработкой retry и хранением курсора в Node.

При этом оставшиеся механизмы не выглядят случайным набором оптимизаций. Они образуют достаточно связную конструкцию: версии хранят историю изменений, поколения хранят историю успешных подтверждений, отношения обеспечивают двустороннюю структуру графа, локальный контекст позволяет выполнять вложенные проходы, а host превращает реактивные обязательства в наблюдаемые действия.

В этом и состоит наиболее сильный результат Quant 1.1.2: он демонстрирует, что выразительная реактивная семантика может опираться на гораздо меньший набор независимых механизмов, чем предполагала архитектура, из которой она была первоначально извлечена.

Не на единственный доказанно минимальный набор. Но на практически работающий, проверенный большим корпусом программ, измеренный на разных нагрузках и достаточно компактный, чтобы всю его причинную модель можно было проследить от входного `get()` до последнего удалённого `Edge`.

И пожалуй, это гораздо интереснее ещё одной библиотеки, которая объявила себя самой быстрой.

### Основные материалы исследования

Для прямой проверки анализа: [kernel.ts](https://github.com/volynetstyle/reflex-quant/blob/main/src/kernel.ts?utm_source=chatgpt.com), [graph.ts](https://github.com/volynetstyle/reflex-quant/blob/main/src/graph.ts?utm_source=chatgpt.com), [host.ts](https://github.com/volynetstyle/reflex-quant/blob/main/src/host.ts?utm_source=chatgpt.com), [формальный контракт](https://github.com/volynetstyle/reflex-quant/blob/main/CONTRACT.md?utm_source=chatgpt.com), [журнал конструктивных решений](https://github.com/volynetstyle/reflex-quant/blob/main/research/LOG.md?utm_source=chatgpt.com), [исследовательский отчёт](https://github.com/volynetstyle/reflex-quant/blob/main/research/REPORT.md?utm_source=chatgpt.com), [аудит необходимости механизмов](https://github.com/volynetstyle/reflex-quant/blob/main/research/WITNESS-AUDIT.md?utm_source=chatgpt.com) и [ветка padawan](https://github.com/volynetstyle/reflex-quant/tree/padawan?utm_source=chatgpt.com), где та же семантика изложена в более учебной форме.

Именно сочетание текущего ядра, контракта, design log, тестовых свидетелей и результатов CI даёт полное представление об архитектуре. Один README, каким бы хорошим он ни был, этого не заменит.