import {compileWiggle} from './effect-edit.js';
import {compileTrackEdit,entranceTrack} from './track-edit.js';
import { lowerMotionTool } from "./tools.js";
import { createHash } from 'node:crypto';
import type { LoadedProject } from '../types.js';
import { buildRegistry } from './registry.js';
import type { MotionState, Animation, Plan } from './schema.js';
import { motionRuleSchema, type MotionRule, type SemanticEdit } from './rule-contract.js';
import { evaluateAnimation } from './evaluation.js';
const stable = (x: unknown) => 'rule_' + createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 28);
export function ruleObjects(project: LoadedProject) { return buildRegistry(project.inspection.document, project.inspection.fingerprint).objects; }
export function resolveRuleTargets(project: LoadedProject, refs: string[]) {
    return [...new Set(refs.map(ref => {
            const matches = ruleObjects(project).filter(o => o.logicalObjectId === ref || o.name === ref || o.sourceInstances.some(i => i.sourceNodeId === ref));
            if (matches.length !== 1 || matches[0].ambiguousScenes.length)
                throw Error(matches.length ? 'AMBIGUOUS_RULE_TARGET' : 'RULE_TARGET_NOT_FOUND');
            return matches[0].logicalObjectId;
        }))];
}
const matches = (r: MotionRule, logical: string, scene: string, start: number, fps: number) => r.enabled && !r.exceptions.includes(logical) && (!r.scope.logicalObjectIds.length || r.scope.logicalObjectIds.includes(logical)) && (!r.scope.sceneId || r.scope.sceneId === scene) && (r.scope.startSeconds === undefined || start / fps >= r.scope.startSeconds) && (r.scope.endSeconds === undefined || start / fps < r.scope.endSeconds);
const rank = (r: MotionRule) => [r.priority, r.scope.logicalObjectIds.length ? 2 : 0, r.scope.sceneId ? 1 : 0, r.scope.startSeconds !== undefined ? 1 : 0];
function winner(rules: MotionRule[]) { return [...rules].sort((a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++)
    if (x[i] !== y[i])
        return y[i] - x[i]; return b.ruleId.localeCompare(a.ruleId); })[0]; }
