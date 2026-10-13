# Motion Exporter — Phase 1

Локальный Figma Design Plugin: выбранные Frames → структурированный `scene.json`, исходные изображения, SVG, PNG-превью и отчёт в одном ZIP. Без сервера, CDN, AI, MCP, анимации и изменения исходного документа.

## Быстрый старт

Требуется Node.js 20.19+ и npm. В этой папке:

```sh
npm ci
npm run check
```

`npm run check` выполняет строгую проверку TypeScript, автоматические тесты и сборку. `npm run build` обновляет `dist/main.js` и автономный `dist/ui.html`. JSZip включён в HTML локально. `package-lock.json` фиксирует зависимости; typings Figma — 1.141.0.

### Установка в Figma Desktop

В пустом проекте нет ID, выданного Figma. `manifest.json` намеренно не содержит выдуманного ID. До первого импорта нужно получить настоящий development ID:

1. Откройте Figma Desktop и документ **Figma Design**.
2. Откройте меню **Plugins → Development → New plugin…** (в некоторых версиях: **Plugins → Manage plugins → Development → + → New plugin**).
3. Назовите плагин **Motion Exporter**, выберите **Figma Design**, шаблон с UI/Custom UI и сохраните сгенерированный проект **в отдельную временную папку**, чтобы не перезаписать исходники этого проекта.
4. Скопируйте числовое значение `id` из созданного Figma `manifest.json`. Затем в этой папке выполните:

   ```sh
   npm run set-plugin-id -- ВАШ_ЧИСЛОВОЙ_ID
   npm run build
   ```

   Подставьте ID вместо `ВАШ_ЧИСЛОВОЙ_ID`. Команда откажется заменять уже сохранённый другой ID.
5. Выберите **Plugins → Development → Import plugin from manifest…** и укажите **manifest.json из этой папки**. Если Figma уже зарегистрировала временный scaffold с тем же ID, удалите его из списка development plugins и импортируйте этот manifest. Исходники scaffold для дальнейшей работы не нужны.
6. Выделите один или несколько **FRAME**, запустите **Plugins → Development → Motion Exporter**.
7. Проверьте порядок, измените его кнопками ↑/↓ и нажмите **EXPORT STORYBOARD**.
8. Сохраните скачанный `motion-project.zip`, распакуйте. При необходимости нажмите **Download ZIP again**.

Если проект уже содержит ID, выданный Figma, сохраните его: повторная генерация не требуется. Development ID не является заявлением о публикации плагина в Community.

## Что реализовано

- Чтение выбранных Frames текущей страницы с `documentAccess: dynamic-page`; другие выбранные типы отмечаются как проигнорированные.
- Автоматический числовой порядок, если **все** имена начинаются с числа и разделителя; иначе порядок по абсолютным X, затем Y и ID. UI позволяет вручную переставить сцены. Разные размеры сохраняются с предупреждением.
- Рекурсивное дерево: FRAME, GROUP, TEXT, RECTANGLE, ELLIPSE, LINE, VECTOR, POLYGON, STAR, BOOLEAN_OPERATION, COMPONENT, INSTANCE. Общие свойства и PNG fallback для остальных типов.
- Порядок дочерних слоёв, видимость, блокировка, opacity, blend mode, fills/strokes/effects, маски, clipping, radii, stroke geometry, vector network/paths, layout/constraints и доступные дополнительные свойства.
- Матрицы local/absolute/scene; преобразование в пространство сцены через обратную матрицу Frame. Размеры и координаты не округляются.
- `IMAGE` paints в fills, strokes, backgrounds и текстовых сегментах: `getImageByHash` + `getBytesAsync`, deduplication по imageHash. Оригинальные PNG/JPEG/GIF/WebP bytes сохраняются; расширение определяется по сигнатуре. Crop `imageTransform`, tile scaling, rotation, filters и остальные поля Paint сохраняются.
- Структурированный текст и `getStyledTextSegments`: UTF-16 start/end, шрифт, размер, вес, межстрочный/межбуквенный интервал, декорация, регистр, fills и дополнительные поля. Файлы шрифтов не копируются.
- SVG для графических примитивов, VECTOR и BOOLEAN_OPERATION через `SVG_STRING`; геометрия и градиенты сохраняются отдельно. `svgSimplifyStroke: false` сохраняет более точный вариант обводки.
- PNG-превью каждого Frame через Figma `exportAsync`, SCALE 1.
- ZIP в UI iframe, относительные пути и проверка существования всех зарегистрированных файлов и asset references перед скачиванием.
- Прогресс, ошибки, повторное скачивание, отчёт. Ошибки отдельных ресурсов допускают экспорт остальных; транспортный сбой прекращает весь экспорт.

