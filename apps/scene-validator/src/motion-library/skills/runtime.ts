import {statePresentation} from "../../motion/transitions.js";
import {inverse} from "../../motion/geometry.js";
import {evaluateAnimation} from "../../motion/evaluation.js";
import type {LoadedProject} from '../../types.js';import type {MotionState,Operation,Animation} from '../../motion/schema.js';
import {applyOperations} from '../../motion/operations.js';import {handoffCoverage} from '../../native/skill-coverage.js';import {skillApplicationSchema,type SkillApplication} from './contracts.js';import {offscreenDistance,transformedOffscreenVector} from '../../motion/intent/entrance.js';import {buildRegistry,resolveState} from '../../motion/registry.js';import {handoffContract} from './registry.js';
export function assertHandoffTargets(project:LoadedProject,a:SkillApplication){for(const ref of [a.outgoing,a.incoming]){const object=buildRegistry(project.inspection.document,project.inspection.fingerprint).objects.find(o=>o.sourceInstances.some(i=>i.sceneId===ref.sceneId&&i.sourceNodeId===ref.targetId));if(!object||resolveState(project.inspection.document,object,ref.sceneId).node.type!=='TEXT')throw Error('TEXT_HANDOFF_TARGET_NOT_TEXT');}if(a.outgoing.sceneId===a.incoming.sceneId&&a.outgoing.targetId===a.incoming.targetId)throw Error('TEXT_HANDOFF_DISTINCT_TARGETS_REQUIRED');}
export function handoffOperations(project:LoadedProject,input:{applicationId:string;outgoing:{sceneId:string;targetId:string};incoming:{sceneId:string;targetId:string};startFrame:number;durationFrames:number;overlapPolicy?:'avoid'|'allow'|'require';placement?:'reference'|'outgoingOrigin';fixedIncomingStart?:boolean;fixedOutgoingStart?:boolean;maxDelaySeconds?:number;easing?:Animation['easing'];direction?:'left'|'right'|'up'|'down'}){
 const effect=({left:'slideLeft',right:'slideRight',up:'slideUp',down:'slideDown'} as const)[input.direction??'left'];
 const ops:Operation[]=[],refs=[input.outgoing,input.incoming].map((r,i)=>({...r,animationIds:[`${input.applicationId}:${i}:position`,`${input.applicationId}:${i}:opacity`]}));
 const application=skillApplicationSchema.parse({placement:input.placement,placementResolved:input.placement!=="outgoingOrigin",fixedIncomingStart:input.fixedIncomingStart,fixedOutgoingStart:input.fixedOutgoingStart,maxDelaySeconds:input.maxDelaySeconds,skillId:handoffContract.id,version:handoffContract.version,outgoing:refs[0],incoming:refs[1],applicationId:input.applicationId,overlapPolicy:input.overlapPolicy??'avoid'});
 assertHandoffTargets(project,application);
 for(const [i,ref] of refs.entries()){
  const common={sceneId:ref.sceneId,targetId:ref.targetId,startFrame:input.startFrame,durationFrames:input.durationFrames,enabled:true,easing:input.easing??'easeInOutCubic'};
  const vector=transformedOffscreenVector(project,ref.sceneId,ref.targetId,effect,i===0?'out':'in');
  ops.push({type:'addAnimation',animation:{...common,animationId:ref.animationIds[0],effect,parameters:{...(vector?{vector}:{}),distance:vector?Math.hypot(vector.x,vector.y):offscreenDistance(project,ref.sceneId,ref.targetId,effect,i===0?'out':'in'),mode:i===0?'out':'in'}}});
  ops.push({type:'addAnimation',animation:{...common,animationId:ref.animationIds[1],effect:i===0?'fadeOut':'fadeIn',parameters:{from:i===0?1:0,to:i===0?0:1}}});
 }
 return [...ops,{type:'setSkillApplication',application} as Operation];
}
export async function prepareHandoff(project:LoadedProject,state:MotionState,application:SkillApplication,options:{signal?:AbortSignal;beforeRender?:()=>void;repair?:boolean}={}){
 assertHandoffTargets(project,application);
 const placementOps:Operation[]=[];
 if(application.placement==="outgoingOrigin"&&!application.placementResolved){
   if(!options.repair)throw Error("TEXT_HANDOFF_CONSTRAINT_CONFLICT: placement has not been compiled");
   const registry=buildRegistry(project.inspection.document,project.inspection.fingerprint),refs=statePresentation(project,state),owner=(ref:SkillApplication['incoming'])=>registry.objects.find(o=>o.sourceInstances.some(i=>i.sceneId===ref.sceneId&&i.sourceNodeId===ref.targetId))!;
   const from=refs[owner(application.outgoing).logicalObjectId][application.outgoing.sceneId],to=refs[owner(application.incoming).logicalObjectId][application.incoming.sceneId],inv=inverse(to.parentCanvas),dx=from.normalized[0][2]-to.normalized[0][2],dy=from.normalized[1][2]-to.normalized[1][2];
   const offset={x:inv[0][0]*dx+inv[0][1]*dy,y:inv[1][0]*dx+inv[1][1]*dy};let found=false;
   for(const a of state.animations.filter(a=>application.incoming.animationIds.includes(a.animationId)&&["slideUp","slideDown","slideLeft","slideRight","moveTo"].includes(a.effect))){if(a.text&&a.text.segmentation!=="block"&&(Math.abs(offset.x)>1e-8||Math.abs(offset.y)>1e-8))throw Error("TEXT_HANDOFF_CONSTRAINT_CONFLICT: segmented position placement requires reference-aligned text; block substitution is forbidden");const start=evaluateAnimation(a,a.startFrame),end=evaluateAnimation(a,a.startFrame+a.durationFrames);placementOps.push({type:"updateAnimation",animationId:a.animationId,animation:{...a,effect:"moveTo",text:undefined,parameters:{fromX:start.x??0,fromY:start.y??0,toX:(end.x??0)+offset.x,toY:(end.y??0)+offset.y}}});found=true;}
   if(!found)throw Error("TEXT_HANDOFF_CONSTRAINT_CONFLICT: replacement placement requires an incoming position track");
   application={...application,placementResolved:true};placementOps.push({type:"setSkillApplication",application});state=applyOperations(state,placementOps,project);
 }
 const before=await handoffCoverage(project,state,application,{...options,collectMasks:options.repair&&application.overlapPolicy==="avoid"&&!application.fixedIncomingStart});
 if(before.status==='PASSED')return {state,operations:placementOps,report:{skill:handoffContract.id,version:handoffContract.version,application,before,after:before,strategy:'unchanged',adjustments:[] as Operation[]}};
 if(!options.repair||application.overlapPolicy!=='avoid'||application.fixedIncomingStart||before.checks.some(c=>c.status==='FAILED'&&c.name!=='TEXT_HANDOFF_VISIBLE_COLLISION'))throw Object.assign(Error('TEXT_HANDOFF_CONSTRAINT_CONFLICT: '+before.checks.filter(c=>c.status==='FAILED').map(c=>c.name).join(', ')+`; incoming start locked=${application.fixedIncomingStart}; collision frames=${before.collisionFrames.slice(0,20).join(',')}`),{report:{application,before,reason:'Native collision or final-state constraint cannot be corrected within allowed scope'}});
 const incoming=state.animations.filter(a=>application.incoming.animationIds.includes(a.animationId));
 if(state.timingDependencies?.some(d=>application.incoming.animationIds.includes(d.animationId)||application.incoming.animationIds.includes(d.anchorAnimationId)))throw Object.assign(Error('TEXT_HANDOFF_CONSTRAINT_CONFLICT: explicit timing dependency'),{report:before});
 const fps=state.settings.fps,duration=Math.max(...state.animations.filter(a=>application.outgoing.animationIds.includes(a.animationId)).map(a=>a.durationFrames));
 const intersects=(a:Uint32Array,b:Uint32Array)=>{let i=0,j=0;while(i<a.length&&j<b.length){if(a[i]===b[j])return true;if(a[i]<b[j])i++;else j++;}return false;};
 const occupancy=new Map(before.coverage.map(m=>[m.frame,m]));let estimated:number|undefined;
 for(let delay=1;before.coverage.length>0&&delay<=Math.min(duration,Math.floor(application.maxDelaySeconds*fps));delay++){
  if(before.coverage.every(m=>{const prior=occupancy.get(m.frame-delay);return !prior||!intersects(m.outgoing,prior.incoming);})){estimated=delay;break;}
 }
 const choices=[...new Set([estimated,Math.min(duration,Math.floor(application.maxDelaySeconds*fps))].filter((d):d is number=>d!==undefined&&d>0&&d/fps<=application.maxDelaySeconds))];
 for(const delay of choices){
  const end=Math.max(...incoming.map(a=>a.startFrame+a.durationFrames))+delay;if(end>=state.settings.durationFrames)continue;
  const operations:Operation[]=incoming.map(a=>({type:'setStartFrame',animationId:a.animationId,startFrame:a.startFrame+delay}));
  for(const e of state.expressions??[])if('sourceAnimationId' in e&&application.incoming.animationIds.includes(e.sourceAnimationId))operations.push({type:'setExpression',expression:{...e,startFrame:e.startFrame+delay}});
  const updated={...application,adjustments:[...application.adjustments,...incoming.map(a=>({strategy:'temporal' as const,animationId:a.animationId,delaySeconds:delay/fps}))]};operations.push({type:'setSkillApplication',application:updated});
  const candidate=applyOperations(state,operations,project),after=await handoffCoverage(project,candidate,updated,options);
  if(after.status==='PASSED')return {state:candidate,operations:[...placementOps,...operations],report:{skill:handoffContract.id,version:handoffContract.version,application:updated,before,after,strategy:'temporal',adjustments:operations}};
 }
 throw Object.assign(Error('TEXT_HANDOFF_CONSTRAINT_CONFLICT: no safe bounded temporal candidate'),{report:{application,before,candidates:choices}});
}

