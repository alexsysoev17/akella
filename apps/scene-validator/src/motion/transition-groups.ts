import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {LoadedProject} from '../types.js';
import {objectTransitionSchema, type MotionState, type Operation} from './schema.js';
import {globalFrameSchema,intervalDurationSchema} from './time.js';
import {buildRegistry,resolveState} from './registry.js';
import {applyOperations} from './operations.js';
import type {MotionProgram} from '../motion-library/expressions/program.js';

const id=z.string().min(1).max(180);
/** Coordination artifact: only existing canonical transitions/expressions are persisted. */
export const transitionGroupSchema=z.object({
    groupId:id,
    fromSceneId:id,
    toSceneId:id,
    startFrame:globalFrameSchema,
    durationFrames:intervalDurationSchema,
    switchFrame:z.number().finite().optional(),
    timelinePolicy:objectTransitionSchema.shape.timelinePolicy,
    members:z.array(z.object({
        logicalObjectId:id,
        transitionId:id.optional(),
        easing:objectTransitionSchema.shape.easing,
        proceduralEffects:objectTransitionSchema.shape.proceduralEffects.optional(),
        /** Quadratic canvas-space control-point offset from the straight midpoint. */
        pathControlOffset:z.object({x:z.number().finite().min(-1e6).max(1e6),y:z.number().finite().min(-1e6).max(1e6)}).strict().optional(),
    }).strict()).min(1).max(100),
}).strict();
export type TransitionGroup=z.infer<typeof transitionGroupSchema>;
export class TransitionGroupError extends Error {
    readonly code:string;
    constructor(readonly issue:{code:string;message:string;details:unknown;allowedActions:string[]}){super(issue.code+': '+issue.message);this.code=issue.code;}
}
const fail=(code:string,message:string,details:unknown):never=>{throw new TransitionGroupError({code,message,details,allowedActions:['inspectAnimations','editTransitionGroup','adjustTimeline']});};
const stableId=(kind:string,groupId:string,objectId:string,axis='')=>`${kind}_${createHash('sha256').update(JSON.stringify([groupId,objectId,axis])).digest('hex').slice(0,28)}`;
const arcProgram=(offset:number):MotionProgram=>({version:1,instructions:[
    {op:'constant',value:2*offset},{op:'input',name:'progress'},{op:'mul'},
    {op:'constant',value:1},{op:'input',name:'progress'},{op:'sub'},{op:'mul'},
]});
/**
 * All members are constructed before canonical validation. No worker needs to
 * guess scene-global hierarchy metadata and no invalid intermediate state leaks.
 * Existing unrelated overlapping transitions are never silently rewritten.
 */
