# Agent Inspector

Кнопка **Inspector** рядом с полем запроса открывает панель справа. На широком экране рабочая область сжимается, чтобы Preview, Timeline и prompt оставались доступны. На узком экране панель занимает экран и закрывается крестиком. Левую границу можно перетаскивать; она также принимает стрелки клавиатуры. Выбранная вкладка сохраняется между открытиями.

- **Обзор:** исходный prompt, статус сохранённого запуска, provider/model, время, задачи, ремонты и итоговая сверка требований.
- **Понимание:** настоящий Intent Contract: sourceText, sceneId, target IDs, техники, timing, наследование и зависимости. Детали раскрываются по задаче.
- **Действия:** generatedOperations, technical validation, применённые операции и diff из существующей Undo history. Before/after доступны в «Данные». Сравнение последовательных repair attempts показывает изменение операций, когда оба входа сохранены. Хронология использует реальные timestamp и время от старта.
- **QA:** группы технических, математических и render checks, причины, target, метрики и сохранённые кадры. Клик на изображение открывает оригинальный файл. Художественная оценка не выполнялась: NOT_TESTED.
- **Данные:** JSON-дерево, узлы создаются при раскрытии, поиск, копирование отдельных значений и всего JSON. Provider responses и расширенные snapshots загружаются только здесь.

## Архитектура

```text
Existing Agent Orchestrator / HarnessRun
  ├─ record() → motion/harness/runs/<runId>/{run,trace}.json
  ├─ Intent execution → motion/ai/<runId>/{tasks,execution,...}.json
  ├─ existing changeMotion → motion/motion.json / undo history
  └─ existing Motion QA → motion/qa/<runId>/<attempt>/
                            ↓ read-only, bounded, redacted projection
                    harness/inspector.ts
                            ↓ local HTTP GET
                     web/inspector.js
```

Нового планировщика, provider adapter, Motion Engine или истории не создано. Inspector работает с общим форматом Harness, независимо от provider ID. В runtime добавлены реальные события provider-started, provider-completed и run-finished. Старые события не реконструируются задним числом.

API: `GET /api/projects/<projectId>/motion/inspector` — последние 100 запусков; `/<runId>` — проекция; `/<runId>?raw=1` — расширенные данные; `/<runId>/report` — Markdown; `/<runId>/bundle` — ZIP. Только существующий локальный сервер 127.0.0.1. Панель опрашивает историю каждые 2 секунды, пока открыта и вкладка браузера активна. Детали повторно читаются при изменении запуска; закрытая панель не делает запросов. Сводки кешируются по mtime run.json (до 200 записей).

Пример хранения запуска:

```json
{"schemaVersion":"1.0.0","runId":"8193ae3d-69fe-4438-b7a6-aaa918f6c3b2","status":"SUCCESS","privacy":"full","calls":[{"provider":"codex-sdk","model":"provider-default","status":"SUCCESS"}],"outcome":{"reconciliation":{"requested":1,"completed":1,"status":"SUCCESS"}},"artisticQuality":"NOT_TESTED"}
```

Это сокращённая иллюстрация полей существующего запуска test6. Полный фактический Run находится в example ZIP, а не генерируется Inspector.

## Копирование и ZIP

«Скопировать отчёт» записывает Markdown в буфер обмена: исходный prompt, требования/привязки, операции, ошибки, repair, QA, метрики и хронология. «Скачать ZIP» инициируется явно пользователем:

```text
report.md
run.json
intent.json
operations.json
qa-report.json
state-diff.json
trace.json
environment.json
frames/<attempt>/*.png
```

Архив содержит существующие QA-изображения, но не исходные assets. Перед выдачей удаляются credentials, известные secret/token/key поля, Bearer/API keys, персональное имя в /Users/, большие SVG/geometry и base64. Это техническая redaction: смысл prompt и имена объектов сохраняются и могут содержать конфиденциальные сведения. В режиме privacy=metadata нет текста/tasks/QA frames/snapshots; privacy=off не создаёт Run History.

## Ограничения хранения и размера

В `motion/harness/config.json`: historyMaxRuns=200, historyMaxAgeDays=90, historyMaxBytes=104857600. Очистка после завершения запуска удаляет только старые Harness run/trace records, сохраняет текущий и RUNNING. Не удаляются source, Undo history, notes, motion, renders и диагностические AI/QA artifacts. Эти artifacts пока требуют отдельного обслуживания диска; это не глобальная квота проекта.

Одно JSON-чтение ограничено 4 MiB; ответ Inspector — 2 MiB с явным omittedSections; отдельные строки — 6000 символов, массивы — 500 элементов. До 20 QA attempts и 16 кадров на attempt в одном представлении. ZIP включает до 25 MiB кадров, не более 8 MiB на изображение. Markdown ограничен 200000 символами. Ограничения предотвращают загрузку многомегабайтной геометрии на UI thread.

## Проверки

`npm run check` — TypeScript, автоматические тесты и сборка. `node --import tsx scripts/verify-inspector.ts` — браузерная проверка существующего test6: пять вкладок, буфер обмена, скачанный ZIP, resize, закрытие, сохранённая вкладка, mobile, отсутствие POST/AI запросов. Скрипт читает проект; анимации не меняет.

Fixtures в inspector.test.ts искусственные: success/partial/failure, неправильный binding в сохранённых данных, missing Fade, clipping, repair, Overshoot metadata, privacy, path/symlink guards, retention, provider independence. Они проверяют отображение сохранённых результатов, а не семантическое качество нового AI-ответа.

Фактические результаты и примеры: `artifacts/agent-inspector/`. Новые вызовы Codex для проверки Inspector не выполнялись. Screenshot/ZIP используют сохранённый реальный запуск test6; новая генерация и новый Motion QA не запускались.

## Известные ограничения

У старых запусков нет добавленных provider timing events; отсутствующие данные обозначаются NOT_AVAILABLE. При отсутствии QA-отчёта нельзя утверждать, что QA пройден. Counterfactual кадры без эффекта/difference, если прошлый QA их не сохранил, Inspector не дорисовывает. Численная incoming velocity доступна только если сохранена в QA samples; evaluator и алгоритм видны по persisted effect parameters. Inspector не показывает скрытые рассуждения модели. В privacy=off панели нечего показывать. Доступные последние 100 запусков ограничены для лёгкой загрузки.

Проверка live-обновлений использует искусственные HTTP responses RUNNING → FAILED; это проверка UI polling, а не новый AI E2E. На сохранённом test6 выполнены 10 замеров read-only API projection: медиана основного представления ~2,9 мс, raw ~7,6 мс, history ~0,60 мс. Размер основного ответа ~59 KB, raw ~224 KB. Полные замеры: `artifacts/agent-inspector/performance.json`. Это не замер скорости генерации анимаций и не нагрузочный тест больших проектов.
