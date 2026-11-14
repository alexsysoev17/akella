import test from 'node:test';import assert from 'node:assert/strict';
import {identityFixture,node} from './identity-fixture.js';
import {applyOperations} from '../src/motion/operations.js';import {projectTime} from '../src/motion/project-time.js';
import {readMotion,changeMotion} from '../src/motion/store.js';
import {evaluateMotion} from '../src/motion/evaluation.js';
import {compileRequirement,compileTasks} from '../src/motion/intent/compiler.js';
import {normalizeSemanticGraph} from '../src/motion/intent/graph.js';
import {buildContext} from '../src/motion/context.js';

test('Duration/FPS transaction: extend/shrink/reopen/Undo, second-locked motion and frame-locked dependency preserve data',async()=>{
 const f=await identityFixture(4,scenes=>scenes.forEach((s,i)=>s.children=[node('n'+i,'Object '+i,20,20,30,30)]));
 try{
 let doc=await readMotion(f.project);
 let state=applyOperations(doc.state,[{type:'setProjectTime',fps:30,durationSeconds:8},{type:'addAnimation',animation:{animationId:'a',sceneId:'s0',targetId:'n0',effect:'moveTo',parameters:{fromX:0,fromY:0,toX:80,toY:0},startFrame:60,durationFrames:30,easing:'linear',enabled:true}},{type:'addAnimation',animation:{animationId:'b',sceneId:'s0',targetId:'n0',effect:'fadeIn',parameters:{from:0,to:1},startFrame:110,durationFrames:15,easing:'linear',enabled:true}},{type:'setTimingDependency',dependency:{dependencyId:'d',animationId:'b',anchorAnimationId:'a',relation:'after',offsetFrames:20}},{type:'setTimingOrigin',origin:{entity:'dependency',id:'d',offset:{unit:'frames',value:20}}}],f.project);
 const old=structuredClone(state);
 state=applyOperations(state,[{type:'setProjectTime',durationSeconds:10}],f.project);
 assert.equal(projectTime(state).durationFrames,300);assert.deepEqual(state.animations,old.animations);assert.deepEqual(state.blocks,old.blocks);
 assert.deepEqual(evaluateMotion(state,75).nodes,evaluateMotion(old,75).nodes);
 state=applyOperations(state,[{type:'setProjectTime',fps:60}],f.project);
 assert.equal(state.animations[0].startFrame,120);assert.equal(state.animations[0].durationFrames,60);
 assert.equal(state.animations[1].startFrame,200);assert.equal(state.timingDependencies![0].offsetFrames,20);
 assert.equal(state.settings.durationFrames,600);
 for(const fps of [24,25,30,50,60]){const converted=applyOperations(state,[{type:'setProjectTime',fps}],f.project);assert.equal(converted.animations[0].startFrame,2*fps);assert.equal(converted.settings.durationFrames,10*fps);}
 state=applyOperations(state,[{type:'addAnimation',animation:{animationId:'late',sceneId:'s3',targetId:'n3',effect:'fadeIn',parameters:{from:0,to:1},startFrame:540,durationFrames:30,easing:'linear',enabled:true}},{type:'setProjectTime',durationSeconds:6}],f.project);
 assert.ok(projectTime(state).warnings.length);assert.ok(state.animations.some(a=>a.animationId==='late'));assert.equal(state.blocks.length,4);
 const restored=applyOperations(state,[{type:'setProjectTime',durationSeconds:20}],f.project);assert.equal(restored.animations.find(a=>a.animationId==='late')!.startFrame,540);
 const transaction=await changeMotion(f.project.root,{expectedRevision:doc.revision,request:'8 to 10',operations:[{type:'setProjectTime',durationSeconds:10,fps:60}]});
 const reopen=await readMotion(f.project);assert.equal(reopen.revision,transaction.document.revision);assert.equal(projectTime(reopen.state).durationSeconds,10);
 const undo=await changeMotion(f.project.root,{expectedRevision:reopen.revision,request:'Undo',action:'undo'});assert.deepEqual(undo.document.state,doc.state);
 const redo=await changeMotion(f.project.root,{expectedRevision:undo.document.revision,request:'Redo',action:'redo'});assert.deepEqual(redo.document.state,reopen.state);
 await assert.rejects(changeMotion(f.project.root,{expectedRevision:doc.revision,request:'stale settings',operations:[{type:'setProjectTime',fps:24}]}),e=>(e as {code?:string}).code==='STALE_PROJECT_REVISION');
 }finally{await f.cleanup();}
});

