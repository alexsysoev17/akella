import type {MotionState} from './schema.js';
import {intervalEnd, safeFrame} from './time.js';
/** Canonical values are persisted integer FPS + output frames, never duplicate seconds. */
export function projectTime(state:MotionState, projectRevision?:string) {
  const {fps,durationFrames}=state.settings;
  const intervals=[...state.animations,...(state.expressions??[]),...(state.objectTransitions??[])];
  const start=Math.min(0,...intervals.map(i=>i.startFrame));
  const end=Math.max(0,...intervals.map(intervalEnd));
  return {fps,durationFrames,durationSeconds:durationFrames/fps,timebase:{numerator:fps,denominator:1},projectRevision,
    playbackRange:{startFrame:0,endFrameExclusive:durationFrames},renderRange:{startFrame:0,endFrameExclusive:durationFrames},
    migration:{legacyOriginCount:(state.timingOrigins??[]).filter(o=>o.basis==="legacyPreserveSeconds").length,legacyPolicy:"preserveSeconds" as const},
    contentExtent:{startFrame:start,endFrameExclusive:end},outsideOutput:intervals.filter(i=>i.startFrame<0||intervalEnd(i)>durationFrames).length,
    warnings:[...(end>durationFrames?[`Часть анимации находится за длительностью видео (${end} кадров содержимого, ${durationFrames} кадров вывода). Данные сохранены.`]:[]),...(start<0?["В проекте есть анимация до начала видео; её состояние учитывается на кадре 0."]:[])]};
}
/** Apply to a candidate only; store.ts owns atomic persistence/revision/Undo. */
export function updateProjectTime(state:MotionState, change:{fps?:number;durationSeconds?:number;fpsPolicy?:'preserveSeconds'|'preserveFrames';width?:number;height?:number}) {
  const original=structuredClone(state);
  const oldFPS=state.settings.fps, fps=change.fps??oldFPS, ratio=fps/oldFPS;
  const outputOrigin=state.timingOrigins?.find(o=>o.entity==="output"&&o.id==="project")?.duration;
  const seconds=change.durationSeconds??(outputOrigin?(outputOrigin.unit==="seconds"?outputOrigin.value:outputOrigin.value/oldFPS):state.settings.durationFrames/oldFPS);
  const output=safeFrame(Math.round(seconds*fps));
  if(output<1||output>108000)throw Error('INVALID_OUTPUT_DURATION');
  const convert=(value:number)=>safeFrame(change.fpsPolicy==='preserveFrames'?value:Math.round(value*ratio));
  const origins=state.timingOrigins??=[];
  const previousOutput=origins.find(o=>o.entity==="output"&&o.id==="project");
  if(previousOutput)previousOutput.duration={unit:"seconds",value:seconds};
  else origins.push({entity:"output",id:"project",basis:"manual",duration:{unit:"seconds",value:seconds}});
  const originFor=(entity:NonNullable<MotionState["timingOrigins"]>[number]["entity"],id:string)=>{
    let origin=origins.find(o=>o.entity===entity&&o.id===id);
    if(!origin){origin={entity,id,basis:"legacyPreserveSeconds"};origins.push(origin);}return origin;
  };
  const measure=(entity:NonNullable<MotionState["timingOrigins"]>[number]["entity"],id:string,field:'start'|'duration'|'offset',value:number)=>{
    const record=originFor(entity,id);
    const origin=record[field]??= {unit:"seconds",value:value/oldFPS};
    if(change.fpsPolicy==="preserveFrames") {record[field]={unit:"frames",value};record.basis="framePolicy";return safeFrame(value); }
    return safeFrame(origin?Math.round(origin.value*(origin.unit==='seconds'?fps:1)+(origin.secondsOffset??0)*fps):convert(value));
  };
  if(fps!==oldFPS){
    for(const [entity,list,id] of [ ['animation',state.animations,'animationId'],['expression',state.expressions??[],'expressionId'],['transition',state.objectTransitions??[],'transitionId'],['block',state.blocks,'blockId']] as const){
      for(const item of list){const key=String((item as unknown as Record<string,unknown>)[id]);
        item.startFrame=measure(entity,key,'start',item.startFrame);
        item.durationFrames=measure(entity,key,'duration',item.durationFrames);
        if(item.durationFrames<1)throw Error('FPS_INTERVAL_COLLAPSE: '+key);
        if('transition' in item)item.transition.durationFrames=convert(item.transition.durationFrames);
        if('effect' in item){
          const origin=originFor(entity,key);
          if(item.effect==='keyframes'){
            origin.keys??=item.parameters.points.map(k=>({unit:"seconds",value:k.frame/oldFPS}));
            item.parameters.points=item.parameters.points.map((k,i)=>({...k,frame:change.fpsPolicy==='preserveFrames'?k.frame:Math.round(origin.keys![i].value*(origin.keys![i].unit==='frames'?1:fps))}));
          }
          if(item.text){origin.stagger??={unit:"seconds",value:item.text.staggerFrames/oldFPS};item.text.staggerFrames=change.fpsPolicy==='preserveFrames'?item.text.staggerFrames:Math.round(origin.stagger.value*(origin.stagger.unit==='frames'?1:fps));}
        }
        if('parameters' in item&&'velocityLookbackFrames' in item.parameters&&typeof item.parameters.velocityLookbackFrames==='number'){const origin=originFor(entity,key);origin.lookback??={unit:'seconds',value:item.parameters.velocityLookbackFrames/oldFPS};item.parameters.velocityLookbackFrames=Math.max(1,Math.round(origin.lookback.value*fps));}
      }
    }
    const oldTracks=new Map<string,{startFrame:number;durationFrames:number}>([...original.animations.map(a=>[a.animationId,a] as const),...(original.objectTransitions??[]).map(t=>[t.transitionId,t] as const)]);
    const newTracks=new Map<string,{startFrame:number;durationFrames:number}>([...state.animations.map(a=>[a.animationId,a] as const),...(state.objectTransitions??[]).map(t=>[t.transitionId,t] as const)]);
    for(const e of state.expressions??[]){
      if(!('sourceAnimationId' in e))continue;
      const old=original.expressions?.find(o=>o.expressionId===e.expressionId), from=oldTracks.get(e.sourceAnimationId),to=newTracks.get(e.sourceAnimationId);
      if(!old||!from||!to)continue;
      const atEnd=e.type==='inertialOvershoot'&&old.startFrame>=from.startFrame+from.durationFrames;
      const gap=old.startFrame-from.startFrame-(atEnd?from.durationFrames:0);
      e.startFrame=safeFrame(to.startFrame+(atEnd?to.durationFrames:0)+convert(gap));
    }
    for(const anchor of state.sceneAnchors??[])anchor.startFrame=measure('scene',anchor.sceneId,'start',anchor.startFrame);
    for(const dep of state.timingDependencies??[])dep.offsetFrames=measure('dependency',dep.dependencyId,'offset',dep.offsetFrames);
  }
  state.settings={...state.settings,fps,durationFrames:output,tailPolicy:'holdLastScene',timelineModel:'independentOutput',...(change.width?{width:change.width}:{}),...(change.height?{height:change.height}:{})};
  return state;
}

