import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {safeDirectory,noSymlinkPath} from '../../files.js';
const exec=promisify(execFile);
/** Fresh process loads approved source. Saved provider response only; no external LLM call. */
export async function verifyOriginalRun(repository:string,projectRoot:string,runId:string,reportRepository=repository){
 if(!/^[a-f0-9-]{36}$/.test(runId))throw Error('INVALID_RUN_ID');
 const saved=path.join(projectRoot,'motion/ai',runId,'semantic-interpret/raw-response.json');
 await noSymlinkPath(projectRoot,saved);await readFile(saved);
 const logDir=await safeDirectory(reportRepository,'data/harness/code-repairs/replays');
 const run=async(args:string[])=>exec(process.execPath,args,{cwd:repository,env:{...process.env,PATH:path.dirname(process.execPath)+path.delimiter+(process.env.PATH??'')},timeout:300000,maxBuffer:8*1024*1024});
 await run([path.join(repository,'node_modules/typescript/bin/tsc'),'--noEmit','-p','tsconfig.check.json']);
 await run(['--input-type=module','-e',"import {build} from 'esbuild';await build({entryPoints:['apps/scene-validator/src/native/worker.ts'],outfile:'apps/scene-validator/src/native/worker-runtime.mjs',bundle:true,format:'esm',platform:'node',target:'node20',packages:'external'});"]);
 try{
  const result=await run(['--import','tsx','scripts/replay-agent-run.ts','--project',projectRoot,'--run',runId,'--recorded-state']);
  await writeFile(path.join(logDir,runId+'.log'),result.stdout+result.stderr);
  return {status:'PASSED',mode:'saved-provider-response',originalRunId:runId,originalProjectChanged:false,log:path.join(logDir,runId+'.log')};
 }catch(error){
  const e=error as {stdout?:string;stderr?:string};await writeFile(path.join(logDir,runId+'.log'),(e.stdout??'')+(e.stderr??''));
  throw Error('ORIGINAL_RUN_REPLAY_FAILED: see diagnostic replay log');
 }
}
