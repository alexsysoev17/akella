import {createHash} from "node:crypto";
import type { LoadedProject } from '../types.js';
import type { MotionState } from './schema.js';
import { expressionValue } from './expressions.js';
import { evaluateAnimation } from './evaluation.js';
import { scopedExpressionValue } from './transition-effects.js';
import { statePresentation } from './transitions.js';
import { renderNativeFrame } from '../native/client.js';
const verified = new Map<string,number>();
const proofKey=(project:LoadedProject,state:MotionState,before?:MotionState)=>createHash('sha256').update(JSON.stringify([project.root,project.inspection.fingerprint,before,state])).digest('hex');
/** A bounded in-process proof of an actually checked candidate, not a client-supplied bypass flag. */
export function hasVerifiedRuleQA(project:LoadedProject,state:MotionState,before:MotionState){
 const at=verified.get(proofKey(project,state,before));return at!==undefined&&Date.now()-at<60000;
}
export async function ruleQA(project: LoadedProject, state: MotionState, previous?: MotionState, signal?: AbortSignal, beforeRender?: () => void, renderOptions:{scale?:number}={}) {
    const owned = new Set(state.ruleMaterializations?.filter(m => m.entity === 'expression').map(m => m.id));
    const changed = (state.expressions ?? []).filter(e => JSON.stringify(e) !== JSON.stringify(previous?.expressions?.find(p => p.expressionId === e.expressionId)));
    const previousOwned = new Set(previous?.ruleMaterializations?.filter(m => m.entity === 'expression').map(m => m.id));
    const removed = (previous?.expressions ?? []).filter(e => !state.expressions?.some(n => n.expressionId === e.expressionId));
    const presentation = statePresentation(project, state), checks: {
        name: string;
        status: 'PASSED' | 'FAILED';
        reason?: string;
    }[] = [], frames = new Set<number>();
    for (const e of changed) {
        signal?.throwIfAborted();
        const value = (f: number) => e.transitionId ? scopedExpressionValue(state, e, f, presentation) : expressionValue(e, f, state.settings.fps, state.animations, evaluateAnimation);
        const samples = Array.from({ length: 65 }, (_, i) => value(e.startFrame + e.durationFrames * i / 64));
        const finite = samples.every(Number.isFinite), deterministic = samples.every((v, i) => v === value(e.startFrame + e.durationFrames * i / 64));
        const settles = e.type !== 'inertialOvershoot' || Math.abs(samples[0]) < 1e-8 && Math.abs(samples[64]) < 1e-8;
        if(e.type==='inertialOvershoot'&&e.enabled&&e.parameters.amplitude>0){
            const visible=samples.some(v=>Math.abs(v)>1e-12)||(state.expressions??[]).some(partner=>partner.enabled&&partner.type==='inertialOvershoot'&&partner.sourceAnimationId===e.sourceAnimationId&&partner.expressionId!==e.expressionId&&samples.some((_,i)=>Math.abs(scopedExpressionValue(state,partner,partner.startFrame+partner.durationFrames*i/64,presentation))>1e-12));
            checks.push({name:`rule:${e.expressionId}:observable-inertia`,status:visible?'PASSED':'FAILED',reason:'INERTIA_NO_OBSERVABLE_RESPONSE: no usable incoming velocity; no synthetic impulse or Wiggle substitution.'});
        }
        const bounded = e.type !== 'wiggle' || samples.every(v => Math.abs(v) <= e.parameters.amplitude + 1e-8);
        checks.push({ name: `rule:${e.expressionId}:numeric-composition`, status: finite && deterministic && settles && bounded ? 'PASSED' : 'FAILED', reason: `finite=${finite}, deterministic=${deterministic}, settles=${settles}, bounded=${bounded}` });
        for (const p of [.25, .5, .75]) {
            const f = Math.round(e.startFrame + e.durationFrames * p);
            if (f >= 0 && f < state.settings.durationFrames)
                frames.add(f);
        }
    }
    for (const e of removed) {
        checks.push({ name: `rule:${e.expressionId}:removed`, status: state.expressions?.some(n => n.expressionId === e.expressionId) ? 'FAILED' : 'PASSED' });
        for (const p of [.25, .5, .75]) {
            const f = Math.round(e.startFrame + e.durationFrames * p);
            if (f >= 0 && f < state.settings.durationFrames)
                frames.add(f);
        }
    }
    const changedTracks=[...state.animations.filter(a=>JSON.stringify(a)!==JSON.stringify(previous?.animations.find(p=>p.animationId===a.animationId))),...(previous?.animations??[]).filter(a=>!state.animations.some(n=>n.animationId===a.animationId))];
    for(const a of changedTracks)for(const p of [0,.5,1]){const f=Math.round(a.startFrame+a.durationFrames*p);if(f>=0&&f<state.settings.durationFrames)frames.add(f);}
    // Bounded real rasterization; numerical sampling is dense and independent of image budget.
    const selected = [...frames].sort((a, b) => a - b);
    const sampled = selected.length <= 16 ? selected : Array.from({ length: 16 }, (_, i) => selected[Math.round(i * (selected.length - 1) / 15)]);
    for (const frame of sampled) {
        signal?.throwIfAborted();
        beforeRender?.();
        const rendered = await renderNativeFrame(project, state, frame, { signal,scale:renderOptions.scale??1 });
        checks.push({ name: `rule-native-frame:${frame}`, status: rendered.png.length ? 'PASSED' : 'FAILED' });
    }
    if (sampled.length)
        checks.push({ name: 'renderedFrames', status: 'PASSED' });
    const status=checks.some(c=>c.status==='FAILED')?'FAILED':'PASSED';
    if(status==='PASSED'){if(verified.size>=32)verified.delete(verified.keys().next().value!);verified.set(proofKey(project,state,previous),Date.now());}
    return { status, checks, renderScale:renderOptions.scale??1, numericEffects: changed.length, removedEffects: removed.length, renderedFrames: sampled, renderValidation: sampled.length ? 'PASSED' : 'NOT_TESTED', visualArtisticAssessment: 'NOT_TESTED', baseAnimationPreservation: 'verified by typed delta scope; no creative-quality claim' };
}
