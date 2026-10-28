import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {Codex} from '@openai/codex-sdk';
import {CodexAdapter} from '../src/harness/providers/codex.js';
import {HarnessRun} from '../src/harness/runtime.js';
import {ProviderError} from '../src/harness/providers/types.js';
import {identityFixture} from './identity-fixture.js';
const request={messages:[{role:'user' as const,content:'русский ///\n\u2028\u2029'}],responseSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},timeoutMs:10000,maxOutputTokens:16000,purpose:'semantic-planning' as const};
test('installed SDK Unicode framing failure reproduced; guarded SDK preserves large JSON and split UTF8 without another model call',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),"sdk'-framing-"));const old=process.env.MOTION_CODEX_BIN;
 try{
 const binary=path.join(dir,'fake-codex');
 const payload={text:'///\nна 5 секунде текст уходит, \u2028лого аналогично\u2029'+'русский '.repeat(10000)};
 const events=[{type:'item.completed',item:{id:'i',type:'agent_message',text:JSON.stringify(payload)}},{type:'turn.completed',usage:{input_tokens:100,output_tokens:100,cached_input_tokens:20}}];
 await writeFile(binary,`#!${process.execPath}\nconst b=Buffer.from(${JSON.stringify(events.map(e=>JSON.stringify(e)).join('\n')+'\n')});process.stdin.resume();process.stdin.on('end',()=>{for(let i=0;i<b.length;i+=7)process.stdout.write(b.subarray(i,i+7));});`,{mode:0o700});
 await assert.rejects(new Codex({codexPathOverride:binary}).startThread({workingDirectory:dir,skipGitRepoCheck:true}).run('fixture'),/Failed to parse item/);
 process.env.MOTION_CODEX_BIN=binary;
 const result=await new CodexAdapter('codex-sdk',dir).generate(request);
 assert.deepEqual(result.output,payload);assert.equal(result.usage?.cachedInputTokens,20);
 for(const [text,code] of [['{"text":','OUTPUT_TRUNCATED'],['{broken}','PROVIDER_JSON_INVALID']] as const){
  const lines=[{type:'item.completed',item:{id:'i',type:'agent_message',text}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}].map(e=>JSON.stringify(e)).join('\n')+'\n';
  await writeFile(binary,`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(lines)}));`,{mode:0o700});
  await assert.rejects(new CodexAdapter('codex-sdk',dir).generate(request),e=>(e as ProviderError).code===code);
 }
 await writeFile(binary,`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write('{"type":broken}\\n'));`,{mode:0o700});
 await assert.rejects(new CodexAdapter('codex-sdk',dir).generate(request),e=>(e as ProviderError).code==='PROVIDER_EVENT_PARSE_ERROR');
 }finally{if(old===undefined)delete process.env.MOTION_CODEX_BIN;else process.env.MOTION_CODEX_BIN=old;await rm(dir,{recursive:true,force:true});}
});
test('one transient provider failure automatically retries through existing supervisor, bounded calls and cancellation remain enforced',async()=>{
 const f=await identityFixture(1);let calls=0;
 const adapter={id:'fixture-provider',mode:'mock' as const,capabilities:()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false}),generate:async()=>{calls++;if(calls===1)throw new ProviderError('TRANSPORT','temporary socket reset');return {output:{text:'ok'},usage:null,estimatedCost:null,latencyMs:1,diagnostics:[],toolCalls:[]};}};
 const run=await HarnessRun.start(f.project,'transport-retry','fixture',adapter.id,'',undefined,{maxLLMCalls:2});
 try{
 const response=await run.invoke(adapter,request);assert.deepEqual(response.output,{text:'ok'});assert.equal(calls,2);
 assert.equal(run.supervisor.report.attempts.filter(a=>a.procedure==='bounded-provider-transport-retry/1').length,1);
 assert.equal(run.supervisor.report.originalFailure?.errorCode,'TRANSPORT');
 }finally{await run.finish('FAILED');await f.cleanup();}
});

test('persistent event corruption stops after one transport retry, preserves root and never repeats into code repair',async()=>{
 const f=await identityFixture(1);let calls=0;const error=new ProviderError('PROVIDER_EVENT_PARSE_ERROR','malformed JSONL envelope');
 const adapter={id:'broken-events',mode:'mock' as const,capabilities:()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false}),generate:async()=>{calls++;throw error;}};
 const run=await HarnessRun.start(f.project,'broken-events','fixture',adapter.id,'',undefined,{maxLLMCalls:2});
 try{
 await assert.rejects(run.invoke(adapter,request),e=>e===error);assert.equal(calls,2);
 const report=await run.supervisor.settle(error,'provider-call');assert.equal(report.status,'RECOVERY_EXHAUSTED');assert.match(report.finalReason!,/one budgeted retry/);assert.equal(report.originalFailure?.errorCode,'PROVIDER_EVENT_PARSE_ERROR');assert.equal(report.attempts.length,1);
 }finally{await run.finish('FAILED');await f.cleanup();}
});