/** Rebuild only owned effects. Ordinary tracks/expressions and all their IDs remain authoritative. */
export function materializeRules(state: MotionState, project: LoadedProject) {
    if (!state.motionRules?.length && !state.ruleMaterializations?.length)
        return;
    const registry = ruleObjects(project), fps = state.settings.fps;
    const logical = (scene: string, target: string) => registry.find(o => o.sourceInstances.some(i => i.sceneId === scene && i.sourceNodeId === target))?.logicalObjectId;
    const previous = state.ruleMaterializations ?? [];
    // Restore only properties owned by a rule; never restore a full stale animation snapshot.
    for (const m of previous) {
        if (m.entity === 'animation') {
            const a = state.animations.find(a => a.animationId === m.id);
            if (a && m.before) {
                const b = m.before as {
                    enabled?: boolean;
                    easing?: Animation['easing'];
                };
                if (b.enabled !== undefined)
                    a.enabled = b.enabled;
                if (b.easing !== undefined)
                    a.easing = b.easing;
            }
        }
        else if (m.entity === 'transition') {
            const t = state.objectTransitions?.find(t => t.transitionId === m.id);
            if (t && m.before)
                t.easing = (m.before as {
                    easing: typeof t.easing;
                }).easing;
        }
    }
    const ids = new Set(previous.filter(m => m.entity === 'expression').map(m => m.id));
    state.expressions = (state.expressions ?? []).filter(e => !ids.has(e.expressionId));
    state.ruleMaterializations = [];
    const rules = state.motionRules ?? [];
    for (const r of rules) {
        if (r.scope.selector === 'objects' && !r.scope.logicalObjectIds.length)
            throw Error('RULE_EXPLICIT_SCOPE_REQUIRED');
        for (const id of [...r.scope.logicalObjectIds, ...r.exceptions])
            if (!registry.some(o => o.logicalObjectId === id))
                throw Error('RULE_TARGET_NOT_FOUND');
        if (r.scope.sceneId && !project.inspection.document.scenes.some(s => s.sceneId === r.scope.sceneId))
            throw Error('RULE_SCENE_NOT_FOUND');
    }
    const select = (effect: MotionRule['effect'], id: string, scene: string, start: number, entrance = false) => winner(rules.filter(r => r.effect === effect && matches(r, id, scene, start, fps) && (r.scope.phase === 'all' || entrance)));
    for (const a of state.animations) {
        const id = logical(a.sceneId, a.targetId);
        if (!id)
            continue;
        const entrance = ['slideUp', 'slideDown', 'slideLeft', 'slideRight', 'scaleIn', 'fadeIn'].includes(a.effect) && !('mode' in a.parameters && a.parameters.mode === 'out');
        const fade = select('fade', id, a.sceneId, a.startFrame, entrance);
        if (fade && (a.effect.startsWith('fade') || ('property' in a.parameters && a.parameters.property === 'opacity'))) {
            state.ruleMaterializations.push({ ruleId: fade.ruleId, entity: 'animation', id: a.animationId, before: { enabled: a.enabled } });
            a.enabled = fade.enabled && fade.parameters.amplitude !== 0;
        }
        const easing = select('easing', id, a.sceneId, a.startFrame, entrance);
        if (easing?.parameters.easing && Object.keys(evaluateAnimation(a, a.startFrame)).some(p => ['x', 'y', 'rotation', 'scale', 'scaleX', 'scaleY'].includes(p))) {
            state.ruleMaterializations.push({ ruleId: easing.ruleId, entity: 'animation', id: a.animationId, before: { easing: a.easing } });
            a.easing = easing.parameters.easing;
        }
    }
    for (const t of state.objectTransitions ?? []) {
        const r = select('easing', t.logicalObjectId, t.fromSceneId, t.startFrame);
        if (r?.parameters.easing) {
            state.ruleMaterializations.push({ ruleId: r.ruleId, entity: 'transition', id: t.transitionId, before: { easing: t.easing } });
            t.easing = r.parameters.easing;
        }
    }
    for (const o of registry) {
        type Move = {
            id: string;
            sceneId: string;
            targetId: string;
            start: number;
            end: number;
            properties: ('x' | 'y')[];
            transition?: string;
            entrance: boolean;
        };
        const moves: Move[] = state.animations.filter(a => a.enabled && logical(a.sceneId, a.targetId) === o.logicalObjectId).flatMap(a => {
            const values = evaluateAnimation(a, a.startFrame), end = evaluateAnimation(a, a.startFrame + a.durationFrames);
            const properties = (['x', 'y'] as const).filter(p => values[p] !== undefined && values[p] !== end[p]);
            return properties.length ? [{ id: a.animationId, sceneId: a.sceneId, targetId: a.targetId, start: a.startFrame, end: a.startFrame + a.durationFrames, properties: [...properties], entrance: a.effect.startsWith('slide') && 'mode' in a.parameters && a.parameters.mode === 'in' }] : [];
        });
        for (const t of state.objectTransitions ?? [])
            if (t.logicalObjectId === o.logicalObjectId) {
                const ref = o.sourceInstances.find(i => i.sceneId === t.fromSceneId)!;
                moves.push({ id: t.transitionId, sceneId: t.fromSceneId, targetId: ref.sourceNodeId, start: t.startFrame, end: t.startFrame + t.durationFrames, properties: ['x', 'y'], transition: t.transitionId, entrance: false });
            }
        for (const m of moves) {
            const r = select('inertialOvershoot', o.logicalObjectId, m.sceneId, m.start, m.entrance);
            if (!r || r.parameters.amplitude === 0)
                continue;
            const next = moves.filter(n => n.id !== m.id && n.start >= m.end).sort((a, b) => a.start - b.start)[0];
            const overlap = moves.some(n => n.id !== m.id && n.start < m.end && n.end > m.end && n.properties.some(p => m.properties.includes(p)));
            if (overlap)
                throw Error('RULE_OVERLAPPING_BASE_MOTIONS');
            const end = Math.min(m.end + Math.round((r.parameters.durationSeconds ?? 1) * fps), next?.start ?? Infinity, state.settings.durationFrames - 1, r.scope.endSeconds === undefined ? Infinity : Math.round(r.scope.endSeconds * fps));
            if (end <= m.end)
                continue; // A contiguous next movement has no post-motion interval to modify.
            for (const property of m.properties) {
                if (state.expressions.some(e => e.enabled && e.type === 'inertialOvershoot' && e.sourceAnimationId === m.id && e.property === property))
                    continue; // Existing source-bound inertia retains its ID and parameters on ADD.
                const expressionId = stable(["inertialOvershoot", o.logicalObjectId, m.id, property]);
                state.expressions.push({ expressionId, type: 'inertialOvershoot', sceneId: m.sceneId, targetId: m.targetId, property, startFrame: m.end, durationFrames: end - m.end, enabled: true, sourceAnimationId: m.id, ...(m.transition ? { transitionId: m.transition, ownership: { scope: 'transition' as const, logicalObjectId: o.logicalObjectId } } : {}), parameters: { amplitude: r.parameters.amplitude ?? .25, frequency: r.parameters.frequency ?? 2.5, decay: r.parameters.decay ?? 3, velocityLookbackFrames: Math.min(6, m.end - m.start), mode: 'ae', settlingEnvelope: 'smoothTail' } });
                state.ruleMaterializations.push({ ruleId: r.ruleId, entity: 'expression', id: expressionId });
            }
        }
        // A single logical owner composes across source instances and transitions.
        const boundaries = new Set([0, state.settings.durationFrames]);
        for (const r of rules.filter(r => r.effect === 'wiggle')) {
            if (r.scope.startSeconds !== undefined)
                boundaries.add(Math.max(0, Math.round(r.scope.startSeconds * fps)));
            if (r.scope.endSeconds !== undefined)
                boundaries.add(Math.min(state.settings.durationFrames, Math.round(r.scope.endSeconds * fps)));
        }
        const cuts = [...boundaries].sort((a, b) => a - b);
        for (let i = 0; i < cuts.length - 1; i++) {
            const start = cuts[i], end = cuts[i + 1];
            if (end <= start)
                continue;
            const r = winner(rules.filter(r => r.effect === 'wiggle' && matches(r, o.logicalObjectId, r.scope.sceneId ?? o.sourceInstances[0].sceneId, start, fps)));
            if (!r || r.parameters.amplitude === 0)
                continue;
            const ref = o.sourceInstances.find(s => !r.scope.sceneId || s.sceneId === r.scope.sceneId);
            if (!ref)
                continue;
            const property = r.parameters.property ?? 'rotation';
            if (state.expressions.some(e => e.enabled && e.type === 'wiggle' && e.property === property && e.startFrame < end && e.startFrame + e.durationFrames > start && (e.ownership?.logicalObjectId === o.logicalObjectId || logical(e.sceneId, e.targetId) === o.logicalObjectId)))
                throw Error('RULE_EXISTING_EFFECT_CONFLICT: existing wiggle');
            const expressionId = stable(["wiggle", o.logicalObjectId, r.scope.sceneId ?? "logical", start, property]);
            state.expressions.push({ expressionId, type: 'wiggle', sceneId: ref.sceneId, targetId: ref.sourceNodeId, property, startFrame: start, durationFrames: end - start, enabled: true, ownership: { scope: r.scope.sceneId ? 'sceneInstance' : 'logicalObject', logicalObjectId: o.logicalObjectId }, parameters: { amplitude: r.parameters.amplitude ?? 3, frequency: r.parameters.frequency ?? .8, seed: parseInt(stable(o.logicalObjectId).slice(5, 12), 16), temporalMode: 'continuous' } });
            state.ruleMaterializations.push({ ruleId: r.ruleId, entity: 'expression', id: expressionId });
        }
    }
}
export function compileSemanticEdit(project: LoadedProject, state: MotionState, edit: SemanticEdit, sourceText: string, fallbackLogicalId?: string): Plan['operations'] {
    const targetIds = edit.targets.length ? resolveRuleTargets(project, edit.targets) : edit.scope.logicalObjectIds.length ? resolveRuleTargets(project, edit.scope.logicalObjectIds) : edit.scope.selector === 'project' ? [] : fallbackLogicalId ? [fallbackLogicalId] : [];
    if (edit.scope.selector !== 'project' && !targetIds.length && !edit.ruleId)
        throw Error('RULE_EXPLICIT_SCOPE_REQUIRED');
    const objects = ruleObjects(project).filter(o=>targetIds.includes(o.logicalObjectId));
    const own=(scene:string,target:string)=>objects.some(o=>o.sourceInstances.some(i=>i.sceneId===scene&&i.sourceNodeId===target))&&(!edit.scope.sceneId||edit.scope.sceneId===scene);
    if(edit.expressionIds?.some(id=>!state.expressions?.some(e=>e.expressionId===id&&e.type===edit.effect&&own(e.sceneId,e.targetId))))throw Error('EDIT_TARGET_OUTSIDE_SCOPE');
    if(edit.expressionIds?.some(id=>state.ruleMaterializations?.some(m=>m.entity==='expression'&&m.id===id)))throw Error('RULE_OWNED_EFFECT: edit the scoped motion rule instead');
    const trackEdit=compileTrackEdit(state,edit,own);if(trackEdit)return trackEdit;
    if(edit.effectStorage==='expression'&&edit.operation==='ADD_EFFECT'){
      if(edit.effect!=='wiggle')throw Error('UNSUPPORTED_EFFECT_STORAGE: use the supported creation contract');
      return objects.flatMap(o=>{const ref=o.sourceInstances.find(i=>!edit.scope.sceneId||i.sceneId===edit.scope.sceneId);if(!ref)throw Error('EDIT_TARGET_OUTSIDE_SCOPE');return compileWiggle(project,state,{sceneId:ref.sceneId,kind:'objectAnimation',targetScope:edit.scope.sceneId?'instance':'logicalObject',target:{sourceNodeId:ref.sourceNodeId,logicalObjectId:o.logicalObjectId},timing:{startSeconds:null,anchorRequirementId:null,delaySeconds:0},parameters:{...edit.parameters,lifetime:edit.scope.sceneId?'scene':'project'}},0,state.settings.durationFrames);});
    }
    if(edit.operation==='MODIFY_DURATION'||edit.operation==='MODIFY_EASING') {
        const commands:Plan['operations']=[];
        for(const a of state.animations.filter(a=>own(a.sceneId,a.targetId)&&(!edit.animationIds||edit.animationIds.includes(a.animationId))&&(edit.scope.startSeconds===undefined||a.startFrame>=edit.scope.startSeconds*state.settings.fps)&&(edit.scope.endSeconds===undefined||a.startFrame<edit.scope.endSeconds*state.settings.fps)&&(edit.scope.phase!=='entrance'||entranceTrack(a)))) {
            const patch=edit.operation==='MODIFY_EASING'?{easing:edit.parameters.easing}:{durationFrames:Math.max(1,Math.round(edit.parameters.durationSeconds!==undefined?edit.parameters.durationSeconds*state.settings.fps:a.durationFrames*(edit.durationFactor??1)))};
            if(edit.operation==='MODIFY_EASING'&&!patch.easing)throw Error('EASING_REQUIRED');
            commands.push(...lowerMotionTool(project,state,{tool:'updateAnimation',animationId:a.animationId,patch}));
        }
        for(const t of (state.objectTransitions??[]).filter(t=>targetIds.includes(t.logicalObjectId)&&edit.scope.phase!=='entrance')) {
            const patch=edit.operation==='MODIFY_EASING'?{easing:edit.parameters.easing}:{durationFrames:Math.max(1,Math.round(edit.parameters.durationSeconds!==undefined?edit.parameters.durationSeconds*state.settings.fps:t.durationFrames*(edit.durationFactor??1)))};
            commands.push(...lowerMotionTool(project,state,{tool:'updateAnimation',animationId:t.transitionId,patch}));
        }
        if(!commands.length)throw Error('NO_MATCHING_EXISTING_ANIMATIONS');
        return commands;
    }
    if(edit.effect==='motion')throw Error('UNSUPPORTED_MOTION_EDIT');
    if(edit.operation==='ENABLE_EFFECT'||edit.operation==='DISABLE_EFFECT') {
        const enabled=edit.operation==='ENABLE_EFFECT';
        const owned=new Set(state.ruleMaterializations?.filter(m=>m.entity==='expression').map(m=>m.id));
        const ops:Plan['operations']=(state.expressions??[]).filter(e=>e.type===edit.effect&&own(e.sceneId,e.targetId)&&!owned.has(e.expressionId)).map(e=>({type:'setExpression',expression:{...e,enabled}}));
        for(const id of targetIds) {
            const applicable=(state.motionRules??[]).filter(r=>r.effect===edit.effect&&r.enabled&&!r.exceptions.includes(id)&&(!r.scope.logicalObjectIds.length||r.scope.logicalObjectIds.includes(id)));
            const r=winner(applicable);if(!r)continue;
            const scope={...r.scope,selector:'objects' as const,logicalObjectIds:[id]};
            const parameters=enabled?(r.disabledParameters??r.parameters):{...r.parameters,amplitude:0};
            ops.push({type:'setMotionRule',rule:{...r,ruleId:stable([edit.effect,scope,'apply']),scope,parameters,disabledParameters:enabled?undefined:(r.disabledParameters??r.parameters),priority:Math.max(0,...(state.motionRules??[]).map(r=>r.priority))+1,exceptions:[],sourceText}});
        }
        if(!ops.length)throw Error('NO_MATCHING_EXISTING_EFFECTS');return ops;
    }
    const excluded = resolveRuleTargets(project, edit.excludedTargets);
    const scope = { ...edit.scope, logicalObjectIds: targetIds };
    const rules = state.motionRules ?? [], existing = edit.ruleId ? rules.find(r => r.ruleId === edit.ruleId) : undefined;
    if (edit.ruleId && !existing)
        throw Error('RULE_NOT_FOUND');
    if (existing && existing.effect !== edit.effect)
        throw Error('RULE_EFFECT_MISMATCH');
    if (edit.operation === 'REMOVE_RULE') {
        if (!existing)
            throw Error('RULE_ID_REQUIRED');
        return [{ type: 'removeMotionRule', ruleId: existing.ruleId }];
    }
    if (edit.operation === 'ADD_EXCEPTION' || edit.operation === 'REMOVE_EXCEPTION') {
        if (!existing || !targetIds.length)
            throw Error('RULE_EXCEPTION_TARGET_REQUIRED');
        return [{ type: 'setMotionRule', rule: { ...existing, exceptions: edit.operation === 'ADD_EXCEPTION' ? [...new Set([...existing.exceptions, ...targetIds])] : existing.exceptions.filter(id => !targetIds.includes(id)) } }];
    }
    const modify = edit.operation === 'MODIFY_EFFECT' || edit.operation === 'MODIFY_RULE' || edit.operation === 'MODIFY_PARAMETER';
    const applicable = existing ? [existing] : rules.filter(r => r.effect === edit.effect && r.enabled && (!targetIds.length || targetIds.every(id => (!r.scope.logicalObjectIds.length || r.scope.logicalObjectIds.includes(id)) && !r.exceptions.includes(id)))).sort((a, b) => { const w = winner([a, b]); return w === a ? -1 : 1; });
    if (modify && !applicable.length) {
        // Existing direct effects are edited in place, preserving all other parameters/IDs.
        const selected = state.expressions?.filter(e => e.type === edit.effect && (!edit.expressionIds||edit.expressionIds.includes(e.expressionId)) && (!scope.sceneId || e.sceneId === scope.sceneId) && (scope.startSeconds === undefined || e.startFrame / state.settings.fps >= scope.startSeconds) && (scope.endSeconds === undefined || e.startFrame / state.settings.fps < scope.endSeconds) && (!targetIds.length || ruleObjects(project).some(o => targetIds.includes(o.logicalObjectId) && o.sourceInstances.some(i => i.sceneId === e.sceneId && i.sourceNodeId === e.targetId)))) ?? [];
        if (!selected.length)
            throw Error('NO_MATCHING_EXISTING_EFFECTS');
        return selected.map(e => ({ type: 'setExpression' as const, expression: { ...e, parameters: { ...e.parameters, ...edit.parameters, ...(edit.amplitudeFactor !== undefined ? { amplitude: e.parameters.amplitude * edit.amplitudeFactor } : {}),...(edit.frequencyFactor!==undefined&&'frequency' in e.parameters?{frequency:e.parameters.frequency*edit.frequencyFactor}:{}),...(edit.decayFactor!==undefined&&'decay' in e.parameters?{decay:e.parameters.decay*edit.decayFactor}:{}) } } as typeof e }));
    }
    if (modify && edit.amplitudeFactor !== undefined && !existing && !targetIds.length) {
        const ids = ruleObjects(project).filter(o => applicable.some(r => !r.exceptions.includes(o.logicalObjectId) && (!r.scope.logicalObjectIds.length || r.scope.logicalObjectIds.includes(o.logicalObjectId)))).map(o => o.logicalObjectId);
        if (!ids.length)
            throw Error('NO_MATCHING_EXISTING_EFFECTS');
        return ids.flatMap(id => compileSemanticEdit(project, state, { ...edit, targets: [id], scope: { ...scope, selector: 'objects', logicalObjectIds: [id] } }, sourceText, id));
    }
    if (modify && (edit.amplitudeFactor !== undefined || edit.frequencyFactor !== undefined) && targetIds.length > 1 && !existing)
        return targetIds.flatMap(id => compileSemanticEdit(project, state, { ...edit, targets: [id], scope: { ...scope, logicalObjectIds: [id] } }, sourceText, id));
    const priority = Math.max(0, ...rules.map(r => r.priority)) + 1;
    const parameters = { ...(modify ? applicable[0]?.parameters : {}), ...edit.parameters };
    if (edit.amplitudeFactor !== undefined) {
        parameters.amplitude = (applicable[0]?.parameters.amplitude ?? (edit.effect === 'wiggle' ? 3 : .25)) * edit.amplitudeFactor;
    }
    if(edit.frequencyFactor!==undefined) parameters.frequency=(applicable[0]?.parameters.frequency??(edit.effect==='wiggle'?.8:2.5))*edit.frequencyFactor;
    if(edit.decayFactor!==undefined){if(edit.effect!=='inertialOvershoot')throw Error('EFFECT_PARAMETER_UNSUPPORTED: decay');parameters.decay=(applicable[0]?.parameters.decay??3)*edit.decayFactor;}
    if (edit.operation === 'REMOVE_EFFECT')
        parameters.amplitude = 0;
    const rule = motionRuleSchema.parse({ ruleId: existing?.ruleId ?? stable([edit.effect, scope, edit.operation === 'REMOVE_EFFECT' ? 'exclude' : 'apply']), effect: edit.effect, scope: existing && edit.operation !== "MODIFY_RULE" ? existing.scope : scope, parameters, priority, sourceText, enabled: true, exceptions: excluded.length ? excluded : existing?.exceptions ?? [] });
    const ops: Plan['operations'] = [];
    if (modify && !existing && scope.phase === 'entrance')
        ops.push({ type: 'setMotionRule', rule: { ...rule, ruleId: stable([rule.ruleId, 'only-entrance']), scope: { ...scope, phase: 'all' }, parameters: { amplitude: 0 }, priority: priority - 1 } });
    if(edit.operation==='ADD_EFFECT'&&edit.effect==='inertialOvershoot'){
        // Reuse the rule materializer as a compiler, without persisting an implicit rule.
        // Plain ADD effects retain the ordinary expression lifecycle and dependent removal.
        const candidate=structuredClone(state);candidate.motionRules=[...(candidate.motionRules??[]),rule];materializeRules(candidate,project);
        const ids=new Set(state.expressions?.map(e=>e.expressionId));
        const created=(candidate.expressions??[]).filter(e=>!ids.has(e.expressionId));
        const retained=(state.expressions??[]).filter(e=>e.type==='inertialOvershoot'&&own(e.sceneId,e.targetId)&&!state.ruleMaterializations?.some(m=>m.entity==='expression'&&m.id===e.expressionId));
        return [...created,...retained].map(expression=>({type:'setExpression' as const,expression}));
    }
    ops.push({ type: 'setMotionRule', rule });
    if (edit.operation === 'REMOVE_EFFECT') {
        const objects = ruleObjects(project), own = (s: string, t: string) => objects.some(o => (!targetIds.length || targetIds.includes(o.logicalObjectId)) && !excluded.includes(o.logicalObjectId) && o.sourceInstances.some(i => i.sceneId === s && i.sourceNodeId === t)) && (!scope.sceneId || scope.sceneId === s);
        for (const e of state.expressions ?? [])
            if (e.type === edit.effect && own(e.sceneId, e.targetId) && (scope.startSeconds === undefined || e.startFrame / state.settings.fps >= scope.startSeconds) && (scope.endSeconds === undefined || e.startFrame / state.settings.fps < scope.endSeconds) && !state.ruleMaterializations?.some(m => m.entity === 'expression' && m.id === e.expressionId))
                ops.push({ type: 'removeExpression', expressionId: e.expressionId });
    }
    return ops;
}
