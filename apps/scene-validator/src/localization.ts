/** Presentation only: preserve machine-readable statuses and source diagnostics. */
export function statusRu(value: string): string {
  return (
    (
      {
        passed: "проверка пройдена",
        failed: "ошибка",
        completed: "завершено",
        identical: "совпадает в пределах порога",
        differences: "есть различия",
        unavailable: "недоступно",
        "not-requested": "не запускалась",
        "not-performed": "не выполнялось",
      } as Record<string, string>
    )[value] ?? value
  );
}
export function diagnosticRu(value: string): string {
  const phrases: Record<string, string> = {
    "Mixed vector paints rendered from exported SVG asset.":
      "Смешанные заливки вектора восстановлены из экспортированного SVG.",
    "Path geometry unavailable; rendered from exported SVG asset.":
      "Геометрия контура недоступна; использован экспортированный SVG.",
    "Original image unavailable": "Исходное изображение недоступно",
    "TILE currently approximated as FILL.":
      "Режим TILE приближённо восстановлен как FILL.",
    "Image paint rotation is not implemented.":
      "Поворот заливки изображения пока не поддерживается.",
    "Image color filters are not implemented.":
      "Цветовые фильтры изображения пока не поддерживаются.",
    "Stroke alignment approximated as CENTER.":
      "Выравнивание обводки приближённо восстановлено по центру.",
    "Text paint approximated; only solid text fills supported.":
      "Заливка текста восстановлена приближённо; поддерживаются одноцветные заливки.",
    "Shadow spread not implemented.": "Расширение тени пока не поддерживается.",
    "Corner smoothing not implemented.":
      "Сглаживание углов пока не поддерживается.",
    "Partial ellipse arc approximated as full ellipse.":
      "Дуга эллипса приближённо восстановлена как полный эллипс.",
    "Upload exceeds size limit": "Размер загрузки превышает допустимый предел",
    "ZIP exceeds 512 MiB": "ZIP превышает предел 512 МиБ",
    "Expanded ZIP exceeds 512 MiB":
      "Распакованный ZIP превышает предел 512 МиБ",
    "ZIP contains too many files": "В ZIP слишком много файлов",
    "ZIP must contain exactly one scene.json export root":
      "В ZIP должен быть ровно один корень экспорта с scene.json",
    "ZIP symlinks are forbidden": "Символические ссылки в ZIP запрещены",
    "Project name required (max 200 characters)":
      "Укажите название проекта длиной не более 200 символов",
    "Project name must contain letters or numbers":
      "Название проекта должно содержать буквы или цифры",
    "Import preview expired; upload again":
      "Проверка импорта устарела. Загрузите архив ещё раз",
    "Project changed since preview; upload again":
      "После проверки проект изменился. Загрузите архив ещё раз",
    "Validation already running": "Проверка уже выполняется",
    "Project not found": "Проект не найден",
    "Preview unavailable": "Превью недоступно",
    "Notes must be text": "Заметки должны содержать текст",
    "Not found": "Не найдено",
    "Finish or wait for pending imports before uploading more":
      "Завершите предыдущие импорты или дождитесь их завершения",
  };
  let result = value;
  // Long phrases first to avoid replacing a substring of a longer diagnostic.
  for (const [from, to] of Object.entries(phrases).sort(
    (a, b) => b[0].length - a[0].length,
  ))
    result = result.replaceAll(from, to);
  return result
    .replace(/^Error: /, "Ошибка: ")
    .replace(
      /Figma exporter reported (\d+) errors; inspect source\/export-report.json\./g,
      "Экспортёр Figma сообщил об ошибках ($1). Подробности: source/export-report.json.",
    )
    .replace(
      /Font unavailable locally: (.+)\. Browser fallback used\./g,
      "Шрифт недоступен на этом компьютере: $1. Использован резервный шрифт браузера.",
    )
    .replace(
      /Effect (\S+) not implemented\./g,
      "Эффект $1 пока не поддерживается.",
    )
    .replace(/Unsupported paint (\S+)/g, "Неподдерживаемая заливка $1")
    .replace(
      /Unsupported node (\S+); fallback when available\./g,
      "Неподдерживаемый узел $1; используется резервный ресурс, если он доступен.",
    )
    .replace(
      /no Figma preview; visual comparison unavailable/g,
      "превью Figma отсутствует; визуальное сравнение недоступно",
    )
    .replace(
      /preview is absent; visual comparison unavailable/g,
      "превью отсутствует; визуальное сравнение недоступно",
    )
    .replace(/Missing asset file: /g, "Отсутствует файл ресурса: ")
    .replace(
      /Project already exists: (.+)\. Use --update for a non-destructive reimport\./g,
      "Проект уже существует: $1. Используйте обновление существующего проекта.",
    )
    .replace(
      /Can't find end of central directory.+/g,
      "Не удалось открыть ZIP. Выберите корректный архив экспорта Figma.",
    );
}
