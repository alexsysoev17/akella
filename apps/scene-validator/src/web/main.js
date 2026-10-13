import { mountMotion, unmountMotion } from "/motion.js";
const $ = (id) => document.getElementById(id),
  app = $("app");
let current, token, updateId;
const escape = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
async function api(url, options) {
  const r = await fetch(url, options);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
}
function message(text) {
  $("message").textContent = text;
}
function openImport(project) {
  updateId = project?.projectId;
  token = undefined;
  $("name").value = project?.name ?? "";
  $("name").disabled = !!project;
  $("zip").value = "";
  $("import-title").textContent = project
    ? "Обновление из Figma"
    : "Новый проект";
  $("commit").textContent = project
    ? "Подтвердить обновление"
    : "Создать проект";
  $("commit").hidden = true;
  $("prepare").hidden = false;
  $("import-status").textContent = "";
  $("import-details").textContent = "";
  $("import").showModal();
}
$("cancel").onclick = () => $("import").close();
$("zip").onchange = () => {
  token = undefined;
  $("commit").hidden = true;
  $("prepare").hidden = false;
};
$("name").oninput = $("zip").onchange;
$("import-form").onsubmit = async (e) => {
  e.preventDefault();
  $("prepare").disabled = true;
  $("import-status").textContent = "Проверяем архив…";
  try {
    const file = $("zip").files[0];
    const query = new URLSearchParams({ name: $("name").value });
    if (updateId) query.set("projectId", updateId);
    const result = await api("/api/import-preview?" + query, {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: file,
    });
    token = result.token;
    $("import-status").textContent =
      `${result.sceneCount} сцен · ${result.assetCount} ресурсов. Можно импортировать.`;
    $("import-details").textContent =
      (result.changes
        ? `Сцен раньше: ${result.changes.previousScenes}
Сцен в новом экспорте: ${result.changes.newScenes}
Добавлены: ${result.changes.added.join(", ") || "нет"}
Удалены: ${result.changes.removed.join(", ") || "нет"}
Изменены: ${result.changes.changed.join(", ") || "нет"}
Исходные данные изменились: ${result.changes.sourceChanged ? "да" : "нет"}` +
          "\nПредыдущие исходники сохранятся в истории. Заметки, данные анимации и результаты рендера сохранятся.\n"
        : "") + result.warnings.join("\n");
    $("commit").hidden = false;
    $("prepare").hidden = true;
  } catch (e) {
    $("import-status").textContent = String(e);
  } finally {
    $("prepare").disabled = false;
  }
};
$("commit").onclick = async () => {
  $("commit").disabled = true;
  try {
    const r = await api("/api/import-commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    $("import").close();
    location.hash = "project/" + r.projectId;
    await route();
    message(
      r.updated
        ? "Дизайн обновлён. Сцены доступны в анимации."
        : "Проект создан.",
    );
  } catch (e) {
    $("import-status").textContent = String(e);
  } finally {
    $("commit").disabled = false;
  }
};
async function route() {
  unmountMotion();
  try {
    const id = location.hash.match(/^#project\/([^/]+)/)?.[1];
    if (!id) {
      current = undefined;
      const r = await api("/api/projects");
      app.innerHTML =
        '<div class="heading"><h1>Проекты</h1><button id="new">+ НОВЫЙ ПРОЕКТ</button></div><div class="grid">' +
        r.projects
          .map(
            (p) =>
              `<a class="card" href="#project/${encodeURIComponent(p.projectId)}"><h2>${escape(p.name)}</h2><p>${p.sceneCount} сцен · ${escape(p.resolution)}</p><small>${escape(new Date(p.updatedAt).toLocaleString("ru-RU"))}</small></a>`,
          )
          .join("") +
        "</div>" +
        (r.projects.length
          ? ""
          : "<p>Проектов пока нет. Импортируйте ZIP из Figma.</p>");
      $("new").onclick = () => openImport();
      if (r.errors.length) message(r.errors.join("\n"));
      return;
    }
    current = await api("/api/projects/" + encodeURIComponent(id));
    renderProject();
  } catch (e) {
    message(String(e));
  }
}
function renderProject() {
  unmountMotion();
  const p = current;
  app.innerHTML = '<div id="content"></div>';
  void mountMotion($("content"), p.projectId, p.name, () => openImport(p));
}
window.addEventListener("hashchange", () => {
  message("");
  route();
});
route();
