import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {interpolateState,transitionProgress,type PresentationState} from '../src/motion/transition-runtime.js';
import {objectTransitionSchema} from '../src/motion/schema.js';
import {resolveProductionModels} from '../src/motion/production-models.js';
import {identityFixture} from './identity-fixture.js';
import {applyOperations} from '../src/motion/operations.js';
import {statePresentation} from '../src/motion/transitions.js';
import {renderNativeFrame,closeNativeRenderer} from '../src/native/client.js';
import {WorkingRevision} from '../src/motion/working-revision.js';
import {validateExecutionLedger} from '../src/motion/direct-checkpoint.js';
after(()=>closeNativeRenderer());
const pose=(x:number):PresentationState=>({sourceNodeId:'a',normalized:[[20,0,x],[0,20,0]],parentCanvas:[[1,0,0],[0,1,0]],local:[[1,0,0],[0,1,0]],width:20,height:20,opacity:1,visible:true});
const transition=(space?:'canvasPixels'|'legacyProgress')=>objectTransitionSchema.parse({transitionId:'t',logicalObjectId:'o',fromSceneId:'a',toSceneId:'b',startFrame:0,durationFrames:30,easing:'linear',proceduralEffects:[{type:'dampedOscillation',amplitude:24,cycles:2,damping:3,...(space?{space}:{})}],layerPolicy:{type:'switch',switchProgress:.5}});
test('canvas-pixel oscillation remains independent of transition distance, scale and opacity; exact endpoints',()=>{
 const t=transition('canvasPixels');
 for(const distance of [0,100,10000])for(let frame=0;frame<=30;frame+=.25){const p=interpolateState(pose(0),pose(distance),t,frame);assert.ok(Math.abs(p.matrix[0][2]-distance*frame/30)<=24+1e-8);assert.equal(p.matrix[0][0],20);assert.equal(p.opacity,1);assert.ok(p.matrix.flat().every(Number.isFinite));assert.equal(transitionProgress(t,frame),frame/30);}
 assert.deepEqual(interpolateState(pose(0),pose(100),t,0).matrix,pose(0).normalized);
 assert.deepEqual(interpolateState(pose(0),pose(100),t,30).matrix,pose(100).normalized);
});
test('legacy serialized effects retain exact historical progress semantics',()=>{for(let f=0;f<=30;f++){const u=f/30,expected=u===0?0:u===1?1:u+24*Math.sin(Math.PI*u)**2*Math.sin(4*Math.PI*u)*Math.exp(-3*u);assert.equal(transitionProgress(transition(),f),expected);assert.equal(transitionProgress(transition('legacyProgress'),f),expected);}});
test('native rendered transition uses bounded pixel displacement and exact reference endpoint',async()=>{const f=await identityFixture();try{const t={...f.transition,proceduralEffects:transition('canvasPixels').proceduralEffects},state=applyOperations(f.state,[{type:'animateObjectStateTransition',...t}],f.project),p=statePresentation(f.project,state);let changed=false;for(const frame of [18,19,20,21,23,24]){const r=await renderNativeFrame(f.project,state,frame,{scale:.25,diagnostics:true}),base=await renderNativeFrame(f.project,{...state,objectTransitions:[{...t,proceduralEffects:[]}]},frame,{scale:.25,diagnostics:true});assert.ok(r.png.length);if(!Buffer.from(r.png).equals(base.png))changed=true;const v=interpolateState(p[t.logicalObjectId].s1,p[t.logicalObjectId].s2,t,frame);assert.ok(v.matrix.flat().every(Number.isFinite));}assert.ok(changed,'actual raster must observe secondary displacement');}finally{await f.cleanup();}});
test('failed technique replacement is atomic inside existing WorkingRevision',async()=>{const f=await identityFixture();try{const w=new WorkingRevision(f.project,'fixture',f.state,'Convert to procedural damping','minimal'),before=structuredClone(w.state);assert.throws(()=>w.apply([{type:'addAnimation',animation:{animationId:'base',sceneId:'s1',targetId:'qr1',effect:'slideUp',startFrame:12,durationFrames:4,easing:'linear',enabled:true,parameters:{distance:20,mode:'in'}}},{type:'setExpression',expression:{expressionId:'invalid',type:'inertialOvershoot',sceneId:'s1',targetId:'qr1',property:'y',sourceAnimationId:'missing',startFrame:16,durationFrames:3,enabled:true,parameters:{mode:'ae',amplitude:.2,frequency:2,decay:3,velocityLookbackFrames:1}}}],'atomic'));assert.deepEqual(w.state,before);assert.equal(w.batches.length,0);}finally{await f.cleanup();}});
test('advisory continuation ledger preserves exact source text and rejects fabricated clauses and dependency cycles',()=>{const request='Сцена 1: фон. Сцена 2: лого.',a={id:'one',sourceText:'Сцена 1: фон.',status:'done',dependsOn:[],nextAction:''},b={id:'two',sourceText:'Сцена 2: лого.',status:'pending',dependsOn:['one'],nextAction:'Animate logo'};assert.equal(validateExecutionLedger({objectives:[a,b]},request).objectives.length,2);assert.throws(()=>validateExecutionLedger({objectives:[{...a,sourceText:'invented'}]},request),/SOURCE_MISMATCH/);assert.throws(()=>validateExecutionLedger({objectives:[{...a,dependsOn:['two']},b]},request),/DEPENDENCY_CYCLE/);});
test('source inertia ends before transition and destination inertia follows its later motion without ownership conflict',async()=>{
 const f=await identityFixture();try{
 const ops:any[]=[{type:'animateObjectStateTransition',...f.transition}];
 for(const [sceneId,targetId,start]of [['s1','qr1',12],['s2','qr2',24]]as const){
 ops.push({type:'addAnimation',animation:{animationId:'base'+sceneId,sceneId,targetId,startFrame:start,durationFrames:3,enabled:true,effect:'property',easing:'linear',parameters:{property:'y',from:sceneId==='s1'?-10:0,to:sceneId==='s1'?0:10}}},
 {type:'setExpression',expression:{expressionId:'inertia'+sceneId,sceneId,targetId,sourceAnimationId:'base'+sceneId,type:'inertialOvershoot',property:'y',startFrame:start+3,durationFrames:3,enabled:true,parameters:{mode:'ae',amplitude:.2,frequency:2,decay:3,velocityLookbackFrames:1}}});}
 const state=applyOperations(f.state,ops,f.project);assert.equal(state.expressions!.length,2);
 for(const frame of [17,18,23,24,28,29])assert.ok((await renderNativeFrame(f.project,state,frame,{scale:.1})).png.length);
 const invalid=structuredClone(ops);invalid.at(-1).expression.startFrame=20;assert.throws(()=>applyOperations(f.state,invalid,f.project));
 }finally{await f.cleanup();}
});
test('Astra configuration cannot leak into any production role without explicit role opt-in',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'model-policy-'));try{await writeFile(path.join(root,'models_cache.json'),JSON.stringify({fetched_at:new Date().toISOString(),models:[{slug:'gpt-6-astra'},{slug:'gpt-6.1-sol'}]}));const settings={provider:'codex-sdk',model:''},models=await resolveProductionModels(settings,{},[],{codexHome:root});for(const m of Object.values(models)){assert.equal(m.model,'gpt-6.1-terra');assert.equal(m.reasoningEffort,'medium');};assert.equal((await resolveProductionModels(settings,{director:['gpt-6-astra']},[],{codexHome:root})).director.model,'gpt-6-astra');await assert.rejects(()=>resolveProductionModels(settings,{},['gpt-6.1-terra'],{codexHome:root}),/FALLBACK_UNAVAILABLE/);}finally{await rm(root,{recursive:true,force:true});}});
