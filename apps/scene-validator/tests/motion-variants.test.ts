import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { identityFixture } from './identity-fixture.js';
import { createProject } from '../src/importer.js';
import { loadProject } from '../src/project.js';
import { changeMotion, readMotion } from '../src/motion/store.js';
import { inventory } from '../src/files.js';
import { registerProvider } from '../src/harness/providers/index.js';
import { startMotionVariants, resumeMotionVariants, rerenderMotionVariant, readMotionVariantBatch, cancelMotionVariantBatch, recoverMotionVariantBatches, listMotionVariantBatches, type MotionVariantDependencies } from '../src/motion/variants.js';
import type { LoadedProject } from '../src/types.js';
import {motionApi} from '../src/motion/api.js';
import {runtimeCode} from '../src/runtime-code.js';
import {harnessConfigSchema} from '../src/harness/config.js';

const request = (p:LoadedProject, extra={}) => ({request:'Анимируй раскадровку как цельный ролик.',settings:{provider:'codex-sdk',model:'gpt-6-astra'},expectedSourceFingerprint:p.inspection.fingerprint,render:false,...extra});
const plan: MotionVariantDependencies['plan'] = async ({project,input}) => ({story:'Одна непрерывная история',continuity:'Общие объекты сохраняют идентичность.',variants:Array.from({length:input.count},(_,i)=>({title:`Решение ${i+1}`,concept:`Акцент ${i+1}`,durationSeconds:12,sceneBeats:project.inspection.document.scenes.map(s=>({sceneId:s.sceneId,direction:'Сохрани состояние и продолжи движение.'}))}))});
const execute: MotionVariantDependencies['execute'] = async (project,input) => {
  const before=await readMotion(project);assert.equal(before.revision,'initial');assert.equal(before.history.length,0);assert.equal(before.state.animations.length,0);
  const changed=await changeMotion(project.root,{expectedRevision:'initial',request:String(input.request),operations:[{type:'setProjectSettings',settings:{...before.state.settings,fps:24}}]});
  return {status:'applied',document:changed};
};
test('Rerender publishes a chat-edited revision without planning/execution and retains prior video provenance',async()=>{
  const f=await identityFixture(1);try{
    const first=await startMotionVariants(f.project,request(f.project,{count:1,render:true}),{plan,execute,render:async()=>({file:'old.mp4'})});const before=await first.done,item=before.variants[0];
    const child=await loadProject(path.join(path.dirname(f.project.root),item.directory)),old=await readMotion(child);
    const edited=(await changeMotion(child.root,{expectedRevision:old.revision,request:'chat edit',operations:[{type:'setProjectSettings',settings:{...old.state.settings,fps:30}}]})).document;
    const editedBytes=await readFile(path.join(child.root,'motion/motion.json'),'utf8');let calls=0;const raw={batchId:before.id,variantId:item.id,expectedRevision:edited.revision,expectedSourceFingerprint:f.project.inspection.fingerprint};
    await assert.rejects(rerenderMotionVariant(f.project,{...raw,expectedRevision:'stale'},{render:async()=>{throw Error('must not render');}}),/STALE_VARIANT_REVISION/);
    const job=await rerenderMotionVariant(f.project,raw,{plan:async()=>{throw Error('must not plan');},execute:async()=>{throw Error('must not execute');},render:async p=>{calls++;assert.equal((await readMotion(p)).revision,edited.revision);return {file:'new.mp4',revision:edited.revision};}});
    const after=await job.done;assert.equal(calls,1);assert.equal(after.variants[0].video,'new.mp4');assert.equal(after.variants[0].revision,edited.revision);assert.equal(after.variants[0].renderHistory[0].video,'old.mp4');assert.equal(after.variants[0].renderHistory[0].revision,old.revision);assert.deepEqual(after.plan,before.plan);assert.equal(await readFile(path.join(child.root,'motion/motion.json'),'utf8'),editedBytes);assert.equal((await readMotion(f.project)).revision,'initial');
    const stale=await rerenderMotionVariant(f.project,raw,{render:async()=>({file:'stale.mp4',revision:'wrong'})});const rejected=await stale.done;assert.equal(rejected.variants[0].video,'new.mp4');assert.match(rejected.variants[0].renderError!,/STALE_VARIANT_RENDER/);
  }finally{await f.cleanup();}
});

