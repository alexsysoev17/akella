import {readDirectCheckpoint,writeDirectCheckpoint,directDirectory,type DirectCheckpoint} from './direct-checkpoint.js';
import {compileTransitionGroup,transitionGroupSchema} from './transition-groups.js';
import {segmentedTextCapabilities} from './text-segment.js';
import type {TaskProgress} from './production-contract.js';
import { agentPolicy, type AgentValidationMode } from './agent-policy.js';
import {runtimeCode} from '../runtime-code.js';
import { objectMentionRanges } from './object-aliases.js';
import { animationSchema } from './schema.js';
import { expressionSchema, expressionRegistry } from '../motion-library/expressions/registry.js';
import { objectsIn } from './context.js';
import { redact } from '../harness/security.js';
import { semanticEditRoute } from './incremental-edit.js';
import { compileSemanticEdit } from './rules.js';
import { applyOperations } from './operations.js';
import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LoadedProject } from '../types.js';
import type { HarnessConfig } from '../harness/config.js';
import { HarnessRun } from '../harness/runtime.js';
import { createProvider } from '../harness/providers/index.js';
import { compatibleSchema, normalizeProviderOutput } from './provider.js';
import { objectEnvelope, validateProviderSchema } from '../harness/providers/schema.js';
import { WorkingRevision, requirementCheckSchema } from './working-revision.js';
import { motionToolSchema,keyframeToolAnimationSchema, inspectAnimations, findObject } from './tools.js';
import { operationSchema } from './schema.js';
import { readMotion, changeMotion } from './store.js';
import { digest } from '../harness/context.js';
import { codeVersions } from '../harness/versions.js';
import { renderNativeFrame } from '../native/client.js';
import { evaluateMotion } from './evaluation.js';
import { statePresentation } from './transitions.js';
import { atomicJson as persistJson, safeDirectory, lockProject } from '../files.js';
import { projectTime } from './project-time.js';
import { recentSuccessfulActions } from './contextual-resolution.js';
import { motionKnowledge } from '../motion-library/knowledge.js';
import type { ProviderSettings } from './provider.js';
const atomicJson = (file: string, value: unknown) => persistJson(file, redact(value));
const callSchema = z.object({ callId: z.string().min(1).max(100), tool: z.enum(['listScenes', 'listObjects', 'findObject', 'inspectObject', 'inspectAnimations', 'inspectExpressions', 'inspectMotionRules', 'inspectDependencies', 'inspectTimeline', 'inspectSceneState', 'compareFrames', 'inspectAvailableCapabilities', 'inspectKnowledge', 'describeTool', 'defineChecks', 'edit', 'applyEdit', 'inspectDiff', 'revertEdit', 'rollbackRevision', 'evaluateObjectAtTime', 'sampleAnimation', 'renderFrame', 'renderFrameSequence', 'runFocusedQA', 'commitRevision','editTransitionGroup','startProduction','reportTaskConflict']), argumentsJson: z.string().max(150000) }).strict();
export const agentTurnSchema = z.object({ calls: z.array(callSchema).max(32), disposition: z.enum(['CONTINUE', 'COMMIT', 'NEEDS_USER_INPUT', 'TECHNICAL_BLOCKED']), message: z.string().max(4000), assumptions: z.array(z.string().max(1000)).max(20) }).strict();
const instructions = `Execute ALL ordinary requests, including long multi-scene briefs, directly using motion tools. No Director, global plan or worker handoff is needed. The complete original request is always authoritative. Continue from the current candidate and confirmed checkpoint operations; do not recreate already-applied animations. Workers with a productionTask execute ONLY its objective, objects and timing; sourceText is provenance, not permission to implement other delegated clauses. Inspect prerequisiteResults for inherited motion and existing effects. Never repeat already checkpointed task operations. Workers with a productionTask never call startProduction. If a task check contradicts its objective, reportTaskConflict({reason,checkIds}) instead of distorting correct motion or repeatedly failing commit; the coordinator can repair only that verification contract. Group simultaneous state transitions using editTransitionGroup, sharing interval/switch but independent easing/paths. You are AKELLA's motion executor. Inspect → act → observe → evaluate → correct within ONE ephemeral working revision. Use tools, never return a global semantic plan. Tool calls are sequential and results reflect current state. argumentsJson is JSON text validated against each tool's real schema. Correct field errors locally after tool feedback, never regenerate the whole project. listObjects returns canonical logical IDs/source instances. inspectAnimations returns full current entries. describeTool returns selected edit/operation/check schemas. For createAnimation/addAnimation/addEffect/setExpression always specify variant to avoid loading unrelated effect schemas. inspectAvailableCapabilities returns compact descriptors; inspectKnowledge loads only selected entries. In strict mode only, defineChecks MUST precede edits: declare canonical targets (and allowTimeline only if authorized), register each user's measurable requirement with its exact sourceText and independent check (startDelta, entryField, absent, motionVaries, basePreserved). Minimal mode automatically includes the engine-derived dependency closure and reports every scope expansion. Explain additional affected objects; do not silently change unrelated objects. Strict mode requires explicit scope and dependency policy. Explicit +5 frames means actual baseline delta 5 for EVERY target; 0 is not success. Checks cannot be redefined after edits. If context.workingRevision.definedChecks is already nonempty, preserve those checks and repair the existing candidate; do not redefine them. A skipped local optimization is feedback, not an admission veto. x/y channels are offsets from immutable source geometry, never absolute source x/y. Preserve the initial pose for an in-place relative move using baselineDelta checks; entrances may intentionally start displaced. Do not omit user clauses. Arbitrary artistic intent may be implemented with keyframes or safe procedural programs, without registering a technique. createAnimation/updateAnimation/addEffect/updateEffect/removeEffect and transitions use edit with an existing typed motionTool. applyEdit uses {operations:[canonical operations]}; describeTool with operationType obtains the exact schema. Use canonical rule removal for rule-owned effects, not edits that will rematerialize. Preserve unrelated tracks and source geometry. Continuous POSITION wiggle must use X/Y; never rotation when rotation removal was requested. Inertia means existing inertialOvershoot bound to the real movement endpoint/velocity, not wiggle. The library is optional knowledge, not a whitelist. Procedural expression type=procedural uses version1 bounded postfix math; sample operations read only declared base track IDs. No JS, eval, files/network or changing application source. Minimal mode: edit/applyEdit and commitRevision directly; defineChecks and runFocusedQA are optional observations, never artistic admission gates. Strict mode: inspectDiff and runFocusedQA before commitRevision, passing checks required; tools cannot mark PASS by assertion. If optional QA fails in minimal mode, consider the diagnostic without treating it as a commit veto. Strict mode requires correcting failed checks. No source Code Repair in this loop. When references/schemas are known, BATCH defineChecks, edit(s), runFocusedQA and commitRevision in the SAME response, instead of making one model call per tool. Do not finish a turn after editing without requesting commit; QA is optional in minimal mode; tool execution itself blocks an invalid commit and returns corrective feedback. Existing objectIndex entries already contain current animations, so do not re-read identical data. For createAnimation keyframes, omit durationFrames when the last keyframe already defines it; the tool derives duration deterministically. animation.targetId and expression.targetId persist SOURCE NODE IDs; tools can deterministically resolve a known logical ID, never guess an unknown ID. Tool references can be obtained earlier in the same task. A generic unsupported tool/field is recoverable, not fatal. Report true identity ambiguity as NEEDS_USER_INPUT; reasonable artistic defaults may be explicit assumptions. disposition COMMIT is not a commit by itself. Do not claim artistic perfection; raster evidence proves rendering, not intent completeness.`;
const stableObservation=(v:unknown):unknown=>Array.isArray(v)?v.map(stableObservation):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k])=>!['timings','latencyMs','durationMs','callId'].includes(k)).map(([k,x])=>[k,stableObservation(x)])):v;
// Provider context is a projection, never the durable replay source.
function entryBrief(e:any){return Object.fromEntries(['animationId','expressionId','transitionId','logicalObjectId','sceneId','targetId','startFrame','durationFrames','effect','type','property','easing','enabled','fromSceneId','toSceneId'].filter(k=>e[k]!==undefined).map(k=>[k,e[k]]));}
function workingContext(w:WorkingRevision){
    const changed=[...w.state.animations.filter(e=>digest(e)!==digest(w.original.animations.find(a=>a.animationId===e.animationId)??null)),...(w.state.expressions??[]).filter(e=>digest(e)!==digest(w.original.expressions?.find(a=>a.expressionId===e.expressionId)??null)),...(w.state.objectTransitions??[]).filter(e=>digest(e)!==digest(w.original.objectTransitions?.find(a=>a.transitionId===e.transitionId)??null))];
    return {baseRevision:w.revision,candidateDigest:digest(w.state),batches:w.batches.length,validationMode:w.validationMode,checks:w.checks,changedEntryCount:changed.length,changedEntries:changed.slice(-80).map(entryBrief),hasMore:changed.length>80,counts:{animations:w.state.animations.length,expressions:w.state.expressions?.length??0,transitions:w.state.objectTransitions?.length??0},scopeExpansionCount:w.scopeExpansions.length,readDetails:'inspectAnimations/inspectExpressions/inspectDependencies/inspectTimeline inspect the actual candidate; no operation is applied twice'};
}
function providerFeedback(value:any,currentDigest:string):unknown{
    return {...value,assistant:value.assistant?{message:value.assistant.message,disposition:value.assistant.disposition,calls:value.assistant.calls?.map((c:any)=>({callId:c.callId,tool:c.tool}))}:undefined,results:value.results?.map((entry:any)=>{
        const result=entry.result,tool=entry.call?.tool,stale=tool?.startsWith('inspect')&&entry.observedDigest&&entry.observedDigest!==currentDigest;
        const brief=(r:any):any=>r&&typeof r==='object'&&Array.isArray(r.diff)?{...r,diff:r.diff.slice(0,80).map((d:any)=>({path:d.path})),diffDetails:'Reload current candidate via inspect tools'}:r;
        return {...entry,call:entry.error?entry.call:{callId:entry.call?.callId,tool,argumentsDigest:digest(entry.call?.argumentsJson)},result:stale?{status:'STALE_OBSERVATION',reloadWith:tool}:result?.editResult?{...result,editResult:brief(result.editResult)}:brief(result)};
    })};
}
const empty = z.object({}).strict();
const inspectArgs = z.object({ logicalObjectId: z.string().optional(), sceneId: z.string().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
export class MotionAgentSession {
    ready = false;
    qa: unknown;
    productionRequested?: string;
    taskConflict?: unknown;
    private schemaCache=new Map<string,unknown>();
    schemaReferences(){return [...this.schemaCache.keys()];}
    schemaState(){return [...this.schemaCache.entries()].slice(-60);}
    restoreSchemas(entries:[string,unknown][]){for(const [key,value]of entries)this.schemaCache.set(key,value);}
    constructor(readonly working: WorkingRevision, readonly run: HarnessRun, readonly completionChecks?:z.infer<typeof requirementCheckSchema>[],readonly allowProduction=false) { }
    async call(input: z.infer<typeof callSchema>) {
        const a = JSON.parse(input.argumentsJson);
        const w = this.working;
        let result: unknown;
        switch (input.tool) {
            case 'reportTaskConflict': {if(!this.completionChecks)throw Error('NO_PRODUCTION_TASK');const q=z.object({reason:z.string().min(1).max(4000),checkIds:z.array(z.string()).min(1).max(30)}).strict().parse(a);if(q.checkIds.some(id=>!this.completionChecks!.some(c=>c.checkId===id)))throw Error('TASK_CHECK_REFERENCE_UNKNOWN');this.taskConflict=q;return {reported:true};}
            case 'startProduction': {const q=z.object({reason:z.string().min(1).max(2000)}).strict().parse(a);if(!this.allowProduction||this.completionChecks||w.batches.length)throw Error('PRODUCTION_HANDOFF_MUST_PRECEDE_EDITS');this.productionRequested=q.reason;return {handoff:'MOTION_PRODUCTION',reason:q.reason};}
            case 'editTransitionGroup': {const compiled=compileTransitionGroup(w.project,w.state,a);result={editResult:w.apply(compiled.operations,input.callId),coordination:compiled.coordination};this.ready=false;break;}
            case 'listScenes':
                empty.parse(a);
                result = w.project.inspection.document.scenes.map(s => ({ sceneId: s.sceneId, name: s.name }));
                break;
            case 'listObjects': {
                const q = inspectArgs.parse(a), all = w.objects().filter(o => !q.sceneId || o.sourceInstances.some(i => i.sceneId === q.sceneId));
                result = { total: all.length, offset: q.offset ?? 0, objects: all.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 50)) };
                break;
            }
            case 'findObject': {
                const q = z.object({ name: z.string(), sceneId: z.string().optional() }).strict().parse(a);
                result = findObject(w.project, w.state, { referenceText: q.name, ...q, allowLogicalFallback: true });
                break;
            }
            case 'inspectObject':
            case 'inspectAnimations':
            case 'inspectExpressions':
            case 'inspectMotionRules':
            case 'inspectDependencies': {
                const q = inspectArgs.parse(a);
                if (q.logicalObjectId) {
                    const resolved = w.objects().filter(o => o.logicalObjectId === q.logicalObjectId || o.sourceInstances.some(i => i.sourceNodeId === q.logicalObjectId));
                    if (resolved.length !== 1)
                        throw Error('LOGICAL_OBJECT_NOT_FOUND: use listObjects or findObject');
                    q.logicalObjectId = resolved[0].logicalObjectId;
                }
                const objects = w.objects().filter(o => !q.logicalObjectId || o.logicalObjectId === q.logicalObjectId);w.observeTargets(objects.map(o=>o.logicalObjectId));const entries = inspectAnimations(w.project, w.state, q);
                result = input.tool === 'inspectDependencies' ? { timing: w.state.timingDependencies?.filter(d => entries.some(e => e.id === d.animationId || e.id === d.anchorAnimationId)) } : input.tool === 'inspectMotionRules' ? w.state.motionRules?.filter(r => !r.scope.logicalObjectIds.length || objects.some(o => r.scope.logicalObjectIds.includes(o.logicalObjectId))) : { objects: input.tool === 'inspectObject' ? objects.slice(q.offset??0,(q.offset??0)+(q.limit??50)) : undefined, sourceObjects:input.tool==='inspectObject'?w.project.inspection.document.scenes.flatMap(objectsIn).filter(n=>objects.some(o=>o.sourceInstances.some(i=>i.sceneId===n.sceneId&&i.sourceNodeId===n.targetId))).slice(q.offset??0,(q.offset??0)+(q.limit??50)):undefined,entryCount:entries.length,hasMore:entries.length>(q.offset??0)+(q.limit??50),sourceStates: input.tool === 'inspectObject' ? Object.fromEntries(objects.map(o => [o.logicalObjectId, statePresentation(w.project, w.state)[o.logicalObjectId]])) : undefined, entries: (input.tool === 'inspectExpressions' ? entries.filter(e => e.storage === 'expression') : entries).slice(q.offset??0,(q.offset??0)+(q.limit??50)) };
                break;
            }
            case 'inspectTimeline':
                empty.parse(a);
                result = { settings: w.state.settings, blocks: w.state.blocks };
                break;
            case 'inspectSceneState': {
                const q = z.object({ sceneId: z.string(), offset: z.number().int().nonnegative().optional() }).strict().parse(a);
                const scene = w.project.inspection.document.scenes.find(s => s.sceneId === q.sceneId);
                if (!scene)
                    throw Error('SCENE_NOT_FOUND');
                const objects = objectsIn(scene);
                result = { sceneId: scene.sceneId, total: objects.length, objects: objects.slice(q.offset ?? 0, (q.offset ?? 0) + 100) };
                break;
            }
            case 'compareFrames': {
                const q = z.object({ frames: z.array(z.number().int().nonnegative()).length(2) }).strict().parse(a);
                const rendered = [];
                for (const frame of q.frames) {
                    if (frame >= w.state.settings.durationFrames)
                        throw Error('FRAME_OUTSIDE_OUTPUT');
                    this.run.beforeRender();
                    rendered.push(await renderNativeFrame(w.project, w.state, frame, { scale: .25, encoding: 'rgba', signal: this.run.signal }));
                }
                let changed = 0, total = 0;
                const pixelsA = rendered[0].png, pixelsB = rendered[1].png;
                for (let i = 0; i < pixelsA.length; i += 4) {
                    let diff = 0;
                    for (let j = 0; j < 4; j++)
                        diff += Math.abs(pixelsA[i + j] - pixelsB[i + j]);
                    if (diff)
                        changed++;
                    total += diff;
                }
                result = { frames: q.frames, changedPixels: changed, meanAbsoluteChannelDifference: total / pixelsA.length, pixelCount: pixelsA.length / 4, artisticAssessment: 'NOT_TESTED' };
                break;
            }
            case 'inspectAvailableCapabilities':
                empty.parse(a);
                result = { animations: animationSchema.options.map(o => o.shape.effect.value), expressions: expressionRegistry.map(({ id, description, lifecycle }) => ({ id, description, lifecycle })), segmentedText:segmentedTextCapabilities,transitionGroups:{tool:'editTransitionGroup',schema:'describeTool kind=edit name=editTransitionGroup',description:'Coordinate same scene-pair interval/switch with per-object easing and paths'},knowledgeAccess: 'inspectKnowledge with kind and explicit IDs; describeTool with name and optional variant' };
                break;
            case 'inspectKnowledge': {
                const q = z.object({ kind: z.enum(['skills', 'expressions', 'capabilities', 'customEasings', 'presets', 'techniques']), ids: z.array(z.string()).min(1).max(3) }).strict().parse(a);
                const knowledge = await motionKnowledge(w.request, false), entries = knowledge[q.kind] as {
                    id: string;
                }[];
                result = entries.filter(e => q.ids.includes(e.id));
                break;
            }
            case 'describeTool': {
                const q = z.object({ kind: z.enum(['edit', 'operation', 'check']), name: z.string().optional(), variant: z.string().optional(),refresh:z.boolean().optional() }).strict().parse(a);
                const key=JSON.stringify([q.kind,q.name,q.variant]);if(this.schemaCache.has(key)&&!q.refresh){result={schemaReference:key,cached:true,refresh:'Set refresh:true to reload this schema if earlier detail was compacted'};break;}
                let schema: z.ZodType | undefined = q.name==='editTransitionGroup'?transitionGroupSchema:q.kind === 'check' ? requirementCheckSchema : q.kind === 'edit' && q.name ? motionToolSchema.options.find(o => o.shape.tool.value === q.name) : q.kind === 'operation' && q.name ? operationSchema.options.find(o => o.shape.type.value === q.name) : undefined;
                if (q.variant) {
                    const animation = animationSchema.options.find(o => o.shape.effect.value === q.variant), expression = expressionSchema.options.find(o => o.shape.type.value === q.variant);
                    if (q.kind === 'edit' && q.name === 'createAnimation' && animation)
                        schema = z.object({ tool: z.literal('createAnimation'), animation:q.variant==='keyframes'?keyframeToolAnimationSchema:animation }).strict();
                    else if (q.kind === 'edit' && q.name === 'addEffect' && expression)
                        schema = z.object({ tool: z.literal('addEffect'), expression }).strict();
                    else if (q.kind === 'operation' && q.name === 'addAnimation' && animation)
                        schema = z.object({ type: z.literal('addAnimation'), animation }).strict();
                    else if (q.kind === 'operation' && q.name === 'setExpression' && expression)
                        schema = z.object({ type: z.literal('setExpression'), expression }).strict();
                    else if (!schema || !['updateEffect','removeEffect','updateAnimation','removeAnimation'].includes(q.name??''))
                        throw Error('SCHEMA_VARIANT_NOT_FOUND');
                }
                if (!schema)
                    throw Error('DESCRIBE_REQUIRES_EXACT_TOOL_OR_OPERATION_NAME');
                result = z.toJSONSchema(schema, { io: 'output' });this.schemaCache.set(key,result);
                break;
            }
            case 'defineChecks':
                result = w.defineChecks(z.object({ checks: z.array(requirementCheckSchema), targets: z.array(z.string()).min(1), allowTimeline: z.boolean().optional(), dependencyPolicy: z.enum(["reject", "preserve-relative"]).optional() }).strict().parse(a).checks, a.targets, a.allowTimeline, a.dependencyPolicy);
                break;
            case 'edit':
                result = w.apply(a, input.callId, true);
                this.ready = false;
                break;
            case 'applyEdit':
                result = w.apply(z.object({ operations: z.array(operationSchema).min(1).max(500) }).strict().parse(a).operations, input.callId);
                this.ready = false;
                break;
            case 'inspectDiff':
                empty.parse(a);
                result = w.diff();
                break;
            case 'revertEdit':
                empty.parse(a);
                result = w.revert();
                this.ready = false;
                break;
            case 'rollbackRevision':
                empty.parse(a);
                w.rollback();
                this.ready = false;
                result = { rolledBack: true };
                break;
            case 'sampleAnimation':
            case 'evaluateObjectAtTime': {
                const q = z.object({ sceneId: z.string(), targetId: z.string(), frames: z.array(z.number().int()).min(1).max(65) }).strict().parse(a);
                const p = statePresentation(w.project, w.state);
                result = q.frames.map(frame => ({ frame, values: evaluateMotion(w.state, frame, p).nodes[JSON.stringify([q.sceneId, q.targetId])] ?? {} }));
                break;
            }
            case 'renderFrame':
            case 'renderFrameSequence': {
                const q = z.object({ frames: z.array(z.number().int()).min(1).max(8),logicalObjectIds:z.array(z.string()).max(20).optional() }).strict().parse(a);
                result = [];
                for (const frame of q.frames) {
                    if (frame < 0 || frame >= w.state.settings.durationFrames)
                        throw Error('FRAME_OUTSIDE_OUTPUT');
                    this.run.beforeRender();
                    const rendered = await renderNativeFrame(w.project, w.state, frame, { scale: .25, diagnostics:true,signal: this.run.signal });
                    const file = `agent-frame-${frame}-${digest(w.state).slice(0, 12)}.png`;
                    if (this.run.config.privacy === 'full')
                        await writeFile(path.join(this.run.directory, file), rendered.png);
                    (result as unknown[]).push({ frame, artifact: this.run.config.privacy === 'full' ? file : null, pixelHash: createHash('sha256').update(rendered.png).digest('hex'), width: rendered.width, height: rendered.height,observedInstances:rendered.composition?.instances.filter(i=>q.logicalObjectIds?q.logicalObjectIds.includes(i.logicalObjectId??''):i.visible).slice(0,100), artisticAssessment: 'NOT_TESTED' });
                }
                break;
            }
            case 'runFocusedQA': {
                empty.parse(a);
                const started = performance.now();
                result = this.qa = await w.validate(this.run.signal, () => this.run.beforeRender());
                this.run.qaDurationMs += performance.now() - started;
                this.run.renderDurationMs += (result as Awaited<ReturnType<WorkingRevision['validate']>>).timings.renderMs;
                break;
            }
            case 'commitRevision':
                empty.parse(a);
                if(this.completionChecks){const observed=await w.observeChecks(this.completionChecks,this.run.signal,()=>this.run.beforeRender());if(observed.some(c=>c.status!=='PASSED'))throw Object.assign(Error('TASK_RESULT_NOT_OBSERVED'),{issue:{code:'TASK_RESULT_NOT_OBSERVED',checks:observed.filter(c=>c.status!=='PASSED')}});}
                result = { verifiedChecks: w.assertReady(), ready: true };
                this.ready = true;
                break;
        }
        return result;
    }
}
async function executeAgentMotionInner(project: LoadedProject, request: {
    request: string;
    mode: string;
    settings: ProviderSettings;
    expectedRevision: string;
    editId?: string;
    activeSceneId?: string;
    selectedObjectIds?: string[];
    selectedObjectId?: string;
    currentFrame?: number;
}, onStage: (stage: string) => void, options: {
    signal?: AbortSignal;
    validationMode?: AgentValidationMode;
    config?: Partial<HarnessConfig>;
    requestFingerprint?: string;
    allowProduction?: boolean;
    resumeId?:string;
    staging?: {sourceText:string;base:import('./schema.js').MotionState;task:unknown;targetIds:string[];expectedChecks:z.infer<typeof requirementCheckSchema>[];progress?:TaskProgress;onProgress:(progress:TaskProgress,runId:string,metrics:{calls:HarnessRun["calls"];contextBytes:number;qaDurationMs:number;renderDurationMs:number;repairAttempts:number})=>Promise<void>};
} = {}) {
    const id = options.resumeId ?? request.editId ?? randomUUID();
    const saved = !options.staging && options.resumeId ? await readDirectCheckpoint(project,id) : undefined;
    if(saved)request={...saved.request};
    const requestedModel=saved?.model.requestedModel??request.settings.model;
    const effectiveModel=saved?.model.effectiveModel??(request.settings.model || (/^codex-(?:sdk|cli)$/.test(request.settings.provider)?'gpt-6.1-sol':''));
    request={...request,settings:{...request.settings,model:effectiveModel}};
    const model=saved?.model??{requestedModel,effectiveModel,reason:requestedModel?'EXPLICIT_USER_CHOICE':effectiveModel?'EMPTY_CODEX_MODEL_PINNED_TO_DIRECT_DEFAULT':'PROVIDER_CONFIGURED_DEFAULT',availability:'NOT_LIVE_CHECKED'};
    const originalDoc=await readMotion(project);
    if(saved){
        const index=originalDoc.history.findIndex(e=>e.transactionId===id),receipt=originalDoc.lastCommit?.transactionId===id;
        if(index>=0||receipt){
            if(index>=originalDoc.cursor&&index>=0)throw Error('TRANSACTION_ALREADY_UNDONE');
            const committed=originalDoc.history[index]??originalDoc.lastCommit;
            if(committed?.operationsDigest!==createHash('sha256').update(JSON.stringify(saved.snapshot.batches)).digest('hex')||committed.requestFingerprint&&committed.requestFingerprint!==saved.requestFingerprint)throw Error('DIRECT_COMMIT_RECEIPT_MISMATCH');
            saved.status='COMPLETED';saved.publication={transactionId:id,status:'COMMITTED',revision:originalDoc.revision};await writeDirectCheckpoint(project,saved);
            return {id,status:'applied',document:originalDoc,time:projectTime(originalDoc.state,originalDoc.revision),replayed:true,plan:{status:'ready',summary:'Ранее выполненное сохранение подтверждено',operations:saved.snapshot.batches.flat(),assumptions:saved.assumptions,warnings:[]},persistence:{status:'CONFIRMED'},playbackStart:0};
        }
        if(saved.status==='COMPLETED')throw Error('DIRECT_COMMIT_RECEIPT_MISSING');
        if(saved.status==='FAILED')throw Error('DIRECT_CHECKPOINT_NOT_RESUMABLE');
    }
    const doc=options.staging?{...originalDoc,state:options.staging.base}:saved?{...originalDoc,state:saved.snapshot.original,revision:saved.snapshot.revision}:originalDoc;
    const run=await HarnessRun.start(project,saved?randomUUID():id,request.request,request.settings.provider,effectiveModel,options.signal,options.config);
    run.references = await codeVersions();
    run.enableAgentExecution();if(!options.staging)run.directCheckpointId=id;if(options.staging){run.executionRole='worker';run.productionId=(options.staging.task as {productionId?:string}).productionId;}
    const w = new WorkingRevision(project, doc.revision, doc.state, options.staging?options.staging.sourceText+'\n'+request.request:request.request,saved?.validationMode??options.validationMode), session = new MotionAgentSession(w, run,options.staging?.expectedChecks,options.allowProduction??false), turns: unknown[] = [];
    let assumptions: string[] = saved?.assumptions??[], message = saved?.message??'', disposition = 'CONTINUE';let localOptimizationIssue:unknown;
    let nextTurn=saved?.nextTurn??0,observations:unknown[]=saved?.observations??[],checkpoint:DirectCheckpoint|undefined;
    if(saved){try{w.restoreCheckpoint(saved.snapshot);if(saved.codeVersion===digest(run.references))session.restoreSchemas(saved.schemas);if(originalDoc.revision!==w.revision)w.rebase(originalDoc.revision,originalDoc.state);}catch(error){saved.status=/DIGEST_MISMATCH|BASE_MISMATCH/.test(String(error))?'FAILED':'PAUSED_RESUMABLE';saved.reason=String(error);await writeDirectCheckpoint(project,saved);await run.captureFailure(error);await run.finish('FAILED');throw error;}}
    if(!options.staging){checkpoint=saved??{version:'direct-checkpoint/1',codeVersion:digest(run.references),runId:id,projectId:project.config.projectId,sourceFingerprint:project.inspection.fingerprint,requestFingerprint:options.requestFingerprint??digest(request),request,validationMode:w.validationMode,status:'RUNNING',snapshot:w.checkpointState(),checksums:{source:project.inspection.fingerprint,candidate:digest(w.state)},assumptions,message,nextTurn,observations,schemas:[],attemptRunIds:[],updatedAt:new Date().toISOString(),reason:null,publication:{transactionId:id,status:'PENDING',revision:null},model};checkpoint.status='RUNNING';checkpoint.reason=null;checkpoint.attemptRunIds.push(run.runId);}
    const persist = async () => { if(checkpoint){checkpoint.assumptions=assumptions;checkpoint.message=message;checkpoint.nextTurn=nextTurn;checkpoint.observations=observations.slice(-30);checkpoint.schemas=session.schemaState();await writeDirectCheckpoint(project,checkpoint,w.checkpointState());} if(options.staging)await options.staging.onProgress({base:w.original,batches:w.batches,checks:w.checks,readTargets:w.observedTargets(),assumptions,candidateDigest:digest(w.state)},id,{calls:run.calls,contextBytes:run.contextBytes,qaDurationMs:run.qaDurationMs,renderDurationMs:run.renderDurationMs,repairAttempts:run.repairAttempts}); const report = { version: '1', working: w.diff(), turns, validationMode:w.validationMode,technicalCommit:session.ready?'READY':'PENDING',qa: session.qa, checks: w.evaluate(), codeRepairInvocations: 0 }; if (run.config.privacy === 'full')
        await atomicJson(path.join(run.directory, 'agent-runtime.json'), report); await run.diagnostic('agent-runtime', { version: '1', turnCount: turns.length, candidateDigest: digest(w.state), checks: w.evaluate(), codeRepairInvocations: 0 }); };
    try {
        if (!saved && doc.revision !== request.expectedRevision)
            throw Object.assign(Error('STALE_PROJECT_REVISION'), { code: 'STALE_PROJECT_REVISION' });
        await atomicJson(path.join(run.directory, 'request.json'), { id, request, revision: doc.revision });
        await persist();
        await run.record('direct-model-selection',model);
        await run.record('agent-execution-policy',{validationMode:w.validationMode,mandatoryResultChecks:agentPolicy(w.validationMode).mandatoryResultChecks,llmCallLimit:null,totalTaskTokenLimit:null,totalTaskDeadline:null,perCallTimeoutMs:run.config.providerTimeoutMs,contextManagement:'current-state plus bounded observations',noProgressGuard:true});
        if(options.staging?.progress){const p=options.staging.progress;w.checks=p.checks;w.observeTargets(p.readTargets);for(const [i,b]of p.batches.entries())w.apply(b,'restored-'+i);assumptions=p.assumptions;}
        try{const local = saved||options.staging?.progress?undefined:semanticEditRoute(project, request.request, doc, request).edit;
        if (local) {
            const ops = compileSemanticEdit(project, doc.state, local, request.request), candidate = applyOperations(doc.state, ops, project);
            const checks: z.infer<typeof requirementCheckSchema>[] = [];
            const changed = candidate.animations.filter(a => JSON.stringify(a) !== JSON.stringify(doc.state.animations.find(b => b.animationId === a.animationId)));
            for (const a of changed) {
                const old = doc.state.animations.find(b => b.animationId === a.animationId);
                if (old && local.operation === 'SHIFT_START' && local.deltaFrames !== undefined)
                    checks.push({ checkId: 'start-' + a.animationId, sourceText: request.request, assertion: { kind: 'startDelta', animationId: a.animationId, frames: local.deltaFrames } });
                else
                    checks.push({ checkId: 'track-' + a.animationId, sourceText: request.request, assertion: { kind: 'entryField', entity: 'animation', id: a.animationId, path: ['startFrame'], value: a.startFrame } });
            }
            for (const e of candidate.expressions ?? []) {
                if (JSON.stringify(e) !== JSON.stringify(doc.state.expressions?.find(b => b.expressionId === e.expressionId)))
                    for (const [key, value] of Object.entries(e.parameters)) {
                        if (['number', 'string', 'boolean'].includes(typeof value))
                            checks.push({ checkId: e.expressionId + '-' + key, sourceText: request.request, assertion: { kind: 'entryField', entity: 'expression', id: e.expressionId, path: ['parameters', key], value: value as number | string | boolean } });
                    }
            }
            for (const e of doc.state.expressions ?? [])
                if (!candidate.expressions?.some(b => b.expressionId === e.expressionId))
                    checks.push({ checkId: 'removed-' + e.expressionId, sourceText: request.request, assertion: { kind: 'absent', entity: 'expression', id: e.expressionId } });
            if (!checks.length) {
                const e = candidate.expressions?.find(e => ops.some(o => o.type === 'setExpression' && o.expression.expressionId === e.expressionId));
                if (e)
                    checks.push({ checkId: 'ensure-' + e.expressionId, sourceText: request.request, assertion: { kind: 'entryField', entity: 'expression', id: e.expressionId, path: ['enabled'], value: e.enabled } });
            }
            if (checks.length) {
                w.defineChecks(checks, local.targets.length ? local.targets : local.scope.logicalObjectIds ?? [], false, 'preserve-relative');
                w.apply(ops, 'local');
                const qaStarted = performance.now();
                session.qa = agentPolicy(w.validationMode).mandatoryQA ? await w.validate(run.signal, () => run.beforeRender()) : {status:'PASSED',integrity:w.validateIntegrity(),timings:{renderMs:0},renderValidation:'NOT_TESTED'};
                run.qaDurationMs += performance.now() - qaStarted;
                run.renderDurationMs += (session.qa as Awaited<ReturnType<WorkingRevision['validate']>>).timings.renderMs;
                if((session.qa as {status:string}).status==='PASSED'){w.assertReady();session.ready = true;}else localOptimizationIssue={code:'LOCAL_QA_FAILED',qa:session.qa};
                message = 'Анимация обновлена';
                await run.record('agent-local-edit', { route: 'LOCAL_FAST_PATH', operations: ops, checks: w.evaluate(), providerCalls: 0 });
                await persist();
            }
        }
        }catch(error){const code=(error as {code?:string}).code??(error as Error).message?.match(/^[A-Z][A-Z0-9_]+/)?.[0]??'LOCAL_TOOL_VALIDATION';if(run.signal.aborted||/^(?:NATIVE_|RENDER_|PROVIDER_|STALE_|SOURCE_|CANCEL|EXECUTION_)/.test(code))throw error;localOptimizationIssue={code,message:String(error)};await run.record('local-optimization-skipped',localOptimizationIssue);}
        if (!session.ready) {
            const directSchema=agentTurnSchema.extend({calls:z.array(callSchema.extend({tool:z.enum(callSchema.shape.tool.options.filter(tool=>tool!=='startProduction'&&tool!=='reportTaskConflict'||options.allowProduction&&tool==='startProduction'||options.staging&&tool==='reportTaskConflict') as [string,...string[]])})).max(32)});
            const schema = z.toJSONSchema(directSchema, { io: 'output' }), adapter = createProvider(request.settings.provider, run.directory), strict = adapter.capabilities().schemaDialect !== 'json-schema', wire = strict ? objectEnvelope(compatibleSchema(schema)) : { schema, wrapped: false };
            if (!adapter.capabilities().structuredOutput)
                throw Object.assign(Error('Provider must support structured tool envelopes; native OS tools are not enabled'), { code: 'UNSUPPORTED_CAPABILITY' });
            if (strict)
                validateProviderSchema(wire.schema);
            run.providerInitializationStatus = 'READY';
            const named = w.objects().filter(o => options.staging?options.staging.targetIds.includes(o.logicalObjectId):objectMentionRanges(o.name, request.request).length || o.sourceInstances.some(i => i.sourceNodeId === request.selectedObjectId || request.selectedObjectIds?.includes(i.sourceNodeId))).slice(0, 12);
            w.observeTargets(named.map(o=>o.logicalObjectId));w.authorizeContextTargets(named.map(o=>o.logicalObjectId));
        const initial = {productionTask:options.staging?.task,localOptimizationIssue,workingRevision:options.staging?{...w.diff(),definedChecks:w.checks}:{...workingContext(w),definedChecks:w.checks},coordinateContract: { xY: 'Animation x/y and keyframes x/y are OFFSETS from source geometry in parent-local coordinates. Resting translation is 0, not the Figma x/y coordinate. Source position remains immutable. For a relative move +25 start at current motion offset (usually0), end at offset+25.', scale: 'multipliers, resting1', rotation: 'degrees added to source rotation, resting0', opacity: 'absolute motion override multiplied by source opacity; resting1', baselineChecks: 'For an in-place move, verify start against original state and final offset against original using baselineDelta; checking only final-minus-new-start can hide an unintended initial jump.' }, objectIndex: named.map(o => {const entries=inspectAnimations(project,w.state,{logicalObjectId:o.logicalObjectId});return {...o,animationCount:entries.length,animationsTruncated:entries.length>12,animations:options.staging?entries.slice(0,12):entries.slice(0,12).map(entryBrief)};}), scenes: project.inspection.document.scenes.slice(0, 20).map(s => ({ sceneId: s.sceneId, name: s.name, blocks: doc.state.blocks.filter(b => b.sceneId === s.sceneId) })), runtime: 'agent-native/1', validationMode:w.validationMode, project: { revision: doc.revision, settings: doc.state.settings, sceneCount: project.inspection.document.scenes.length, objectCount: w.objects().length }, editor: { activeSceneId: request.activeSceneId, selectedObjectIds: request.selectedObjectIds ?? (request.selectedObjectId ? [request.selectedObjectId] : []), currentFrame: request.currentFrame }, recentActions: recentSuccessfulActions(doc).slice(-4), tools: callSchema.shape.tool.options.filter(tool=>tool!=='startProduction'&&tool!=='reportTaskConflict'||options.allowProduction&&tool==='startProduction'||options.staging&&tool==='reportTaskConflict'), toolArguments: { listScenes: {}, listObjects: { sceneId: 'optional', offset: 0, limit: 50 }, findObject: { name: 'string', sceneId: 'optional' }, inspectAnimations: { logicalObjectId: 'ID' }, describeTool: { kind: 'edit|operation|check', name: 'exact tool or operation name', variant: 'effect/type for creation (keyframes, wiggle, procedural, trimPath, etc.)' }, defineChecks: { checks: 'ResultCheck[] (request schema using describeTool kind=check)', targets: 'canonical logical IDs authorized by request', allowTimeline: 'strict mode option', dependencyPolicy: 'strict mode option; minimal infers actual dependency closure' }, edit: {updateAnimation:{tool:'updateAnimation',animationId:'existing ID',patch:{startFrame:'optional frame',easing:'optional easing'}},updateEffect:{tool:'updateEffect',expressionId:'existing ID',patch:{parameters:'partial effect parameters'}},removeEffect:{tool:'removeEffect',expressionId:'existing ID'}}, commonOperations:[{type:'removeExpression',expressionId:'existing ID'},{type:'scaleExpressionParameter',expressionId:'existing ID',parameter:'amplitude|frequency|decay',factor:'finite number'},{type:'shiftAnimation',animationId:'existing ID',deltaFrames:'signed integer'}], applyEdit: { operations: 'canonical Operation[]' }, sampleAnimation: { sceneId: 'ID', targetId: 'ID', frames: [0, 15, 30] }, renderFrame: { frames: [0] }, inspectDiff: {}, revertEdit: {}, runFocusedQA: {}, commitRevision: {} }, animationPrimitives: animationSchema.options.map(o => o.shape.effect.value), expressionPrimitives: expressionRegistry.map(e => ({ id: e.id, description: e.description })), editNames: motionToolSchema.options.map(o => o.shape.tool.value), operationNames: operationSchema.options.map(o => o.shape.type.value) };
            const feedback: unknown[] = [];
            const compactHistory: unknown[] = [];
            let compactContext=!!saved;
            let timeoutRetries=0,continuationDeadline=0;
            const repeated = new Set<string>();
            const stagnant = new Set<string>();
            const observed = new Set<string>();
            for (let turn = nextTurn; !session.ready && !session.productionRequested && !session.taskConflict; turn++) {
                run.checkpoint();
                onStage(run.repairAttempts>0?'repairing':'generating');
                run.phase = 'agent-tool-execution';
                const freshInitial={...initial,objectIndex:initial.objectIndex.map(o=>{const animations=inspectAnimations(project,w.state,{logicalObjectId:o.logicalObjectId});return {...o,animations:options.staging?animations.slice(0,12):animations.slice(0,12).map(entryBrief),animationCount:animations.length};})};
                const activeContext=compactContext?{...freshInitial,objectIndex:freshInitial.objectIndex.map(o=>({...o,animations:undefined,animationCount:o.animationCount})),workingRevision:undefined}:freshInitial;
                const userContext = JSON.stringify({ userRequest: request.request, context: activeContext, taskHistory: options.staging?feedback:feedback.map(entry=>providerFeedback(entry,digest(w.state))),describedToolSchemas:session.schemaReferences(), currentWorkingRevision:options.staging?{...w.diff(),checks:w.checks}:workingContext(w),assumptions,executionNote:message,confirmedExecution:observations.map(entry=>{const e=entry as {tool?:string;candidateDigest?:string};return {...e,observationStatus:e.tool?.startsWith('inspect')?(e.candidateDigest===digest(w.state)?'CURRENT':'STALE_RELOAD_WITH_TOOL'):'CONFIRMED_TOOL_EXECUTION'};}),compactedHistory:compactHistory });
                run.contextBytes = Math.max(run.contextBytes, Buffer.byteLength(userContext));
                if(continuationDeadline&&Date.now()>=continuationDeadline)throw Object.assign(Error('DIRECT_CONTINUATION_BUDGET'),{code:'DIRECT_CONTINUATION_BUDGET'});
                let response;
                try { response = await run.invoke(adapter, { purpose: 'agent-execution', messages: [{ role: 'system', content: instructions }, { role: 'user', content: userContext }], responseSchema: wire.schema, model: effectiveModel || undefined, signal:continuationDeadline?AbortSignal.any([run.signal,AbortSignal.timeout(Math.max(1,continuationDeadline-Date.now()))]):run.signal, timeoutMs: continuationDeadline?Math.max(1,Math.min(run.config.providerTimeoutMs,continuationDeadline-Date.now())):run.config.providerTimeoutMs, maxOutputTokens: run.config.maxOutputTokens }); } catch(error) {
                    if(checkpoint&&!run.signal.aborted&&(error as {code?:string}).code==='PROVIDER_TIMEOUT'){
                        await persist();
                        if(!continuationDeadline)continuationDeadline=Date.now()+run.config.directContinuationBudgetMs;
                        if(timeoutRetries<run.config.directTimeoutRetries&&Date.now()<continuationDeadline){timeoutRetries++;run.repairAttempts++;compactContext=true;feedback.splice(0);compactHistory.splice(0);session.ready=false;await run.record('direct-timeout-continuation',{runId:id,retry:timeoutRetries,candidateDigest:digest(w.state),batches:w.batches.length,originalRequestPreserved:true});continue;}
                    }
                    if((error as {code?:string}).code==='CONTEXT_EXHAUSTED'&&(!compactContext||feedback.length>0)){compactContext=true;feedback.splice(0);compactHistory.splice(0);compactHistory.push({reason:'Context window admission: detailed stale observations removed. User request, current revision/diff/checks and target identities retained; inspect tools can reload authoritative data.'});await run.record('agent-context-compacted',{providerCalls:run.calls.length,workingDigest:digest(w.state),userRequestPreserved:true});continue;}throw error;}
                model.availability=adapter.mode==='live'?'INFERENCE_CONFIRMED':'MOCK_RESPONSE_CONFIRMED';
                const payload = response.toolCalls.length ? { calls: response.toolCalls.map((c, i) => ({ callId: `native-${turn}-${i}`, tool: c.name, argumentsJson: JSON.stringify(c.arguments) })), disposition: 'CONTINUE', message: '', assumptions: [] } : wire.wrapped ? (response.output as {
                    response?: unknown;
                })?.response : response.output;
                const parsed = directSchema.safeParse(strict ? normalizeProviderOutput(payload, schema) : payload);
                if (!parsed.success) {
                    const error = { code: 'INVALID_TOOL_RESPONSE', issues: parsed.error.issues.slice(0, 8) };
                    const signature=digest([error,digest(w.state)]);if(repeated.has(signature))throw Error('REPEATED_UNCHANGED_INVALID_RESPONSE');repeated.add(signature);feedback.push(error);
                    turns.push({ turn, error, rawOutput: response.output });run.repairAttempts++;
                    continue;
                }
                const answer = parsed.data;
                assumptions = [...new Set([...assumptions,...answer.assumptions])];
                message = answer.message;
                disposition = answer.disposition;
                const beforeTurnDigest=digest(w.state);let newEvidence=false;
                const results: unknown[] = [];
                let hadToolError = false;
                run.phase="agent-tool-execution";
                for (const call of answer.calls) {
                    if(session.productionRequested||session.taskConflict)break;
                    run.checkpoint();
                    try {
                        const result = await session.call(callSchema.parse(call));const evidence=digest(stableObservation([call.tool,call.argumentsJson,result]));if(!observed.has(evidence)){observed.add(evidence);newEvidence=true;}if(result&&typeof result==='object'&&(result as {status?:string}).status==='FAILED'&&(agentPolicy(w.validationMode).mandatoryQA||call.tool!=='runFocusedQA'))hadToolError=true;
                        results.push({ call, result,observedDigest:digest(w.state) });
                        observations.push({turn,tool:call.tool,callId:call.callId,argumentsDigest:digest(call.argumentsJson),resultDigest:digest(result),candidateDigest:digest(w.state),batches:w.batches.length,summary:JSON.stringify(result)?.slice(0,1800),details:`motion/ai/${run.runId}/agent-runtime.json`});
                        observations=observations.slice(-30);nextTurn=turn+1;
                        await persist();
                    }
                    catch (error) {
                        hadToolError = true;
                        session.ready = false;
                        if(/DIRECT_CHECKPOINT|ENOSPC|EIO|EROFS/.test(String(error)))throw error;
                        const issue = (error as {
                            issue?: Record<string, unknown>;
                        }).issue ?? { code: (error as {
                                code?: string;
                            }).code ?? (error instanceof z.ZodError ? 'INVALID_TOOL_ARGUMENT' : (error as Error).message?.match(/^[A-Z][A-Z0-9_]+/)?.[0] ?? 'TECHNICAL_INVARIANT_FAILED'), message: String(error), ...(error instanceof z.ZodError ? { issues: error.issues.slice(0, 8) } : {}) };
                        const signature = digest([call.tool, call.argumentsJson, issue,digest(w.state)]);
                        results.push({ call, error: issue });
                        if (repeated.has(signature))
                            throw Object.assign(Error('REPEATED_UNCHANGED_TOOL_FAILURE'), { code: 'REPEATED_UNCHANGED_TOOL_FAILURE' });
                        repeated.add(signature);
                    }
                }
                if (hadToolError){session.ready=false;run.repairAttempts++;}
                if(!session.ready&&beforeTurnDigest===digest(w.state)&&!newEvidence){const signature=digest([answer.calls.map(c=>[c.tool,c.argumentsJson]),stableObservation(results.map((r:any)=>({tool:r.call?.tool,argumentsJson:r.call?.argumentsJson,result:r.result,error:r.error}))),beforeTurnDigest]);if(stagnant.has(signature))throw Error('REPEATED_NO_PROGRESS');stagnant.add(signature);}
                feedback.push({ assistant: answer, results });
                while(feedback.length>4){const old=feedback.shift() as {assistant?:{calls?:{tool:string;argumentsJson:string}[]};results?:unknown[]};compactHistory.push({tools:old.assistant?.calls?.map(c=>({tool:c.tool,argumentsDigest:digest(c.argumentsJson)})),observationDigest:digest(old.results??old),details:'Older observations compacted; authoritative working state and tools remain available'});}
                if(compactHistory.length>20)compactHistory.splice(0,compactHistory.length-20);
                nextTurn=turn+1;turns.push({ turn, calls: answer.calls, results });
                await run.record('agent-turn', { turn, results });
                await persist();
                if (['NEEDS_USER_INPUT', 'TECHNICAL_BLOCKED'].includes(disposition))
                    break;
            }
        }
        if(session.productionRequested){await run.finish('HANDOFF');return {handoff:'MOTION_PRODUCTION' as const,reason:session.productionRequested,id,request,intakeMetrics:{calls:run.calls,contextBytes:run.contextBytes,qaDurationMs:run.qaDurationMs,renderDurationMs:run.renderDurationMs,repairAttempts:run.repairAttempts}};}
        if(options.staging&&!session.ready&&(session.taskConflict||disposition==='TECHNICAL_BLOCKED')){const observed=await w.observeChecks(options.staging.expectedChecks,run.signal,()=>run.beforeRender());if(observed.some(c=>c.status!=='PASSED')){await persist();await run.finish('TASK_CONTRACT_CONFLICT');return {taskConflict:true as const,report:session.taskConflict??message,observed,state:w.state,id};}}
        if (!session.ready)
            throw Object.assign(Error(disposition === 'NEEDS_USER_INPUT' || disposition === 'TECHNICAL_BLOCKED' ? message : 'Не хватило доступных шагов для проверенного результата; исходная анимация сохранена.'), { code: disposition === 'CONTINUE' ? 'AGENT_NO_COMMIT' : disposition, agentDisposition: disposition === 'CONTINUE' ? 'RESOURCE_LIMIT_REACHED' : disposition });
        if(options.staging){w.assertReady();await persist();await run.finish('STAGED_VERIFIED');return {staged:true as const,state:w.state,batches:w.batches,checks:w.evaluate(),readTargets:w.observedTargets(),assumptions,id,message};}
        onStage('applying');
        let checks = w.assertReady();
        const current=await readMotion(project);if(current.revision!==w.revision){run.phase='agent-rebase';const rebase=w.rebase(current.revision,current.state);await run.record('agent-rebase',rebase);const rebaseStarted=performance.now();session.qa=agentPolicy(w.validationMode).mandatoryQA?await w.validate(run.signal,()=>run.beforeRender()):{status:'PASSED',integrity:w.validateIntegrity(),timings:{renderMs:0}};run.qaDurationMs+=performance.now()-rebaseStarted;run.renderDurationMs+=(session.qa as Awaited<ReturnType<WorkingRevision['validate']>>).timings.renderMs;checks=w.assertReady();await persist();}
        if(checkpoint){checkpoint.publication.status='COMMITTING';await persist();}
        run.phase = 'atomic-commit';
        runtimeCode.assertCurrent();
        const publication = await changeMotion(project.root, { expectedRevision: w.revision, expectedSourceFingerprint: project.inspection.fingerprint, operationBatches: w.batches, expectedCandidate: w.state, transactionId: id, requestFingerprint: checkpoint?.requestFingerprint ?? options.requestFingerprint ?? digest(request), request: request.request, origin: 'ai', agentValidationMode:w.validationMode, assumptions, warnings:w.scopeExpansions.length?['Computed transaction scope includes additional entities; see agent-runtime.json scopeExpansions']:[], signal: run.signal, checkpoint: () => run.checkpoint() });
        if ((session.qa as {
            qa?: {
                renderValidation: string;
            };
        })?.qa?.renderValidation === 'PASSED')
            run.firstPreviewAvailableMs = performance.now() - run.started;
        if(checkpoint){checkpoint.status='COMPLETED';checkpoint.publication={transactionId:id,status:'COMMITTED',revision:publication.document.revision};await persist();}
        const diagnosticFailures=checks.filter(c=>c.status!=='PASSED');
        const reconciliation = { status: diagnosticFailures.length?'PARTIAL_SUCCESS':'SUCCESS',technicalCommit:'PASSED',validationMode:w.validationMode,coverageAssessment:checks.length?'MODEL_DEFINED_DIAGNOSTICS':'NOT_INDEPENDENTLY_ASSESSED',diagnosticFailures, requested: checks.length, completed: checks.filter(c=>c.status==='PASSED').length, intentCompleteness: 'MODEL_INTERPRETED_NOT_INDEPENDENTLY_PROVEN', validationLevels: { execution: 'PASSED', render: (session.qa as {
                    qa?: {
                        renderValidation: string;
                    };
                })?.qa?.renderValidation ?? 'NOT_TESTED', artistic: 'NOT_TESTED' } };
        const result = { id, request, revision: doc.revision, sourceFingerprint: project.inspection.fingerprint, status: 'applied', taskExecution: true, agentDisposition: diagnosticFailures.length?'PARTIAL_SUCCESS':assumptions.length ? 'SUCCESS_WITH_EXPLICIT_ASSUMPTIONS' : 'SUCCESS', agentRuntime: 'agent-native/1', document: publication.document, time: projectTime(publication.document.state, publication.document.revision), plan: { status: 'ready', summary: message || 'Анимация обновлена', operations: w.batches.flat(), warnings: w.scopeExpansions.length?['Вычисленная область транзакции расширена: '+[...new Set(w.scopeExpansions.flatMap((e:any)=>e.targets??[]))].map(id=>w.objects().find(o=>o.logicalObjectId===id)?.name??id).join(', ')+'; подробности в Inspector']:[], assumptions }, requirements: checks.map(c => ({ ...c, requirementId: c.checkId, techniques: [], qaResult: { status: c.status, renderValidation: (session.qa as {
                        qa?: {
                            renderValidation: string;
                        };
                    })?.qa?.renderValidation ?? 'NOT_TESTED' } })), tasks: [], reconciliation, persistence: { status: 'CONFIRMED' }, playbackStart: 0 };
        try {
            await atomicJson(path.join(run.directory, 'proposal.json'), result);
            await atomicJson(path.join(run.directory, 'commit-verified.json'), { revision: publication.document.revision });
            await run.finish(diagnosticFailures.length?'PARTIAL_SUCCESS':'SUCCESS', { reconciliation });
        }
        catch (error) {
            result.persistence = { status: 'DURABILITY_WARNING' };
            await run.finish(diagnosticFailures.length?'PARTIAL_SUCCESS':'SUCCESS', { reconciliation }).catch(() => { });
        }
        return result;
    }
    catch (error) {
        if(checkpoint){
            const latest=await readMotion(project),index=latest.history.findIndex(e=>e.transactionId===id);
            if((index>=0&&index<latest.cursor)||latest.lastCommit?.transactionId===id){checkpoint.status='COMPLETED';checkpoint.publication={transactionId:id,status:'COMMITTED',revision:latest.revision};await persist().catch(()=>{});await run.finish('SUCCESS').catch(()=>{});return {id,status:'applied',document:latest,time:projectTime(latest.state,latest.revision),replayed:true,plan:{status:'ready',summary:'Сохранение подтверждено по transaction receipt',operations:w.batches.flat(),assumptions,warnings:[]},persistence:{status:'CONFIRMED'},playbackStart:0};}
            const code=(error as {code?:string}).code??String(error);
            checkpoint.status=run.signal.aborted?'CANCELLED':/PROVIDER_TIMEOUT|PROVIDER_TRANSPORT|CONTEXT_EXHAUSTED|CONTINUATION_BUDGET|OUTPUT_TRUNCATED|AUTH_REQUIRED|PROVIDER_AUTH/.test(code)?'PAUSED_RESUMABLE':'FAILED';checkpoint.reason=String(error);await persist();
            await run.diagnostic('direct-checkpoint-status',{runId:id,status:checkpoint.status,batches:w.batches.length,candidateDigest:digest(w.state),publicCommit:false,reason:checkpoint.reason});
            await run.finish(checkpoint.status);
            if(checkpoint.status!=='FAILED')return {id,checkpointId:id,status:checkpoint.status,resumable:true,summary:checkpoint.status==='CANCELLED'?'Выполнение отменено. Промежуточная работа сохранена.':'Ответ модели прерван или требуется продолжение. Выполненные изменения сохранены. Можно продолжить.',persistence:{status:'CHECKPOINTED'},candidateDigest:digest(w.state),appliedBatches:w.batches.length};
        }
        if (/BUDGET|TIMEOUT/.test(String(error)))
            Object.assign(error as object, { agentDisposition: 'RESOURCE_LIMIT_REACHED' });
        else if(!(error as {agentDisposition?:string}).agentDisposition)Object.assign(error as object,{agentDisposition:run.signal.aborted?'CANCELLED':'TECHNICAL_BLOCKED'});
        await persist().catch(() => { });
        await run.captureFailure(error);
        await run.finish('FAILED');
        throw error;
    }
}

