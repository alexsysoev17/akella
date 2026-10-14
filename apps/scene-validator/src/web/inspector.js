const esc = (v) =>
  String(v ?? "NOT_AVAILABLE").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const pretty = (v) => JSON.stringify(v ?? "NOT_AVAILABLE", null, 2);
export function attachInspector(container, url) {
  const panel = document.createElement("aside");
  panel.className = "agent-inspector";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Agent Inspector");
  panel.innerHTML = `<div class="inspector-resize" role="separator" aria-label="Ширина Inspector" tabindex="0"></div><header><strong>Agent Inspector</strong><button data-close aria-label="Закрыть">×</button></header><select aria-label="История запусков"></select><div class="inspector-tabs" role="tablist">${["Обзор", "Понимание", "Действия", "QA", "Данные"].map((t, i) => `<button role="tab" data-tab="${i}">${t}</button>`).join("")}</div><div class="inspector-body"></div><footer><button data-copy>Скопировать отчёт</button><button data-zip>Скачать ZIP</button><button data-project-zip>Диагностика проекта</button><span role="status"></span></footer>`;
  container.append(panel);
  const select = panel.querySelector("select"),
    body = panel.querySelector(".inspector-body"),
    status = panel.querySelector("[role=status]");
  const values = new Map();
  let valueId = 0;
  let rawData,
    manualSelection = false,
    lastVersion;
  let tab = Number(localStorage.getItem("agent-inspector-tab")) || 0,
    data,
    timer,
    disposed = false,
    selectedId,
    loading = false;
  const fetchJSON = async (suffix) => {
    const r = await fetch(url + "/inspector" + suffix);
    if (!r.ok) throw new Error((await r.json()).error);
    return r.json();
  };
  function tree(value, key = "JSON") {
    const id = String(++valueId);
    values.set(id, value);
    if (value && typeof value === "object")
      return `<details data-value="${id}"><summary>${esc(key)} <small>${Array.isArray(value) ? value.length + " элементов" : Object.keys(value).length + " полей"}</small><button data-copy-value="${id}" title="Копировать значение">⧉</button></summary><div data-children></div></details>`;
    return `<div class="inspector-value"><span>${esc(key)}</span>: <code>${esc(value)}</code><button data-copy-value="${id}" title="Копировать значение">⧉</button></div>`;
  }
  body.addEventListener(
    "toggle",
    (e) => {
      const el = e.target;
      if (el.matches("details[data-value]") && el.open && !el.dataset.loaded) {
        el.dataset.loaded = "1";
        const value = values.get(el.dataset.value);
        el.querySelector("[data-children]").innerHTML = Object.entries(value)
          .map(([k, v]) => tree(v, k))
          .join("");
      }
    },
    true,
  );
  body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy-value]");
    if (b) {
      e.preventDefault();
      copy(pretty(values.get(b.dataset.copyValue)));
    }
  });
  function cards(items) {
    return items
      .map(
        (t) =>
          `<details><summary><span class="inspector-status">${esc(t.status)}</span> ${esc(t.targetReference?.name ?? t.target?.name ?? t.sceneId ?? t.requirementId)} · ${esc((t.techniques ?? [t.techniqueId]).filter(Boolean).join(" + "))}</summary><p>${esc(t.sourceText ?? t.userIntent ?? t.error ?? "")}</p><p>Сцена: ${esc(t.sceneId ?? t.targetReference?.sceneId ?? t.target?.sceneId)}<br>Figma ID: ${esc(t.target?.sourceNodeId ?? t.targetReference?.sourceNodeId)}<br>Logical ID: ${esc(t.target?.logicalObjectId ?? t.targetReference?.logicalObjectId)}</p>${t.inheritFromRequirementId ? `<p>Наследование: ${esc(t.inheritFromRequirementId)} · ${esc(t.inheritanceExplanation)}</p>` : ""}${tree(t, "Подробности")}</details>`,
      )
      .join("");
  }
  function block(title, value) {
    return `<section><h3>${esc(title)}</h3>${tree(value, title)}</section>`;
  }
  function render() {
    if (disposed) return;
    panel.querySelectorAll("[data-tab]").forEach((b) => {
      const active = Number(b.dataset.tab) === tab;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", String(active));
    });
    if (!data) {
      body.textContent =
        "Нет сохранённых запусков. Выполните запрос с включённой историей Harness.";
      return;
    }
    values.clear();
    const run = data.run,
      tasks = data.understanding?.tasks ?? run.result?.tasks ?? [],
      requirements =
        data.understanding?.contract?.requirements ??
        run.result?.requirements ??
        "NOT_AVAILABLE";
    if (tab === 0)
      body.innerHTML = `<p class="inspector-status">${esc(run.status)}</p><p>${esc(data.prompt)}</p><div class="inspector-metrics"><span>Длительность: ${run.metrics?.latencyMs != null ? (run.metrics.latencyMs / 1000).toFixed(2) + " с" : "NOT_AVAILABLE"}</span><span>Задач: ${tasks.length}</span><span>Выполнено: ${tasks.filter((t) => ["PASSED", "SUCCESS", "applied"].includes(t.status)).length}</span><span>Ошибок: ${tasks.filter((t) => ["FAILED", "UNSUPPORTED", "BLOCKED"].includes(t.status)).length}</span><span>Ремонтов: ${esc(run.metrics?.repairAttempts)}</span></div><p>${(run.calls ?? []).map((c) => esc(c.provider) + " · " + esc(c.model) + " · " + esc(c.status)).join("<br>") || "Provider: NOT_AVAILABLE"}</p><h3>Задачи</h3>${cards(tasks)}${run.status === "RUNNING" ? `<p>Текущий этап: ${esc(data.trace?.at(-1)?.stage)}</p>` : ""}${block("Итоговая сверка требований", run.outcome)}${block("Производительность", run.metrics)}${block("Знания и версии", run.knowledgeReferences)}${block("Ошибки", run.failures) + block("Настройки провайдера — валидация и источник", data.providerSettingsValidation) + block("Semantic — причины повторных вызовов и проверки", data.semanticDiagnostics)}`;
    if (tab === 1)
      body.innerHTML =
        "<h3>Требования и привязки объектов</h3>" +
        block(
          "Разрешение объектов, селекторов и контекстных ссылок",
          data.targetResolution,
        ) +
        (Array.isArray(requirements)
          ? cards(requirements)
          : "<p>NOT_AVAILABLE</p>");
    if (tab === 2)
      body.innerHTML =
        cards(tasks) +
        block("Полнота операций — ожидается / скомпилировано / пропущено", tasks.map(t => ({taskId:t.taskId,target:t.targetReference,coverage:t.operationCoverage ?? "NOT_AVAILABLE",primaryFailureReason:t.primaryFailureReason ?? null}))) +
        block("Сравнение попыток ремонта", data.repairComparisons) +
        block("Evaluator и метод выборки скорости", data.evaluator) +
        block(
          "Применённые изменения — before / after / operations",
          data.stateChanges,
        ) +
        `<h3>Хронология</h3>` +
        (Array.isArray(data.trace)
          ? data.trace
              .map(
                (e) =>
                  `<details><summary><time>${esc(e.at)}</time> · ${esc(e.stage)} · ${Math.round(e.durationMs)} мс от старта</summary>${tree(e.data)}</details>`,
              )
              .join("")
          : tree("NOT_AVAILABLE"));
    if (tab === 3)
      body.innerHTML =
        `<p>Художественная оценка: NOT_TESTED</p><p>Доступность сохранённых QA: ${esc(data.qaAvailability)}</p>` +
        (data.qa.length
          ? data.qa
              .map(
                (q) =>
                  `<section><h3>${esc(q.attempt)} · ${esc(q.report?.status)}</h3>${Object.entries(
                    q.categories,
                  )
                    .map(
                      ([category, checks]) =>
                        `<h4>${esc({ technical: "Техническая проверка", mathematics: "Математика движения", render: "Проверка рендера", visual: "Визуальное сравнение", artistic: "Художественная оценка" }[category] ?? category)}</h4>${Array.isArray(checks) ? checks.map((c) => `<details><summary>${esc(c.status)} · ${esc(c.name)} · ${esc(c.target ?? "")}</summary><p>${esc(c.reason ?? "Подробности в метриках проверки")}</p>${tree(c)}</details>`).join("") : esc(checks)}`,
                    )
                    .join(
                      "",
                    )}${block("Сырой QA Report", q.report)}<p>Сравнение с кадром без эффекта: NOT_AVAILABLE, если не сохранено в QA.</p><div class="inspector-frames">${q.frames.map((f) => `<a href="${url}/qa/${run.runId}/${q.attempt}/${f}" target="_blank" rel="noopener"><img loading="lazy" src="${url}/qa/${run.runId}/${q.attempt}/${f}" alt="${esc(f)}"></a>`).join("")}</div></section>`,
              )
              .join("")
          : "<p>QA: NOT_TESTED — сохранённых проверок нет.</p>");
    if (tab === 4 && !rawData) {
      body.textContent = "Загрузка данных…";
      fetchJSON("/" + selectedId + "?raw=1")
        .then((v) => {
          if (v.run.runId === selectedId) {
            rawData = v;
            render();
          }
        })
        .catch((e) => (status.textContent = e.message));
      return;
    }
    if (tab === 4) {
      body.innerHTML =
        '<input data-search placeholder="Поиск в данных" aria-label="Поиск JSON"><button data-json>Копировать JSON</button><div data-tree></div>';
      const target = body.querySelector("[data-tree]");
      target.innerHTML = tree(rawData);
      body.querySelector("[data-search]").oninput = (e) => {
        const query = e.target.value.toLocaleLowerCase();
        target.innerHTML = query
          ? tree(
              Object.fromEntries(
                Object.entries(rawData).filter(([k, v]) =>
                  (k + pretty(v)).toLocaleLowerCase().includes(query),
                ),
              ),
            )
          : tree(rawData);
      };
      body.querySelector("[data-json]").onclick = () => copy(pretty(rawData));
    }
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = "Скопировано";
    } catch {
      status.textContent = "Буфер обмена недоступен";
    }
  }
  async function update() {
    if (disposed || panel.hidden || loading) return;
    loading = true;
    try {
      const runs = await fetchJSON("");
      const old = selectedId;
      select.innerHTML = runs
        .map(
          (r) =>
            `<option value="${esc(r.runId)}">${esc(r.createdAt)} · ${esc(r.status)}</option>`,
        )
        .join("");
      selectedId =
        manualSelection && runs.some((r) => r.runId === old)
          ? old
          : runs[0]?.runId;
      select.value = selectedId || "";
      const current = runs.find((r) => r.runId === selectedId),
        version = pretty(current);
      if (version !== lastVersion || !data) {
        lastVersion = version;
        rawData = null;
        data = selectedId ? await fetchJSON("/" + selectedId) : null;
        render();
      }
      status.textContent = "";
    } catch (e) {
      status.textContent = e.message;
    } finally {
      loading = false;
    }
  }
  const button = container.querySelector("#m-inspector");
  button.onclick = () => {
    panel.hidden = !panel.hidden;
    container.classList.toggle("inspector-open", !panel.hidden);
    if (!panel.hidden) update();
  };
  panel.querySelector("[data-close]").onclick = () => {
    panel.hidden = true;
    container.classList.remove("inspector-open");
  };
  select.onchange = () => {
    manualSelection = true;
    selectedId = select.value;
    data = null;
    rawData = null;
    update();
  };
  panel.querySelectorAll("[data-tab]").forEach(
    (b) =>
      (b.onclick = () => {
        tab = Number(b.dataset.tab);
        localStorage.setItem("agent-inspector-tab", String(tab));
        render();
      }),
  );
  panel.querySelector("[data-copy]").onclick = async () => {
    if (!selectedId) return;
    status.textContent = "Подготовка отчёта…";
    try {
      const r = await fetch(url + "/inspector/" + selectedId + "/report");
      if (!r.ok) throw new Error("Ошибка отчёта");
      await copy(await r.text());
    } catch (e) {
      status.textContent = e.message;
    }
  };
  panel.querySelector("[data-zip]").onclick = () => {
    if (selectedId) {
      const a = document.createElement("a");
      a.href = url + "/inspector/" + selectedId + "/bundle";
      a.download = "agent-" + selectedId + ".zip";
      a.click();
    }
  };
  panel.querySelector("[data-project-zip]").onclick = () => {
    if(selectedId){const a=document.createElement("a");a.href=url+"/inspector/"+selectedId+"/project-bundle";a.download="project-diagnostic-"+selectedId+".zip";a.click();}
  };
  const grip = panel.querySelector(".inspector-resize");
  grip.onpointerdown = (e) => {
    if (e.button !== 0) return;
    grip.setPointerCapture(e.pointerId);
  };
  grip.onpointermove = (e) => {
    if (grip.hasPointerCapture(e.pointerId)) {
      const width = Math.min(
        window.innerWidth,
        Math.max(340, window.innerWidth - e.clientX),
      );
      panel.style.width = width + "px";
      container.style.setProperty("--inspector-width", width + "px");
    }
  };
  grip.onpointerup = grip.onpointercancel = (e) => {
    if (grip.hasPointerCapture(e.pointerId))
      grip.releasePointerCapture(e.pointerId);
  };
  grip.onkeydown = (e) => {
    if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
      e.preventDefault();
      panel.style.width =
        Math.max(
          340,
          Math.min(
            window.innerWidth,
            panel.clientWidth + (e.key === "ArrowLeft" ? 20 : -20),
          ),
        ) + "px";
      container.style.setProperty("--inspector-width", panel.style.width);
    }
  };
  timer = setInterval(() => {
    if (!document.hidden) update();
  }, 2000);
  return () => {
    disposed = true;
    clearInterval(timer);
    container.classList.remove("inspector-open");
    container.style.removeProperty("--inspector-width");
    panel.remove();
  };
}
