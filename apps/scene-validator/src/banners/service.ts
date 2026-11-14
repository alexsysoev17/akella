import {mkdir,readFile,writeFile,copyFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {CodexAdapter} from '../harness/providers/codex.js';
import {redactSecrets} from '../harness/security.js';
import {intentSchema,planSchema,reviewSchema,editIntentSchema,editSchema,applyEdits,assertResize,validateDesign,bannerProviderSchema,defaultAppearance,type BannerProject,type Variant,type Resource,type Plan} from './contracts.js';
import {projectDirectory,readProject,readBannerContext,saveProject,atomic,containedFile,hash} from './storage.js';
import {prepareBrandContext,loadBrand,pinnedReferenceImages,modelBrandContext} from './brand-context.js';
import {compositionGuide} from './composition.js';
import {artDirectionSchema,validateArtDirection,validateInspections,inspectedReviewSchema,typographyObservations,visualInspectionGuide} from './art-direction.js';
import {renderVariant} from './render.js';
import {generateKeyVisual} from './krea.js';
import JSZip from 'jszip';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {workspace} from './workspace.js';

const active=new Set<string>();
const initial=z.object({brand:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),brief:z.string().trim().min(1).max(4000),
  width:z.number().int().min(120).max(4096),height:z.number().int().min(120).max(4096),count:z.number().int().min(1).max(12).optional(),
  imageModel:z.enum(['openai/gpt-image-2','google/nano-banana-2','google/nano-banana-pro']).optional()}).strict();
const change=z.object({revision:z.number().int().min(0),prompt:z.string().trim().min(1).max(4000),variantId:z.string().max(100),
  action:z.enum(['edit','resize']),width:z.number().int().min(120).max(4096).optional(),height:z.number().int().min(120).max(4096).optional()}).strict();

async function model<T extends z.ZodType>(run:string,name:string,schema:T,prompt:string,images:string[]=[]) :Promise<z.infer<T>> {
  const directory=path.join(run,name);await mkdir(directory,{recursive:true});
  const adapter=new CodexAdapter('codex-sdk',directory);
  const response=await adapter.generate({messages:[{role:'system',content:'You are AKELLA\'s banner designer. Return only the requested structured document. '+compositionGuide},
    {role:'user',content:prompt}],images,responseSchema:bannerProviderSchema(schema),
    model:process.env.BANNER_MODEL||undefined,reasoningEffort:name.includes('intent')?'low':'high',
    timeoutMs:name==='design'?600000:360000,maxOutputTokens:18000});
  await atomic(path.join(directory,'usage.json'),{usage:response.usage,latencyMs:response.latencyMs,diagnostics:response.diagnostics});
  return schema.parse(response.output);
}
async function stage(p:BannerProject,message:string){p.job!.stage=message;await saveProject(p);}