## Файлы результата

```text
motion-project/
├── scene.json
├── assets/
│   ├── images/image_<imageHash>.png|jpg|gif|webp
│   ├── vectors/svg_<encoded-node-id>.svg
│   └── fallbacks/fallback_<encoded-node-id>.png  # только при необходимости
├── previews/frame_<encoded-node-id>.png
└── export-report.json
```

Названия слоёв не участвуют в идентификации файлов. Кодирование node ID экранирует двоеточия и подчёркивания без коллизий. Scene ID основан на node ID; image asset ID — на Figma imageHash; SVG asset ID — на node ID. SVG представляет ресурс конкретного экземпляра, без content deduplication. После изменения документа тот же SVG path может содержать новые bytes. Для неизменённого документа IDs и ссылки стабильны; дата отчёта меняется.

## Формат данных

Схема `1.0.0` описана TypeScript-интерфейсами в `src/types/scene.ts` и пояснена в [docs/scene-format.md](docs/scene-format.md). Сцены содержат дерево узлов, а не набор плоских картинок. `canvas` использует размер первой сцены; индивидуальные `width`/`height` всегда авторитетны.

Исходные поля Figma находятся в `node.properties`, текст — в `node.text`. `sceneTransform` и идентификаторы находятся на уровне узла. На уровне сцены также вынесены `fills`, `background`, `opacity`, `clipsContent`, `transform`, размеры и порядок. Никакие logicalObjectId не создаются.

Отчёт содержит UTC ISO дату, количество frames/nodes/images/svg, warnings/errors, неподдерживаемые свойства, fallback-экспорты и ограничения. Nodes включает сами выбранные Frames. `images` — успешно извлечённые уникальные оригиналы; fallback PNG и previews в это число не входят. `warningCount` включает `unsupportedProperties`.

Если извлечение оригинала не удалось, Paint получает `assetStatus: "missing"`, но не несуществующий `assetId`. При возможности добавляется PNG визуального fallback всего узла. Успешный SVG также зарегистрирован как визуальный fallback сложной геометрии. Отсутствующий preview не получает путь. Наличие скачанного ZIP **не означает**, что все ресурсы извлечены: при ненулевом `errorCount` UI явно сообщает об ошибках.

## Память и локальность

Ресурсы обрабатываются последовательно. Main отправляет бинарные порции до 256 KiB и ждёт ACK каждой; base64 не применяется. UI собирает один файл в заранее выделенном Uint8Array, затем передаёт его JSZip. ZIP использует STORE: изображения уже сжаты, лишний проход DEFLATE не нужен. Итоговый Blob и буферы требуют памяти пропорционально размеру проекта. Лимит суммарных переданных данных — 512 MiB; фактический пик памяти может быть выше. При превышении лимита экспорт прерывается; выбирайте меньший набор Frames. ACK timeout — 30 секунд. После упаковки промежуточные буферы освобождаются; остаётся URL готового Blob для повторного скачивания.

Manifest запрещает сеть: `networkAccess.allowedDomains: ["none"]`. Main не пишет на диск. Скачивание выполняется стандартной ссылкой Blob в UI iframe. Выбор директории выполняет Figma/операционная система.

## Архитектура

```text
figma-motion-exporter/
├── manifest.json
├── package.json / package-lock.json / tsconfig.json
├── scripts/                   # сборка и сохранение Figma-issued ID
├── src/
│   ├── main.ts                # selection + transport + orchestration
│   ├── types/                 # scene/report и сообщения Main ↔ UI
│   ├── exporter/
│   │   ├── scene.ts / nodes.ts # чтение документа и дерево
│   │   ├── images.ts / vectors.ts / text.ts
│   │   ├── assets.ts / formats.ts
│   │   └── transforms.ts / serialization.ts / ordering.ts / errors.ts
│   └── ui/                    # интерфейс и ZIP packaging
├── tests/                     # чистые функции, mock API, bundle/transport
├── docs/scene-format.md
└── dist/main.js / ui.html     # готовая локальная сборка
```

## Проверки

