import {z} from 'zod';
import type {MotionState,Operation} from './schema.js';
import {evaluateEasing,handoffParameters,type Easing} from '../motion-library/easings/registry.js';
import {curveSlope,curveAcceleration,accelerationBridge,continuousArrival} from '../motion-library/easings/handoff.js';
import {windowOffset} from '../motion-library/expressions/functions.js';

export const inertiaTuningSchema=z.object({
  tool:z.literal('tuneInertia'), expressionId:z.string().min(1),
  approach:z.enum(['preserve','adapt','continuous']),
  peakRatio:z.number().finite().min(0).max(.5).default(.04),
  frequency:z.number().finite().min(.1).max(20).default(2),
  decay:z.number().finite().min(.1).max(30).default(3),
}).strict().describe('Tune an existing inertia and its base together. preserve keeps the exact authored curve and matches tail velocity (flat arrival may have no bounce). adapt explicitly reshapes only the final approach with a C2 acceleration-matched bridge; peakRatio is desired tail displacement / last-segment travel, not a guarantee or gate. Earlier curve, poses, timing, identity and text staggering stay intact. continuous rebuilds the complete single movement from rest, matching velocity/acceleration/jerk to the tail and adding all transform companions for transitions/moveTo. This intentionally changes the whole approach; preserve is for fixed authored curves. Supports base tracks and state transitions. Sibling inertia on the same source is velocity-matched too. Does not add or delete wiggle.');

