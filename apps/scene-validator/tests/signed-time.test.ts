import test from "node:test";
import assert from "node:assert/strict";
import { identityFixture, node } from "./identity-fixture.js";
import {objectRequirement} from "./intent-fixture.js";
import { applyOperations, validateMotion } from "../src/motion/operations.js";
import { evaluateAnimation, evaluateMotion } from "../src/motion/evaluation.js";
import { preflightIntentPlan, runIntentTasks } from "../src/motion/intent/execution.js";
import {recoverPreflight} from "../src/harness/recovery/runtime.js";
import {recoveryPolicySchema} from "../src/harness/recovery/config.js";
import {intervalEnd,MAX_FLOAT32} from "../src/motion/time.js";
import {codeSourceContext} from "../src/harness/recovery/source-context.js";
import type {Animation,MotionState} from "../src/motion/schema.js";
import type {IntentPlan} from "../src/motion/intent/schema.js";
export const move=(id:string,start:number,target=id):Extract<Animation,{effect:"moveTo"}>=>({animationId:id,sceneId:"s0",targetId:target,startFrame:start,durationFrames:60,easing:"linear",enabled:true,effect:"moveTo",parameters:{fromX:0,fromY:0,toX:100,toY:50}});
export function shiftPlan(ids:string[],delta=-60):IntentPlan{return {schemaVersion:"1.0.0",assumptions:[],coverage:[],requirements:ids.map(id=>({...objectRequirement(id,"s0",id,id,["moveTo"],"shift existing motion"),kind:"editAnimation",animationIds:[id],effectOperation:{storage:"animation",action:"updateTiming"},timing:{startSeconds:null,relation:"unchanged",anchorRequirementId:null,delaySeconds:0,offsetFrames:delta}}))};}
function preparedState(f: {state:MotionState;project:Parameters<typeof applyOperations>[2]},pre:ReturnType<typeof preflightIntentPlan>) {return [...pre.preparedPlans.values()].reduce((s,p)=>applyOperations(s,p.compiled.operations,f.project),f.state);}
async function fixture(){const f=await identityFixture(2,scenes=>{scenes[0].children=[node("A","A"),node("B","B"),node("C","C")];});f.state.animations=[move("A",90),move("B",150),move("C",210)];f.state.timingDependencies=[{dependencyId:"ab",animationId:"B",anchorAnimationId:"A",relation:"after",offsetFrames:0},{dependencyId:"bc",animationId:"C",anchorAnimationId:"B",relation:"after",offsetFrames:0}];return f;}
test("signed frames: half progress at zero, completed hold, future intervals and safe arithmetic",async()=>{
 const f=await fixture();try{let s=validateMotion({...f.state,animations:[move("A",-30)],timingDependencies:[]},f.project);
 assert.equal(evaluateMotion(s,0).nodes['["s0","A"]'].x,50);assert.equal(evaluateMotion(s,-15).nodes['["s0","A"]'].x,25);
 s=validateMotion({...s,animations:[move("A",-90)]},f.project);assert.equal(evaluateMotion(s,0).nodes['["s0","A"]'].x,100);
 validateMotion({...s,animations:[move("A",600)]},f.project);
 assert.throws(()=>intervalEnd({startFrame:Number.MAX_SAFE_INTEGER,durationFrames:1}),/INVALID_GLOBAL_FRAME/);
 assert.throws(()=>validateMotion({...s,animations:[{...move("A",0),startFrame:NaN}]},f.project));
 assert.throws(()=>validateMotion({...s,animations:[{...move("A",0),parameters:{fromX:0,fromY:0,toX:MAX_FLOAT32*2,toY:0}}]},f.project));
 }finally{await f.cleanup();}
});
test("anchor and group shifts preserve edges, use committed baselines and avoid double propagation in reverse requirement order",async()=>{
 const f=await fixture();try{
 for(const ids of [["A"],["A","B"],["B","A"],["C","A"]]){
 const p=shiftPlan(ids,-120),r=preflightIntentPlan(f.project,f.state,p);assert.deepEqual(preparedState(f,r).animations.map(a=>a.startFrame),[-30,30,90]);assert.deepEqual(preparedState(f,r).timingDependencies,f.state.timingDependencies);assert.deepEqual(preparedState(f,r).settings,f.state.settings);
 const result=await runIntentTasks(f.project,f.state,p,{repair:async()=>{throw Error("no model");},verify:async()=>({status:"PASSED"}),commit:async(_t,_p,s)=>s,trace:async()=>{},preparedPlans:r.preparedPlans});assert.equal(result.reconciliation.status,"SUCCESS");
 }
 const child=preparedState(f,preflightIntentPlan(f.project,f.state,shiftPlan(["B"],5)));assert.deepEqual(child.animations.map(a=>a.startFrame),[90,155,215]);assert.equal(child.timingDependencies![0].offsetFrames,5);
 assert.equal(preparedState(f,preflightIntentPlan(f.project,f.state,shiftPlan(["A"],5))).timingDependencies!.some(d=>d.anchorAnimationId===d.animationId),false);
 }finally{await f.cleanup();}
});
test("genuine cycles and unrelated scope mutations remain rejected",async()=>{
 const f=await fixture();try{assert.throws(()=>applyOperations(f.state,[{type:"setTimingDependency",dependency:{dependencyId:"ca",animationId:"A",anchorAnimationId:"C",relation:"after",offsetFrames:0}}],f.project),/cycle/i);
 const bad={...shiftPlan(["A"])};const task=(await import('../src/motion/intent/compiler.js')).compileTasks(f.project,bad)[0];const {admitCompiledTask}=await import('../src/motion/intent/execution.js');assert.throws(()=>admitCompiledTask(f.project,f.state,bad,task,{status:"ready",summary:"bad",assumptions:[],warnings:[],operations:[{type:"shiftAnimation",animationId:"A",deltaFrames:-60},{type:"updateAnimation",animationId:"C",animation:{...f.state.animations[2],easing:"easeInOutCubic"}}]}),/TASK_SCOPE/);
 }finally{await f.cleanup();}
});
test("inertia reanchors exactly once through direct and dependency-driven retiming",async()=>{
 const f=await fixture();try{f.state.expressions=[{expressionId:"ib",sceneId:"s0",targetId:"B",property:"x",type:"inertialOvershoot",sourceAnimationId:"B",startFrame:210,durationFrames:36,enabled:true,parameters:{amplitude:.25,frequency:2,decay:3,velocityLookbackFrames:6,mode:"ae"}}];
 const next=preparedState(f,preflightIntentPlan(f.project,f.state,shiftPlan(["B","A"],-180)));assert.equal(next.expressions![0].startFrame,30);assert.equal(next.animations[1].startFrame,-30);assert.equal(next.expressions![0].expressionId,"ib");
 }finally{await f.cleanup();}
});
test("Level1 deterministically recompiles stale temporal scope failure and final reconciliation accepts",async()=>{
 const f=await fixture();try{const plan=shiftPlan(["A","B"]);const {compileTasks}=await import('../src/motion/intent/compiler.js');let calls=0;const recovered=await recoverPreflight(f.project,f.state,plan,Object.assign(Error("TASK_SCOPE_VIOLATION"),{report:{code:"TASK_SCOPE_VIOLATION",taskId:compileTasks(f.project,plan)[0].taskId}}),{policy:recoveryPolicySchema.parse({codeRepair:{enabled:false}}),revision:"fixture",request:"shift",checkpoint:()=>{},decide:async()=>{calls++;throw Error('not needed');},record:async()=>{}});
 assert.equal(calls,0);assert.equal(recovered.report.procedure,"deterministic-global-retiming/1");
 const result=await runIntentTasks(f.project,f.state,recovered.plan,{repair:async()=>{throw Error("not needed");},verify:async()=>({status:"PASSED"}),commit:async(_t,_p,s)=>s,trace:async()=>{},preparedPlans:recovered.prepared.preparedPlans});assert.equal(result.reconciliation.status,"SUCCESS");
 }finally{await f.cleanup();}
});
test("seeded signed-time dependency/property checks and bounded source retrieval",async()=>{
 const f=await fixture();try{let seed=123;for(let i=0;i<120;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const delta=(seed%1000)-500;const s=preparedState(f,preflightIntentPlan(f.project,f.state,shiftPlan(["B","A"],delta)));assert.deepEqual(s.animations.map(a=>a.startFrame),[90+delta,150+delta,210+delta]);assert.deepEqual(evaluateMotion(s,0),evaluateMotion(s,0));assert.equal(s.settings.durationFrames,f.state.settings.durationFrames);}
 const files=[{path:"compiler.ts",hash:"test",content:"import x from 'x';\n"+"unrelated\n".repeat(15000)+"removeTimingDependency\n"+"more\n".repeat(10000)}];const c=codeSourceContext(files,15000);assert.ok(c.metrics.originalBytes>100000);assert.ok(c.metrics.transmittedBytes<15000);assert.equal(c.files[0].complete,false);
 }finally{await f.cleanup();}
});