Проверено в этом окружении: чистая установка `npm ci` и `npm run check` в отдельной временной папке; TypeScript без ошибок, **21/21 тестов**, сборка успешна.

Автоматические тесты покрывают матрицы rotation/scale/shear и singular case, ordering, сигнатуры форматов, mixed JSON, IDs, deduplication, сценарии 1–9 на mock Figma API, отказ ресурсов, прерывание транспорта, настоящий ZIP round-trip и передачу ресурсов собранным Main с ACK. Также проверяется синтаксис встроенного JavaScript готового UI HTML и получение выделения UI при `event.source: null` (регрессионная проверка моста Main → UI).

**Mock-тесты не заменяют Figma Desktop. Установка, реальный Figma exportAsync, фактическая визуальная точность SVG/preview и скачивание в Figma в этом окружении не проверены.**

Ручной приёмочный чек-лист в Figma:

| Тест | Действие | Проверка после распаковки |
|---|---|---|
| 1 | Один Frame с одноцветным фоном | Scene, fills, размеры, PNG-превью SCALE 1 |
| 2 | Текст RED Bold / COLLAR Regular | Characters, fontName/weight, start/end двух сегментов, выравнивание |
| 3 | Frame с PNG, отдельно с JPEG | Оригинальный файл; совпадение SHA-256 с исходником, корректное расширение |
| 4 | Один PNG в трёх Frames | Один image asset, три независимых node ID |
| 5 | Pen curve, gradient stroke, ROUND cap, без fill | vectorPaths/network, strokes/gradient, SVG; визуальное сравнение |
| 6 | Две вложенные повёрнутые группы | Parent IDs, layer order, local/absolute/scene matrices |
| 7 | Image CROP | Исходные bytes + imageTransform; исходник не заменён crop |
| 8 | Дважды экспортировать неизменённый документ | IDs и пути одинаковы; сравнить scene.json |
| 9 | Перенести ZIP на другой компьютер | Валидный JSON, все assets/previews существуют и открываются без Figma |
| UI | Поменять порядок ↑/↓, разные размеры, Unicode имена | Scene index соответствует UI, размеры сохранены, предупреждение видно |
| Ошибки | Большой набор ресурсов или unsupported node | Явное сообщение; отчёт; нет ссылок на отсутствующие файлы |

## Известные ограничения

- Официальный API предоставляет не всю внутреннюю модель Figma. Неизвестные поля не угадываются; поддерживаемые поля читаются по allowlist и проверке наличия. `figma.mixed` сериализуется как `{ "mixed": true }`; текстовые сегменты дают детализацию смешанных стилевых значений.
- SVG может содержать clipping, masks и превращённые в fill обводки. Геометрия не гарантирует готовность к Trim Paths. SVG/PNG — визуальные эталоны; renderer в этом этапе отсутствует.
- Стиль/variable ID сохраняется вместе с разрешёнными значениями. Definitions стилей/variables, исходные component definitions вне выбранных Frames и prototype interactions не экспортируются. Instance экспортируется как разрешённое дерево.
- Неизвестный формат изображения фиксируется как ошибка; bytes не маркируются ложным расширением. GIF сохраняется в том виде, в каком bytes возвращает Figma; сохранение исходной GIF-анимации Figma не гарантируется.
- Шрифты требуют установки в будущем renderer. Для недоступных ресурсов возможен только PNG всего узла; это явно отражено в отчёте.
- Глубокие/очень большие документы ограничены памятью и лимитами Figma exportAsync. Для размеров, превышающих ограничения PNG экспорта Figma, preview может завершиться ошибкой.
- Формат не определяет длительности, matching объектов, blocks, motion, timeline или анимацию.

Официальные источники: [Plugin manifest](https://developers.figma.com/docs/plugins/manifest/), [getStyledTextSegments](https://developers.figma.com/docs/plugins/api/properties/TextNode-getstyledtextsegments/), [Plugin API](https://developers.figma.com/docs/plugins/api/api-reference/). При изменении API обновляйте typings и повторяйте ручной чек-лист.

## Импорт в Motion Platform

ZIP импортируется через локальную Motion Platform: + NEW PROJECT → название и файл → Check ZIP → Create Project. Для существующего проекта: UPDATE FROM FIGMA. Плагин экспортирует только source-данные; project.json и notes создаёт платформа. После пересборки закройте окно плагина в Figma Desktop и запустите Plugins → Development → Motion Exporter повторно. Уникальный ID manifest сохраняется.
