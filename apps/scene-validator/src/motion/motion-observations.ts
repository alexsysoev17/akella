import type {MotionState} from './schema.js';
import {evaluateAnimation} from './evaluation.js';
import {expressionValue} from './expressions.js';
/** Measurements for artistic decisions. These never gate edits or publication. */
export function motionObservations(state:MotionState){
 const fps=state.settings.fps;
 return {advisoryOnly:true,
  timing:state.animations.filter(a=>a.enabled).map(a=>({id:a.animationId,startSeconds:a.startFrame/fps,sceneMarkerSeconds:(state.blocks.find(b=>b.sceneId===a.sceneId)?.startFrame??0)/fps})),
  inertia:(state.expressions??[]).filter(e=>e.enabled&&e.type==='inertialOvershoot'&&!e.transitionId&&!e.textBinding).map(e=>{
   const a=state.animations.find(a=>'sourceAnimationId'in e&&a.animationId===e.sourceAnimationId);if(!a)return {id:e.expressionId,measurement:'SOURCE_UNAVAILABLE'};
   const end=a.startFrame+a.durationFrames,base=(f:number)=>{const v=evaluateAnimation(a,f);return v[e.property]??v.scale??0;};
   const tail=(f:number)=>expressionValue(e,f,fps,state.animations,evaluateAnimation);
   return {id:e.expressionId,units:'source property units',incomingStep:base(end)-base(end-1),firstTailStep:tail(end+1)-tail(end),peakTail:Math.max(...Array.from({length:65},(_,i)=>Math.abs(tail(end+e.durationFrames*i/64)))),note:'Compare incoming and outgoing speed and visible displacement; these measurements are not artistic limits.'};
  }),
  transitions:(state.objectTransitions??[]).map(t=>({id:t.transitionId,endSeconds:(t.startFrame+t.durationFrames)/fps,withinMoveEffects:t.proceduralEffects.length,afterMoveEffects:(state.expressions??[]).filter(e=>e.enabled&&e.transitionId===t.transitionId).length,note:'Within-move effects end with the transition; a requested settling tail needs its own expression.'}))};
}