/** A single lease protects candidate delivery; public state still commits through changeMotion. */
export async function executeAgentMotion(...args:Parameters<typeof executeAgentMotionInner>){
    const [project,input,onStage,options={}]=args;
    if(options.staging)return executeAgentMotionInner(project,input,onStage,options);
    const id=options.resumeId??input.editId??randomUUID(),unlock=await lockProject(await directDirectory(project,id),{neverExpireLiveOwner:true});
    try{
        if(!options.resumeId){try{const saved=await readDirectCheckpoint(project,id);if(saved.request.request!==input.request||options.requestFingerprint&&saved.requestFingerprint!==options.requestFingerprint)throw Error('DIRECT_CHECKPOINT_ID_REUSED');return await executeAgentMotionInner(project,saved.request,onStage,{...options,resumeId:id});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
        return await executeAgentMotionInner(project,{...input,editId:id},onStage,options);
    }finally{await unlock();}
}
export async function resumeDirectMotion(project:LoadedProject,id:string,onStage:(stage:string)=>void,options:{signal?:AbortSignal;config?:Partial<HarnessConfig>}={}){
    const saved=await readDirectCheckpoint(project,id);
    return executeAgentMotion(project,saved.request,onStage,{...options,resumeId:id,requestFingerprint:saved.requestFingerprint,allowProduction:false});
}
