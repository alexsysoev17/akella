import {objectsIn} from './context.js';
import {renderNativeFrame} from '../native/client.js';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { LoadedProject } from '../types.js';
import { operationSchema, type MotionState, type Operation } from './schema.js';
import { applyOperations, motionDiff } from './operations.js';
import { motionToolSchema, lowerMotionTool } from './tools.js';
import { buildRegistry } from './registry.js';
import { evaluateMotion } from './evaluation.js';
import { statePresentation } from './transitions.js';
import { ruleQA } from './rule-qa.js';
import { digest } from '../harness/context.js';
const id = z.string().min(1).max(180);
export const resultCheckSchema = z.discriminatedUnion('kind', [
    z.object({kind:z.literal('entryMatches'),entity:z.enum(['animation','expression','transition']),sceneId:id.optional(),targetId:id.optional(),logicalObjectId:id.optional(),where:z.array(z.object({path:z.array(z.string().min(1).max(100)).min(1).max(5),value:z.union([z.number().finite(),z.string(),z.boolean(),z.null()])}).strict()).min(1).max(10),minimumCount:z.number().int().min(1).max(5000)}).strict(),
    z.object({kind:z.literal('renderedDelta'),logicalObjectId:id,sceneId:id.optional(),beforeFrame:z.number().int().nonnegative(),afterFrame:z.number().int().nonnegative(),property:z.enum(['x','y','rotation','opacity']),delta:z.number().finite(),tolerance:z.number().nonnegative().max(.1)}).strict(),
    z.object({ kind: z.literal('startDelta'), animationId: id, frames: z.number().int() }).strict(),
    z.object({ kind: z.literal('entryField'), entity: z.enum(['animation', 'expression', 'transition']), id, path: z.array(z.string().min(1).max(100)).min(1).max(5), value: z.union([z.number().finite(), z.string(), z.boolean(), z.null()]) }).strict(),
    z.object({ kind: z.literal('absent'), entity: z.enum(['animation', 'expression', 'transition']), id }).strict(),
    z.object({ kind: z.literal('baselineDelta'), sceneId: id, targetId: id, property: z.enum(['x', 'y', 'rotation', 'opacity', 'scaleX', 'scaleY']), beforeFrame: z.number().int(), afterFrame: z.number().int(), delta: z.number().finite(), tolerance: z.number().nonnegative().max(.1) }).strict(),
    z.object({ kind: z.literal('motionDelta'), sceneId: id, targetId: id, property: z.enum(['x', 'y', 'rotation', 'opacity', 'scaleX', 'scaleY']), fromFrame: z.number().int(), toFrame: z.number().int(), delta: z.number().finite(), tolerance: z.number().nonnegative().max(.1) }).strict(),
    z.object({ kind: z.literal('motionVaries'), sceneId: id, targetId: id, property: z.enum(['x', 'y', 'rotation', 'opacity', 'scaleX', 'scaleY']), frames: z.array(z.number().int()).min(3).max(65), minimumRange: z.number().nonnegative() }).strict(),
    z.object({ kind: z.literal('basePreserved'), animationIds: z.array(id).min(1).max(500) }).strict(),
]);
export const requirementCheckSchema = z.object({ checkId: id, sourceText: z.string().min(1).max(5000), assertion: resultCheckSchema }).strict();
export type ResultCheck = z.infer<typeof requirementCheckSchema>;
/** Ephemeral canonical candidate only. Persistence/history/lock remain in changeMotion. */
export class WorkingRevision {
    original: MotionState;
    private readTargets=new Set<string>();
    state: MotionState;
    batches: Operation[][] = [];
    checks: ResultCheck[] = [];
    private checkedDigest?: string;
    private renderProofs=new Map<string,{digest:string;result:{status:string;actual:unknown}}>();
    private startedEditing = false;
    private scope: string[] = [];
    private allowTimeline = false;
    private dependencyPolicy: "reject" | "preserve-relative" = "reject";
    private receipts = new Map<string, {
        digest: string;
        result: unknown;
        batchIndex: number;
        operationsDigest: string;
    }>();
    constructor(readonly project: LoadedProject, public revision: string, state: MotionState, readonly request: string) { this.original = structuredClone(state); this.state = structuredClone(state); }
    defineChecks(input: unknown, targets: string[], allowTimeline = false, dependencyPolicy: "reject" | "preserve-relative" = "reject") { if (this.startedEditing)
        throw Error('CHECKS_MUST_PRECEDE_EDITS'); const checks = z.array(requirementCheckSchema).min(1).max(200).parse(input); if (new Set(checks.map(c => c.checkId)).size !== checks.length)
        throw Error('DUPLICATE_CHECK_ID'); if (checks.some(c => !this.request.includes(c.sourceText)))
        throw Error('CHECK_SOURCE_NOT_IN_USER_REQUEST'); if (!targets.length || targets.some(id => !this.objects().some(o => o.logicalObjectId === id)))
        throw Error("INVALID_DECLARED_TARGET_SCOPE"); this.scope = [...new Set(targets)];this.observeTargets(targets); this.allowTimeline = allowTimeline; this.dependencyPolicy = dependencyPolicy; this.checks = checks; return { defined: checks.length, scope: this.scope, allowTimeline }; }
    apply(input: unknown, deliveryId: string, typed = false) { if (!this.checks.length)
        throw Error('DEFINE_RESULT_CHECKS_FIRST'); const inputDigest = digest(input); const previous = this.receipts.get(deliveryId); if (previous) {
        if (previous.digest !== inputDigest)
            throw Error('TOOL_CALL_ID_REUSED');
        if (digest(this.batches[previous.batchIndex] ?? []) !== previous.operationsDigest)
            throw Error('TOOL_CALL_REVERTED: use a new callId');
        return previous.result;
    } const ops = typed ? lowerMotionTool(this.project, this.state, motionToolSchema.parse(input)) : z.array(operationSchema).min(1).max(500).parse(input); if (this.batches.reduce((n, b) => n + b.length, 0) + ops.length > 500)
        throw Error("WORKING_OPERATION_LIMIT: canonical history supports at most 500 operations per atomic transaction"); const before = this.state; const next = applyOperations(this.state, ops, this.project); this.assertScope(next, ops); this.startedEditing = true; this.state = next; this.batches.push(ops); this.checkedDigest = undefined; const result = { applied: ops.length, candidateDigest: digest(next), diff: motionDiff(before, next) }; this.receipts.set(deliveryId, { digest: inputDigest, result, batchIndex: this.batches.length - 1, operationsDigest: digest(ops) }); return result; }
    assertScope(next: MotionState, ops: Operation[]) {
        const own = (e: {
            sceneId: string;
            targetId: string;
        }) => this.objects().some(o => this.scope.includes(o.logicalObjectId) && o.sourceInstances.some(i => i.sceneId === e.sceneId && i.sourceNodeId === e.targetId));
        const explicit = new Set(ops.flatMap(op => op.type === 'addAnimation' ? [op.animation.animationId] : 'animationId' in op ? [op.animationId] : op.type === 'stagger' ? op.animationIds : []));
        const moved = new Set(this.state.animations.filter(a => own(a) && explicit.has(a.animationId) && next.animations.some(b => b.animationId === a.animationId && (b.startFrame !== a.startFrame || b.durationFrames !== a.durationFrames))).map(a => a.animationId));
        const dependent = new Set<string>();
        if (this.dependencyPolicy === 'preserve-relative') {
            let size = -1;
            while (size !== moved.size) {
                size = moved.size;
                for (const d of next.timingDependencies ?? [])
                    if (moved.has(d.anchorAnimationId) && !explicit.has(d.animationId)) {
                        moved.add(d.animationId);
                        dependent.add(d.animationId);
                    }
            }
        }
        const onlyStartChanged = (before: unknown, after: unknown) => { if (!before || !after)
            return false; const { startFrame: _b, ...b } = before as Record<string, unknown>, { startFrame: _a, ...a } = after as Record<string, unknown>; return isDeepStrictEqual(b, a); };
        const derivedTrack = (e: MotionState['animations'][number]) => dependent.has(e.animationId) && onlyStartChanged(this.state.animations.find(a => a.animationId === e.animationId), next.animations.find(a => a.animationId === e.animationId));
        const derivedExpression = (e: NonNullable<MotionState['expressions']>[number]) => 'sourceAnimationId' in e && dependent.has(e.sourceAnimationId) && onlyStartChanged(this.state.expressions?.find(a => a.expressionId === e.expressionId), next.expressions?.find(a => a.expressionId === e.expressionId));
        const changed = <T>(before: T[], after: T[], key: (e: T) => string, allowed: (e: T) => boolean) => { for (const e of [...before, ...after]) {
            const b = before.find(v => key(v) === key(e)), a = after.find(v => key(v) === key(e));
            if (!isDeepStrictEqual(b, a) && !allowed(e))
                throw Error('EDIT_OUTSIDE_DECLARED_SCOPE: ' + key(e));
        } };
        changed(this.state.animations, next.animations, e => e.animationId, e => own(e) || derivedTrack(e));
        changed(this.state.expressions ?? [], next.expressions ?? [], e => e.expressionId, e => derivedExpression(e) || (e.ownership?.scope === 'logicalObject' ? this.scope.includes(e.ownership.logicalObjectId ?? '') : own(e)));
        changed(this.state.objectTransitions ?? [], next.objectTransitions ?? [], e => e.transitionId, e => this.scope.includes(e.logicalObjectId));
        changed(this.state.anchors ?? [], next.anchors ?? [], e => JSON.stringify([e.logicalObjectId, e.sceneId, e.startFrame]), e => this.scope.includes(e.logicalObjectId));
        changed(this.state.motionRules ?? [], next.motionRules ?? [], e => e.ruleId, e => (e.scope.logicalObjectIds.length ? e.scope.logicalObjectIds : this.objects().map(o => o.logicalObjectId)).every(id => this.scope.includes(id)));
        changed(this.state.timingDependencies ?? [], next.timingDependencies ?? [], e => e.dependencyId, e => { const a = next.animations.find(a => a.animationId === e.animationId) ?? this.state.animations.find(a => a.animationId === e.animationId); return Boolean(a && own(a)); });
        changed(this.state.visibility, next.visibility, e => e.sceneId + '/' + e.targetId, own);
        if (!this.allowTimeline && (!isDeepStrictEqual(this.state.settings, next.settings) || !isDeepStrictEqual(this.state.blocks, next.blocks)))
            throw Error('TIMELINE_SCOPE_NOT_DECLARED');
    }
    revert() { if (!this.batches.length)
        throw Error('NO_EDIT_TO_REVERT'); this.batches.pop(); this.state = this.batches.reduce((state, batch) => applyOperations(state, batch, this.project), structuredClone(this.original)); this.checkedDigest = undefined; return this.diff(); }
    rollback() { this.state = structuredClone(this.original); this.batches = []; this.checkedDigest = undefined; }
    diff() { return { baseRevision: this.revision, candidateDigest: digest(this.state), batches: this.batches.length, diff: motionDiff(this.original, this.state) }; }
    evaluate() {
        const presentation = statePresentation(this.project, this.state), entries = (s: MotionState, k: string) => k === 'animation' ? s.animations : k === 'expression' ? (s.expressions ?? []) : (s.objectTransitions ?? []), entry = (s: MotionState, k: string, id: string) => entries(s, k).find(e => ('animationId' in e ? e.animationId : 'expressionId' in e ? e.expressionId : e.transitionId) === id);
        return this.checks.map(c => { const a = c.assertion; let actual: unknown, passed = false; if(a.kind==='entryMatches'){const matches=entries(this.state,a.entity).filter(e=>{const logical='logicalObjectId'in e?e.logicalObjectId:this.objects().find(o=>o.sourceInstances.some(i=>i.sceneId===e.sceneId&&i.sourceNodeId===e.targetId))?.logicalObjectId;if(a.logicalObjectId&&logical!==a.logicalObjectId)return false;if(a.targetId&&(!('targetId'in e)||e.targetId!==a.targetId))return false;if(a.sceneId&&('sceneId'in e?e.sceneId!==a.sceneId:e.fromSceneId!==a.sceneId&&e.toSceneId!==a.sceneId))return false;return a.where.every(condition=>{let value:unknown=e;for(const key of condition.path){if(['__proto__','prototype','constructor'].includes(key))return false;value=value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,key)?.value:undefined;}return isDeepStrictEqual(value,condition.value);});});actual={count:matches.length,ids:matches.map(e=>'animationId'in e?e.animationId:'expressionId'in e?e.expressionId:e.transitionId)};return {...c,status:matches.length>=a.minimumCount?'PASSED':'FAILED',actual};}if(a.kind==='renderedDelta'){const proof=this.renderProofs.get(c.checkId);return {...c,...(proof?.digest===digest(this.state)?proof.result:{status:'NOT_TESTED',actual:null})};}if (a.kind === 'startDelta') {
            const before = entry(this.original, 'animation', a.animationId) ?? entry(this.original, 'transition', a.animationId), after = entry(this.state, 'animation', a.animationId) ?? entry(this.state, 'transition', a.animationId);
            actual = before && after ? after.startFrame - before.startFrame : null;
            passed = actual === a.frames;
        }
        else if (a.kind === 'entryField') {
            actual = entry(this.state, a.entity, a.id);
            for (const k of a.path) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) {
                    actual = undefined;
                    break;
                }
                actual = actual && typeof actual === 'object' ? Object.getOwnPropertyDescriptor(actual, k)?.value : undefined;
            }
            passed = isDeepStrictEqual(actual, a.value);
        }
        else if (a.kind === 'absent') {
            actual = Boolean(entry(this.state, a.entity, a.id));
            passed = !actual;
        }
        else if (a.kind === 'basePreserved') {
            actual = a.animationIds.filter(id => !entry(this.original, 'animation', id) || !isDeepStrictEqual(entry(this.original, 'animation', id), entry(this.state, 'animation', id)));
            passed = (actual as string[]).length === 0;
        }
        else if (a.kind === 'baselineDelta') {
            const fallback = a.property.startsWith('scale') || a.property === 'opacity' ? 1 : 0;
            const original = evaluateMotion(this.original, a.beforeFrame, statePresentation(this.project, this.original)).nodes[JSON.stringify([a.sceneId, a.targetId])]?.[a.property] ?? fallback;
            const final = evaluateMotion(this.state, a.afterFrame, presentation).nodes[JSON.stringify([a.sceneId, a.targetId])]?.[a.property] ?? fallback;
            actual = final - original;
            passed = Number.isFinite(actual) && Math.abs((actual as number) - a.delta) <= a.tolerance;
        }
        else if (a.kind === 'motionDelta') {
            const value = (f: number) => evaluateMotion(this.state, f, presentation).nodes[JSON.stringify([a.sceneId, a.targetId])]?.[a.property] ?? (a.property.startsWith('scale') || a.property === 'opacity' ? 1 : 0);
            actual = value(a.toFrame) - value(a.fromFrame);
            passed = Number.isFinite(actual) && Math.abs((actual as number) - a.delta) <= a.tolerance;
        }
        else {
            const values = a.frames.map(f => evaluateMotion(this.state, f, presentation).nodes[JSON.stringify([a.sceneId, a.targetId])]?.[a.property] ?? (a.property.startsWith('scale') || a.property === 'opacity' ? 1 : 0));
            actual = { values, range: Math.max(...values) - Math.min(...values) };
            passed = values.every(Number.isFinite) && (actual as {
                range: number;
            }).range > a.minimumRange;
        } return { ...c, status: passed ? 'PASSED' : 'FAILED', actual }; });
    }
    async validate(signal?: AbortSignal, beforeRender?: () => void) { signal?.throwIfAborted();const validationStarted=performance.now();let sampledRenderMs=0; const frames=new Map<string,Awaited<ReturnType<typeof renderNativeFrame>>>();
        for(const check of this.checks){const a=check.assertion;if(a.kind!=='renderedDelta')continue;
            const sample=async(state:MotionState,frame:number)=>{if(frame>=state.settings.durationFrames)throw Error('CHECK_FRAME_OUTSIDE_OUTPUT');const key=digest(state)+':'+frame;let rendered=frames.get(key);if(!rendered){beforeRender?.();const renderStarted=performance.now();rendered=await renderNativeFrame(this.project,state,frame,{scale:.25,diagnostics:true,signal});sampledRenderMs+=performance.now()-renderStarted;frames.set(key,rendered);}const instances=rendered.composition?.instances.filter(i=>i.logicalObjectId===a.logicalObjectId&&i.visible&&(!a.sceneId||i.sceneId===a.sceneId))??[];if(instances.length!==1||!instances[0].transform)return {value:null,reason:instances.length>1?'AMBIGUOUS_VISIBLE_INSTANCE':'NO_VISIBLE_INSTANCE'};const i=instances[0],m=i.transform!;return {value:a.property==='x'?m[0][2]:a.property==='y'?m[1][2]:a.property==='rotation'?Math.atan2(m[1][0],m[0][0])*180/Math.PI:i.effectiveOpacity??i.opacity??0,frame,sceneId:i.sceneId,targetId:i.targetId,transform:m};};
            const baseline=await sample(this.original,a.beforeFrame),candidate=await sample(this.state,a.afterFrame);const delta=baseline.value===null||candidate.value===null?null:candidate.value-baseline.value;this.renderProofs.set(check.checkId,{digest:digest(this.state),result:{status:delta!==null&&Number.isFinite(delta)&&Math.abs(delta-a.delta)<=a.tolerance?'PASSED':'FAILED',actual:{baseline,candidate,delta,basis:'Actual native-rendered instance transforms; not artistic approval'}}});
        }
        const checks = this.evaluate(), qa = await ruleQA(this.project, this.state, this.original, signal, beforeRender, { scale: .25 }); const passed = checks.length > 0 && checks.every(c => c.status === 'PASSED') && qa.status === 'PASSED'; this.checkedDigest = passed ? digest(this.state) : undefined; return { status: passed ? 'PASSED' : 'FAILED', checks, qa,timings:{totalMs:performance.now()-validationStarted,renderMs:sampledRenderMs+qa.timings.renderMs}, artisticAssessment: 'NOT_TESTED' }; }
    assertReady() { if (!this.batches.length || !this.checks.length || this.checkedDigest !== digest(this.state))
        throw Error('CANDIDATE_NOT_VERIFIED'); const checks = this.evaluate(); if (checks.some(c => c.status !== 'PASSED'))
        throw Error('RESULT_CHECK_FAILED'); return checks; }
    observeTargets(ids:string[]){for(const id of ids)this.readTargets.add(id);}
    /** One bounded rebase; any changed read dependency is a real conflict. */
    rebase(revision:string,latest:MotionState){
        const objects=this.objects(),ids=new Set([...this.readTargets,...this.scope]);
        const owner=(scene:string,target:string)=>objects.find(o=>o.sourceInstances.some(i=>i.sceneId===scene&&i.sourceNodeId===target))?.logicalObjectId;
        const nodes=this.project.inspection.document.scenes.flatMap(objectsIn);let previous=-1;
        while(previous!==ids.size){previous=ids.size;for(const o of objects.filter(o=>ids.has(o.logicalObjectId)))for(const ref of o.sourceInstances){const parent=nodes.find(n=>n.sceneId===ref.sceneId&&n.targetId===ref.sourceNodeId)?.parentId;const parentOwner=parent&&owner(ref.sceneId,parent);if(parentOwner)ids.add(parentOwner);}for(const d of this.original.timingDependencies??[]){const a=this.original.animations.find(a=>a.animationId===d.animationId),anchor=this.original.animations.find(a=>a.animationId===d.anchorAnimationId);if(a&&anchor&&ids.has(owner(a.sceneId,a.targetId)??'')){const id=owner(anchor.sceneId,anchor.targetId);if(id)ids.add(id);}}}
        const belongs=(e:{sceneId:string;targetId:string})=>ids.has(owner(e.sceneId,e.targetId)??'');
        const projection=(s:MotionState)=>({settings:s.settings,blocks:s.blocks,animations:s.animations.filter(belongs),expressions:s.expressions?.filter(e=>belongs(e)||ids.has(e.ownership?.logicalObjectId??'')),transitions:s.objectTransitions?.filter(t=>ids.has(t.logicalObjectId)),anchors:s.anchors?.filter(a=>ids.has(a.logicalObjectId)),visibility:s.visibility.filter(belongs),rules:s.motionRules?.filter(r=>!r.scope.logicalObjectIds.length||r.scope.logicalObjectIds.some(id=>ids.has(id))),dependencies:s.timingDependencies?.filter(d=>s.animations.some(a=>[d.animationId,d.anchorAnimationId].includes(a.animationId)&&belongs(a)))});
        if(!isDeepStrictEqual(projection(this.original),projection(latest)))throw Object.assign(Error('Анимация уже изменилась: конфликт затрагивает прочитанные объекты или зависимости.'),{code:'STALE_PROJECT_REVISION_CONFLICT'});
        const candidate=this.batches.reduce((s,b)=>applyOperations(s,b,this.project),structuredClone(latest));
        this.original=structuredClone(latest);this.state=candidate;this.revision=revision;this.checkedDigest=undefined;this.renderProofs.clear();return {rebased:true,revision,readTargets:[...ids]};
    }
    objects() { return buildRegistry(this.project.inspection.document, this.project.inspection.fingerprint).objects; }
}