test("signed organizational anchors are independent from the visible video block range",async()=>{
 const f=await fixture();try{
 const r={...objectRequirement("scene","s0","A","A",[],"scene starts before output"),kind:"sceneTiming" as const,timing:{startSeconds:-1,relation:"sceneStart" as const,anchorRequirementId:null,delaySeconds:0}};
 const plan:IntentPlan={schemaVersion:"1.0.0",requirements:[r],coverage:[],assumptions:[]};
 const next=preparedState(f,preflightIntentPlan(f.project,f.state,plan));assert.equal(next.sceneAnchors![0].startFrame,-f.state.settings.fps);assert.deepEqual(next.blocks,f.state.blocks);assert.deepEqual(next.settings,f.state.settings);assert.equal(next.animations[0].startFrame,90-f.state.settings.fps);
 }finally{await f.cleanup();}
});
test("compound preroll interpolation, custom easing, fractional velocity and seeded mixed FPS remain deterministic",async()=>{
 const f=await fixture();try{
 const base=move("A",-30);
 const effects:Animation[]=[base,{...base,animationId:"fade",effect:"fadeIn",parameters:{from:0,to:1}},{...base,animationId:"scale",effect:"scaleIn",parameters:{from:.5,to:1.5}},{...base,animationId:"rotate",effect:"rotation",parameters:{from:0,to:180}},{...base,animationId:"slide",targetId:"B",effect:"slideUp",parameters:{distance:5000,mode:"in"}}];
 const s=validateMotion({...f.state,animations:effects,timingDependencies:[]},f.project),v=evaluateMotion(s,0).nodes['["s0","A"]'];assert.equal(v.opacity,.5);assert.equal(v.scale,1);assert.equal(v.rotation,90);assert.equal(evaluateMotion(s,0).nodes['["s0","B"]'].y,2500);
 for(const fps of [24,30,60])for(const start of [-180,-30,0,400])for(const durationFrames of [7,60,301]){
 const a={...base,startFrame:start,durationFrames,easing:"easeInOutCubic" as const,parameters:{fromX:-2500,fromY:5000,toX:5000,toY:-3000}};
 const x=evaluateAnimation(a,0), shifted=evaluateAnimation({...a,startFrame:start+300},300);assert.deepEqual(x,shifted);assert.ok(Object.values(x).every(Number.isFinite));
 const {velocityAtTime}=await import('../src/motion/evaluation.js');const velocity=velocityAtTime(a,(start+durationFrames-.1)/fps,fps);assert.ok(Object.values(velocity).every(Number.isFinite));
 }
 }finally{await f.cleanup();}
});
