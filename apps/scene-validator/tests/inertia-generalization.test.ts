import test from 'node:test';
import assert from 'node:assert/strict';
import {tuneInertia} from '../src/motion/inertia-tuning.js';
import {evaluateAnimation} from '../src/motion/evaluation.js';
import {expressionValue} from '../src/motion/expressions.js';
import {scopedExpressionValue} from '../src/motion/transition-effects.js';
import {interpolateState} from '../src/motion/transition-runtime.js';
import {compose,transitionOffsetMatrix,poseScaleBasis} from '../src/motion/geometry.js';
import {transformPoint} from '../src/motion/anchor.js';
import {motionKnowledge} from '../src/motion-library/knowledge.js';
import type {MotionState} from '../src/motion/schema.js';
function fixture(fps=30,seconds=1,distance=100,property='y'):MotionState{
 const duration=Math.round(seconds*fps);
 return {schemaVersion:'1.0.0',anchorDefault:'center',settings:{fps,durationFrames:fps*8,width:1080,height:1080,strictDuration:true},blocks:[],visibility:[],animations:[{animationId:'path',sceneId:'destination',targetId:'shape',effect:'keyframes',parameters:{property,points:[{frame:0,value:distance},{frame:duration,value:0}]},startFrame:0,durationFrames:duration,easing:'easeOutQuad',enabled:true}],expressions:[{expressionId:'response',sceneId:'destination',targetId:'shape',type:'inertialOvershoot',property,sourceAnimationId:'path',enabled:true,startFrame:duration,durationFrames:fps*2,parameters:{amplitude:.08,frequency:1.5,decay:3,velocityLookbackFrames:2,mode:'ae'}}]} as MotionState;
}
function apply(s:MotionState,frequency:number,decay:number){
 const result=structuredClone(s);
 for(const op of tuneInertia(s,{tool:'tuneInertia',expressionId:'response',approach:'continuous',peakRatio:.04,frequency,decay})){
  if(op.type==='updateAnimation')result.animations[result.animations.findIndex(a=>a.animationId===op.animationId)]=op.animation;
  if(op.type==='animateObjectStateTransition')result.objectTransitions![0]=op;
  if(op.type==='setExpression'){const i=result.expressions!.findIndex(e=>e.expressionId===op.expression.expressionId);if(i<0)result.expressions!.push(op.expression);else result.expressions![i]=op.expression;}
 }
 return result;
}
test('288 independent motions: distance/direction, duration, FPS, frequency and damping',()=>{
 let count=0;
 for(const fps of [24,30,60])for(const seconds of [.3,.6,1,1.5])for(const distance of [-800,-20,35,500])for(const frequency of [.7,1.4,2.2])for(const decay of [2,5]){
  const property=count%2?'x':'y',original=fixture(fps,seconds,distance,property),s=apply(original,frequency,decay),a=s.animations[0],e=s.expressions![0],end=a.durationFrames;
  const base=(f:number)=>evaluateAnimation(a,f)[property]!,tail=(f:number)=>expressionValue(e,f,fps,s.animations,evaluateAnimation);
  assert.equal(base(0),distance);assert.equal(base(end),0);assert.deepEqual(apply(s,frequency,decay),s);
  let last=distance;
  for(let i=1;i<=100;i++){const value=base(end*i/100);assert.ok(Number.isFinite(value));assert.ok((value-last)*Math.sign(distance)<=1e-6);last=value;}
  const h=.0001,vin=(base(end)-base(end-h))/(h/fps),vout=tail(end+h)/(h/fps);
  assert.ok(Math.abs(vin-vout)<Math.max(.02,Math.abs(vin)*.003));
  const peak=Math.max(...Array.from({length:129},(_,i)=>Math.abs(tail(end+e.durationFrames*i/128))));
  assert.ok(peak<=Math.abs(distance)*.0401);assert.equal(tail(end+e.durationFrames),0);
  count++;
 }
 assert.equal(count,288);
});

test('approved guidance is retrievable for text inertia and by explicit ID in unrelated requests',async()=>{
 for(const [request,textSelected,ids] of [['текст с инерцией',true,[]],['continue the previous edit',false,['inertia-continuity']]] as const){
  const knowledge=await motionKnowledge(request,textSelected,[...ids]);
  assert.ok(knowledge.skills.some(s=>s.id==='inertia-continuity'&&s.text.length>100));
  if(textSelected)assert.ok(knowledge.skills.some(s=>s.id==='kinetic-typography'));
 }
 assert.equal((await motionKnowledge('change opacity',false)).skills.some(s=>s.id==='inertia-continuity'),false);
});

test('unversioned rotated scale effects retain their canvas-axis composition',()=>{
 const base=compose({x:20,y:40,scaleX:100,scaleY:200,rotation:.6,shear:0}),offset={scaleX:.2,scaleY:-.1};
 assert.equal(poseScaleBasis('linear'),'canvas');
 assert.equal(poseScaleBasis({type:'inertiaHandoff',parameters:{launchRest:true}}),'canvas');
 assert.deepEqual(transitionOffsetMatrix(base,offset),transitionOffsetMatrix(base,offset,undefined,'canvas'));
 assert.notDeepEqual(transitionOffsetMatrix(base,offset),transitionOffsetMatrix(base,offset,undefined,'local'));
});

test('16 pose changes include rotated nonuniform scaling and reflections',()=>{
 for(const angle of [-.8,-.25,.35,1.1])for(const scales of [[180,180],[180,300],[350,140],[180,-220]]){
  const s=fixture();s.animations=[];s.objectTransitions=[{transitionId:'path',logicalObjectId:'identity',fromSceneId:'source',toSceneId:'destination',startFrame:0,durationFrames:30,easing:'easeInOutSine',proceduralEffects:[],layerPolicy:{type:'switch',switchProgress:.5}} as any];
  const e=s.expressions![0];e.property='x';e.transitionId='path';e.ownership={scope:'transition'};
  const r=apply(s,1.4,4),t=r.objectTransitions![0];
  const pose=(x:number,y:number,sx:number,sy:number,rotation:number)=>({sourceNodeId:'shape',normalized:compose({x,y,scaleX:sx,scaleY:sy,rotation,shear:0}),parentCanvas:[[1,0,0],[0,1,0]],local:[[1,0,0],[0,1,0]],width:1,height:1,opacity:1,visible:true} as any);
  const refs={identity:{source:pose(-100,200,300,300*Math.sign(scales[1]),-.1),destination:pose(400,-100,scales[0],scales[1],angle)}};
  const matrix=(frame:number)=>{const p=interpolateState(refs.identity.source,refs.identity.destination,t,frame,r),offset=Object.fromEntries(r.expressions!.map(e=>[e.property,scopedExpressionValue(r,e,frame,refs)]));return transitionOffsetMatrix(p.matrix,offset,p.anchor?transformPoint(p.matrix,p.anchor):undefined,poseScaleBasis(t.easing));};
  const h=.0001;
  for(const point of [{x:0,y:0},{x:1,y:1},{x:.5,y:.5}]){const p0=transformPoint(matrix(30-h),point),p1=transformPoint(matrix(30),point),p2=transformPoint(matrix(30+h),point);
   for(const axis of ['x','y'] as const){const before=(p1[axis]-p0[axis])*30/h,after=(p2[axis]-p1[axis])*30/h;assert.ok(Math.abs(before-after)<.1,JSON.stringify({angle,scales,axis,before,after}));}
  }
 }
});
