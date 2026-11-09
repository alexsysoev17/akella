import test from "node:test";
import assert from "node:assert/strict";
import {identityFixture,node} from "./identity-fixture.js";
import {readMotion,changeMotion} from "../src/motion/store.js";
import {logicalId} from "../src/motion/registry.js";
import {registerProvider} from "../src/harness/providers/index.js";
import {executeMotion} from "../src/motion/service.js";
import {renderProjectFrame} from "../src/native/service.js";
import {closeNativeRenderer} from "../src/native/client.js";
import {exportVideo} from "../src/motion/video.js";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import path from "node:path";
process.env.AKELLA_RENDERER="native";
const graph=(prompt:string,targets:string[],extra:object)=>({schemaVersion:"semantic-graph/1.0",clauses:[{clauseId:"c",text:prompt}],actions:[{actionId:"a",clauseId:"c",kind:"editAnimation",scene:null,targets,techniques:[],parameters:[],constraints:[],unresolvedReason:null,...extra}],assumptions:[]});
test("all-animation removal freezes one logical QR across three scene instances from frame zero; native QA/MP4/Undo",async()=>{
 const ids=["15:5212","25:1646","63:1469"];
 const f=await identityFixture(4,scenes=>scenes.forEach((s,i)=>{s.children=[node(`other${i}`,"Unrelated",150,75)];if(i)s.children.push(node(ids[i-1],"куар",20+i*25,30,24,24));}));
 let response:unknown,calls=0;
 const stop=registerProvider("freeze-native-fixture",()=>({id:"freeze-native-fixture",mode:"mock",capabilities:()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false}),generate:async()=>{calls++;return{output:response,usage:null,estimatedCost:null,latencyMs:0,diagnostics:["prepared semantics, real native execution"],toolCalls:[]};}}));
 try{
  const doc=await readMotion(f.project);f.state.settings.durationFrames=120;f.state.blocks.forEach((b,i)=>{b.startFrame=i*30;b.durationFrames=30;});
  const animations=ids.flatMap((targetId,i)=>[{animationId:`base${i}`,sceneId:`s${i+1}`,targetId,effect:"slideUp" as const,startFrame:(i+1)*30,durationFrames:9,easing:"linear" as const,enabled:true,parameters:{distance:30,mode:"in" as const}},{animationId:`fade${i}`,sceneId:`s${i+1}`,targetId,effect:"fadeIn" as const,startFrame:(i+1)*30,durationFrames:9,easing:"linear" as const,enabled:true,parameters:{from:0,to:1}}]);
  const unrelated={...animations[0],animationId:"unrelated",sceneId:"s0",targetId:"other0",startFrame:0};
  await changeMotion(f.project.root,{expectedRevision:doc.revision,request:"synthetic seed",operations:[{type:"setProjectSettings",settings:f.state.settings},{type:"setBlocks",blocks:f.state.blocks},...animations.map(animation=>({type:"addAnimation" as const,animation})),{type:"addAnimation",animation:unrelated},...ids.map((targetId,i)=>({type:"setExpression" as const,expression:{expressionId:`inertia${i}`,sceneId:`s${i+1}`,targetId,type:"inertialOvershoot" as const,property:"y" as const,sourceAnimationId:`base${i}`,startFrame:(i+1)*30+9,durationFrames:18,enabled:true,parameters:{mode:"ae" as const,amplitude:.2,frequency:2.5,decay:3,velocityLookbackFrames:3}}}))]});
  const before=await readMotion(f.project),prompt="убери анимацию у куар - пусть он будет стоять с самого начала весь видос статично";
  response=graph(prompt,["куар"],{motionAction:"freezeProject",targetScope:"logicalObject"});
  const result=await executeMotion(f.project,{mode:"edit",request:prompt,expectedRevision:before.revision,settings:{provider:"freeze-native-fixture",model:""}},()=>{},{config:{maxLLMCalls:1,maxRepairAttempts:0}});
  assert.equal(result.reconciliation?.status,"SUCCESS",await readFile(path.join(f.project.root,"motion/ai",result.id,"tasks.json"),"utf8"));assert.equal(calls,1);
  const after=await readMotion(f.project);assert.deepEqual(after.state.animations,[unrelated]);assert.equal(after.state.expressions?.length,0);assert.equal(after.state.staticObjects?.[0].logicalObjectId,logicalId("куар"));
  let pose:unknown;
  for(const frame of [0,29,30,59,60,89,90,119]){const r=await renderProjectFrame(f.project,frame,{encoding:"rgba"});const qr=r.hits.filter(h=>ids.includes(h.targetId));assert.equal(qr.length,1);pose??=qr[0].points;assert.deepEqual(qr[0].points,pose);}
  const video=await exportVideo(f.project.root,()=>{},{renderer:"native"});assert.ok("frameDigests" in video);
  for(const digest of video.frameDigests){const r=await renderProjectFrame(f.project,digest.frame,{encoding:"rgba"});assert.equal(createHash("sha256").update(r.png).digest("hex"),digest.sha256);}
  await changeMotion(f.project.root,{expectedRevision:after.revision,request:"undo freeze",action:"undo"});assert.deepEqual((await readMotion(f.project)).state,before.state);
 }finally{stop();await closeNativeRenderer();await f.cleanup();}
});
