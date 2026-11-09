import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {identityFixture,node} from './identity-fixture.js';
import {logicalId} from '../src/motion/registry.js';
import {WorkingRevision} from '../src/motion/working-revision.js';
import {statePresentation} from '../src/motion/transitions.js';
import {evaluateMotion} from '../src/motion/evaluation.js';
import {expressionValue} from '../src/motion/expressions.js';
import {evaluateAnimation} from '../src/motion/evaluation.js';
import {renderNativeFrame,closeNativeRenderer} from '../src/native/client.js';
import {interpolateState} from '../src/motion/transition-runtime.js';
import {scopedExpressionValue} from '../src/motion/transition-effects.js';
import {expressionSchema} from '../src/motion-library/expressions/registry.js';
import {effectiveMotionModel} from '../src/motion/model-policy.js';
import {transitionOffsetMatrix,multiply} from '../src/motion/geometry.js';
import {transformPoint} from '../src/motion/anchor.js';
import {compactProviderFeedback} from '../src/motion/agent-runtime.js';
import {readMotion,changeMotion} from '../src/motion/store.js';
import {exportVideo} from '../src/motion/video.js';
import {createHash} from 'node:crypto';
after(()=>closeNativeRenderer());
test('Astra Medium default is independent of prompt size and explicit choices remain explicit',()=>{
 assert.deepEqual(effectiveMotionModel({provider:'codex-sdk',model:''}),{model:'gpt-6-astra',reasoningEffort:'medium'});
 assert.deepEqual(effectiveMotionModel({provider:'codex-sdk',model:'explicit-model',reasoningEffort:'low'}),{model:'explicit-model',reasoningEffort:'low'});
});
test('unchanged inspection/schema results retain one full copy, errors stay intact',()=>{
 const result={entries:Array.from({length:50},(_,i)=>({expressionId:'effect'+i,parameters:{amplitude:4,frequency:2}}))};
 const entry={results:[{call:{tool:'inspectExpressions',callId:'a',argumentsJson:'{}'},observedDigest:'state',result}]};
 const projected:any[]=compactProviderFeedback([entry,entry,{results:[{call:{tool:'edit'},error:{code:'GENUINE_CONFLICT'}}]}],'state') as any[];
 assert.equal(projected[0].results[0].result.status,'DUPLICATE_OBSERVATION');assert.deepEqual(projected[1].results[0].result,result);assert.equal(projected[2].results[0].error.code,'GENUINE_CONFLICT');assert.ok(JSON.stringify(projected).length<JSON.stringify([entry,entry,entry]).length);
});
for(const timelinePolicy of ['referenceStates','storyboardBoundary']as const)test('500б global wiggle phase and rendered pose survive '+timelinePolicy+' handoff at 30 FPS',async()=>{
 const f=await identityFixture(3,scenes=>scenes.forEach(s=>s.children.forEach(n=>n.name='500б')));
 try{
 const state=structuredClone(f.state);state.settings={...state.settings,width:200,height:120,fps:30,durationFrames:240};
 state.blocks.forEach((b,i)=>{b.startFrame=[0,90,165][i];b.durationFrames=[90,75,75][i];});
 const transition={...f.transition,logicalObjectId:logicalId('500б'),startFrame:150,durationFrames:30,timelinePolicy,layerPolicy:{type:'switch'as const,switchProgress:.5}};
 const w=new WorkingRevision(f.project,'fixture',state,'Добавь 500б лёгкое покачивание','minimal');
 w.apply([{type:'animateObjectStateTransition',...transition}],'transition');
 for(const [property,amplitude]of [['x',4],['rotation',2],['scaleX',.03]]as const)w.apply({tool:'addEffect',expression:{expressionId:'secondary-'+property,sceneId:'s1',targetId:'qr1',property,type:'wiggle',enabled:true,startFrame:100,durationFrames:130,parameters:{amplitude,frequency:1.5,seed:7,temporalMode:'continuous'}}},property,true);
 assert.ok(w.state.expressions!.every(e=>e.ownership?.scope==='logicalObject'));assert.equal(w.state.animations.length,0);
 const originalEffectCount=w.state.expressions!.length;const repeated=structuredClone(w.state.expressions![0]);delete repeated.ownership;w.apply({tool:'addEffect',expression:repeated},'repeat-same-effect',true);assert.equal(w.state.expressions!.length,originalEffectCount);
 const presentation=statePresentation(f.project,w.state),frames=[149,150,151,164,165,166,179,180,181];
 for(const frame of frames){
  const evaluation=evaluateMotion(w.state,frame,presentation),expected=expressionValue(w.state.expressions![0],frame,30,[],evaluateAnimation);
  const actual=frame<150?evaluation.nodes[JSON.stringify(['s1','qr1'])].x:evaluation.transitionEffects[transition.transitionId].x;
  assert.ok(Math.abs(actual!-expected)<1e-10,JSON.stringify({frame,actual,expected}));
  const rendered=await renderNativeFrame(f.project,w.state,frame,{diagnostics:true,encoding:'rgba'});
  const again=await renderNativeFrame(f.project,w.state,frame,{diagnostics:true,encoding:'rgba'});assert.deepEqual(rendered.png,again.png);
  const host=frame<165?'s1':'s2',instance=rendered.composition!.instances.find(i=>i.sceneId===host&&i.targetId===(host==='s1'?'qr1':'qr2'));
  assert.ok(instance?.visible);assert.ok(instance.transform!.flat().every(Number.isFinite));
  {
   const refs=presentation[transition.logicalObjectId],base=interpolateState(refs.s1,refs.s2,transition,frame,w.state),ref=refs[host];
   const expectedMatrix=multiply(transitionOffsetMatrix(base.matrix,evaluation.transitionEffects[transition.transitionId],base.anchor?transformPoint(base.matrix,base.anchor):undefined),[[1/ref.width,0,0],[0,1/ref.height,0]]);
   for(let row=0;row<2;row++)for(let column=0;column<3;column++)assert.ok(Math.abs(instance.transform![row][column]-expectedMatrix[row][column])<1e-8,JSON.stringify({frame,actual:instance.transform,expectedMatrix}));
  }
 }
 const before=structuredClone(w.state.animations),effect=w.state.expressions![0];w.apply({tool:'updateEffect',expressionId:effect.expressionId,patch:{parameters:{amplitude:effect.parameters.amplitude/3}}},'weaken',true);assert.deepEqual(w.state.animations,before);
 assert.equal(evaluateMotion(w.state,231,presentation).transitionEffects[transition.transitionId].x,0);
 if(timelinePolicy==='referenceStates'){
  const doc=await readMotion(f.project);await changeMotion(f.project.root,{expectedRevision:doc.revision,request:'Continuity fixture',operations:[{type:'setProjectSettings',settings:state.settings},{type:'setBlocks',blocks:state.blocks},...w.batches.flat()]});
  const video=await exportVideo(f.project.root,()=>{},{renderer:'native'});assert.ok('frameDigests'in video);
  for(const proof of video.frameDigests){const rendered=await renderNativeFrame(f.project,w.state,proof.frame,{encoding:'rgba'});assert.equal(createHash('sha256').update(rendered.png).digest('hex'),proof.sha256);}
 }
 }finally{await f.cleanup();}
});
test('source-bound procedural inertia keeps its original identity/time across a later transition and decays to neutral',async()=>{
 const f=await identityFixture();try{
  const state=structuredClone(f.state);state.settings.durationFrames=60;state.blocks[2].durationFrames=36;
  const w=new WorkingRevision(f.project,'fixture',state,'Keep source inertia across transition','minimal');
  w.apply([{type:'addAnimation',animation:{animationId:'base',sceneId:'s1',targetId:'qr1',effect:'property',startFrame:10,durationFrames:6,easing:'linear',enabled:true,parameters:{property:'x',from:30,to:0}}},{type:'animateObjectStateTransition',...f.transition}],'base');
  w.apply({tool:'addEffect',expression:{expressionId:'tail',sceneId:'s1',targetId:'qr1',type:'inertialOvershoot',sourceAnimationId:'base',property:'x',startFrame:16,durationFrames:20,enabled:true,parameters:{mode:'ae',amplitude:.2,frequency:2,decay:3,settlingEnvelope:'smoothTail'}}},'tail',true);
  const e=w.state.expressions![0],p=statePresentation(f.project,w.state);assert.equal(e.ownership?.scope,'logicalObject');
  for(const frame of [17,18,19,23,24,25,35,36]){const evaluation=evaluateMotion(w.state,frame,p),actual=frame<18?evaluation.nodes[JSON.stringify(['s1','qr1'])].x:evaluation.transitionEffects[f.transition.transitionId].x;assert.ok(Math.abs(actual!-expressionValue(e,frame,12,w.state.animations,evaluateAnimation))<1e-9);}
  assert.equal(expressionValue(e,36,12,w.state.animations,evaluateAnimation),0);assert.ok(Math.abs(expressionValue(e,18,12,w.state.animations,evaluateAnimation))>.01);
 }finally{await f.cleanup();}
});
test('logical canvas displacement crosses different rotated/scaled parents and anchors without double application',async()=>{
 const f=await identityFixture(3,scenes=>scenes.forEach((s,i)=>{if(!s.children.length)return;const parent=node('parent'+i,'Parent '+i,0,0,200,120,s.children);parent.type='GROUP';parent.properties!.fills=[];parent.sceneTransform=i===1?[[1.4,-.3,12],[.6,.7,8]]:[[.8,.4,3],[-.2,1.3,14]];s.children=[parent];}));
 try{
  const state=structuredClone(f.state);state.anchors=[{logicalObjectId:f.transition.logicalObjectId,sceneId:'s1',point:{units:'normalized',x:0,y:0},preservation:'none'},{logicalObjectId:f.transition.logicalObjectId,sceneId:'s2',point:{units:'normalized',x:1,y:1},preservation:'none'}];
  const w=new WorkingRevision(f.project,'fixture',state,'Logical canvas motion','minimal');w.apply([{type:'animateObjectStateTransition',...f.transition,layerPolicy:{type:'switch',switchProgress:.5}}],'transition');
  w.apply({tool:'addEffect',expression:{expressionId:'xy',sceneId:'s1',targetId:'qr1',type:'wiggle',property:'x',startFrame:0,durationFrames:30,enabled:true,parameters:{amplitude:4,frequency:2,seed:4,temporalMode:'continuous'}}},'wiggle',true);
  const p=statePresentation(f.project,w.state),t=w.state.objectTransitions![0];
  for(const frame of [17,18,20,21,22,24,25]){const host=frame<21?'s1':'s2',ref=p[t.logicalObjectId][host],v=interpolateState(p[t.logicalObjectId].s1,p[t.logicalObjectId].s2,t,frame,w.state),offset=evaluateMotion(w.state,frame,p).transitionEffects[t.transitionId],expected=multiply(transitionOffsetMatrix(v.matrix,offset,v.anchor?transformPoint(v.matrix,v.anchor):undefined),[[1/ref.width,0,0],[0,1/ref.height,0]]),rendered=await renderNativeFrame(f.project,w.state,frame,{diagnostics:true}),actual=rendered.composition!.instances.find(i=>i.sceneId===host&&i.targetId===ref.sourceNodeId)!.transform!;for(let r=0;r<2;r++)for(let c=0;c<3;c++)assert.ok(Math.abs(actual[r][c]-expected[r][c])<1e-8,JSON.stringify({frame,actual,expected}));}
 }finally{await f.cleanup();}
});
test('explicit transition inertia momentum window has visible decay while legacy endpoint sampling remains unchanged',async()=>{
 const f=await identityFixture();try{
 const t={...f.transition,easing:'easeInOutExpo'as const},state={...f.state,objectTransitions:[t]},p=statePresentation(f.project,state);
 const e=expressionSchema.parse({expressionId:'momentum',sceneId:'s1',targetId:'qr1',property:'x',type:'inertialOvershoot',enabled:true,transitionId:t.transitionId,sourceAnimationId:t.transitionId,startFrame:24,durationFrames:6,parameters:{amplitude:.2,frequency:2,decay:3,mode:'ae',settlingEnvelope:'smoothTail',velocitySampling:'lookback',velocityLookbackFrames:3}});
 const offset=scopedExpressionValue(state,e,25,p);assert.ok(Math.abs(offset)>.1);assert.equal(scopedExpressionValue(state,e,24,p),0);assert.equal(scopedExpressionValue(state,e,30,p),0);
 const old=structuredClone(e);delete (old.parameters as any).velocitySampling;const explicit=structuredClone(e);(explicit.parameters as any).velocitySampling='endpoint';assert.equal(scopedExpressionValue(state,old,25,p),scopedExpressionValue(state,explicit,25,p));
 }finally{await f.cleanup();}
});

test('cumulative scope history is not retransmitted after every successful batch; durable result is unchanged',()=>{
 const result={applied:1,diff:[{path:'animation.a',before:null,after:{animationId:'a'}}],scopeExpansions:Array.from({length:25},(_,i)=>({batch:i,targets:['object-a'],reason:'canonical transaction diff',operationTypes:['addAnimation']}))};
 const original=JSON.stringify(result);
 const projected:any[]=compactProviderFeedback([{results:[{call:{tool:'applyEdit',argumentsJson:'{}'},result}]}],'state') as any[];
 assert.equal(projected[0].results[0].result.scopeExpansionCount,25);
 assert.equal(projected[0].results[0].result.scopeExpansions,undefined);
 assert.equal(projected[0].results[0].result.applied,1);
 assert.equal(JSON.stringify(result),original);
 assert.ok(JSON.stringify(projected).length<original.length/2);
});