export async function preparePlanSkills(project:LoadedProject,state:MotionState,plan:import('../../motion/intent/schema.js').IntentPlan,options:{signal?:AbortSignal;beforeRender?:()=>void}={}){
 const {requirementAnimations}=await import('../../motion/intent/compiler.js');let next=state;const operations:Operation[]=[],reports=[];
 for(const binding of plan.skillBindings??[]){
  const outgoing=plan.requirements.find(r=>r.requirementId===binding.outgoing),incoming=plan.requirements.find(r=>r.requirementId===binding.incoming);if(!outgoing||!incoming)throw Error('SKILL_REQUIREMENT_REFERENCE_MISSING');
  const ref=(r:typeof outgoing)=>({sceneId:r.sceneId!,targetId:r.target.sourceNodeId!,animationIds:requirementAnimations(next,r).map(a=>a.animationId)});
  const application=skillApplicationSchema.parse({applicationId:'handoff:'+binding.outgoing+':'+binding.incoming,skillId:binding.skillId,version:'2.0.0',outgoing:ref(outgoing),incoming:ref(incoming),maxDelaySeconds:binding.maxDelaySeconds,placement:binding.placement,placementResolved:binding.placement!=='outgoingOrigin',overlapPolicy:binding.overlapPolicy,fixedOutgoingStart:binding.fixedOutgoingStart||outgoing.timing.startSeconds!==null,fixedIncomingStart:binding.fixedIncomingStart||incoming.timing.startSeconds!==null});
  const set:Operation={type:'setSkillApplication',application};next=applyOperations(next,[set],project);operations.push(set);
  const prepared=await prepareSkill(project,next,application,{...options,repair:true});next=prepared.state;operations.push(...prepared.operations);reports.push(prepared.report);
 }
 return {state:next,operations,reports};
}

/** One executor entry per supported complex contract. New composites register
 * here and in the typed binding/schema registry, reusing engine operations. */
export const skillExecutors={'text.handoff.no-overlap':prepareHandoff};
export const prepareSkill=(...args:Parameters<typeof prepareHandoff>)=>skillExecutors[args[2].skillId](...args);
