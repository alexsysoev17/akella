import {mountBanners} from "/banners.js";
import {mountSkills} from "/skills.js";
import { mountMotion, unmountMotion } from "/motion.js";
const $ = (id) => document.getElementById(id),
  app = $("app");
let current, token, updateId;
let welcomeStarted = true;
window.addEventListener('akella-new-project',()=>createEmptyProject());
let routeVersion = 0;
let disposeWelcome = () => {};
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
let creatingProject = false;
async function createEmptyProject() {
  if (creatingProject) return;
  creatingProject = true;
  try { const p = await api('/api/projects', {method:'POST'}); location.hash = 'project/' + p.projectId; }
  catch (e) { message(String(e)); }
  finally { creatingProject = false; }
}
function conversation(messages) {
  return messages.map(m=>`<p class="import-message ${m.role === 'user' ? 'from-user' : ''}"${m.stage ? ` data-stage="${escape(m.stage)}"` : ''}>${escape(m.text)}</p>`).join('');
}
function renderDraft(p) {
  app.innerHTML = `<section class="empty-project"><header><span>${escape(p.name)}</span><a href="#">В главное меню</a></header><div class="empty-chat"><h1>С чего начнём?</h1><p>Пришли ссылку на Figma или напиши, какие кадры взять. Я найду их в файле.</p><div id="import-conversation" role="log" aria-live="polite">${conversation(p.messages)}</div><form id="figma-prompt-form"><label class="sr-only" for="figma-prompt">Что импортировать из Figma</label><textarea id="figma-prompt" placeholder="В файле «хакатон?» на странице «для теста» возьми «тест 1»" required></textarea><button id="figma-submit">Импортировать</button></form></div></section>`;
  $('import-conversation').scrollTop=$('import-conversation').scrollHeight;
  const version = routeVersion;
  const busy = p.status === 'importing';
  $('figma-prompt').disabled = busy;
  $('figma-submit').disabled = busy;
  $('figma-submit').textContent = busy ? 'Импортируем…' : 'Импортировать';
  if (!busy) $('figma-prompt').focus();
  $('figma-prompt-form').onsubmit = async e => {
    e.preventDefault();
    $('figma-submit').disabled = true;
    try {
      const next = await api(`/api/projects/${encodeURIComponent(p.projectId)}/import-from-figma`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:$('figma-prompt').value})});
      if(version===routeVersion) renderDraft(next);
    } catch(e) { if(version===routeVersion){message(String(e));$('figma-submit').disabled=false;} }
  };
  let timer;
  const poll = async () => {
    try {
      const next = await api('/api/projects/' + encodeURIComponent(p.projectId));
      if(version!==routeVersion)return;
      if(!next.draft){current=next;await renderProject();return;}
      if(next.status!=='importing'){renderDraft(next);return;}
      if(JSON.stringify(next.messages)!==JSON.stringify(p.messages)){
        p.messages=next.messages;
        $('import-conversation').innerHTML=conversation(next.messages);
        $('import-conversation').scrollTop=$('import-conversation').scrollHeight;
      }
      timer=setTimeout(poll,1500);
    } catch(e) {if(version===routeVersion){message(String(e));timer=setTimeout(poll,4000);}}
  };
  disposeWelcome=()=>clearTimeout(timer);
  if(busy)timer=setTimeout(poll,1000);
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
      <div class="welcome-tagline"><span>SOFTWARE THAT CREATES</span></div>
    </div>
    <div class="welcome-panel">
      <h1 class="welcome-title">ДОБРО ПОЖАЛОВАТЬ В АКЕЛЛУ</h1>
      <div class="welcome-actions">${showProjects ? `<button id="new">Новый проект</button><button id="open-project" aria-controls="project-list">Открыть проект</button><a href="#banners">Баннеры</a><a href="#skills">Библиотека анимаций</a>
      <nav id="project-list" class="welcome-projects" aria-label="Проекты">${projects.map(p => `<a href="#project/${encodeURIComponent(p.projectId)}">${escape(p.name)}</a>`).join("") || '<p>Пока нет проектов</p>'}</nav>` : '<button id="start">Старт</button><a href="#banners">Баннеры</a>'}</div>
    </div></section>`;
  const tagline = app.querySelector(".welcome-tagline");
  const text = tagline.firstElementChild;
  let lastWidth = 0;
  const fit = () => {
    if (!tagline.isConnected) return;
    const width = tagline.getBoundingClientRect().width;
    if (!width || width === lastWidth) return;
    lastWidth = width;
    // Measure actual Medium glyphs with their tracking; change font size only.
    text.style.fontSize = "100px";
    const naturalWidth = text.getBoundingClientRect().width;
    if (naturalWidth) text.style.fontSize = `${100 * width / naturalWidth}px`;
  };
  const observer = new ResizeObserver(fit);
  let disposed = false;
  disposeWelcome = () => { disposed = true; observer.disconnect(); };
  void document.fonts.load("500 100px Inter").catch(() => []).then(() => {
    if (disposed) return;
    observer.observe(tagline);
    fit();
  });
  if (showProjects) {
    $("new").onclick = () => createEmptyProject();
    $("open-project").onclick = () => {
      const first = $("project-list").querySelector("a");
      if (first) { first.focus(); first.scrollIntoView({block:"nearest"}); }
      else void createEmptyProject();
    };
  } else $("start").onclick = () => { welcomeStarted = true; void route(); };
}
async function route() {
  disposeWelcome();
  const version = ++routeVersion;
  unmountMotion();
  try {
    if(location.hash==="#banners"){
      const dispose=await mountBanners(app,()=>version===routeVersion);
      if(version===routeVersion)disposeWelcome=dispose;else dispose();
      return;
    }
    if(location.hash==="#skills"){disposeWelcome=await mountSkills(app);return;}
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
    await renderProject();
  } catch (e) {
    if (version === routeVersion) message(String(e));
  }
}
async function renderProject() {
  unmountMotion();
  const p = current;
  if(p.draft){renderDraft(p);return;}
  const version = routeVersion;
  app.innerHTML = '<div id="content"></div>';
  await mountMotion($("content"), p.projectId, p.name, () => openImport(p));
  if(version!==routeVersion)return;

}
window.addEventListener("hashchange", () => {
  message("");
  route();
});
route();
