/** Human-only source promotion. No Motion Tool or model response can approve a patch. */
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,rm,mkdtemp,copyFile,symlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {atomicJson,noSymlinkPath,safeDirectory,within} from '../../files.js';
import {reviewCodeRepair,codeProposalSchema} from './code-repair.js';
const exec=promisify(execFile),sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const permits=new Map<string,{repository:string;workspace:string;identity:string;expires:number}>();
export let sourcePromotionBusy=false;
/** Trusted parent writes this outside the generated-test sandbox after verification. */
export async function attestCodeRepair(repository:string,workspace:string){
 const report=await reviewCodeRepair(workspace);
 if(report.status!=='AWAITING_APPROVAL')return;
 const dir=await safeDirectory(repository,'data/harness/code-repairs/verified');
 await atomicJson(path.join(dir,report.patchIdentity+'.json'),{workspace,patchIdentity:report.patchIdentity,reportHash:sha(await readFile(path.join(workspace,'report.json'),'utf8')),manifestHash:sha(await readFile(path.join(workspace,'proposal.json'),'utf8'))});
}
async function verified(repository:string,workspace:string,identity:string){
 if(!/^[a-f0-9]{64}$/.test(identity))throw Error('INVALID_PATCH_IDENTITY');
 const file=within(repository,'data/harness/code-repairs/verified/'+identity+'.json');await noSymlinkPath(repository,file);
 const stamp=JSON.parse(await readFile(file,'utf8'));
 if(stamp.workspace!==workspace)throw Error('CODE_REPAIR_WORKSPACE_MISMATCH');
 const report=await reviewCodeRepair(workspace);
 if(report.status!=='AWAITING_APPROVAL'||report.patchIdentity!==identity||stamp.reportHash!==sha(await readFile(path.join(workspace,'report.json'),'utf8'))||stamp.manifestHash!==sha(await readFile(path.join(workspace,'proposal.json'),'utf8')))throw Error('CODE_REPAIR_ATTESTATION_CHANGED');
 return report;
}
export async function reviewForApproval(repository:string,workspace:string,identity:string){
 const report=await verified(repository,workspace,identity);
 for(const [token,v] of permits)if(v.expires<Date.now())permits.delete(token);
 if(permits.size>=32)throw Error('TOO_MANY_PENDING_APPROVALS');
 const approvalToken=randomUUID();permits.set(approvalToken,{repository,workspace,identity,expires:Date.now()+5*60000});
 return {...report,approvalToken,patchText:await readFile(path.join(workspace,'proposal.patch'),'utf8'),expiresInSeconds:300};
}
export async function approveCodeRepair(repository:string,workspace:string,identity:string,approvalToken:string,verifyReplay:(isolatedRepository:string)=>Promise<unknown>){
 const permit=permits.get(approvalToken);permits.delete(approvalToken);
 if(!permit||permit.repository!==repository||permit.workspace!==workspace||permit.identity!==identity||permit.expires<Date.now())throw Error('HUMAN_APPROVAL_REQUIRED');
 if(sourcePromotionBusy)throw Error('CODE_PROMOTION_BUSY');
 sourcePromotionBusy=true;
 let locked=false,changed=false,committed=false;
 const lock=path.join(repository,'.git','akella-promotion.lock');
 let replayRoot:string|undefined;
 const before=new Map<string,string|null>(), applied=new Map<string,string>();
 let paths:string[]=[];
 try{
  await mkdir(lock);locked=true;
  const report=await verified(repository,workspace,identity);
  const git=(args:string[])=>exec('git',args,{cwd:repository,maxBuffer:2e6});
  if((await git(['status','--porcelain'])).stdout.trim())throw Error('CODE_PROMOTION_REQUIRES_CLEAN_TREE');
  if((await git(['rev-parse','HEAD'])).stdout.trim()!==report.baseCommit)throw Error('CODE_PROMOTION_STALE_BASE');
  const saved=JSON.parse(await readFile(path.join(workspace,'proposal.json'),'utf8'));const proposal=codeProposalSchema.parse(saved.proposal);
  paths=proposal.changes.map(c=>c.path);
  for(const c of proposal.changes){
   const file=within(repository,c.path);await noSymlinkPath(repository,path.dirname(file));
   try{await noSymlinkPath(repository,file)}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
   let old:string|null=null;try{old=await readFile(file,'utf8')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
   if(sha(old??'')!==c.beforeHash)throw Error('CODE_PROMOTION_SOURCE_CHANGED');
   before.set(c.path,old);if("content" in c)applied.set(c.path,c.content);
  }
  // Replay against the approved isolated source BEFORE touching the working application.
  // Recreate source from the clean repository; generated tests cannot smuggle
  // unreviewed files from their writable sandbox into the trusted replay.
  replayRoot=await mkdtemp(path.join(os.tmpdir(),'akella-approved-replay-'));
  const tracked=(await git(['ls-files','-z'])).stdout.split('\0').filter(Boolean);
  for(const rel of tracked){
   if(!/^(?:apps\/scene-validator\/(?:src|tests)\/|figma-motion-exporter\/src\/|scripts\/|package(?:-lock)?\.json$|tsconfig(?:\.[a-z]+)?\.json$)/.test(rel))continue;
   const from=within(repository,rel),to=within(replayRoot,rel);await noSymlinkPath(repository,from);await mkdir(path.dirname(to),{recursive:true});await copyFile(from,to);
  }
  await symlink(path.join(repository,'node_modules'),path.join(replayRoot,'node_modules'));
  for(const c of proposal.changes){if(!('content'in c))throw Error('UNMATERIALIZED_PATCH');const file=within(replayRoot,c.path);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,c.content);}
  const replay=await verifyReplay(replayRoot);
  await verified(repository,workspace,identity);
  if((await git(['status','--porcelain'])).stdout.trim() || (await git(['rev-parse','HEAD'])).stdout.trim()!==report.baseCommit)throw Error('CODE_PROMOTION_SOURCE_CHANGED_DURING_REPLAY');
  changed=true;
  for(const c of proposal.changes){if(!('content'in c))throw Error('UNMATERIALIZED_PATCH');await writeFile(within(repository,c.path),c.content,{flag:before.get(c.path)===null?'wx':'w'});}
  // Generated patch code was explicitly reviewed. New tests have already run in confinement.
  // The trusted replay callback must verify the ORIGINAL saved request in a copy, not mutate client data.
  for(const c of proposal.changes){if(!('content'in c)||sha(await readFile(within(repository,c.path),'utf8'))!==sha(c.content))throw Error('CODE_PROMOTION_SOURCE_CHANGED_DURING_REPLAY');}
  const actual=(await git(['status','--porcelain','-uall'])).stdout.trimEnd().split('\n').filter(Boolean).map(l=>l.slice(3));
  if(actual.some(p=>!paths.includes(p)))throw Error('CODE_PROMOTION_UNRELATED_CHANGES');
  await git(['add','--',...paths]);
  await git(['-c','user.name=AKELLA Reviewed Repair','-c','user.email=repair@localhost','commit','-m','Human-approved repair '+identity.slice(0,12)]);committed=true;
  const result={status:'APPLIED',patchIdentity:identity,commit:(await git(['rev-parse','HEAD'])).stdout.trim(),replay,restartRequired:true,originalProjectChanged:false};
  const dir=await safeDirectory(repository,'data/harness/code-repairs/applied');await atomicJson(path.join(dir,identity+'.json'),result);
  return result;
 }catch(error){
  if(changed&&!committed){
   for(const [rel,old] of before){const file=within(repository,rel);const current=await readFile(file,"utf8").catch(()=>null);if(current!==applied.get(rel))continue; /* Preserve concurrent edits. */ if(old===null)await rm(file,{force:true});else await writeFile(file,old);}
   if(paths.length)await exec('git',['restore','--staged','--',...paths],{cwd:repository}).catch(()=>{});
  }
  throw error;
 }finally{if(replayRoot)await rm(replayRoot,{recursive:true,force:true});if(locked)await rm(lock,{recursive:true,force:true});sourcePromotionBusy=false;}
}