export async function createBannerProject(input:unknown){
  const request=initial.parse(input);if(request.width*request.height>10_000_000)throw Error('Слишком большой холст');
  await loadBrand(request.brand);
  const id=randomUUID(),directory=projectDirectory(id);await mkdir(directory,{recursive:true});
  const p:BannerProject={version:1,id,brand:request.brand,brandSnapshot:'',title:request.brief.slice(0,70),brief:request.brief,revision:0,
    variants:[],resources:[],messages:[],updatedAt:new Date().toISOString()};await saveProject(p);
  await atomic(path.join(directory,'settings.json'),{imageModel:request.imageModel??'openai/gpt-image-2'});
  await enqueue(p,request.brief,async(run)=>{
    await stage(p,'Разбираем задачу и ищем визуальное направление…');
    const intent=await model(run,'intent',intentSchema,`Brief: ${request.brief}\nCanvas: ${request.width}×${request.height}. Count: ${request.count??'Use the explicitly requested number, otherwise 4'}. Produce 2–4 short separate asset search queries (subject, style and seasonal props) in Russian, plus a query for brand composition examples. audience=consumer for a customer promotion, employee for internal/HR communication, unspecified if unclear. Do not invent offer facts.`);
    p.title=intent.title;
    await stage(p,'Подбираем правила бренда, шрифты и изображения…');
    const prepared=await prepareBrandContext(p.brand,intent.assetQueries,intent.referenceQuery,directory,{...request,audience:intent.audience});
    const count=request.count??intent.count;
    const instructions=`BRIEF: ${request.brief}\nCreate exactly ${count} distinct variants at ${request.width}×${request.height}. The only authoritative offer facts are in the brief.\nBRAND EVIDENCE:\n${JSON.stringify(modelBrandContext(prepared.context))}\nChoose a relevant reference direction for each variant. Record the evidence IDs informing hierarchy, background and KV placement in sourceIds. In rationale briefly explain the visual idea and format adaptation in natural Russian for the user; do not print internal IDs or implementation details. Keep campaign/channel-scoped examples in their scope. Do not merely substitute objects on the same flat template.\nIf a suitable asset is present, use it. If not, request a standalone KV in generatedAssets with ID gen-..., and use that ID in an image layer. Each KV needs relevant style reference IDs from the candidate assets. No placeholder, no full-banner raster.\nGive a short Russian explanation of each composition. All variant and layer IDs must be unique within their scope. Layer order is back-to-front.`;
    await stage(p,`Собираем ${count} вариантов из отдельных слоёв…`);
    const directed=await model(run,'design',artDirectionSchema,instructions+'\nBefore placing layers, write one direction per variant: map the real offer, product and qualifiers to a deliberate reading order. Read the source text and identify what each group DOES. A source promo-mechanic card is not automatically a container for a card condition. Transfer the communicative structure together with its materials; if that structure is unsuitable, choose another source. Choose intended short line breaks and exact font resources. Preserve explicit brand spelling and typography. Then author the matching layers.',prepared.images);
    validateArtDirection(directed,prepared.context.evidence.filter((r:any)=>r.polarity==='positive').map((r:any)=>r.id));
    await atomic(path.join(run,'art-direction.json'),directed.directions);
    const plan=planSchema.parse({message:directed.message,variants:directed.variants,generatedAssets:directed.generatedAssets});
    if(plan.variants.length!==count||plan.variants.some(v=>v.width!==request.width||v.height!==request.height))throw Error('Агент вернул неверное число вариантов или размер');
    const resources=await generateAssets(p,run,plan,prepared.resources);
    await finish(p,run,plan,resources,instructions,prepared.images,{brandSnapshot:prepared.context.snapshot,context:prepared.context});
  });
  return p;
}

/** Trusted local recovery after a validator fix; intentionally not an HTTP/UI action.
 * Reuses an actual completed provider draft, never silently regenerates a paid KV.
 */
export async function recoverBannerCreationDraft(id:string,sourceRunId:string){
  if(!/^[a-f0-9-]{36}$/.test(sourceRunId))throw Error('Invalid source run');
  const p=await readProject(id),directory=projectDirectory(id);
  if(p.revision!==0||p.job?.status!=='failed'||p.job.id!==sourceRunId)throw Error('Recovery requires the current failed creation, without published content');
  const source=path.join(directory,'runs',sourceRunId);
  const planBytes=await readFile(await containedFile(source,'design/raw-response.json'));
  const raw=JSON.parse(planBytes.toString('utf8'));
  const plan=planSchema.parse({message:raw.message,variants:raw.variants,generatedAssets:raw.generatedAssets});
  if(plan.generatedAssets.length)throw Error('Generated KV recovery requires separate job reconciliation');
  const resources=JSON.parse(await readFile(path.join(directory,'prepared-resources.json'),'utf8')) as Resource[];
  const context=JSON.parse(await readFile(path.join(directory,'brand-context.json'),'utf8'));
  const instructions=await readFile(await containedFile(source,'design/request.txt'),'utf8');
  const images=[path.join(directory,'asset-sheet.png'),...await pinnedReferenceImages(directory,context)];
  await enqueue(p,'Повторная проверка сохранённых макетов после исправления вёрстки.',async run=>{
    await atomic(path.join(run,'reused-draft.json'),{sourceRunId,planSha256:hash(planBytes),reason:'local validator recovery; no new design or KV generation'});
    await finish(p,run,plan,resources,instructions,images,{brandSnapshot:context.snapshot,context});
  });
  return p;
}

