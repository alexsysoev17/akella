import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { LoadedProject } from '../types.js';
import { atomicJson, noSymlinkPath, safeDirectory, within } from '../files.js';
import { createProject } from '../importer.js';
import { loadProject } from '../project.js';
import { HarnessRun } from '../harness/runtime.js';
import { createProvider } from '../harness/providers/index.js';
import { objectEnvelope } from '../harness/providers/schema.js';
import { redactSecrets } from '../harness/security.js';
import { providerSettingsSchema } from './provider-settings.js';
import { compatibleSchema, normalizeProviderOutput } from './provider.js';
import { effectiveMotionModel } from './model-policy.js';
import { defaultMotion } from './context.js';
import { renderNativeFrame } from '../native/client.js';
import { executeMotion } from './service.js';
import { readMotion } from './store.js';
import { exportVideo } from './video.js';
import { analyzeStoryboard } from './storyboard-analysis.js';
import { formatDirectorContext } from './directing-knowledge.js';
import {motionCapabilityContext} from './capability-context.js';
import {readDirectCheckpoint} from './direct-checkpoint.js';
import {resumeDirectMotion} from './agent-runtime.js';
import {selectApprovedMotionReferences} from './approved-references.js';
import {pinApprovedMotionImages} from './approved-image-context.js';
import {runtimeCode} from '../runtime-code.js';

export const variantRequestSchema = z.object({
  request: z.string().trim().min(1).max(8000),
  count: z.number().int().min(1).max(8).default(4),
  settings: providerSettingsSchema,
  expectedSourceFingerprint: z.string().min(1),
  render: z.boolean().default(true),
}).strict();
type VariantRequest = z.infer<typeof variantRequestSchema>;
const directionSchema = z.object({
  title: z.string().min(1).max(100),
  concept: z.string().min(1).max(1800),
  durationSeconds: z.number().min(2).max(180),
  sceneBeats: z.array(z.object({ sceneId: z.string(), direction: z.string().min(1).max(1600) }).strict()).min(1).max(64),
}).strict();
const planSchema = z.object({
  story: z.string().min(1).max(1800),
  continuity: z.string().min(1).max(1800),
  variants: z.array(directionSchema).min(1).max(8),
}).strict();
export type MotionVariantPlan = z.infer<typeof planSchema>;
const statusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
const itemSchema = z.object({
  id: z.string().uuid(), index: z.number().int(), projectId: z.string().uuid().nullable(),
  directory: z.string().regex(/^motion-variant-[a-f0-9-]{36}$/),
  title: z.string(), concept: z.string(), status: statusSchema, stage: z.string(),
  runId: z.string().nullable(), revision: z.string().nullable(), error: z.string().nullable(),
  renderStatus: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'skipped']),
  video: z.string().nullable(), renderError: z.string().nullable(),
  renderTargetRevision:z.string().nullable().default(null),
  renderCodeDigest:z.string().nullable().default(null),
  renderHistory:z.array(z.object({at:z.string(),video:z.string(),revision:z.string().nullable(),runtimeCodeDigest:z.string().nullable().default(null)}).strict()).default([]),
  progress: z.number().nullable(), total: z.number().nullable(),
  attempts: z.array(z.object({at:z.string(),status:statusSchema,runId:z.string().nullable(),error:z.string().nullable(),renderError:z.string().nullable()}).strict()).default([]),
}).strict();
const batchSchema = z.object({
  version: z.literal('motion-variants/1'), id: z.string().uuid(), projectId: z.string().uuid(),
  sourceFingerprint: z.string(), createdAt: z.string(), updatedAt: z.string(),
  status: statusSchema, stage: z.string(), error: z.string().nullable(),
  request: variantRequestSchema, planningRunId: z.string().uuid().nullable(),
  planningAttempts:z.array(z.object({at:z.string(),runId:z.string().uuid(),error:z.string().nullable()}).strict()).default([]),
  plan: planSchema.nullable(), variants: z.array(itemSchema).max(8),
}).strict();
export type MotionVariantBatch = z.infer<typeof batchSchema>;
type VariantItem = z.infer<typeof itemSchema>;
type PlanContext = { project: LoadedProject; input: VariantRequest; signal: AbortSignal; runId: string };
export type MotionVariantDependencies = {
  plan: (context: PlanContext) => Promise<MotionVariantPlan>;
  execute: (project: LoadedProject, request: Record<string, unknown>, stage: (value: string) => void, signal: AbortSignal, runId: string) => Promise<unknown>;
  resume: (project: LoadedProject, runId: string, stage: (value: string) => void, signal: AbortSignal) => Promise<unknown>;
  render: (project: LoadedProject, progress: (value: number, total: number) => void, signal: AbortSignal) => Promise<{file: string;revision?:string}>;
};
const running = new Map<string, { projectId: string; controller: AbortController; done: Promise<MotionVariantBatch> }>();
const activeParents = new Set<string>();
let occupiedSlots = 0;
const slotQueue: Array<() => void> = [];
/** Shared by all variant batches: at most two provider/native-QA pipelines at once. */
async function acquireSlot(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const enter = () => { signal.removeEventListener('abort', abort); occupiedSlots++; resolve(); };
    const abort = () => { const i = slotQueue.indexOf(enter); if (i >= 0) slotQueue.splice(i, 1); reject(signal.reason); };
    if (occupiedSlots < 2) enter();
    else { slotQueue.push(enter); signal.addEventListener('abort', abort, {once:true}); }
  });
  return () => { occupiedSlots--; slotQueue.shift()?.(); };
}
const terminal = (status: string) => !['queued', 'running'].includes(status);
const safeError = (error: unknown) => redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 3000);
const batchFile = (project: LoadedProject, id: string) => within(project.root, `motion/variants/${z.string().uuid().parse(id)}.json`);

