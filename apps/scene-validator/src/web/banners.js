const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function mountBanners(app,isCurrent=()=>true){
 document.body.dataset.page='banners';let disposed=false,project=null,selected='',layer='',timer=null,renderKey='';
 const controller=new AbortController();
 async function api(url,body){const r=await fetch(url,{signal:controller.signal,...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const value=await r.json();if(!r.ok)throw Error(value.error||'Не удалось выполнить запрос');return value;}
 const [brands,projects]=await Promise.all([api('/api/brands'),api('/api/banners')]);
 if(!isCurrent()){controller.abort();return ()=>{};}
 app.innerHTML=`<section class="banner-workspace banner-studio"><header><h1>Баннеры</h1><nav><button id="banner-new">Новый проект</button><a href="#">В главное меню</a></nav></header>
 <label class="banner-project-picker">Проекты <select id="banner-project"><option value="">Новый баннер</option>${projects.map(p=>`<option value="${escape(p.id)}">${escape(p.title)}</option>`).join('')}</select></label>
 <form id="banner-create"><h2>Что создаём?</h2><label>Бренд <select id="banner-brand">${brands.map(b=>`<option value="${escape(b.id)}">${escape(b.name)}</option>`).join('')}</select></label>
 <textarea id="banner-brief" required maxlength="4000" placeholder="Например: горизонтальный новогодний баннер. Скидка 25% на молоко с картой X5 Клуб."></textarea>
 <div class="banner-format"><label>Ширина <input id="banner-width" type="number" min="120" max="4096" value="1200" required></label><label>Высота <input id="banner-height" type="number" min="120" max="4096" value="600" required></label><label>Варианты <input id="banner-count" type="number" min="1" max="12" placeholder="4 или по ТЗ"></label></div>
 <details><summary>Изображения</summary><p>Подходящие изображения берём из базы бренда. Недостающие фото и иллюстрации создаём через Krea; текст, логотип и композицию собираем в Акелле.</p><label>Модель Krea <select id="banner-image-model"><option value="openai/gpt-image-2">GPT Image 2</option><option value="google/nano-banana-2">Nano Banana 2</option><option value="google/nano-banana-pro">Nano Banana Pro</option></select></label></details>
 <button type="submit">Создать варианты</button></form>
 <p id="banner-status" role="status" aria-live="polite"></p><div id="banner-editor" hidden><div id="banner-canvas"></div><aside class="banner-conversation"><h2 id="banner-title"></h2><a id="banner-bundle">Скачать проект со слоями</a><div id="banner-messages" class="banner-messages"></div><form id="banner-chat"><label id="banner-scope" for="banner-prompt"></label><textarea id="banner-prompt" maxlength="4000" required placeholder="Замени текст на… или передвинь фотографию немного вправо"></textarea><button type="submit">Применить правку</button></form><div id="banner-inspector"></div><form id="banner-resize"><h3>Ресайз выбранного варианта</h3><div class="banner-format"><label>Ширина <input id="resize-width" type="number" min="120" max="4096" value="600" required></label><label>Высота <input id="resize-height" type="number" min="120" max="4096" value="900" required></label></div><button type="submit">Создать ресайз</button></form><button id="banner-undo">Отменить последнюю правку</button><details id="banner-review"></details></aside></div></section>`;
 const $=id=>app.querySelector('#'+id);
 const status=text=>{if(!disposed)$('banner-status').textContent=text;};
 const artifact=(v,ext)=>`/api/banners/${project.id}/${project.revision}/${encodeURIComponent(v.id)}.${ext}`;
 function selectVariant(id){selected=id;layer='';renderKey='';render();}
 function render(){
  if(disposed||!project)return;
  const busy=project.job?.status==='running';$('banner-create').hidden=true;$('banner-editor').hidden=false;
  $('banner-title').textContent=project.title;$('banner-bundle').href=`/api/banners/${project.id}/export`;$('banner-bundle').hidden=!project.variants.length;
  status(busy?project.job.stage:project.job?.status==='failed'?project.job.error:'');
  for(const f of ['banner-chat','banner-resize'])for(const el of $(f).querySelectorAll('button,textarea,input'))el.disabled=busy||!project.variants.length;
  $('banner-undo').disabled=busy||project.revision<2||project.parentRevision===null;
  if(!project.variants.some(v=>v.id===selected))selected=project.variants[0]?.id||'';
  const current=project.variants.find(v=>v.id===selected);$('banner-scope').textContent=current?`Правка: ${current.name}`:'Готовим варианты…';
  const key=project.revision+':'+selected+':'+layer+':'+project.messages.length;if(key===renderKey)return;renderKey=key;
  $('banner-canvas').innerHTML=project.variants.length?`<div class="banner-grid">${project.variants.map(v=>`<article class="banner-card ${v.id===selected?'is-selected':''}"><button class="banner-select" data-variant="${escape(v.id)}" aria-pressed="${v.id===selected}"><div class="banner-image-wrap"><img src="${artifact(v,'png')}" alt="${escape(v.name)}" width="${v.width}" height="${v.height}">${v.id===selected&&layer?highlight(v.layers.find(l=>l.id===layer),v):''}</div><h3>${escape(v.name)}</h3></button><div class="banner-exports"><span>${v.width} × ${v.height}</span><a href="${artifact(v,'png')}" download="${escape(v.id)}.png">PNG</a><a href="${artifact(v,'svg')}" download="${escape(v.id)}.svg">SVG</a><a href="/api/banners/${project.id}/${project.revision}/document.json" download="banner-document.json">Слои JSON</a></div></article>`).join('')}</div>`:'<div class="banner-working">Здесь появятся варианты.<br>Каждый макет сохранится с отдельными слоями.</div>';
  for(const button of $('banner-canvas').querySelectorAll('[data-variant]'))button.onclick=()=>selectVariant(button.dataset.variant);
  $('banner-messages').innerHTML=project.messages.map(m=>`<p class="banner-message ${m.role}">${escape(m.text)}</p>`).join('');$('banner-messages').scrollTop=$('banner-messages').scrollHeight;
  $('banner-inspector').innerHTML=current?`<details open><summary>Слои выбранного варианта</summary><div class="banner-layers">${[...current.layers].reverse().map(l=>`<button data-layer="${escape(l.id)}" aria-pressed="${l.id===layer}">${escape(l.name)}${l.kind==='text'?`<small>${escape(l.text)}</small>`:''}</button>`).join('')}</div></details>`:'';
  for(const button of $('banner-inspector').querySelectorAll('[data-layer]'))button.onclick=()=>{layer=button.dataset.layer;renderKey='';render();const l=current.layers.find(l=>l.id===layer);$('banner-scope').textContent=`Правка: ${current.name} · ${l.name}`;};
  $('banner-review').innerHTML=project.review?`<summary>Проверка композиции</summary><p>${escape(project.review.summary)}</p>${project.review.issues.map(i=>`<p>${escape(i.variantId)}: ${escape(i.message)}</p>`).join('')}`:'';
 }
 function highlight(l,v){return l?`<span class="banner-layer-highlight" style="left:${100*l.x/v.width}%;top:${100*l.y/v.height}%;width:${100*l.width/v.width}%;height:${100*l.height/v.height}%;transform:rotate(${l.rotation}deg)"></span>`:'';}
 async function open(id){clearTimeout(timer);renderKey='';project=await api('/api/banners/'+id);if(disposed)return;localStorage.setItem('akella-banner-project',id);$('banner-project').value=id;render();poll();}
 function poll(){clearTimeout(timer);if(disposed||project?.job?.status!=='running')return;timer=setTimeout(async()=>{const id=project.id;try{const fresh=await api('/api/banners/'+id);if(disposed||project?.id!==id)return;project=fresh;render();poll();}catch(e){status(e.message);}},2000);}
 function newProject(){clearTimeout(timer);project=null;selected='';layer='';renderKey='';localStorage.removeItem('akella-banner-project');$('banner-create').hidden=false;$('banner-editor').hidden=true;$('banner-project').value='';status('');}
 $('banner-new').onclick=newProject;$('banner-project').onchange=()=>{if($('banner-project').value)open($('banner-project').value).catch(e=>status(e.message));else newProject();};
 $('banner-create').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button[type=submit]');b.disabled=true;status('Создаём проект…');try{
  project=await api('/api/banners',{brand:$('banner-brand').value,brief:$('banner-brief').value,width:Number($('banner-width').value),height:Number($('banner-height').value),...($('banner-count').value?{count:Number($('banner-count').value)}:{}),imageModel:$('banner-image-model').value});
  const option=document.createElement('option');option.value=project.id;option.textContent=project.title;$('banner-project').append(option);$('banner-project').value=project.id;localStorage.setItem('akella-banner-project',project.id);render();poll();
 }catch(e){status(e.message);}finally{b.disabled=false;}};
 async function submit(action,prompt,width,height){const selectedLayer=project.variants.find(v=>v.id===selected)?.layers.find(l=>l.id===layer);project=await api(`/api/banners/${project.id}/chat`,{revision:project.revision,variantId:selected,action,prompt:prompt+(selectedLayer?`\nВыбранный слой: ${selectedLayer.id} (${selectedLayer.name}).`:''),...(width?{width,height}:{})});render();poll();}
 $('banner-chat').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;try{await submit('edit',$('banner-prompt').value);$('banner-prompt').value='';}catch(e){status(e.message);b.disabled=false;}};
 $('banner-resize').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;const w=Number($('resize-width').value),h=Number($('resize-height').value);try{await submit('resize',`Сделай ресайз ${w}×${h}. Сохрани всё содержимое, перекомпонуй объекты.`,w,h);}catch(e){status(e.message);b.disabled=false;}};
 $('banner-undo').onclick=async()=>{try{project=await api(`/api/banners/${project.id}/undo`,{revision:project.revision});renderKey='';render();}catch(e){status(e.message);}};
 const last=localStorage.getItem('akella-banner-project');if(last&&projects.some(p=>p.id===last))await open(last);
 return ()=>{disposed=true;clearTimeout(timer);controller.abort();};
}
