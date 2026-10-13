# Scene format 1.0.0

Авторитетные типы: `src/types/scene.ts`. Формат расширяемый: будущие потребители должны игнорировать неизвестные поля, но проверять major schemaVersion.

## MotionProject

- `schemaVersion`: `1.0.0`.
- `source`: Figma, pageName/pageId страницы на момент начала экспорта.
- `canvas`: width/height первой сцены, `sizing: first-scene`. Не нормализует размеры других сцен.
- `assets`: успешно записанные физические ресурсы. `assetId`, kind, относительный path, mimeType, byteLength; imageHash для images, figmaNodeId для SVG/fallback.
- `scenes`: окончательный UI-порядок Frames; index начинается с 0.

## Scene / Node

Scene расширяет Node: `sceneId`, `index`, `width`, `height`, `fills`, `background`, `opacity`, `clipsContent`, `transform`, `preview` (если экспортирован). `transform` — relativeTransform исходного Frame относительно его исходного родителя.

Каждый Node:

- `figmaNodeId`: исходный node.id, без matching между сценами.
- `name` и `alias`: исходное имя слоя. Не являются уникальными ID.
- `type`: исходный Figma тип.
- `parentId`: исходный родитель в Figma; для корневой Scene может ссылаться на страницу/контейнер вне экспорта. Это ссылка происхождения, не путь файла.
- `layerOrder`: индекс в исходном children, снизу вверх (Figma child array order); у выбранных root Frames соответствует окончательному index сцены.
- `children`: дерево в исходном порядке, включая скрытые узлы и дочерние узлы Instances.
- `sceneTransform`: 2×3 affine matrix в пространстве выбранного Frame.
- `origin`: `(0,0)` в локальных пикселях геометрии, верхний левый угол. Поворот/масштаб/перенос уже учтены матрицей; центр вращения не угадывается.
- `properties`: доступные исходные поля Figma из явного allowlist. Здесь x/y/width/height/rotation, relativeTransform, absoluteTransform, bounds, visible/locked/opacity/blendMode, fills/strokes/effects, radii, masks/clipping, stroke/vector геометрия, layout, style/variable references.
- `text`: только у TEXT; characters, node-level typography, segment-level typography и start/end.
- `svgAssetId` / `fallbackAssetId`: только если файл действительно зарегистрирован.
- `serializationError`: если узел удалось сохранить только частично.

`undefined` поля не записываются. Отсутствующее свойство не означает значение 0 или false. `figma.mixed` становится `{ "mixed": true }`. Non-finite numbers считаются ошибкой сериализации свойства.

## Матрицы

```text
[[a, c, tx],
 [b, d, ty]]

x' = a*x + c*y + tx
y' = b*x + d*y + ty

sceneTransform(node) = inverse(absoluteTransform(frame)) * absoluteTransform(node)
```

Колонковые векторы, пиксели, координатная система Figma. `relativeTransform` относительно непосредственного родителя; `absoluteTransform` относительно страницы Figma. `x`/`y` сохраняются для справки; renderer должен использовать матрицы и иерархию, а не суммировать x/y вложенных повёрнутых объектов. `rotation` — исходные градусы Figma; не нужно применять её ещё раз поверх матрицы. Матрица выбранного Frame в scene coordinates — единичная. Не делается округление.

## Paint / изображения

Paint сохраняет все enumerable поля официального Paint API. У `IMAGE` добавляется `assetId` успешно извлечённого оригинала. `imageHash` остаётся для provenance/deduplication. `imageTransform` — API crop transformation при scaleMode CROP, `scalingFactor` — TILE, остальные scaleMode/rotation/opacity/filters/blendMode сохраняются как есть.

`clipping` у image Paint описывает геометрию владеющего узла и необходимость учитывать ancestor clipping. Фактические клипы/маски/контуры находятся в дереве, `properties.clipsContent`, `isMask`, `maskType`, paths и radii. Это метаданные для будущего renderer, не дополнительная crop-матрица.

При невозможности извлечь оригинал: `assetStatus: missing`, assetId отсутствует; ошибка в отчёте и при возможности `fallbackAssetId` узла. PNG fallback — визуальное представление узла целиком, не исходное изображение.

## Векторы / текст

`properties.vectorPaths` сохраняет data и windingRule, если API предоставляет это поле. `vectorNetwork`, strokeGeometry/fillGeometry сохраняются, если доступны. Stroke weight/cap/join/align, gradientStops/gradientTransform содержатся в properties и Paints. SVG является дополнительным визуальным ресурсом; shape/path semantics для Trim Paths не гарантируются.

Текстовые segment indices используют UTF-16 code units, end exclusive. Mixed node-level значения не заменяют segments. Файлы шрифтов отсутствуют. В будущем восстановление текста требует matching font family/style/weight и поддержки типографики renderer.

## Referential integrity

Все пути относительны корню `motion-project/`. Asset references разрешаются через assets[].assetId → assets[].path. Preview — прямой относительный путь. Перед упаковкой UI проверяет существование каждого зарегистрированного asset/preview и каждой asset reference. Node IDs/style IDs/page IDs — идентификаторы источника, не внешние файлы, которые нужно искать в архиве.

Имена файлов стабильны для неизменённых ID/hash. Scene JSON может меняться при изменении имени страницы/слоёв/свойств. `exportedAt` в отчёте всегда новый; byte-for-byte одинаковый ZIP не обещается.
