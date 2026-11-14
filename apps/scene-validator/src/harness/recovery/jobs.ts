import path from 'node:path';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {atomicJson,noSymlinkPath,safeDirectory} from '../../files.js';
import {readMotion} from '../../motion/store.js';
import type {LoadedProject} from '../../types.js';
import type {IntentPlan} from '../../motion/intent/schema.js';
export interface RecoveryJob {version:'deferred-recovery/1';id:string;originalRunId:string;replayRunId:string;revision:string;fingerprint:string;status:'PENDING'|'RUNNING'|'COMPLETED'|'FAILED'|'STALE'|'CANCELLED';attempts:number;createdAt:string;expiresAt:string;ownerPid?:number;reason:string;request:unknown;contract:IntentPlan;result?:unknown;}
const active=new Map<string,AbortController>();
const jobFile=(p:LoadedProject,id:string)=>{if(!/^[a-f0-9-]{36}$/.test(id))throw Error('INVALID_RECOVERY_JOB');return path.join(p.root,'motion/harness/recovery/jobs',id+'.json');};
export async function recoveryJobs(p:LoadedProject):Promise<RecoveryJob[]>{
 const dir=path.join(p.root,'motion/harness/recovery/jobs');
 let names:string[];try{await noSymlinkPath(p.root,dir);names=await readdir(dir);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
 const rows:RecoveryJob[]=[];for(const n of names.filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).slice(-200)){const f=path.join(dir,n);await noSymlinkPath(p.root,f);const row=JSON.parse(await readFile(f,'utf8'));if(row.version==='deferred-recovery/1')rows.push(row);}return rows;
}
export async function deferRecovery(p:LoadedProject,runId:string,revision:string,request:unknown,contract:IntentPlan,reason:string){
 await safeDirectory(p.root,'motion/harness/recovery/jobs');
 const file=jobFile(p,runId);try{await noSymlinkPath(p.root,file);return JSON.parse(await readFile(file,'utf8')) as RecoveryJob;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const job:RecoveryJob={version:'deferred-recovery/1',id:runId,originalRunId:runId,replayRunId:randomUUID(),revision,fingerprint:p.inspection.fingerprint,status:'PENDING',attempts:0,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),reason,request,contract};
 await atomicJson(file,job);return job;
}
export async function cancelRecovery(p:LoadedProject,id:string){const file=jobFile(p,id);await noSymlinkPath(p.root,file);const job:RecoveryJob=JSON.parse(await readFile(file,'utf8'));active.get(file)?.abort(Error('CANCELLED'));if(['PENDING','RUNNING'].includes(job.status)){job.status='CANCELLED';job.reason='User cancelled deferred recovery';await atomicJson(file,job);}return job;}
export async function drainRecoveries(p:LoadedProject,execute:(job:RecoveryJob,signal:AbortSignal)=>Promise<unknown>){
 for(const job of await recoveryJobs(p)){
  const file=jobFile(p,job.id);if(active.has(file)||!['PENDING','RUNNING'].includes(job.status))continue;
  if(job.status==='RUNNING'&&job.ownerPid){try{process.kill(job.ownerPid,0);continue;}catch{/* Previous server died; verify actual committed state before resuming. */}}
  const controller=new AbortController();active.set(file,controller);
  try{
   const doc=await readMotion(p);
   if(doc.history.slice(0,doc.cursor).some(h=>h.request.startsWith('['+job.replayRunId+'/'))){job.status='COMPLETED';job.reason='Recovered committed transaction after interruption';}
   else if(doc.revision!==job.revision||p.inspection.fingerprint!==job.fingerprint){job.status='STALE';job.reason='Project/source changed; automatic replay cannot overwrite user edits';}
   else if(job.attempts>=2||Date.now()>Date.parse(job.expiresAt)){job.status='FAILED';job.reason='Deferred recovery resource/expiry limit';}
   else{
    job.status='RUNNING';job.ownerPid=process.pid;job.attempts++;await atomicJson(file,job);
    job.result=await execute(job,controller.signal);if((job.result as {status?:string})?.status!=='SUCCESS')throw Error('DEFERRED_RECOVERY_NOT_VERIFIED');job.status='COMPLETED';job.reason='Original contract executed and verified';
   }
  }catch(error){job.status=controller.signal.aborted?'CANCELLED':'FAILED';job.reason=String(error);}
  finally{
   delete job.ownerPid;await atomicJson(file,job);active.delete(file);
   try{const original=path.join(p.root,'motion/ai',job.originalRunId,'global-recovery.json');await noSymlinkPath(p.root,original);const ledger=JSON.parse(await readFile(original,'utf8'));await atomicJson(original,{...ledger,status:job.status==='COMPLETED'?'RECOVERY_SUCCEEDED':job.status==='PENDING'||job.status==='RUNNING'?'RECOVERY_DEFERRED':'RECOVERY_BLOCKED',finalReason:job.reason,deferredJob:{id:job.id,replayRunId:job.replayRunId,status:job.status},...(job.status==='COMPLETED'?{verifiedResult:job.result}:{})});}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')console.warn('Recovery job ledger:',String(e));}
  }
 }
}
