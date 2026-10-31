import {z} from 'zod';
import {anchorChangeSchema} from './anchor-contract.js';
import {compileAnchorChange} from './anchor-edit.js';
import {readMotion,changeMotion} from './store.js';
import {applyOperations} from './operations.js';
import {renderNativeFrame} from '../native/client.js';
import {inverse} from './geometry.js';
import {transformPoint} from './anchor.js';
import type {LoadedProject} from '../types.js';
export async function commitAnchorChange(project:LoadedProject,input:unknown){
 const c=anchorChangeSchema.extend({expectedRevision:z.string()}).parse(input),doc=await readMotion(project);if(c.expectedRevision!==doc.revision)throw Error('STALE_PROJECT_REVISION');
 const {expectedRevision,...change}=c;
 if(change.space==='composition'){
  const rendered=await renderNativeFrame(project,doc.state,change.frame,{scale:.25,encoding:'rgba'});
  const {buildRegistry}=await import('./registry.js');const o=buildRegistry(project.inspection.document,project.inspection.fingerprint).objects.find(o=>o.logicalObjectId===change.logicalObjectId);const ref=o?.sourceInstances.find(i=>i.sceneId===change.sceneId),hit=rendered.hits.find(h=>h.sceneId===ref?.sceneId&&h.targetId===ref.sourceNodeId);
  if(!hit?.transform||!change.point)throw Error('ANCHOR_VISIBLE_TRANSFORM_REQUIRED');
  const point=transformPoint(inverse(hit.transform),change.point);change.point={units:'pixels',...point};change.space='local';
 }
 const operations=compileAnchorChange(project,doc.state,change);let candidate=applyOperations(doc.state,operations,project);
 if(change.preserveVisualPosition&&change.action!=='SET_TRANSFORM'){
  const {buildRegistry}=await import('./registry.js');const object=buildRegistry(project.inspection.document,project.inspection.fingerprint).objects.find(o=>o.logicalObjectId===change.logicalObjectId)!;const ref=object.sourceInstances.find(i=>i.sceneId===change.sceneId)!;
  const before=await renderNativeFrame(project,doc.state,change.frame,{scale:.25,encoding:'rgba'}),after=await renderNativeFrame(project,candidate,change.frame,{scale:.25,encoding:'rgba'});
  const a=before.hits.find(h=>h.sceneId===ref.sceneId&&h.targetId===ref.sourceNodeId),b=after.hits.find(h=>h.sceneId===ref.sceneId&&h.targetId===ref.sourceNodeId);
  if(!a?.transform||!b?.transform||!b.parentTransform)throw Error('ANCHOR_VISIBLE_TRANSFORM_REQUIRED');
  const inv=inverse(b.parentTransform),dx=a.transform[0][2]-b.transform[0][2],dy=a.transform[1][2]-b.transform[1][2],op=operations[0];
  if(op.type==='setAnchor'){op.anchor.compensation={x:(op.anchor.compensation?.x??0)+inv[0][0]*dx+inv[0][1]*dy,y:(op.anchor.compensation?.y??0)+inv[1][0]*dx+inv[1][1]*dy};candidate=applyOperations(doc.state,operations,project);}
  const final=await renderNativeFrame(project,candidate,change.frame,{scale:.25,encoding:'rgba'}),hit=final.hits.find(h=>h.sceneId===ref.sceneId&&h.targetId===ref.sourceNodeId);
  if(!hit||hit.points.some((p,i)=>Math.hypot(p.x-a.points[i].x,p.y-a.points[i].y)>1e-6))throw Error('ANCHOR_POSE_PRESERVATION_FAILED');
 }

 const frames=[...new Set([Math.max(0,change.frame-1),change.frame,Math.min(candidate.settings.durationFrames-1,change.frame+1)])];
 for(const frame of frames)await renderNativeFrame(project,candidate,frame,{scale:.25,encoding:'rgba'});
 const saved=await changeMotion(project.root,{expectedRevision,expectedSourceFingerprint:doc.sourceFingerprint,request:'Anchor: '+change.action,operations});
 return {...saved,anchorDiagnostics:{frames,providerCalls:0,preservation:change.preserveVisualPosition?'Fixed parent-space translation on all frames, computed at reference frame '+change.frame:'No position compensation',scope:change.scope}};
}
