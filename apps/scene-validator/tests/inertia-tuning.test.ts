import test from 'node:test';
import assert from 'node:assert/strict';
import {tuneInertia} from '../src/motion/inertia-tuning.js';
import {evaluateAnimation} from '../src/motion/evaluation.js';
import {expressionValue} from '../src/motion/expressions.js';
import {evaluateEasing,easingSchema,type Easing} from '../src/motion-library/easings/registry.js';
import {type MotionState} from '../src/motion/schema.js';
import {scopedExpressionValue} from '../src/motion/transition-effects.js';
import {motionToolSchema} from '../src/motion/tools.js';
const curves:Easing[]=['linear','easeInQuad','easeOutQuad','easeOutCubic','easeInOutCubic','easeInOutQuint',{type:'cubicBezier',parameters:{x1:.85,y1:0,x2:.15,y2:1}}];
function fixture(easing:Easing,fps=30):MotionState{
 return {schemaVersion:'1.0.0',anchorDefault:'center',settings:{fps,width:1920,height:1080,durationFrames:fps*4,strictDuration:true,tailPolicy:'holdLastScene'},blocks:[],visibility:[],timingDependencies:[],objectTransitions:[],animations:[{animationId:'move',sceneId:'scene',targetId:'node',startFrame:0,durationFrames:fps,easing,enabled:true,effect:'keyframes',parameters:{property:'y',points:[{frame:0,value:-100},{frame:fps,value:0}]}}],expressions:[{expressionId:'tail',sceneId:'scene',targetId:'node',startFrame:fps,durationFrames:fps,enabled:true,type:'inertialOvershoot',property:'y',sourceAnimationId:'move',parameters:{amplitude:.05,frequency:3,decay:5,velocityLookbackFrames:2,velocitySampling:'lookback',mode:'ae'}}]} as MotionState;
}
function tuned(s:MotionState,approach:'adapt'|'preserve'='adapt'){
 const r=structuredClone(s);
 for(const op of tuneInertia(s,{tool:'tuneInertia',expressionId:'tail',approach,peakRatio:.08})){
  if(op.type==='updateAnimation')r.animations[r.animations.findIndex(a=>a.animationId===op.animationId)]=op.animation;
  if(op.type==='setExpression')r.expressions![r.expressions!.findIndex(e=>e.expressionId===op.expression.expressionId)]=op.expression;
  if(op.type==='animateObjectStateTransition')r.objectTransitions![0]=op;
 }
 return r;
}
for(const easing of curves)for(const fps of [24,30,60])test(`C2 arrival, bounded tail, retained early curve: ${JSON.stringify(easing)} @${fps}`,()=>{
 const s=fixture(easing,fps),r=tuned(s),a=r.animations[0],e=r.expressions![0];
 easingSchema.parse(a.easing);
 const base=(f:number)=>evaluateAnimation(a,f).y!,tail=(f:number)=>expressionValue(e,f,fps,r.animations,evaluateAnimation);
 const h=1e-4,v0=(base(fps)-base(fps-h))/(h/fps),v1=tail(fps+h)/(h/fps);
 assert.ok(Math.abs(v0-v1)<.03,`${v0} vs ${v1}`);
 const curve=a.easing as Extract<Easing,{type:'inertiaHandoff'}>;
 for(let i=0;i<20;i++){const t=curve.parameters.join*i/20;assert.equal(evaluateEasing(t,curve),evaluateEasing(t,easing));}
 let last=-100;
 for(let i=0;i<=1000;i++){const v=base(fps*i/1000);assert.ok(v>=last-1e-7&&v<=1e-7);last=v;}
 const values=Array.from({length:1001},(_,i)=>tail(fps+fps*i/1000));
 // Strength is a preference; do not force a minimum pixel peak by introducing a kick.
 assert.ok(Math.max(...values)>0&&Math.max(...values)<=8.01);
 const dt=.001;
 const beforeAcceleration=(base(fps)-2*base(fps-dt)+base(fps-2*dt))/(dt/fps)**2;
 const afterAcceleration=(tail(fps+2*dt)-2*tail(fps+dt))/(dt/fps)**2;
 assert.ok(Math.abs(beforeAcceleration-afterAcceleration)<Math.max(1,Math.abs(afterAcceleration))*.01);
 const q=curve.parameters,join=q.join*fps;
 if(join>0){const hh=.0002;const left=(base(join)-2*base(join-hh)+base(join-2*hh))/(hh/fps)**2;
 const right=(base(join+2*hh)-2*base(join+hh)+base(join))/(hh/fps)**2;
 assert.ok(Math.abs(left-right)<Math.max(.1,Math.abs(left)*.03),`bridge acceleration ${left} vs ${right}`);}
 // Once the fitted arrival begins braking it must never restart acceleration.
 let braking=false;
 for(let i=1;i<200;i++){const f=join+(fps-join)*i/200,h=.0001;
 const acc=(base(f+h)-2*base(f)+base(f-h))/(h/fps)**2;
 if(acc<-.01)braking=true;
 if(braking)assert.ok(acc<.05,`second push at ${f}: ${acc}`);}

 assert.ok(Math.min(...values)<0);assert.equal(values.at(-1),0);
 assert.ok(Math.abs(tail(2*fps-h)/(h/fps))<.01);
 assert.deepEqual(tuned(r),r,'repeated tuning is stable');
 // Evaluator is stateless: out-of-order requests match sequential evaluation.
 for(const i of [900,10,720,100,900])assert.equal(tail(fps+fps*i/1000),values[i]);
});
test('preserve keeps authored curves literally, stationary track has no manufactured momentum',()=>{
 for(const easing of curves){const s=fixture(easing),r=tuned(s,'preserve');assert.deepEqual(s.animations,r.animations);}
 const s=fixture('linear');const a=s.animations[0];if(a.effect==='keyframes')a.parameters.points[0].value=0;
 const r=tuned(s,'preserve');assert.equal(expressionValue(r.expressions![0],35,30,r.animations,evaluateAnimation),0);
});
test('only last multi-key segment gets a bridge; schema and tool discovery accept tuning',()=>{
 const s=fixture('easeOutQuad'),a=s.animations[0];if(a.effect==='keyframes')a.parameters.points=[{frame:0,value:-200},{frame:15,value:-100},{frame:30,value:0}];
 const r=tuned(s);for(let f=0;f<15;f+=.1)assert.equal(evaluateAnimation(r.animations[0],f).y,evaluateAnimation(a,f).y);
 assert.equal(motionToolSchema.parse({tool:'tuneInertia',expressionId:'tail',approach:'adapt'}).tool,'tuneInertia');
});
test('transition tail matches the actual interpolated position derivative',()=>{
 const s=fixture('easeInOutCubic');s.animations=[];
 s.objectTransitions=[{transitionId:'move',logicalObjectId:'object',fromSceneId:'before',toSceneId:'scene',startFrame:0,durationFrames:30,easing:'easeInOutCubic',proceduralEffects:[],layerPolicy:{mode:'switch',switchProgress:.5}} as any];
 const e=s.expressions![0];e.transitionId='move';e.ownership={scope:'transition'};
 const r=tuned(s),t=r.objectTransitions![0];
 const pose=(y:number)=>({sourceNodeId:'node',normalized:[[1,0,0],[0,1,y],[0,0,1]],parentCanvas:[[1,0,0],[0,1,0],[0,0,1]],local:[[1,0,0],[0,1,y],[0,0,1]],width:1,height:1,visible:true,opacity:1} as any);
 const p={object:{before:pose(-100),scene:pose(0)}};
 const h=.0001,expected=(1-evaluateEasing(1-h/30,t.easing))*100/(h/30);
 const actual=scopedExpressionValue(r,r.expressions![0],30+h,p)/(h/30);
 assert.ok(Math.abs(actual-expected)<.03,`${actual} vs ${expected}`);
});
test('distance, direction and movement duration scale actual momentum; text staggering stays authored',()=>{
 for(const distance of [-1200,-100,30,450])for(const frames of [12,24,60]){
  const s=fixture('easeOutQuad'),a=s.animations[0];a.durationFrames=frames;
  a.text={segmentation:'lines',staggerFrames:4} as any;
  if(a.effect==='keyframes')a.parameters.points=[{frame:0,value:distance},{frame:frames,value:0}];
  s.expressions![0].startFrame=frames;
  const r=tuned(s),e=r.expressions![0],base=(f:number)=>evaluateAnimation(r.animations[0],f).y!,tail=(f:number)=>expressionValue(e,f,30,r.animations,evaluateAnimation),h=1e-4;
  assert.deepEqual(r.animations[0].text,a.text);
  const incoming=(base(frames)-base(frames-h))/(h/30),outgoing=tail(frames+h)/(h/30);
  assert.ok(Math.abs(incoming-outgoing)<Math.max(1,Math.abs(incoming))*.001);
  assert.equal(Math.sign(tail(frames+1)),-Math.sign(distance));
 }
});

