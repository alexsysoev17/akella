# Agentic Motion Intelligence

## Аудит и исправления

Раньше Motion Skills и схемы expressions уже передавались агенту. Движок имел
velocity-based inertia и ограниченный Trim Path. Однако runtime проверял только
схемы/конфликты: технически допустимый Scale мог пройти вместо Trim Paths.
Системный промпт также рекомендовал ближайшую имитацию. Проверки результата,
контрольных кадров и визуального repair не было.

Теперь provider-independent capability registry строится из настоящих Zod
схем и ссылается на evaluators движка. Реестр техник содержит назначение,
запросы, параметры, ограничения, examples и критерии QA.
Knowledge Retrieval выбирает релевантные техники вместе с существующими
skills/presets. Реализация находится в src/motion-library/{registry,techniques}.

## Pipeline

Prompt + exact mentions → target resolution → retrieved knowledge/capabilities →
AI operations → existing technical validation → technique validation →
candidate state → numeric QA → Chromium render QA → commit → autoplay.

Candidate живёт отдельно от сохранённого motion state. Commit происходит только
после успешной проверки, с проверкой revision/source fingerprint и digest
проверенного состояния. При ошибке предыдущая анимация сохраняется.

Технический guard определяет явно названные техники по русским/английским
формулировкам и текущим эффектам. Это детерминированный guard, а не отдельная
LLM-классификация любого естественного языка. Непредусмотренные перефразы могут
не включить strict technique enforcement. При составном запросе используются
имена, mentions, выбранная сцена и существующие эффекты; это не полноценный
семантический анализ режиссуры.

## Реальные техники

- InertialOvershoot: измеренная входящая скорость × amplitude × sin(2π frequency t)
  × exp(-decay t). Position, ScaleX/Y и Rotation поддерживаются общим evaluator.
  В последней четверти заданного интервала offset плавно сводится к нулю.
  incomingImpulse — необязательная явная добавка к скорости в единицах свойства
  за секунду для почти нулевой входящей скорости. Она сохраняется в параметрах.
- Trim Paths / implementation trimPath: getTotalLength и stroke-dasharray/
  stroke-dashoffset на отдельной белой маске вдоль центральной линии.
  Исходная геометрия и paint не переписываются. Поддержаны LINE, Bezier,
  несколько отдельных vectorPaths одновременно, forward/reverse, градиенты и
  пунктир. Outlined stroke поддержан, если сохранён один однозначный centerline:
  маска раскрывает исходную залитую outline-геометрию.
- Wiggle, spring, custom Bezier используют существующие evaluators и retrieval.
  Для них работают общие проверки данных/кадров; специализированные проверки
  frequency/decay относятся к inertialOvershoot.

Exporter уже сохраняет vectorPaths и strokeGeometry. Его менять не потребовалось.
Без centerline нельзя достоверно восстановить направление прорисовки залитой
формы. Сложные compound subpaths, multiple outlined strokes без явного
соответствия и нецентральные обводки отклоняются с причиной.
На близко проходящих или самопересекающихся участках широкая reveal mask может
раскрывать соседний участок раньше времени; точная визуальная оценка этого
случая автоматикой не гарантируется.

