import type {SemanticEdit} from './rule-contract.js';
import type {MotionState,Plan,Animation} from './schema.js';
/** Canonical tracks, not scene blocks. Exit and entrance are deliberately distinct. */
export function entranceTrack(a:Animation){
 if(a.effect==='fadeOut'||a.effect==='scaleOut'||('mode' in a.parameters&&a.parameters.mode==='out'))return false;
 return ['fadeIn','scaleIn','slideUp','slideDown','slideLeft','slideRight'].includes(a.effect);
}
export function compileTrackEdit(state:MotionState,edit:SemanticEdit,owns:(scene:string,target:string)=>boolean):Plan['operations']|null{
 const timing=['SHIFT_START','SHIFT_END','SET_START','SET_DURATION','SCALE_DURATION','REMOVE_ANIMATION','MODIFY_STAGGER','SET_TEMPORAL_DEPENDENCY','REMOVE_TEMPORAL_DEPENDENCY'];
 const transform=['MODIFY_POSITION','MODIFY_ROTATION','MODIFY_SCALE','MODIFY_OPACITY'];
 if(!timing.includes(edit.operation)&&!transform.includes(edit.operation))return null;
 const all=state.animations.filter(a=>owns(a.sceneId,a.targetId)&&(edit.scope.startSeconds===undefined||a.startFrame>=edit.scope.startSeconds*state.settings.fps)&&(edit.scope.endSeconds===undefined||a.startFrame<edit.scope.endSeconds*state.settings.fps));
 const tracks=all.filter(a=>(!edit.animationIds||edit.animationIds.includes(a.animationId))&&(edit.scope.phase!=='entrance'||entranceTrack(a)));
 if(edit.animationIds?.some(id=>!tracks.some(a=>a.animationId===id)))throw Error('EDIT_TARGET_OUTSIDE_SCOPE');
 if(!tracks.length)throw Error('NO_MATCHING_EXISTING_ANIMATIONS');
 // Multiple repetitions need an explicit ID/time scope, not an arbitrary first match.
 if(edit.scope.phase==='entrance'&&!edit.animationIds){
  const groups=new Map<string,Animation[]>();for(const a of tracks){const k=a.sceneId+'/'+a.targetId;groups.set(k,[...(groups.get(k)??[]),a]);}
  for(const group of groups.values()){
   const ordered=[...group].sort((a,b)=>a.startFrame-b.startFrame);let end=ordered[0].startFrame+ordered[0].durationFrames;
   for(const a of ordered.slice(1)){if(a.startFrame>end)throw Error('AMBIGUOUS_ENTRANCE_TIMING: choose an entrance interval');end=Math.max(end,a.startFrame+a.durationFrames);}
  }
 }
 const commands:Plan['operations']=[];
 if(transform.includes(edit.operation)){
  const values=edit.values;if(!values)throw Error('EDIT_VALUE_REQUIRED');
  for(const a of tracks){
   let parameters:Record<string,unknown>|undefined;
   if(edit.operation==='MODIFY_POSITION'&&a.effect==='moveTo')parameters={...a.parameters,...(values.x!==undefined?{toX:values.x}:{}),...(values.y!==undefined?{toY:values.y}:{})};
   const value=edit.operation==='MODIFY_ROTATION'?values.rotation:edit.operation==='MODIFY_SCALE'?values.scale:edit.operation==='MODIFY_OPACITY'?values.opacity:undefined;
   if(value!==undefined&&((edit.operation==='MODIFY_ROTATION'&&a.effect==='rotation')||(edit.operation==='MODIFY_SCALE'&&a.effect.startsWith('scale'))||(edit.operation==='MODIFY_OPACITY'&&a.effect.startsWith('fade'))))parameters={...a.parameters,to:value};
   if(parameters)commands.push({type:'updateAnimation',animationId:a.animationId,animation:{...a,parameters} as Animation});
  }
  if(!commands.length)throw Error('NO_MATCHING_PROPERTY_TRACK: inspect actual existing motion');return commands;
 }
 const start=Math.min(...tracks.map(a=>a.startFrame)),end=Math.max(...tracks.map(a=>a.startFrame+a.durationFrames));
 if(edit.operation==='REMOVE_ANIMATION')return tracks.map(a=>({type:'removeAnimation',animationId:a.animationId}));
 if(edit.operation==='SET_TEMPORAL_DEPENDENCY'){
  if(!edit.dependencyRelation)throw Error('DEPENDENCY_RELATION_REQUIRED');
  if(!edit.anchorAnimationId||!state.animations.some(a=>a.animationId===edit.anchorAnimationId))throw Error('TIMING_ANCHOR_NOT_FOUND');
  return tracks.map(a=>({type:'setTimingDependency',dependency:{dependencyId:state.timingDependencies?.find(d=>d.animationId===a.animationId)?.dependencyId??'edit_dependency_'+a.animationId,animationId:a.animationId,anchorAnimationId:edit.anchorAnimationId!,relation:edit.dependencyRelation??'after',offsetFrames:edit.deltaFrames??0}}));
 }
 if(edit.operation==='REMOVE_TEMPORAL_DEPENDENCY')return (state.timingDependencies??[]).filter(d=>tracks.some(a=>a.animationId===d.animationId)).map(d=>({type:'removeTimingDependency',dependencyId:d.dependencyId}));
 for(const [i,a] of tracks.entries()){
  if(edit.operation==='SHIFT_START'||edit.operation==='SHIFT_END'||edit.operation==='SET_START'){
   const delta=edit.operation==='SET_START'?(edit.frameValue===undefined?NaN:edit.frameValue-start):edit.deltaFrames;
   if(delta===undefined||!Number.isSafeInteger(delta))throw Error('EDIT_FRAME_DELTA_REQUIRED');
   if(edit.operation==='SHIFT_END')commands.push({type:'setDuration',animationId:a.animationId,durationFrames:a.durationFrames+delta});
   else commands.push({type:'shiftAnimation',animationId:a.animationId,deltaFrames:delta});
  }else if(edit.operation==='MODIFY_STAGGER'){
   if(edit.values?.staggerFrames===undefined)throw Error('EDIT_STAGGER_REQUIRED');
   commands.push({type:'updateAnimation',animationId:a.animationId,animation:{...a,...(a.text?{text:{...a.text,staggerFrames:edit.values.staggerFrames}}:{startFrame:start+i*edit.values.staggerFrames})}});
  }else{
   const group=tracks.filter(t=>t.sceneId===a.sceneId&&t.targetId===a.targetId),groupStart=Math.min(...group.map(t=>t.startFrame)),groupEnd=Math.max(...group.map(t=>t.startFrame+t.durationFrames));
   const factor=edit.operation==='SET_DURATION'?(edit.frameValue??NaN)/(groupEnd-groupStart):edit.durationFactor;
   if(factor===undefined||!Number.isFinite(factor)||factor<=0)throw Error('EDIT_DURATION_REQUIRED');
   commands.push({type:'updateAnimation',animationId:a.animationId,animation:{...a,startFrame:Math.round(groupStart+(a.startFrame-groupStart)*factor),durationFrames:Math.max(1,Math.round(a.durationFrames*factor))}});
  }
 }
 if(edit.dependencyPolicy==='preserve-absolute'){
  const selected=new Set(tracks.map(a=>a.animationId));
  const reachable=new Set(selected);let grew=true;while(grew){grew=false;for(const d of state.timingDependencies??[])if(reachable.has(d.anchorAnimationId)&&!reachable.has(d.animationId)){reachable.add(d.animationId);grew=true;}}
  for(const a of state.animations)if(reachable.has(a.animationId)&&!selected.has(a.animationId))commands.push({type:'setStartFrame',animationId:a.animationId,startFrame:a.startFrame});
 }
 return commands;
}