test('canonical weaker/frequency/decay edits retain coupled arrival, preserve control values and undo snapshot',async()=>{
 const {identityFixture,node}=await import('./identity-fixture.js');
 const {applyOperations}=await import('../src/motion/operations.js');
 const {readMotion,changeMotion}=await import('../src/motion/store.js');
 const f=await identityFixture(1,scenes=>{scenes[0].children=[node('node','Object')];});
 try{
  const initial=fixture('easeOutQuad'),doc=await readMotion(f.project);
  const a={...initial.animations[0],sceneId:'s0'},e={...initial.expressions![0],sceneId:'s0'};
  let s=applyOperations(doc.state,[{type:'setProjectSettings',settings:{...doc.state.settings,fps:30,durationFrames:120}},{type:'setBlocks',blocks:doc.state.blocks.map(b=>({...b,durationFrames:120}))},{type:'addAnimation',animation:a},{type:'setExpression',expression:e}],f.project);
  s=applyOperations(s,tuneInertia(s,{tool:'tuneInertia',expressionId:'tail',approach:'adapt',peakRatio:.04}),f.project);
  const peak=(s:MotionState)=>Math.max(...Array.from({length:501},(_,i)=>Math.abs(expressionValue(s.expressions![0],30+30*i/500,30,s.animations,evaluateAnimation))));
  const previousPeak=peak(s),old=structuredClone(s);
  const weak=applyOperations(s,[{type:'scaleExpressionParameter',expressionId:'tail',parameter:'amplitude',factor:.5}],f.project);
  assert.equal((weak.expressions![0].parameters as any).amplitude,(s.expressions![0].parameters as any).amplitude*.5);
  assert.ok(peak(weak)<=previousPeak*.501);assert.ok(peak(weak)>previousPeak*.1);
  assert.notDeepEqual(weak.animations,s.animations);
  assert.deepEqual(s,old,'input snapshot is immutable');
  const modified={...weak.expressions![0],parameters:{...weak.expressions![0].parameters,frequency:1.5,decay:4}};
  const edited=applyOperations(weak,[{type:'setExpression',expression:modified}],f.project);
  const tail=(frame:number)=>expressionValue(edited.expressions![0],frame,30,edited.animations,evaluateAnimation),base=(frame:number)=>evaluateAnimation(edited.animations[0],frame).y!,h=.0001;
  assert.ok(Math.abs((base(30)-base(30-h))/(h/30)-tail(30+h)/(h/30))<.05);
  assert.deepEqual(applyOperations(edited,[],f.project),edited,'no repeated fitting drift');
  const linear=applyOperations(edited,[{type:'setEasing',animationId:'move',easing:'linear'}],f.project);
  assert.equal((linear.animations[0].easing as any).parameters.base,'linear','curve edits keep the response linked');
  const preserve=applyOperations(linear,[{type:'setEasing',animationId:'move',easing:'linear'},...tuneInertia({...linear,animations:[{...linear.animations[0],easing:'linear'}]},{tool:'tuneInertia',expressionId:'tail',approach:'preserve'})],f.project);
  assert.equal(preserve.animations[0].easing,'linear','explicit preserve does not rewrap the requested easing');
  const zero=applyOperations(edited,[{type:'setExpression',expression:{...edited.expressions![0],parameters:{...edited.expressions![0].parameters,amplitude:0}}}],f.project);
  assert.ok(peak(zero)<1e-4);
  const restored=applyOperations(zero,[{type:'setExpression',expression:edited.expressions![0]}],f.project);
  assert.ok(peak(restored)>.01,'amplitude can recover after zero');
  const commit=await changeMotion(f.project.root,{expectedRevision:doc.revision,request:'coupled fixture',operations:[{type:'setProjectSettings',settings:edited.settings},{type:'setBlocks',blocks:edited.blocks},{type:'addAnimation',animation:edited.animations[0]},{type:'setExpression',expression:edited.expressions![0]}]});
  const saved=(await readMotion(f.project)).state;assert.deepEqual(saved.animations,edited.animations);
  await changeMotion(f.project.root,{expectedRevision:commit.document.revision,request:'undo',action:'undo'});
  assert.deepEqual((await readMotion(f.project)).state,doc.state);
 }finally{await f.cleanup();}
});

