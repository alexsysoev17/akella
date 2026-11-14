import {interpolateState,presentedTransitions,normalizationSize} from './transition-runtime.js';
import {transitionOffsetMatrix,poseScaleBasis} from './geometry.js';
import {anchorChangeSchema,type AnchorBinding} from './anchor-contract.js';
import {anchorBinding,anchorLocal,preserveAnchorOffset,transformPoint,anchoredMotion,motionTransform} from './anchor.js';
import {inverse,multiply,matrix,unit,canvasMatrix} from './geometry.js';
import {buildRegistry,resolveState} from './registry.js';
import {evaluateMotion} from './evaluation.js';
import {statePresentation} from './transitions.js';
import type {LoadedProject} from '../types.js';
import type {MotionState,Operation} from './schema.js';
export function compileAnchorChange(project:LoadedProject,state:MotionState,input:unknown):Operation[]{
 const c=anchorChangeSchema.parse(input),object=buildRegistry(project.inspection.document,project.inspection.fingerprint).objects.find(o=>o.logicalObjectId===c.logicalObjectId);
 if(!object||object.ambiguousScenes.includes(c.sceneId)||(c.scope==='object'&&object.ambiguousScenes.length))throw Error('ANCHOR_TARGET_AMBIGUOUS_OR_MISSING');
 const ref=resolveState(project.inspection.document,object,c.sceneId),local=multiply(inverse(ref.parentTransform),ref.transform),width=ref.width,height=ref.height;
 const old=anchorBinding(state.anchors,c.logicalObjectId,c.sceneId,c.frame,state.anchorDefault),scope={logicalObjectId:c.logicalObjectId,...(c.scope==='object'?{}:{sceneId:c.sceneId}),...(c.scope==='fromFrame'?{startFrame:c.frame}:{})};
 const exact=(state.anchors??[]).find(a=>a.logicalObjectId===scope.logicalObjectId&&a.sceneId===scope.sceneId&&a.startFrame===scope.startFrame),inherited=anchorBinding((state.anchors??[]).filter(a=>a!==exact&&(!scope.sceneId?!a.sceneId:!a.sceneId||a.sceneId===scope.sceneId&&(scope.startFrame===undefined?a.startFrame===undefined:a.startFrame===undefined||a.startFrame<scope.startFrame))),c.logicalObjectId,c.sceneId,c.frame,state.anchorDefault);
 if(c.action==='RESET_ANCHOR'&&!c.preserveVisualPosition){if(exact?.transform)return [{type:'setAnchor',anchor:{...scope,point:inherited?.point??{units:'pixels',x:0,y:0},transform:exact.transform,preservation:'none'}}];return [{type:'resetAnchor',...scope}];}
 let point=c.action==='CENTER_ANCHOR'?{units:'normalized' as const,x:.5,y:.5}:c.action==='RESET_ANCHOR'?(inherited?.point??{units:'pixels' as const,x:0,y:0}):c.point??old?.point;
 if(!point&&c.action!=='SET_TRANSFORM')throw Error('ANCHOR_POINT_REQUIRED');
 if(c.action==='SET_TRANSFORM'){if(!c.transform)throw Error('TRANSFORM_VALUES_REQUIRED');return [{type:'setAnchor',anchor:{...scope,point:point??{units:'normalized',x:.5,y:.5},transform:{...old?.transform,...c.transform},compensation:old?.compensation,preservation:old?.preservation??'none',referenceFrame:old?.referenceFrame}}];}
 if(c.space==='composition'){
  if((state.objectTransitions??[]).some(t=>t.logicalObjectId===c.logicalObjectId&&c.frame>=t.startFrame)||state.staticObjects?.some(o=>o.logicalObjectId===c.logicalObjectId))throw Error('ANCHOR_COMPOSITION_REQUIRES_RENDERED_TRANSFORM');
  const evaluation=evaluateMotion(state,c.frame,statePresentation(project,state)),registry=buildRegistry(project.inspection.document,project.inspection.fingerprint);let parent=unit,world=canvasMatrix(ref.scene,state.settings);
  for(const node of [...ref.ancestors,ref.node]){const m=multiply(inverse(parent),matrix(node.sceneTransform)),id=registry.objects.find(o=>o.sourceInstances.some(i=>i.sceneId===c.sceneId&&i.sourceNodeId===node.figmaNodeId))?.logicalObjectId??'',binding=anchorBinding(state.anchors,id,c.sceneId,c.frame,state.anchorDefault),v=evaluation.nodes[JSON.stringify([c.sceneId,node.figmaNodeId])]??{};world=multiply(world,multiply(anchoredMotion(v,m,binding,Number(node.properties.width??0),Number(node.properties.height??0)),m));parent=matrix(node.sceneTransform);}
  point={units:'pixels',...transformPoint(inverse(world),point!)};
 }

 if(!point)throw Error('ANCHOR_POINT_REQUIRED');
 if(c.action==='MOVE_ANCHOR'){const previous=anchorLocal(old,width,height);point={units:'pixels',x:previous.x+point.x*(point.units==='normalized'?width:1),y:previous.y+point.y*(point.units==='normalized'?height:1)};}
 const next:AnchorBinding={...scope,point,transform:old?.transform,preservation:c.preserveVisualPosition?'referenceFrameOffset':'none',...(c.preserveVisualPosition?{referenceFrame:c.frame}:{})};
 if(c.preserveVisualPosition){
  const transition=presentedTransitions(state,c.frame).find(t=>t.logicalObjectId===c.logicalObjectId);
  if(transition){
    const host=c.frame>=transition.startFrame+transition.durationFrames*transition.layerPolicy.switchProgress?transition.toSceneId:transition.fromSceneId;
    if(c.scope!=='object'&&host!==c.sceneId)throw Error('ANCHOR_PRESERVATION_SCOPE_CONFLICT');
    const withBinding=()=>({...state,anchors:[...(state.anchors??[]).filter(a=>!(a.logicalObjectId===next.logicalObjectId&&a.sceneId===next.sceneId&&a.startFrame===next.startFrame)),next]});
    const pose=(s:MotionState)=>{const presentation=statePresentation(project,s),refs=presentation[c.logicalObjectId],current=refs[host],v=interpolateState(refs[transition.fromSceneId],refs[transition.toSceneId],transition,c.frame,s),evaluation=evaluateMotion(s,c.frame,presentation),offset=evaluation.transitionEffects[transition.transitionId]??{},visual=transitionOffsetMatrix(v.matrix,offset,v.anchor?transformPoint(v.matrix,v.anchor):undefined,poseScaleBasis(transition.easing)),base=multiply(multiply(inverse(current.parentCanvas),visual),[[1/normalizationSize(current).width,0,0],[0,1/normalizationSize(current).height,0]]),binding=anchorBinding(s.anchors,c.logicalObjectId,host,c.frame,s.anchorDefault);
      if(c.frame>=transition.startFrame+transition.durationFrames)return multiply(anchoredMotion(evaluation.nodes[JSON.stringify([host,current.sourceNodeId])]??{},current.local,binding,current.width,current.height),base);
      const pivot=v.anchor?{x:v.anchor.x*normalizationSize(current).width,y:v.anchor.y*normalizationSize(current).height}:anchorLocal(binding,current.width,current.height);return multiply(motionTransform(binding?.transform??{},transformPoint(base,pivot),binding?.compensation),base);
    };
    const a=pose(state),b=pose(withBinding());next.compensation={x:(next.compensation?.x??0)+a[0][2]-b[0][2],y:(next.compensation?.y??0)+a[1][2]-b[1][2]};const final=pose(withBinding());if(final.flat().some((n,i)=>Math.abs(n-a.flat()[i])>1e-6))throw Error('ANCHOR_PRESERVATION_SCOPE_CONFLICT');
  }else{const v=evaluateMotion(state,c.frame,statePresentation(project,state)).nodes[JSON.stringify([c.sceneId,ref.sourceNodeId])]??{};next.compensation=preserveAnchorOffset(v,local,old,next,width,height);}
 }
 return [{type:'setAnchor',anchor:next}];
}
