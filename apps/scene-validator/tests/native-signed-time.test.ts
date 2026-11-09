import test from "node:test";
import assert from "node:assert/strict";
import {identityFixture,node} from "./identity-fixture.js";
import {objectRequirement} from "./intent-fixture.js";
import {renderNativeFrame,closeNativeRenderer,compareNativeFrames} from "../src/native/client.js";
import {nativeMotionQA} from "../src/native/qa.js";
import {validateMotion,applyOperations} from "../src/motion/operations.js";
import {evaluateMotion} from "../src/motion/evaluation.js";
import {exportVideo} from "../src/motion/video.js";
import {changeMotion,readMotion} from "../src/motion/store.js";
import {registerProvider} from "../src/harness/providers/index.js";
import {executeMotion} from "../src/motion/service.js";
import {readFile} from "node:fs/promises";
import {statePresentation} from "../src/motion/transitions.js";
import {interpolateState} from "../src/motion/transition-runtime.js";
import {createHash} from "node:crypto";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createRequire} from "node:module";
import type {Animation} from "../src/motion/schema.js";
process.env.AKELLA_RENDERER="native";
async function fixture(){
 const f=await identityFixture(3,scenes=>{scenes[2].children=[node("moving","Moving",10,15,20,20),...[1,2].map(i=>{const n=node(`r${i}`,`Ribbon ${i}`,10,50+i*20,150,15);n.type="VECTOR";n.properties={...n.properties,fills:[],strokes:[{type:"SOLID",color:{r:1,g:0,b:0}}],strokeWeight:2,strokeAlign:"CENTER",vectorPaths:[{data:"M0 0 C50 20 100 -20 150 0",windingRule:"NONZERO"}]};return n;})];});
 f.state.settings.fps=30;return f;
}
const trim=(id:string,start=-30):Extract<Animation,{effect:"trimPath"}>=>({animationId:id,sceneId:"s2",targetId:id,startFrame:start,durationFrames:60,easing:"linear",enabled:true,effect:"trimPath",parameters:{from:0,to:1,direction:"forward"}});
test("native signed pre-roll: actual half Trim Paths/position at frame zero; completed hold and scene-independent lifetime",async()=>{
 const f=await fixture();try{
 const base:Animation={animationId:"m",sceneId:"s2",targetId:"moving",startFrame:-30,durationFrames:60,easing:"linear",enabled:true,effect:"moveTo",parameters:{fromX:0,fromY:0,toX:100,toY:0}};
 const s=validateMotion({...f.state,animations:[base,trim("r1")],objectTransitions:[]},f.project);
 const actual=await renderNativeFrame(f.project,s,0), expected=await renderNativeFrame(f.project,{...s,animations:[{...base,parameters:{fromX:50,fromY:0,toX:50,toY:0}},{...trim("r1"),parameters:{from:.5,to:.5,direction:"forward"}}]},0);
 assert.deepEqual(actual.png,expected.png);assert.ok(actual.paths.some(p=>p.targetId==="r1"&&p.end===.5));assert.ok(actual.hits.some(h=>h.targetId==="moving"&&Math.abs(h.points[0].x-60)<1e-6));
 const completed=await renderNativeFrame(f.project,{...s,animations:[trim("r1",-90)]},0);assert.ok(completed.paths.some(p=>p.targetId==="r1"&&p.end===1));
 assert.deepEqual(actual.png,(await renderNativeFrame(f.project,s,0,{cache:false})).png);
 }finally{await closeNativeRenderer();await f.cleanup();}
});
test("native offscreen motion is not clamped; fully offscreen geometry has no pixels and QA distinguishes it",async()=>{
 const f=await fixture();try{
 const a:Animation={animationId:"off",sceneId:"s2",targetId:"moving",startFrame:0,durationFrames:60,easing:"linear",enabled:true,effect:"moveTo",parameters:{fromX:-2500,fromY:0,toX:0,toY:0}};
 const s=validateMotion({...f.state,animations:[a],objectTransitions:[]},f.project);
 const first=await renderNativeFrame(f.project,s,0),hidden=await renderNativeFrame(f.project,{...s,visibility:[{sceneId:"s2",targetId:"moving",visible:false}]},0);
 assert.deepEqual(first.png,hidden.png);assert.equal(first.hits.find(h=>h.targetId==="moving")!.points[0].x,-2490);
 const entered=await renderNativeFrame(f.project,s,60);assert.notDeepEqual(first.png,entered.png);
 const big=validateMotion({...s,animations:[{...a,parameters:{fromX:1e20,fromY:-1e20,toX:1e20,toY:-1e20}}]},f.project);assert.deepEqual((await renderNativeFrame(f.project,big,0)).png,hidden.png);
 const offTrim={...s,animations:[trim("r1",-30),{...a,targetId:"r1",parameters:{fromX:5000,fromY:0,toX:5000,toY:0}}]};
 const qa=await nativeMotionQA(f.project,offTrim,"validation/offscreen-test","intentional offscreen");assert.notEqual(qa.status,"FAILED",JSON.stringify(qa.checks.filter(c=>c.status==="FAILED")));
 }finally{await closeNativeRenderer();await f.cleanup();}
});
test("production semantic-to-render execution shifts connected ribbons once and exports exactly the visible window",async()=>{
 const f=await fixture();let calls=0;const request="shift both ribbons 60 frames earlier";
 const response={schemaVersion:"semantic-graph/1.0",clauses:[{clauseId:"c",text:request}],actions:[{actionId:"a",clauseId:"c",kind:"editAnimation",scene:"s2",targets:["Ribbon 1","Ribbon 2"],techniques:["trimPath"],parameters:[],effectOperation:{storage:"animation",action:"updateTiming"},delayFrames:-60,constraints:[],unresolvedReason:null}],assumptions:[]};
 const stop=registerProvider("signed-fixture",()=>({id:"signed-fixture",mode:"mock",capabilities:()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false}),generate:async()=>{calls++;return{output:response,usage:null,estimatedCost:null,latencyMs:0,diagnostics:["prepared semantic fixture; actual execution/native QA"],toolCalls:[]};}}));
 try{
 const old=await readMotion(f.project);await changeMotion(f.project.root,{expectedRevision:old.revision,request:"seed",operations:[{type:"setProjectSettings",settings:f.state.settings},{type:"setBlocks",blocks:f.state.blocks},{type:"removeObjectStateTransition",transitionId:"qr-move"},...([{...trim("r1",30),durationFrames:21},{...trim("r2",51),durationFrames:21}]).map(animation=>({type:"addAnimation",animation})),{type:"setTimingDependency",dependency:{dependencyId:"r12",animationId:"r2",anchorAnimationId:"r1",relation:"after",offsetFrames:0}}]});
 const result=await executeMotion(f.project,{mode:"edit",expectedRevision:(await readMotion(f.project)).revision,request,settings:{provider:"signed-fixture"}},()=>{});assert.equal(result.status,"applied",JSON.stringify(result));assert.equal(calls,1);
 const current=await readMotion(f.project);assert.deepEqual(current.state.animations.map(a=>a.startFrame),[-30,-9]);assert.equal(current.state.timingDependencies![0].offsetFrames,0);assert.equal(current.state.settings.durationFrames,f.state.settings.durationFrames);
 const video=await exportVideo(f.project.root);assert.equal(video.frames,current.state.settings.durationFrames);
 const ffmpeg=createRequire(import.meta.url)("ffmpeg-static");assert.equal(typeof ffmpeg,"string");
 const decoded=await promisify(execFile)(ffmpeg,["-v","error","-i",path.join(f.project.root,"renders",video.file),"-f","rawvideo","-pix_fmt","rgba","pipe:1"],{encoding:"buffer",maxBuffer:16*1024*1024});
 assert.equal(decoded.stdout.byteLength/(current.state.settings.width*current.state.settings.height*4),current.state.settings.durationFrames);

 assert.ok("frameDigests" in video);
 for (const d of video.frameDigests) {const frame=await renderNativeFrame(f.project,current.state,d.frame,{encoding:"rgba"});assert.equal(createHash("sha256").update(frame.png).digest("hex"),d.sha256); }
 assert.equal(evaluateMotion(current.state,0).nodes['["s2","r1"]'].trim,1);
 }finally{stop();await closeNativeRenderer();await f.cleanup();}
});