/** No project-global repair, fabricated impulse, alternating oscillation keys or admission threshold. */
export function tuneInertia(state:MotionState,input:unknown,createCompanions=true):Operation[]{
  const c=inertiaTuningSchema.parse(input);
  const e=state.expressions?.find(e=>e.expressionId===c.expressionId);
  if(!e||e.type!=='inertialOvershoot'||!e.enabled)throw Error('TUNING_REQUIRES_ENABLED_INERTIA');
  const a=state.animations.find(a=>a.animationId===e.sourceAnimationId);
  const transition=e.transitionId?state.objectTransitions?.find(t=>t.transitionId===e.transitionId):undefined;
  const source=transition??a;
  if(!source||("enabled" in source&&!source.enabled))throw Error('TUNING_SOURCE_UNAVAILABLE');
  let frames=source.durationFrames, end=source.startFrame+frames;
  if(a&&!transition&&a.effect==='keyframes'){
    const points=a.parameters.points;
    frames=points.at(-1)!.frame-points.at(-2)!.frame;
    end=a.startFrame+points.at(-1)!.frame;
    if(c.approach!=='preserve'&&points.at(-1)!.value===points.at(-2)!.value)throw Error('TUNING_SELECT_MOVEMENT_BEFORE_HOLD');
  }
  if(e.startFrame!==end)throw Error('TUNING_REQUIRES_MATCHED_MOVEMENT_ENDPOINT');
  const fps=state.settings.fps, seconds=frames/fps, duration=e.durationFrames/fps;
  const omega=2*Math.PI*c.frequency;
  // Unit initial velocity response, including the actual finite tail envelope.
  let unitPeak=0;
  for(let i=1;i<2048;i++){
    const t=duration*i/2048;
    unitPeak=Math.max(unitPeak,Math.abs(Math.sin(omega*t)/omega*Math.exp(-c.decay*t)*windowOffset(t,duration,false)));
  }
  let easing:Easing=source.easing;
  if(c.approach==='continuous'){
    if(a&&!transition&&a.effect==='keyframes'&&a.parameters.points.length!==2)throw Error('CONTINUOUS_ARRIVAL_REQUIRES_SINGLE_MOVEMENT_SEGMENT');
    const base=typeof easing!=='string'&&easing.type==='inertiaHandoff'?easing.parameters.base:easing;
    let selected:Easing|undefined;
    for(const scale of [1,.9,.8,.7,.6,.5,.4,.3,.2,.1,.05,0]){
      const endSlope=unitPeak>0?c.peakRatio*seconds/unitPeak*scale:0;
      const endAcceleration=-2*c.decay*seconds*endSlope;
      const endJerk=(3*c.decay*c.decay-omega*omega)*seconds*seconds*endSlope;
      let braking=false,ok=true;
      for(let i=1;i<=512;i++){const q=continuousArrival(i/512,endSlope,endAcceleration,endJerk);
        if(q.acceleration< -1e-6)braking=true;
        if(q.velocity< -1e-7||q.value< -1e-7||q.value>1+1e-7||braking&&q.acceleration>1e-5){ok=false;break;}
      }
      if(ok){selected={type:'inertiaHandoff',parameters:handoffParameters.parse({base,join:0,launchRest:true,...(transition?{poseScaleBasis:'local'}:{}),endSlope,endAcceleration,endJerk,response:{approach:'continuous',expressionId:e.expressionId,peakRatio:endSlope*unitPeak/seconds,peakPerAmplitude:e.parameters.amplitude>0?endSlope*unitPeak/seconds/e.parameters.amplitude:(typeof easing!=='string'&&easing.type==='inertiaHandoff'?easing.parameters.response?.peakPerAmplitude:0)??0,amplitude:e.parameters.amplitude,frequency:c.frequency,decay:c.decay,durationSeconds:seconds,tailSeconds:duration}})};break;}
    }
    easing=selected!;
  }else if(c.approach==='adapt'){
    // Unwrap our own previous tuning; repeated calls cannot progressively distort the curve.
    const base=typeof easing!=='string'&&easing.type==='inertiaHandoff'?easing.parameters.base:easing;
    const sample=(t:number)=>evaluateEasing(t,base);
    const slope=unitPeak>0?c.peakRatio*seconds/unitPeak:0;
    // Fit a whole braking interval, not just a matching derivative at one point.
    // Search lower peaks too: requested strength is a preference, never an excuse
    // for braking then accelerating again just before the tail.
    let selected:Easing|undefined,best=Infinity;
    const scales=[1,.9,.8,.7,.6,.5,.4,.3,.2,.1,.05];
    for(const scale of scales){
      const outgoing=slope*scale,endAcceleration=-2*c.decay*seconds*outgoing;
      for(let step=18;step>=0;step--){
        const join=step/20;
        if((1-join)*seconds<Math.min(seconds*.5,Math.max(3/fps,.12)))continue;
        const value=sample(join),incoming=curveSlope(sample,join),acceleration=curveAcceleration(sample,join);
        const bridge=accelerationBridge(join,value,incoming,outgoing,acceleration,endAcceleration);
        let ok=value>=0&&value<=1&&incoming>=-1e-7,braking=acceleration< -1e-5;
        let jerkCost=0,deviation=0;
        for(let i=0;i<=128&&ok;i++){
          const t=join+(1-join)*i/128,q=bridge(t);
          if(q.acceleration < -1e-5)braking=true;
          // Once braking has begun, no second push is introduced by the fitter.
          if(q.velocity< -1e-7||q.value<value-1e-7||q.value>1+1e-7||braking&&q.acceleration>1e-4)ok=false;
          jerkCost+=q.jerk*q.jerk/129;
          deviation+=(q.value-sample(t))**2/129;
        }
        // Prefer restrained curvature and keeping the authored trajectory. A
        // modestly smaller peak is better than an aggressive compensating push.
        const score=Math.log1p(jerkCost)*.002+deviation*8+(1-scale)**2+(1-join)*.5;
        if(ok&&score<best){best=score;selected={type:'inertiaHandoff',parameters:handoffParameters.parse({base,join,endSlope:outgoing,endAcceleration,
          response:{expressionId:e.expressionId,peakRatio:outgoing*unitPeak/seconds,peakPerAmplitude:e.parameters.amplitude>0?outgoing*unitPeak/seconds/e.parameters.amplitude:(typeof source.easing!=="string"&&source.easing.type==="inertiaHandoff"?source.easing.parameters.response?.peakPerAmplitude:0)??0,amplitude:e.parameters.amplitude,frequency:c.frequency,decay:c.decay,durationSeconds:seconds,tailSeconds:duration}})};}
      }
    }
    if(!selected)throw Error('TUNING_NO_SMOOTH_BRAKING_APPROACH_USE_PRESERVE_OR_LOWER_PEAK');
    easing=selected;
  }
  const operations:Operation[]=[];
  if(c.approach!=='preserve'){
    if(transition)operations.push({type:'animateObjectStateTransition',...transition,easing});
    else operations.push({type:'updateAnimation',animationId:a!.animationId,animation:{...a!,easing}});
  }
  const siblings=[...(state.expressions??[])];
  if(c.approach==='continuous'){
    // A state transition is a complete pose, not merely the selected X channel.
    const properties=transition?['x','y','rotation','scaleX','scaleY']:a?.effect==='moveTo'?['x','y']:[];
    for(const property of properties){
      if(siblings.some(other=>other.type==='inertialOvershoot'&&other.enabled&&other.sourceAnimationId===e.sourceAnimationId&&other.property===property))continue;
      if(!createCompanions)continue;
      const expressionId=e.expressionId.slice(0,140)+'_flow_'+property;
      if(siblings.some(other=>other.expressionId===expressionId))throw Error('FLOW_COMPANION_ID_COLLISION');
      siblings.push({...e,expressionId,property:property as typeof e.property});
    }
  }
  for(const sibling of siblings){
    if(sibling.type!=='inertialOvershoot'||!sibling.enabled||sibling.sourceAnimationId!==e.sourceAnimationId||sibling.transitionId!==e.transitionId)continue;
    const frequency=c.approach==='continuous'||sibling.expressionId===e.expressionId?c.frequency:sibling.parameters.frequency;
    operations.push({type:'setExpression',expression:{...sibling,parameters:{...sibling.parameters,
      mode:'ae',velocitySampling:'endpointExact',settlingEnvelope:'smoothTail',
      ...(c.approach!=='preserve'&&sibling.expressionId===e.expressionId?{responseMode:'coupled' as const,amplitude:sibling.parameters.amplitude}:{responseMode:undefined,amplitude:1/(2*Math.PI*frequency)}),frequency,
      decay:c.approach==='continuous'||sibling.expressionId===e.expressionId?c.decay:sibling.parameters.decay,
    }}});
  }
  if(c.approach==='continuous'&&a&&!transition&&typeof easing!=='string'&&easing.type==='inertiaHandoff'&&['x','y'].includes(e.property)){
    const property=(track:typeof a)=>track.effect==='keyframes'||track.effect==='property'?track.parameters.property:undefined;
    for(const peer of state.animations){
      const channel=property(peer);
      if(peer.animationId===a.animationId||!peer.enabled||peer.sceneId!==a.sceneId||peer.targetId!==a.targetId||peer.startFrame!==a.startFrame||peer.durationFrames!==a.durationFrames||!channel||!['x','y'].includes(channel)||channel===e.property)continue;
      const existing=state.expressions?.find(x=>x.type==='inertialOvershoot'&&x.sourceAnimationId===peer.animationId&&x.property===channel);
      if(existing&&!existing.enabled||!existing&&!createCompanions)continue;
      const expressionId=existing?.expressionId??e.expressionId.slice(0,140)+'_flow_'+channel;
      if(!existing&&state.expressions?.some(x=>x.expressionId===expressionId))throw Error('FLOW_COMPANION_ID_COLLISION');
      const {response,...shape}=easing.parameters;
      operations.push({type:'updateAnimation',animationId:peer.animationId,animation:{...peer,easing:{type:'inertiaHandoff',parameters:handoffParameters.parse(shape)}}});
      operations.push({type:'setExpression',expression:{...e,...existing,expressionId,sourceAnimationId:peer.animationId,property:channel as 'x'|'y',parameters:{...e.parameters,mode:'ae',velocitySampling:'endpointExact',settlingEnvelope:'smoothTail',responseMode:undefined,amplitude:1/omega,frequency:c.frequency,decay:c.decay}} as typeof e});
    }
  }
  return operations;
}

