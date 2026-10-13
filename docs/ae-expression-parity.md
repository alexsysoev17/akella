# AE-compatible velocity and inertial expression

> Обновление интеграции: [Core inertia](core-inertia-integration.md). Современный алгоритм теперь используется по умолчанию для всех новых эффектов, а `mode` — только внутренняя версия совместимости. Ниже сохранены математический эталон и результаты сравнения.

## Результат и граница точности

Добавлен отдельный режим `inertialOvershoot.parameters.mode="ae"` и easing `aeEasyEase`. Старые проекты без mode сохраняют secant/lookback и smooth settling. Полное совпадение предоставленного AE ряда **не достигнуто** и не заявляется.

[Численный отчёт](../artifacts/ae-parity/reference-comparison.json):

- TEST A, заданная скорость −60.5 px/s, буквальная expression формула: все кадры 16–44 в допуске 0.15px; максимальная ошибка **0.105355974px**.
- TEST B, скорость самостоятельно из двух keyframes и временного Bezier с speed=0/influence=33.33%: **−50.947973629 px/s**; максимальная ошибка **0.652004281px**. Допуск 0.15px **не пройден**.

Модель стандартного zero-speed Easy Ease с influence около 1/3 близка к smoothstep: при ΔY=−641, duration=.5s и u=(.5−1/300)/.5 производная равна `(ΔY/duration)*6u(1−u)`, около −50.94 px/s. Именно `easeInOutCubic` иной: это другая кривая. Из наблюдаемого AE ряда следует эффективная скорость около −60.5, но опубликованных speed/influence и округлённых Position измерений недостаточно, чтобы доказать внутреннюю методику AE `velocityAtTime` в данном проекте. Коэффициент для искусственного получения −60.5 не добавлен.

After Effects здесь не запускался. Его frame values — предоставленный пользователем внешний эталон. Параметры стандартного Easy Ease подтверждены [документацией Adobe](https://helpx.adobe.com/after-effects/desktop/animate-in-after-effects/speed-between-keyframes/speed.html). Наша модель temporal interpolation — инженерная реализация по этим параметрам; она не является доказанной полной эмуляцией закрытого AE evaluator.

## Математика

```text
final property = eased base keyframes + expression offset
sampleTime = incomingKeyTime - 1 / (FPS * 10)
velocity = derivative(BASE property, sampleTime)
offset(t) = velocity * amplitude * sin(2π * frequency * t) * exp(-decay * t)
```

Время — секунды; frequency — Hz; decay — s⁻¹; velocity — property units/s. Position использует px/s, Rotation — degrees/s, Scale — коэффициент/s (1 соответствует 100%, а не числу 100). Amplitude в такой формуле — коэффициент с временным масштабом, поскольку он умножается на velocity.

`velocityAtTime` использует центральную численную производную с малым шагом, одностороннюю второго порядка возле границ. AE evaluator берёт шаг ≤ `1/(FPS*1000)` и ограничивает его текущим keyframe segment. Он не пересекает соседний keyframe и не читает итоговое значение с expressions — рекурсивной зависимости нет. Subframe evaluation проходит через настоящий base keyframe/easing evaluator.

Для aeEasyEase time-x управляющие точки задаются `outInfluence/100` и `1-inInfluence/100`, value-y — 0 и 1 (нулевые скорости). Используется существующая инверсия cubic Bezier по X. Проценты influence редактируемы; готовые кривые кэшируются. Другие easing не заменяются.

Режим AE не применяет `windowOffset`; на duration cutoff возвращает base, как исходный expression. Остаток перед cutoff измеряется QA и может дать WARNING. Старый режим оставляет сглаженное завершение. `incomingImpulse` не разрешён в AE mode; сохранённый legacy additive impulse — отдельное, явно отличающееся поведение.

## Схема и интеграция

```json
{
  "type": "inertialOvershoot",
  "sourceAnimationId": "position-y",
  "startFrame": 15,
  "durationFrames": 30,
  "property": "y",
  "parameters": {
    "mode": "ae",
    "amplitude": 0.1,
    "frequency": 2,
    "decay": 4,
    "velocityLookbackFrames": 6
  }
}
```

В AE mode `velocityLookbackFrames` сохраняется для совместимости схемы, но **не участвует** в расчёте. Любая новая инерция, независимо от easing, получает текущий внутренний marker в детерминированном Task Compiler; `sourceAnimationId` остаётся ссылкой на исходные keyframes. Агент получает capability/easing metadata, а не придумывает oscillation keyframes.

Редактирование distance, easing и duration меняет производную автоматически. Operations при изменении endpoint сдвигают связанную AE expression, сохраняя её длительность и задержку; уже выполненный retiming или явная правка startFrame не применяются второй раз. Расширение duration должно включать корректные keyframe points — некорректная схема отклоняется, а не исправляется скрытой подгонкой.

В активном интервале выражения используется последний source keyframe не позднее текущего времени. Глобальный интервал expression остаётся частью платформенной модели. Для обычного after-arrival он начинается на последнем endpoint; смена endpoint автоматически retime-ится. Это не неограниченное прикрепление произвольного AE expression ко всей timeline.

Vector2 реализуется независимыми scalar tracks/expressions X и Y. Нулевая X velocity даёт нулевой X offset. Чистая функция поддерживает также Vector3, но 3D Position Renderer отсутствует. Один Y velocity не копируется на X/Z.

## Проверки

`npm run compare:ae` воспроизводит численный отчёт и явно выводит `endToEndTolerancePassed=false`. `npm run compare:ae -- --strict` также возвращает exit code 1, пока TEST B не укладывается в допуск. Unit regression проверяет именно этот известный предел модели; зелёный unit test **не означает**, что TEST B прошёл AE tolerance.

Выполнены: A (expression math), B (самостоятельная velocity, зафиксировано расхождение), C (distance), D (duration/retiming), E (другой easing), F (нулевая X/Z), G (amplitude / 2 без изменения keyframes/easing), nearest-key/internal-segment sampling и совместимость legacy.

[Browser/MP4 проверка](../artifacts/ae-parity/preview-video.json) использует искусственную сцену с теми же keyframes и параметрами, настоящий Chromium Preview и настоящий FFmpeg export. Кадры 16–44 проверены через SVG CTM: X=960, maximum DOM-value error около **0.00005321px** относительно собственного evaluator. MP4: 60 frames, 30FPS; decoded frame18/Preview mean RGB difference около **1.0003/255** с учётом lossy H.264. Это проверка согласованности платформы, не рендер AE.

## Ограничения

Поддержан zero-endpoint-speed temporal Easy Ease и редактируемый influence; произвольные nonzero KeyframeEase speed, spatial path interpolation/roving, AE auto-Bezier и 3D Renderer не эмулируются. Для доказанной parity TEST B нужны дополнительные сведения об исходной AE temporal curve и фактическом velocityAtTime; никакая догадка не встроена в Engine как специальный коэффициент. Старая инерция намеренно не мигрируется автоматически.

Финальная проверка реализации: TypeScript/build прошли; regression suite 120/120. Strict reference comparison завершилась exit code 1 из-за TEST B, как и должна при текущем расхождении.