Механика dash/pathLength сверена с [SVG painting specification](https://www.w3.org/TR/SVG/painting).
В отличие от изменения dash исходного stroke, отдельная маска сохраняет его стиль.

## Technical validation и repair

Существующий validateMotion проверяет IDs, targets, ranges, timing, conflicts
и expression sources. Дополнительный guard выдаёт TECHNIQUE_MISMATCH, если
явно требуется trimPath, а для указанной цели его нет, или требуется
inertialOvershoot, а создана имитация keyframes.

AI получает structured runtimeFeedback, включая QA Report и предыдущий ответ.
Максимум — 3 общие попытки (первичная + 2 исправления). Каждая проверяется
относительно исходного state: неудачные попытки не накапливаются.
Обычная генерация и manual-response проходят одинаковую QA; ручной provider
не может сам запросить AI repair. Прямые операции API также проходят QA,
но при ошибке возвращают отчёт без обращения к AI.
Undo/Redo восстанавливает историю без повторной генерации.

## Что проверяет QA

Численно:
- исходная скорость и ненулевая амплитуда;
- частота по интервалам пиков и decay по отношению ранних пиков;
- достаточный FPS (минимум 4 кадра на цикл);
- конечность значений, непрерывность начала/конца expressions;
- возврат к base target после expressions;
- разрывы на стыках base tracks. Явно запрошенный скачок отмечается WARNING.

Renderer:
- реальные PNG до, в начале, на 25/50/75%, в конце и после эффекта;
- вклад объекта в картинку: сравнение screenshot с тем же кадром без объекта;
- видимое влияние inertia: сравнение с кадром без конкретного expression;
- рост/убывание видимой прорисованной области, длины SVG paths,
  сохранность source path/paint;
- единственный видимый экземпляр Logical Object на контрольных кадрах перехода;
- contact sheet из реально сохранённых PNG.

Используются те же motionHtml, motionFrame и Chromium, что в preview/MP4.
Предельный бюджет — 100 различных rendered frames на одну попытку.
Численная выборка для inertia плотнее, до 24 samples/cycle и 20 000 samples
на expression; дополнительно сохраняются вычисленные состояния контрольных кадров.

Результаты: PASSED / FAILED / WARNING / NOT_TESTED. Общий статус отражает
выполненные объективные проверки. Он не означает, что выполнены все возможные
визуальные проверки. Художественное соответствие, смысл текста, произвольные
сложные clipping/occlusion и идентичность содержимого отмечены NOT_TESTED,
если соответствующая проверка отсутствует. Vision-модель не подключена.
Выход за кадр и сильный overshoot сами по себе не запрещаются.
Полностью невидимый обычный эффект даёт WARNING; отсутствие визуально требуемой
инерции или path reveal даёт FAILED.

## Диагностика

Настройки → «Диагностика Motion Agent» → «Последняя проверка».

Показываются запрос, references, выбранные техники, implementation IDs,
операции, технические ошибки, QA и попытки. Успешная попытка содержит contact sheet.
Полные файлы: motion/ai/<requestId>/ и
motion/qa/<requestId>/attempt-N/ (manual для ручного provider):
report.json, numeric-samples.json, effect-*.json, frame-*.png, contact-sheet.png.
История QA сохраняется отдельно для каждого запроса. Пользовательские source,
notes, motion history и renders не удаляются.

## Выполненная приёмка

1. Настоящий Codex SDK на полностью искусственном проекте QR + Bezier:
   - A: moveTo + scaleIn + два inertialOvershoot X/Y, QA и commit.
   - B: trimPath по кривой, QA и commit.
   - C: amplitude 0.5 → 0.25 для обоих expressions; duration линии 30 → 45.
     Остальные движения сохранены. QA прошла. MP4: 120 кадров, 30 FPS.
   Первая попытка C выявила неправильный выбор цели валидатором; исправление
   внесено в код и покрыто регрессионным тестом. Повторный реальный запрос прошёл.
2. Реальная копия source из test3, локально, без отправки AI:
   вручную задан межсценовый переход «куар», сохранены пять PNG.
   Во всех кадрах один видимый экземпляр; SHA-256 оригинального source не изменился.
3. Автоматические тесты: имитации, нулевая амплитуда, aliasing,
   frequency/decay, finite endpoints, jump detection, artwork freedom,
   Bezier/multiple/reverse/outlined-gradient reveal, actual rendered pixels,
   реальный QA FAIL → тестовый provider repair → QA PASS, лимит попыток,
   immutable state/source, существующие TEXT/Logical Object/MP4/UI тесты.

Реальный AI тест использует искусственный дизайн. Полные A–C с передачей
пользовательского Figma-документа внешней модели не выполнялись.
Системный IME и художественное качество произвольного ролика не проверялись.
Артефакты: artifacts/motion-intelligence/ — отчёты, contact sheets и acceptance.mp4.

Сохраняются прежние ограничения reconstruction и discrete hierarchy switch
межсценовых переходов. Instance expressions по-прежнему несовместимы с
поддеревом object-state transition; transition использует собственные procedural
effects. Это не автоматическое решение произвольной композиции или всех
техник After Effects.
