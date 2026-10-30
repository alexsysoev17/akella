import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {identityFixture,node} from './identity-fixture.js';
import {readMotion,changeMotion} from '../src/motion/store.js';
import {executeMotion} from '../src/motion/service.js';
import {registerProvider} from '../src/harness/providers/index.js';
import {closeNativeRenderer,renderNativeFrame} from '../src/native/client.js';
import {recoveryFailure} from '../src/harness/recovery/failure.js';
import {failureDiagnostic} from '../src/harness/failure.js';
import {compileSemanticEdit,ruleObjects} from '../src/motion/rules.js';
import {semanticEditSchema} from '../src/motion/rule-contract.js';
after(()=>closeNativeRenderer());
async function fixture(){
 const f=await identityFixture(2,scenes=>scenes.forEach((s,j)=>{s.width=240;s.height=135;s.properties={width:240,height:135,clipsContent:true,fills:[]};s.children=['лого','звезда 1','звезда 2','звезда 3','телефон'].map((name,i)=>({...node('n'+j+i,name,10+i*40,25,20,20),properties:{width:20,height:20,fills:[{type:'SOLID',color:{r:1,g:1,b:1}}]}}));}));
 const doc=await readMotion(f.project);
 const animations=[0,1].map(j=>({type:'addAnimation' as const,animation:{animationId:'base'+j,targetId:'n'+j+'0',sceneId:'s'+j,startFrame:j*90,durationFrames:15,effect:'slideUp' as const,parameters:{distance:20,mode:'in' as const},easing:'linear' as const,enabled:true}}));
 await changeMotion(f.project.root,{expectedRevision:doc.revision,request:'setup',operations:[{type:'setProjectSettings',settings:{...f.state.settings,width:240,height:135,fps:30,durationFrames:180}},{type:'setBlocks',blocks:f.state.blocks.map((b,i)=>({...b,startFrame:i*90,durationFrames:90}))},...animations,...animations.map((a,j)=>({type:'setExpression' as const,expression:{expressionId:'inertia'+j,type:'inertialOvershoot' as const,sceneId:'s'+j,targetId:'n'+j+'0',sourceAnimationId:a.animation.animationId,property:'y' as const,startFrame:j*90+15,durationFrames:30,enabled:true,parameters:{amplitude:.25,frequency:2.5,decay:3,velocityLookbackFrames:3,mode:'ae' as const,settlingEnvelope:'smoothTail' as const}}})),{...animations[0],animation:{...animations[0].animation,animationId:'phone',targetId:'n04',startFrame:45,durationFrames:20}}]});
 return f;
}
test('instant logo edit across instances, contextual follow-up, modifiers, lifecycle, duration, idempotent delivery, Undo/Redo; zero providers',async()=>{
 const f=await fixture();let calls=0;
 const stop=registerProvider('instant-block',()=>({id:'instant-block',mode:'mock',capabilities:()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false}),generate:async()=>{calls++;throw Error('LOCAL_FAST_PATH must not call provider');}}));
 const turn=async(request:string,editId=randomUUID())=>{const doc=await readMotion(f.project);return executeMotion(f.project,{editId,mode:'edit',request,expectedRevision:doc.revision,settings:{provider:'instant-block',model:''}},()=>{},{config:{maxLLMCalls:1,maxRepairAttempts:0}});};
 try{
  const before=await readMotion(f.project);const editId=randomUUID();const input={editId,mode:'edit',request:'сделай у лого эффект колебаний гораздо слабее',expectedRevision:before.revision,settings:{provider:'instant-block',model:''}};
  const result=await executeMotion(f.project,input,()=>{},{config:{maxLLMCalls:1,maxRepairAttempts:0}});assert.equal(result.reconciliation?.status,'SUCCESS');
  let doc=await readMotion(f.project);assert.deepEqual(doc.state.animations,before.state.animations);
  assert.deepEqual(doc.state.expressions,before.state.expressions!.map(e=>({...e,parameters:{...e.parameters,amplitude:.0625}})));
  const replay=await executeMotion(f.project,input);assert.ok('replayed' in replay);assert.equal((await readMotion(f.project)).revision,doc.revision);
  await assert.rejects(executeMotion(f.project,{...input,request:'другой запрос'}),/EDIT_ID_REUSED/);
  const metrics=JSON.parse(await readFile(path.join(f.project.root,'motion/ai',result.id,'incremental-edit.json'),'utf8'));
  assert.equal(metrics.route,'LOCAL_FAST_PATH');assert.equal(metrics.llmCalls,0);assert.equal(metrics.changes.length,2);
  await assert.rejects(readFile(path.join(f.project.root,'motion/ai',result.id,'semantic-interpret/request.txt')),/ENOENT/);
  assert.equal((await turn('Сделай еще слабее')).reconciliation?.status,'SUCCESS');doc=await readMotion(f.project);assert.ok(doc.state.expressions!.every(e=>e.parameters.amplitude===.03125));
  await turn('уменьши амплитуду колебаний лого на 30%');doc=await readMotion(f.project);assert.ok(doc.state.expressions!.every(e=>e.parameters.amplitude===.03125*.7));
  await turn('отключи колебания у лого');assert.ok((await readMotion(f.project)).state.expressions!.every(e=>!e.enabled));
  await turn('включи колебания у лого');assert.ok((await readMotion(f.project)).state.expressions!.every(e=>e.enabled));
  await turn('добавь звезда 1 звезда 2 звезда 3 эффект постоянного покачивания');
  await turn('уменьши частоту wiggle звезда 2');doc=await readMotion(f.project);const second=doc.state.expressions!.find(e=>e.type==='wiggle'&&e.targetId==='n02')!;assert.equal(second.type==='wiggle'&&second.parameters.frequency,.4);assert.equal(second.parameters.amplitude,3);
  await turn('убери wiggle только у звезда 1');assert.equal((await readMotion(f.project)).state.expressions!.filter(e=>e.type==='wiggle').length,2);
  await turn('сделай все движения телефон медленнее');doc=await readMotion(f.project);assert.equal(doc.state.animations.find(a=>a.animationId==='phone')!.durationFrames,25);
  await turn('Верни предыдущее значение');doc=await readMotion(f.project);assert.equal(doc.state.animations.find(a=>a.animationId==='phone')!.durationFrames,20);
  doc=(await changeMotion(f.project.root,{expectedRevision:doc.revision,request:'redo',action:'redo'})).document;assert.equal(doc.state.animations.find(a=>a.animationId==='phone')!.durationFrames,25);
  await turn('убери колебания у лого');doc=await readMotion(f.project);assert.ok(!doc.state.expressions!.some(e=>e.type==='inertialOvershoot'));assert.equal(doc.state.animations.length,3);
  assert.ok((await renderNativeFrame(f.project,doc.state,95,{cache:false})).png.length);assert.equal(calls,0);
 }finally{stop();await f.cleanup();}
});
test('group/global rule edit changes only logo, preserves frequency and group, enable/disable restores original amplitude',async()=>{
 const f=await fixture();try{
 let doc=await readMotion(f.project);
 // Remove direct expressions before establishing an authoritative shared rule.
 doc=(await changeMotion(f.project.root,{expectedRevision:doc.revision,request:'rule seed',operations:[{type:'removeExpression',expressionId:'inertia0'},{type:'removeExpression',expressionId:'inertia1'},...compileSemanticEdit(f.project,{...doc.state,expressions:[]},semanticEditSchema.parse({operation:'ADD_RULE',effect:'wiggle',targets:['лого','звезда 1'],scope:{selector:'objects',phase:'all'},parameters:{amplitude:8,frequency:1.2}}),'group')]})).document;
 const third=structuredClone(doc.state.expressions!.find(e=>e.targetId==='n01'));
 const stop=registerProvider('instant-group',()=>({id:'instant-group',mode:'mock',capabilities:()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false}),generate:async()=>{throw Error('Unexpected provider');}}));
 try{for(const request of ['сделай wiggle у лого гораздо слабее','отключи wiggle у лого','включи wiggle у лого']){const d=await readMotion(f.project);const r=await executeMotion(f.project,{mode:'edit',request,expectedRevision:d.revision,settings:{provider:'instant-group',model:''}},()=>{},{config:{maxLLMCalls:1,maxRepairAttempts:0}});assert.equal(r.reconciliation?.status,'SUCCESS',JSON.stringify(r));}
 doc=await readMotion(f.project);assert.deepEqual(doc.state.expressions!.find(e=>e.targetId==='n01'),third);const logo=doc.state.expressions!.find(e=>e.targetId==='n00')!;assert.equal(logo.parameters.amplitude,2);assert.equal(logo.type==='wiggle'&&logo.parameters.frequency,1.2);
 }finally{stop();}
 }finally{await f.cleanup();}
});
test('DOM provider timeout and cancellation are distinct from technical validation and context capacity',()=>{
 const error=new DOMException('The operation was aborted due to timeout','TimeoutError');
 const f=recoveryFailure(error,'semantic-planning','r');assert.equal(f.code,'PROVIDER_TIMEOUT');assert.equal(f.category,'PROVIDER_FAILURE');assert.equal(f.codeRepairEligible,false);
 assert.equal(failureDiagnostic(error,'provider-call','CALL_FAILED',true).errorCode,'PROVIDER_TIMEOUT');
 assert.equal(recoveryFailure(new DOMException('cancel','AbortError'),'provider-call','r').code,'CANCELLED');
});
test('local typed rule add/remove/exceptions and easing preserve unrelated state, real atomic store rejects stale candidates',async()=>{
 const f=await fixture();let calls=0;
 const stop=registerProvider('instant-rules',()=>({id:'instant-rules',mode:'mock',capabilities:()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false}),generate:async()=>{calls++;throw Error('Unexpected model');}}));
 const turn=async(request:string)=>{const doc=await readMotion(f.project);const r=await executeMotion(f.project,{mode:'edit',request,expectedRevision:doc.revision,settings:{provider:'instant-rules',model:''}},()=>{},{config:{maxLLMCalls:1,maxRepairAttempts:0}});assert.equal(r.reconciliation?.status,'SUCCESS',JSON.stringify(r));return readMotion(f.project);};
 try{
  let doc=await turn('добавь правило постоянного покачивания у звезда 1 и звезда 2');const id=doc.state.motionRules!.find(r=>r.effect==='wiggle')!.ruleId;
  doc=await turn('добавь исключение '+id+' для звезда 1');assert.equal(doc.state.expressions!.filter(e=>e.type==='wiggle').length,1);
  doc=await turn('убери исключение '+id+' для звезда 1');assert.equal(doc.state.expressions!.filter(e=>e.type==='wiggle').length,2);
  doc=await turn('удали правило '+id);assert.equal(doc.state.expressions!.filter(e=>e.type==='wiggle').length,0);
  const original=structuredClone(doc.state.animations.filter(a=>a.animationId!=='phone'));
  doc=await turn('измени easing телефон на easeInOutCubic');assert.equal(doc.state.animations.find(a=>a.animationId==='phone')!.easing,'easeInOutCubic');assert.deepEqual(doc.state.animations.filter(a=>a.animationId!=='phone'),original);
  await assert.rejects(changeMotion(f.project.root,{expectedRevision:'stale',request:'stale',operations:[{type:'setExpression',expression:doc.state.expressions![0]}]}),/изменилась/);
  assert.equal((await readMotion(f.project)).revision,doc.revision);assert.equal(calls,0);
 }finally{stop();await f.cleanup();}
});
test('actual adapter TimeoutError is persisted as PROVIDER_TIMEOUT, zero operations and no source repair',async()=>{
 const f=await fixture();let calls=0;
 const {readRuns}=await import('../src/harness/runtime.js');
 const stop=registerProvider('instant-timeout',()=>({id:'instant-timeout',mode:'mock',capabilities:()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false}),generate:async()=>{calls++;throw new DOMException('The operation was aborted due to timeout','TimeoutError');}}));
 try{
  const before=await readMotion(f.project);
  await assert.rejects(executeMotion(f.project,{mode:'edit',request:'сделай у лого эффект колебаний необычно нежным',expectedRevision:before.revision,settings:{provider:'instant-timeout',model:''}},()=>{},{config:{maxLLMCalls:1,maxRepairAttempts:0,recovery:{enabled:false} as never}}),/PROVIDER_TIMEOUT/);
  assert.deepEqual(await readMotion(f.project),before);assert.equal(calls,1);
  const runs=await readRuns(f.project.root);assert.equal((runs[0].failure as {errorCode:string}).errorCode,'PROVIDER_TIMEOUT');
 }finally{stop();await f.cleanup();}
});
test('modifier policy uses actual current values, consumes numeric percentages and rejects unsafe compound interpretation',async()=>{
 const f=await fixture();try{
 const {deterministicIncrementalEdit}=await import('../src/motion/incremental-edit.js');const doc=await readMotion(f.project);
 for(const [text,factor] of [['чуть слабее',.8],['слабее',.5],['гораздо слабее',.25],['сильнее',1.6],['в два раза сильнее',2]] as const){assert.equal(deterministicIncrementalEdit(f.project,'сделай колебания лого '+text,doc)?.amplitudeFactor,factor);}
 assert.ok(Math.abs(deterministicIncrementalEdit(f.project,'уменьши амплитуду лого на 30.5%',doc)!.amplitudeFactor!-.695)<Number.EPSILON);
 assert.equal(deterministicIncrementalEdit(f.project,'уменьши амплитуду лого на -30%',doc),null);
 assert.equal(deterministicIncrementalEdit(f.project,'уменьши амплитуду лого и частоту колебаний',doc)?.frequencyFactor,.5);
 assert.equal(deterministicIncrementalEdit(f.project,'сделай колебания лого слабее и сильнее',doc),null);
 }finally{await f.cleanup();}
});
test('compound relative effect edits use current IDs, preserve all other state, commit atomically with Undo/Redo and no LLM',async()=>{
 const f=await fixture();let calls=0;
 const stop=registerProvider('compound-local-block',()=>({id:'compound-local-block',mode:'mock',capabilities:()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false}),generate:async()=>{calls++;throw Error('Unexpected LLM');}}));
 try{
  let before=await readMotion(f.project);
  const {deterministicIncrementalEdit}=await import('../src/motion/incremental-edit.js');
  const prompt='сделай у лого эффект колебаний гораздо слабее - уменьши частоту колебаний и амплитуду';
  const parsed=deterministicIncrementalEdit(f.project,prompt,before)!;assert.equal(parsed.amplitudeFactor,.25);assert.equal(parsed.frequencyFactor,.5);
  assert.equal(deterministicIncrementalEdit(f.project,'уменьши амплитуду лого в два раза и частоту на 20%',before)?.frequencyFactor,.8);
  const shared=deterministicIncrementalEdit(f.project,'уменьши амплитуду лого и частоту на 20%',before);assert.equal(shared?.amplitudeFactor,.8);assert.equal(shared?.frequencyFactor,.8);
  assert.equal(deterministicIncrementalEdit(f.project,'уменьши амплитуду лого и увеличь частоту колебаний',before)?.frequencyFactor,1.6);
  for(const text of ['уменьши амплитуду лого и частоту на -20%','уменьши амплитуду лого и частоту и длительность','сделай колебания лого слабее и сильнее уменьши частоту и амплитуду'])assert.equal(deterministicIncrementalEdit(f.project,text,before),null,text);
  // An unrelated effect must stay byte-for-byte identical; missing former IDs must not be resurrected.
  before=(await changeMotion(f.project.root,{expectedRevision:before.revision,request:'unrelated',operations:[{type:'setExpression',expression:{...before.state.expressions![0],expressionId:'phone-inertia',targetId:'n04',sourceAnimationId:'phone',startFrame:65}}]})).document;
  const result=await executeMotion(f.project,{editId:randomUUID(),mode:'edit',request:prompt,expectedRevision:before.revision,settings:{provider:'compound-local-block',model:''}},()=>{},{config:{maxLLMCalls:1,maxRepairAttempts:0}});
  assert.equal(result.reconciliation?.status,'SUCCESS');assert.equal(calls,0);
  const after=await readMotion(f.project),expected=structuredClone(before.state);
  for(const e of expected.expressions!)if(e.expressionId!=='phone-inertia'){e.parameters.amplitude*=.25;if('frequency' in e.parameters)e.parameters.frequency*=.5;}
  assert.deepEqual(after.state,expected);
  const metrics=JSON.parse(await readFile(path.join(f.project.root,'motion/ai',result.id,'incremental-edit.json'),'utf8'));
  assert.equal(metrics.performance.route,'LOCAL_FAST_PATH');assert.equal(metrics.performance.providerCalls,0);assert.deepEqual(metrics.performance.expressions.map((e:{expressionId:string})=>e.expressionId).sort(),['inertia0','inertia1']);
  await assert.rejects(readFile(path.join(f.project.root,'motion/ai',result.id,'semantic-interpret/request.txt')),/ENOENT/);
  await assert.rejects(executeMotion(f.project,{mode:'edit',request:prompt,expectedRevision:before.revision,settings:{provider:'compound-local-block',model:''}}),/изменилась/);
  assert.deepEqual((await changeMotion(f.project.root,{expectedRevision:after.revision,action:'undo',request:'undo'})).document.state,before.state);
  const redo=(await changeMotion(f.project.root,{expectedRevision:(await readMotion(f.project)).revision,action:'redo',request:'redo'})).document;assert.deepEqual(redo.state,expected);
  assert.ok((await renderNativeFrame(f.project,redo.state,18,{cache:false})).png.length);
 }finally{stop();await f.cleanup();}
});
test('verified QA reuse requires exact before/after/source; no client bypass flag and no stale proof',async()=>{
 const f=await fixture();try{
 const {ruleQA,hasVerifiedRuleQA}=await import('../src/motion/rule-qa.js');const {applyOperations}=await import('../src/motion/operations.js');
 const before=(await readMotion(f.project)).state;
 const next=applyOperations(before,compileSemanticEdit(f.project,before,semanticEditSchema.parse({operation:'ADD_RULE',effect:'wiggle',targets:['звезда 1'],scope:{selector:'objects',phase:'all'},parameters:{}}),'proof'),f.project);
 assert.equal(hasVerifiedRuleQA(f.project,next,before),false);
 const qa=await ruleQA(f.project,next,before,undefined,undefined,{scale:.25});assert.equal(qa.status,'PASSED');assert.equal(hasVerifiedRuleQA(f.project,next,before),true);
 const changed=structuredClone(next);changed.expressions![0].parameters.amplitude*=.9;assert.equal(hasVerifiedRuleQA(f.project,changed,before),false);
 assert.equal(hasVerifiedRuleQA({...f.project,inspection:{...f.project.inspection,fingerprint:'changed'}},next,before),false);
 }finally{await f.cleanup();}
});
