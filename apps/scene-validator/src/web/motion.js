import {
  selectedProviderId,
  PROVIDER_LABELS,
  PROVIDER_SETTINGS_MESSAGE,
} from "/provider-contract.js";
import { attachInspector } from "/inspector.js";
import { attachMentions } from "/mentions.js";
import { curveData } from "/easing-runtime.js";
let stop = () => {};
export function unmountMotion() {
  stop();
  stop = () => {};
}
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export async function mountMotion(
  container,
  projectId,
  projectName = "Проект",
  onUpdate = () => {},
) {
  let alive = true,
    raf = 0,
    playing = false,
    frame = 0,
    data,
    selected,
    pendingPlayback = false,
    executionMessage = "",
    busy = false,
    activeJobId = null,
    manualId,
    expandedScene,
    promptMentions;
  const $ = (id) => container.querySelector("#" + id),
    url = "/api/projects/" + encodeURIComponent(projectId) + "/motion";
  const api = async (action, body) => {
    const r = await fetch(
      url + "/" + action,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    const result = await r.json();
    if (!r.ok) throw new Error(result.error);
    return result;
  };
  const error = (e) => {
    if (alive && $("m-error")) {
      $("m-error").textContent = String(e);
      $("m-job").textContent = "Запрос не выполнен. Причина указана ниже.";
    }
  };
  const guarded = (fn) => async () => {
    try {
      $("m-error").textContent = "";
      await fn();
    } catch (e) {
      error(e);
    }
  };
  stop = () => {
    promptMentions?.destroy();
    alive = false;
    playing = false;
    cancelAnimationFrame(raf);
    window.removeEventListener("message", receive);
  };
  container.innerHTML = "<p>Загружаем анимационный проект…</p>";
  function receive(event) {
    if (
      event.origin !== location.origin ||
      event.source !== $("m-preview")?.contentWindow
    )
      return;
    if (event.data?.type === "motion-ready") {
      send({ type: "motion-state", state: data.document.state, revision:data.document.revision });
      seek(frame);
      if (pendingPlayback) {
        pendingPlayback = false;
        play();
        $("m-job").textContent =
          executionMessage || "Анимация обновлена. Воспроизводим preview.";
      }
    }
    if(event.data?.type === "motion-render-error")error(event.data.error);
    if (event.data?.type === "motion-select") {
      selected = data.objects.find(
        (o) =>
          o.targetId === event.data.targetId &&
          o.sceneId === event.data.sceneId,
      );
      if (selected) {
        $("m-scenes").value = selected.sceneId;
        expandedScene = selected.sceneId;
        objects();
        promptMentions?.suggest(selected);
      }
    }
  }
  function send(message) {
    $("m-preview")?.contentWindow?.postMessage(message, location.origin);
  }
  function seek(value) {
    if (!Number.isFinite(value)) return;
    frame = Math.max(
      0,
      Math.min(
        data.document.state.settings.durationFrames - 1,
        Math.floor(value),
      ),
    );
    $("m-frame").value = String(frame);
    $("m-scrub").value = String(frame);
    drawTimeline();
    $("m-time").textContent =
      `${(frame / data.document.state.settings.fps).toFixed(2)} / ${(data.document.state.settings.durationFrames / data.document.state.settings.fps).toFixed(2)} с`;
    send({ type: "motion-frame", frame });
  }
  let timelineBars = [];
  function drawTimeline() {
    if (!timelineBars.length) return;
    const max = data.document.state.settings.durationFrames - 1;
    const position = (frame / Math.max(1, max)) * (timelineBars.length - 1);
    let peak = Math.round(position);
    timelineBars.forEach((bar, i) => {
      const distance = Math.abs(i - position);
      const levels = [26, 20, 14, 10, 6];
      const height = levels[Math.min(4, Math.floor(distance))];
      bar.style.height = height + "px";
      bar.classList.toggle("peak", i === peak);
    });
    const track = $("m-timeline");
    track.setAttribute("aria-valuenow", String(frame));
    track.setAttribute("aria-valuemax", String(max));
    track.setAttribute(
      "aria-valuetext",
      (frame / data.document.state.settings.fps).toFixed(2) + " секунд",
    );
  }
  function resizeTimeline() {
    const track = $("m-timeline");
    if (!track) return;
    const count = Math.max(1, Math.floor((track.clientWidth + 8) / 10));
    track.replaceChildren(
      ...Array.from({ length: count }, () => {
        const bar = document.createElement("span");
        bar.className = "timeline-bar";
        return bar;
      }),
    );
    timelineBars = [...track.children];
    drawTimeline();
  }
  function pause() {
    playing = false;
    cancelAnimationFrame(raf);
    $("m-play").textContent = "Воспроизвести";
  }
  function curves() {
    if (!$("m-curves")) return;
    const animations = data.document.state.animations.filter(
      (a) =>
        !selected ||
        (a.targetId === selected.targetId && a.sceneId === selected.sceneId),
    );
    const transitions = (data.document.state.objectTransitions ?? []).filter(
      (t) => !selected || t.logicalObjectId === selected.logicalObjectId,
    );
    const items = [
      ...animations.map((a) => ({
        id: a.animationId,
        label: a.effect + " · " + a.animationId,
        easing: a.easing,
      })),
      ...transitions.map((t) => ({
        id: t.transitionId,
        label: "Переход · " + t.transitionId,
        easing: t.easing === "springSoft" ? "springStateLegacy" : t.easing,
      })),
    ];
    const previous = $("m-curves").value;
    $("m-curves").innerHTML = items
      .map((a) => `<option value="${esc(a.id)}">${esc(a.label)}</option>`)
      .join("");
    if (items.some((a) => a.id === previous)) $("m-curves").value = previous;
    const draw = () => {
      const item = items.find((a) => a.id === $("m-curves").value);
      if (!item) {
        $("m-curve").innerHTML = "";
        $("m-curve-label").textContent =
          "У выбранного объекта пока нет кривой движения";
        return;
      }
      const c = curveData(item.easing);
      $("m-curve").innerHTML =
        `<path class="curve-guide" d="M12 ${c.startY}H248 M12 ${c.endY}H248"/><path class="curve-line" d="${c.path}"/><circle cx="12" cy="${c.startY}" r="3"/><circle cx="248" cy="${c.endY}" r="3"/>`;
      $("m-curve-label").textContent =
        `${c.name} · диапазон ${c.min.toFixed(2)}…${c.max.toFixed(2)}`;
    };
    $("m-curves").onchange = draw;
    draw();
  }
  function objects() {
    const scene = $("m-scenes").value;
    container.querySelectorAll("[data-scene-row]").forEach((row) => {
      const id = row.dataset.sceneRow,
        button = row.querySelector("[data-scene-button]");
      button.setAttribute("aria-expanded", String(id === expandedScene));
      row.classList.toggle("active", id === scene);
      const list = container.querySelector(
        '[data-scene-objects="' + CSS.escape(id) + '"]',
      );
      list.hidden = id !== expandedScene;
      if (id !== expandedScene) return;
      const items = data.objects.filter((o) => o.sceneId === id);
      const byId = new Map(items.map((o) => [o.targetId, o]));
      list.innerHTML = items
        .slice(1)
        .map((o) => {
          let depth = 0,
            parent = byId.get(o.parentId),
            seen = new Set();
          while (parent && parent !== items[0] && !seen.has(parent.targetId)) {
            seen.add(parent.targetId);
            depth++;
            parent = byId.get(parent.parentId);
          }
          return `<button class="object ${selected?.targetId === o.targetId && selected?.sceneId === id ? "selected" : ""}" data-target="${esc(o.targetId)}" style="--depth:${Math.min(depth, 5)}" title="${esc(o.name)} · ${esc(o.targetId)} · ${esc(o.logicalObjectId || "")}"><span>${esc(o.name || o.type)}</span>${o.ambiguous ? '<small class="state-count">неоднозначно</small>' : o.stateCount > 1 ? `<small class="state-count">${o.stateCount} состояния</small>` : ""}</button>`;
        })
        .join("");
      list.querySelectorAll("[data-target]").forEach(
        (button) =>
          (button.onclick = () => {
            selected = items.find((o) => o.targetId === button.dataset.target);
            objects();
          }),
      );
    });
    curves();
    $("m-selected").textContent = selected
      ? `${selected.name} · ${selected.targetId}${selected.logicalObjectId ? ` · ${selected.stateCount} состояния · ${selected.logicalObjectId}` : ""}`
      : "Объект не выбран";
    $("m-visible").disabled = !selected;
    $("m-visible").checked = selected
      ? (data.document.state.visibility.find(
          (v) =>
            v.sceneId === selected.sceneId && v.targetId === selected.targetId,
        )?.visible ?? selected.visible)
      : true;
  }
  function refresh(reload = false) {
    const doc = data.document,
      s = doc.state.settings;
    $("m-fps").value = s.fps;
    $("m-seconds").value = s.durationFrames / s.fps;
    $("m-width").value = s.width;
    $("m-height").value = s.height;
    $("m-scrub").max = s.durationFrames - 1;
    $("m-frame").max = s.durationFrames - 1;
    $("m-undo").disabled = !doc.cursor;
    $("m-redo").disabled = doc.cursor >= doc.history.length;
    $("m-history").innerHTML = doc.history
      .map(
        (h, i) =>
          `<li>${i < doc.cursor ? "Применено:" : "Отменено:"} ${esc(h.request)} <small>${esc(h.origin)}</small>${[...(h.assumptions ?? []), ...(h.warnings ?? [])].map((note) => `<p class="muted">${esc(note)}</p>`).join("")}</li>`,
      )
      .join("");
    if (reload) {
      $("m-preview").style.aspectRatio = `${s.width}/${s.height}`;
      $("m-preview").src =
        url + "/preview?revision=" + encodeURIComponent(doc.revision);
    } else send({ type: "motion-state", state: doc.state, revision:doc.revision });
    objects();
    seek(frame);
  }
  function play() {
    if (playing) return;
    playing = true;
    $("m-play").textContent = "Пауза";
    if (frame >= data.document.state.settings.durationFrames - 1) seek(0);
    let start = performance.now(),
      initial = frame;
    const tick = (now) => {
      if (!playing || !alive) return;
      const s = data.document.state.settings;
      let f = initial + Math.floor(((now - start) / 1000) * s.fps);
      if (f >= s.durationFrames) {
        if ($("m-loop").checked) {
          f %= s.durationFrames;
          initial = f;
          start = now;
        } else {
          seek(s.durationFrames - 1);
          pause();
          return;
        }
      }
      seek(f);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  async function changed(operations, request, reload = false) {
    pause();
    const result = await api("operations", {
      expectedRevision: data.document.revision,
      operations,
      request,
    });
    data.document = result.document;

    $("m-proposal").textContent = "Изменения сохранены.";
    refresh(reload);
  }
  async function poll(jobId) {
    for (;;) {
      if (!alive)
        throw new Error(
          "Просмотр закрыт. Задание продолжает выполняться на сервере.",
        );
      const job = await api("jobs/" + jobId);
      if (job.status === "failed") {
        executionMessage =
          "Запрос не выполнен. Изменения этого запроса не подтверждены.";
        $("m-proposal").textContent = executionMessage;
        data = await api("");
        refresh(true);
        throw new Error(job.error);
      }
      if (job.status === "completed") return job.result;
      if (job.stage)
        $("m-job").textContent =
          {
            understanding: "Разбираем полный запрос…",
            generating: "Создаём движение…",
            checking: "Проверяем движение…",
            repairing: "Уточняем движение…",
            "recovering-project": "Восстанавливаем проект…",
            "code-repair-proposed": "Готовим предложение ремонта кода…",
            applying: "Сохраняем изменения…",
          }[job.stage] ?? "Понимаем запрос…";
      if (job.total)
        $("m-job").textContent = `Рендер: ${job.progress}/${job.total} кадров`;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  function showExecution(result) {
    if (result.manual) {
      manualId = result.id;
      $("m-manual").hidden = false;
      if (!$("m-settings-dialog").open) $("m-settings-dialog").showModal();
      $("m-manual-request").value =
        result.prompt + "\nJSON SCHEMA:\n" + JSON.stringify(result.schema);
      $("m-proposal").textContent =
        "Скопируйте запрос в Codex и вставьте JSON-ответ. Корректный ответ применится автоматически.";
      return;
    }
    $("m-proposal").textContent = [
      result.plan.summary,
      ...result.plan.assumptions,
      ...result.plan.warnings,
    ].join("\n");
    if ($("m-settings-dialog").open) $("m-settings-dialog").close();
    data.document = result.document;
    pause();
    frame = result.playbackStart ?? 0;
    const reconciliation = result.reconciliation;
    executionMessage = reconciliation
      ? `${reconciliation.status === "SUCCESS" ? "Применено" : reconciliation.status === "PARTIAL_SUCCESS" ? "Выполнено частично" : "Не выполнено"}: ${reconciliation.completed} из ${reconciliation.requested} ${result.intentContract ? "требований" : "задач"}.`
      : "";
    if (reconciliation?.validationLevels) {
      const render =
        {
          PASSED: "проверен",
          WARNING: "есть предупреждения",
          FAILED: "проверка не пройдена",
          NOT_TESTED: "проверен не полностью",
        }[reconciliation.validationLevels.render] ?? "не проверен";
      executionMessage += ` Рендер: ${render}. Художественная оценка не выполнялась.`;
    }
    if (result.persistence?.status === "DURABILITY_WARNING")
      executionMessage +=
        " Состояние записано, но подтверждение долговременного сохранения завершилось с предупреждением.";
    if (result.diagnosticPersistence?.status === "FAILED")
      executionMessage +=
        " Изменения сохранены, запись диагностики не завершена.";
    pendingPlayback = !reconciliation || reconciliation.completed > 0;
    refresh(true);
    $("m-job").textContent = executionMessage || "Запускаем preview…";
    if (reconciliation && reconciliation.status !== "SUCCESS")
      $("m-error").textContent = result.tasks
        .filter((t) => t.status !== "PASSED")
        .map((t) => `${t.targetReference.name}: ${t.error}`)
        .join("\n");
  }
  async function plan() {
    if (busy) return;
    const request = $("m-ai").value;
    if (!request.trim()) throw new Error("Опишите анимацию.");
    if (/^(верни как было|отмени|undo)[.!\s]*$/i.test(request)) {
      const r = await api("undo", { expectedRevision: data.document.revision });
      data.document = r.document;
      refresh(true);
      return;
    }
    busy = true;
    executionMessage = "";
    pendingPlayback = false;
    $("m-proposal").textContent = "";
    $("m-generate").disabled = true;
    $("m-job").textContent = "Понимаем запрос…";
    try {
      const job = await api("execute", {
        mode:
          data.document.state.animations.length ||
          data.document.state.objectTransitions?.length ||
          data.document.state.expressions?.length
            ? "edit"
            : "create",
        request,
        mentions: promptMentions.references(),
        activeSceneId: $("m-scenes").value,
        expectedRevision: data.document.revision,
        settings: {
          provider: selectedProviderId(
            $("m-provider").value,
            data.availableProviders ?? [],
          ),
          model: $("m-model").value.trim(),
        },
        ...(selected
          ? {
              selectedObjectId: selected.targetId,
              selectedSceneId: selected.sceneId,
            }
          : {}),
      });
      activeJobId = job.jobId;
      $("m-cancel").hidden = false;
      showExecution(await poll(job.jobId));
    } finally {
      busy = false;
      activeJobId = null;
      if (alive) {
        $("m-generate").disabled = false;
        $("m-cancel").hidden = true;
      }
    }
  }
  try {
    data = await api("");
    if (!alive) return;
    expandedScene = data.scenes[0]?.sceneId;
    container.innerHTML = `<div class="director">
      <aside class="scene-sidebar"><a class="project-switch" href="#" title="Все проекты"><span>${esc(projectName)}</span></a><div class="sidebar-label">СЦЕНЫ <span>${data.scenes.length}</span></div>
      <select id="m-scenes" hidden aria-hidden="true" tabindex="-1">${data.scenes.map((s) => `<option value="${esc(s.sceneId)}">${esc(s.name)}</option>`).join("")}</select>
      <div id="m-objects" class="scene-tree">${data.scenes.map((s, i) => `<div class="scene-row" data-scene-row="${esc(s.sceneId)}"><button data-scene-button="${esc(s.sceneId)}" aria-expanded="false" title="${esc(s.name)}"><span class="scene-title">Сцена ${i + 1}</span><span class="scene-name">${esc(s.name)}</span></button><iframe class="scene-thumb" title="Миниатюра сцены ${i + 1}" tabindex="-1" aria-hidden="true" loading="lazy" src="${url}/thumbnail/${encodeURIComponent(s.sceneId)}"></iframe></div><div class="scene-objects" data-scene-objects="${esc(s.sceneId)}" hidden></div>`).join("")}</div>
      <button id="m-open-settings" class="settings-launch">Настройки</button></aside>
      <div class="motion-workspace"><div class="viewer-toolbar"><div class="toolbar-actions"><button id="m-render" class="secondary">Экспорт MP4</button></div></div>
      <div class="video-stage"><iframe id="m-preview" title="Покадровый preview анимации"></iframe></div>
      <div class="transport"><button id="m-play" class="quiet">Воспроизвести</button><div id="m-timeline" role="slider" tabindex="0" aria-label="Позиция на таймлайне" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"></div><input type="range" min="0" value="0" id="m-scrub" hidden aria-hidden="true" tabindex="-1"><span id="m-time"></span></div>
      <div class="prompt-composer"><label class="sr-only" for="m-ai">Опишите анимацию</label><textarea id="m-ai" placeholder="Опишите, как должна двигаться сцена…"></textarea><div class="composer-footer"><button id="m-inspector" class="secondary">Inspector</button><button id="m-cancel" hidden>Отменить</button><button id="m-generate">Сделать</button></div></div>
      <div class="execution-status"><p id="m-job" role="status"></p><p id="m-error" role="alert"></p><div id="m-proposal"></div></div></div>
      <dialog id="m-settings-dialog" class="motion-settings"><div class="settings-heading"><h2>Настройки проекта</h2><button id="m-close-settings" class="quiet" aria-label="Закрыть настройки">Закрыть</button></div>
      <label>Тема<select id="m-theme"><option value="dark">Тёмная</option><option value="light">Светлая</option></select></label><h3>Видео</h3><div class="settings"><label>Длительность, с<input id="m-seconds" type="number" min="0.1" step="0.1"></label><label>FPS<input id="m-fps" type="number" min="1" max="60"></label><label>Ширина<input id="m-width" type="number" min="2" max="4096"></label><label>Высота<input id="m-height" type="number" min="2" max="4096"></label></div><button id="m-settings" class="secondary">Сохранить параметры видео</button>
      <div class="settings"><label>Текущий кадр<input id="m-frame" type="number" min="0" value="0"></label><label class="check-label"><input id="m-loop" type="checkbox" checked> Повторять видео</label></div><h3>Выбранный объект</h3><p id="m-selected"></p><label class="check-label"><input id="m-visible" type="checkbox"> Показывать объект</label>
      <details class="curve-inspector"><summary>Кривая движения</summary><label>Анимация<select id="m-curves"></select></label><svg id="m-curve" viewBox="0 0 260 124" role="img" aria-label="Кривая easing: время слева направо, прогресс снизу вверх"></svg><p id="m-curve-label"></p></details><h3>AI-агент</h3><p id="m-provider-status">Проверяем подключение…</p><label>Подключение<select id="m-provider"><option value="" disabled>Выберите подключение</option>${(data.availableProviders ?? ["codex-sdk", "codex-cli"]).map((id) => `<option value="${esc(id)}">${esc(PROVIDER_LABELS[id] ?? id)}</option>`).join("")}<option value="manual-response">Ручной обмен с Codex</option></select></label><label>Модель<input id="m-model" placeholder="По умолчанию провайдера"></label>
      <div id="m-manual" hidden><label>Запрос для Codex<textarea id="m-manual-request" readonly></textarea></label><label>Ответ JSON<textarea id="m-manual-response"></textarea></label><button id="m-read-response">Загрузить ответ</button></div>
      <details><summary>Диагностика Motion Agent</summary><button id="m-debug-load" class="secondary">Последняя проверка</button><pre id="m-debug" style="white-space:pre-wrap;max-height:400px;overflow:auto"></pre><div id="m-debug-tasks"></div><img id="m-debug-sheet" style="width:100%" hidden alt="Контрольные кадры QA"></details><h3>Диагностика композиции</h3><ul>${(data.diagnostics ?? []).map((d) => `<li>${esc(d)}</li>`).join("") || "<li>Нет замечаний</li>"}</ul><h3>История запросов</h3><ol id="m-history"></ol><h3>Готовые видео</h3><div id="m-videos"></div><h3>История изменений</h3><div class="actions"><button id="m-undo">Отменить изменение</button><button id="m-redo">Повторить изменение</button></div><h3>Исходный дизайн</h3><button id="update" class="secondary">Обновить из Figma</button></dialog></div>`;
    $("m-theme").value = document.documentElement.dataset.theme ?? "dark";
    $("m-theme").onchange = () => {
      document.documentElement.dataset.theme = $("m-theme").value;
      try {
        localStorage.setItem("motion-theme", $("m-theme").value);
      } catch {}
    };
    const timeline = $("m-timeline");
    let dragPointer;
    const scrubPointer = (event) => {
      const box = timeline.getBoundingClientRect();
      const value = Math.max(
        0,
        Math.min(1, (event.clientX - box.left) / Math.max(1, box.width)),
      );
      const next = Math.round(
        value * (data.document.state.settings.durationFrames - 1),
      );
      if (next !== frame) seek(next);
    };
    timeline.onpointerdown = (event) => {
      if (event.button !== 0 || dragPointer !== undefined) return;
      event.preventDefault();
      dragPointer = event.pointerId;
      timeline.setPointerCapture(event.pointerId);
      pause();
      scrubPointer(event);
    };
    timeline.onpointermove = (event) => {
      if (event.pointerId === dragPointer) scrubPointer(event);
    };
    const finishDrag = (event) => {
      if (event.pointerId !== dragPointer) return;
      if (event.type === "pointerup") scrubPointer(event);
      dragPointer = undefined;
      if (timeline.hasPointerCapture(event.pointerId))
        timeline.releasePointerCapture(event.pointerId);
    };
    timeline.onpointerup = finishDrag;
    timeline.onpointercancel = finishDrag;
    timeline.onlostpointercapture = () => {
      dragPointer = undefined;
    };
    $("m-timeline").onkeydown = (event) => {
      let next;
      if (event.key === "ArrowRight") next = frame + 1;
      if (event.key === "ArrowLeft") next = frame - 1;
      if (event.key === "Home") next = 0;
      if (event.key === "End")
        next = data.document.state.settings.durationFrames - 1;
      if (next !== undefined) {
        event.preventDefault();
        pause();
        seek(next);
      }
    };
    const timelineObserver = new ResizeObserver(resizeTimeline);
    timelineObserver.observe($("m-timeline"));
    const detachInspector = attachInspector(container, url);
    const previousStop = stop;
    stop = () => {
      detachInspector();
      timelineObserver.disconnect();
      previousStop();
    };
    if (data.activeJob?.id) {
      activeJobId = data.activeJob.id;
      busy = true;
      $("m-ai").disabled = true;
      $("m-generate").disabled = true;
      $("m-cancel").hidden = false;
      $("m-job").textContent = "Восстанавливаем подключение к выполняющемуся заданию…";
      pollJob(data.activeJob.id)
        .then(showExecution)
        .catch(error)
        .finally(() => {
          busy = false;
          $("m-ai").disabled = false;
          $("m-generate").disabled = false;
          $("m-cancel").hidden = true;
        });
    }
    $("m-debug-load").onclick = guarded(async () => {
      const diagnostics = await api("diagnostics");
      $("m-debug").textContent = JSON.stringify(diagnostics, null, 2);
      const proposal = diagnostics["proposal.json"];
      const tasks = diagnostics["tasks.json"]?.tasks ?? [];
      $("m-debug-tasks").replaceChildren();
      for (const task of tasks) {
        const attempt = task.repairHistory
          ?.filter((h) => h.entry?.qa)
          .at(-1)?.attempt;
        const row = document.createElement("p");
        row.textContent = `${task.targetReference.name} → ${task.techniqueId}: ${task.status}`;
        if (attempt) {
          const button = document.createElement("button");
          button.textContent = "Кадры проверки";
          button.onclick = () => {
            $("m-debug-sheet").hidden = false;
            $("m-debug-sheet").src =
              url +
              "/qa/" +
              diagnostics.id +
              "/" +
              task.taskId +
              "-attempt-" +
              attempt +
              "/contact-sheet.png";
          };
          row.append(" ", button);
        }
        $("m-debug-tasks").append(row);
      }
      const attempt = tasks.length
        ? null
        : proposal?.attempts
          ? "attempt-" + proposal.attempts
          : proposal
            ? "manual"
            : null;
      $("m-debug-sheet").hidden = !attempt;
      if (attempt)
        $("m-debug-sheet").src =
          url + "/qa/" + diagnostics.id + "/" + attempt + "/contact-sheet.png";
    });
    $("m-open-settings").onclick = () => $("m-settings-dialog").showModal();
    $("m-close-settings").onclick = () => $("m-settings-dialog").close();
    $("update").onclick = () => {
      $("m-settings-dialog").close();
      onUpdate();
    };
    container.querySelectorAll("[data-scene-button]").forEach(
      (button) =>
        (button.onclick = () => {
          const id = button.dataset.sceneButton;
          expandedScene = expandedScene === id ? undefined : id;
          $("m-scenes").value = id;
          $("m-scenes").onchange();
        }),
    );
    window.addEventListener("message", receive);
    const recoverySection = document.createElement("details");
    recoverySection.innerHTML = `<summary>Автоматическое восстановление</summary><label class="check-label"><input type="checkbox" id="m-recovery-enabled"> Восстанавливать операции проекта</label><label>Модель восстановления<input id="m-recovery-model" value="gpt-6-sol"></label><label>Усилие<select id="m-recovery-effort"><option value="low">Низкое</option><option value="medium">Среднее</option><option value="high">Высокое</option></select></label><label>Попытки<input id="m-recovery-attempts" type="number" min="0" max="3"></label><label>Бюджет, секунд<input id="m-recovery-seconds" type="number" min="1" max="180"></label><label>Бюджет токенов<input id="m-recovery-tokens" type="number" min="1000" max="100000"></label><label class="check-label"><input type="checkbox" id="m-code-repair-enabled"> Разрешить отправку разрешённых исходников AI-провайдеру для ремонта кода</label><label>Модель ремонта кода<input id="m-code-repair-model" value="gpt-6-sol"></label><p>Клиентские проекты не передаются. Патчи и тесты создаются изолированно; код приложения автоматически не меняется.</p><button id="m-save-recovery" class="secondary">Сохранить восстановление</button><p id="m-recovery-status" role="status"></p>`;
    $("m-settings-dialog").append(recoverySection);
    let recoverySettings;
    api("recovery-settings").then(settings => {
      if (!alive) return;
      recoverySettings = settings;
      $("m-recovery-enabled").checked = settings.enabled;
      $("m-recovery-model").value = settings.model;
      $("m-recovery-effort").value = settings.effort;
      $("m-recovery-attempts").value = settings.maxAttempts;
      $("m-recovery-seconds").value = settings.maxDurationMs / 1000;
      $("m-recovery-tokens").value = settings.maxTokens;
      $("m-code-repair-enabled").checked = settings.codeRepair.enabled;
      $("m-code-repair-model").value = settings.codeRepair.model;
    }).catch(e => { if (alive) $("m-recovery-status").textContent = e.message; });
    $("m-save-recovery").onclick = guarded(async () => {
      if (!recoverySettings) throw Error("Настройки ещё загружаются");
      recoverySettings = await api("recovery-settings", { ...recoverySettings,
        enabled: $("m-recovery-enabled").checked, model: $("m-recovery-model").value.trim(), effort: $("m-recovery-effort").value,
        maxAttempts: Number($("m-recovery-attempts").value), maxDurationMs: Number($("m-recovery-seconds").value) * 1000, maxTokens: Number($("m-recovery-tokens").value),
        codeRepair: { ...recoverySettings.codeRepair, enabled: $("m-code-repair-enabled").checked, model: $("m-code-repair-model").value.trim() },
      });
      $("m-recovery-status").textContent = "Сохранено";
    });
    $("m-provider").value = data.provider?.provider ?? "";
    $("m-model").value = data.provider?.model ?? "";
    if (data.providerSettingsError) {
      error(new Error(PROVIDER_SETTINGS_MESSAGE));
      $("m-generate").disabled = true;
    }
    const saveAISettings = guarded(async () => {
      const settings = {
        provider: selectedProviderId(
          $("m-provider").value,
          data.availableProviders ?? [],
        ),
        model: $("m-model").value.trim(),
      };
      await api("provider-settings", settings);
      data.provider = settings;
      const status = await api("provider");
      if (alive) $("m-provider-status").textContent = status.message;
      delete data.providerSettingsError;
      $("m-error").textContent = "";
      $("m-generate").disabled = busy;
    });
    $("m-provider").onchange = saveAISettings;
    $("m-model").onchange = saveAISettings;
    $("m-scenes").onchange = () => {
      pause();
      selected = undefined;
      objects();
      const block = data.document.state.blocks.find(
        (b) => b.sceneId === $("m-scenes").value,
      );
      if (block) seek(block.startFrame);
    };
    $("m-visible").onchange = guarded(async () => {
      if (!selected) throw new Error("Выберите объект");
      await changed(
        [
          {
            type: "setVisibility",
            sceneId: selected.sceneId,
            targetId: selected.targetId,
            visible: $("m-visible").checked,
          },
        ],
        "Изменить видимость",
      );
    });
    $("m-play").onclick = () => (playing ? pause() : play());
    $("m-scrub").oninput = () => {
      pause();
      seek(Number($("m-scrub").value));
    };
    $("m-frame").oninput = () => {
      pause();
      seek(Number($("m-frame").value));
    };
    $("m-cancel").addEventListener("click", async () => {
      if (activeJobId) {
        $("m-cancel").disabled = true;
        try {
          await api("cancel", { jobId: activeJobId });
          $("m-job").textContent = "Отменяем генерацию…";
        } finally {
          $("m-cancel").disabled = false;
        }
      }
    });
    promptMentions = attachMentions($("m-ai"));
    $("m-generate").onclick = guarded(plan);
    $("m-ai").onkeydown = (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void guarded(plan)();
      }
    };
    for (const action of ["undo", "redo"])
      $("m-" + action).onclick = guarded(async () => {
        pause();
        data.document = (await api(action, { expectedRevision: data.document.revision })).document;
        refresh(true);
      });
    $("m-settings").onclick = guarded(async () => {
      const state = data.document.state;
      const fps = Number($("m-fps").value),
        durationFrames = Math.round(Number($("m-seconds").value) * fps);
      const settings = {
        fps,
        durationFrames,
        width: Number($("m-width").value),
        height: Number($("m-height").value),
        strictDuration: true,
      };
      const operations = [{ type: "setProjectSettings", settings }];
      if (durationFrames !== state.settings.durationFrames) {
        const last = [...state.blocks]
          .sort((a, b) => a.startFrame - b.startFrame)
          .at(-1);
        operations.push({
          type: "setBlockDuration",
          blockId: last.blockId,
          durationFrames: durationFrames - last.startFrame,
        });
      }
      await changed(operations, "Изменить технические требования", true);
    });
    $("m-read-response").onclick = guarded(async () =>
      showExecution(
        await api("manual-response", {
          proposalId: manualId,
          response: JSON.parse($("m-manual-response").value),
        }),
      ),
    );
    async function videos() {
      const r = await api("renders");
      if (alive)
        $("m-videos").innerHTML = r.files
          .map(
            (file) =>
              `<p><a href="${url}/renders/${encodeURIComponent(file)}" download>Скачать MP4 · ${esc(file)}</a></p>`,
          )
          .join("");
    }
    $("m-render").onclick = guarded(async () => {
      pause();
      $("m-render").disabled = true;
      try {
        const job = await api("render", {});
        await poll(job.jobId);
        $("m-job").textContent = "MP4 готов.";
        await videos();
      } finally {
        if (alive) $("m-render").disabled = false;
      }
    });
    refresh(true);
    void videos().catch(error);
    void api("provider")
      .then((status) => {
        if (alive) $("m-provider-status").textContent = status.message;
      })
      .catch(error);
  } catch (e) {
    if (alive) container.textContent = String(e);
  }
}
