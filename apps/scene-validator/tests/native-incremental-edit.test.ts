import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {identityFixture,node} from './identity-fixture.js';
import {incrementalEditProfile,incrementalContext,deterministicIncrementalEdit,incrementalPlan} from '../src/motion/incremental-edit.js';
import {executeMotion} from '../src/motion/service.js';
import {ruleObjects} from '../src/motion/rules.js';
import {expressionValue} from '../src/motion/expressions.js';
import {evaluateAnimation} from '../src/motion/evaluation.js';
import {readMotion,changeMotion} from '../src/motion/store.js';
import {registerProvider} from '../src/harness/providers/index.js';
import {closeNativeRenderer,renderNativeFrame} from '../src/native/client.js';
import {requestContextCategories} from '../src/harness/providers/budget.js';
import {semanticContext} from '../src/harness/semantic-context.js';
after(()=>closeNativeRenderer());
async function fixture(){
 const f=await identityFixture(2,scenes=>scenes.forEach((s,j)=>{
  s.children=['звезда 1','звезда 2','звезда 3','Телефон'].map((name,i)=>({...node(`n${j}${i}`,name,20+i*45+j*5,30,25,25),properties:{width:25,height:25,fills:[{type:'SOLID',color:{r:1,g:1,b:1}}]}}));
  s.width=240;s.height=135;s.properties={width:240,height:135,clipsContent:true,fills:[]};
 }));
 const star=ruleObjects(f.project).find(o=>o.name==='звезда 3')!;
 let doc=await readMotion(f.project);
 doc=(await changeMotion(f.project.root,{expectedRevision:doc.revision,request:'setup',operations:[{type:'setProjectSettings',settings:{...f.state.settings,width:240,height:135,fps:30,durationFrames:180}},{type:'setBlocks',blocks:f.state.blocks.map((b,i)=>({...b,startFrame:i*90,durationFrames:90}))},{type:'animateObjectStateTransition',transitionId:'cross-scene',logicalObjectId:star.logicalObjectId,fromSceneId:'s0',toSceneId:'s1',startFrame:75,durationFrames:30,easing:'linear',proceduralEffects:[],layerPolicy:{type:'switch',switchProgress:.5},timelinePolicy:'referenceStates'},{type:'addAnimation',animation:{animationId:'base',targetId:'n00',sceneId:'s0',effect:'slideUp',parameters:{distance:20,mode:'in'},easing:'linear',startFrame:0,durationFrames:15,enabled:true}}]})).document;
 return {...f,doc};
}
const add='добавь звезда 1 звезда 2 звезда 3 эффект постоянного покачивания';
test('incremental route scopes three objects, omits full graph/history and refuses deterministic unknown modifiers',async()=>{
 const f=await fixture();try{
  const p=incrementalEditProfile(f.project,add)!;assert.equal(p.objects.length,3);
  const context=incrementalContext(f.project,f.doc,add,p);
  assert.equal(context.objectIndex.length,3);assert.ok(!('motion' in context));
  assert.ok(!('recentConversation' in (semanticContext(context) as object)));
  assert.equal(deterministicIncrementalEdit(f.project,add)?.operation,'ADD_EFFECT');
  assert.equal(deterministicIncrementalEdit(f.project,add+' только после 5 секунды'),null);
  assert.equal(deterministicIncrementalEdit(f.project,add+' и неизвестный объект'),null);
  assert.equal(incrementalEditProfile(f.project,'звезда 1 появляется снизу с инерцией'),null);
  const edit=deterministicIncrementalEdit(f.project,add)!;
  assert.throws(()=>incrementalPlan(add,[{...edit,scope:{...edit.scope,selector:'project'}}],context),/SCOPE_VIOLATION/);
  const categories=requestContextCategories({messages:[{role:'system',content:'local effect contract'},{role:'user',content:JSON.stringify({userRequest:add,context:semanticContext(context)})}],responseSchema:{type:'object'}});
  assert.ok(categories.objectContext>0);assert.equal(categories.conversationHistory,0);assert.ok(categories.skills>0);
 }finally{await f.cleanup();}
});
test('production local add/repeat/remove/modify → preflight → selective native QA → persisted state → Undo/Redo, zero model calls',async()=>{
 const f=await fixture();let calls=0;
 const stop=registerProvider('incremental-reject',()=>({id:'incremental-reject',mode:'mock',capabilities:()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false}),generate:async()=>{calls++;throw Error('Unexpected provider call');}}));
 try{
  let doc=f.doc;const base=structuredClone(doc.state.animations);let expressionIds:string[]=[];let previousSecond:any;
  const prompts=[add,add,'убери wiggle только у звезда 1','сделай wiggle у звезда 2 вдвое слабее'];
  for(let i=0;i<prompts.length;i++){
   const result=await executeMotion(f.project,{mode:'edit',request:prompts[i],expectedRevision:doc.revision,settings:{provider:'incremental-reject',model:''}},()=>{}, {config:{maxLLMCalls:1,maxRepairAttempts:0}});
   assert.equal(result.reconciliation?.status,'SUCCESS',JSON.stringify(result));
   doc=await readMotion(f.project);assert.deepEqual(doc.state.animations,base);assert.deepEqual(doc.state.objectTransitions,f.doc.state.objectTransitions);
   const effects=doc.state.expressions!.filter(e=>e.type==='wiggle');assert.equal(effects.length,i<2?3:2);
   if(i===0)expressionIds=effects.map(e=>e.expressionId);
   if(i===1)assert.deepEqual(effects.map(e=>e.expressionId),expressionIds);
   if(i===2)previousSecond=effects.find(e=>e.targetId==='n01');
   if(i===3){const e=effects.find(e=>e.targetId==='n01')!;for(const frame of [15,45,85,120])assert.equal(expressionValue(e,frame,30,doc.state.animations,evaluateAnimation),expressionValue(previousSecond,frame,30,doc.state.animations,evaluateAnimation)*.5);assert.equal(effects.find(e=>e.targetId==='n01')!.parameters.amplitude,1.5);assert.equal(effects.find(e=>e.targetId==='n02')!.parameters.amplitude,3);}
  }
  assert.equal(calls,0);
  assert.deepEqual((await readMotion(f.project)).state,doc.state);
  const before=await renderNativeFrame(f.project,doc.state,89,{cache:false});
  const again=await renderNativeFrame(f.project,doc.state,89,{cache:false});assert.deepEqual(before.png,again.png);
  assert.ok((await renderNativeFrame(f.project,doc.state,90,{cache:false})).png.length);
  const saved=structuredClone(doc.state);
  const undone=(await changeMotion(f.project.root,{expectedRevision:doc.revision,request:'undo',action:'undo'})).document;
  const redone=(await changeMotion(f.project.root,{expectedRevision:undone.revision,request:'redo',action:'redo'})).document;
  assert.deepEqual(redone.state,saved);
 }finally{stop();await f.cleanup();}
});

