import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {RuntimeCodeGuard} from '../src/runtime-code.js';
import {identityFixture,node} from './identity-fixture.js';
import {objectRequirement} from './intent-fixture.js';
import {registerProvider} from '../src/harness/providers/index.js';
import {readMotion,changeMotion} from '../src/motion/store.js';
import {servePlatform} from '../src/platform-server.js';
import {closeNativeRenderer,renderNativeFrame} from '../src/native/client.js';
import {exportVideo} from '../src/motion/video.js';
const request='на 9 секунде куар телефона увеличивается на 30 процентов а потом встает на место причем анимация  медленно в начале и конце посередине резко';
test('loaded runtime detects changed, added and deleted executable files; new process snapshot clears stale state',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'runtime-code-'));try{
  const file=path.join(root,'coverage.ts');await writeFile(file,'old');const guard=new RuntimeCodeGuard(root);
  assert.equal(guard.status().status,'CURRENT');await writeFile(file,'new');assert.throws(()=>guard.assertCurrent(),e=>(e as {code?:string}).code==='SERVER_RESTART_REQUIRED');
  assert.deepEqual(guard.status().changedFiles,['coverage.ts']);const updated=new RuntimeCodeGuard(root);assert.equal(updated.status().status,'CURRENT');
  await writeFile(path.join(root,'new.ts'),'patch');assert.equal(updated.status().status,'RESTART_REQUIRED');await rm(file);assert.ok(updated.status().changedFiles.includes('coverage.ts'));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('two HTTP runs: exact QR clause passes coverage, preflight, execution and native QA without repair calls',async()=>{
 process.env.AKELLA_RENDERER='native';let primary=0,repair=0,output:unknown;
 const stop=registerProvider('http-qr-regression',()=>({id:'http-qr-regression',mode:'mock',capabilities:()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false}),generate:async req=>{if(req.purpose!=='semantic-planning'){repair++;throw Error('Unexpected recovery call');}primary++;return {output,usage:null,estimatedCost:null,latencyMs:0,diagnostics:[],toolCalls:[]};}}));
 try{for(const align of ['end','start'] as const){
  const f=await identityFixture(1,s=>s[0].children=[node('qr','куар телефона',70,40,24,24)]);let server:Awaited<ReturnType<typeof servePlatform>>|undefined;
  try{
   let doc=await readMotion(f.project);await changeMotion(f.project.root,{expectedRevision:doc.revision,request:'fixture',operations:[{type:'setProjectSettings',settings:{...doc.state.settings,fps:12,durationFrames:132}},{type:'setBlocks',blocks:doc.state.blocks.map(b=>({...b,durationFrames:132}))}]});doc=await readMotion(f.project);
   const a=objectRequirement('action_512df5289f5cee8e2e6c','s0','qr','куар телефона',['scaleIn'],request),b=objectRequirement('action_ed1be1a337d003f438bd','s0','qr','куар телефона',['scaleOut'],request);
   a.timing.startSeconds=9;a.parameters={...a.parameters,scaleFrom:1,scaleTo:1.3,durationSeconds:.5};b.parameters={...b.parameters,scaleFrom:1.3,scaleTo:1,durationSeconds:.5};b.timing={...b.timing,relation:'afterRequirement',anchorRequirementId:a.requirementId,align};
   output={schemaVersion:'1.0.0',requirements:[a,b],coverage:[{sourceText:request,requirementIds:[a.requirementId,b.requirementId],classification:'executable',explanation:'exact QR sequence'}],assumptions:[]};
   server=await servePlatform(path.dirname(f.project.root),0);const port=(server.address() as {port:number}).port,base=`http://127.0.0.1:${port}`;
   const status=await fetch(base+'/api/runtime').then(r=>r.json());assert.equal(status.status,'CURRENT');assert.equal(status.loadedCodeDigest.length,64);
   const response=await fetch(`${base}/api/projects/${f.project.config.projectId}/motion/execute`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'edit',request,expectedRevision:doc.revision,settings:{provider:'http-qr-regression',model:''}})});assert.equal(response.status,202,await response.clone().text());const job=await response.json();
   let result:any;for(let i=0;i<300;i++){result=await fetch(`${base}/api/projects/${f.project.config.projectId}/motion/jobs/${job.jobId}`).then(r=>r.json());if(result.status!=='running')break;await new Promise(r=>setTimeout(r,30));}
   assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(result.result.reconciliation.status,'SUCCESS');
   const after=await readMotion(f.project),tracks=after.state.animations.sort((a,b)=>a.startFrame-b.startFrame);assert.equal(tracks.length,2);assert.equal(tracks[0].startFrame,108);assert.equal(tracks[1].startFrame,tracks[0].startFrame+tracks[0].durationFrames);
   const first=await renderNativeFrame(f.project,after.state,108,{encoding:'rgba'}),peak=await renderNativeFrame(f.project,after.state,114,{encoding:'rgba'}),last=await renderNativeFrame(f.project,after.state,131,{encoding:'rgba'});assert.notDeepEqual(first.png,peak.png);assert.deepEqual(first.png,last.png);
   if(align==='end'){const dirs=await readdir(path.join(f.project.root,'motion/ai'));const trace=await readFile(path.join(f.project.root,'motion/ai',dirs[0],'intent-target-resolution.json'),'utf8');assert.match(trace,/DETERMINISTIC_SEMANTIC_PATCH/);}
   if(align==='start'){const video=await exportVideo(f.project.root,()=>{},{renderer:'native'});assert.equal(video.frames,132);}
  }finally{if(server)await new Promise<void>(r=>server!.close(()=>r()));await closeNativeRenderer();await f.cleanup();}
 }}finally{stop();}assert.equal(primary,2);assert.equal(repair,0);
});
test('explicit transition FROM state resolves duplicate names without editor scene or invented IDs',async()=>{
 const {validateIntentPlan}=await import('../src/motion/intent/planner.js');
 const f=await identityFixture(2,s=>s.forEach((scene,i)=>scene.children=[node('product'+i,'500б',20+i*70,40)]));
 try{
  const text='500б встает в положение как на сцене 2';const r=objectRequirement('move','s0','product0','500б',['objectStateTransition'],text);r.sceneId=null;r.target.sourceNodeId=null;r.targetScope='logicalObject';r.parameters.fromSceneId='s0';r.parameters.toSceneId='s1';
  const p={schemaVersion:'1.0.0' as const,requirements:[r],coverage:[{sourceText:text,requirementIds:['move'],classification:'executable' as const,explanation:'transition'}],assumptions:[]};
  const resolved=validateIntentPlan(f.project,text,p);assert.equal(resolved.requirements[0].target.sourceNodeId,'product0');assert.equal(resolved.requirements[0].sceneId,'s0');assert.equal(resolved.requirements[0].unresolvedReason,null);
  r.parameters.fromSceneId='missing';assert.equal(validateIntentPlan(f.project,text,p).requirements[0].unresolvedReason,'UNKNOWN_SCENE');
 }finally{await f.cleanup();}
});