test('continuous approach has rest launch and matches the tail through jerk without a braking restart',async()=>{
 const {continuousArrival}=await import('../src/motion-library/easings/handoff.js');
 for(const durationFrames of [18,24,30]){
 const s=fixture('easeOutQuad'),a=s.animations[0];a.durationFrames=durationFrames;
 if(a.effect==='keyframes')a.parameters.points[1].frame=durationFrames;s.expressions![0].startFrame=durationFrames;
 const ops=tuneInertia(s,{tool:'tuneInertia',expressionId:'tail',approach:'continuous',peakRatio:.05,frequency:1.25,decay:3.8});
 const updated=ops.find(op=>op.type==='updateAnimation')!;assert.equal(updated.type,'updateAnimation');if(updated.type!=='updateAnimation')return;
 const q=(updated.animation.easing as any).parameters;
 const end=continuousArrival(1,q.endSlope,q.endAcceleration,q.endJerk),start=continuousArrival(0,q.endSlope,q.endAcceleration,q.endJerk);
 assert.deepEqual(start,{value:0,velocity:0,acceleration:0,jerk:0});
 assert.ok(Math.abs(end.value-1)<1e-10);assert.ok(Math.abs(end.velocity-q.endSlope)<1e-10);assert.ok(Math.abs(end.acceleration-q.endAcceleration)<1e-9);assert.ok(Math.abs(end.jerk-q.endJerk)<1e-8);
 let braking=false;for(let i=1;i<1000;i++){const v=continuousArrival(i/1000,q.endSlope,q.endAcceleration,q.endJerk);if(v.acceleration< -1e-6)braking=true;assert.ok(v.velocity>=0);if(braking)assert.ok(v.acceleration<=1e-5);}
 }
});

