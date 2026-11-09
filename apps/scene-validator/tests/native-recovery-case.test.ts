import test from "node:test";
import assert from "node:assert/strict";
import {identityFixture,node} from "./identity-fixture.js";
import {registerProvider} from "../src/harness/providers/index.js";
import {executeMotion} from "../src/motion/service.js";
import {changeMotion,readMotion} from "../src/motion/store.js";
import {renderNativeFrame,closeNativeRenderer} from "../src/native/client.js";
import {exportVideo} from "../src/motion/video.js";
import {createHash} from "node:crypto";
process.env.AKELLA_RENDERER="native";
// Exact user wording; synthetic shapes stand in for client media. Prepared provider, NOT live semantic evidence.
const clauses=["объект Абонементы на любимую еду и напитки появляется через фэйд, ","тарелка появляется снизу вверх в начале меделенно в конце быстро и крутится на 180 градусов, ","куар появляется справа на лево, ","лого появляются по скейлу из нуля к ста процентам,","лента 2 и лента 1 рисуется по очереди первая будет лента 1,","с выгодой до 80% появляется слева на право с бонус эффектом в конце, ","петрушка 1 морковь петрушка 2 базилик будто вылетало от камеры"];
const names=["Абонементы на любимую еду и напитки","тарелка","куар","лого","лента 1","лента 2","с выгодой до 80%","петрушка 1","морковь","петрушка 2","базилик"];
test("reported Russian multi-clause case: production compile, commit, native QA and Preview/MP4 source frames",async()=>{
 const f=await identityFixture(2,scenes=>{scenes[1].children=names.map((name,i)=>{const n=node("n"+i,name,10+(i%4)*40,10+Math.floor(i/4)*30,20,20);if(i===4||i===5){n.type="VECTOR";n.properties={...n.properties,fills:[],strokes:[{type:"SOLID",color:{r:0,g:0,b:0}}],strokeWeight:2,strokeAlign:"CENTER",vectorPaths:[{data:"M0 0 C5 15 15 -5 25 10",windingRule:"NONZERO"}]};}return n;});});
 const action=(id:string,clause:number,targets:string[],techniques:string[],parameters:unknown[]=[])=>({actionId:id,clauseId:"c"+clause,kind:"objectAnimation",scene:"s1",targets,techniques,parameters,constraints:[],unresolvedReason:null});
 const response={schemaVersion:"semantic-graph/1.0",clauses:clauses.map((text,i)=>({clauseId:"c"+i,text})),actions:[action("title",0,[names[0]],["fadeIn"]),action("plate",1,[names[1]],["slideUp"],[{key:"easing",value:"easeInCubic"}]),action("rotation",1,[names[1]],["rotation"],[{key:"distance",value:180}]),action("qr",2,[names[2]],["slideLeft"]),action("logo",3,[names[3]],["scaleIn"],[{key:"scaleFrom",value:0},{key:"scaleTo",value:1}]),action("ribbon1",4,[names[4]],["trimPath"]),{...action("ribbon2",4,[names[5]],["trimPath"]),dependsOn:"ribbon1",inheritFrom:"ribbon1"},action("benefit",5,[names[6]],["slideRight","inertialOvershoot"]),action("ingredients",6,names.slice(7),["scaleIn"],[{key:"scaleFrom",value:3},{key:"scaleTo",value:1}])],assumptions:["Бонус — умеренная позиционная инерция; впечатление движения от камеры — уменьшение масштаба 3 → 1 в 2D, не настоящая 3D камера."]};
 let calls=0;const stop=registerProvider("recovery-case-fixture",()=>({id:"recovery-case-fixture",mode:"mock",capabilities:()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false}),generate:async()=>{calls++;return {output:response,usage:null,estimatedCost:null,latencyMs:0,diagnostics:["synthetic prepared semantic response"],toolCalls:[]};}}));
 try{
  const initial=await readMotion(f.project);f.state.settings.durationFrames=72;f.state.blocks[1].durationFrames=60;
  await changeMotion(f.project.root,{expectedRevision:initial.revision,request:"fixture settings",operations:[{type:"setProjectSettings",settings:f.state.settings},{type:"setBlocks",blocks:f.state.blocks}]});
  const result=await executeMotion(f.project,{request:clauses.join(""),mode:"edit",expectedRevision:(await readMotion(f.project)).revision,settings:{provider:"recovery-case-fixture"}},()=>{}, {config:{maxLLMCalls:1,maxRepairAttempts:0}});
  assert.equal(result.status,"applied",JSON.stringify(result));assert.equal(calls,1);
  const {state}=await readMotion(f.project), animations=state.animations;
  for(const [i,effect] of [[0,"fadeIn"],[1,"slideUp"],[1,"rotation"],[2,"slideLeft"],[3,"scaleIn"],[4,"trimPath"],[5,"trimPath"],[6,"slideRight"],[7,"scaleIn"],[8,"scaleIn"],[9,"scaleIn"],[10,"scaleIn"]] as const)assert.ok(animations.some(a=>a.targetId==="n"+i&&a.effect===effect));
  const first=animations.find(a=>a.targetId==="n4")!,second=animations.find(a=>a.targetId==="n5")!;assert.equal(second.startFrame,first.startFrame+first.durationFrames);
  assert.ok(state.expressions?.some(e=>e.targetId==="n6"&&e.type==="inertialOvershoot"));
  assert.equal(animations.filter(a=>a.effect==="trimPath").length,2);
  const frame=await renderNativeFrame(f.project,state,first.startFrame+Math.floor(first.durationFrames/2));assert.ok(frame.paths.some(p=>p.targetId==="n4"&&p.end>0&&p.end<1));assert.deepEqual(frame.png,(await renderNativeFrame(f.project,state,first.startFrame+Math.floor(first.durationFrames/2),{cache:false})).png);
  const video=await exportVideo(f.project.root);assert.ok("frameDigests" in video);for(const d of video.frameDigests){const rendered=await renderNativeFrame(f.project,state,d.frame,{encoding:"rgba"});assert.equal(createHash("sha256").update(rendered.png).digest("hex"),d.sha256);}
 }finally{stop();await closeNativeRenderer();await f.cleanup();}
});
