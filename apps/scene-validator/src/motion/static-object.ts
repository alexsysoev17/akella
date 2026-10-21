import type { LoadedProject } from "../types.js";
import type { MotionState, Plan } from "./schema.js";
import { buildRegistry, resolveState, type SourceNode } from "./registry.js";
export function staticObjectReference(project:LoadedProject, entry:{logicalObjectId:string;sceneId:string;targetId:string}) {
  const object = buildRegistry(project.inspection.document,project.inspection.fingerprint).objects.find(o=>o.logicalObjectId===entry.logicalObjectId);
  if (!object) throw new Error("TARGET_NOT_FOUND");
  const reference = resolveState(project.inspection.document,object,entry.sceneId);
  if (reference.sourceNodeId !== entry.targetId) throw new Error("STATIC_SOURCE_NOT_FOUND");
  if (reference.maskIds.length || reference.ancestors.some(n=>n.figmaNodeId!==reference.scene.figmaNodeId && (n.properties.clipsContent===true || Array.isArray(n.properties.effects)&&n.properties.effects.length>0 || ![undefined,"NORMAL","PASS_THROUGH"].includes(n.properties.blendMode as string|undefined))))
    throw new Error("ENGINE_CAPABILITY_MISSING: persistent object under ancestor clipping, mask or compositing effect");
  return reference;
}
export function staticObjectMembers(project: LoadedProject, logicalObjectId: string) {
  const object = buildRegistry(project.inspection.document, project.inspection.fingerprint).objects.find(o => o.logicalObjectId === logicalObjectId);
  if (!object) throw new Error("TARGET_NOT_FOUND");
  if (object.ambiguousScenes.length) throw new Error("AMBIGUOUS_LOGICAL_OBJECT");
  const members = new Set<string>();
  for (const instance of object.sourceInstances) {
    const scene = project.inspection.document.scenes.find(s => s.sceneId === instance.sceneId)!;
    const visit = (n: SourceNode, inside = false) => {
      inside ||= n.figmaNodeId === instance.sourceNodeId;
      if (inside) members.add(`${instance.sceneId}/${n.figmaNodeId}`);
      n.children?.forEach(c => visit(c, inside));
    };
    (scene.children as SourceNode[]).forEach(n => visit(n));
  }
  return { object, members };
}
export function staticObjectTransitions(project:LoadedProject,state:MotionState,members:Set<string>) {
  const registry = buildRegistry(project.inspection.document,project.inspection.fingerprint);
  return (state.objectTransitions ?? []).filter(t=>{
    const object = registry.objects.find(o=>o.logicalObjectId===t.logicalObjectId);
    const instances = object?.sourceInstances.filter(i=>i.sceneId===t.fromSceneId||i.sceneId===t.toSceneId) ?? [];
    if (!instances.some(i=>members.has(`${i.sceneId}/${i.sourceNodeId}`))) return false;
    if (!instances.every(i=>members.has(`${i.sceneId}/${i.sourceNodeId}`))) throw new Error("ENGINE_CAPABILITY_MISSING: child transition crosses frozen subtree ownership");
    return true;
  });
}
/** One canonical persistent presentation, not zero-length transitions or scene duplication. */
export function freezeObjectOperations(project: LoadedProject, state: MotionState, logicalObjectId: string): Plan["operations"] {
  const { object, members } = staticObjectMembers(project, logicalObjectId);
  const own = (a: {sceneId: string; targetId: string}) => members.has(`${a.sceneId}/${a.targetId}`);
  const transitions = staticObjectTransitions(project,state,members);
  const ids = new Set([...state.animations.filter(own).map(a => a.animationId), ...transitions.map(t => t.transitionId)]);
  const source = [...object.sourceInstances].sort((a,b) => project.inspection.document.scenes.find(s => s.sceneId === a.sceneId)!.index - project.inspection.document.scenes.find(s => s.sceneId === b.sceneId)!.index)[0];
  staticObjectReference(project,{logicalObjectId,sceneId:source.sceneId,targetId:source.sourceNodeId});
  const contained: string[] = [];
  for (const entry of state.staticObjects ?? []) {
    if (entry.logicalObjectId === logicalObjectId) continue;
    const existing = staticObjectMembers(project,entry.logicalObjectId).members;
    if (![...existing].some(id=>members.has(id))) continue;
    if (![...existing].every(id=>members.has(id))) throw new Error("STATIC_SCOPE_OVERLAP: frozen ancestor owns additional objects");
    contained.push(entry.logicalObjectId);
  }
  return [
    ...contained.map(logicalObjectId=>({type:"removeStaticObject" as const,logicalObjectId})),
    ...(state.expressions ?? []).filter(e => own(e) || !!e.transitionId && ids.has(e.transitionId) || "sourceAnimationId" in e && ids.has(e.sourceAnimationId)).map(e => ({type:"removeExpression" as const, expressionId:e.expressionId})),
    ...(state.timingDependencies ?? []).filter(d => ids.has(d.animationId) || ids.has(d.anchorAnimationId)).map(d => ({type:"removeTimingDependency" as const, dependencyId:d.dependencyId})),
    ...transitions.map(t => ({type:"removeObjectStateTransition" as const, transitionId:t.transitionId})),
    ...state.animations.filter(own).map(a => ({type:"removeAnimation" as const, animationId:a.animationId})),
    { type:"setStaticObject", object:{logicalObjectId, sceneId:source.sceneId, targetId:source.sourceNodeId} },
  ];
}
