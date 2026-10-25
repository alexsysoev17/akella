import {createHash} from 'node:crypto';
import {redactSecrets} from '../security.js';
import {recoveryFailure,type RecoveryFailure} from './failure.js';
export type Strategy='deterministic'|'project'|'code';
export type SupervisorStatus='RECOVERY_NOT_NEEDED'|'RECOVERY_ATTEMPTED'|'RECOVERY_SUCCEEDED'|'RECOVERY_EXHAUSTED'|'RECOVERY_BLOCKED'|'PATCH_AWAITING_APPROVAL'|'RECOVERY_DEFERRED';
export interface FailureEvent {
 id:string;rootEventId:string;parentEventId:string|null;stage:string;errorCode:string;rootCause:string;failureCategory:string;projectRevision:string;
 originalUserRequest:string;affectedRequirements:string[];relevantObjectIds:string[];attemptedOperations:unknown[];
 validationEvidence:unknown[];failureFingerprint:string;previousRecoveryAttempts:number;availableResources:unknown;executionTrace:unknown[];
 failure:RecoveryFailure;
}
export interface RecoveryAction<T=unknown>{strategy:Strategy;procedure:string;reason:string;run:(signal:AbortSignal)=>Promise<T>;verify:(value:T)=>Promise<unknown>;}
export interface SupervisorReport {
 version:'global-recovery/1';status:SupervisorStatus;events:FailureEvent[];originalFailure?:FailureEvent;
 attempts:{eventId:string;strategy:Strategy;procedure:string;reason:string;status:string;durationMs:number;validation?:unknown;failure?:string}[];
 decisions:{eventId:string;strategy:Strategy|'external';disposition:string;reason:string}[];
 codeRepair?:unknown;finalReason:string|null;verifiedResult:unknown;
}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function diagnoseFailure(event:FailureEvent){
 const f=event.failure,code=f.code;
 const external=/CANCEL|AUTH|CREDENTIAL|RATE_LIMIT|OVERLOADED|UNAVAILABLE|PROVIDER_TIMEOUT|PROVIDER_TRANSPORT_ERROR|EXECUTION_TIMEOUT|ECONN|ENOTFOUND|ENOSPC|EACCES|EPERM|OS_SANDBOX_UNAVAILABLE|STALE_PROJECT_REVISION|RECOVERY_DEPENDENT_DELETE_NOT_AUTHORIZED/.test(code)||/not logged in|unauthorized|authentication required|operation.*aborted.*timeout|operation.*timed out/i.test(f.invariant);
 const mandatoryOverflow=event.validationEvidence.some(v=>v&&typeof v==='object'&&typeof (v as {mandatoryBytes?:number}).mandatoryBytes==='number'&&Number((v as {mandatoryBytes:number}).mandatoryBytes)>Number((v as {budgetBytes?:number}).budgetBytes));
 if(code==='CONTEXT_EXHAUSTED'&&mandatoryOverflow)return {kind:'external' as const,reason:'Mandatory prompt/instructions/schema exceed configured capacity even without project context; safe packing cannot remove user requirements.'};
 const identityAmbiguity=/AMBIGUOUS_TARGET|AMBIGUOUS_CONTEXTUAL_REFERENCE|AMBIGUOUS_STRUCTURED_MENTION/.test(code);
 if(external||identityAmbiguity)return {kind:'external' as const,reason:identityAmbiguity?'Multiple authoritative identities remain; selecting one would change user scope.':`External condition ${code}; no source change can safely manufacture credentials, access, disk space or user consent.`};
 const stack=event.validationEvidence.map(v=>JSON.stringify(v)).join(' ');
 const sourceEvidence=/apps[\\/]scene-validator[\\/]src[\\/]|VALIDATOR_SCOPE_CONTRADICTION|COMPILER_COVERAGE|CONTEXT_PACKING_INVARIANT|PROVIDER_SCHEMA_INVALID|INTERNAL|ASSERTION/.test(stack+' '+f.invariant+' '+code);
 return {kind:'internal' as const,reason:sourceEvidence?'Source/validator/invariant evidence supports isolated implementation investigation if stage recovery fails.':'Unverified internal failure; investigate the contract and available source evidence, do not assume a source defect.',sourceEvidence};
}
/** One ledger/strategy runner around existing recovery handlers, never a second motion executor. */
export class GlobalFailureSupervisor {
 readonly report:SupervisorReport={version:'global-recovery/1',status:'RECOVERY_NOT_NEEDED',events:[],attempts:[],decisions:[],finalReason:null,verifiedResult:null};
 private started:number|undefined;
 private seen=new Set<string>();
 private terminalInvestigations=new Set<string>();
 private busy=false;
 private sequence=0;
 private activeParent:string|undefined;
 private persistenceFailure:string|null=null;
 constructor(private options:{request:string;revision:string;maxAttempts:number;maxDurationMs:number;signal?:AbortSignal;persist:(report:SupervisorReport)=>Promise<void>;resources?:()=>unknown;trace?:()=>unknown[];reserveSourceAttempt?:boolean;known?:(fingerprint:string)=>Promise<unknown[]>}){}
 setRequest(request:string){this.options.request=request;}
 setRevision(revision:string){this.options.revision=revision;}
 async observe(error:unknown,stage:string,detail:{requirements?:string[];objects?:string[];operations?:unknown[];evidence?:unknown[];parentEventId?:string}={}){
  const failure=recoveryFailure(error,stage,this.options.revision);
  const rootCause=redactSecrets(failure.invariant);
  const fingerprint=hash([stage,failure.code,rootCause.replace(/[a-f0-9]{8}-[a-f0-9-]{27}/gi,'<id>'),detail.requirements??[],detail.objects??[]]);
  let knownVerifiedRecipes:unknown[]=[];const evidence=[...failure.evidence,...detail.evidence??[]];
  try{knownVerifiedRecipes=await this.options.known?.(fingerprint)??[];}catch(error){evidence.push({source:'experience-lookup',detail:redactSecrets(String(error))});}
  const id='failure_'+this.sequence++;
  const parent=this.report.events.find(e=>e.id===(detail.parentEventId??this.activeParent));
  const event:FailureEvent={id,rootEventId:parent?.rootEventId??id,parentEventId:parent?.id??null,stage,errorCode:failure.code,rootCause,failureCategory:failure.category,projectRevision:this.options.revision,originalUserRequest:this.options.request,affectedRequirements:detail.requirements??[],relevantObjectIds:detail.objects??[],attemptedOperations:detail.operations??[],validationEvidence:evidence,failureFingerprint:fingerprint,previousRecoveryAttempts:this.report.attempts.length,availableResources:{current:this.options.resources?.()??{},knownVerifiedRecipes},executionTrace:this.options.trace?.().slice(-12)??[],failure};
  if(!parent&&stage!=="context-admission"&&!this.report.originalFailure)this.report.originalFailure=structuredClone(event);
  this.report.events.push(event);if(this.report.events.length>100){const removable=this.report.events.findIndex(e=>e.id!==this.report.originalFailure?.id&&e.id!==event.rootEventId&&e.id!==event.id&&!this.report.events.some(child=>child.parentEventId===e.id));this.report.events.splice(removable>=0?removable:1,1);}
  this.report.status='RECOVERY_ATTEMPTED';this.started??=performance.now();
  await this.save();return event;
 }
 private async save(){
  if(this.persistenceFailure)return;
  try{await this.options.persist(structuredClone(this.report));}
  catch(error){
   this.persistenceFailure=redactSecrets(String(error));
   this.report.status='RECOVERY_BLOCKED';
   this.report.finalReason='Recovery ledger could not be persisted; further repair actions blocked: '+this.persistenceFailure;
   this.report.decisions.push({eventId:this.report.events.at(-1)?.id??'storage',strategy:'external',disposition:'BLOCKED',reason:this.report.finalReason});
  }
 }
 async attempt<T>(event:FailureEvent,action:RecoveryAction<T>):Promise<{ok:true;value:T}|{ok:false;error:unknown}>{
  const key=event.failureFingerprint+':'+action.strategy+':'+action.procedure;
  const blocked=this.persistenceFailure?'Recovery ledger unavailable; no unrecorded repair allowed':this.options.signal?.aborted?'User cancelled recovery':this.report.attempts.length>=this.options.maxAttempts-(action.strategy!=='code'&&this.options.reserveSourceAttempt?1:0)?'Global recovery attempt budget exhausted (source-investigation reserve preserved)':performance.now()-(this.started??performance.now())>this.options.maxDurationMs?'Global recovery duration exhausted':this.seen.has(key)?'Identical failure and strategy already attempted without progress':null;
  if(blocked){this.report.decisions.push({eventId:event.id,strategy:action.strategy,disposition:'SKIPPED',reason:blocked});await this.save();return {ok:false,error:Error(blocked)};}
  this.seen.add(key);const row={eventId:event.id,strategy:action.strategy,procedure:action.procedure,reason:action.reason,status:'RUNNING',durationMs:0,validation:undefined as unknown,failure:undefined as string|undefined};this.report.attempts.push(row);await this.save();if(this.persistenceFailure){row.status='BLOCKED';return {ok:false,error:Error(this.report.finalReason!)};}const start=performance.now();
  const previousParent=this.activeParent;this.activeParent=event.id;
  try{
   const remaining=Math.max(1,Math.floor(this.options.maxDurationMs-(performance.now()-(this.started??performance.now()))));
   const signal=AbortSignal.any([this.options.signal??new AbortController().signal,AbortSignal.timeout(remaining)]);
   const bounded=async<U>(work:Promise<U>):Promise<U>=>new Promise((resolve,reject)=>{const stop=()=>reject(signal.reason??Error('RECOVERY_TIMEOUT'));signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop));});
   const value=await bounded(action.run(signal));row.validation=await bounded(action.verify(value));
   const status=(row.validation as {status?:string})?.status;
   if(!['PASSED','PATCH_VERIFIED','NO_VERIFIED_PATCH','CANDIDATE'].includes(status??''))throw Error('RECOVERY_VERIFICATION_REQUIRED');
   row.status=status==='CANDIDATE'?'CANDIDATE_PENDING_EXECUTION_QA':status==='NO_VERIFIED_PATCH'?'DIAGNOSED_NO_PATCH':'VERIFIED_STAGE';return {ok:true,value};
  }
  catch(error){row.status='FAILED';row.failure=String(error);await this.observe(error,action.strategy==='code'?'code-repair':action.strategy==='project'?'project-recovery':'deterministic-recovery',{parentEventId:event.id,evidence:[{parentFailure:event.id,procedure:action.procedure}]});return {ok:false,error};}
  finally{this.activeParent=previousParent;row.durationMs=performance.now()-start;await this.save();}
 }
 /** Terminal escalation after existing stage repair has been tried. Always diagnoses, even with no hook/resources. */
 async settle(error:unknown,stage:string,hooks:{deterministic?:RecoveryAction;project?:RecoveryAction;code?:RecoveryAction;codeEnabled?:boolean}={},detail:Parameters<GlobalFailureSupervisor['observe']>[2]={}){
  if(this.busy)return this.report;
  const event=await this.observe(error,stage,detail);
  const root=(this.report.events.find(e=>e.id===event.rootEventId)??(this.report.originalFailure?.id===event.rootEventId?this.report.originalFailure:undefined))??event;
  const diagnosis=diagnoseFailure(root);
  if(this.persistenceFailure)return this.report;
  if(this.terminalInvestigations.has(event.failureFingerprint)){this.report.finalReason='Identical terminal failure already investigated';await this.save();return this.report;}
  this.terminalInvestigations.add(event.failureFingerprint);this.busy=true;
  try{
   if(diagnosis.kind==='external'||this.options.signal?.aborted||event.errorCode==='RECOVERY_DEPENDENT_DELETE_NOT_AUTHORIZED'){this.report.decisions.push({eventId:event.id,strategy:'external',disposition:'BLOCKED',reason:event.errorCode==='RECOVERY_DEPENDENT_DELETE_NOT_AUTHORIZED'?diagnoseFailure(event).reason:diagnosis.reason});this.report.status='RECOVERY_BLOCKED';this.report.finalReason=event.errorCode==='RECOVERY_DEPENDENT_DELETE_NOT_AUTHORIZED'?diagnoseFailure(event).reason:diagnosis.reason;return this.report;}
   for(const strategy of ['deterministic','project','code'] as const){
    const action=hooks[strategy];
    if(!action||(strategy==='code'&&hooks.codeEnabled===false)){this.report.decisions.push({eventId:event.id,strategy,disposition:'UNAVAILABLE',reason:strategy==='code'&&hooks.codeEnabled===false?'Code investigation disabled in project configuration':`No safe ${strategy} transformation is established for this stage; preserving original request and state`});continue;}
    const outcome=await this.attempt(event,action);
    if(this.persistenceFailure)return this.report;
    if(!outcome.ok){const latest=this.report.events.at(-1);if(latest&&diagnoseFailure(latest).kind==='external'&&(!hooks.code||action.strategy==='code'||/CANCEL|AUTH|PROVIDER_TIMEOUT|PROVIDER_TRANSPORT|UNAVAILABLE|ENOSPC|EACCES/.test(latest.errorCode))){const reason=diagnoseFailure(latest).reason;this.report.status='RECOVERY_BLOCKED';this.report.finalReason=reason;this.report.decisions.push({eventId:latest.id,strategy:'external',disposition:'BLOCKED',reason});return this.report;}}
    if(outcome.ok){
     if(strategy==='code'){
      this.report.codeRepair=outcome.value;const status=(outcome.value as {status?:string})?.status;
      this.report.status=status==='AWAITING_APPROVAL'?'PATCH_AWAITING_APPROVAL':'RECOVERY_EXHAUSTED';this.report.finalReason=status==='AWAITING_APPROVAL'?'Regression-tested isolated patch awaits explicit human approval; application code unchanged':`Code investigation completed with ${status??'no verified patch'}`;
     }else{this.report.status='RECOVERY_ATTEMPTED';this.report.finalReason='Stage recovered and validated; full execution/reconciliation still required';}
     return this.report;
    }
   }
   this.report.status='RECOVERY_EXHAUSTED';this.report.finalReason='Applicable recovery strategies failed or no safe transformation/resources remain; see decisions and validation evidence';return this.report;
  }finally{this.busy=false;await this.save();}
 }
 async defer(jobId:string){this.report.status='RECOVERY_DEFERRED';this.report.finalReason='Durable continuation queued with bounded fresh execution resources: '+jobId;await this.save();}
 async complete(verified:boolean,evidence?:unknown){
  if(this.persistenceFailure)return;
  if(!this.report.events.length){this.report.status='RECOVERY_NOT_NEEDED';this.report.finalReason='No failure observed';}
  else if(verified){if((evidence as {status?:string})?.status!=='SUCCESS')throw Error('RECOVERY_VERIFICATION_REQUIRED');this.report.status='RECOVERY_SUCCEEDED';this.report.finalReason='Execution, QA and final reconciliation verified';this.report.verifiedResult=evidence;}
  else if(this.report.status==='RECOVERY_ATTEMPTED'){this.report.status='RECOVERY_EXHAUSTED';this.report.finalReason='Full verified result was not obtained';}
  await this.save();
 }
}