test("native logical transitions and incoming inertia evaluate across frame zero without resetting identity",async()=>{
 const f=await identityFixture(3);try{
 const t={...f.transition,startFrame:-30,durationFrames:60,easing:"linear" as const};
 const s=validateMotion({...f.state,objectTransitions:[t]},f.project);
 const p=statePresentation(f.project,s)[t.logicalObjectId], expected=interpolateState(p.s1,p.s2,t,0);
 const frame=await renderNativeFrame(f.project,s,0);const qr=frame.hits.filter(h=>/^qr/.test(h.targetId));assert.equal(qr.length,1);assert.ok(Math.abs(qr[0].points[0].x-expected.matrix[0][2])<1e-5);
 const completed={...s,objectTransitions:[{...t,startFrame:-90}]};const atZero=await renderNativeFrame(f.project,completed,0);assert.equal(atZero.hits.filter(h=>/^qr/.test(h.targetId)).length,1);assert.ok(atZero.hits.some(h=>h.targetId==="qr2"));
 const inertia=validateMotion({...completed,expressions:[{expressionId:"pre-inertia",sceneId:"s1",targetId:"qr1",property:"x",type:"inertialOvershoot",sourceAnimationId:t.transitionId,transitionId:t.transitionId,ownership:{scope:"transition",logicalObjectId:t.logicalObjectId},startFrame:-30,durationFrames:60,enabled:true,parameters:{mode:"ae",amplitude:.25,frequency:.7,decay:1,velocityLookbackFrames:6}}]},f.project);
 const v=evaluateMotion(inertia,0,statePresentation(f.project,inertia)).transitionEffects[t.transitionId].x!;assert.ok(Number.isFinite(v)&&Math.abs(v)>0);
 const swung=await renderNativeFrame(f.project,inertia,0);assert.notDeepEqual(swung.png,atZero.png);
 assert.ok(Math.abs(swung.hits.find(h=>h.targetId==="qr2")!.points[0].x-atZero.hits.find(h=>h.targetId==="qr2")!.points[0].x-v)<1e-5);

 }finally{await closeNativeRenderer();await f.cleanup();}
});