/** Trusted recovery of a pre-generation draft after retrieval fixes. It obtains
 * newly grounded sources and asks the same designer to repair the existing work.
 * Never retries a submitted/ambiguous paid media job, and never edits a published revision.
 */
export async function regroundBannerCreationDraft(id:string,sourceRunId:string){
  if(!/^[a-f0-9-]{36}$/.test(sourceRunId))throw Error('Invalid source run');
  const p=await readProject(id),directory=projectDirectory(id);
  if(p.revision!==0||p.job?.status!=='failed'||p.job.id!==sourceRunId)throw Error('Grounding requires the current failed unpublished draft');
  const source=await containedFile(directory,`runs/${sourceRunId}/design/raw-response.json`);
  const prior=artDirectionSchema.parse(JSON.parse(await readFile(source,'utf8')));
  const runDirectory=path.dirname(path.dirname(source));
  if((await readdir(runDirectory)).some(name=>name.endsWith('-krea.json')))
    throw Error('Submitted media jobs require explicit reconciliation, not another generation');
  // Only the exact failed admission above is known to precede generateAssets.
  if(p.job.error!=='Выбран отсутствующий визуальный пример')throw Error('Draft did not fail before media generation; recovery needs review');
  const intent=intentSchema.parse(JSON.parse(await readFile(await containedFile(directory,`runs/${sourceRunId}/intent/raw-response.json`),'utf8')));
  const priorResources=JSON.parse(await readFile(path.join(directory,'prepared-resources.json'),'utf8')) as Resource[];
  await enqueue(p,'Уточняем выбранные примеры и материалы в сохранённом черновике.',async run=>{
    await atomic(path.join(run,'reused-draft.json'),{sourceRunId,reason:'Verified pre-media failure; re-ground existing draft against reviewed sources'});
    const prepared=await prepareBrandContext(p.brand,intent.assetQueries,intent.referenceQuery,directory,{width:prior.variants[0].width,height:prior.variants[0].height,audience:intent.audience});
    // Retrieval may select different supporting assets; existing pinned products
    // remain available so a narrower new shortlist cannot silently replace them.
    prepared.resources=[...new Map([...priorResources,...prepared.resources].map(r=>[r.id,r])).values()];
    prepared.context.resources=prepared.resources.map(({file,sha256,...r})=>r);
    const instructions=`BRIEF: ${p.brief}\nBRAND EVIDENCE:\n${JSON.stringify(modelBrandContext(prepared.context))}\nExisting draft: ${JSON.stringify(prior)}\nRepair this existing draft using the now supplied concrete source images and original materials. A composition study is valid evidence; its concrete image and material must be inspected. Preserve variant IDs, canvas sizes, exact offer text and original products/logos. Replace proposed generated material with an appropriate supplied original when present, and remove the now-unneeded generation request. Improve only visible hierarchy, text-strip padding, original background materials and their integration. Do not flatten dimensional source ribbons into generic waves. Keep source-dependent typography grouping. Return the four completed editable variants and their grounded directions.`;
    await stage(p,'Уточняем макеты по оригинальным материалам…');
    const directed=await model(run,'reference-repair',artDirectionSchema,instructions,prepared.images);
    validateArtDirection(directed,prepared.context.evidence.filter((r:any)=>r.polarity==='positive').map((r:any)=>r.id));
    const pendingIds=new Set(prior.generatedAssets.map(a=>a.id));
    const comparable=structuredClone(prior.variants);
    for(const v of comparable)for(const layer of v.layers)if(layer.kind==='image'&&pendingIds.has(layer.assetId)){
      const replacement=directed.variants.find(x=>x.id===v.id)?.layers.find(x=>x.id===layer.id);
      if(replacement&&prepared.resources.some(r=>r.id===replacement.assetId&&r.kind==='image'))layer.assetId=replacement.assetId;
    }
    // This unpublished grounding pass may replace generic decoration by reviewed
    // source materials. It still protects all copy, marks and actual product KVs.
    const withoutDecorImages=(variants:Variant[])=>variants.map(v=>({...v,layers:v.layers.filter(l=>!(l.kind==='image'&&['decoration','panel'].includes(l.role)))}));
    for(const v of directed.variants)for(const l of v.layers)if(l.kind==='image'&&['decoration','panel'].includes(l.role)&&
      !prepared.resources.some(r=>r.kind==='image'&&r.id===l.assetId)&&!pendingIds.has(l.assetId))throw Error('Grounding introduced an unreviewed decorative material');
    assertCreativeRepair(withoutDecorImages(comparable),withoutDecorImages(directed.variants));
    await atomic(path.join(run,'art-direction.json'),directed.directions);
    const plan=planSchema.parse({message:directed.message,variants:directed.variants,generatedAssets:directed.generatedAssets});
    const resources=await generateAssets(p,run,plan,prepared.resources);
    await finish(p,run,plan,resources,instructions,prepared.images,{brandSnapshot:prepared.context.snapshot,context:prepared.context});
  });
  return p;
}

