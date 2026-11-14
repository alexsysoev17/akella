import {anchorInspector} from '/anchor-inspector.js';
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
  const previewPreferenceKey='akella-preview-quality:'+projectId;
  let previewQuality='auto';try{const saved=localStorage.getItem(previewPreferenceKey);if(['auto','full','half','third','quarter'].includes(saved))previewQuality=saved;}catch{}
  let previewMetrics=null,incrementalPerformance=null,pivotInspector;
  function performanceView(){const el=$('m-preview-performance');if(el)el.textContent=JSON.stringify({motionEdit:incrementalPerformance,preview:previewMetrics},null,2);}
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
    activeVariantId = null,
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
  function typeIntoPrompt(event){
    if(!alive||event.defaultPrevented||event.isComposing||event.ctrlKey||event.metaKey||event.altKey||event.key.length!==1||document.querySelector('dialog[open]')||document.querySelector('.agent-inspector:not([hidden])'))return;
    const target=event.target;
    if(target.closest?.('input,textarea,[contenteditable="true"],select'))return;
    const input=$("m-ai");if(!input||input.disabled)return;
    event.preventDefault();input.focus();input.setRangeText(event.key,input.selectionStart,input.selectionEnd,'end');input.dispatchEvent(new Event('input',{bubbles:true}));
  }
  stop = () => {
    document.removeEventListener("keydown",typeIntoPrompt);
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
      send({ type: "motion-state", state: data.document.state, revision:data.document.revision,sourceFingerprint:data.document.sourceFingerprint });
      send({type:"motion-preview-quality",quality:previewQuality});
      seek(frame);
      pivotInspector?.select();
      selectionPreview();
      if (pendingPlayback) {
        pendingPlayback = false;
        play();
        $("m-job").textContent =
          executionMessage || "Анимация обновлена. Воспроизводим preview.";
      }
    }
    if(event.data?.type === 'motion-preview-metrics'){
      previewMetrics=event.data.metrics;performanceView();
    }
    if(event.data?.type === "motion-render-error")error(event.data.error);
    if(event.data?.type==="motion-anchor-start"){if(event.data.revision!==data.document.revision){error("STALE_ANCHOR_FRAME");return;}pause();seek(event.data.frame);return;}
    if(event.data?.type==="motion-anchor-drag"){if(event.data.revision!==data.document.revision||event.data.sceneId!==selected?.sceneId||event.data.targetId!==selected?.targetId){error("STALE_ANCHOR_FRAME");return;}pause();seek(event.data.frame);pivotInspector?.drag(event.data.point);return;}
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
    send({ type: "motion-frame", frame,playing });
  }
  let timelineBars = [];
  function drawTimeline() {
    if (!timelineBars.length) return;
    const max = data.document.state.settings.durationFrames - 1;
    const position = frame / Math.max(1,max);
    timelineBars[0].style.left = `calc(${position*100}% - ${position*17}px)`;
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
    const handle=document.createElement('span');
    handle.className='timeline-handle';
    track.replaceChildren(handle);
    timelineBars = [...track.children];
    drawTimeline();
  }
  function pause() {
    playing = false;
    send({type:'motion-playback',playing:false});
    cancelAnimationFrame(raf);
    $("m-play").textContent = "Воспроизвести";
    $("m-play").setAttribute("aria-pressed","false");
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
  let selectionPreviewKey='';
  function selectionPreview() {
    const host=$('m-selection-preview');if(!host)return;
    const sceneId=$('m-scenes').value;
    send({type:'motion-highlight-selection',sceneId:selected?.sceneId,targetId:selected?.targetId});
    const key=[sceneId,selected?.targetId,data.document.sourceFingerprint].join('/');
    if(key===selectionPreviewKey)return;selectionPreviewKey=key;
    host.replaceChildren();
    if(selected?.text!==undefined){
      const text=document.createElement('div');text.className='selection-text';text.textContent=selected.text;
      host.append(text);host.setAttribute('aria-label','Текст: '+selected.name);
    }else if(selected){
      const image=document.createElement('img');image.alt=selected.name;
      image.src=url+'/selection-thumbnail/'+encodeURIComponent(selected.targetId)+'?sceneId='+encodeURIComponent(selected.sceneId);
      image.onerror=()=>{if(host.contains(image)){host.textContent='Не удалось загрузить миниатюру';}};
      host.append(image);host.setAttribute('aria-label','Миниатюра: '+selected.name);
    }else{
      const image=document.createElement('iframe');image.title='Миниатюра выбранной сцены';image.tabIndex=-1;
      image.src=url+'/thumbnail/'+encodeURIComponent(sceneId);host.append(image);host.setAttribute('aria-label','Миниатюра сцены');
    }
  }
  function objects() {
    pivotInspector?.select();
    selectionPreview();
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
            pause();
            const block=data.document.state.blocks.find(b=>b.sceneId===selected.sceneId);
            if(block && (frame<block.startFrame||frame>=block.startFrame+block.durationFrames))seek(block.startFrame);
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
        url + "/preview?revision=" + encodeURIComponent(doc.revision)+'&quality='+encodeURIComponent(previewQuality);
    } else send({ type: "motion-state", state: doc.state, revision:doc.revision,sourceFingerprint:doc.sourceFingerprint });
    objects();
    seek(frame);
  }
  function play() {
    if (playing) return;
    playing = true;
    send({type:'motion-playback',playing:true});
    $("m-play").textContent = "Пауза";
    $("m-play").setAttribute("aria-pressed","true");
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
  function offerProductionResume(){
    container.querySelector('#m-production-resume')?.remove();
    const records=(data.directCheckpoints??[]).filter(p=>['PAUSED_RESUMABLE','RUNNING','CANCELLED'].includes(p.status));if(!records.length)return;
    const wrap=document.createElement('div');wrap.id='m-production-resume';
    for(const p of records.slice(0,3)){const button=document.createElement('button');button.type='button';button.textContent=`Продолжить (${p.operations} операций сохранено)`;button.onclick=guarded(async()=>{if(busy)return;busy=true;button.disabled=true;try{const job=await api('direct-resume',{runId:p.runId});activeJobId=job.jobId;$('m-cancel').hidden=false;showExecution(await poll(job.jobId));}finally{busy=false;activeJobId=null;if(alive)$('m-cancel').hidden=true;button.disabled=false;}});wrap.append(button);}
    $('m-proposal').after(wrap);
  }
  const variantLabels = {queued:'В очереди',copying:'Готовим исходники',understanding:'Изучаем раскадровку',generating:'Создаём движение',checking:'Проверяем движение',repairing:'Уточняем движение',applying:'Сохраняем',rendering:'Собираем видео',completed:'Готово',failed:'Не завершено',cancelled:'Остановлено',interrupted:'Прервано'};
  function showVariants(batch) {
    const region=$('m-variants');if(!region)return;
    let group=region.querySelector(`[data-batch="${batch.id}"]`);
    if(!group){group=document.createElement('section');group.className='motion-variants';group.dataset.batch=batch.id;group.innerHTML='<h3></h3><p class="variant-batch-status" role="status"></p><button class="variant-resume" type="button" hidden>Продолжить незавершённые</button><div class="motion-variant-grid"></div>';region.prepend(group);}
    group.querySelector('h3').textContent=`Варианты ролика · ${batch.variants.length}`;
    group.querySelector('.variant-batch-status').textContent=batch.error??({preparing:'Готовим независимые проекты…',directing:'Изучаем кадры и продумываем варианты…',animating:'Создаём ролики…',completed:'',failed:'Часть вариантов не завершена. Готовые результаты доступны.',cancelled:'Создание остановлено. Готовые результаты сохранены.',interrupted:'Сервер перезапущен. Сохранённые проекты доступны.'}[batch.stage]??'');
    const resume=group.querySelector('.variant-resume');resume.hidden=(!batch.plan&&batch.variants.some(v=>v.runId||v.revision||v.video))||['queued','running'].includes(batch.status)||!batch.variants.some(v=>v.status!=='completed'||['failed','cancelled'].includes(v.renderStatus));
    resume.onclick=guarded(async()=>{if(busy)return;busy=true;resume.disabled=true;$('m-generate').disabled=true;try{const job=await api('variants/resume',{batchId:batch.id,expectedSourceFingerprint:data.document.sourceFingerprint});activeVariantId=job.batchId;$('m-cancel').hidden=false;await pollVariants(job.batchId);}finally{busy=false;activeVariantId=null;if(alive){resume.disabled=false;$('m-generate').disabled=false;$('m-cancel').hidden=true;}}});
    for(const variant of batch.variants){
      let card=group.querySelector(`[data-variant="${variant.id}"]`);
      if(!card){card=document.createElement('article');card.className='motion-variant-card';card.dataset.variant=variant.id;card.innerHTML='<h4></h4><p class="variant-concept"></p><p class="variant-stage" role="status"></p><div class="variant-media"></div><p class="variant-error"></p><details class="variant-attempts" hidden><summary>Предыдущие попытки</summary><ul></ul></details><a class="variant-open">Открыть и редактировать</a><button type="button" class="variant-rerender">Обновить видео</button>';group.querySelector('.motion-variant-grid').append(card);}
      card.querySelector('h4').textContent=variant.title;
      card.querySelector('.variant-concept').textContent=variant.concept;
      card.querySelector('.variant-stage').textContent=variant.stage==='rendering'&&variant.total?`Собираем видео · ${variant.progress}/${variant.total}`:variantLabels[variant.stage]??'Создаём движение…';
      card.querySelector('.variant-error').textContent=variant.error??variant.renderError??'';
      const attempts=card.querySelector('.variant-attempts');attempts.hidden=!variant.attempts?.length;attempts.querySelector('ul').replaceChildren(...(variant.attempts??[]).map(a=>{const li=document.createElement('li');li.textContent=`${variantLabels[a.status]??a.status}${a.error||a.renderError?': '+(a.error??a.renderError):''}`;return li;}));
      const link=card.querySelector('.variant-open');link.hidden=!variant.projectId||['queued','running'].includes(variant.status)||variant.renderStatus==='running';if(variant.projectId)link.href='#project/'+variant.projectId;
      const rerender=card.querySelector('.variant-rerender');rerender.hidden=!variant.projectId||variant.status!=='completed';rerender.disabled=['queued','running'].includes(batch.status);
      rerender.onclick=guarded(async()=>{if(busy)return;busy=true;rerender.disabled=true;$('m-generate').disabled=true;try{const response=await fetch(`/api/projects/${encodeURIComponent(variant.projectId)}/motion`),child=await response.json();if(!response.ok)throw Error(child.error??'Не удалось открыть вариант');const job=await api('variants/rerender',{batchId:batch.id,variantId:variant.id,expectedRevision:child.document.revision,expectedSourceFingerprint:data.document.sourceFingerprint});activeVariantId=job.batchId;$('m-cancel').hidden=false;await pollVariants(job.batchId);}finally{busy=false;activeVariantId=null;if(alive){rerender.disabled=false;$('m-generate').disabled=false;$('m-cancel').hidden=true;}}});
      const media=card.querySelector('.variant-media');
      if(variant.video&&media.dataset.file!==variant.video){const video=document.createElement('video');video.controls=true;video.loop=true;video.preload='metadata';video.src=`/api/projects/${encodeURIComponent(variant.projectId)}/motion/renders/${encodeURIComponent(variant.video)}`;video.setAttribute('aria-label',variant.title);media.replaceChildren(video);media.dataset.file=variant.video;}
    }
  }
  async function pollVariants(batchId){
    while(alive){const batch=await api('variants/'+batchId);showVariants(batch);if(!['queued','running'].includes(batch.status))return batch;await new Promise(resolve=>setTimeout(resolve,1200));}
  }
  async function createVariants(request,count){
    const job=await api('variants',{request,count,expectedSourceFingerprint:data.document.sourceFingerprint,settings:{provider:selectedProviderId($('m-provider').value,data.availableProviders??[]),model:$('m-model').value.trim()}});
    activeVariantId=job.batchId;$('m-cancel').hidden=false;
    await pollVariants(job.batchId);if(alive)$('m-job').textContent='';
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
          ({NEEDS_USER_INPUT:"Нужно уточнение.",TECHNICAL_BLOCKED:"Техническое ограничение. Исходная анимация сохранена.",RESOURCE_LIMIT_REACHED:"Достигнут лимит выполнения. Исходная анимация сохранена.",CANCELLED:"Выполнение отменено."})[job.agentDisposition]??"Запрос не выполнен. Изменения этого запроса не подтверждены.";
        $("m-proposal").textContent = executionMessage;
        data = await api("");
        refresh(true);
        throw new Error(job.error);
      }
      if (job.status === "completed") return job.result;
      if (job.stage)
        $("m-job").textContent =
          {
            'production-planning':'Планируем анимацию…',
            'direct-resuming':'Продолжаем сохранённое исполнение…',
            'production-resuming':'Продолжаем с сохранённого этапа…',
            'production-finalizing':'Сохраняем готовую анимацию…',
            understanding: "Разбираем полный запрос…",
            generating: "Создаём движение…",
            checking: "Проверяем движение…",
            repairing: "Уточняем движение…",
            "recovering-project": "Восстанавливаем проект…",
            "investigating-recovery": "Проверяем причину сбоя и готовим исправление…",
            "code-repair-proposed": "Готовим предложение ремонта кода…",
            applying: "Сохраняем изменения…",
          }[job.stage] ?? (job.stage.startsWith('production-task:')?'Создаём этап '+job.stage.slice(16)+'…':'Понимаем запрос…');
      if (job.total)
        $("m-job").textContent = `Рендер: ${job.progress}/${job.total} кадров`;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  function showExecution(result) {
    if(!alive)return;
    if(result.status==='applied'){data.directCheckpoints=(data.directCheckpoints??[]).filter(p=>p.runId!==result.id);offerProductionResume();}
    if(['paused','PAUSED_RESUMABLE','CANCELLED'].includes(result.status)){executionMessage=result.summary??'Готовые этапы сохранены. Можно продолжить.';$('m-proposal').textContent=executionMessage;void api('').then(next=>{data=next;offerProductionResume();});return;}

    if (result.manual) {
      manualId = result.id;
      $("m-manual").hidden = false;

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
    executionMessage = result.agentRuntime ? result.plan.summary : reconciliation
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
    if(result.time?.warnings?.length)executionMessage+=" "+result.time.warnings.join(" ");
    pendingPlayback = !reconciliation || reconciliation.completed > 0;
    refresh(true);
    $("m-job").textContent = executionMessage || "Запускаем preview…";
    if (reconciliation && reconciliation.status !== "SUCCESS")
      $("m-error").textContent = result.tasks
        .filter((t) => t.status !== "PASSED")
        .map((t) => `${t.targetReference.name}: ${t.error}`)
        .join("\n");
  }
  let settingsPending;
  async function plan() {
    if(settingsPending)await settingsPending;
    if (busy) return;
    const request = $("m-ai").value;
    if (!request.trim()) throw new Error("Опишите анимацию.");
    if (/^(верни как было|отмени|undo)[.!\s]*$/i.test(request)) {
      const seconds=frame/data.document.state.settings.fps;
      const r = await api("undo", { expectedRevision: data.document.revision });
      data.document = r.document;
      frame=Math.round(seconds*data.document.state.settings.fps);
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
      const count=Number($('m-variant-count').value);
      if(count>1){await createVariants(request,count);return;}
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
        currentFrame:frame,
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
      const result=await poll(job.jobId);
      incrementalPerformance=result.incrementalPerformance??null;
      showExecution(result);performanceView();
    } finally {
      busy = false;
      activeJobId = null;
      activeVariantId = null;
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
      <div id="m-selection-preview" class="selection-preview" aria-live="polite"></div><div id="m-objects" class="scene-tree">${data.scenes.map((s, i) => `<div class="scene-row" data-scene-row="${esc(s.sceneId)}"><button data-scene-button="${esc(s.sceneId)}" aria-expanded="false" title="${esc(s.name)}"><span class="scene-title">${esc(/^\d+$/.test(s.name)?"СЦЕНА "+s.name:s.name)}</span><span class="scene-name">${esc(s.name)}</span></button><iframe class="scene-thumb" title="Миниатюра сцены ${i + 1}" tabindex="-1" aria-hidden="true" loading="lazy" src="${url}/thumbnail/${encodeURIComponent(s.sceneId)}"></iframe></div><div class="scene-objects" data-scene-objects="${esc(s.sceneId)}" hidden></div>`).join("")}</div>
      <button id="m-open-settings" class="settings-launch">Светлая тема</button></aside>
      <div class="motion-workspace"><div class="viewer-toolbar"><div class="toolbar-actions"><label>Preview <select id="m-preview-quality" aria-label="Качество предпросмотра"><option value="auto">Auto</option><option value="full">Full · 100%</option><option value="half">Half · 50%</option><option value="third">Third · 33.33%</option><option value="quarter">Quarter · 25%</option></select></label><details><summary>Производительность</summary><pre id="m-preview-performance">Ожидаем первый кадр…</pre></details><button id="m-render" class="secondary">Экспорт MP4</button><select id="m-draft-quality" aria-label="Разрешение чернового видео"><option value="full">Full</option><option value="half">Half</option><option value="third">Third</option><option value="quarter" selected>Quarter</option></select><button id="m-draft" class="secondary">Черновой MP4</button></div></div>
      <div class="video-stage"><iframe id="m-preview" title="Покадровый preview анимации"></iframe></div>
      <div class="transport"><button id="m-play" class="quiet">Воспроизвести</button><div id="m-timeline" role="slider" tabindex="0" aria-label="Позиция на таймлайне" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"></div><input type="range" min="0" value="0" id="m-scrub" hidden aria-hidden="true" tabindex="-1"><span id="m-time"></span></div>
      <div class="prompt-composer"><label class="sr-only" for="m-ai">Опишите анимацию</label><textarea id="m-ai" placeholder="ПЕЧАТАЙТЕ ЗДЕСЬ"></textarea><div class="composer-footer"><button id="m-inspector" class="secondary">Inspector</button><label class="variant-count-label">Варианты<select id="m-variant-count" aria-label="Количество вариантов ролика"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option><option value="6">6</option><option value="7">7</option><option value="8">8</option></select></label><button id="m-cancel" hidden>Отменить</button><button id="m-generate">Сделать</button></div></div>
      <div class="execution-status"><p id="m-job" role="status"></p><p id="m-error" role="alert"></p><div id="m-proposal"></div></div></div><div id="m-variants"></div>
      <dialog id="m-settings-dialog" class="motion-settings" hidden inert><div class="settings-heading"><h2>Настройки проекта</h2><a href="#skills">Библиотека анимаций</a><button id="m-close-settings" class="quiet" aria-label="Закрыть настройки">Закрыть</button></div>
      <label>Тема<select id="m-theme"><option value="dark">Тёмная</option><option value="light">Светлая</option></select></label><h3>Видео</h3><div class="settings"><label>Длительность, с<input id="m-seconds" type="number" min="0.1" step="0.1"></label><label>FPS<input id="m-fps" type="number" min="1" max="60"></label><label>Ширина<input id="m-width" type="number" min="2" max="4096"></label><label>Высота<input id="m-height" type="number" min="2" max="4096"></label></div><button id="m-settings" class="secondary">Сохранить параметры видео</button>
      <div class="settings"><label>Текущий кадр<input id="m-frame" type="number" min="0" value="0"></label><label class="check-label"><input id="m-loop" type="checkbox" checked> Повторять видео</label></div><h3>Выбранный объект</h3><p id="m-selected"></p><label class="check-label"><input id="m-visible" type="checkbox"> Показывать объект</label>
      <details class="curve-inspector"><summary>Кривая движения</summary><label>Анимация<select id="m-curves"></select></label><svg id="m-curve" viewBox="0 0 260 124" role="img" aria-label="Кривая easing: время слева направо, прогресс снизу вверх"></svg><p id="m-curve-label"></p></details><h3>AI-агент</h3><p id="m-provider-status">Проверяем подключение…</p><label>Подключение<select id="m-provider"><option value="" disabled>Выберите подключение</option>${(data.availableProviders ?? ["codex-sdk", "codex-cli"]).map((id) => `<option value="${esc(id)}">${esc(PROVIDER_LABELS[id] ?? id)}</option>`).join("")}<option value="manual-response">Ручной обмен с Codex</option></select></label><label>Модель<input id="m-model" placeholder="Codex: gpt-6-astra, либо выберите модель"></label>
      <div id="m-manual" hidden><label>Запрос для Codex<textarea id="m-manual-request" readonly></textarea></label><label>Ответ JSON<textarea id="m-manual-response"></textarea></label><button id="m-read-response">Загрузить ответ</button></div>
      <details><summary>Диагностика Motion Agent</summary><button id="m-debug-load" class="secondary">Последняя проверка</button><pre id="m-debug" style="white-space:pre-wrap;max-height:400px;overflow:auto"></pre><div id="m-debug-tasks"></div><img id="m-debug-sheet" style="width:100%" hidden alt="Контрольные кадры QA"></details><h3>Диагностика композиции</h3><ul>${(data.diagnostics ?? []).map((d) => `<li>${esc(d)}</li>`).join("") || "<li>Нет замечаний</li>"}</ul><h3>История запросов</h3><ol id="m-history"></ol><h3>Готовые видео</h3><div id="m-videos"></div><h3>История изменений</h3><div class="actions"><button id="m-undo">Отменить изменение</button><button id="m-redo">Повторить изменение</button></div><h3>Исходный дизайн</h3><button id="update" class="secondary">Обновить из Figma</button></dialog></div>`;
    const director=container.querySelector('.director');
    const menu=document.createElement('aside');menu.className='workspace-menu';
    menu.innerHTML='<a href="#">НОВЫЙ ПРОЕКТ</a><a href="#">ОТКРЫТЬ ПРОЕКТ</a><a href="#" id="m-home">В ГЛАВНОЕ МЕНЮ</a>';
    menu.append($("m-inspector"),container.querySelector('.viewer-toolbar'));director.append(menu);
    menu.querySelector('a').onclick=event=>{event.preventDefault();window.dispatchEvent(new Event('akella-new-project'));};

    const renderQuality=document.createElement('label');renderQuality.textContent='КАЧЕСТВО РЕНДЕРА';
    $("m-draft-quality").before(renderQuality);renderQuality.append($("m-draft-quality"));
    $("m-settings-dialog").append($("m-draft"));
    container.querySelector('.toolbar-actions').append($("m-render"));
    $("m-inspector").textContent='ИНСПЕКТОР';
    container.querySelector('.viewer-toolbar label').firstChild.textContent='КАЧЕСТВО ПРЕВЬЮ';
    for(const selectId of ['m-preview-quality','m-draft-quality'])for(const option of $(selectId).options)option.textContent=({auto:'АВТО',full:'ПОЛНОЕ',half:'ПОЛОВИНА',third:'ТРЕТЬ',quarter:'ЧЕТВЕРТЬ'})[option.value]??option.textContent;
    function textQualityPicker(selectId,title){
      const select=$(selectId),host=select.parentElement;
      const group=document.createElement('div');group.className='text-quality-picker';
      const toggle=document.createElement('button');toggle.type='button';toggle.textContent=title;toggle.setAttribute('aria-expanded','false');
      const choices=document.createElement('div');choices.className='text-quality-choices';choices.hidden=true;
      for(const [value,label] of [['full','ПОЛНОЕ'],['half','ПОЛОВИНА'],['third','ТРЕТЬ'],['quarter','ЧЕТВЕРТЬ']]){
        const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.quality=value;
        button.onclick=()=>{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));sync();};choices.append(button);
      }
      const sync=()=>{for(const button of choices.children){const selected=button.dataset.quality===select.value;button.classList.toggle('is-selected',selected);button.setAttribute('aria-pressed',String(selected));}};
      toggle.onclick=()=>{choices.hidden=!choices.hidden;toggle.setAttribute('aria-expanded',String(!choices.hidden));sync();};
      select.addEventListener('change',sync);select.hidden=true;select.tabIndex=-1;
      group.append(toggle,choices,select);host.replaceWith(group);
    }
    textQualityPicker('m-preview-quality','КАЧЕСТВО ПРЕВЬЮ');
    textQualityPicker('m-draft-quality','КАЧЕСТВО РЕНДЕРА');
    $("m-ai").addEventListener('focus',()=>$("m-ai").classList.add('prompt-started'));
    document.addEventListener('keydown',typeIntoPrompt);
    $("m-preview").addEventListener('load',()=>{try{$("m-preview").contentDocument.addEventListener('keydown',typeIntoPrompt);}catch{}});
    function applyTheme(theme) {
      const dark = theme === 'dark';
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      $('m-theme').value = dark ? 'dark' : 'light';
      $('m-open-settings').textContent = dark ? 'Тёмная тема' : 'Светлая тема';
      $('m-open-settings').title = dark ? 'Включить светлую тему' : 'Включить тёмную тему';
      try { localStorage.setItem('motion-theme', dark ? 'dark' : 'light'); } catch {}
    }
    applyTheme(document.documentElement.dataset.theme ?? 'light');
    $('m-theme').onchange = () => applyTheme($('m-theme').value);
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
    pivotInspector=anchorInspector(container,{getData:()=>data,getSelected:()=>selected,getFrame:()=>frame,api,refresh,send,error});
    menu.append($("m-open-settings"));
    const detachInspector = attachInspector(container, url);
    const previousStop = stop;
    stop = () => {
      detachInspector();
      timelineObserver.disconnect();
      previousStop();
    };
    offerProductionResume();
    $('m-variant-count').value=data.document.state.animations.length||data.document.state.objectTransitions?.length||data.document.state.expressions?.length?'1':'4';
    for(const batch of [...(data.variantBatches??[])].reverse())showVariants(batch);
    const activeBatch=data.variantBatches?.find(batch=>['queued','running'].includes(batch.status));
    if(activeBatch){activeVariantId=activeBatch.id;busy=true;$('m-generate').disabled=true;$('m-cancel').hidden=false;void pollVariants(activeBatch.id).catch(error).finally(()=>{busy=false;activeVariantId=null;if(alive){$('m-generate').disabled=false;$('m-cancel').hidden=true;}});}
    if (data.activeJob?.id) {
      activeJobId = data.activeJob.id;
      busy = true;
      $("m-ai").disabled = true;
      $("m-generate").disabled = true;
      $("m-cancel").hidden = false;
      $("m-job").textContent = "Восстанавливаем подключение к выполняющемуся заданию…";
      poll(data.activeJob.id)
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
    $('m-open-settings').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
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
      if(activeVariantId){$('m-cancel').disabled=true;try{await api('variants/cancel',{batchId:activeVariantId});$('m-job').textContent='Останавливаем создание вариантов…';}catch(e){error(e);}finally{$('m-cancel').disabled=false;}return;}
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
        const seconds=frame/data.document.state.settings.fps;
        data.document = (await api(action, { expectedRevision: data.document.revision })).document;
        frame=Math.round(seconds*data.document.state.settings.fps);
        refresh(true);
      });
    $("m-settings").onclick = guarded(async () => {
      if(settingsPending)return;
      pause();
      $("m-settings").disabled=true;
      $("m-generate").disabled=true;
      const playheadSeconds=frame/data.document.state.settings.fps;
      settingsPending=(async()=>{
        const result=await api("settings",{expectedRevision:data.document.revision,fps:Number($("m-fps").value),...(Number($("m-seconds").value)!==data.document.state.settings.durationFrames/data.document.state.settings.fps?{durationSeconds:Number($("m-seconds").value)}:{}),width:Number($("m-width").value),height:Number($("m-height").value)});
        data.document=result.document;
        frame=Math.round(playheadSeconds*data.document.state.settings.fps);
        refresh(true);
        $("m-job").textContent=(result.warnings??[]).join(" ") || "Параметры видео сохранены.";
      })();
      try{await settingsPending;}finally{settingsPending=undefined;$("m-settings").disabled=false;$("m-generate").disabled=busy;}
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
    $('m-preview-quality').value=previewQuality;
    $('m-preview-quality').onchange=()=>{previewQuality=$('m-preview-quality').value;try{localStorage.setItem(previewPreferenceKey,previewQuality);}catch{}send({type:'motion-preview-quality',quality:previewQuality});};
    $('m-draft').onclick=guarded(async()=>{pause();$('m-draft').disabled=true;try{const job=await api('render',{mode:'draft',quality:$('m-draft-quality').value});await poll(job.jobId);$('m-job').textContent='Черновой MP4 готов.';await videos();}finally{if(alive)$('m-draft').disabled=false;}});
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
