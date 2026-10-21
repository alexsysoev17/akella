import { mountMotion, unmountMotion } from "/motion.js";
const $ = (id) => document.getElementById(id),
  app = $("app");
let current, token, updateId;
let welcomeStarted = false;
let routeVersion = 0;
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
function renderWelcome(projects = [], showProjects = false) {
  document.body.dataset.page = "welcome";
  app.innerHTML = `<section class="welcome" aria-label="Добро пожаловать в AKELLA">
    <div class="welcome-brand">
      <img class="welcome-photo" src="/brand/akella_photo.png" alt="Волки" fetchpriority="high">
      <img class="welcome-logo" src="/brand/akella.svg" alt="AKELLA">
      <svg class="welcome-tagline" viewBox="0 0 789 60" role="img" aria-label="Software that creates"><text x="0" y="49" textLength="789" lengthAdjust="spacingAndGlyphs">SOFTWARE THAT CREATES</text></svg>
    </div>
    <div class="welcome-panel">
      <h1 class="welcome-title"><span>Welcome to</span><img src="/brand/akella.svg" alt="AKELLA"></h1>
      <div class="welcome-actions">${showProjects ? `<button id="new">Новый проект</button><button id="open-project" aria-controls="project-list">Открыть проект</button>
      <nav id="project-list" class="welcome-projects" aria-label="Проекты">${projects.map(p => `<a href="#project/${encodeURIComponent(p.projectId)}">${escape(p.name)}</a>`).join("") || '<p>Пока нет проектов</p>'}</nav>` : '<button id="start">Старт</button>'}</div>
    </div></section>`;
  if (showProjects) {
    $("new").onclick = () => openImport();
    $("open-project").onclick = () => {
      const first = $("project-list").querySelector("a");
      if (first) { first.focus(); first.scrollIntoView({block:"nearest"}); }
      else openImport();
    };
  } else $("start").onclick = () => { welcomeStarted = true; void route(); };
}
async function route() {
  const version = ++routeVersion;
  unmountMotion();
  try {
    const id = location.hash.match(/^#project\/([^/]+)/)?.[1];
    if (!id) {
      current = undefined;
      if (!welcomeStarted) { renderWelcome(); return; }
      const r = await api("/api/projects");
      if (version !== routeVersion) return;
      renderWelcome(r.projects, true);
      if (r.errors.length) message(r.errors.join("\n"));
      return;
    }
    welcomeStarted = true;
    document.body.dataset.page = "project";
    current = await api("/api/projects/" + encodeURIComponent(id));
    if (version !== routeVersion) return;
    renderProject();
  } catch (e) {
    if (version === routeVersion) message(String(e));
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
