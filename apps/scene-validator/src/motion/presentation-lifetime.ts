import type { MotionState } from "./schema.js";
export type PresentationInstance = {sceneId:string; sourceNodeId:string};
/** Scene membership supplies a reference pose, not a lifetime boundary.
 * Motion starts establish presence; fill/hold persists until another reference
 * instance is presented. An active interval wins over an organizational marker. */
export function motionPresentationHosts(state:MotionState, frame:number, objects:{sourceInstances:PresentationInstance[]}[], visibleScenes:Set<string>) {
  const result=new Map<string, PresentationInstance>();
  const intervals=new Map<string,{active:boolean;start:number}>();
  for(const a of [...state.animations,...(state.expressions ?? [])]){
    if(!a.enabled||frame<a.startFrame)continue;
    const key=JSON.stringify([a.sceneId,a.targetId]), active=frame<a.startFrame+a.durationFrames, old=intervals.get(key);
    if(!old || active&&!old.active || active===old.active&&a.startFrame>old.start)intervals.set(key,{active,start:a.startFrame});
  }
  for (const object of objects) {
    const candidates=object.sourceInstances.flatMap(i=>{
      const interval=intervals.get(JSON.stringify([i.sceneId,i.sourceNodeId]));
      return interval?[{instance:i,...interval}]:[];
    }).sort((a,b)=>Number(b.active)-Number(a.active)||b.start-a.start||a.instance.sceneId.localeCompare(b.instance.sceneId));
    if (!candidates.length) continue;
    const chosen=candidates[0].instance;
    if (!visibleScenes.has(chosen.sceneId))
      for (const i of object.sourceInstances) result.set(JSON.stringify([i.sceneId,i.sourceNodeId]),chosen);
  }
  return result;
}
