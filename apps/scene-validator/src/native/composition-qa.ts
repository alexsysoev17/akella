import type {LoadedProject} from '../types.js';
import type {MotionState} from '../motion/schema.js';
import type {NativeFrame} from './renderer.js';
import type {Check} from '../motion/qa/numeric.js';
import {statePresentation} from '../motion/transitions.js';
import {interpolateState} from '../motion/transition-runtime.js';
import {buildRegistry} from '../motion/registry.js';
import {renderNativeFrame} from './client.js';
import {atomicJson,safeDirectory} from '../files.js';
import path from 'node:path';
export function compositionFrameChecks(project:LoadedProject,state:MotionState,frame:NativeFrame):Check[]{
 const c=frame.composition;if(!c)return [{name:'compositionTrace',category:'render',status:'FAILED',reason:'Actual native frame diagnostic trace missing'}];
 const checks:Check[]=frame.warnings.filter(w=>w.startsWith("COMPOSITION_ROOT_ISOLATION_REQUIRES_REVIEW")).map(reason=>({name:"sceneRootIsolation",category:"render",status:"WARNING",reason})),refs=statePresentation(project,state),registry=buildRegistry(project.inspection.document,project.inspection.fingerprint);
 for(const scene of c.activeScenes){
  const incoming=(state.objectTransitions??[]).filter(t=>t.timelinePolicy==="referenceStates"&&t.toSceneId===scene.sceneId);
  if(incoming.length&&incoming.every(t=>frame.frame<t.startFrame))checks.push({name:'prematureSceneSwitch',category:'render',status:'FAILED',target:scene.sceneId,metrics:{frame:frame.frame,incoming:incoming.map(t=>t.startFrame)}});
 }
 for(const t of c.transitions){
  const transition=state.objectTransitions!.find(x=>x.transitionId===t.transitionId)!;
  const owner=registry.objects.find(o=>o.logicalObjectId===t.logicalObjectId)!;
  const expected=refs[t.logicalObjectId]?.[t.hostSceneId];if(!expected)continue;
  const instances=c.instances.filter(i=>i.logicalObjectId===t.logicalObjectId&&i.visible);
  const rendered=instances.find(i=>i.sceneId===t.hostSceneId&&i.targetId===expected.sourceNodeId);
  const intendedVisible=expected.visible&&expected.opacity>0;
  // A requested post-arrival fade/scale/visibility edit remains legitimate.
  const hasInstanceEdit=state.animations.some(a=>a.enabled&&a.sceneId===t.hostSceneId&&a.targetId===expected.sourceNodeId&&frame.frame>=a.startFrame);
  const required=intendedVisible&&!hasInstanceEdit;
  checks.push({name:'logicalObjectContinuity',category:'render',target:owner.name,status:required&&!rendered?'FAILED':'PASSED',reason:required&&!rendered?`Frame ${frame.frame}: missing ${t.hostSceneId}/${expected.sourceNodeId}`:undefined,metrics:{frame:frame.frame,transitionId:t.transitionId,instanceCount:instances.length}});
  if(instances.length>1)checks.push({name:'duplicateLogicalObject',category:'render',target:owner.name,status:'FAILED',metrics:{frame:frame.frame,instances}});
  if(rendered?.transform){
   const a=rendered.transform;const points=[[0,0],[expected.width,0],[0,expected.height],[expected.width,expected.height]].map(([x,y])=>({x:a[0][0]*x+a[0][1]*y+a[0][2],y:a[1][0]*x+a[1][1]*y+a[1][2]}));
   const cover=c.instances.find(i=>i.opaqueCover&&i.sceneId!==rendered.sceneId&&(i.zOrder??-1)>(rendered.zOrder??Infinity)&&i.transform&&Math.abs(i.transform[0][1])<1e-9&&Math.abs(i.transform[1][0])<1e-9&&(()=>{const hit=frame.hits.find(h=>h.sceneId===i.sceneId&&h.targetId===i.targetId);if(!hit)return false;return points.every(p=>p.x>=Math.min(...hit.points.map(p=>p.x))&&p.x<=Math.max(...hit.points.map(p=>p.x))&&p.y>=Math.min(...hit.points.map(p=>p.y))&&p.y<=Math.max(...hit.points.map(p=>p.y)));})());
   checks.push({name:'foreignSceneOcclusion',category:'render',target:owner.name,status:cover?'FAILED':'PASSED',metrics:{frame:frame.frame,cover:cover?.targetId}});
   if(t.active){
    const desired=interpolateState(refs[t.logicalObjectId][t.fromSceneId],refs[t.logicalObjectId][t.toSceneId],transition,frame.frame);
    // Transition-bound expressions legitimately displace the interpolated pose.
    const procedural=state.expressions?.some(e=>e.enabled&&(e.transitionId===t.transitionId||e.ownership?.logicalObjectId===t.logicalObjectId));
    if(!procedural){const error=Math.hypot(a[0][2]-desired.matrix[0][2],a[1][2]-desired.matrix[1][2]);checks.push({name:'transitionPoseContinuity',category:'render',target:owner.name,status:error<1e-5?'PASSED':'FAILED',metrics:{frame:frame.frame,error}});}
   }
  }
 }
 return checks;
}
/** Bounded whole-composition boundary pass. No LLM/video export. Intentional
 * layer switches and explicit instance edits are not universal jump failures. */
export async function compositionQA(project:LoadedProject,state:MotionState,directory:string,options:{beforeRender?:()=>void;signal?:AbortSignal;frames?:number[];maxFrames?:number}={}){
 const edges=[...state.blocks.map(b=>b.startFrame),...(state.objectTransitions??[]).flatMap(t=>[t.startFrame,t.startFrame+t.durationFrames*t.layerPolicy.switchProgress,t.startFrame+t.durationFrames])];
 const all=[...new Set(options.frames??[0,state.settings.durationFrames-1,...edges.flatMap(f=>[Math.ceil(f)-1,Math.ceil(f)])])].filter(f=>f>=0&&f<state.settings.durationFrames).sort((a,b)=>a-b);
 const selected=all.slice(0,options.maxFrames??128),checks:Check[]=[],samples=[];
 for(const f of selected){options.signal?.throwIfAborted();options.beforeRender?.();const rendered=await renderNativeFrame(project,state,f,{scale:.25,diagnostics:true,signal:options.signal});checks.push(...compositionFrameChecks(project,state,rendered));samples.push({frame:f,composition:rendered.composition});}
 if(selected.length<all.length)checks.push({name:'compositionCoverage',category:'render',status:'NOT_TESTED',reason:`Only ${selected.length}/${all.length} requested frames rendered`});
 const report={status:checks.some(c=>c.status==='FAILED')?'FAILED':selected.length<all.length||checks.some(c=>c.status==='WARNING')?'WARNING':'PASSED',scope:'native full-composition boundary samples; arbitrary occlusion/artistic quality NOT_TESTED',frames:selected,checks,samples};
 await atomicJson(path.join(await safeDirectory(project.root,directory),'report.json'),report);return report;
}

export function compareFrameComposition(a:NativeFrame,b:NativeFrame){
 const ids=new Set([...(a.composition?.instances??[]),...(b.composition?.instances??[])].map(i=>i.logicalObjectId).filter((id):id is string=>!!id));
 return [...ids].flatMap(id=>{const before=a.composition?.instances.filter(i=>i.logicalObjectId===id&&i.visible)??[],after=b.composition?.instances.filter(i=>i.logicalObjectId===id&&i.visible)??[];return JSON.stringify(before)===JSON.stringify(after)?[]:[{logicalObjectId:id,before,after}];});
}