test('Existing and freshly imported projects without variant storage remain readable at startup',async()=>{
  const f=await identityFixture(1);try{
    assert.deepEqual(await listMotionVariantBatches(f.project),[]);
    await recoverMotionVariantBatches(f.project);
    assert.deepEqual(await listMotionVariantBatches(f.project),[]);
    assert.equal((await readMotion(f.project)).revision,'initial');
  }finally{await f.cleanup();}
});

test('Four source-only variants have independent histories and leave parent motion/source/config intact',async()=>{
  const f=await identityFixture(3);try{
    await changeMotion(f.project.root,{expectedRevision:'initial',request:'Existing unrelated user motion',operations:[{type:'setProjectSettings',settings:{...f.state.settings,fps:25,durationFrames:180}}]});
    const parent=await readMotion(f.project),source=await inventory(f.project.sourceRoot),config=await readFile(path.join(f.project.root,'project.json'),'utf8');
    const settingsSeen:string[]=[],roots=new Set<string>();
    const job=await startMotionVariants(f.project,request(f.project),{plan,execute:async(p,input,stage,signal,runId)=>{
      roots.add(p.root);settingsSeen.push(JSON.stringify(input.settings));assert.notEqual(p.root,f.project.root);assert.equal(input.expectedRevision,'initial');assert.equal(input.editId,runId);
      stage('checking');return execute(p,input,stage,signal,runId);
    }});
    const batch=await job.done;assert.equal(batch.status,'completed');assert.equal(batch.variants.length,4);assert.equal(roots.size,4);
    assert.equal(new Set(batch.variants.map(v=>v.projectId)).size,4);assert.equal(new Set(batch.variants.map(v=>v.runId)).size,4);
    assert.deepEqual(new Set(settingsSeen),new Set([JSON.stringify(request(f.project).settings)]));
    for(const item of batch.variants){const p=await loadProject(path.join(path.dirname(f.project.root),item.directory));assert.deepEqual(await inventory(p.sourceRoot),source);assert.equal((await readMotion(p)).history.length,1);assert.equal(item.renderStatus,'skipped');}
    assert.deepEqual(await readMotion(f.project),parent);assert.deepEqual(await inventory(f.project.sourceRoot),source);assert.equal(await readFile(path.join(f.project.root,'project.json'),'utf8'),config);
    assert.equal((await readMotionVariantBatch(f.project,batch.id)).status,'completed');
  }finally{await f.cleanup();}
});

test('One failed executor and one failed render preserve other finished variants',async()=>{
  const f=await identityFixture(2);try{
    let called=0,rendered=0;
    const job=await startMotionVariants(f.project,request(f.project,{render:true}),{plan,execute:async(...args)=>{if(++called===2)throw Error('isolated executor failure');return execute(...args);},render:async()=>{if(++rendered===1)throw Error('encoder unavailable');return {file:`draft-half-${randomUUID()}.mp4`};}});
    const b=await job.done;assert.equal(b.status,'failed');assert.equal(b.variants.filter(v=>v.status==='completed').length,3);assert.equal(b.variants.filter(v=>v.status==='failed').length,1);assert.equal(b.variants.filter(v=>v.renderStatus==='completed').length,2);assert.equal(b.variants.filter(v=>v.renderError==='encoder unavailable').length,1);assert.equal((await readMotion(f.project)).revision,'initial');
  }finally{await f.cleanup();}
});