async function enqueue(p:BannerProject,prompt:string,work:(run:string)=>Promise<void>){
  if(active.has(p.id)||p.job?.status==='running')throw Error('Дождись завершения текущего запроса');
  active.add(p.id);const id=randomUUID(),run=path.join(projectDirectory(p.id),'runs',id);await mkdir(run,{recursive:true});
  p.job={id,status:'running',stage:'Начинаем…'};p.messages.push({role:'user',text:prompt,at:new Date().toISOString()});await saveProject(p);
  void work(run).then(async()=>{p.job!.status='completed';p.job!.stage='Готово';await saveProject(p);}).catch(async(error)=>{
    // Reload committed state: failed drafts must never replace existing content.
    const current=await readProject(p.id);current.job={id,status:'failed',stage:'Запрос не завершён',error:redactSecrets(String(error.message||error))};
    await saveProject(current);
  }).finally(()=>active.delete(p.id));
}

async function generateAssets(p:BannerProject,run:string,plan:Plan,resources:Resource[]){
  const directory=projectDirectory(p.id),result=[...resources];
  const settings=JSON.parse(await readFile(path.join(directory,'settings.json'),'utf8'));
  for(const request of plan.generatedAssets){
    if(!request.id.startsWith('gen-')||result.some(r=>r.id===request.id))throw Error('Invalid generated asset identity');
    const refs=request.referenceIds.map(id=>result.find(r=>r.id===id&&r.kind==='image'));
    if(refs.some(r=>!r))throw Error('Krea needs existing style reference images');
    const generated=await generateKeyVisual({cwd:directory,prompt:request.prompt,model:settings.imageModel,background:request.background,
      references:await Promise.all(refs.map(r=>containedFile(directory,r!.file))),onProgress:async(message,jobId)=>{
        if(jobId)await atomic(path.join(run,request.id+'-krea.json'),{jobId,model:settings.imageModel,request});
        await stage(p,message);
      }});
    // URL originates in Krea, never the language model. Only known provider CDNs.
    const url=new URL(generated.url);
    if(url.protocol!=='https:'||!['krea.ai','krea.ai.s3.amazonaws.com','krea-prod.s3.amazonaws.com','s3.amazonaws.com','cloudfront.net'].some(h=>url.hostname===h||url.hostname.endsWith('.'+h)))throw Error('Unrecognized Krea media host: '+url.hostname);
    const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw Error('Krea output download HTTP '+response.status);
    const type=response.headers.get('content-type')?.split(';')[0]??'';
    const ext=({'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp'} as Record<string,string>)[type];if(!ext)throw Error('Unsupported Krea output format');
    const chunks:Buffer[]=[];let size=0;for await(const chunk of response.body as any){size+=chunk.length;if(size>40*1024*1024)throw Error('Krea image too large');chunks.push(Buffer.from(chunk));}
    const bytes=Buffer.concat(chunks);let sha256=hash(bytes),file='resources/'+sha256+ext;
    await mkdir(path.join(directory,'resources'),{recursive:true});await writeFile(path.join(directory,file),bytes);
    let geometry:any={};
    if(request.background==='cutout'){
      await stage(p,'Подготавливаем прозрачный KV для вёрстки…');
      const target=path.join(directory,'resources',sha256+'-cutout.png');
      const {stdout}=await promisify(execFile)(path.join(workspace,'data/knowledge/.venv/bin/python'),[path.join(workspace,'scripts/knowledge/banner_cutout.py'),path.join(directory,file),target],{timeout:60000,maxBuffer:100000});
      geometry=JSON.parse(stdout);file=path.relative(directory,target);sha256=geometry.sha256;
    }
    result.push({id:request.id,name:request.name,kind:'image',file,sha256,width:geometry.width,height:geometry.height,source:{provider:'krea',jobId:generated.jobId,model:generated.model,prompt:request.prompt,referenceIds:request.referenceIds,style:request.style,background:request.background,originalSha256:hash(bytes),alphaPreparation:geometry.method}});
  }
  return result;
}