test('continuous transition carries the entire translated, scaled and rotated pose past arrival',async()=>{
 const {compose,transitionOffsetMatrix}=await import('../src/motion/geometry.js');
 const {interpolateState}=await import('../src/motion/transition-runtime.js');
 const {transformPoint}=await import('../src/motion/anchor.js');
 const s=fixture('easeInOutCubic');s.animations=[];
 s.objectTransitions=[{transitionId:'move',logicalObjectId:'object',fromSceneId:'before',toSceneId:'scene',startFrame:0,durationFrames:30,easing:'easeInOutCubic',proceduralEffects:[],layerPolicy:{type:'switch',switchProgress:.5}} as any];
 const e=s.expressions![0];e.property='x';e.transitionId='move';e.ownership={scope:'transition'};
 for(const op of tuneInertia(s,{tool:'tuneInertia',expressionId:'tail',approach:'continuous',peakRatio:.035,frequency:1.25,decay:3.8})){
  if(op.type==='animateObjectStateTransition')s.objectTransitions![0]=op;
  if(op.type==='setExpression'){const i=s.expressions!.findIndex(e=>e.expressionId===op.expression.expressionId);if(i<0)s.expressions!.push(op.expression);else s.expressions![i]=op.expression;}
 }
 assert.deepEqual(s.expressions!.map(e=>e.property).sort(),['rotation','scaleX','scaleY','x','y']);
 const pose=(x:number,y:number,scale:number,rotation:number)=>({sourceNodeId:'node',normalized:compose({x,y,scaleX:scale,scaleY:scale,rotation,shear:0}),parentCanvas:[[1,0,0],[0,1,0]],local:[[1,0,0],[0,1,0]],width:1,height:1,visible:true,opacity:1} as any);
 const refs={object:{before:pose(0,300,300,0),scene:pose(600,100,180,.14)}};
 const matrix=(f:number)=>{const base=interpolateState(refs.object.before,refs.object.scene,s.objectTransitions![0],f,s);const offsets=Object.fromEntries(s.expressions!.map(e=>[e.property,scopedExpressionValue(s,e,f,refs)]));return transitionOffsetMatrix(base.matrix,offsets,base.anchor?transformPoint(base.matrix,base.anchor):undefined);};
 const h=.0001;
 for(const point of [{x:0,y:0},{x:1,y:1},{x:.5,y:.5}]){
 const a=transformPoint(matrix(30-h),point),b=transformPoint(matrix(30),point),c=transformPoint(matrix(30+h),point);
 for(const k of ['x','y'] as const){const v0=(b[k]-a[k])/(h/30),v1=(c[k]-b[k])/(h/30);assert.ok(Math.abs(v0-v1)<.1,`${k}: ${v0} vs ${v1}`);}
 }
});

