import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {identityFixture} from './identity-fixture.js';
import {WorkingRevision} from '../src/motion/working-revision.js';
import {statePresentation} from '../src/motion/transitions.js';
import {evaluateMotion} from '../src/motion/evaluation.js';
import {interpolateState} from '../src/motion/transition-runtime.js';
import {multiply,transitionOffsetMatrix,poseScaleBasis} from '../src/motion/geometry.js';
import {transformPoint} from '../src/motion/anchor.js';
import {renderNativeFrame,closeNativeRenderer} from '../src/native/client.js';
after(()=>closeNativeRenderer());

test('native rendered pose uses local scale axes through a rotated anisotropic arrival',async()=>{
 const f=await identityFixture(3,scenes=>scenes.forEach((s,i)=>{
  if(!s.children.length)return;
  const n=s.children[0],angle=i===1?-.1:-.8,c=Math.cos(angle),sn=Math.sin(angle);
  n.sceneTransform=[[c,-sn,i===1?100:80],[sn,c,i===1?60:40]];
  n.properties!.width=i===1?30:18;n.properties!.height=30;
 }));
 try{
  const state=structuredClone(f.state);state.settings.durationFrames=60;state.blocks[2].durationFrames=36;
  const w=new WorkingRevision(f.project,'fixture',state,'Continuous whole pose','minimal');
  w.apply([{type:'animateObjectStateTransition',...f.transition,layerPolicy:{type:'switch',switchProgress:.5}},{type:'setExpression',expression:{expressionId:'response',sceneId:'s1',targetId:'qr1',type:'inertialOvershoot',property:'x',sourceAnimationId:f.transition.transitionId,transitionId:f.transition.transitionId,ownership:{scope:'transition'},enabled:true,startFrame:24,durationFrames:24,parameters:{amplitude:.08,frequency:1.4,decay:4,velocityLookbackFrames:2,mode:'ae'}}}],'setup');
  w.apply({tool:'tuneInertia',expressionId:'response',approach:'continuous',peakRatio:.04,frequency:1.4,decay:4},'continuous',true);
  const t=w.state.objectTransitions![0],refs=statePresentation(f.project,w.state),p=refs[t.logicalObjectId];
  assert.equal(poseScaleBasis(t.easing),'local');assert.equal(w.state.expressions!.length,5);
  // Real integer-frame renderer integration on both sides of the arrival and at rest.
  // Subframe velocity invariants are covered independently in inertia-generalization.
  let distinguishesOldBasis=false;
  const digests=new Set<string>();
  for(const frame of [22,23,24,25,26,30,48]){
   const visual=interpolateState(p.s1,p.s2,t,frame,w.state),offset=evaluateMotion(w.state,frame,refs).transitionEffects[t.transitionId],origin=visual.anchor?transformPoint(visual.matrix,visual.anchor):undefined;
   const expected=transitionOffsetMatrix(visual.matrix,offset,origin,'local'),old=transitionOffsetMatrix(visual.matrix,offset,origin,'canvas');
   if(expected.flat().some((x,i)=>Math.abs(x-old.flat()[i])>1e-5))distinguishesOldBasis=true;
   const rendered=await renderNativeFrame(f.project,w.state,frame,{diagnostics:true});
   assert.ok(rendered.png.length>0);digests.add(Buffer.from(rendered.png).toString('base64'));
   const instance=rendered.composition!.instances.find(i=>i.sceneId==='s2'&&i.targetId==='qr2');
   assert.ok(instance?.visible);
   const matrix=multiply(expected,[[1/p.s2.width,0,0],[0,1/p.s2.height,0]]);
   for(let row=0;row<2;row++)for(let col=0;col<3;col++)assert.ok(Math.abs(instance.transform![row][col]-matrix[row][col])<1e-8,JSON.stringify({frame,actual:instance.transform,expected:matrix}));
  }
  assert.ok(distinguishesOldBasis,'fixture must expose the old rotated-axis defect');
  assert.ok(digests.size>3,'native output must contain moving rendered frames');
 }finally{await f.cleanup();}
});