/** Edits invalidate only the corresponding provenance value, retaining its unit. */
export function refreshTimingOrigins(before:MotionState, state:MotionState, explicit=new Set<string>()) {
  const lookup=(s:MotionState,entity:string,id:string):{startFrame?:number;durationFrames?:number;offsetFrames?:number}|undefined =>
    entity==='output'?{durationFrames:s.settings.durationFrames}:entity==='animation'?s.animations.find(a=>a.animationId===id):entity==='expression'?s.expressions?.find(e=>e.expressionId===id):entity==='transition'?s.objectTransitions?.find(t=>t.transitionId===id):entity==='block'?s.blocks.find(b=>b.blockId===id):entity==='scene'?s.sceneAnchors?.find(a=>a.sceneId===id):s.timingDependencies?.find(d=>d.dependencyId===id);
  if(!state.timingOrigins)return;
  state.timingOrigins=state.timingOrigins.filter(origin=>{
    const old=lookup(before,origin.entity,origin.id), next=lookup(state,origin.entity,origin.id);
    if(!next)return false;
    if(explicit.has(origin.entity+':'+origin.id))return true;
    for(const [field,key] of [['start','startFrame'],['duration','durationFrames'],['offset','offsetFrames']] as const){
      const m=origin[field],value=next[key];if(m&&value!==undefined&&value!==old?.[key])m.value=m.unit==='frames'?value-(m.secondsOffset??0)*state.settings.fps:value/state.settings.fps-(m.secondsOffset??0);
    }
    const oldAnimation=before.animations.find(a=>origin.entity==='animation'&&a.animationId===origin.id), animation=state.animations.find(a=>origin.entity==='animation'&&a.animationId===origin.id);
    if(animation?.effect==='keyframes'&&oldAnimation?.effect==='keyframes'&&JSON.stringify(animation.parameters.points.map(k=>k.frame))!==JSON.stringify(oldAnimation.parameters.points.map(k=>k.frame)))origin.keys=animation.parameters.points.map((k,i)=>({unit:origin.keys?.[i]?.unit??'seconds',value:origin.keys?.[i]?.unit==='frames'?k.frame:k.frame/state.settings.fps}));
    if(animation?.text&&animation.text.staggerFrames!==oldAnimation?.text?.staggerFrames&&origin.stagger)origin.stagger.value=origin.stagger.unit==='frames'?animation.text.staggerFrames:animation.text.staggerFrames/state.settings.fps;
    const oldEffect=before.expressions?.find(e=>origin.entity==='expression'&&e.expressionId===origin.id),effect=state.expressions?.find(e=>origin.entity==='expression'&&e.expressionId===origin.id);
    if(effect?.type==='inertialOvershoot'&&oldEffect?.type==='inertialOvershoot'&&origin.lookback&&effect.parameters.velocityLookbackFrames!==oldEffect.parameters.velocityLookbackFrames)origin.lookback.value=origin.lookback.unit==='frames'?effect.parameters.velocityLookbackFrames:effect.parameters.velocityLookbackFrames/state.settings.fps;
    return true;
  });
}
