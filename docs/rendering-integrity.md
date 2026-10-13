# SVG / Text Rendering Integrity

## Причины, подтверждённые кодом и воспроизведением

1. **Скрытая сцена и кэш маски.** Motion Runtime обрабатывает объекты всех сцен, включая `display:none`. Chromium возвращает нулевой `getBBox()` скрытого path. Маска рассчитывалась один раз и сохраняла неверные bounds до конца жизни DOM. Реальный объект 25:1654 воспроизвёл маску 0 × 0: стадии 0/25/50/75% совпадали, исходный объект появлялся только на 100% после снятия маски.
2. **Ширина reveal = strokeWidth × 8 + 2.** При реальной strokeWidth 178.627 получалось 1431.019px. Такая маска захватывала соседние изгибы и не соответствовала исходной траектории. Это не восстановление ширины исходной ленты.
3. **Потеря исходной маски.** Reveal заменял `mask` непосредственно на исходном path. При наличии source mask она не участвовала в промежуточных кадрах. Теперь effect wrapper пересекается с source mask/clip, не заменяя их.
4. **Принудительные caps/joins.** Reveal всегда использовал butt/round вместо исходных параметров. Caps, joins и miter limit теперь сохраняются.
5. **Font alias collisions.** Каждая сцена начинала имена с `motion-font-0`; в общем HTML более поздние @font-face могли подменить шрифты других сцен. Теперь aliases уникальны для блока/сцены. Это подтверждённая ошибка архитектуры, но конкретный ранее обрезанный текстовый объект не идентифицирован, поэтому нельзя утверждать, что именно она вызвала тот случай.
6. **Недостоверно названная QA length.** Внешний filled outline имел длину около 8298, centerline — около 3338. Reveal использует centerline; отчёт теперь отдельно хранит `sourceGeometryLengths` и фактические `lengths` reveal. Изменение dashoffset само по себе не доказывает видимость эффекта.

Короткий foreignObject с `overflow=visible` отдельно проверен в Chromium: сам по себе он не обрезает descenders. Произвольный padding или глобальное отключение clipping не применены.

## Исправления

- `motion/path-reveal.ts`: измерение неизменяемой source geometry в отдельном невидимом SVG viewport независимо от display родительской сцены; результат кэшируется на DOM path. Native stroke и filled stroke outline используют одну centerline, но исходный paint/d не меняется.
- Mask region для outline берётся из реального outline bbox; для native stroke добавляется вычисленная верхняя граница cap/join extent из ширины и miter limit. Это region маски эффекта, а не увеличение исходного объекта.
- Маска и исходный path находятся в отдельном wrapper. Own transform учитывается один раз; направление вычисляется из SVG transform chain, доступной и у скрытых сцен. На progress=1 clip/mask эффекта снимается. При удалении эффекта wrapper удаляется.
- `renderer.ts`: только stroke geometry получает Trim metadata; fills, image clips и дочерняя геометрия не назначаются через глобальную замену всех path. Original gradient, stroke outline, opacity и winding rule сохраняются. Exporter уже сохраняет vectorPaths/strokeGeometry/miter limit; его схема и manifest не изменены.
- `motion/presentation.ts`: scene-specific font aliases.
- Text geometry: явно видимый overflow без изменения ширины, font-size, line-height и source frame bounds; fonts.ready соблюдается в Preview и MP4.
- `motion/text-reveal.ts`: отдельный typed `maskReveal` только для TEXT. Его bounds учитывают source bbox и загруженные HTML line boxes, включая ascent/descent. `forward` раскрывает снизу вверх, `reverse` сверху вниз, остальные два направления горизонтальные. Slide/Fade/Overshoot не создают эту маску.
- SOURCE CLIPPING остаётся на внутреннем source group; EFFECT CLIPPING на отдельном wrapper; SCENE CLIPPING — viewport canvas. Иерархия, source masks и compositing не отключаются.

## QA и диагностика

Geometry/gradient/source transform integrity, mask bounds, actual path reveal и final-state pixel comparison выполняются обычным кодом и Chromium. Монотонность общего pixel count не используется.

Text glyph QA сравнивает реальный кадр с counterfactual естественной высоты HTML content и visible foreignObject overflow, сохраняя source ancestor masks/clipping. Эта проверка не доказывает соответствие неизвестного шрифта Figma. Invisible/unreachable endpoint получает NOT_TESTED, а не фиктивный PASS.

```sh
npm run render:object -- --project projects/test4 --scene <sceneId> --target <nodeId> --frame 135 --output artifacts/object-debug
npm run verify:rendering -- --project projects/test4 --output artifacts/rendering-check
```

Первый инструмент сохраняет baseline/animated PNG на прозрачном фоне и JSON с bbox, transforms, hierarchy, mask bounds, centerline, outline и font ascent/descent. Source clipping сохраняется; изоляция скрывает соседние paints и не выдаёт occlusion за повреждение geometry. Второй инструмент проверяет все активные Trim/Text Mask Reveal без фиксированного количества сцен. QA/диагностика используют существующий Renderer. SVG bounds/length/mask definitions кэшируются на path; актуальность QA-кэша зависит также от версий renderer/runtime.

## Реальный проект и результаты

[Файлы проверок](../artifacts/render-integrity/README.md) относятся к изолированной копии настоящего test4. Обе реальные ленты (25:1653, 25:1654 / исторический trim_25_1654) сняты на 0/25/50/75/100% до и после исправления mask runtime. Геометрия в scene.json не изменена.

- Реальная QA обеих лент: PASSED, без failed checks.
- Final frame 150 против same-frame render без Trim: **0 изменённых пикселей**, MAE 0. Это проверка отсутствия остаточной обрезки, не подмена источника Figma preview.
- Внешний Figma preview: 57 258 пикселей с RGB отклонением >8; средняя RGB ошибка 1.1926/255. Полное совпадение с Figma не заявляется.
- Настоящий MP4: 180 кадров, 30 FPS. Preview/decoded MP4 MAE на кадрах 120/135/150: 2.0860 / 2.0734 / 2.0734 из 255. H.264 lossy; точное равенство PNG не ожидается.
- Synthetic visual tests: native line, Bezier, thick/round strokes, outlined gradient, transformed SVG, отдельные paths, source mask, hidden initialization, descenders, slide/fade/inertia, Text Mask Reveal, font aliases/reopening. Они не выдаются за проверку неизвестного реального текстового инцидента.

## Ограничения

- Неидентифицированный исходный текстовый инцидент не объявлен исправленным; покрыт воспроизводимый descenders test, устранён конфликт aliases и добавлена QA незапрошенной foreignObject обрезки.
- Установка нужных source fonts остаётся необходимой для точной типографики. Font fallback и различия антиалиасинга могут отличать реконструкцию от Figma.
- Outlined vector без достоверной centerline, mixed/per-vertex stroke geometry, decorations/arrowheads и неоднозначное соответствие нескольких outlines/centerlines не подменяются Scale.
- Compound `M…M…` в одном path явно отклоняется: SVG dash phase перезапускается на subpaths. Поддержаны отдельные vectorPaths и многосегментные Bezier внутри одной траектории; отдельные paths раскрываются одновременно.
- Source SVG fallback может иметь отличающиеся экспортные bounds; существующие предупреждения сохранены. Исправления не обещают точную поддержку каждого произвольного SVG.
