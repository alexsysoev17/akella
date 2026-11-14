import {isDeepStrictEqual} from "node:util";
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readFile,cp} from 'node:fs/promises';
import {loadProject} from '../../project.js';
import {readMotion} from '../../motion/store.js';
import {commitChanges} from '../../motion/tool-runtime.js';
import {parsePlan} from '../../motion/schema.js';
import {atomicJson,noSymlinkPath,safeDirectory} from '../../files.js';
/** Publish the already-verified original-request replay, never regenerate or weaken intent.
 * Called only after human-approved source integration. Revision/fingerprint races fail closed. */
export async function resumeVerifiedReplay(projectRoot:string,originalRunId:string,replay:{replayRoot:string;resultFile:string;resultHash:string}){
 if(!/^[a-f0-9-]{36}$/.test(originalRunId)||!/^[a-f0-9]{64}$/.test(replay.resultHash))throw Error('INVALID_REPLAY_RECEIPT');
 await noSymlinkPath(replay.replayRoot,replay.resultFile);
 const raw=await readFile(replay.resultFile);if(createHash('sha256').update(raw).digest('hex')!==replay.resultHash)throw Error('VERIFIED_REPLAY_CHANGED');
 const result=JSON.parse(raw.toString());
 if(result.reconciliation?.status!=='SUCCESS'||!Array.isArray(result.requirements)||!result.requirements.length||result.requirements.some((r:{status:string;qaResult?:{status:string}})=>r.status!=='PASSED'||!['PASSED','WARNING'].includes(r.qaResult?.status??'')))throw Error('REPLAY_NOT_FULLY_VERIFIED');
 const project=await loadProject(projectRoot),current=await readMotion(project);
 try{const file=path.join(projectRoot,'motion/ai',originalRunId,'resume-receipt.json');await noSymlinkPath(projectRoot,file);const prior=JSON.parse(await readFile(file,'utf8'));if(prior.verifiedReplayHash===replay.resultHash&&prior.revision===current.revision)return {...prior,idempotent:true};}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 const requestFile=path.join(projectRoot,'motion/ai',originalRunId,'request.json');await noSymlinkPath(projectRoot,requestFile);const original=JSON.parse(await readFile(requestFile,'utf8'));
 if(current.revision!==original.revision)throw Error('STALE_PROJECT_REVISION: source repaired; current user edits preserved, replay publication blocked');
 if(project.inspection.fingerprint!==original.sourceFingerprint)throw Error('SOURCE_FINGERPRINT_CHANGED');
 const plan=parsePlan(result.plan);
 const candidateFile=path.join(replay.replayRoot,'motion/ai',result.id,'candidate-commit.json');await noSymlinkPath(replay.replayRoot,candidateFile);const candidate=JSON.parse(await readFile(candidateFile,'utf8'));
 if(!Array.isArray(candidate.operationBatches))throw Error('VERIFIED_REPLAY_BATCHES_CHANGED');
 const batches=candidate.operationBatches.map((operations:unknown[])=>parsePlan({...plan,operations}).operations);
 if(!isDeepStrictEqual(batches.flat(),plan.operations))throw Error('VERIFIED_REPLAY_BATCHES_CHANGED');
 const committed=await commitChanges(projectRoot,{expectedRevision:current.revision,expectedSourceFingerprint:project.inspection.fingerprint,operationBatches:batches,expectedCandidate:result.document.state,transactionId:result.id,request:`[${result.id}/run] ${original.request.request}`,origin:'approved-code-recovery',assumptions:plan.assumptions,warnings:plan.warnings});
 const receipt={status:'APPLIED',originalRunId,resumedRunId:result.id,revision:committed.document.revision,sourceFingerprint:project.inspection.fingerprint,reconciliation:result.reconciliation,verifiedReplayHash:replay.resultHash};
 const dir=await safeDirectory(projectRoot,'motion/ai/'+originalRunId);
 await atomicJson(path.join(dir,'resume-receipt.json'),receipt);
 try{const file=path.join(dir,'global-recovery.json');await noSymlinkPath(projectRoot,file);const report=JSON.parse(await readFile(file,'utf8'));await atomicJson(file,{...report,status:'RECOVERY_SUCCEEDED',finalReason:'Human-approved source patch integrated; original verified replay committed',verifiedResult:receipt});}catch{/* Canonical state commit/receipt is authoritative; absent legacy diagnostics cannot undo it. */}
 try{
  for(const segment of ['motion/ai','motion/harness/runs']){
   const source=path.join(replay.replayRoot,segment,result.id);await noSymlinkPath(replay.replayRoot,source);
   const target=path.join(projectRoot,segment,result.id);await safeDirectory(projectRoot,segment);
   await cp(source,target,{recursive:true,force:false,errorOnExist:true});
  }
 }catch(error){return {...receipt,diagnosticWarning:String(error)};}
 return receipt;
}
