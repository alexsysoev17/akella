import {resumeVerifiedReplay} from "../src/harness/recovery/resume.js";
import {loadProject} from "../src/project.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,cp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {GlobalFailureSupervisor} from '../src/harness/recovery/supervisor.js';
import {rememberSupervisor,supervisorExperience} from '../src/harness/recovery/supervisor-memory.js';
import {codeSources} from '../src/harness/recovery/source-routing.js';
import {recoveryFailure} from '../src/harness/recovery/failure.js';
import {recoveryPolicySchema} from '../src/harness/recovery/config.js';
import {proposeCodeRepair} from '../src/harness/recovery/code-service.js';
import {reviewCodeRepair} from '../src/harness/recovery/code-repair.js';
import {HarnessRun} from '../src/harness/runtime.js';
import {identityFixture,node} from './identity-fixture.js';
import {executeMotion,superviseRunFailure} from '../src/motion/service.js';
import {readMotion} from '../src/motion/store.js';
import {registerProvider,ProviderError} from '../src/harness/providers/index.js';
import {closeNativeRenderer,renderNativeFrame} from '../src/native/client.js';
import {validateIntentPlan} from '../src/motion/intent/planner.js';
import {objectRequirement} from './intent-fixture.js';
import {inspectSemanticCoverage} from '../src/motion/intent/coverage.js';
import {inspectorRun} from '../src/harness/inspector.js';
process.env.AKELLA_RENDERER='native';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const caps=()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false});
const makeSupervisor=(persist:unknown[]=[])=>new GlobalFailureSupervisor({request:'Original instruction',revision:'r1',maxAttempts:6,maxDurationMs:30000,persist:async report=>{persist.push(report);}});
const injected=(code:string,file='motion/intent/compiler')=>Object.assign(Error(code),{code,stack:`Error: ${code}\n at /fixture/apps/scene-validator/src/${file}.ts:10:2`});
const stages=[
 ['CONTEXT_PACKING_INVARIANT','context-packing'],['OUTPUT_TRUNCATED','semantic-planning'],['OUTPUT_TRUNCATED','semantic-repair'],['VALIDATOR_SCOPE_CONTRADICTION','semantic-coverage'],
 ['OBJECT_RESOLUTION_INTERNAL','object-resolution'],['COMPILER_INTERNAL','motion-compiler'],['TIMING_DEPENDENCY_INTERNAL','timeline'],['PREFLIGHT_INTERNAL','preflight'],
 ['OPERATION_INTERNAL','operation-execution'],['NATIVE_RENDER_FAILURE','rendering'],['MOTION_QA_FAILED','motion-qa'],['FINAL_RECONCILIATION_FAILED','final-reconciliation'],
 ['RECOVERY_RUNTIME_INTERNAL','project-recovery'],['CODE_REPAIR_INTERNAL','code-repair'],['LLM_CALL_BUDGET','provider-call'],
] as const;
for(const [code,stage] of stages)test(`failure routing injection: ${stage}/${code} always diagnoses, attempts applicable handlers and preserves unverified status`,async()=>{
 const snapshots:unknown[]=[],s=makeSupervisor(snapshots);let project=0,source=0;
 await s.settle(injected(code),stage,{
  project:{strategy:'project',procedure:'controlled-stage-replay/1',reason:'Injected failure exercises bounded fallback',run:async()=>{project++;throw injected('RECOVERY_RUNTIME_INTERNAL','harness/recovery/runtime');},verify:async()=>({status:'PASSED'})},
  code:{strategy:'code',procedure:'controlled-source-investigation/1',reason:'Investigate original and recovery failure evidence',run:async()=>{source++;return {status:'INSUFFICIENT_EVIDENCE',reason:'Synthetic routing injection; no source defect claimed'};},verify:async()=>({status:'NO_VERIFIED_PATCH'})},
 },{requirements:['r'],objects:['actual-id'],operations:[{type:'updateAnimation',animationId:'existing'}],evidence:[{stack:injected(code).stack}]});
 assert.equal(project,1);assert.equal(source,1);assert.equal(s.report.status,'RECOVERY_EXHAUSTED');assert.ok(s.report.events.some(e=>e.stage===stage));assert.ok(s.report.events.some(e=>e.stage==='project-recovery'));
 assert.equal(s.report.events[0].originalUserRequest,'Original instruction');assert.deepEqual(s.report.events[0].relevantObjectIds,['actual-id']);assert.ok(s.report.finalReason);assert.ok(snapshots.length>=3);assert.equal(s.report.verifiedResult,null);
});
test('genuine context capacity and authentication blockers diagnose objectively, with zero futile provider/source calls',async()=>{
 for(const [error,evidence] of [[injected('CONTEXT_EXHAUSTED'),[{mandatoryBytes:70000,budgetBytes:60000,lossless:true}]], [injected('PROVIDER_AUTH_FAILED'),[]]] as const){
  const s=makeSupervisor();let called=0;await s.settle(error,'provider-startup',{code:{strategy:'code',procedure:'investigate',reason:'must not call',run:async()=>{called++;return{};},verify:async()=>({status:'PASSED'})}},{evidence:[...evidence]});
  assert.equal(s.report.status,'RECOVERY_BLOCKED');assert.equal(called,0);assert.ok(s.report.decisions.some(d=>d.strategy==='external'));
 }
});
test('repeat/no-progress and attempt limit stop identical actions; failed verification never becomes success',async()=>{
 const s=makeSupervisor(),event=await s.observe(injected('QA_INTERNAL'),'qa');let calls=0;
 const action={strategy:'project' as const,procedure:'same',reason:'test',run:async()=>{calls++;return{};},verify:async()=>({status:'FAILED'})};
 assert.equal((await s.attempt(event,action)).ok,false);assert.equal((await s.attempt(event,action)).ok,false);assert.equal(calls,1);await s.complete(false);assert.notEqual(s.report.status,'RECOVERY_SUCCEEDED');assert.match(s.report.decisions.at(-1)!.reason,/Identical/);
});
test('verified experience is version-bound; failed or patch-only attempts never become verified executable recipes',async()=>{
 const f=await identityFixture(1);try{
  const s=makeSupervisor(),event=await s.observe(injected('COMPILER_INTERNAL'),'compiler');await s.attempt(event,{strategy:'deterministic',procedure:'reviewed-replay',reason:'test',run:async()=>({}),verify:async()=>({status:'PASSED'})});
  await rememberSupervisor(f.project.root,s.report,'code-v1');assert.equal((await supervisorExperience(f.project.root))[0].status,'FAILED');
  await s.complete(true,{status:'SUCCESS',requirements:1,qa:'PASSED',persisted:true});await rememberSupervisor(f.project.root,s.report,'code-v1');assert.equal((await supervisorExperience(f.project.root))[0].status,'VERIFIED');assert.equal((await supervisorExperience(f.project.root)).filter(r=>r.codeVersion==='code-v2').length,0);
 }finally{await f.cleanup();}
});
test('actual early-stage Code Repair uses relevant local source and mock coding adapter even when legacy eligibility is false',async()=>{
 const f=await identityFixture(1);let calls=0;const sourcePaths:string[][]=[];
 const stop=registerProvider('source-investigation-fixture',()=>({id:'source-investigation-fixture',mode:'mock',capabilities:caps,generate:async req=>{calls++;const payload=JSON.parse(req.messages.find(m=>m.role==='user')!.content);sourcePaths.push(payload.context.files.map((f:{path:string})=>f.path));return{output:{action:'stop',proposal:null,reason:'Controlled source investigation: no proved defect'},usage:null,estimatedCost:null,latencyMs:0,diagnostics:[],toolCalls:[]};}}));
 try{
  for(const [code,stage,file] of [['SEMANTIC_INTERNAL','semantic-planning','motion/intent/planner'],['SEMANTIC_COVERAGE','semantic-coverage','motion/intent/coverage'],['PROVIDER_ADAPTER_INTERNAL','provider-startup','harness/providers/codex'],['CONTEXT_PACKING_INVARIANT','context-packing','harness/context-packing'],['RECOVERY_RUNTIME_INTERNAL','project-recovery','harness/recovery/runtime']] as const){
   const run=await HarnessRun.start(f.project,randomUUID(),'Product fade','source-investigation-fixture','');run.phase=stage;
   try{const error=injected(code,file);assert.ok(codeSources(recoveryFailure(error,stage,'r')).includes('apps/scene-validator/src/'+file+'.ts'));
    await superviseRunFailure(run,error,f.project,{provider:'source-investigation-fixture',model:''},()=>{},'initial');await run.captureFailure(error);await run.finish('FAILED');
    const report=JSON.parse(await readFile(path.join(run.directory,'global-recovery.json'),'utf8'));assert.equal(report.status,'RECOVERY_EXHAUSTED');assert.ok(report.attempts.some((a:{strategy:string})=>a.strategy==='code'));
    assert.equal(run.calls.filter(c=>c.purpose==='code-repair').length,1);
    const view=await inspectorRun(f.project.root,run.runId);assert.notEqual(view.recovery,'NOT_AVAILABLE');assert.notEqual(view.codeRepair,'NOT_AVAILABLE');
   }finally{await run.finish('FAILED');}
  }
  assert.equal(calls,5);assert.equal(sourcePaths.length,5);assert.equal((await readMotion(f.project)).revision,'initial');
 }finally{stop();await f.cleanup();}
});
async function productionRecovery(kind:'planning'|'repair'){
 const f=await identityFixture(1,scenes=>{scenes[0].children=[node('p','Product',40,40)];});let calls=0;const seen:string[]=[];
 const mirror=path.join(f.root,'original-before-replay');await cp(f.project.root,mirror,{recursive:true});
 const request=kind==='planning'?'Product появляется через фейд':'Product появляется снизу через фейд';
 const graph={schemaVersion:'semantic-graph/1.0',clauses:[{clauseId:'c',text:request}],actions:[{actionId:'a',clauseId:'c',kind:'objectAnimation',scene:'s0',targets:['Product'],techniques:kind==='planning'?['fadeIn']:['slideUp'],parameters:[],constraints:[],unresolvedReason:null}],assumptions:[]};
 const stop=registerProvider('closed-loop-fixture',()=>({id:'closed-loop-fixture',mode:'mock',capabilities:caps,generate:async req=>{calls++;seen.push(req.purpose??'');const payload=JSON.parse(req.messages.find(m=>m.role==='user')!.content);
  if((kind==='planning'&&calls===1)||(kind==='repair'&&calls===2))throw new ProviderError('OUTPUT_TRUNCATED','Incomplete response: max_output_tokens');
  let output:unknown=graph;
  if(kind==='repair'&&calls===3){const context=payload.context;const r=context.affectedRequirements[0];output={updates:[{requirementId:r.requirementId,changes:[{field:'techniques',value:['slideUp','fadeIn']}]}],addedRequirements:[],coverageRows:[]};}
  return {output,usage:null,estimatedCost:null,latencyMs:0,diagnostics:['prepared mock semantic response; actual execution/native QA'],toolCalls:[]};
 }}));
 try{
  const result=await executeMotion(f.project,{request,mode:'create',expectedRevision:'initial',settings:{provider:'closed-loop-fixture'}},()=>{}, {config:{maxLLMCalls:kind==='planning'?1:2,recovery:recoveryPolicySchema.parse({semanticRecoveryCalls:1,codeRepair:{enabled:false}})}});
  assert.equal(result.reconciliation?.status,'SUCCESS',JSON.stringify(result));assert.equal(calls,kind==='planning'?2:3);assert.equal(seen.at(-1),'semantic-recovery');
  const report=JSON.parse(await readFile(path.join(f.project.root,'motion/ai',result.id,'global-recovery.json'),'utf8'));assert.equal(report.status,'RECOVERY_SUCCEEDED');assert.ok(report.attempts.some((a:{status:string})=>a.status==='VERIFIED_STAGE'));
  const state=(await readMotion(f.project)).state;assert.equal(state.animations.filter(a=>a.effect==='fadeIn').length,1);
  const start=await renderNativeFrame(f.project,state,0),end=await renderNativeFrame(f.project,state,30);assert.notDeepEqual(start.png,end.png);
  assert.ok(result.requirements!.every((r:{status:string})=>r.status==='PASSED'));assert.equal((await supervisorExperience(f.project.root)).some(r=>r.status==='VERIFIED'),true);
  if(kind==='planning'){
    const originalId=randomUUID(),dir=path.join(mirror,'motion/ai',originalId);await mkdir(dir,{recursive:true});
    const original={request:{request},revision:'initial',sourceFingerprint:f.project.inspection.fingerprint};
    await writeFile(path.join(dir,'request.json'),JSON.stringify(original));
    const resultFile=path.join(f.project.root,'verified-result.json');await writeFile(resultFile,JSON.stringify(result));const hash=createHash('sha256').update(await readFile(resultFile)).digest('hex');
    await assert.rejects(()=>resumeVerifiedReplay(mirror,originalId,{replayRoot:f.project.root,resultFile,resultHash:'0'.repeat(64)}),/VERIFIED_REPLAY_CHANGED/);
    await writeFile(path.join(dir,'request.json'),JSON.stringify({...original,revision:'stale'}));
    await assert.rejects(()=>resumeVerifiedReplay(mirror,originalId,{replayRoot:f.project.root,resultFile,resultHash:hash}),/STALE_PROJECT_REVISION/);
    assert.equal((await readMotion(await loadProject(mirror))).revision,'initial');
    await writeFile(path.join(dir,'request.json'),JSON.stringify(original));
    const published=await resumeVerifiedReplay(mirror,originalId,{replayRoot:f.project.root,resultFile,resultHash:hash});assert.equal(published.status,'APPLIED');
    assert.deepEqual((await readMotion(await loadProject(mirror))).state,state);
    const repeat=await resumeVerifiedReplay(mirror,originalId,{replayRoot:f.project.root,resultFile,resultHash:hash});assert.equal((repeat as {idempotent?:boolean}).idempotent,true);
  }

 }finally{stop();await closeNativeRenderer();await f.cleanup();}
}
test('production closed loop: original prompt → initial OUTPUT_TRUNCATED → reserved recovery → actual native QA/reconciliation/commit',()=>productionRecovery('planning'));
test('production recovery-of-recovery: valid draft → real coverage failure → truncated audit → compact field patch → actual execution/native pixels',()=>productionRecovery('repair'));
test('exit fade is checked as fadeOut; missing exit fade still fails and complete provenance remains required',async()=>{
 const f=await identityFixture(1,s=>{s[0].children=[node('p','Product')];});try{
  const request='Product уходит влево через фейд типа пропадает';const r=objectRequirement('r','s0','p','Product',['slideLeft','fadeOut'],request);
  const plan={schemaVersion:'1.0.0' as const,requirements:[r],coverage:[{sourceText:request,requirementIds:['r'],classification:'executable' as const,explanation:'fixture'}],assumptions:[]};
  assert.deepEqual(inspectSemanticCoverage(f.project,request,plan).issues,[]);r.techniques=['slideLeft'];assert.ok(inspectSemanticCoverage(f.project,request,plan).issues.some(i=>i.expected==='fadeOut'));
 }finally{await f.cleanup();}
});
test('actual isolated source proposal passes baseline-fail/patched-pass tests, awaits approval and never changes active source',async()=>{
 if(process.platform!=='darwin')return;
 const root=await mkdtemp(path.join(os.tmpdir(),'global-source-fixture-'));let workspace:string|undefined;const exec=promisify(execFile);
 const file='apps/scene-validator/src/motion/tools.ts',original='export const duration=(n:number)=>n+1;\n';
 const stop=registerProvider('source-patch-fixture',()=>({id:'source-patch-fixture',mode:'mock',capabilities:caps,generate:async req=>{
  const context=JSON.parse(req.messages.find(m=>m.role==='user')!.content).context;
  return {output:{action:'propose',reason:'Controlled +1 defect',proposal:{rootCause:'Injected duration error',changes:[{path:file,beforeHash:sha(original),edits:[{find:'n+1',replace:'n'}]},{path:context.regressionPath,beforeHash:sha(''),content:"import test from 'node:test';import assert from 'node:assert/strict';import {duration} from '../src/motion/tools.js';test('exact duration',()=>assert.equal(duration(3),3));\n"}],regressionTests:[context.regressionPath],risks:['synthetic fixture only']}},usage:null,estimatedCost:null,latencyMs:0,diagnostics:[],toolCalls:[]};
 }}));
 try{
  await mkdir(path.join(root,'apps/scene-validator/src/motion'),{recursive:true});await mkdir(path.join(root,'apps/scene-validator/tests'),{recursive:true});await writeFile(path.join(root,file),original);await writeFile(path.join(root,'package.json'),'{"type":"module"}');await writeFile(path.join(root,'.gitignore'),'node_modules\ndata/\n');
  await writeFile(path.join(root,'tsconfig.check.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:true,types:['node']},include:['apps/**/*.ts']}));await symlink(path.resolve('node_modules'),path.join(root,'node_modules'));
  await exec('git',['init','-q'],{cwd:root});await exec('git',['add','apps','package.json','tsconfig.check.json','.gitignore'],{cwd:root});await exec('git',['-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','Injected baseline'],{cwd:root});
  const s=makeSupervisor(),failure=recoveryFailure(injected('INTERNAL_INJECTED','motion/tools'),'fixture','r');
  await s.settle(injected('INTERNAL_INJECTED','motion/tools'),'fixture',{code:{strategy:'code',procedure:'source-investigation',reason:'Controlled source evidence',run:async()=>{const result=await proposeCodeRepair(root,failure,recoveryPolicySchema.parse({}),{provider:'source-patch-fixture',model:''});if('workspace'in result)workspace=result.workspace;return result;},verify:async value=>{const report=await reviewCodeRepair((value as {workspace:string}).workspace);assert.equal(report.status,'AWAITING_APPROVAL');assert.ok(report.tests.every((t:{status:string})=>t.status==='PASSED'));assert.ok(report.baseline.some((t:{status:string})=>t.status==='FAILED'));return {status:'PATCH_VERIFIED'};}}});
  assert.equal(s.report.status,'PATCH_AWAITING_APPROVAL',JSON.stringify({attempts:s.report.attempts,codeRepair:s.report.codeRepair,decisions:s.report.decisions}));assert.equal(await readFile(path.join(root,file),'utf8'),original);
  let extra=0;const reused=await proposeCodeRepair(root,failure,recoveryPolicySchema.parse({}),{provider:'source-patch-fixture',model:''},undefined,async()=>{extra++;});assert.equal(reused.status,'AWAITING_APPROVAL');assert.equal(extra,0);
 }finally{stop();await rm(root,{recursive:true,force:true});if(workspace)await rm(workspace,{recursive:true,force:true});}
});

test('failure inside Code Repair is supervised once, with no recursive coding agent or false success',async()=>{
 const s=makeSupervisor();let calls=0;
 await s.settle(injected('COMPILER_INTERNAL'),'compiler',{code:{strategy:'code',procedure:'source-investigation',reason:'test',run:async()=>{calls++;throw new ProviderError('OUTPUT_TRUNCATED','code proposal truncated');},verify:async()=>({status:'PATCH_VERIFIED'})}});
 assert.equal(calls,1);assert.equal(s.report.status,'RECOVERY_EXHAUSTED');assert.ok(s.report.events.some(e=>e.stage==='code-repair'&&e.errorCode==='OUTPUT_TRUNCATED'));assert.equal(s.report.codeRepair,undefined);
});
test('source reserve and cancellation/deadline keep repair bounded independently of primary execution',async()=>{
 const s=new GlobalFailureSupervisor({request:'x',revision:'r',maxAttempts:2,maxDurationMs:1000,reserveSourceAttempt:true,persist:async()=>{}});const event=await s.observe(injected('INTERNAL'),'execution');
 const action={strategy:'project' as const,procedure:'p',reason:'test',run:async()=>({}),verify:async()=>({status:'PASSED'})};
 assert.equal((await s.attempt(event,action)).ok,true);assert.equal((await s.attempt(event,{...action,procedure:'p2'})).ok,false);
 assert.equal((await s.attempt(event,{...action,strategy:'code',procedure:'source'})).ok,true);
 const controller=new AbortController(),c=new GlobalFailureSupervisor({request:'x',revision:'r',maxAttempts:2,maxDurationMs:1000,signal:controller.signal,persist:async()=>{}});
 const e=await c.observe(injected('INTERNAL'),'execution');controller.abort();let called=0;assert.equal((await c.attempt(e,{...action,run:async()=>{called++;return{};}})).ok,false);assert.equal(called,0);
});
test('an absolute-time grow/return sequence is local to its clause and still requires an end dependency',async()=>{
 const f=await identityFixture(1,s=>{s[0].children=[node('p','Product')];});try{
  const first='Product появляется через фейд. ',second='на 9 секунде Product увеличивается а потом встает на место';const request=first+second;
  const previous=objectRequirement('previous','s0','p','Product',['fadeIn'],first),grow=objectRequirement('grow','s0','p','Product',['scaleIn'],second),back=objectRequirement('back','s0','p','Product',['scaleIn'],second);
  previous.sourceClauseId='c0';grow.sourceClauseId='c1';back.sourceClauseId='c1';
  grow.timing.startSeconds=9;back.timing.relation='afterRequirement';back.timing.anchorRequirementId='grow';back.timing.align='end';
  const plan={schemaVersion:'1.0.0' as const,sourceClauses:[{clauseId:'c0',text:first,start:0,end:first.length},{clauseId:'c1',text:second,start:first.length,end:request.length}],requirements:[previous,grow,back],coverage:[{sourceText:first,requirementIds:['previous'],classification:'executable' as const,explanation:'fixture'},{sourceText:second,requirementIds:['grow','back'],classification:'executable' as const,explanation:'fixture'}],assumptions:[]};
  assert.equal(inspectSemanticCoverage(f.project,request,plan).issues.filter(i=>i.code==='MISSING_SEQUENTIAL_DEPENDENCY').length,0);back.timing.align='start';assert.ok(inspectSemanticCoverage(f.project,request,plan).issues.some(i=>i.code==='MISSING_SEQUENTIAL_DEPENDENCY'));
 }finally{await f.cleanup();}
});

test('recovery storage failure blocks unrecorded changes; broken optional experience does not suppress diagnosis',async()=>{
 let actions=0;
 const blocked=new GlobalFailureSupervisor({request:'original',revision:'r1',maxAttempts:3,maxDurationMs:1000,persist:async()=>{throw Error('ENOSPC');}});
 await blocked.settle(injected('COMPILER_INTERNAL'),'compiler',{project:{strategy:'project',procedure:'must-not-run',reason:'test',run:async()=>{actions++;return{};},verify:async()=>({status:'PASSED'})}});
 assert.equal(actions,0);assert.equal(blocked.report.status,'RECOVERY_BLOCKED');assert.match(blocked.report.finalReason!,/persisted/);
 await blocked.complete(true,{status:'SUCCESS'});assert.equal(blocked.report.status,'RECOVERY_BLOCKED');
 const healthy=new GlobalFailureSupervisor({request:'original',revision:'r1',maxAttempts:3,maxDurationMs:1000,persist:async()=>{},known:async()=>{throw Error('INVALID_RECOVERY_EXPERIENCE');}});
 await healthy.settle(injected('COMPILER_INTERNAL'),'compiler');
 assert.equal(healthy.report.events.length,1);assert.ok(healthy.report.events[0].validationEvidence.some(e=>JSON.stringify(e).includes('experience-lookup')));assert.equal(healthy.report.status,'RECOVERY_EXHAUSTED');
});