export async function readMotionVariantBatch(project: LoadedProject, id: string) {
  const file = batchFile(project, id);
  await noSymlinkPath(project.root, file);
  const batch = batchSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  if (batch.projectId !== project.config.projectId || batch.id !== id) throw Error('VARIANT_BATCH_IDENTITY_MISMATCH');
  return batch;
}
export async function listMotionVariantBatches(project: LoadedProject) {
  const dir = within(project.root, 'motion/variants');
  let names: string[];
  try { await noSymlinkPath(project.root, dir); names = await readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const batches = await Promise.all(names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).map(n => readMotionVariantBatch(project, n.slice(0, -5))));
  return batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
async function writeBatch(project: LoadedProject, batch: MotionVariantBatch) {
  await safeDirectory(project.root, 'motion/variants');
  batch.updatedAt = new Date().toISOString();
  await atomicJson(batchFile(project, batch.id), batchSchema.parse(batch));
}
/** Restart never silently resubmits a paid provider job. Published child projects remain usable. */
export async function recoverMotionVariantBatches(project: LoadedProject) {
  for (const batch of await listMotionVariantBatches(project)) {
    if (terminal(batch.status) || running.has(batch.id)) continue;
    batch.status = 'interrupted'; batch.stage = 'interrupted'; batch.error = 'Сервер перезапущен. Сохранённые варианты доступны; незавершённые можно продолжить в их проектах.';
    for (const variant of batch.variants) {
      if (!terminal(variant.status)) { variant.status = 'interrupted'; variant.stage = 'interrupted'; }
      if (variant.renderStatus === 'running') { variant.renderStatus = 'failed'; variant.renderError = 'Рендер прерван перезапуском сервера.'; }
    }
    await writeBatch(project, batch);
  }
}
export async function cancelMotionVariantBatch(project: LoadedProject, id: string) {
  const batch = await readMotionVariantBatch(project, id), job = running.get(id);
  if (job?.projectId === project.config.projectId) job.controller.abort();
  else if (!terminal(batch.status)) await recoverMotionVariantBatches(project);
  return { cancelled: !!job, batchId: id };
}

/** Images are immutable source previews, or native renders of the SOURCE-ONLY copy. */
async function storyboardImages(project: LoadedProject, run: HarnessRun) {
  const images: string[] = [], state = defaultMotion(project);
  for (const [index, scene] of project.inspection.document.scenes.entries()) {
    run.checkpoint();
    if (scene.preview) {
      const file = within(project.sourceRoot, scene.preview);
      await noSymlinkPath(project.sourceRoot, file); await readFile(file);
      images.push(file);
    } else {
      run.beforeRender();
      const rendered = await renderNativeFrame(project, state, state.blocks[index].startFrame, { scale: Math.min(1, 1280 / state.settings.width), encoding: 'png', signal: run.signal });
      const file = path.join(run.directory, `storyboard-${index + 1}.png`);
      await writeFile(file, rendered.png); images.push(file);
    }
  }
  return images;
}
async function planVariants({ project, input, signal, runId }: PlanContext): Promise<MotionVariantPlan> {
  const selected = effectiveMotionModel(input.settings);
  // One multimodal plan covers all directions. Leave its own deadline available
  // after the harness recovery/execution reserves; ordinary executor defaults stay unchanged.
  const run = await HarnessRun.start(project, runId, input.request, input.settings.provider, selected.model, signal,
    {maxDurationMs:680000,semanticPlanningTimeoutMs:600000,providerTimeoutMs:600000});
  try {
    const images = await storyboardImages(project, run), analysis = analyzeStoryboard(project.inspection.document);
    const approvedMotionReferences=await selectApprovedMotionReferences({project,request:input.request});
    const approvedImages=await pinApprovedMotionImages(approvedMotionReferences.imageEvidence??[],run.directory);
    await atomicJson(path.join(run.directory,'storyboard-analysis.json'),analysis);
    await atomicJson(path.join(run.directory,'approved-motion-context.json'),approvedMotionReferences);
    await atomicJson(path.join(run.directory,'approved-motion-images.json'),{evidence:approvedImages.evidence,diagnostics:approvedImages.diagnostics});
    await run.record('approved-motion-reference-context',approvedMotionReferences);
    const adapter = createProvider(input.settings.provider, run.directory), schema = z.toJSONSchema(planSchema, { io: 'output' });
    const strict = adapter.capabilities().schemaDialect !== 'json-schema';
    const wire = strict ? objectEnvelope(compatibleSchema(schema)) : { schema, wrapped: false };
    const response = await run.invoke(adapter, {
      purpose: 'semantic-planning', images:[...images,...approvedImages.images], model: selected.model || undefined, reasoningEffort: selected.reasoningEffort,
      signal: run.signal, timeoutMs: run.config.providerTimeoutMs, maxOutputTokens: run.config.maxOutputTokens, responseSchema: wire.schema,
      messages: [{ role: 'system', content: `You direct complete motion graphics films from editable source storyboards. Inspect ALL attached source frames in the listed order before proposing directions. They are reference states of one story, not automatically independent slides. Keep the message, source artwork, scene order and shared-object identity intact. Infer continuity and text replacement from the actual images plus source geometry; labeled hypotheses need visual confirmation. Produce exactly ${input.count} thoughtful, DISTINCT complete directions. Vary rhythm, emphasis, choreography and restrained vs energetic motion, not just easing names. Do not replay earlier hand-tuned animation. Provide every sceneId exactly once in source order in each sceneBeats array. Choose enough duration for legibility and settling, obey explicit duration in the request. Output complete concise Russian sentences, never cut a word or thought to meet a field limit. Follow the runtime capability facts: a visual intention must have a supported implementation for the actual source type. Keep the entire plan compact enough for an executor brief. Do not write keyframes or tools here; the ordinary AKELLA executor implements each direction independently. No arbitrary quality scores or artistic refusal gates. ${JSON.stringify(formatDirectorContext(analysis))}` },
        { role: 'user', content: JSON.stringify({ request: input.request, count: input.count, approvedMotionReferences, nativeTextPose:project.nativeTextPose, approvedMotionImageOrder:approvedImages.evidence.map((e,i)=>({image:images.length+i+1,kind:'approved temporal contact sheet; motion reference only, preserve current source artwork',...e})), runtimeCapabilities:motionCapabilityContext(project), sourceFrames: project.inspection.document.scenes.map((s, i) => ({ image: i + 1, sceneId: s.sceneId, name: s.name, width: s.width, height: s.height })) }) }],
    });
    const payload = wire.wrapped ? (response.output as {response?: unknown})?.response : response.output;
    const plan = planSchema.parse(strict ? normalizeProviderOutput(payload, schema) : payload);
    validatePlan(plan, project, input.count);
    await atomicJson(path.join(run.directory, 'variant-plan.json'), plan);
    await run.finish('SUCCESS'); return plan;
  } catch (error) { await run.captureFailure(error); await run.finish(signal.aborted ? 'CANCELLED' : 'FAILED'); throw error; }
}
function validatePlan(plan: MotionVariantPlan, project: LoadedProject, count: number) {
  if (plan.variants.length !== count) throw Error('VARIANT_COUNT_MISMATCH');
  const order = project.inspection.document.scenes.map(s => s.sceneId);
  for (const direction of plan.variants)
    if (JSON.stringify(direction.sceneBeats.map(s => s.sceneId)) !== JSON.stringify(order)) throw Error('VARIANT_STORYBOARD_ORDER_MISMATCH');
}
function executionRequest(input: VariantRequest, plan: MotionVariantPlan, index: number) {
  const direction = plan.variants[index];
  return `Создай законченный ролик по этой исходной раскадровке. Исходное ТЗ пользователя:\n${input.request}\n\nОбщая история (сверена с изображениями исходных кадров):\n${plan.story}\nНепрерывность между состояниями:\n${plan.continuity}\n\nРежиссёрское решение этого варианта: ${direction.title}\n${direction.concept}\nДлительность: ${direction.durationSeconds} секунд, если это не противоречит явному ТЗ.\nПоследовательность исходных состояний:\n${direction.sceneBeats.map(s => `${s.sceneId}: ${s.direction}`).join('\n')}\n\nСохрани смысл, исходные элементы и порядок раскадровки. Общие объекты продолжают движение или остаются в кадре, а не повторяют появление в каждом состоянии. Выбирай ближайший или уже обрезающий объект край; сохраняй основную динамику. Для смены текста избегай пересечения читаемых надписей, стремись к разрыву не более одного кадра после ухода предыдущей. При инерции прочитай inertia-continuity и используй непрерывный подход/хвост вместо нового толчка после торможения. Проверь реальные кадры входов, смены текста и стыков инерции; исправь замеченные проблемы. Это самостоятельная авторская реализация одного решения, не набор слайдов. Не используй startProduction; выполни обычным прямым агентом. Commit после всей композиции.`;
}
const defaults: MotionVariantDependencies = {
  plan: planVariants,
  execute: (project, request, stage, signal, runId) => executeMotion(project, request, stage, { signal, runId, executionRuntime: 'agent', validationMode: 'minimal' }),
  resume: (project,runId,stage,signal) => resumeDirectMotion(project,runId,stage,{signal}),
  render: (project, progress, signal) => exportVideo(project.root, progress, { signal, renderer: 'native', draftQuality: 'half' }),
};

/** Starts one bounded batch. Every executor sees a fresh project, never another variant's motion. */
export async function startMotionVariants(project: LoadedProject, raw: unknown, dependencies: Partial<MotionVariantDependencies> = {}) {
  return launchVariants(project,variantRequestSchema.parse(raw),dependencies);
}
export const resumeVariantSchema=z.object({batchId:z.string().uuid(),expectedSourceFingerprint:z.string().min(1),variantIds:z.array(z.string().uuid()).min(1).max(8).optional()}).strict();
export async function resumeMotionVariants(project:LoadedProject,raw:unknown,dependencies:Partial<MotionVariantDependencies>={}){
  const input=resumeVariantSchema.parse(raw),batch=await readMotionVariantBatch(project,input.batchId);
  if(input.expectedSourceFingerprint!==project.inspection.fingerprint||batch.sourceFingerprint!==project.inspection.fingerprint)throw Error('STALE_SOURCE_FINGERPRINT');
  if(!terminal(batch.status))throw Error('Варианты уже создаются.');
  if(!batch.plan&&(input.variantIds||batch.variants.some(v=>v.runId||v.revision||v.video)))throw Error('Новый общий план можно получить только до начала анимации всех вариантов.');
  const eligible=batch.variants.filter(v=>v.status!=='completed'||batch.request.render&&['failed','cancelled'].includes(v.renderStatus));
  const selected=input.variantIds?eligible.filter(v=>input.variantIds!.includes(v.id)):eligible;
  if(!selected.length||input.variantIds&&(new Set(input.variantIds).size!==selected.length))throw Error('Можно продолжить только незавершённые варианты или их незавершённый рендер.');
  const selectedIds=new Set(selected.map(v=>v.id)),renderOnly=new Set(selected.filter(v=>v.status==='completed'&&v.revision).map(v=>v.id));
  return launchVariants(project,batch.request,dependencies,{batch,selectedIds,renderOnly});
}
export const rerenderVariantSchema=z.object({batchId:z.string().uuid(),variantId:z.string().uuid(),expectedRevision:z.string().min(1),expectedSourceFingerprint:z.string().min(1)}).strict();
/** Publish a new native video for an existing, possibly chat-edited child. No provider calls. */
export async function rerenderMotionVariant(project:LoadedProject,raw:unknown,dependencies:Partial<MotionVariantDependencies>={}){
  const input=rerenderVariantSchema.parse(raw),batch=await readMotionVariantBatch(project,input.batchId);
  if(input.expectedSourceFingerprint!==project.inspection.fingerprint||batch.sourceFingerprint!==project.inspection.fingerprint)throw Error('STALE_SOURCE_FINGERPRINT');
  if(!terminal(batch.status)||activeParents.has(project.root))throw Error('Варианты этого проекта уже создаются.');
  const item=batch.variants.find(v=>v.id===input.variantId);
  if(!item||item.status!=='completed'||!item.projectId)throw Error('Рендер доступен для завершённого варианта.');
  activeParents.add(project.root);
  const controller=new AbortController(),signal=controller.signal,render=dependencies.render??defaults.render,renderCodeDigest=runtimeCode.status().loadedCodeDigest;
  const loadChild=async()=>{
    const child=await loadProject(path.join(path.dirname(project.root),item.directory));
    if(child.config.projectId!==item.projectId||child.config.projectId!==item.id||child.inspection.fingerprint!==batch.sourceFingerprint)throw Error('VARIANT_SOURCE_OR_IDENTITY_CHANGED');
    if((await readMotion(child)).revision!==input.expectedRevision)throw Error('STALE_VARIANT_REVISION');
    return child;
  };
  try{await loadChild();}catch(error){activeParents.delete(project.root);throw error;}
  batch.status='running';batch.stage='rendering';batch.error=null;item.stage='rendering';item.renderStatus='pending';item.renderError=null;item.renderTargetRevision=input.expectedRevision;item.progress=null;item.total=null;
  try{await writeBatch(project,batch);}catch(error){activeParents.delete(project.root);throw error;}
  let saves=Promise.resolve();const save=()=>{const snapshot=structuredClone(batch);saves=saves.then(()=>writeBatch(project,snapshot));return saves;};
  const done=(async()=>{
    let release:(()=>void)|undefined;
    try{
      release=await acquireSlot(signal);signal.throwIfAborted();const child=await loadChild();item.renderStatus='running';await save();
      const output=await render(child,(n,total)=>{item.progress=n;item.total=total;void save().catch(()=>{});},signal);
      signal.throwIfAborted();if(output.revision&&output.revision!==input.expectedRevision)throw Error('STALE_VARIANT_RENDER');
      await loadChild();
      if(item.video)item.renderHistory.push({at:new Date().toISOString(),video:item.video,revision:item.revision,runtimeCodeDigest:item.renderCodeDigest});
      item.video=output.file;item.revision=input.expectedRevision;item.renderStatus='completed';item.renderCodeDigest=renderCodeDigest;
    }catch(error){item.renderStatus=signal.aborted?'cancelled':'failed';item.renderError=safeError(error);}
    finally{release?.();}
    item.stage='completed';if(item.renderStatus==='completed')item.renderTargetRevision=null;
    batch.status=signal.aborted?'cancelled':batch.variants.some(v=>v.status==='failed'||v.renderStatus==='failed')?'failed':batch.variants.every(v=>v.status==='completed')?'completed':'cancelled';batch.stage=batch.status;
    await save();return batch;
  })().finally(()=>{running.delete(batch.id);activeParents.delete(project.root);});
  running.set(batch.id,{projectId:project.config.projectId,controller,done});void done.catch(()=>{});return {batchId:batch.id,done};
}
async function launchVariants(project:LoadedProject,input:VariantRequest,dependencies:Partial<MotionVariantDependencies>,continuation?:{batch:MotionVariantBatch;selectedIds:Set<string>;renderOnly:Set<string>}){
  if (input.settings.provider === 'manual-response') throw Error('Для вариантов выберите подключённого агента.');
  if (input.expectedSourceFingerprint !== project.inspection.fingerprint) throw Error('STALE_SOURCE_FINGERPRINT');
  if (activeParents.has(project.root)) throw Error('Варианты этого проекта уже создаются.');
  activeParents.add(project.root);
  const id = continuation?.batch.id??randomUUID(), controller = new AbortController(), deps = { ...defaults, ...dependencies };
  const batch: MotionVariantBatch = continuation?.batch??{
    version: 'motion-variants/1', id, projectId: project.config.projectId, sourceFingerprint: project.inspection.fingerprint,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'queued', stage: 'preparing', error: null,
    request: input, planningRunId: null, planningAttempts:[], plan: null,
    variants: Array.from({ length: input.count }, (_, index) => { const id = randomUUID(); return {
      id, index, projectId: null, directory: `motion-variant-${id}`, title: `Вариант ${index + 1}`, concept: '', status: 'queued' as const, stage: 'queued',
      runId: null, revision: null, error: null, renderStatus: input.render ? 'pending' as const : 'skipped' as const, video: null, renderError: null,renderTargetRevision:null,renderCodeDigest:null,renderHistory:[], progress: null, total: null,attempts:[],
    }; }),
  };
  const selected=batch.variants.filter(v=>!continuation||continuation.selectedIds.has(v.id));
  if(continuation){
    if(!batch.plan&&batch.planningRunId)batch.planningAttempts.push({at:new Date().toISOString(),runId:batch.planningRunId,error:batch.error});
    for(const v of selected){v.attempts.push({at:new Date().toISOString(),status:v.status,runId:v.runId,error:v.error,renderError:v.renderError});v.status='queued';v.stage='queued';v.error=null;v.renderError=null;v.progress=null;v.total=null;}
    batch.status='queued';batch.stage='resuming';batch.error=null;
  }
  try { await writeBatch(project, batch); } catch (error) { activeParents.delete(project.root); throw error; }
  const done = runBatch().finally(() => { running.delete(id); activeParents.delete(project.root); });
  running.set(id, { projectId: project.config.projectId, controller, done });
  void done.catch(() => {});
  return { batchId: id, done };

  async function runBatch() {
    const signal = controller.signal, copies = new Map<string,LoadedProject>();
    let saves = Promise.resolve();
    const save = () => { const snapshot = structuredClone(batch); saves = saves.then(() => writeBatch(project, snapshot)); return saves; };
    const progress = (item: VariantItem, stage: string) => { item.stage = stage; void save().catch(() => {}); };
    try {
      batch.status = 'running'; await save();
      for (const item of selected) {
        signal.throwIfAborted(); item.stage = 'copying'; await save();
        const destination=path.join(path.dirname(project.root),item.directory);
        let copy:LoadedProject;
        try{copy=await loadProject(destination);}
        catch(error){
          if((error as NodeJS.ErrnoException).code!=='ENOENT'||item.projectId)throw error;
          const imported=await createProject({source:project.sourceRoot,name:`${project.config.name} · Вариант ${item.index+1}`,projectsRoot:path.dirname(project.root),projectPath:destination,initialProjectId:item.id,...(project.config.figmaSource?{figmaSource:project.config.figmaSource}:{})});
          copy=await loadProject(imported.projectPath);
        }
        if(copy.config.projectId!==item.id||copy.inspection.fingerprint!==batch.sourceFingerprint)throw Error('VARIANT_SOURCE_OR_IDENTITY_CHANGED');
        if(!batch.plan&&(await readMotion(copy)).revision!=='initial')throw Error('VARIANT_WAS_EDITED: existing motion is preserved; open the child project to continue.');
        copies.set(item.id,copy);item.projectId=copy.config.projectId;item.stage='queued';await save();
      }
      signal.throwIfAborted();
      let plan=batch.plan;
      if(!plan){
        batch.stage='directing';batch.planningRunId=randomUUID();await save();
        const releasePlan=await acquireSlot(signal);
        try{plan=planSchema.parse(await deps.plan({project:copies.get(selected[0].id)!,input,signal,runId:batch.planningRunId}));}
        finally{releasePlan();}
        validatePlan(plan,project,input.count);batch.plan=plan;
        plan.variants.forEach((direction,i)=>Object.assign(batch.variants[i],{title:direction.title,concept:direction.concept}));
      }
      validatePlan(plan,project,input.count);
      batch.stage='animating';await save();let cursor=0;
      const worker=async()=>{
        while(cursor<selected.length&&!signal.aborted){
          const item=selected[cursor++],copy=copies.get(item.id)!;
          let release:(()=>void)|undefined;
          try{
            release=await acquireSlot(signal);signal.throwIfAborted();
            item.status='running';item.stage='understanding';await save();
            const docBefore=await readMotion(copy);
            if(continuation?.renderOnly.has(item.id)){
              if(docBefore.revision!==(item.renderTargetRevision??item.revision))throw Error('VARIANT_CHANGED_BEFORE_RENDER_RESUME');
            }else{
              let checkpoint=false;
              if(item.runId){try{await readDirectCheckpoint(copy,item.runId);checkpoint=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
              let result:{status?:string;summary?:string};
              if(checkpoint){item.stage='direct-resuming';await save();result=await deps.resume(copy,item.runId!,stage=>progress(item,stage),signal) as typeof result;}
              else{
                if(docBefore.revision!=='initial')throw Error('VARIANT_WAS_EDITED: existing motion is preserved; open the child project to continue.');
                item.runId=randomUUID();await save();
                const request=executionRequest(input,plan!,item.index);
                if(request.length>20000)throw Error('VARIANT_DIRECTION_CONTEXT_TOO_LONG');
                result=await deps.execute(copy,{request,mode:'create',mentions:[],expectedRevision:'initial',settings:input.settings,editId:item.runId},stage=>progress(item,stage),signal,item.runId) as typeof result;
              }
              if(result.status!=='applied')throw Error(result.summary??`Вариант не завершён: ${result.status??'unknown'}`);
              item.revision=(await readMotion(copy)).revision;
            }
            item.status='completed';item.stage=input.render?'rendering':'completed';await save();
            if(input.render){
              item.renderStatus='running';await save();
              try{const video=await deps.render(copy,(n,total)=>{item.progress=n;item.total=total;progress(item,'rendering');},signal);if(video.revision&&video.revision!==(item.renderTargetRevision??item.revision))throw Error('STALE_VARIANT_RENDER');if(item.video)item.renderHistory.push({at:new Date().toISOString(),video:item.video,revision:item.revision,runtimeCodeDigest:item.renderCodeDigest});item.video=video.file;item.revision=item.renderTargetRevision??item.revision;item.renderTargetRevision=null;item.renderStatus='completed';item.renderCodeDigest=runtimeCode.status().loadedCodeDigest;}
              catch(error){item.renderStatus=signal.aborted?'cancelled':'failed';item.renderError=safeError(error);}
              item.stage='completed';await save();
            }
          }catch(error){item.status=signal.aborted?'cancelled':'failed';item.stage=item.status;item.error=safeError(error);await save();}
          finally{release?.();}
        }
      };
      await Promise.all(Array.from({length:Math.min(2,selected.length)},worker));
      for(const item of selected)if(item.status==='queued'){item.status='cancelled';item.stage='cancelled';}
      batch.status=signal.aborted?'cancelled':batch.variants.some(v=>v.status==='failed')?'failed':batch.variants.every(v=>v.status==='completed')?'completed':'cancelled';
      batch.stage=batch.status;await save();return batch;
    }catch(error){
      batch.status=signal.aborted?'cancelled':'failed';batch.stage=batch.status;batch.error=safeError(error);
      for(const item of selected)if(!terminal(item.status)){item.status=signal.aborted?'cancelled':'failed';item.stage=item.status;item.error=batch.error;}
      await save();return batch;
    }
  }
}
