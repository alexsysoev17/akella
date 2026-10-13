# Advanced Motion System

Расширение существующего движка, без второго renderer. Реестр находится в
`apps/scene-validator/src/motion-library/`. Preview, произвольный seek и MP4
используют одну функцию вычисления кадра. Исходные Figma scene.json/assets не меняются.

## Easing

Реестр содержит linear и In/Out/InOut для Quad, Cubic, Quart, Quint, Sine, Expo,
Circ, Back, Elastic, Bounce. Старые строковые значения сохраняют совместимость.
Каждая запись содержит описание, схему параметров, defaults и evaluator.

Структурированный easing сохраняется непосредственно в motion state:

```json
{"type":"cubicBezier","parameters":{"x1":0.85,"y1":0,"x2":0.15,"y2":1}}
```

Cubic Bezier решает X(t)=progress методом Newton с безопасным переходом к
бисекции, затем вычисляет Y(t). Координаты X ограничены 0..1; Y может выходить
за этот диапазон. Поэтому доступны резкое ускорение посередине и overshoot.

Piecewise задаёт точки {t,value,slope}; обязательны концы (0,0), (1,1) и строго
возрастающий t. Linear обеспечивает C0. Hermite использует общие касательные,
обеспечивая C1; slope=null или пропуск включает автоматическую касательную.
Доступны параметрические spring (stiffness/damping/mass), elastic
(amplitude/frequency/decay), back (overshoot), bounce (restitution/bounceCount).

Новые spring/elastic плавно доводятся до конечного значения в последней четверти
интервала. Это художественная конечная анимация, а не бесконечная физическая
симуляция. Bounce сохраняет характерный излом скорости в момент контакта.
Legacy springSoft и state-transition spring сохраняют прежние формулы для
совместимости; их поведение не следует путать с новым параметрическим spring.

## Expressions и композиция

Типы: wiggle, inertialOvershoot, dampedOscillation, spring, bounce, loop.
Поддерживаются x, y, scaleX, scaleY, rotation, opacity на контейнерах текста,
изображений, векторов и групп. Это структурированные данные, не JavaScript/eval.

Порядок: исходное состояние → base tracks с easing → сумма expression offsets.
Выражения складываются в стабильном порядке expressionId. Opacity ограничена
0..1, scale — положительным значением. Несовместимые base tracks отклоняются;
несколько additive expressions разрешены.

Время параметров выражений — секунды, частота — Hz, decay — 1/секунду.
Start/duration сохраняются в кадрах. Wiggle использует seed и аналитический
семплинг: результат не зависит от порядка посещения кадров. Финальная четверть
интервала плавно сводит offset к нулю.

InertialOvershoot ссылается на sourceAnimationId и измеряет скорость этого
base track перед его концом через velocityLookbackFrames. Amplitude — коэффициент
скорости в секундах, не фиксированное число пикселей. Очень мягкая остановка
даёт небольшую инерцию; окно измерения явно сохранено. Helpers valueAtTime,
velocityAtTime, nearestKey доступны как чистые функции.

Loop переиспользует base track. PingPong разрешает разные endpoints, cycle
требует одинаковые endpoints. Выражения конечны и заканчиваются до последнего
кадра проекта. Произвольные зависимости выражений друг от друга не поддерживаются.

## Presets и AI context

Восемь шаблонов: Smooth Entrance, Sharp Smooth, Smooth Overshoot, Elastic
Entrance, Soft Floating, Subtle Wiggle, Dynamic Exit, Gentle Scale.
Операция applyMotionPreset один раз разворачивает шаблон в обычные tracks и
expressions. Последующие правки не перечитывают defaults.

Четыре локальных Markdown skill: animation-principles, kinetic-typography,
motion-timing, motion-guidelines. Context Builder передаёт компактный каталог,
два релевантных skill и максимум два подробных preset. Приоритет:
техническая валидность → последняя инструкция → текущее состояние →
применённая, не отменённая история → skills → defaults.
Библиотека не зависит от AI-провайдера.

AI генерирует параметры custom curve в проверяемом JSON. setEasing изменяет
только easing существующего animationId. scaleEasingParameter и
scaleExpressionParameter умножают текущее значение одного поля.
«Вдвое слабее» дважды даёт amplitude ×0.25, без сброса остальных настроек.
Undo/Redo и история используют существующее транзакционное хранилище.

Строгая схема провайдера использует общие $defs, required для всех свойств,
nullable для необязательных полей и additionalProperties=false.
Требования сверены с [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
Это контракт передачи данных; математические вычисления выполняются локально.

## Интерфейс

Откройте настройки выбранного объекта → график easing. Он показывает реальную
кривую выбранной анимации/перехода, включая выход за 0..1. Основное управление
остаётся через промпт, например:

> Появление снизу: медленный старт, резкое ускорение посередине, мягкая остановка.
> После достижения позиции добавь инерционные затухающие колебания.

Затем: «Сделай середину резче», «Колебания вдвое слабее»,
«Пусть затухают медленнее».

## Проверки и границы

Автоматические тесты покрывают семейства easing, Bezier inversion,
piecewise C1, параметры spring, конечность значений, deterministic seek,
композицию/velocity, относительные правки, историю, preset expansion,
ограниченный knowledge context, strict provider schema, старые easing,
одинаковые expressions на TEXT/image/VECTOR/GROUP, браузерный график.
Настоящий MP4 синтетической сцены декодируется и сравнивается с preview.

Новая реальная проверка Codex на полностью искусственном проекте выполнена в следующей итерации — см. [Motion Intelligence](motion-intelligence.md). Пользовательский Figma-экспорт внешней модели не передавался.

Instance expressions нельзя одновременно применить к поддереву, управляемому
межсценовым object-state transition. Сам transition поддерживает новые easing
и свои прежние proceduralEffects. Анимация отдельных букв одного TextNode,
произвольный expression-код и физические столкновения объектов не реализованы.
Сохраняются существующие ограничения точности Figma reconstruction.