test('semantic graph preserves original frame units through compilation and FPS edits; legacy odd frames round-trip without drift',async()=>{
 const f=await identityFixture(1,scenes=>scenes[0].children=[node('n','QR',30,30),node('other','Phone',80,30)]);
 try{
 const prompt='на 2 секунде QR появляется через фейд спустя 20 кадров он движется снизу Phone появляется на 30 кадре';
 let state=applyOperations(f.state,[{type:'setProjectTime',fps:30,durationSeconds:10}],f.project);
 const graph={schemaVersion:'semantic-graph/1.0',clauses:[{clauseId:'c',text:prompt}],actions:[
 {actionId:'a',clauseId:'c',kind:'objectAnimation',scene:'s0',targets:['n'],techniques:['fadeIn'],start:{unit:'seconds',value:2},parameters:[],constraints:[],unresolvedReason:null},
 {actionId:'b',clauseId:'c',kind:'objectAnimation',scene:'s0',targets:['n'],techniques:['slideUp'],dependsOn:'a',relation:'afterRequirement',delayFrames:20,parameters:[],constraints:[],unresolvedReason:null},
 {actionId:'c',clauseId:'c',kind:'objectAnimation',scene:'s0',targets:['other'],techniques:['fadeIn'],start:{unit:'frames',value:30},parameters:[],constraints:[],unresolvedReason:null}],assumptions:[]};
 const p=normalizeSemanticGraph(graph,{...buildContext(f.project,state,prompt),objectIndex:[{sourceNodeId:"n",name:"QR",sceneId:"s0"},{sourceNodeId:"other",name:"Phone",sceneId:"s0"}]},prompt);
 for(const task of compileTasks(f.project,p))state=applyOperations(state,compileRequirement(f.project,state,p,task).operations,f.project);
 const before=structuredClone(state);
 state=applyOperations(state,[{type:'setProjectTime',fps:60}],f.project);
 const a=state.animations.find(a=>a.targetId==='n'&&a.effect==='fadeIn')!,b=state.animations.find(a=>a.effect==='slideUp')!;
 assert.equal(a.startFrame,120);assert.equal(b.startFrame-a.startFrame-a.durationFrames,20);
 assert.equal(state.animations.find(a=>a.targetId==='other')!.startFrame,30);
 assert.deepEqual(state.animations.map(a=>a.animationId),before.animations.map(a=>a.animationId));
 let odd=applyOperations(before,[{type:'addAnimation',animation:{...before.animations[0],animationId:'odd',targetId:'other',effect:'rotation',parameters:{from:0,to:90},startFrame:101,durationFrames:31}}],f.project);
 odd=applyOperations(odd,[{type:'setProjectTime',fps:24}],f.project);odd=applyOperations(odd,[{type:'setProjectTime',fps:30}],f.project);
 assert.equal(odd.animations.find(a=>a.animationId==='odd')!.startFrame,101);assert.equal(odd.animations.find(a=>a.animationId==='odd')!.durationFrames,31);
 }finally{await f.cleanup();}
});

test('inertia follows its original base endpoint after FPS conversion, including explicit frame-locked start; keyframes remain editable',async()=>{
 const f=await identityFixture(1,s=>s[0].children=[node('n','QR',20,20)]);
 try{
 let state=applyOperations(f.state,[{type:'setProjectTime',fps:30,durationSeconds:10},{type:'addAnimation',animation:{animationId:'a',sceneId:'s0',targetId:'n',effect:'keyframes',parameters:{property:'y',points:[{frame:0,value:60},{frame:15,value:30},{frame:30,value:0}]},startFrame:30,durationFrames:30,easing:'linear',enabled:true}},{type:'setTimingOrigin',origin:{entity:'animation',id:'a',start:{unit:'frames',value:30},duration:{unit:'seconds',value:1}}},{type:'setExpression',expression:{expressionId:'e',sourceAnimationId:'a',sceneId:'s0',targetId:'n',startFrame:60,durationFrames:30,type:'inertialOvershoot',property:'y',enabled:true,parameters:{mode:'ae',amplitude:.1,frequency:2,decay:3,velocityLookbackFrames:6}}}],f.project);
 state=applyOperations(state,[{type:'setProjectTime',fps:60}],f.project);
 assert.equal(state.animations[0].startFrame,30);assert.equal(state.animations[0].durationFrames,60);assert.equal(state.expressions![0].startFrame,90);
 const track=state.animations[0];assert.ok(track.effect==='keyframes');assert.deepEqual(track.parameters.points.map(k=>k.frame),[0,30,60]);
 state=applyOperations(state,[{type:'updateAnimation',animationId:'a',animation:{...track,parameters:{...track.parameters,points:track.parameters.points.map((k,i)=>i===1?{...k,frame:24}:k)}}},{type:'setStartFrame',animationId:'a',startFrame:50}],f.project);
 state=applyOperations(state,[{type:'setProjectTime',fps:30}],f.project);
 assert.equal(state.animations[0].startFrame,50,'manual edit refreshes frame provenance rather than reverting to the original frame 30');assert.equal(state.expressions![0].startFrame,80);
 const updated=state.animations[0];assert.ok(updated.effect==='keyframes');assert.equal(updated.parameters.points[1].frame,12,'edited keyframe timing is not replaced by obsolete provenance');
 }finally{await f.cleanup();}
});


test('project output duration round-trip retains intended seconds despite intermediate frame quantization',async()=>{
 const f=await identityFixture(1);try{
  let state=applyOperations(f.state,[{type:'setProjectTime',fps:60,durationSeconds:101/60}],f.project);
  state=applyOperations(state,[{type:'setProjectTime',fps:24}],f.project);assert.equal(state.settings.durationFrames,40);
  state=applyOperations(state,[{type:'setProjectTime',fps:60}],f.project);assert.equal(state.settings.durationFrames,101);
 }finally{await f.cleanup();}
});
