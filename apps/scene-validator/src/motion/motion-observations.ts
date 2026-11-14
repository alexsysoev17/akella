import type {MotionState} from './schema.js';
import {evaluateAnimation} from './evaluation.js';
import {expressionValue} from './expressions.js';
/** Measurements for artistic decisions. These never gate edits or publication. */
export function motionObservations(state:MotionState){
 const fps=state.settings.fps;
 return {advisoryOnly:true,
  timing:state.animations.filter(a=>a.enabled).map(a=>({id:a.animationId,startSeconds:a.startFrame/fps,sceneMarkerSeconds:(state.blocks.find(b=>b.sceneId===a.sceneId)?.startFrame??0)/fps})),
  inertia:(state.expressions??[]).filter(e=>e.enabled&&e.type==='inertialOvershoot'&&!e.transitionId).map(e=>{
   const a=state.animations.find(a=>'sourceAnimationId'in e&&a.animationId===e.sourceAnimationId);if(!a)return {id:e.expressionId,measurement:'SOURCE_UNAVAILABLE'};
   const end=a.startFrame+(a.effect==='keyframes'?a.parameters.points.at(-1)!.frame:a.durationFrames),base=(f:number)=>{const v=evaluateAnimation(a,f);return v[e.property]??v.scale??0;};
   const tail=(f:number)=>expressionValue(e,f,fps,state.animations,evaluateAnimation);
   const h=.001;
   const incomingVelocity=(base(end)-base(end-h))/(h/fps),outgoingVelocity=(tail(end+h)-tail(end))/(h/fps);
   const accelerationBefore=(base(end)-2*base(end-h)+base(end-2*h))/(h/fps)**2;
   const accelerationAfter=(tail(end+2*h)-2*tail(end+h)+tail(end))/(h/fps)**2;
   const beforeFrameSteps=Array.from({length:6},(_,i)=>base(end-5+i)-base(end-6+i));
   const afterFrameSteps=Array.from({length:6},(_,i)=>tail(end+1+i)-tail(end+i));
   return {id:e.expressionId,segmentedText:Boolean(e.textBinding),incomingVelocity,outgoingVelocity,velocityJump:outgoingVelocity-incomingVelocity,accelerationBefore,accelerationAfter,accelerationJump:accelerationAfter-accelerationBefore,beforeFrameSteps,afterFrameSteps,
    approach:typeof a.easing!=='string'&&a.easing.type==='inertiaHandoff'?{adjustedFromProgress:a.easing.parameters.join,endSlope:a.easing.parameters.endSlope,endAcceleration:a.easing.parameters.endAcceleration,wholeApproachFromRest:Boolean(a.easing.parameters.launchRest),endJerk:a.easing.parameters.endJerk,coupledResponse:a.easing.parameters.response,originalCurve:a.easing.parameters.base}:null,
    ambientEffects:(state.expressions??[]).filter(other=>other.enabled&&other.type==='wiggle'&&other.sceneId===e.sceneId&&other.targetId===e.targetId).map(other=>other.expressionId),units:'source property units',incomingStep:base(end)-base(end-1),firstTailStep:tail(end+1)-tail(end),peakTail:Math.max(...Array.from({length:65},(_,i)=>Math.abs(tail(end+e.durationFrames*i/64)))),note:'Compare recent frame steps, speed, acceleration, renewed pushes and visible displacement; these measurements are not artistic limits.'};
  }),
  transitions:(state.objectTransitions??[]).map(t=>({id:t.transitionId,endSeconds:(t.startFrame+t.durationFrames)/fps,withinMoveEffects:t.proceduralEffects.length,afterMoveEffects:(state.expressions??[]).filter(e=>e.enabled&&e.transitionId===t.transitionId).length,afterMoveChannels:(state.expressions??[]).filter(e=>e.enabled&&e.transitionId===t.transitionId).map(e=>e.property),note:'Within-move effects end with the transition; a requested settling tail needs its own expression. Inspect ALL moving pose channels: X-only inertia does not continue Y, scale or rotation.'}))};
}