async function finish(p:BannerProject,run:string,plan:Plan,resources:Resource[],instructions:string,referenceImages:string[],options:{brandSnapshot?:string;original?:Variant;resize?:boolean;context:any}){
  const directory=projectDirectory(p.id);let variants=plan.variants;
  let reports:{textBoxes:unknown[]}[]=[];
  for(const r of resources)if(hash(await readFile(await containedFile(directory,r.file)))!==r.sha256)throw Error('Сохранённый ресурс изменился: '+r.id);
  const render=async()=>{
    const problems:string[]=[];reports=[];await mkdir(path.join(run,'renders'),{recursive:true});
    if(new Set(variants.map(v=>v.id)).size!==variants.length)throw Error('Повторяющиеся ID вариантов');
    for(const v of variants){
      const errors=validateDesign(v,resources);if(errors.length){problems.push(...errors.map(e=>v.id+': '+e));continue;}
      if(options.resize)assertResize(options.original!,v);
      const report=await renderVariant(directory,v,resources,path.join(run,'renders',v.id));reports.push(report);problems.push(...report.issues.map(e=>v.id+': '+e));
    }return problems;
  };
  await stage(p,'Проверяем вёрстку, текст и охранное поле логотипа…');
  for(let attempt=0;attempt<3;attempt++){
    const errors=await render();if(!errors.length)break;
    if(attempt===2)throw Error('Макеты сохранены как черновик запуска, но требуют исправления: '+errors.join('; '));
    const repaired=await model(run,'fit-repair-'+attempt,planSchema,`${instructions}\nCurrent document: ${JSON.stringify(variants)}\nFix ONLY these objective layout issues: ${JSON.stringify(errors)}. Preserve variant IDs, dimensions, all text, image identity and all other content. Return generatedAssets: [].`,referenceImages);
    assertLayoutOnly(variants,repaired.variants);variants=repaired.variants;
  }
  await stage(p,'Смотрим готовые макеты и проверяем композицию…');
  const rendered=variants.map(v=>path.join(run,'renders',v.id+'.png'));
  const reviewImages=[...referenceImages,...rendered];
  const imageOrder=`First ${referenceImages.length} images are source references or the original composition; the LAST ${rendered.length} images are actual outputs in order: ${variants.map(v=>v.id).join(', ')}.`;
  const inspection=await model(run,'visual-review',inspectedReviewSchema,`${instructions}\n${imageOrder}\n${visualInspectionGuide}\nActual measured text: ${JSON.stringify(typographyObservations(variants,reports))}\nDocument: ${JSON.stringify(variants)}`,reviewImages);
  validateInspections(inspection,variants);
  await atomic(path.join(run,'visual-inspections.json'),inspection.inspections);
  let review=reviewSchema.parse({summary:inspection.summary,issues:inspection.issues});
  // One bounded art-direction pass for creation; scoped edits do not invite unrelated restyling.
  if(review.issues.some(i=>i.severity==='error')||(!options.original&&review.issues.length)){
    const previous=variants;
    const beforeImages:string[]=[];
    for(const v of variants){const before=path.join(run,'renders',v.id+'-before-review.png');await copyFile(path.join(run,'renders',v.id+'.png'),before);beforeImages.push(before);}
    const repair=await model(run,'visual-repair',planSchema,`${instructions}\n${imageOrder}\nCurrent document: ${JSON.stringify(variants)}\nVisual review: ${JSON.stringify(review)}\nCorrect concrete visible problems, including weak hierarchy, flat or unrelated backgrounds and poor KV integration when identified against references. Preserve variants without issues. Preserve IDs, dimensions, exact text and image identity; return generatedAssets:[]. ${options.original?'Only adjust layout within the requested edit/resize; preserve all paint and layer identity.':'Paint, gradients, typography scale and decorative vector shapes may improve; never replace offer content or original images/logos. More effects are not inherently better.'}`,reviewImages);
    if(options.original)assertLayoutOnly(variants,repair.variants);else assertCreativeRepair(variants,repair.variants);
    variants=repair.variants;
    const errors=await render();if(errors.length){variants=previous;await render();review.summary+=' Геометрическая правка не прошла; оставлена предыдущая композиция.';}
    else {
      const decision=await model(run,'visual-review-final',reviewSchema.extend({prefer:z.enum(['candidate','previous'])}),
        `Compare candidate and previous compositions against the SAME references and brief. ${instructions}\nImages: first ${referenceImages.length} source references, then ${rendered.length} CANDIDATE outputs, then ${beforeImages.length} PREVIOUS outputs, in variant order ${variants.map(v=>v.id).join(', ')}. Prefer candidate only if concrete issues improve without new visual damage. Otherwise prefer previous. Report remaining issues for the chosen set. No universal beauty score.`,[...reviewImages,...beforeImages]);
      review={summary:decision.summary,issues:decision.issues};
      if(decision.prefer==='previous'){variants=previous;await render();}
    }
  }
  // Creative suggestions remain visible, rather than becoming arbitrary refusal tests.
  const revision=p.revision+1,revisionDir=path.join(directory,'revisions',String(revision));await mkdir(revisionDir,{recursive:true});
  const all=options.original?(options.resize?[...p.variants,...variants]:p.variants.map(v=>v.id===options.original!.id?variants[0]:v)):variants;
  for(const v of all){
    const base=variants.some(x=>x.id===v.id)?path.join(run,'renders',v.id):path.join(directory,'revisions',String(p.revision),v.id);
    for(const ext of ['png','svg','metrics.json'])await copyFile(base+'.'+ext,path.join(revisionDir,v.id+'.'+ext));
  }
  const next:BannerProject={...p,revision,parentRevision:p.revision||null,variants:all,resources,brandSnapshot:options.brandSnapshot??p.brandSnapshot,review,
    job:{...p.job!,status:'completed',stage:'Готово'},
    messages:[...p.messages,{role:'assistant',text:plan.message+(review.issues.length?'\n'+review.summary:''),at:new Date().toISOString()}]};
  await atomic(path.join(revisionDir,'brand-context.json'),options.context);
  await atomic(path.join(revisionDir,'document.json'),next);await saveProject(next);Object.assign(p,next);
}

