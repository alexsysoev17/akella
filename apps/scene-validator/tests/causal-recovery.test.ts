import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {GlobalFailureSupervisor} from '../src/harness/recovery/supervisor.js';
import {HarnessRun} from '../src/harness/runtime.js';
import {recoveryProviderRuntime} from '../src/harness/recovery/provider-runtime.js';
import {recoveryPolicySchema} from '../src/harness/recovery/config.js';
import {recoveryFailure} from '../src/harness/recovery/failure.js';
import {proposeCodeRepair,resumeCodeInvestigation} from '../src/harness/recovery/code-service.js';
import {readRepairSources} from '../src/harness/recovery/source-reader.js';
import {reviewCodeRepair} from '../src/harness/recovery/code-repair.js';
import {deferRecovery,drainRecoveries,recoveryJobs,cancelRecovery} from '../src/harness/recovery/jobs.js';
import {identityFixture,node} from './identity-fixture.js';
import {registerProvider} from '../src/harness/providers/index.js';
import {executeMotion,resumeProjectRecoveries} from '../src/motion/service.js';
import {changeMotion,readMotion} from '../src/motion/store.js';
import {applyOperations} from '../src/motion/operations.js';
import {logicalId} from '../src/motion/registry.js';
import {evaluateMotion} from '../src/motion/engine.js';
import {renderNativeFrame,closeNativeRenderer} from '../src/native/client.js';
import {exportVideo} from '../src/motion/video.js';
import {objectRequirement} from './intent-fixture.js';
process.env.AKELLA_RENDERER='native';
const caps=()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false});
const answer=(output:unknown)=>({output,usage:null,estimatedCost:null,latencyMs:0,diagnostics:[],toolCalls:[]});
const hash=(x:string|Uint8Array)=>createHash('sha256').update(x).digest('hex');
test('Code Repair tests directory queries stay within frozen allowed source and reject traversal/read directories',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'repair-directory-'));
 const workspace={id:'directory',root,baseCommit:'fixture',files:[]};
 try{
  await mkdir(path.join(root,'apps/scene-validator/tests'),{recursive:true});
  await writeFile(path.join(root,'apps/scene-validator/tests/provider.test.ts'),"// structured INVALID_OUTPUT\n");
  const result=await readRepairSources(workspace,[{kind:'tests',path:'apps/scene-validator/tests',query:'INVALID_OUTPUT'}],5000);
  assert.match(JSON.stringify(result),/provider.test.ts/);
  for(const query of [{kind:'read' as const,path:'apps/scene-validator/tests'},{kind:'tests' as const,path:'apps/scene-validator/tests/../../projects'},{kind:'tests' as const,path:'projects/test44'}])await assert.rejects(readRepairSources(workspace,[query],5000),/CODE_SOURCE_READ_SCOPE/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('secondary recovery budget failure retains original causal root through source escalation',async()=>{
 const s=new GlobalFailureSupervisor({request:'лого с инерцией между сценами',revision:'r',maxAttempts:6,maxDurationMs:1000,persist:async()=>{}});
 const original=await s.observe(Error('TECHNICAL_VALIDATION_FAILED: Expression on a state-transition subtree is not yet supported'),'preflight',{objects:['96:1439']});
 await s.attempt(original,{strategy:'project',procedure:'project',reason:'test',run:async()=>{throw Error('REPAIR_TIME_BUDGET');},verify:async()=>({status:'PASSED'})});
 const secondary=s.report.events.at(-1)!;assert.equal(secondary.parentEventId,original.id);assert.equal(secondary.rootEventId,original.id);
 let calls=0;await s.settle(Error('REPAIR_TIME_BUDGET'),'recovery',{code:{strategy:'code',procedure:'source',reason:'test',run:async()=>{calls++;return {status:'INSUFFICIENT_EVIDENCE'};},verify:async()=>({status:'NO_VERIFIED_PATCH'})}},{parentEventId:secondary.id});
 assert.equal(calls,1);assert.equal(s.report.events.at(-1)!.rootEventId,original.id);assert.match(s.report.events[0].rootCause,/Expression on/);
 for(let i=0;i<110;i++)await s.observe(Error('RECOVERY_DIAGNOSTIC_'+i),'recovery',{parentEventId:original.id});
 assert.ok(s.report.events.some(e=>e.id===original.id));assert.equal(s.report.originalFailure?.id,original.id);assert.ok(s.report.events.length<=100);
});
test('a 55.6s planning sample does not preempt first Project Recovery; primary reserves actual recovery resources',async()=>{
 const f=await identityFixture(1);const run=await HarnessRun.start(f.project,'10000000-0000-4000-8000-000000000001','test','budget-fixture','',undefined,{minimumRetryBudgetMs:1,executionReserveMs:10000});
 let calls=0;const adapter={id:'budget-fixture',mode:'mock' as const,capabilities:caps,generate:async()=>{calls++;return answer({});}};
 try{
  const request={purpose:'semantic-planning' as const,messages:[{role:'user' as const,content:'test'}],responseSchema:{type:'object'},timeoutMs:180000,maxOutputTokens:100};
  await run.invoke(adapter,request);run.calls[0].latencyMs=55627;
  await recoveryProviderRuntime(run,1).invoke(adapter,{...request,purpose:'motion-repair'});
  assert.equal(calls,2);assert.equal(run.calls[1].purpose,'project-recovery');assert.ok(run.events.some(e=>e.stage==='provider-started'&&(e.data as {purpose?:string}).purpose==='project-recovery'));
 }finally{await run.finish('FAILED');await f.cleanup();}
});
async function logoFixture(){
 const f=await identityFixture(3,scenes=>scenes.forEach((s,i)=>s.children=[node('logo'+i,'лого',i===2?70:i?130:30,i===2?45:i?15:60,24,24)]));
 f.state.settings={...f.state.settings,fps:12,durationFrames:84};f.state.blocks.forEach((b,i)=>{b.startFrame=i*28;b.durationFrames=28;});
 const before=await readMotion(f.project);await changeMotion(f.project.root,{expectedRevision:before.revision,request:'fixture',operations:[{type:'setProjectSettings',settings:f.state.settings},{type:'setBlocks',blocks:f.state.blocks}]});return f;
}
test('production entrance inertia then cross-scene motion preserves expressions, native pixels and FFmpeg input',async()=>{
 const f=await logoFixture();let output:unknown,calls=0;
 const stop=registerProvider('causal-motion-fixture',()=>({id:'causal-motion-fixture',mode:'mock',capabilities:caps,generate:async()=>{calls++;return answer(output);}}));
 const turn=async(prompt:string,actions:unknown[])=>{output={schemaVersion:'semantic-graph/1.0',clauses:[{clauseId:'c',text:prompt}],actions,assumptions:[]};const doc=await readMotion(f.project);return executeMotion(f.project,{mode:'edit',request:prompt,expectedRevision:doc.revision,settings:{provider:'causal-motion-fixture',model:''}},()=>{},{config:{maxLLMCalls:1}});};
 try{
  const a={actionId:'a',clauseId:'c',kind:'objectAnimation',targets:['logo0'],scene:'s0',techniques:['slideUp','fadeIn','inertialOvershoot'],parameters:[{key:'durationSeconds',value:.5}],constraints:[],unresolvedReason:null};
  const first=await turn('лого появляется снизу через фейд с инерцией',[a]);assert.equal(first.reconciliation?.status,'SUCCESS');
  const entrance=structuredClone((await readMotion(f.project)).state);
  const second=await turn('На 2 секунде лого перемещается в состояние сцены 2',[{...a,actionId:'b',techniques:['objectStateTransition'],targets:['logo0'],parameters:[{key:'toSceneId',value:'s1'},{key:'durationSeconds',value:1}],start:{unit:'seconds',value:2}}]);
  assert.equal(second.reconciliation?.status,'SUCCESS',JSON.stringify(second));const doc=await readMotion(f.project);
  assert.deepEqual(doc.state.expressions,entrance.expressions);assert.deepEqual(doc.state.animations,entrance.animations);assert.equal(doc.state.objectTransitions?.length,1);
  const third=await turn('На 4 секунде лого уходит влево с инерцией и встает как в сцене 3',[{...a,actionId:'c',techniques:['objectStateTransition','inertialOvershoot'],targets:['logo0'],parameters:[{key:'fromSceneId',value:'s1'},{key:'toSceneId',value:'s2'},{key:'durationSeconds',value:1}],start:{unit:'seconds',value:4}}]);
  assert.equal(third.reconciliation?.status,'SUCCESS',JSON.stringify(third));const final=await readMotion(f.project);doc.state=final.state;
  assert.equal(doc.state.objectTransitions?.length,2);const bound=doc.state.expressions!.filter(e=>e.transitionId);assert.ok(bound.length);assert.ok(bound.every(e=>e.sceneId==='s1'&&e.targetId==='logo1'&&e.transitionId===doc.state.objectTransitions![1].transitionId));
  assert.deepEqual(doc.state.expressions!.filter(e=>!e.transitionId),entrance.expressions);assert.deepEqual(doc.state.animations,entrance.animations);
  const start=await renderNativeFrame(f.project,doc.state,3,{encoding:'rgba'}),end=await renderNativeFrame(f.project,doc.state,83,{encoding:'rgba'});assert.notDeepEqual(start.png,end.png);
  const v=await exportVideo(f.project.root,()=>{},{renderer:'native'});assert.ok('frameDigests'in v);assert.equal(v.frameDigests.find(d=>d.frame===83)?.sha256,hash(end.png));assert.equal(calls,3);
  const conflict=structuredClone(doc.state);conflict.expressions![0].durationFrames=36;assert.throws(()=>applyOperations(conflict,[],f.project),/state-transition subtree/);
 }finally{stop();await closeNativeRenderer();await f.cleanup();}
});
test('durable job resumes saved contract after restart, commits once and never calls semantic provider',async()=>{
 const f=await identityFixture(1,s=>s[0].children=[node('p','Product',30,30)]);let providerCalls=0;
 const stop=registerProvider('deferred-fixture',()=>({id:'deferred-fixture',mode:'mock',capabilities:caps,generate:async()=>{providerCalls++;throw Error('must not replan');}}));
 try{
  const doc=await readMotion(f.project),request='Product появляется через фейд',r=objectRequirement('r','s0','p','Product',['fadeIn'],request);
  const plan={schemaVersion:'1.0.0' as const,requirements:[r],coverage:[{sourceText:request,requirementIds:['r'],classification:'executable' as const,explanation:'fixture'}],assumptions:[]};
  const id='20000000-0000-4000-8000-000000000001';await deferRecovery(f.project,id,doc.revision,{mode:'edit',request,expectedRevision:doc.revision,settings:{provider:'deferred-fixture',model:''}},plan,'EXECUTION_TIMEOUT');
  await resumeProjectRecoveries(f.project);assert.equal((await recoveryJobs(f.project))[0].status,'COMPLETED');const after=await readMotion(f.project);assert.notEqual(after.revision,doc.revision);assert.equal(providerCalls,0);
  await resumeProjectRecoveries(f.project);assert.deepEqual(await readMotion(f.project),after);
  const job=(await recoveryJobs(f.project))[0];job.status='RUNNING';job.ownerPid=999999;await writeFile(path.join(f.project.root,'motion/harness/recovery/jobs',job.id+'.json'),JSON.stringify(job));
  await resumeProjectRecoveries(f.project);assert.equal((await recoveryJobs(f.project))[0].status,'COMPLETED');assert.deepEqual(await readMotion(f.project),after);
 }finally{stop();await closeNativeRenderer();await f.cleanup();}
});
test('deferred jobs obey cancellation, stale revisions and expiry without execution',async()=>{
 const f=await identityFixture(1);try{
  const doc=await readMotion(f.project),plan={schemaVersion:'1.0.0' as const,requirements:[],coverage:[],assumptions:[]};let called=0;
  const a=await deferRecovery(f.project,'30000000-0000-4000-8000-000000000001',doc.revision,{},plan,'timeout');await cancelRecovery(f.project,a.id);
  await deferRecovery(f.project,'30000000-0000-4000-8000-000000000002','old',{},plan,'timeout');
  const expired=await deferRecovery(f.project,'30000000-0000-4000-8000-000000000003',doc.revision,{},plan,'timeout');expired.expiresAt=new Date(0).toISOString();await writeFile(path.join(f.project.root,'motion/harness/recovery/jobs',expired.id+'.json'),JSON.stringify(expired));
  await drainRecoveries(f.project,async()=>{called++;return{};});assert.equal(called,0);assert.deepEqual((await recoveryJobs(f.project)).map(j=>j.status).sort(),['CANCELLED','FAILED','STALE']);
 }finally{await f.cleanup();}
});
test('Code Repair requests missing implementation, reads callers/tests, verifies an actual isolated patch',async()=>{
 if(process.platform!=='darwin')return;
 const root=await mkdtemp(path.join(os.tmpdir(),'causal-code-')),exec=promisify(execFile);let workspace:string|undefined,calls=0;
 const entry='apps/scene-validator/src/motion/tools.ts',hidden='apps/scene-validator/src/motion/timing.ts';const original='export const exactTime=(n:number)=>n+1;\n';
 const stop=registerProvider('source-reader-fixture',()=>({id:'source-reader-fixture',mode:'mock',capabilities:caps,generate:async req=>{
  calls++;const context=JSON.parse(req.messages.find(m=>m.role==='user')!.content).context;
  if(calls===1)return answer({action:'inspect',proposal:null,reason:'Need implementation and callers',queries:[{kind:'read',path:hidden,query:null,startLine:1,endLine:30},{kind:'callers',path:null,query:'exactTime',startLine:null,endLine:null},{kind:'tests',path:null,query:'exactTime',startLine:null,endLine:null}]});
  assert.ok(JSON.stringify(context.investigation).includes('n+1'));
  return answer({action:'propose',reason:'Off-by-one in discovered function',proposal:{rootCause:'Exact time adds one',changes:[{path:hidden,beforeHash:hash(original),edits:[{find:'n+1',replace:'n'}]},{path:context.regressionPath,beforeHash:hash(''),content:"import test from 'node:test';import assert from 'node:assert/strict';import {exactTime} from '../src/motion/timing.js';test('exact time',()=>assert.equal(exactTime(3),3));\n"}],regressionTests:[context.regressionPath],risks:['synthetic defect']}});
 }}));
 try{
  await mkdir(path.join(root,'apps/scene-validator/src/motion'),{recursive:true});await mkdir(path.join(root,'apps/scene-validator/tests'),{recursive:true});await writeFile(path.join(root,entry),"export {exactTime} from './timing.js';\n");await writeFile(path.join(root,hidden),original);
  await writeFile(path.join(root,'package.json'),'{"type":"module"}');await writeFile(path.join(root,'.gitignore'),'node_modules\ndata/\n');await symlink(path.resolve('node_modules'),path.join(root,'node_modules'));
  await writeFile(path.join(root,'tsconfig.check.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:true,types:['node']},include:['apps/**/*.ts']}));
  await exec('git',['init','-q'],{cwd:root});await exec('git',['add','apps','package.json','.gitignore','tsconfig.check.json'],{cwd:root});await exec('git',['-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','Fixture'],{cwd:root});
  const failure=recoveryFailure(Object.assign(Error('Exact timing failure'),{stack:'Error\n at /fixture/'+entry+':1:1'}),'execution','r');
  const result=await proposeCodeRepair(root,failure,recoveryPolicySchema.parse({}),{provider:'source-reader-fixture',model:''});assert.ok('workspace'in result);workspace=result.workspace as string;
  assert.equal(result.status,'AWAITING_APPROVAL',JSON.stringify(result));const report=await reviewCodeRepair(workspace);assert.ok(report.baseline.some((t:{status:string})=>t.status==='FAILED'));assert.ok(report.tests.every((t:{status:string})=>t.status==='PASSED'));assert.equal(calls,2);assert.equal(await readFile(path.join(root,hidden),'utf8'),original);
  await assert.rejects(()=>readRepairSources({id:'x',root,baseCommit:'x',files:[]},[{kind:'read',path:'../../secret'}],1000),/CODE_SOURCE_READ_SCOPE/);
 }finally{stop();await rm(root,{recursive:true,force:true});if(workspace)await rm(workspace,{recursive:true,force:true});}
});

test('Code Repair budgets include cached input once, checkpoint before next call and explicitly resume tested patch',async()=>{
 if(process.platform!=='darwin')return;
 const root=await mkdtemp(path.join(os.tmpdir(),'causal-code-')),exec=promisify(execFile);let workspace:string|undefined,calls=0;
 const entry='apps/scene-validator/src/motion/tools.ts',hidden='apps/scene-validator/src/motion/timing.ts';const original='export const exactTime=(n:number)=>n+1;\n';
 const stop=registerProvider('source-budget-fixture',()=>({id:'source-budget-fixture',mode:'mock',capabilities:caps,generate:async req=>{
  calls++;const context=JSON.parse(req.messages.find(m=>m.role==='user')!.content).context;
  if(calls===1)return {...answer({action:'inspect',proposal:null,reason:'Need implementation and callers',queries:[{kind:'read',path:hidden,query:null,startLine:1,endLine:30},{kind:'callers',path:null,query:'exactTime',startLine:null,endLine:null},{kind:'tests',path:null,query:'exactTime',startLine:null,endLine:null}]}),usage:{inputTokens:38423,outputTokens:419,cachedInputTokens:18944}};
  assert.ok(JSON.stringify(context.investigation).includes('n+1'));
  return answer({action:'propose',reason:'Off-by-one in discovered function',proposal:{rootCause:'Exact time adds one',changes:[{path:hidden,beforeHash:hash(original),edits:[{find:'n+1',replace:'n'}]},{path:context.regressionPath,beforeHash:hash(''),content:"import test from 'node:test';import assert from 'node:assert/strict';import {exactTime} from '../src/motion/timing.js';test('exact time',()=>assert.equal(exactTime(3),3));\n"}],regressionTests:[context.regressionPath],risks:['synthetic defect']}});
 }}));
 try{
  await mkdir(path.join(root,'apps/scene-validator/src/motion'),{recursive:true});await mkdir(path.join(root,'apps/scene-validator/tests'),{recursive:true});await writeFile(path.join(root,entry),"export {exactTime} from './timing.js';\n");await writeFile(path.join(root,hidden),original);
  await writeFile(path.join(root,'package.json'),'{"type":"module"}');await writeFile(path.join(root,'.gitignore'),'node_modules\ndata/\n');await symlink(path.resolve('node_modules'),path.join(root,'node_modules'));
  await writeFile(path.join(root,'tsconfig.check.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:true,types:['node']},include:['apps/**/*.ts']}));
  await exec('git',['init','-q'],{cwd:root});await exec('git',['add','apps','package.json','.gitignore','tsconfig.check.json'],{cwd:root});await exec('git',['-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','Fixture'],{cwd:root});
  const failure=recoveryFailure(Object.assign(Error('Exact timing failure'),{stack:'Error\n at /fixture/'+entry+':1:1'}),'execution','r');
  const blocked=await proposeCodeRepair(root,failure,recoveryPolicySchema.parse({}),{provider:'source-budget-fixture',model:''});
  assert.equal(blocked.status,'CODE_REPAIR_TOKEN_BUDGET');assert.equal(calls,1);assert.ok('workspace' in blocked);workspace=blocked.workspace as string;
  assert.ok(workspace);const budget=JSON.parse(await readFile(path.join(workspace,'provider-budget.json'),'utf8'));assert.equal(budget.totalTokens,38842);assert.equal(budget.cachedInputTokens,18944);
  const result=await resumeCodeInvestigation(root,workspace,120000);assert.ok('workspace'in result);workspace=result.workspace as string;
  assert.equal(result.status,'AWAITING_APPROVAL',JSON.stringify(result));const report=await reviewCodeRepair(workspace);assert.ok(report.baseline.some((t:{status:string})=>t.status==='FAILED'));assert.ok(report.tests.every((t:{status:string})=>t.status==='PASSED'));assert.equal(calls,2);assert.equal(await readFile(path.join(root,hidden),'utf8'),original);
  await assert.rejects(()=>readRepairSources({id:'x',root,baseCommit:'x',files:[]},[{kind:'read',path:'../../secret'}],1000),/CODE_SOURCE_READ_SCOPE/);
 }finally{stop();await rm(root,{recursive:true,force:true});if(workspace)await rm(workspace,{recursive:true,force:true});}
});

test('production source escalation receives original transition invariant and secondary budget chain',async()=>{
 const f=await identityFixture(1);let workspace:string|undefined,seen:unknown;
 const {superviseRunFailure}=await import('../src/motion/service.js');
 const stop=registerProvider('causal-source-escalation',()=>({id:'causal-source-escalation',mode:'mock',capabilities:caps,generate:async req=>{seen=JSON.parse(req.messages.find(m=>m.role==='user')!.content).context.failure;return answer({action:'stop',proposal:null,reason:'Controlled investigation only; no source defect claimed'});}}));
 const run=await HarnessRun.start(f.project,'40000000-0000-4000-8000-000000000001','лого с инерцией','causal-source-escalation','');
 try{
  const original=await run.supervisor.observe(Error('TECHNICAL_VALIDATION_FAILED: Expression on a state-transition subtree is not yet supported'),'preflight',{objects:['96:1439']});
  await run.supervisor.attempt(original,{strategy:'project',procedure:'fixture',reason:'test',run:async()=>{throw Error('REPAIR_TIME_BUDGET');},verify:async()=>({status:'PASSED'})});
  await superviseRunFailure(run,Error('REPAIR_TIME_BUDGET'),f.project,{provider:'causal-source-escalation',model:''},()=>{},'initial');
  const payload=seen as {code:string;invariant:string;causalChain:{code:string}[]};assert.equal(payload.code,'TECHNICAL_VALIDATION_FAILED');assert.match(payload.invariant,/state-transition subtree/);assert.ok(payload.causalChain.some(e=>e.code==='REPAIR_TIME_BUDGET'));
  workspace=(run.supervisor.report.codeRepair as {workspace:string}).workspace;
  await run.captureFailure(Error('REPAIR_TIME_BUDGET'));assert.equal(run.failure?.originalFailure?.code,'TECHNICAL_VALIDATION_FAILED');assert.ok(run.failure?.causalChain?.some(e=>e.code==='REPAIR_TIME_BUDGET'));
 }finally{await run.finish('FAILED');stop();await f.cleanup();if(workspace)await rm(workspace,{recursive:true,force:true});}
});

test('server startup continues durable recovery and exposes the actual completed motion result through HTTP',async()=>{
 const f=await identityFixture(1,s=>s[0].children=[node('p','Product',30,30)]);const {servePlatform}=await import('../src/platform-server.js');let server:Awaited<ReturnType<typeof servePlatform>>|undefined;
 const stop=registerProvider('durable-http-fixture',()=>({id:'durable-http-fixture',mode:'mock',capabilities:caps,generate:async()=>{throw Error('No planning call permitted');}}));
 try{
  const doc=await readMotion(f.project),request='Product появляется через фейд',r=objectRequirement('r','s0','p','Product',['fadeIn'],request),id='50000000-0000-4000-8000-000000000001';
  const plan={schemaVersion:'1.0.0' as const,requirements:[r],coverage:[{sourceText:request,requirementIds:['r'],classification:'executable' as const,explanation:'fixture'}],assumptions:[]};
  await deferRecovery(f.project,id,doc.revision,{mode:'edit',request,expectedRevision:doc.revision,settings:{provider:'durable-http-fixture',model:''}},plan,'EXECUTION_TIMEOUT');
  server=await servePlatform(path.dirname(f.project.root),0);const addr=server.address() as {port:number};
  let response:{status:string;result?:{document?:unknown;reconciliation?:{status:string}};error?:string}={status:'running'};
  for(let i=0;i<100&&response.status==='running';i++){await new Promise(r=>setTimeout(r,30));const http=await fetch(`http://127.0.0.1:${addr.port}/api/projects/${f.project.config.projectId}/motion/jobs/${id}`);assert.equal(http.status,200);response=await http.json();}
  assert.equal(response.status,'completed',JSON.stringify(response));assert.ok(response.result?.document);assert.equal(response.result?.reconciliation?.status,'SUCCESS');
 }finally{if(server)await new Promise<void>(r=>server!.close(()=>r()));stop();await closeNativeRenderer();await f.cleanup();}
});

test('cancelling an executing durable job aborts its real signal and cannot publish success',async()=>{
 const f=await identityFixture(1);try{
  const doc=await readMotion(f.project),plan={schemaVersion:'1.0.0' as const,requirements:[],coverage:[],assumptions:[]},id='60000000-0000-4000-8000-000000000001';
  await deferRecovery(f.project,id,doc.revision,{},plan,'timeout');let entered!:()=>void;const started=new Promise<void>(r=>entered=r);
  const running=drainRecoveries(f.project,async(_job,signal)=>{entered();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
  await started;await cancelRecovery(f.project,id);await running;assert.equal((await recoveryJobs(f.project))[0].status,'CANCELLED');assert.deepEqual(await readMotion(f.project),doc);
 }finally{await f.cleanup();}
});