/** Keep explicit coupled arrivals coherent under ordinary parameter edits.
 * Called once after canonical edits/retiming/rules, never from the renderer.
 * The stored amplitude remains the user's control; strength is transferred to
 * the approach instead of multiplying the tail's first velocity into a jump.
 */
export function reconcileInertiaResponses(state:MotionState,previous?:MotionState){
  for(const source of [...state.animations,...state.objectTransitions??[]]){
    const easing=source.easing;
    const oldSource='animationId' in source?previous?.animations.find(a=>a.animationId===source.animationId):previous?.objectTransitions?.find(t=>t.transitionId===source.transitionId);
    const oldEasing=oldSource?.easing;
    const oldResponse=oldEasing&&typeof oldEasing!=='string'&&oldEasing.type==='inertiaHandoff'?oldEasing.parameters.response:undefined;
    const response=typeof easing!=='string'&&easing.type==='inertiaHandoff'?easing.parameters.response:undefined;
    const r=response??oldResponse;
    if(!r)continue;
    const changedCurve=!response||Boolean(oldResponse&&JSON.stringify(response)===JSON.stringify(oldResponse)&&typeof easing!=='string'&&easing.type==='inertiaHandoff'&&typeof oldEasing!=='string'&&oldEasing?.type==='inertiaHandoff'&&JSON.stringify(easing.parameters.base)!==JSON.stringify(oldEasing.parameters.base));
    const e=state.expressions?.find(e=>e.expressionId===r.expressionId);
    if(!e||e.type!=='inertialOvershoot'||!e.enabled||e.parameters.responseMode!=='coupled')continue;
    if(e.sourceAnimationId!==('animationId' in source?source.animationId:source.transitionId))continue;
    const frames='effect' in source&&source.effect==='keyframes'
      ?source.parameters.points.at(-1)!.frame-source.parameters.points.at(-2)!.frame:source.durationFrames;
    const p=e.parameters,seconds=frames/state.settings.fps,tailSeconds=e.durationFrames/state.settings.fps;
    if(!changedCurve&&p.amplitude===r.amplitude&&p.frequency===r.frequency&&p.decay===r.decay&&seconds===r.durationSeconds&&tailSeconds===r.tailSeconds)continue;
    const peakRatio=r.peakPerAmplitude!==undefined?r.peakPerAmplitude*p.amplitude:r.peakRatio*(r.amplitude>0?p.amplitude/r.amplitude:1);
    const operations=tuneInertia(state,{tool:'tuneInertia',expressionId:e.expressionId,approach:r.approach??'adapt',peakRatio:Math.min(.5,peakRatio),frequency:p.frequency,decay:p.decay},false);
    for(const op of operations){
      if(op.type==='updateAnimation')state.animations[state.animations.findIndex(a=>a.animationId===op.animationId)]=op.animation;
      if(op.type==='animateObjectStateTransition'){const {type,...transition}=op;state.objectTransitions![state.objectTransitions!.findIndex(t=>t.transitionId===op.transitionId)]=transition;}
      if(op.type==='setExpression'){const index=state.expressions!.findIndex(x=>x.expressionId===op.expression.expressionId);if(index<0)state.expressions!.push(op.expression);else state.expressions![index]=op.expression;}
    }
  }
}