test('Cancellation aborts active executors, never starts queued ones, and does not submit again after restart',async()=>{
  const f=await identityFixture(2);try{
    let entered=0,ready!:()=>void;const active=new Promise<void>(resolve=>ready=resolve);
    const job=await startMotionVariants(f.project,request(f.project),{plan,execute:async(_p,_input,_stage,signal)=>{if(++entered===2)ready();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));return {status:'applied'};}});
    await active;
    const originalGuard=runtimeCode.assertCurrent;let response:any;
    try{
      runtimeCode.assertCurrent=()=>{throw Error('server is stale');};
      await motionApi(f.project,{method:'POST',headers:{'content-type':'application/json'}} as any,{writeHead:()=>{},end:(body:string)=>response=JSON.parse(body)} as any,['api','projects',f.project.config.projectId,'motion','variants','cancel'],async()=>Buffer.from(JSON.stringify({batchId:job.batchId})));
      assert.equal(response.cancelled,true);
    }finally{runtimeCode.assertCurrent=originalGuard;}
    const b=await job.done;assert.equal(b.status,'cancelled');assert.equal(entered,2);assert.ok(b.variants.every(v=>v.status==='cancelled'));
    // Simulate only the persisted state of a process that disappeared.
    b.status='running';b.variants[0].status='running';b.variants[0].renderStatus='running';
    await writeFile(path.join(f.project.root,'motion/variants',`${b.id}.json`),JSON.stringify(b));
    await recoverMotionVariantBatches(f.project);
    const recovered=await readMotionVariantBatch(f.project,b.id);assert.equal(recovered.status,'interrupted');assert.equal(recovered.variants[0].status,'interrupted');assert.equal(recovered.variants[0].renderStatus,'failed');assert.equal(entered,2);
  }finally{await f.cleanup();}
});

test('Batch admission checks fingerprints and at most two execution pipelines run across parents',async()=>{
  const f=await identityFixture(2);try{
    const imported=await createProject({name:'second parent',source:f.source,projectsRoot:path.dirname(f.project.root)}),other=await loadProject(imported.projectPath);
    await assert.rejects(startMotionVariants(f.project,request(f.project,{expectedSourceFingerprint:'stale'})),/STALE_SOURCE/);
    let active=0,peak=0;
    const deps={plan,execute:async(...args:Parameters<MotionVariantDependencies['execute']>)=>{active++;peak=Math.max(peak,active);try{await new Promise(resolve=>setTimeout(resolve,40));return await execute(...args);}finally{active--;}}};
    const a=await startMotionVariants(f.project,request(f.project),deps);await assert.rejects(startMotionVariants(f.project,request(f.project),deps),/уже создаются/);
    const b=await startMotionVariants(other,request(other),deps);const results=await Promise.all([a.done,b.done]);assert.ok(results.every(r=>r.status==='completed'));assert.equal(peak,2);assert.equal(active,0);
    await assert.rejects(readMotionVariantBatch(other,a.batchId),/ENOENT/);await assert.rejects(readMotionVariantBatch(f.project,'../escape'));
  }finally{await f.cleanup();}
});

test('Real planner adapter receives every source preview, selected model and ordered scene facts',async()=>{
  const f=await identityFixture(2);let unregister:(()=>void)|undefined;try{
    const source=JSON.parse(await readFile(path.join(f.source,'scene.json'),'utf8'));
    for(const [i,s] of source.scenes.entries()){s.preview=`preview-${i}.png`;await writeFile(path.join(f.source,s.preview),Buffer.from('89504e470d0a1a0a','hex'));}
    await writeFile(path.join(f.source,'scene.json'),JSON.stringify(source));
    const imported=await createProject({name:'planner source',source:f.source,projectsRoot:path.dirname(f.project.root)}),project=await loadProject(imported.projectPath);
    let calls=0;
    unregister=registerProvider('variants-test',()=>({id:'variants-test',mode:'mock',capabilities:()=>({structuredOutput:true,schemaDialect:'json-schema',nativeToolCalling:false,cancellation:true,usage:true,nativeOutputTokenLimit:false}),generate:async input=>{
      calls++;assert.equal(input.images?.length,2);assert.equal(input.model,'chosen-model');assert.equal(input.reasoningEffort,'high');assert.ok(input.images!.every(file=>file.includes('motion-variant-')));assert.match(input.messages[0].content,/short-readable-text-handoff/);assert.match(input.messages[1].content,/sceneId/);
      assert.ok(input.timeoutMs>590000&&input.timeoutMs<=600000,'Multimodal planner gets its full explicit deadline after harness reserves');
      assert.equal(harnessConfigSchema.parse({}).providerTimeoutMs,180000);assert.equal(harnessConfigSchema.parse({}).semanticPlanningTimeoutMs,180000);assert.equal(harnessConfigSchema.parse({}).maxDurationMs,240000);
      const output=await plan({project,input:{...request(project),count:4,settings:{provider:'variants-test',model:'chosen-model'},render:false},signal:new AbortController().signal,runId:randomUUID()});
      return {output,usage:{inputTokens:50,outputTokens:60},estimatedCost:null,latencyMs:1,diagnostics:[],toolCalls:[]};
    }}));
    const job=await startMotionVariants(project,request(project,{settings:{provider:'variants-test',model:'chosen-model',reasoningEffort:'high'}}),{execute});
    assert.equal((await job.done).status,'completed');assert.equal(calls,1);assert.equal((await listMotionVariantBatches(project)).length,1);
  }finally{unregister?.();await f.cleanup();}
});

