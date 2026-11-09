import test from 'node:test';
import assert from 'node:assert/strict';
import {identityFixture,node} from './identity-fixture.js';
import {objectRequirement} from './intent-fixture.js';
import {inspectSemanticCoverage,assertCoverageScope} from '../src/motion/intent/coverage.js';
import {intentPlanSchema} from '../src/motion/intent/schema.js';
import {semanticContext} from '../src/harness/semantic-context.js';
import {saveExperience,experienceSearch} from '../src/harness/experience.js';
import {collectImprovements,candidates} from '../src/harness/improvements.js';
import {transportErrorCode} from '../src/harness/providers/types.js';
import {recoveryFailure} from '../src/harness/recovery/failure.js';
import {animationSchema} from '../src/motion/schema.js';
import {evaluateAnimation} from '../src/motion/evaluation.js';
import {randomUUID} from 'node:crypto';
test('lateral/scale clauses consume their own targets; following Trim Paths never inherits QR/logo',async()=>{
 const f=await identityFixture(2,s=>{s[1].children=['куар','лого','лента 1','лента 2'].map((n,i)=>node('n'+i,n));});
 try{
 const clauses=['куар появляется справа на лево,','лого появляются по скейлу из нуля к ста процентам,','лента 2 и лента 1 рисуется по очереди первая будет лента 1'];
 const request=clauses.join('');
 const rs=[objectRequirement('q','s1','n0','куар',['slideLeft'],clauses[0]),objectRequirement('l','s1','n1','лого',['scaleIn'],clauses[1]),objectRequirement('a','s1','n2','лента 1',['trimPath'],clauses[2]),objectRequirement('b','s1','n3','лента 2',['trimPath'],clauses[2])];
 rs[1].parameters.scaleFrom=0;rs[3].timing.relation='afterRequirement';rs[3].timing.anchorRequirementId='a';
 let offset=0;const sourceClauses=clauses.map((text,i)=>{const c={clauseId:'c'+i,text,start:offset,end:offset+text.length};offset=c.end;return c;});rs.forEach((r,i)=>r.sourceClauseId='c'+Math.min(i,2));
 const plan=intentPlanSchema.parse({schemaVersion:'1.0.0',requirements:rs,sourceClauses,coverage:clauses.map((sourceText,i)=>({sourceText,requirementIds:i===2?['a','b']:[rs[i].requirementId],classification:'executable',explanation:'fixture'})),assumptions:[]});
 assert.deepEqual(inspectSemanticCoverage(f.project,request,plan).issues,[]);
 const missing=structuredClone(plan);missing.requirements=missing.requirements.filter(r=>r.requirementId!=='b');assert.ok(inspectSemanticCoverage(f.project,request,missing).issues.some(i=>i.code==='MISSING_OBJECT_REQUIREMENT'));
 const bogus={status:'SUSPICIOUS' as const,clauses:[],issues:[{code:'MISSING_OBJECT_REQUIREMENT',sourceText:clauses[2],requirementIds:[],expected:{target:'s1/n0',techniques:['trimPath']}}]};
 assert.throws(()=>assertCoverageScope(f.project,request,plan,bogus),/VALIDATOR_SCOPE_CONTRADICTION/);
 }finally{await f.cleanup();}
});
test('exact scale zero is represented, evaluated and never replaced with epsilon',()=>{
 const a=animationSchema.parse({animationId:'a',sceneId:'s',targetId:'o',effect:'scaleIn',parameters:{from:0,to:1},startFrame:0,durationFrames:30,easing:'linear',enabled:true});assert.equal(evaluateAnimation(a,0).scale,0);assert.equal(evaluateAnimation(a,15).scale,.5);assert.equal(evaluateAnimation(a,30).scale,1);
});
test('retrieved experience survives both provider projections; bounded candidates do not apply themselves',async()=>{
 const f=await identityFixture();try{
 for(let i=0;i<2;i++)await saveExperience(f.project.root,{runId:randomUUID(),createdAt:new Date().toISOString(),status:'FAILED',request:'scale and trim',techniques:['trimPath'],failures:['SEMANTIC_COVERAGE'],repairs:0,objectiveQA:'NOT_TESTED',artisticQuality:'NOT_TESTED',versions:[]});
 const experience=await experienceSearch(f.project.root,'trim',['trimPath']);
 for(const contextualEditHint of [false,true])assert.equal((semanticContext({experience,contextualEditHint}) as {experience:unknown[]}).experience.length,2);
 assert.equal((await collectImprovements(f.project.root)).length,1);assert.equal((await collectImprovements(f.project.root)).length,0);assert.equal((await candidates(f.project.root))[0].status,'PROPOSED');
 }finally{await f.cleanup();}
});
test('truncation is distinct from transport and a proven validator defect is code-repair eligible',()=>{
 assert.equal(transportErrorCode(Error('Incomplete response returned, reason: max_output_tokens')),'OUTPUT_TRUNCATED');
 const truncated=recoveryFailure({code:'OUTPUT_TRUNCATED'},'semantic-repair','r');assert.equal(truncated.category,'PROVIDER_OUTPUT_LIMIT');assert.equal(truncated.codeRepairEligible,false);
 assert.equal(recoveryFailure({code:'SEMANTIC_COVERAGE'},'semantic-planning','r').codeRepairEligible,false);
 assert.equal(recoveryFailure({code:'VALIDATOR_SCOPE_CONTRADICTION'},'semantic-planning','r').codeRepairEligible,true);
});

test('authoritative mention overrides active duplicate instance for new animations; unmentioned instances stay untouched',async()=>{
 const f=await identityFixture();try{
  const {validateIntentPlan}=await import('../src/motion/intent/planner.js');const {logicalId}=await import('../src/motion/registry.js');
  const request='QR появляется через fade';const r=objectRequirement('q','s2','qr2','QR',['fadeIn'],request);
  const events:unknown[]=[];
  const plan=validateIntentPlan(f.project,request,{schemaVersion:'1.0.0',requirements:[r],coverage:[{sourceText:request,requirementIds:['q'],classification:'executable',explanation:'fixture'}],assumptions:[]},30,{state:f.state,activeSceneId:'s2',mentions:[{displayName:'QR',logicalObjectId:logicalId('QR'),sceneId:'s1',sourceNodeId:'qr1',start:0,end:2}],onResolution:e=>events.push(e)});
  assert.equal(plan.requirements[0].sceneId,'s1');assert.equal(plan.requirements[0].target.sourceNodeId,'qr1');assert.ok(events.some(e=>(e as {event:string}).event==='STRUCTURED_MENTION_BOUND'));
 }finally{await f.cleanup();}
});

test('output truncation never triggers an identical full semantic retry',async()=>{
 const f=await identityFixture();try{
  const {semanticPlan,semanticFailureCategory}=await import('../src/motion/intent/planner.js');const {ProviderError}=await import('../src/harness/providers/types.js');
  let calls=0;const error=new ProviderError('OUTPUT_TRUNCATED','Incomplete response: max_output_tokens');
  await assert.rejects(()=>semanticPlan(f.project,'QR fade',{}, {interpret:async()=>{calls++;throw error;},audit:async()=>{throw Error('unexpected audit');}},async()=>{}, {maxAttempts:2,auditAlways:false}),e=>e===error);
  assert.equal(calls,1);assert.equal(semanticFailureCategory(error),'PROVIDER_OUTPUT_LIMIT');
 }finally{await f.cleanup();}
});