export function assertLayoutOnly(before:Variant[],after:Variant[]){
  if(before.length!==after.length)throw Error('Layout repair changed variant count');
  for(const old of before){const v=after.find(v=>v.id===old.id);if(!v||v.width!==old.width||v.height!==old.height)throw Error('Layout repair changed canvas');assertResize(old,v);
    for(const layer of old.layers){const afterLayer=v.layers.find(l=>l.id===layer.id)!;
      if(!isDeepStrictEqual(layer.appearance??defaultAppearance,afterLayer.appearance??defaultAppearance))throw Error('Layout repair changed appearance: '+layer.id);}
  }
}
/** Art direction may improve paint and ornaments, never rewrite the offer or replace a KV. */
export function assertCreativeRepair(before:Variant[],after:Variant[]){
  if(before.length!==after.length||new Set(after.map(v=>v.id)).size!==before.length)throw Error('Creative repair changed variants');
  const decorative=(l:Variant['layers'][number])=>l.kind==='shape'&&['panel','decoration'].includes(l.role);
  for(const old of before){const v=after.find(v=>v.id===old.id);if(!v||v.width!==old.width||v.height!==old.height)throw Error('Creative repair changed canvas');
    const required=old.layers.filter(l=>!decorative(l)),actual=v.layers.filter(l=>!decorative(l));
    if(required.length!==actual.length)throw Error('Creative repair changed content');
    for(const l of required){const updated=actual.find(x=>x.id===l.id);if(!updated)throw Error('Creative repair removed content');
      for(const key of ['kind','role','text','assetId'] as const)if(updated[key]!==l[key])throw Error('Creative repair changed '+key);
      if(l.kind==='logo'&&(updated.opacity!==l.opacity||updated.rotation!==l.rotation))throw Error('Creative repair changed logo');
    }
  }
}
export async function changeBannerProject(id:string,input:unknown){
  const request=change.parse(input),p=await readProject(id);
  if(p.revision!==request.revision)throw Error('Макет уже изменился. Обнови страницу.');
  const original=p.variants.find(v=>v.id===request.variantId);if(!original)throw Error('Выбери вариант');
  if(request.action==='resize'&&(!request.width||!request.height))throw Error('Укажи размер ресайза');
  await enqueue(p,request.prompt,async run=>{
    const directory=projectDirectory(id);await stage(p,request.action==='resize'?'Перекомпоновываем те же объекты под новый формат…':'Разбираем правку выбранного варианта…');
    let resources=p.resources,context=await readBannerContext(p);
    let images=[path.join(directory,'revisions',String(p.revision),original.id+'.png'),...await pinnedReferenceImages(directory,context)];
    if(request.action==='edit'){
      const intent=await model(run,'edit-intent',editIntentSchema,`Edit request: ${request.prompt}\nExisting layers: ${JSON.stringify(original.layers.map(l=>({id:l.id,name:l.name,kind:l.kind,text:l.text})))}\nneedsAssets=true ONLY when the user requests a new/replacement image. Text edits, position/scale/color edits need no retrieval. Otherwise assetQueries=[],referenceQuery=''.`);
      if(intent.needsAssets){
        if((await loadBrand(p.brand)).catalog.snapshot!==p.brandSnapshot)throw Error('База бренда обновилась. Создай новый проект для новой версии бренда.');
        const prepared=await prepareBrandContext(p.brand,intent.assetQueries,intent.referenceQuery,directory,{...original,audience:context.audience,persistContext:false});
        resources=[...new Map([...prepared.resources,...p.resources].map(r=>[r.id,r])).values()];context={...prepared.context,resources:resources.map(({file,...r})=>r)};
        images=[images[0],...prepared.images];
      }
    }else if((await loadBrand(p.brand)).catalog.snapshot===p.brandSnapshot){
      const familyIds=[...new Set<string>(context.evidence.filter((e:any)=>original.sourceIds.includes(e.id)&&e.design?.familyId).map((e:any)=>e.design.familyId))];
      const prepared=await prepareBrandContext(p.brand,[],p.brief+' '+request.prompt,directory,{width:request.width,height:request.height,familyIds,audience:context.audience,persistContext:false});
      context={...prepared.context,resources:resources.map(({file,...r})=>r)};
      images=[images[0],...await pinnedReferenceImages(directory,context)];
    }
    const targetId=request.action==='resize'?original.id+'-'+request.width+'x'+request.height+'-'+randomUUID().slice(0,6):original.id;
    const instructions=`ORIGINAL BRIEF: ${p.brief}\nREQUEST: ${request.prompt}\nACTION: ${request.action}. Return exactly one variant, id=${targetId}, width=${request.width??original.width}, height=${request.height??original.height}.\nOriginal document: ${JSON.stringify(original)}\nBrand: ${JSON.stringify(modelBrandContext(context))}\n${request.action==='resize'?'Preserve exact existing layers, text, image IDs, colors, shapes and fonts. generatedAssets MUST be empty. Reflow layout, scale, font sizes and gradient positions/direction/radius; preserve gradient type and exact color/opacity stops.':'Only edit the selected composition according to the request. Preserve unchanged layers and content. Krea is only for a missing replacement image.'}`;
    let plan:Plan;
    if(request.action==='edit'){
      const edits=await model(run,'edit',editSchema,instructions+'\nReturn ONLY the minimal property patches required by the user, plus explicitly requested new/removal layers. Do not re-output the whole document. Preserve untouched properties. Use layerId="canvas" for background, variant name or rationale. When replacing an image, update its descriptive layer name and variant rationale if they otherwise describe the old subject. Names/rationale are editor metadata, not printed copy.',images);
      await atomic(path.join(run,'patches.json'),edits);
      plan={message:edits.message,variants:[applyEdits(original,edits)],generatedAssets:edits.generatedAssets};
    }else plan=await model(run,'edit',planSchema,instructions,images);
    if(plan.variants.length!==1||plan.variants[0].id!==targetId||plan.variants[0].width!==(request.width??original.width)||plan.variants[0].height!==(request.height??original.height))throw Error('Агент изменил другой вариант или формат');
    if(request.action==='resize'){if(plan.generatedAssets.length)throw Error('Ресайз не должен генерировать изображения');assertResize(original,plan.variants[0]);}
    else resources=await generateAssets(p,run,plan,resources);
    await finish(p,run,plan,resources,instructions,images,{original,resize:request.action==='resize',context});
  });return p;
}
export async function undoBannerProject(id:string,revision:number){
  if(active.has(id))throw Error('Дождись завершения запроса');active.add(id);
  try{
  const p=await readProject(id);if(p.job?.status==='running')throw Error('Дождись завершения запроса');
  const parent=p.parentRevision===undefined?revision-1:p.parentRevision;
  if(p.revision!==revision||!parent)throw Error('Нет предыдущей версии');
  const directory=projectDirectory(id),previous=JSON.parse(await readFile(await containedFile(directory,`revisions/${parent}/document.json`),'utf8')) as BannerProject;
  const next=revision+1,out=path.join(directory,'revisions',String(next));await mkdir(out,{recursive:true});
  for(const v of previous.variants)for(const ext of ['png','svg','metrics.json'])await copyFile(path.join(directory,'revisions',String(parent),v.id+'.'+ext),path.join(out,v.id+'.'+ext));
  try{await atomic(path.join(out,'brand-context.json'),await readBannerContext({...previous,id,revision:parent}));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;} // Legacy projects may predate stored reference context.
  const result={...previous,revision:next,parentRevision:previous.parentRevision===undefined?(parent>1?parent-1:null):previous.parentRevision,job:undefined,messages:[...p.messages,{role:'assistant' as const,text:'Предыдущее изменение отменено.',at:new Date().toISOString()}]};await atomic(path.join(out,'document.json'),result);await saveProject(result);return result;
  }finally{active.delete(id);}
}
export async function bannerFile(id:string,revision:string,name:string){
  if(!/^\d+$/.test(revision)||!/^[-\w:.]+\.(png|svg|json)$/.test(name))throw Error('Invalid banner artifact');
  const p=await readProject(id);if(Number(revision)>p.revision)throw Error('Revision not committed');
  return containedFile(projectDirectory(id),`revisions/${revision}/${name}`);
}
export async function exportBannerBundle(id:string){
  const p=await readProject(id);if(!p.variants.length)throw Error('Сначала создай макеты');
  const base=projectDirectory(id),zip=new JSZip();zip.file('document.json',JSON.stringify(p,null,2));
  for(const r of p.resources)zip.file(r.file,await readFile(await containedFile(base,r.file)));
  for(const v of p.variants)for(const ext of ['png','svg'])zip.file('banners/'+v.id+'.'+ext,await readFile(await bannerFile(id,String(p.revision),v.id+'.'+ext)));
  zip.file('README.txt','AKELLA banner-document/1\nEditable layer document: document.json. Resources are pinned by SHA-256. SVG preserves text and individual elements; PNG is a flattened preview. Figma publishing is not automatic.\n');
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