test('co-timed XY entrances share their flow and later strength edits; deleted companions stay deleted',async()=>{
 const {identityFixture,node}=await import('./identity-fixture.js');const {applyOperations}=await import('../src/motion/operations.js');
 const f=await identityFixture(1,scenes=>{scenes[0].children=[node('node','Object')];});
 try{
 const s=fixture('easeOutQuad'),a={...s.animations[0],sceneId:'s0'},e={...s.expressions![0],sceneId:'s0'};
 const x={...a,animationId:'moveX',effect:'keyframes',parameters:{property:'x',points:[{frame:0,value:-50},{frame:30,value:0}]}};
 let state=applyOperations(f.state,[{type:'setProjectSettings',settings:{...f.state.settings,fps:30,durationFrames:120}},{type:'setBlocks',blocks:f.state.blocks.map(b=>({...b,startFrame:0,durationFrames:120}))},{type:'addAnimation',animation:a},{type:'addAnimation',animation:x},{type:'setExpression',expression:e}],f.project);
 state=applyOperations(state,tuneInertia(state,{tool:'tuneInertia',expressionId:'tail',approach:'continuous',peakRatio:.04,frequency:1.25,decay:3.8}),f.project);
 for(const factor of [1,.5]){
  if(factor!==1)state=applyOperations(state,[{type:'scaleExpressionParameter',expressionId:'tail',parameter:'amplitude',factor}],f.project);
  const x=state.animations.find(a=>a.animationId==='moveX')!,y=state.animations.find(a=>a.animationId==='move')!;
  for(let f=0;f<=30;f+=.2)assert.ok(Math.abs(evaluateAnimation(x,f).x!*.02-evaluateAnimation(y,f).y!*.01)<1e-8);
  const ex=state.expressions!.find(e=>e.property==='x')!,ey=state.expressions!.find(e=>e.property==='y')!;
  for(let f=30;f<=60;f+=.2)assert.ok(Math.abs(expressionValue(ex,f,30,state.animations,evaluateAnimation)*2-expressionValue(ey,f,30,state.animations,evaluateAnimation))<1e-5);
 }
 const companion=state.expressions!.find(e=>e.property==='x')!;
 state=applyOperations(state,[{type:'removeExpression',expressionId:companion.expressionId}],f.project);
 state=applyOperations(state,[{type:'scaleExpressionParameter',expressionId:'tail',parameter:'amplitude',factor:.5}],f.project);
 assert.ok(!state.expressions!.some(e=>e.expressionId===companion.expressionId));
 }finally{await f.cleanup();}
});
