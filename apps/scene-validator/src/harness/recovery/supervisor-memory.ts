import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {atomicJson,noSymlinkPath,safeDirectory} from '../../files.js';
import type {SupervisorReport} from './supervisor.js';
interface Case {version:'supervisor-experience/1';fingerprint:string;codeVersion:string;rootCause:string;subsystem:string;strategy:string;procedure:string;validation:unknown;replay:unknown;status:'VERIFIED'|'FAILED'|'PATCH_VERIFIED_AWAITING_APPROVAL';updatedAt:string;}
export async function supervisorExperience(root:string):Promise<Case[]>{
 const file=path.join(root,'motion/harness/recovery/cases.json');
 try{await noSymlinkPath(root,file);const rows=JSON.parse(await readFile(file,'utf8'));if(!Array.isArray(rows))throw Error('INVALID_RECOVERY_EXPERIENCE');return rows.filter(r=>r?.version==='supervisor-experience/1').slice(0,200);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
}
export async function rememberSupervisor(root:string,report:SupervisorReport,codeVersion:string){
 const old=await supervisorExperience(root);const updates:Case[]=[];
 for(const attempt of report.attempts){
  const event=report.events.find(e=>e.id===attempt.eventId);if(!event)continue;
  const verified=report.status==='RECOVERY_SUCCEEDED'&&attempt.status==='VERIFIED_STAGE';
  const patch=report.status==='PATCH_AWAITING_APPROVAL'&&attempt.strategy==='code'&&attempt.status==='VERIFIED_STAGE';
  updates.push({version:'supervisor-experience/1',fingerprint:event.failureFingerprint,codeVersion,rootCause:event.rootCause.slice(0,2000),subsystem:event.stage,strategy:attempt.strategy,procedure:attempt.procedure,validation:attempt.validation??{status:'NOT_VERIFIED'},replay:verified?report.verifiedResult:{status:patch?'PATCH_TESTED_ONLY':'NOT_VERIFIED'},status:verified?'VERIFIED':patch?'PATCH_VERIFIED_AWAITING_APPROVAL':'FAILED',updatedAt:new Date().toISOString()});
 }
 if(!updates.length)return;
 const merged=[...updates,...old].filter((r,i,all)=>all.findIndex(x=>x.fingerprint===r.fingerprint&&x.procedure===r.procedure&&x.codeVersion===r.codeVersion)===i).slice(0,200);
 const dir=await safeDirectory(root,'motion/harness/recovery');await atomicJson(path.join(dir,'cases.json'),merged);
}