test('Malformed or reordered director output never starts executors',async()=>{
  const f=await identityFixture(2);try{
    let calls=0;const job=await startMotionVariants(f.project,request(f.project),{plan:async context=>{const p=await plan(context);p.variants[0].sceneBeats.reverse();return p;},execute:async()=>{calls++;return {status:'applied'};}});
    const batch=await job.done;assert.equal(batch.status,'failed');assert.match(batch.error!,/STORYBOARD_ORDER/);assert.equal(calls,0);
  }finally{await f.cleanup();}
});

test('Resume reuses the saved plan and children, preserves completed variants and keeps prior failure visible',async()=>{
  const f=await identityFixture(2);try{
    let planned=0,executed=0;
    const first=await startMotionVariants(f.project,request(f.project),{plan:async c=>{planned++;const p=await plan(c);p.variants[0].sceneBeats[0].direction='Законченное описание движения. '.repeat(25);return p;},execute:async(...args)=>{if(++executed===2)throw Error('transient transport');return execute(...args);}});
    const before=await first.done,failed=before.variants.find(v=>v.status==='failed')!,completed=before.variants.filter(v=>v.status==='completed');
    const completedBytes=await Promise.all(completed.map(v=>readFile(path.join(path.dirname(f.project.root),v.directory,'motion/motion.json'),'utf8')));
    const resumed=await resumeMotionVariants(f.project,{batchId:before.id,expectedSourceFingerprint:f.project.inspection.fingerprint,variantIds:[failed.id]},{plan:async()=>{throw Error('must not replan');},execute:async(...args)=>{executed++;return execute(...args);}});
    const after=await resumed.done;assert.equal(after.status,'completed');assert.equal(planned,1);assert.equal(executed,5);assert.deepEqual(after.plan,before.plan);assert.deepEqual(after.variants.map(v=>v.projectId),before.variants.map(v=>v.projectId));
    assert.ok(after.plan!.variants[0].sceneBeats[0].direction.length>500);
    assert.equal(after.variants.find(v=>v.id===failed.id)!.attempts[0].error,'transient transport');
    assert.deepEqual(await Promise.all(completed.map(v=>readFile(path.join(path.dirname(f.project.root),v.directory,'motion/motion.json'),'utf8'))),completedBytes);
    await assert.rejects(resumeMotionVariants(f.project,{batchId:after.id,expectedSourceFingerprint:f.project.inspection.fingerprint,variantIds:[completed[0].id]}),/незавершённые/);
  }finally{await f.cleanup();}
});

