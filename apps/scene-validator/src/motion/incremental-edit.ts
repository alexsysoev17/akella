import { z } from 'zod';
import type { LoadedProject } from '../types.js';
import type { MotionDocument } from './store.js';
import { ruleObjects } from './rules.js';
import { objectMentionRanges } from './object-aliases.js';
import { semanticEditSchema, type SemanticEdit } from './rule-contract.js';
import { normalizeSemanticGraph } from './intent/graph.js';
import { ruleSkills } from '../motion-library/skills/rule-skills.js';

// Context routing only; unfamiliar language remains the existing provider's responsibility.
export function incrementalEditProfile(project: LoadedProject, request: string) {
  if (request.length > 1600 || /сцен|scene|появ|уход|перемест|trim|фейд|fade|easing|изинг|после|затем|длитель|быстр|медлен|секунд|кадр|duration|frame|second/iu.test(request)) return null;
  if (/wiggle|покач/iu.test(request) && /инерц|колеб/iu.test(request)) return null;
  const effect = /wiggle|покач|покачив/iu.test(request) ? 'wiggle' : /инерц|колеб/iu.test(request) ? 'inertialOvershoot' : null;
  if (!effect || !/добав|убер|удал|измени|слаб|силь|амплитуд|частот|add|remove|update/iu.test(request)) return null;
  const objects = ruleObjects(project).filter(o => objectMentionRanges(o.name, request).length);
  if (!objects.length || objects.some(o => o.ambiguousScenes.length)) return null;
  return { effect, objects };
}
export const incrementalEditSchema = z.object({ edits: z.array(semanticEditSchema).min(1).max(20), assumptions: z.array(z.string()).max(20) }).strict();
export const incrementalEditInstructions = `Interpret this local motion-effect edit, retaining every requested modifier. Return typed semantic edits only. Use actual supplied logical object IDs, never invent identities. ADD_EFFECT adds an effect; MODIFY_EFFECT updates existing parameters; REMOVE_EFFECT removes only that effect. Rule modifications use actual supplied rule IDs. Scope must remain within admitted objects; never expand to project. Wiggle is continuous smooth seeded motion, rotation by default, amplitude 3 degrees and frequency .8 Hz unless requested otherwise. Existing parameters and base animations remain unchanged when editing. Inertia requires real base movement. Unknown identity or unsupported instructions must not be guessed. No new base animation, scene timing or geometry in this contract.`;
export function incrementalContext(project: LoadedProject, doc: MotionDocument, request: string, profile: NonNullable<ReturnType<typeof incrementalEditProfile>>) {
  const ids = new Set(profile.objects.map(o => o.logicalObjectId));
  const owns = (scene: string, target: string) => profile.objects.some(o => o.sourceInstances.some(i => i.sceneId === scene && i.sourceNodeId === target));
  return {
    incrementalEditHint: true,
    project: {projectId: project.config.projectId, fps: doc.state.settings.fps, durationFrames: doc.state.settings.durationFrames},
    projectRevision: doc.revision,
    userRequest: request,
    objectIndex: profile.objects.map(o => ({logicalObjectId:o.logicalObjectId, name:o.name, sourceInstances:o.sourceInstances})),
    // No geometry, full graph, unrelated history or implementation snippets.
    effectState: {
      expressions: (doc.state.expressions ?? []).filter(e => e.type === profile.effect && (e.ownership?.logicalObjectId ? ids.has(e.ownership.logicalObjectId) : owns(e.sceneId,e.targetId))),
      rules: (doc.state.motionRules ?? []).filter(r => r.effect === profile.effect && (!r.scope.logicalObjectIds.length || r.scope.logicalObjectIds.some(id => ids.has(id)))),
      ...(profile.effect === 'inertialOvershoot' ? {
        animations: doc.state.animations.filter(a => owns(a.sceneId,a.targetId)),
        transitions: (doc.state.objectTransitions ?? []).filter(t => ids.has(t.logicalObjectId)),
      } : {}),
    },
    skill: ruleSkills.filter(s => s.id === (profile.effect === 'wiggle' ? 'motion.continuous-wiggle' : 'motion.inertia-after-movement')).map(({id,version,description,defaults,constraints}) => ({id,version,effect:profile.effect,description,defaults,constraints})),
    constraints: {allowedLogicalObjectIds:[...ids], preserveBaseAnimations:true, preserveOtherEffects:true},
  };
}
/** Closed, fully consumed grammar only. Any extra modifier/unknown target falls back to semantic interpretation. */
export function deterministicIncrementalEdit(project: LoadedProject, request: string): SemanticEdit | null {
  const profile = incrementalEditProfile(project, request);
  if (!profile || profile.effect !== 'wiggle') return null;
  const chars = request.split('');
  for (const o of profile.objects) for (const range of objectMentionRanges(o.name, request)) chars.fill(' ', range.start, range.end);
  const rest = chars.join('').toLowerCase().replace(/[,.!—–-]/g,' ').replace(/\s+/g,' ').trim();
  let operation: SemanticEdit['operation'];
  let amplitudeFactor: number | undefined;
  if (/^(?:добавь|добавить)\s+(?:(?:на|к|у|объектам|объекты|и)\s+)*(?:эффект\s+)?(?:постоянного\s+покачивания|постоянное\s+покачивание|постоянный\s+wiggle)$/u.test(rest)) operation='ADD_EFFECT';
  else if (/^(?:убери|удали)\s+(?:wiggle|покачивание|покачивания)(?:\s+(?:только|у|и))*$/u.test(rest)) operation='REMOVE_EFFECT';
  else if (/^(?:сделай|уменьши)\s+(?:wiggle|покачивание|покачивания|амплитуду)(?:\s+у)?\s+(?:вдвое|в два раза)\s+слабее$/u.test(rest)) {operation='MODIFY_EFFECT';amplitudeFactor=.5;}
  else return null;
  return semanticEditSchema.parse({operation,effect:'wiggle',targets:profile.objects.map(o=>o.logicalObjectId),scope:{selector:'objects',phase:'all'},parameters:{},...(amplitudeFactor?{amplitudeFactor}:{})});
}
export function incrementalGraphContext(context: unknown) {
  const c=context as ReturnType<typeof incrementalContext>;
  return {...c,objectIndex:c.objectIndex.flatMap(o=>o.sourceInstances.map(i=>({...i,name:o.name})))};
}
export function incrementalPlan(request: string, edits: SemanticEdit[], context: unknown, assumptions: string[] = []) {
  const c = context as ReturnType<typeof incrementalContext>;
  const admitted = new Set(c.objectIndex.map(o=>o.logicalObjectId));
  for (const edit of edits) {
    if (edit.scope.selector === 'project' || !edit.targets.length || [...edit.targets,...edit.excludedTargets,...edit.scope.logicalObjectIds].some(id=>!admitted.has(id))) throw Error('INCREMENTAL_SCOPE_VIOLATION');
    if (!c.skill.some(s=>s.effect===edit.effect)) throw Error('INCREMENTAL_EFFECT_NOT_ADMITTED');
    if (edit.ruleId) {
      const rule=c.effectState.rules.find(r=>r.ruleId===edit.ruleId);
      if (!rule || rule.scope.selector==='project' || rule.scope.logicalObjectIds.some(id=>!admitted.has(id))) throw Error('INCREMENTAL_RULE_NOT_ADMITTED: editing a broader rule requires explicit wider admission');
    }
  }
  return normalizeSemanticGraph({schemaVersion:'semantic-graph/1.0',clauses:[{clauseId:'edit',text:request}],actions:edits.map((edit,i)=>({actionId:'edit_'+i,clauseId:'edit',kind:'editAnimation',scene:c.objectIndex.find(o=>o.logicalObjectId===edit.targets[0])!.sourceInstances[0].sceneId,constraints:[],unresolvedReason:null,targets:[c.objectIndex.find(o=>o.logicalObjectId===edit.targets[0])!.sourceInstances[0].sourceNodeId],techniques:[edit.effect === 'easing' ? 'customCurve' : edit.effect === 'fade' ? 'fadeIn' : edit.effect],relation:'unchanged',parameters:[],semanticEdit:edit})),assumptions},incrementalGraphContext(context),request);
}