export function compileTransitionGroup(project:LoadedProject,state:MotionState,input:unknown){
    const group=transitionGroupSchema.parse(input),end=group.startFrame+group.durationFrames;
    if(group.fromSceneId===group.toSceneId)fail('TRANSITION_GROUP_SCENES_IDENTICAL','A state transition needs two distinct reference scenes',{groupId:group.groupId});
    if(new Set(group.members.map(m=>m.logicalObjectId)).size!==group.members.length)fail('TRANSITION_GROUP_DUPLICATE_OBJECT','One logical object can participate once',{groupId:group.groupId});
    const registry=buildRegistry(project.inspection.document,project.inspection.fingerprint);
    const overlapping=(state.objectTransitions??[]).filter(t=>Math.max(t.startFrame,group.startFrame)<Math.min(t.startFrame+t.durationFrames,end));
    const compatible=overlapping.filter(t=>t.fromSceneId===group.fromSceneId&&t.toSceneId===group.toSceneId&&t.startFrame===group.startFrame&&t.durationFrames===group.durationFrames);
    const switchFrame=group.switchFrame??(compatible[0]?compatible[0].startFrame+compatible[0].durationFrames*compatible[0].layerPolicy.switchProgress:end);
    if(switchFrame<group.startFrame||switchFrame>end)fail('TRANSITION_GROUP_SWITCH_OUTSIDE_INTERVAL','Hierarchy switch must lie inside the shared interval',{switchFrame,startFrame:group.startFrame,endFrame:end});
    const members=new Set(group.members.map(m=>m.logicalObjectId));
    const externalConflicts=overlapping.filter(t=>!members.has(t.logicalObjectId)&&(!compatible.includes(t)||Math.abs(t.startFrame+t.durationFrames*t.layerPolicy.switchProgress-switchFrame)>1e-7));
    if(externalConflicts.length)fail('TRANSITION_GROUP_EXTERNAL_CONFLICT','Overlapping scene composites require a shared interval, scene pair and hierarchy switch; include the affected objects or choose a separate interval',{groupId:group.groupId,transitionIds:externalConflicts.map(t=>t.transitionId),switchFrame});
    const operations:Operation[]=[],assignments:{logicalObjectId:string;transitionId:string;pathExpressionIds:string[]}[]=[];
    for(const member of group.members){
        const object=registry.objects.find(o=>o.logicalObjectId===member.logicalObjectId);
        if(!object)fail('TRANSITION_GROUP_TARGET_NOT_FOUND','Resolve a current logical object',{logicalObjectId:member.logicalObjectId});
        const from=resolveState(project.inspection.document,object!,group.fromSceneId);
        resolveState(project.inspection.document,object!,group.toSceneId);
        const current=overlapping.filter(t=>t.logicalObjectId===member.logicalObjectId&&t.fromSceneId===group.fromSceneId&&t.toSceneId===group.toSceneId);
        if(current.length>1)fail('TRANSITION_GROUP_MEMBER_AMBIGUOUS','Choose the exact current transition identity',{logicalObjectId:member.logicalObjectId,transitionIds:current.map(t=>t.transitionId)});
        const existing=compatible.find(t=>t.logicalObjectId===member.logicalObjectId)??current[0];
        const transitionId=member.transitionId??existing?.transitionId??stableId('transition',group.groupId,member.logicalObjectId);
        const idOwner=(state.objectTransitions??[]).find(t=>t.transitionId===transitionId);
        if(idOwner&&idOwner.logicalObjectId!==member.logicalObjectId)fail('TRANSITION_GROUP_ID_COLLISION','Transition identity belongs to another object',{transitionId,owner:idOwner.logicalObjectId});
        if(existing&&existing.transitionId!==transitionId)fail('TRANSITION_GROUP_EXISTING_ID','Preserve the current transition identity when updating a group',{logicalObjectId:member.logicalObjectId,existingTransitionId:existing.transitionId,requestedTransitionId:transitionId});
        const transition=objectTransitionSchema.parse({transitionId,logicalObjectId:member.logicalObjectId,fromSceneId:group.fromSceneId,toSceneId:group.toSceneId,startFrame:group.startFrame,durationFrames:group.durationFrames,easing:member.easing,proceduralEffects:member.proceduralEffects??existing?.proceduralEffects??[],timelinePolicy:group.timelinePolicy??existing?.timelinePolicy??'referenceStates',layerPolicy:{type:'switch',switchProgress:(switchFrame-group.startFrame)/group.durationFrames}});
        operations.push({type:'animateObjectStateTransition',...transition});
        transition.proceduralEffects=transition.proceduralEffects.map((p,i)=>{const space=p.space??(existing?existing.proceduralEffects[i]?.space:'canvasPixels');return space?{...p,space}:p;});
        operations[operations.length-1]={type:'animateObjectStateTransition',...transition};
        const pathExpressionIds:string[]=[];
        for(const axis of ['x','y'] as const){
            const expressionId=stableId('transition_path',group.groupId,member.logicalObjectId,axis),old=state.expressions?.find(e=>e.expressionId===expressionId);
            if(old&&(old.transitionId!==transitionId||old.type!=='procedural'))fail('TRANSITION_GROUP_EXPRESSION_COLLISION','Path effect identity is already owned elsewhere',{expressionId});
            if(!member.pathControlOffset){if(old){operations.push({type:'setExpression',expression:{...old,startFrame:group.startFrame,durationFrames:group.durationFrames,sceneId:group.fromSceneId,targetId:from.sourceNodeId}});pathExpressionIds.push(expressionId);}continue;}
            if(member.pathControlOffset[axis]===0){if(old)operations.push({type:'removeExpression',expressionId});continue;}
            operations.push({type:'setExpression',expression:{expressionId,type:'procedural',sceneId:group.fromSceneId,targetId:from.sourceNodeId,transitionId,ownership:{scope:'transition',logicalObjectId:member.logicalObjectId},property:axis,startFrame:group.startFrame,durationFrames:group.durationFrames,enabled:true,parameters:{amplitude:1},program:arcProgram(member.pathControlOffset[axis])}});
            pathExpressionIds.push(expressionId);
        }
        assignments.push({logicalObjectId:member.logicalObjectId,transitionId,pathExpressionIds});
    }
    // Genuine geometry/ownership/overlap/dependency failures stay blocking.
    applyOperations(state,operations,project);
    return {group:{...group,switchFrame,members:group.members.map((m,i)=>({...m,transitionId:assignments[i].transitionId}))},operations,assignments,writeSet:[...members],coordination:{fromSceneId:group.fromSceneId,toSceneId:group.toSceneId,startFrame:group.startFrame,endFrame:end,switchFrame}};
}
