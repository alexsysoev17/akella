import test from "node:test";
import assert from "node:assert/strict";
import {identityFixture,node} from "./identity-fixture.js";
import {readMotion,changeMotion} from "../src/motion/store.js";
import {registerProvider} from "../src/harness/providers/index.js";
import {executeMotion} from "../src/motion/service.js";
import {evaluateMotion} from "../src/motion/evaluation.js";
import {statePresentation} from "../src/motion/transitions.js";
import {closeNativeRenderer} from "../src/native/client.js";
process.env.AKELLA_RENDERER="native";
test("sequential existing effect edits, start/end retiming, dependent inertia and true Trim Paths retain identities",async()=>{
 const f=await identityFixture(2,scenes=>{scenes[0].children=[node("plate","тарелка",20,25),node("parsley","петрушка 2",55,45),node("basil","базилик",100,30)];scenes[1].children=[1,2].map(i=>{const n=node(`r${i}`,`лента ${i}`,10,30+i*20,150,15);n.type="VECTOR";n.properties={...n.properties,fills:[],strokes:[{type:"SOLID",color:{r:1,g:0,b:0}}],strokeWeight:2,strokeAlign:"CENTER",vectorPaths:[{data:"M0 0 C50 20 100 -20 150 0",windingRule:"NONZERO"}]};return n;});});
 let output:unknown,calls=0;
 const stop=registerProvider("core-retime-fixture",()=>({id:"core-retime-fixture",mode:"mock",capabilities:()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false}),generate:async()=>{calls++;return{output,usage:null,estimatedCost:null,latencyMs:0,diagnostics:["prepared intent, real state/tools/native QA"],toolCalls:[]};}}));
 const turn=async(prompt:string,target:string,techniques:string[],parameters:{key:string;value:string|number}[]=[],extra:object={})=>{
  output={schemaVersion:"semantic-graph/1.0",clauses:[{clauseId:"c",text:prompt}],actions:[{actionId:"a",clauseId:"c",kind:"editAnimation",scene:null,targets:[target],techniques,parameters,constraints:[],unresolvedReason:null,...extra}],assumptions:[]};
  const before=await readMotion(f.project),n=calls;
  const result=await executeMotion(f.project,{mode:"edit",request:prompt,expectedRevision:before.revision,settings:{provider:"core-retime-fixture",model:""}},()=>{},{config:{maxLLMCalls:1,maxRepairAttempts:0}});
  assert.equal(result.reconciliation?.status,"SUCCESS",JSON.stringify(result));assert.equal(calls,n+1);return(await readMotion(f.project)).state;
 };
 try{
  const doc=await readMotion(f.project);f.state.settings.durationFrames=120;f.state.blocks.forEach((b,i)=>{b.startFrame=i*60;b.durationFrames=60;});
  const base=(animationId:string,targetId:string,startFrame:number)=>({animationId,targetId,sceneId:"s0",startFrame,durationFrames:12,effect:"slideUp" as const,easing:"linear" as const,enabled:true,parameters:{distance:30,mode:"in" as const}});
  const b=base("basil-base","basil",5),p=base("parsley-base","parsley",20);
  await changeMotion(f.project.root,{expectedRevision:doc.revision,request:"synthetic seed",operations:[{type:"setProjectSettings",settings:f.state.settings},{type:"setBlocks",blocks:f.state.blocks},{type:"addAnimation",animation:b},{type:"addAnimation",animation:p},{type:"addAnimation",animation:{...b,animationId:"basil-fade",effect:"fadeIn",parameters:{from:0,to:1}}},{type:"addAnimation",animation:{...p,animationId:"parsley-fade",effect:"fadeIn",parameters:{from:0,to:1}}},{type:"setExpression",expression:{expressionId:"parsley-inertia",sceneId:"s0",targetId:"parsley",type:"inertialOvershoot",property:"y",sourceAnimationId:p.animationId,startFrame:32,durationFrames:18,enabled:true,parameters:{mode:"ae",amplitude:.2,frequency:2.5,decay:3,velocityLookbackFrames:3}}},...[1,2].map(i=>({type:"addAnimation" as const,animation:{animationId:`ribbon-${i}`,targetId:`r${i}`,sceneId:"s1",startFrame:60+(i-1)*20,durationFrames:12,effect:"trimPath" as const,easing:"linear" as const,enabled:true,parameters:{from:0,to:1,direction:"forward" as const}}}))]});
  let s=await turn("тарелка появляется снизу за секунду линейно","тарелка",["slideUp"],[{key:"durationSeconds",value:1},{key:"easing",value:"linear"}],{kind:"objectAnimation"});
  const plateBase=structuredClone(s.animations.find(a=>a.targetId==="plate")!);
  s=await turn("добавь затухающую инерцию у тарелка","тарелка",["inertialOvershoot"],[],{kind:"objectAnimation"});
  const effect=structuredClone(s.expressions!.find(e=>e.targetId==="plate")!);
  const y=(state:typeof s)=>evaluateMotion(state,plateBase.startFrame+plateBase.durationFrames+1,statePresentation(f.project,state)).nodes[JSON.stringify(["s0","plate"])]?.y??0;
  const oldY=Math.abs(y(s));
  s=await turn("сделай сильнее колебания у тарелка","тарелка",["inertialOvershoot"],[{key:"amplitudeFactor",value:1.5}],{effectOperation:{storage:"expression",action:"update"}});
  assert.equal(s.expressions!.find(e=>e.expressionId===effect.expressionId)!.parameters.amplitude,effect.parameters.amplitude!*1.5);assert.ok(Math.abs(y(s))>oldY);assert.deepEqual(s.animations.find(a=>a.targetId==="plate"),plateBase);
  // Implicit follow-up resolves the actual recent committed effect, not all objects.
  output={schemaVersion:"1.0.0",requirements:[{requirementId:"followup",kind:"editAnimation",sourceText:"сделай колебания послабее",target:{name:null,sourceNodeId:null,logicalObjectId:null},sceneId:null,techniques:["inertialOvershoot"],selector:{type:"recentSuccessfulTargets",effect:"inertialOvershoot"},parameters:{amplitudeFactor:.5},effectOperation:{storage:"expression",action:"update"}}],coverage:[{sourceText:"сделай колебания послабее",requirementIds:["followup"],classification:"executable",explanation:"recent committed inertia"}],assumptions:[]};
  const before=await readMotion(f.project);
  const weakened=await executeMotion(f.project,{mode:"edit",request:"сделай колебания послабее",expectedRevision:before.revision,settings:{provider:"core-retime-fixture",model:""}},()=>{},{config:{maxLLMCalls:1,maxRepairAttempts:0}});
  assert.equal(weakened.reconciliation?.status,"SUCCESS");s=(await readMotion(f.project)).state;assert.equal(s.expressions!.find(e=>e.expressionId===effect.expressionId)!.parameters.amplitude,effect.parameters.amplitude!*.75);
  s=await turn("пусть колебания тарелка затухают медленнее","тарелка",["inertialOvershoot"],[{key:"decayFactor",value:.8}],{effectOperation:{storage:"expression",action:"update"}});
  assert.equal((s.expressions!.find(e=>e.expressionId===effect.expressionId)!.parameters as {decay:number}).decay,(effect.parameters as {decay:number}).decay*.8);
  s=await turn("добавь постоянный wiggle у тарелка","тарелка",["wiggle"],[{key:"lifetime",value:"project"}],{kind:"objectAnimation",targetScope:"logicalObject"});
  const wiggles=structuredClone(s.expressions!.filter(e=>e.type==="wiggle"));
  s=await turn("сделай wiggle у тарелка чуть быстрее","тарелка",["wiggle"],[{key:"frequencyFactor",value:1.25}],{effectOperation:{storage:"expression",action:"update"}});
  for(const old of wiggles){const next=s.expressions!.find(e=>e.expressionId===old.expressionId)!;assert.ok(next.type==="wiggle");assert.equal(next.parameters.frequency,old.parameters.frequency*1.25);assert.equal(next.parameters.amplitude,old.parameters.amplitude);}
  s=await turn("убери wiggle у тарелка","тарелка",["wiggle"],[],{effectOperation:{storage:"expression",action:"remove"}});assert.equal(s.expressions!.some(e=>e.type==="wiggle"),false);assert.deepEqual(s.animations.find(a=>a.targetId==="plate"),plateBase);
  s=await turn("пусть анимация петрушка 2 начинается чуть позже анимации базилик","петрушка 2",[],[],{effectOperation:{storage:"animation",action:"updateTiming"},delayPolicy:"slightlyLater",temporalReference:{kind:"existingAnimation",target:{name:"базилик"},endpoint:"start"}});
  assert.equal(s.animations.find(a=>a.animationId===p.animationId)!.startFrame,6);assert.equal(s.animations.find(a=>a.animationId==="parsley-fade")!.startFrame,6);assert.equal(s.expressions!.find(e=>e.expressionId==="parsley-inertia")!.startFrame,18);assert.deepEqual(s.animations.find(a=>a.animationId===b.animationId),b);
  s=await turn("пусть анимация петрушка 2 начинается когда заканчивается анимация базилик","петрушка 2",[],[],{effectOperation:{storage:"animation",action:"updateTiming"},temporalReference:{kind:"existingAnimation",target:{name:"базилик"},endpoint:"end"}});
  assert.equal(s.animations.find(a=>a.animationId===p.animationId)!.startFrame,17);
  s=await turn("анимация петрушка 2 заканчивается одновременно с анимацией базилик","петрушка 2",[],[],{align:"end",effectOperation:{storage:"animation",action:"updateTiming"},temporalReference:{kind:"existingAnimation",target:{name:"базилик"},endpoint:"end"}});
  assert.equal(s.animations.find(a=>a.animationId===p.animationId)!.startFrame,5);assert.ok(s.timingDependencies!.some(d=>d.animationId===p.animationId&&d.relation==="endWith"));
  s=await turn("пусть анимация ленты 2 начинается когда заканчивается анимация ленты 1","лента 2",["trimPath"],[],{effectOperation:{storage:"animation",action:"updateTiming"},temporalReference:{kind:"existingAnimation",target:{name:"лента 1"},effect:"trimPath",endpoint:"end"}});
  assert.equal(s.animations.find(a=>a.animationId==="ribbon-2")!.startFrame,72);assert.equal(s.animations.filter(a=>a.effect==="trimPath").length,2);
  s=await turn("движение тарелка с 1 до 3 секунд","тарелка",["slideUp"],[{key:"durationSeconds",value:2}],{start:{unit:"seconds",value:1},effectOperation:{storage:"animation",action:"updateTiming"}});
  assert.equal(s.animations.find(a=>a.animationId===plateBase.animationId)!.startFrame,12);assert.equal(s.expressions!.find(e=>e.expressionId===effect.expressionId)!.startFrame,36);
  s=await turn("убери колебания у тарелка","тарелка",["inertialOvershoot"],[],{effectOperation:{storage:"expression",action:"remove"}});assert.ok(s.animations.some(a=>a.animationId===plateBase.animationId));assert.equal(s.expressions!.filter(e=>e.targetId==="plate").length,0);
  s=await turn("тарелка статична с самого начала весь ролик без анимации","тарелка",[],[],{motionAction:"freezeProject"});assert.equal(s.animations.some(a=>a.targetId==="plate"),false);assert.equal(s.staticObjects?.length,1);
 }finally{stop();await closeNativeRenderer();await f.cleanup();}
});
