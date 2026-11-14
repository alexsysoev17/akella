import {createHash,randomUUID} from "node:crypto";
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {safeDirectory,noSymlinkPath} from '../../files.js';
const exec=promisify(execFile);
/** Fresh process loads approved source. Saved provider response only; no external LLM call. */
export async function verifyOriginalRun(repository:string,projectRoot:string,runId:string,reportRepository=repository,allowLiveReplay=false){
 if(!/^[a-f0-9-]{36}$/.test(runId))throw Error('INVALID_RUN_ID');
 const saved=path.join(projectRoot,'motion/ai',runId,'semantic-interpret/raw-response.json');
 let recorded=true;try{await noSymlinkPath(projectRoot,saved);await readFile(saved);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;recorded=false;}
 if(!recorded&&!allowLiveReplay)throw Error("ORIGINAL_REPLAY_NEEDS_PROVIDER: explicit approval must allow replanning because no complete saved response exists");
 const logDir=await safeDirectory(reportRepository,'data/harness/code-repairs/replays');
 const run=async(args:string[])=>exec(process.execPath,args,{cwd:repository,env:{...process.env,PATH:path.dirname(process.execPath)+path.delimiter+(process.env.PATH??'')},timeout:300000,maxBuffer:8*1024*1024});
 await run([path.join(repository,'node_modules/typescript/bin/tsc'),'--noEmit','-p','tsconfig.check.json']);
 await run(['--input-type=module','-e',"import {build} from 'esbuild';await build({entryPoints:['apps/scene-validator/src/native/worker.ts'],outfile:'apps/scene-validator/src/native/worker-runtime.mjs',bundle:true,format:'esm',platform:'node',target:'node20',packages:'external'});"]);
 try{
  const reportFile=path.join(logDir,runId+"-"+randomUUID()+".json");
  const result=await run(['--import','tsx','scripts/replay-agent-run.ts','--project',projectRoot,'--run',runId,'--recorded-state','--report-file',reportFile,...recorded?[]:['--live-original-provider']]);
  const replay=JSON.parse(await readFile(reportFile,'utf8'));
  if(replay.reconciliation?.status!=="SUCCESS")throw Error("ORIGINAL_RUN_REPLAY_UNVERIFIED");
  const resultHash=createHash("sha256").update(await readFile(replay.resultFile)).digest("hex");
  await writeFile(path.join(logDir,runId+'.log'),result.stdout+result.stderr);
  return {status:'PASSED',mode:recorded?'saved-provider-response':'live-original-provider',originalRunId:runId,originalProjectChanged:false,replayRoot:replay.copy,resultFile:replay.resultFile,resultHash,log:path.join(logDir,runId+'.log')};
 }catch(error){
  const e=error as {stdout?:string;stderr?:string};await writeFile(path.join(logDir,runId+'.log'),(e.stdout??'')+(e.stderr??''));
  throw Error('ORIGINAL_RUN_REPLAY_FAILED: see diagnostic replay log');
 }
}

/** Fresh Node process loads the integrated code before publishing the verified candidate. */
export async function publishOriginalReplay(repository:string,projectRoot:string,runId:string,replay:unknown){
 const value=replay as {replayRoot?:string;resultFile?:string;resultHash?:string};
 if(!value.replayRoot||!value.resultFile||!value.resultHash)return {status:'BLOCKED',reason:'Verified replay receipt unavailable'};
 try{
  const result=await exec(process.execPath,['--import','tsx','scripts/resume-verified-run.ts','--project',projectRoot,'--run',runId,'--copy',value.replayRoot,'--result',value.resultFile,'--hash',value.resultHash],{cwd:repository,env:{...process.env,PATH:path.dirname(process.execPath)+path.delimiter+(process.env.PATH??'')},timeout:120000,maxBuffer:2*1024*1024});
  return JSON.parse(result.stdout.trim()) as {status:string;revision?:string;reason?:string};
 }catch(error){return {status:'BLOCKED',reason:'Source patch integrated, but replay publication failed; user edits preserved. '+String(error).slice(0,1000)};}
}
