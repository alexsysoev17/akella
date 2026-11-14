import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {identityFixture,node} from './identity-fixture.js';
import {readMotion,changeMotion} from '../src/motion/store.js';
import {executeMotion} from '../src/motion/service.js';
import {registerProvider} from '../src/harness/providers/index.js';
import {closeNativeRenderer,renderNativeFrame} from '../src/native/client.js';
import {incrementalEditProfile,incrementalContext,incrementalPlan} from '../src/motion/incremental-edit.js';
import {ruleQA} from '../src/motion/rule-qa.js';
import {numericQA} from '../src/motion/qa/numeric.js';
import {scopedExpressionValue} from '../src/motion/transition-effects.js';
import {semanticEditSchema} from '../src/motion/rule-contract.js';
after(()=>closeNativeRenderer());
test('three stars: local inertia after each movement, idempotence, parameter edits, selective removal, real native QA and Undo/Redo',async()=>{
 const f=await identityFixture(2,scenes=>scenes.forEach((s,j)=>{s.children=[1,2,3].map(i=>node(`star${j}${i}`,`звезда ${i}`,30*i,30,20,20));}));let calls=0;
 const stop=registerProvider('inertia-local-test',()=>({id:'inertia-local-test',mode:'mock',capabilities:()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false}),generate:async()=>{calls++;throw Error('unexpected provider call');}}));
 const turn=async(request:string)=>{const doc=await readMotion(f.project);return executeMotion(f.project,{editId:randomUUID(),mode:'edit',request,expectedRevision:doc.revision,settings:{provider:'inertia-local-test',model:''}},()=>{},{config:{maxLLMCalls:1,maxRepairAttempts:0}});};
 try{
  const d=await readMotion(f.project);await changeMotion(f.project.root,{expectedRevision:d.revision,request:'setup',operations:[{type:'setProjectSettings',settings:{...d.state.settings,fps:30,durationFrames:180}},{type:'setBlocks',blocks:d.state.blocks.map((b,j)=>({...b,startFrame:j*90,durationFrames:90}))},...[0,1].flatMap(j=>[1,2,3].map(i=>({type:'addAnimation' as const,animation:{animationId:`move${j}${i}`,sceneId:`s${j}`,targetId:`star${j}${i}`,startFrame:j*90,durationFrames:20,effect:'slideUp' as const,parameters:{distance:30,mode:'in' as const},easing:'linear' as const,enabled:true}})))]});
  const before=(await readMotion(f.project)).state;
  assert.throws(()=>incrementalEditProfile(f.project,'добавь звезда 1 колебания', {...d,state:before}),/AMBIGUOUS_EFFECT_TYPE/);
  await turn('добавь к объектам звезда 1, звезда 2, звезда 3 эффект колебаний после завершения движений');
  const added=await readMotion(f.project);assert.equal(added.state.expressions!.length,6);assert.ok(added.state.expressions!.every(e=>e.type==='inertialOvershoot'&&e.startFrame===before.animations.find(a=>a.animationId===e.sourceAnimationId)!.startFrame+20));assert.deepEqual(added.state.animations,before.animations);
  assert.equal(numericQA(added.state).checks.filter(c=>c.status==='FAILED').length,0);for(const e of added.state.expressions!){assert.ok(Math.abs(scopedExpressionValue(added.state,e,e.startFrame+2))>0);assert.equal(scopedExpressionValue(added.state,e,e.startFrame+e.durationFrames),0);}
  const stopped=structuredClone(added.state);for(const a of stopped.animations)if(a.effect==='slideUp')a.parameters.distance=0;const noVelocity=await ruleQA(f.project,stopped);assert.ok(noVelocity.checks.some(c=>c.status==='FAILED'&&c.reason?.includes('INERTIA_NO_OBSERVABLE_RESPONSE')));
  const ids=added.state.expressions!.map(e=>e.expressionId).sort();await turn('добавь к объектам звезда 1, звезда 2, звезда 3 эффект колебаний');assert.deepEqual((await readMotion(f.project)).state.expressions!.map(e=>e.expressionId).sort(),ids);
  await turn('сделай у звезда 2 колебания слабее уменьши частоту и амплитуду');
  const edited=await readMotion(f.project);for(const e of edited.state.expressions!.filter(e=>e.targetId.endsWith('2'))){const old=added.state.expressions!.find(x=>x.expressionId===e.expressionId)!;assert.equal(e.type,'inertialOvershoot');assert.equal(old.type,'inertialOvershoot');if(e.type!=='inertialOvershoot'||old.type!=='inertialOvershoot')throw Error('unexpected effect');assert.equal(e.parameters.amplitude,old.parameters.amplitude*.5);assert.equal(e.parameters.frequency,old.parameters.frequency*.5);assert.equal(e.parameters.decay,old.parameters.decay);}
  await turn('убери у звезда 1 инерцию');const final=await readMotion(f.project);assert.equal(final.state.expressions!.filter(e=>e.targetId.endsWith('1')).length,0);assert.equal(final.state.expressions!.length,4);assert.deepEqual(final.state.animations,before.animations);assert.equal(calls,0);
  for(const frame of [19,20,25,50,89,90,110,120,150])assert.ok((await renderNativeFrame(f.project,final.state,frame,{scale:.25})).png.length>0);
  await changeMotion(f.project.root,{request:'undo',action:'undo',expectedRevision:final.revision});const undone=await readMotion(f.project);assert.equal(undone.state.expressions!.length,6);await changeMotion(f.project.root,{request:'redo',action:'redo',expectedRevision:undone.revision});assert.equal((await readMotion(f.project)).state.expressions!.length,4);
  const profile=incrementalEditProfile(f.project,'добавь звезда 3 колебания после движения',await readMotion(f.project))!;const ctx=incrementalContext(f.project,await readMotion(f.project),'',profile);
  assert.throws(()=>incrementalPlan('inertia',[semanticEditSchema.parse({operation:'ADD_EFFECT',effect:'wiggle',targets:profile.objects.map(o=>o.logicalObjectId),scope:{selector:'objects'},parameters:{}})],ctx),/INCREMENTAL_EFFECT_NOT_ADMITTED/);
 }finally{stop();await f.cleanup();}
});