test('Resume continues the actual direct checkpoint once, without repeating confirmed operations or model planning',async()=>{
  const f=await identityFixture(1);let stop:(()=>void)|undefined;try{
    let calls=0,started!:()=>void;const waiting=new Promise<void>(resolve=>started=resolve);
    const id='variant-resume-test';stop=registerProvider(id,()=>({id,mode:'mock',capabilities:()=>({structuredOutput:true,schemaDialect:'json-schema',nativeToolCalling:false,cancellation:true,usage:true,nativeOutputTokenLimit:false}),generate:async r=>{
      calls++;let output:unknown;
      if(calls===1){const c=JSON.parse(r.messages[1].content);output={calls:[{callId:'first-edit',tool:'applyEdit',argumentsJson:JSON.stringify({operations:[{type:'setProjectSettings',settings:{...c.context.project.settings,fps:24}}]})}],disposition:'CONTINUE',message:'Подготовлено',assumptions:[]};}
      else if(calls===2){started();await new Promise((_,reject)=>r.signal!.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));}
      else output={calls:[{callId:'publish',tool:'commitRevision',argumentsJson:'{}'}],disposition:'COMMIT',message:'Готово',assumptions:[]};
      return {output,usage:{inputTokens:50,outputTokens:20},estimatedCost:null,latencyMs:1,diagnostics:[],toolCalls:[]};
    }}));
    const first=await startMotionVariants(f.project,request(f.project,{count:1,settings:{provider:id,model:'chosen'}}),{plan});
    await waiting;await cancelMotionVariantBatch(f.project,first.batchId);const cancelled=await first.done;assert.equal(cancelled.status,'cancelled');
    const item=cancelled.variants[0],checkpointPath=path.join(path.dirname(f.project.root),item.directory,'motion/direct-runs',item.runId!,'checkpoint.json');
    const checkpoint=JSON.parse(await readFile(checkpointPath,'utf8'));assert.equal(checkpoint.snapshot.batches.flat().length,1);
    const resumed=await resumeMotionVariants(f.project,{batchId:cancelled.id,expectedSourceFingerprint:f.project.inspection.fingerprint},{plan:async()=>{throw Error('unexpected replanning');}});
    const result=await resumed.done;assert.equal(result.status,'completed');assert.equal(result.variants[0].runId,item.runId);assert.equal(calls,3);
    const child=await loadProject(path.join(path.dirname(f.project.root),item.directory)),doc=await readMotion(child);assert.equal(doc.state.settings.fps,24);assert.equal(doc.history.length,1);assert.equal(doc.history[0].operations.length,1);
  }finally{stop?.();await f.cleanup();}
});

test('A failed common planner can retry once on the same untouched child projects, preserving the failed run and error',async()=>{
  const f=await identityFixture(2);try{
    let calls=0;
    const first=await startMotionVariants(f.project,request(f.project),{plan:async()=>{calls++;throw Error('PROVIDER_TIMEOUT');},execute});
    const failed=await first.done;assert.equal(failed.plan,null);assert.equal(failed.status,'failed');assert.ok(failed.variants.every(v=>!v.runId));
    const childIds=failed.variants.map(v=>v.projectId),directories=failed.variants.map(v=>v.directory);
    const next=await resumeMotionVariants(f.project,{batchId:failed.id,expectedSourceFingerprint:f.project.inspection.fingerprint},{plan:async c=>{calls++;return plan(c);},execute});
    const done=await next.done;assert.equal(done.id,failed.id);assert.equal(done.status,'completed');assert.equal(calls,2);
    assert.deepEqual(done.variants.map(v=>v.projectId),childIds);assert.deepEqual(done.variants.map(v=>v.directory),directories);
    assert.equal(done.planningAttempts[0].runId,failed.planningRunId);assert.equal(done.planningAttempts[0].error,'PROVIDER_TIMEOUT');assert.notEqual(done.planningRunId,failed.planningRunId);
    assert.equal((await readMotion(f.project)).revision,'initial');
  }finally{await f.cleanup();}
});

test('Retrying a failed planner refuses a child edited in the meantime before making another provider call',async()=>{
  const f=await identityFixture(1);try{
    let calls=0;
    const first=await startMotionVariants(f.project,request(f.project),{plan:async()=>{calls++;throw Error('PROVIDER_TIMEOUT');},execute});
    const failed=await first.done,child=await loadProject(path.join(path.dirname(f.project.root),failed.variants[0].directory));
    await changeMotion(child.root,{expectedRevision:'initial',request:'User changed the child',operations:[{type:'setProjectSettings',settings:{...(await readMotion(child)).state.settings,fps:24}}]});
    const before=await readFile(path.join(child.root,'motion/motion.json'),'utf8');
    const next=await resumeMotionVariants(f.project,{batchId:failed.id,expectedSourceFingerprint:f.project.inspection.fingerprint},{plan:async c=>{calls++;return plan(c);},execute});
    const result=await next.done;assert.equal(result.status,'failed');assert.match(result.error!,/VARIANT_WAS_EDITED/);assert.equal(calls,1);
    assert.equal(await readFile(path.join(child.root,'motion/motion.json'),'utf8'),before);
  }finally{await f.cleanup();}
});
