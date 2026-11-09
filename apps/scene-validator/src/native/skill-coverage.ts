import {statePresentation} from "../motion/transitions.js";
import type {LoadedProject} from '../types.js';import type {MotionState} from '../motion/schema.js';import type {SkillApplication} from '../motion-library/skills/contracts.js';
import {renderNativeFrame} from './client.js';import {buildRegistry} from '../motion/registry.js';import {handoffContract} from '../motion-library/skills/registry.js';
export async function handoffCoverage(project:LoadedProject,state:MotionState,application:SkillApplication,options:{signal?:AbortSignal;beforeRender?:()=>void;collectMasks?:boolean;maxMaskBytes?:number}={}){
 const groups=[application.outgoing,application.incoming].map(ref=>{const object=buildRegistry(project.inspection.document,project.inspection.fingerprint).objects.find(o=>o.sourceInstances.some(i=>i.sceneId===ref.sceneId&&i.sourceNodeId===ref.targetId));return object?.sourceInstances.map(i=>({sceneId:i.sceneId,targetId:i.sourceNodeId}))??[ref];});
 const tracks=[application.outgoing,application.incoming].map(ref=>ref.animationIds.map(id=>{const a=state.animations.find(a=>a.animationId===id&&a.enabled);if(!a||a.sceneId!==ref.sceneId||a.targetId!==ref.targetId)throw Error('TEXT_HANDOFF_ANIMATION_MISSING: '+id);return a;}));
 const start=Math.min(...tracks.flat().map(a=>a.startFrame)),end=Math.max(...tracks.flat().map(a=>a.startFrame+a.durationFrames));
 if(end-start>state.settings.fps*handoffContract.defaults.maxIntervalSeconds)throw Error('TEXT_HANDOFF_COVERAGE_BUDGET: maximum5second skill interval');
 if(start<0||end>=state.settings.durationFrames)throw Error('TEXT_HANDOFF_TIMING_VALID: handoff must fit output including its final pose');
 const masks:{frame:number;outgoing:Uint32Array;incoming:Uint32Array}[]=[];
 const samples=[];let maxEmpty=0,empty=0,maskBytes=0,maskBudgetExceeded=false;
 for(let frame=start;frame<=end;frame++){
  options.signal?.throwIfAborted();const images=[];
  for(let i=0;i<2;i++){options.beforeRender?.();images.push(await renderNativeFrame(project,state,frame,{encoding:'rgba',coverageProbe:{focus:groups[i],ignore:groups[1-i]},signal:options.signal}));}
  const threshold=Math.round(handoffContract.defaults.alphaThreshold*255);
  const occupied=images.map(image=>{const pixels:number[]=[],region=image.coverageRegion;for(let i=0;i<image.png.length;i+=4)if(image.png[i]*image.png[i+3]/255>=threshold){const local=i/4;pixels.push(region?(region.y+Math.floor(local/region.width))*region.canvasWidth+region.x+local%region.width:local);}return Uint32Array.from(pixels);});
  const outgoingPixels=occupied[0].length,incomingPixels=occupied[1].length;let collisionPixels=0,i=0,j=0;
  while(i<outgoingPixels&&j<incomingPixels){if(occupied[0][i]===occupied[1][j]){collisionPixels++;i++;j++;}else if(occupied[0][i]<occupied[1][j])i++;else j++;}
  if(options.collectMasks&&!maskBudgetExceeded){maskBytes+=occupied[0].byteLength+occupied[1].byteLength;if(maskBytes>(options.maxMaskBytes??handoffContract.defaults.maxSparseMaskBytes)){masks.length=0;maskBudgetExceeded=true;}else masks.push({frame,outgoing:occupied[0],incoming:occupied[1]});}
  empty=outgoingPixels+incomingPixels===0?empty+1:0;maxEmpty=Math.max(maxEmpty,empty);
  samples.push({frame,collisionPixels,outgoingPixels,incomingPixels,poses:images.map(image=>image.hits.filter(h=>groups.some(g=>g.some(r=>r.sceneId===h.sceneId&&r.targetId===h.targetId))))});
 }
 const collisions=samples.filter(s=>s.collisionPixels>=handoffContract.defaults.minimumCollisionPixels),last=samples.at(-1)!,first=samples[0];
 const owner=buildRegistry(project.inspection.document,project.inspection.fingerprint).objects.find(o=>o.sourceInstances.some(i=>i.sceneId===application.incoming.sceneId&&i.sourceNodeId===application.incoming.targetId));
 const finalHit=last.poses[1].find(h=>groups[1].some(r=>r.sceneId===h.sceneId&&r.targetId===h.targetId));
 const target=owner&&finalHit?statePresentation(project,state)[owner.logicalObjectId]?.[finalHit.sceneId]:undefined;
 const outOwner=buildRegistry(project.inspection.document,project.inspection.fingerprint).objects.find(o=>o.sourceInstances.some(i=>i.sceneId===application.outgoing.sceneId&&i.sourceNodeId===application.outgoing.targetId));
 const outPose=outOwner?statePresentation(project,state)[outOwner.logicalObjectId]?.[application.outgoing.sceneId]:undefined;
 const translation=application.placement==='outgoingOrigin'&&outPose?{x:outPose.normalized[0][2],y:outPose.normalized[1][2]}:{x:target?.normalized[0][2]??0,y:target?.normalized[1][2]??0};
 const targetError=target&&finalHit?Math.max(...[[0,0],[1,0],[1,1],[0,1]].map(([x,y],i)=>Math.hypot(finalHit.points[i].x-(target.normalized[0][0]*x+target.normalized[0][1]*y+translation.x),finalHit.points[i].y-(target.normalized[1][0]*x+target.normalized[1][1]*y+translation.y)))):Infinity;
 const check=(name:string,ok:boolean,reason?:string)=>({name,status:ok?'PASSED' as const:'FAILED' as const,category:'render' as const,reason});
 const policy=application.overlapPolicy;
 const checks=[check('TEXT_HANDOFF_VISIBLE_COLLISION',policy!=='avoid'||!collisions.length),check('TEXT_HANDOFF_OVERLAP_POLICY',policy!=='require'||collisions.length>0),check('TEXT_HANDOFF_TARGET_REACHED',last.incomingPixels>0&&targetError<1e-5,'Final incoming reference-pose error='+targetError),check('TEXT_HANDOFF_FINAL_STATE',last.incomingPixels>0&&last.outgoingPixels===0),check('TEXT_HANDOFF_TIMING_VALID',true),check('TEXT_HANDOFF_CONTINUITY',first.outgoingPixels>0&&last.incomingPixels>0&&samples.every(s=>s.poses.flat().every(h=>h.points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)))),'Source initially visible, replacement finally visible, all evaluated poses finite; deliberate temporal gaps remain permitted')];
 const report={applicationId:application.applicationId,skillId:application.skillId,status:checks.some(c=>c.status==='FAILED')?'FAILED' as const:'PASSED' as const,policy,checks,samples,collisionFrames:collisions.map(s=>s.frame),maxEmptyFrames:maxEmpty,maskBudgetExceeded,scope:'actual native glyph contribution; black nonparticipant occluders, other handoff text ignored per probe; whole-frame complex blends inherit renderer limits'};
 return Object.defineProperty(report,'coverage',{value:masks,enumerable:false}) as typeof report & {coverage:typeof masks};
}