test('unfamiliar wording uses ONE compact provider request; no full graph or history; actual admission below unchanged budget',async()=>{
 const f=await fixture();let calls=0;let bytes=0;
 const stop=registerProvider('incremental-compact',()=>({id:'incremental-compact',mode:'mock',capabilities:()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false}),generate:async req=>{
  calls++;const payload=JSON.parse(req.messages.find(m=>m.role==='user')!.content);const c=payload.context;
  assert.equal(c.objectIndex.length,3);assert.ok(!c.motion);assert.ok(!c.recentConversation);assert.ok(!c.effectState.animations);assert.equal(c.skill.length,1);
  assert.ok(!req.messages[0].content.includes('Trim Paths'));
  bytes=Buffer.byteLength(JSON.stringify({...req,signal:undefined}));assert.ok(bytes<20000);
  return {output:{edits:[{operation:'ADD_EFFECT',effect:'wiggle',targets:c.objectIndex.map((o:any)=>o.logicalObjectId),scope:{selector:'objects',phase:'all'},parameters:{amplitude:2}}],assumptions:[]},usage:null,estimatedCost:null,latencyMs:0,diagnostics:[],toolCalls:[]};
 }}));
 try{
 const result=await executeMotion(f.project,{mode:'edit',request:'Добавь звезда 1 звезда 2 звезда 3 мягкий плавный wiggle',expectedRevision:f.doc.revision,settings:{provider:'incremental-compact',model:''}},()=>{},{config:{maxLLMCalls:1,maxRepairAttempts:0}});
 assert.equal(result.reconciliation?.status,'SUCCESS',JSON.stringify(result));assert.equal(calls,1);assert.equal(result.reconciliation?.selectedObjectCount,3);assert.equal(result.reconciliation?.selectedExpressionCount,3);
 assert.ok(bytes>1000);
 }finally{stop();await f.cleanup();}
});
test('context admission overflow never escalates to expensive Code Repair; broader rule cannot escape admitted objects',async()=>{
 const {GlobalFailureSupervisor}=await import('../src/harness/recovery/supervisor.js');
 let codeCalls=0;
 const supervisor=new GlobalFailureSupervisor({request:add,revision:'test',maxAttempts:3,maxDurationMs:5000,persist:async()=>{}});
 const report=await supervisor.settle(Object.assign(Error('CONTEXT_EXHAUSTED: project context exceeds capacity'),{code:'CONTEXT_EXHAUSTED'}),'provider-startup',{code:{strategy:'code',procedure:'should-not-run',reason:'not an implementation defect',run:async()=>{codeCalls++;return {};},verify:async()=>({status:'PASSED'})},codeEnabled:true});
 assert.equal(codeCalls,0);assert.equal(report.status,'RECOVERY_BLOCKED');assert.ok(report.originalFailure);
 const f=await fixture();try{
  const p=incrementalEditProfile(f.project,add)!;const c=incrementalContext(f.project,f.doc,add,p);
  const effect=deterministicIncrementalEdit(f.project,add)!;
  c.effectState.rules.push({ruleId:'global',effect:'wiggle',scope:{selector:'project',logicalObjectIds:[],phase:'all'},parameters:{},priority:1,sourceText:'global',enabled:true,exceptions:[]});
  assert.throws(()=>incrementalPlan(add,[{...effect,operation:'MODIFY_RULE',ruleId:'global'}],c),/INCREMENTAL_RULE_NOT_ADMITTED/);
 }finally{await f.cleanup();}
});
