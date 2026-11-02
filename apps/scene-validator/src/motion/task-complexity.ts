import type {LoadedProject} from '../types.js';
import type {MotionState} from './schema.js';
import {buildRegistry} from './registry.js';
import {objectMentionRanges} from './object-aliases.js';
/** Evidence for semantic routing, not a keyword/length gate. Local deterministic edits bypass it. */
export function taskComplexity(project:LoadedProject,state:MotionState,request:string){
 const named=buildRegistry(project.inspection.document,project.inspection.fingerprint).objects.filter(o=>objectMentionRanges(o.name,request).length),ids=new Set(named.flatMap(o=>o.sourceInstances.map(i=>i.sceneId))),nodes=new Set(named.flatMap(o=>o.sourceInstances.map(i=>i.sceneId+'/'+i.sourceNodeId)));
 return {routing:'AGENT_SEMANTIC_DECISION',namedObjects:named.length,referenceScenes:[...ids],existingTargetAnimations:state.animations.filter(a=>nodes.has(a.sceneId+'/'+a.targetId)).length,existingDependencyEdges:state.timingDependencies?.length??0,instructions:'Use full user meaning and requested temporal/transition relationships. Multiple named objects alone do not require Production. Routine parameter edits stay direct; a coordinated multi-stage composition should hand off before editing. No route is decided by character count.'};
}
