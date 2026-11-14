import {z} from 'zod';
import {semanticEditSchema} from './rule-contract.js';
/** Wire delta for effect edits only. Lowered through the existing SemanticEdit/compiler. */
const effect=z.enum(['inertialOvershoot','wiggle']);
const id=z.string().min(1).max(180);
export const incrementalEffectEditSchema=semanticEditSchema.pick({operation:true,effect:true,targets:true,excludedTargets:true,scope:true,parameters:true,ruleId:true,amplitudeFactor:true,frequencyFactor:true,decayFactor:true,durationFactor:true,expressionIds:true,animationIds:true,effectStorage:true}).extend({effect,operation:z.enum(['ADD_EFFECT','MODIFY_EFFECT','REMOVE_EFFECT','ENABLE_EFFECT','DISABLE_EFFECT','MODIFY_PARAMETER','MODIFY_DURATION','ADD_RULE','MODIFY_RULE','REMOVE_RULE','ADD_EXCEPTION','REMOVE_EXCEPTION'])});
const query=z.object({kind:z.enum(['inspectObject','inspectAnimations','inspectDependencies','inspectExpressions','inspectMotionRules','inspectSceneStates']),logicalObjectId:id}).strict();
export const incrementalMotionPatchSchema=z.object({result:z.discriminatedUnion('kind',[
 z.object({kind:z.literal('PATCH'),edits:z.array(incrementalEffectEditSchema).min(1).max(20)}).strict(),
 z.object({kind:z.literal('NO_OP'),effect,targets:z.array(id).min(1).max(200),expressionIds:z.array(id).min(1).max(1000)}).strict(),
 z.object({kind:z.literal('QUERY'),queries:z.array(query).min(1).max(6)}).strict(),
]),assumptions:z.array(z.string().max(2000)).max(20)}).strict();
export type IncrementalMotionPatch=z.infer<typeof incrementalMotionPatchSchema>;
export function effectPatchContext(context:unknown){const c=context as {incrementalEffect?:string;skill?:{effect:string}[]};return ['inertialOvershoot','wiggle'].includes(c.incrementalEffect??c.skill?.[0]?.effect??'');}
/** NO_OP is a proposal, not proof: IDs must still exist and canonical ADD checks all movements. */
export function lowerIncrementalPatch(patch:IncrementalMotionPatch,context:unknown){
 const result=patch.result;
 if(result.kind==='PATCH')return {edits:result.edits.map(e=>semanticEditSchema.parse(e)),assumptions:patch.assumptions};
 if(result.kind==='QUERY')return {edits:[],queries:result.queries,assumptions:patch.assumptions};
 const c=context as {userRequest?:string;objectIndex:{logicalObjectId:string;sourceInstances:{sceneId:string;sourceNodeId:string}[]}[];effectState:{expressions:{expressionId:string;type:string;enabled:boolean;sceneId:string;targetId:string;ownership?:{logicalObjectId?:string}}[]};skill:{effect:string}[]};
 if(!/^(?:добавь|добавить|добавьте|add)\s/iu.test(c.userRequest??'')||/уменьш|увелич|измени|вдвое|амплитуд|частот|слабее|сильнее|только|сцен|исключ|кроме|секунд|кадр|появлен|появля/iu.test(c.userRequest??''))throw Error('INCREMENTAL_NO_OP_REQUIRES_ENSURE_INTENT');
 if(c.objectIndex.some(o=>!result.targets.includes(o.logicalObjectId)))throw Error('INCREMENTAL_NO_OP_TARGET_COVERAGE');
 if(!c.skill.some(s=>s.effect===result.effect)||result.targets.some(id=>!c.objectIndex.some(o=>o.logicalObjectId===id)))throw Error('INCREMENTAL_SCOPE_VIOLATION');
 const evidence=result.expressionIds.map(id=>c.effectState.expressions.find(e=>e.expressionId===id));
 const owns=(e:NonNullable<typeof evidence[number]>,id:string)=>e.ownership?.logicalObjectId===id||c.objectIndex.find(o=>o.logicalObjectId===id)?.sourceInstances.some(i=>i.sceneId===e.sceneId&&i.sourceNodeId===e.targetId);
 if(evidence.some(e=>!e||!e.enabled||e.type!==result.effect||!result.targets.some(id=>owns(e,id)))||result.targets.some(id=>!evidence.some(e=>e&&owns(e,id))))throw Error('INCREMENTAL_NO_OP_EVIDENCE_STALE');
 return {edits:[semanticEditSchema.parse({operation:'ADD_EFFECT',effect:result.effect,targets:result.targets,scope:{selector:'objects'},parameters:{}})],assumptions:[...patch.assumptions,'NO_OP proposal verified against current IDs; canonical ADD still checks complete movement coverage.']};
}
export const incrementalPatchInstructions=`Return IncrementalMotionPatch only: result.kind=PATCH with nonempty edits; QUERY with bounded read-only queries; or NO_OP with actual target logical IDs, effect and existing enabled expression IDs. NEVER return an empty PATCH or replace it with prose assumptions. ADD_EFFECT is idempotent: return ADD_EFFECT even if some/all source-bound effects already exist; the compiler preserves them and creates missing movement tails. NO_OP is checked against current state and compiled as an idempotent ensure, not blindly trusted. Use only the admitted effect and targets. NO_OP is only for an unqualified ADD/ensure; explicit scene/time/entrance scopes and parameter modifications require PATCH. Do not recreate base animation or omit requested parameter changes. No full semantic graph, coverage rows, scene plan, keyframes or raw operations are required.`;
