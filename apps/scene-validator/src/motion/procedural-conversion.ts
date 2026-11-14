import {z} from 'zod';
import {createHash} from 'node:crypto';
import type {MotionState,Operation} from './schema.js';
import {expressionSchema} from '../motion-library/expressions/registry.js';
export const inertiaConversionSchema=z.object({tool:z.literal('convertKeyframeInertia'),animationId:z.string().min(1),motionEndFrame:z.number().int().positive().optional(),settleFrame:z.number().int().positive().optional(),amplitude:z.number().finite().min(0).max(100000).default(.2),frequency:z.number().finite().min(.001).max(10000).default(2.5),decay:z.number().finite().min(0).max(10000).default(3)}).strict().describe('Atomically convert a selected keyframed transform overshoot into a base hold plus real incoming-velocity inertia. Frames are local to the selected animation. Explicit motionEndFrame resolves ambiguous movement/tail boundaries; optional settleFrame shortens follow-through before the next owner without retiming any dependency. Original base ID, duration, easing and final value are preserved. Zero incoming velocity yields zero physical inertia; never inject a hidden impulse.');
export class InertiaConversionError extends Error{
 readonly issue;
 constructor(code:string,details:unknown){super(code);this.issue={code,message:code,details,allowedActions:['inspectAnimations','sampleAnimation','convertKeyframeInertia:motionEndFrame']};}
}
/** Only the selected track is replaced; its duration/identity/dependency anchors remain intact.
 * A positive local motionEndFrame is explicit authority when the tail cannot be inferred.
 * Inference admits a monotonic entrance crossing the final value followed by both signs.
 * It does not pretend to uniquely recover artistic intent from arbitrary numerical samples. */
export function convertKeyframeInertia(state:MotionState,input:unknown):Operation[]{
 const command=inertiaConversionSchema.parse(input),a=state.animations.find(a=>a.animationId===command.animationId);
 if(!a||a.effect!=='keyframes'||!a.enabled)throw new InertiaConversionError('CONVERSION_REQUIRES_ENABLED_KEYFRAMES',{animationId:command.animationId});
 if(a.text&&a.text.segmentation!=='block')throw new InertiaConversionError('CONVERSION_SEGMENTED_TRACK_REQUIRES_EXPLICIT_BINDING',{animationId:a.animationId});
 if(a.parameters.property==='trim')throw new InertiaConversionError('CONVERSION_PROPERTY_UNSUPPORTED',{property:'trim',reason:'Path reveal cannot be replaced by transform inertia'});
 const points=a.parameters.points,target=points.at(-1)!.value,initial=points[0].value-target;
 const id=(property:string)=>'converted_inertia_'+createHash('sha256').update(a.animationId+':'+property).digest('hex').slice(0,30);
 const properties=a.parameters.property==='scale'?['scaleX','scaleY']as const:[a.parameters.property];
 const prior=state.expressions?.find(e=>e.expressionId===id(properties[0])&&e.type==='inertialOvershoot'&&e.sourceAnimationId===a.animationId);
 let end=command.motionEndFrame??(prior?prior.startFrame-a.startFrame:undefined);
 if(end===undefined){const crossing=points.findIndex((p,i)=>i>0&&(p.value-target)*initial<=0);
 const tail=points.slice(crossing),signs=new Set(tail.map(p=>Math.sign(p.value-target)).filter(Boolean));
 if(initial===0||crossing<1||signs.size!==2||points.slice(1,crossing).some((p,i)=>(p.value-points[i].value)*initial>0))throw new InertiaConversionError('CONVERSION_BOUNDARY_AMBIGUOUS',{animationId:a.animationId,availableFrames:points.map(p=>p.frame)});
 end=points[crossing].frame;}
 const settle=command.settleFrame??a.durationFrames;
 if(end<=points[0].frame||end>=settle||settle>a.durationFrames)throw new InertiaConversionError('CONVERSION_BOUNDARY_OUTSIDE_TRACK',{end,settle,durationFrames:a.durationFrames});
 const base={...a,parameters:{...a.parameters,points:[...points.filter(p=>p.frame<end!),{frame:end,value:target},{frame:a.durationFrames,value:target}]}};
 const ops:Operation[]=[{type:'updateAnimation',animationId:a.animationId,animation:base}];
 for(const property of properties){const expressionId=id(property),collision=state.expressions?.find(e=>e.expressionId===expressionId);
 if(collision&&(!('sourceAnimationId'in collision)||collision.sourceAnimationId!==a.animationId))throw new InertiaConversionError('CONVERSION_ID_COLLISION',{expressionId});
 const competing=state.expressions?.filter(e=>e.expressionId!==expressionId&&e.type==='inertialOvershoot'&&e.sourceAnimationId===a.animationId&&e.property===property)??[];
 if(competing.length)throw new InertiaConversionError('CONVERSION_EXISTING_INERTIA',{expressionIds:competing.map(e=>e.expressionId),reason:'Edit the existing effect instead of duplicating it'});
 ops.push({type:'setExpression',expression:expressionSchema.parse({expressionId,type:'inertialOvershoot',sourceAnimationId:a.animationId,sceneId:a.sceneId,targetId:a.targetId,property,startFrame:a.startFrame+end,durationFrames:settle-end,enabled:true,parameters:{mode:'ae',settlingEnvelope:'smoothTail',amplitude:command.amplitude,frequency:command.frequency,decay:command.decay,velocityLookbackFrames:Math.min(6,end)}})});}
 return ops;
}
