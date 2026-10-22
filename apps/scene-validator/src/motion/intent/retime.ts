import {dependencyStart} from "../time.js";
import type { MotionState } from "../schema.js";
/** Retimes organizational anchors atomically without compressing motion intervals.
 * Associated tracks shift together; visible blocks follow only when representable. */
export function retimeScenes(state:MotionState, starts:{sceneId:string;startFrame:number}[]) {
  const before=structuredClone(state), seen=new Set<string>();
  const ordered=[...state.blocks].sort((a,b)=>a.startFrame-b.startFrame);
  for(const ref of starts){
    if(seen.has(ref.sceneId))throw new Error("Duplicate scene timing");
    seen.add(ref.sceneId);
    if(ordered.filter(b=>b.sceneId===ref.sceneId).length!==1)throw new Error("Scene timing requires one unambiguous block");
  }
  state.sceneAnchors=[...(state.sceneAnchors ?? []).filter(a=>!seen.has(a.sceneId)),...starts];
  const proposed=ordered.map(b=>({...b,startFrame:starts.find(r=>r.sceneId===b.sceneId)?.startFrame ?? b.startFrame}));
  // Organizational anchors can lie anywhere. Adjust default presentation only
  // where the existing contiguous video-block representation can express it.
  const visual=proposed[0]?.startFrame===0 && proposed.every((b,i)=>b.startFrame>=0&&b.startFrame<state.settings.durationFrames&&(!i||b.startFrame>proposed[i-1].startFrame));
  if(visual) for(let i=0;i<proposed.length;i++){
    const b=proposed[i], next=proposed[i+1], duration=(next?.startFrame??state.settings.durationFrames)-b.startFrame;
    if(b.transition.durationFrames>=duration)b.transition={type:"cut",durationFrames:0};
    b.durationFrames=duration+(next?b.transition.durationFrames:0);
    Object.assign(state.blocks.find(x=>x.blockId===b.blockId)!,b);
  }
  for(const ref of starts){
    const old=before.sceneAnchors?.find(a=>a.sceneId===ref.sceneId)?.startFrame ?? before.blocks.find(b=>b.sceneId===ref.sceneId)!.startFrame;
    const delta=ref.startFrame-old;
    for(const a of state.animations.filter(a=>a.sceneId===ref.sceneId))a.startFrame+=delta;
    for(const e of state.expressions?.filter(e=>e.sceneId===ref.sceneId) ?? [])e.startFrame+=delta;
    for(const t of state.objectTransitions?.filter(t=>t.fromSceneId===ref.sceneId) ?? [])t.startFrame+=delta;
  }
}
export function resolveTimingDependencies(state: MotionState, explicitStarts = new Set<string>(), explicitEdges = new Set<string>()) {
  const edges = state.timingDependencies ?? [],
    byTarget = new Map(edges.map((d) => [d.animationId, d.anchorAnimationId]));
  const visited = new Set<string>(),
    stack: string[] = [];
  const visit = (id: string) => {
    const index = stack.indexOf(id);
    if (index >= 0)
      throw new Error(
        "Timing dependency cycle: " + [...stack.slice(index), id].join(" -> "),
      );
    if (visited.has(id)) return;
    stack.push(id);
    const next = byTarget.get(id);
    if (next) visit(next);
    stack.pop();
    visited.add(id);
  };
  for (const id of byTarget.keys()) visit(id);
  const pending = [...(state.timingDependencies ?? [])],
    completed = new Set<string>();
  while (pending.length) {
    const i = pending.findIndex(
      (d) =>
        !pending.some((other) => other.animationId === d.anchorAnimationId),
    );
    if (i < 0) throw new Error("Timing dependency cycle");
    const [d] = pending.splice(i, 1);
    if (completed.has(d.animationId))
      throw new Error("Multiple timing dependencies for one animation");
    completed.add(d.animationId);
    const a = state.animations.find((a) => a.animationId === d.animationId),
      anchor = state.animations.find(
        (a) => a.animationId === d.anchorAnimationId,
      );
    if (!a || !anchor)
      throw new Error("Timing dependency refers to a missing animation");
    // Resolve the parent first, then derive an explicitly moved child offset.
    // This also handles a group whose selected members skip an intermediate node.
    if (explicitStarts.has(a.animationId) && !explicitEdges.has(d.dependencyId))
      d.offsetFrames = a.startFrame - dependencyStart(a, anchor, d.relation, 0);
    const start = dependencyStart(a, anchor, d.relation, d.offsetFrames);
    a.startFrame = start;

  }
}

/** Attached effects retain their source-relative offset across direct and transitive edits. */
export function reanchorExpressions(state: MotionState, before: MotionState, skip = new Set<string>()) {
  const tracks = (s: MotionState) => new Map<string, {startFrame:number;durationFrames:number}>([...s.animations.map(a=>[a.animationId,a] as const), ...(s.objectTransitions ?? []).map(t=>[t.transitionId,t] as const)]);
  const oldTracks=tracks(before), nextTracks=tracks(state);
  for (const e of state.expressions ?? []) {
    if (!("sourceAnimationId" in e) || skip.has(e.expressionId)) continue;
    const old = before.expressions?.find(x=>x.expressionId===e.expressionId);
    const from=oldTracks.get(e.sourceAnimationId), to=nextTracks.get(e.sourceAnimationId);
    if (!old || !from || !to) continue;
    const endAnchor=e.type==="inertialOvershoot" && old.startFrame>=from.startFrame+from.durationFrames;
    e.startFrame=old.startFrame + to.startFrame-from.startFrame + (endAnchor?to.durationFrames-from.durationFrames:0);
  }
}
