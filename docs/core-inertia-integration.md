# Core inertia integration

Современная инерция — стандартная техника платформы, а не пользовательский AE Mode. Пользователь не выбирает версию алгоритма и не должен упоминать After Effects.

## Единственный runtime

- `motion/engine.ts`: общий evaluator keyframes/easing; публичные `valueAtTime(animation, seconds, fps)` и `velocityAtTime(animation, seconds, fps)`.
- `motion/sampling.ts`: общее субкадровое чтение BASE и локальная производная в пределах keyframe segment. Все компоненты velocity независимы; expression output сюда не попадает.
- `motion/expressions.ts`: единственный dispatcher/compositor, добавляющий offset к результату BASE.
- `motion-library/expressions/functions.ts`: математическая формула damped sine и точная численная производная; отдельной Motion Library нет.
- `motion-library/expressions/registry.ts` и `motion-library/registry/capabilities.ts`: типизированный контракт `inertialOvershoot` с настоящим `expressionValue` evaluator.

```text
keyframes → easing → base value
                    ↓
         core instantaneous velocity
                    ↓
      velocity × amplitude × damped sine
                    ↓
          base + procedural offset
```

Внутренний маркер `parameters.mode="ae"` означает текущую версию алгоритма: sampling перед incoming keyframe на 0.1 frame, локальная производная и экспоненциальное затухание. Название сохранено для совместимости с уже записанными современными эффектами; оно не требует пользовательского выбора и не обещает полную эмуляцию AE.

Старые сохранённые эффекты без `mode` или с `legacy` продолжают использовать прежнюю secant/lookback velocity и smooth settling. Чтение проекта их не мигрирует. Изменение amplitude существующего legacy эффекта также сохраняет старый алгоритм. Snapshots Undo/Redo не пересчитываются по новой версии.

## Все пути создания

- Agent Task Compiler: **каждый новый** inertialOvershoot получает текущую версию независимо от easing и формулировки пользователя.
- Motion Operations `setExpression`: новый эффект без указанной внутренней версии получает текущий алгоритм. При редактировании версия уже существующего эффекта сохраняется.
- Presets: новая инерция использует тот же текущий evaluator. `smooth-overshoot` имеет ненулевую исходную terminal velocity, с которой можно естественно передать импульс; сохранённые экземпляры preset не меняются.
- Default easing нового движения с инерцией — обычный temporal cubic Bezier, без обязательного использования `aeEasyEase`. Явно заданный easing не заменяется. Добавление инерции к существующему движению не меняет BASE.

Для arbitrary easing расчёт корректен, но реальная скорость перед остановкой может быть очень мала. Тогда и физический offset мал. QA не должен выдавать незаметные колебания за сильную анимацию; lookback average или искусственный impulse не подставляются скрыто. Duration cutoff текущей версии может иметь остаток; он проверяется и диагностируется QA.

## Agent и редактирование

Retrieval предоставляет технику для «инерция после движения», «затухающие колебания», «немного покачается после остановки». Семантику определяет LLM, lexical hints только выбирают релевантные знания. Structured Plan → deterministic compiler → existing operations → common evaluator → real QA.

Keyframes/distance/easing автоматически меняют incoming velocity. Duration editing пересчитывает key times и сохраняет относительную задержку expression. «Вдвое слабее» меняет amplitude текущего эффекта, сохраняя IDs, BASE, easing и версию.

## Проверенная интеграция

[Реальный Codex](../artifacts/core-inertia/live-provider.json): все три обычные фразы прошли на искусственных fixtures с существующим линейным движением QR; каждый Run использовал один LLM call, создал текущую инерцию, прошёл реальную QA и сохранил BASE. Отдельный реальный запрос amplitude / 2 прошёл без пересоздания движения. Это реальные Provider calls, не mocks; fixtures не являются реальным Figma-документом.

Infrastructure tests проверяют public sampling API, реальную registry/evaluator связь, API defaults, preserved legacy, preset version и независимость выбора нового алгоритма от easing. Полная regression suite проверяет также Undo/Redo и существующий Preview/MP4 pipeline.

## Разница с AE

[Предыдущее численное сравнение](ae-expression-parity.md) остаётся актуальным: сама формула с заданной velocity укладывается в 0.15px, но independently derived zero-speed Easy Ease даёт −50.948 вместо эффективных −60.5 px/s из предоставленного ряда; максимальная ошибка 0.652px. Никакой специальный коэффициент не добавлен. Это ограничение точного воспроизведения AE temporal/velocity evaluator, а не нарушение общего принципа **BASE + реальная velocity-dependent expression**. Различие влияет на амплитуду конкретного эталона, а не на знак, частоту, затухание или универсальность композиции.

Воспроизводимый Provider test: `npm run eval:core-inertia` (реальный Codex, искусственные fixtures). Финальная регрессия: 123/123; TypeScript и сборка проходят.
