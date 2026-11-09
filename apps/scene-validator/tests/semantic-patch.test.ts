import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {identityFixture,node} from './identity-fixture.js';
import {objectRequirement} from './intent-fixture.js';
import {intentPlanSchema} from '../src/motion/intent/schema.js';
import {inspectSemanticCoverage} from '../src/motion/intent/coverage.js';
import {patchSequentialDependencies} from '../src/motion/intent/semantic-patch.js';
import {validateIntentPlan} from '../src/motion/intent/planner.js';
import {registerProvider} from '../src/harness/providers/index.js';
import {executeMotion} from '../src/motion/service.js';
import {readMotion} from '../src/motion/store.js';
import {renderNativeFrame,closeNativeRenderer} from '../src/native/client.js';
import {exportVideo} from '../src/motion/video.js';
const prompt='на 1 секунде куар увеличивается на 30 процентов а потом встает на место';
function plan(){const a=objectRequirement('a','s0','qr','куар',['scaleIn'],prompt),b=objectRequirement('b','s0','qr','куар',['scaleOut'],prompt);a.timing.startSeconds=1;a.parameters={...a.parameters,scaleFrom:1,scaleTo:1.3,durationSeconds:.5};b.parameters={...b.parameters,scaleFrom:1.3,scaleTo:1,durationSeconds:.5};b.timing={...b.timing,relation:'afterRequirement',anchorRequirementId:'a',align:'end'};return intentPlanSchema.parse({schemaVersion:'1.0.0',requirements:[a,b],coverage:[{sourceText:prompt,requirementIds:['a','b'],classification:'executable',explanation:'two phases'}],assumptions:[]});}
test('local temporal patch preserves every field except proven dependency and is idempotent',async()=>{const f=await identityFixture(1,s=>s[0].children=[node('qr','куар',40,40)]);try{const p=plan(),before=structuredClone(p),report=inspectSemanticCoverage(f.project,prompt,p);assert.equal(report.issues[0].code,'MISSING_SEQUENTIAL_DEPENDENCY');assert.equal(patchSequentialDependencies(p,prompt,report).length,1);before.requirements[1].timing.align='start';assert.deepEqual(p,before);assert.equal(inspectSemanticCoverage(f.project,prompt,p).status,'PASSED');assert.equal(patchSequentialDependencies(p,prompt,inspectSemanticCoverage(f.project,prompt,p)).length,0);validateIntentPlan(f.project,prompt,p);}finally{await f.cleanup();}});
test('unsafe absolute timing, negative delay, cycle, different target, constraints and wrong anchor are never repaired',async()=>{const f=await identityFixture(1,s=>s[0].children=[node('qr','куар',40,40)]);try{for(const mutate of [(p:ReturnType<typeof plan>)=>{p.requirements[1].timing.startSeconds=1.2;},(p:ReturnType<typeof plan>)=>{p.requirements[1].timing.delaySeconds=-.1;},(p:ReturnType<typeof plan>)=>{p.requirements[0].timing.anchorRequirementId='b';},(p:ReturnType<typeof plan>)=>{p.requirements[1].target.sourceNodeId='other';},(p:ReturnType<typeof plan>)=>{p.requirements[1].constraints=['at same time'];},(p:ReturnType<typeof plan>)=>{p.requirements[1].timing.anchorRequirementId='unknown';}]){const p=plan(),report=inspectSemanticCoverage(f.project,prompt,p);mutate(p);const before=structuredClone(p);assert.equal(patchSequentialDependencies(p,prompt,report).length,0);assert.deepEqual(p,before);}}finally{await f.cleanup();}});
for(const returnEffect of ['scaleIn','scaleOut'] as const)test('production '+returnEffect+' two-stage QR: coverage failure → local patch → preflight → commit/QA → native preview and FFmpeg',async()=>{
 process.env.AKELLA_RENDERER='native';const f=await identityFixture(1,s=>s[0].children=[node('qr','куар',40,40,24,24)]);let calls=0;
 const stop=registerProvider('semantic-patch-fixture',()=>({id:'semantic-patch-fixture',mode:'mock',capabilities:()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false}),generate:async()=>{calls++;return {output:(()=>{const p=plan();p.requirements[1].techniques=[returnEffect];return p;})(),usage:null,estimatedCost:null,latencyMs:0,diagnostics:[],toolCalls:[]};}}));
 try{const before=await readMotion(f.project);const result=await executeMotion(f.project,{mode:'edit',request:prompt,expectedRevision:before.revision,settings:{provider:'semantic-patch-fixture',model:''}},()=>{},{config:{maxLLMCalls:1}});assert.equal(result.reconciliation?.status,'SUCCESS',JSON.stringify(result));assert.equal(calls,1);const after=await readMotion(f.project);const tracks=after.state.animations.filter(a=>a.targetId==='qr');assert.equal(tracks.length,2);assert.equal(tracks[1].startFrame,tracks[0].startFrame+tracks[0].durationFrames);
 const first=await renderNativeFrame(f.project,after.state,tracks[0].startFrame,{encoding:'rgba'}),peak=await renderNativeFrame(f.project,after.state,tracks[1].startFrame,{encoding:'rgba'});assert.notDeepEqual(first.png,peak.png);const lastFrame=after.state.settings.durationFrames-1,last=await renderNativeFrame(f.project,after.state,lastFrame,{encoding:'rgba'});assert.deepEqual(first.png,last.png);const video=await exportVideo(f.project.root,()=>{},{renderer:'native'});assert.ok('frameDigests' in video);assert.equal(video.frameDigests.find(d=>d.frame===lastFrame)?.sha256,createHash('sha256').update(last.png).digest('hex'));
 }finally{stop();await closeNativeRenderer();await f.cleanup();}
});

test('valid afterRequirement align=start is not a missing dependency (saved-run semantics)',async()=>{const f=await identityFixture(1,s=>s[0].children=[node('qr','куар',40,40)]);try{const p=plan();p.requirements[1].timing.align='start';const before=structuredClone(p);assert.equal(inspectSemanticCoverage(f.project,prompt,p).status,'PASSED');assert.equal(patchSequentialDependencies(p,prompt,inspectSemanticCoverage(f.project,prompt,p)).length,0);assert.deepEqual(p,before);}finally{await f.cleanup();}});
test('compact temporal delta keeps full-plan writes off the provider wire and preserves unrelated requirements',async()=>{
 const {semanticRepairSchema,mergeCompactRepair,targetedRepairSchema}=await import('../src/motion/intent/repair.js');const {z}=await import('zod');
 const p=plan(),issues=[{code:'MISSING_SEQUENTIAL_DEPENDENCY',sourceText:prompt,requirementIds:['b']}];const schema=semanticRepairSchema(issues);
 const delta={updates:[{requirementId:'b',changes:[{field:'timing',value:{...p.requirements[1].timing,align:'start'}}]}]};
 assert.ok(schema.safeParse(delta).success);assert.ok(!schema.safeParse({requirements:p.requirements,coverageRows:p.coverage}).success);
 assert.ok(JSON.stringify(z.toJSONSchema(schema)).length<JSON.stringify(z.toJSONSchema(targetedRepairSchema)).length/2);
 const merged=mergeCompactRepair(p,delta,issues,prompt);assert.deepEqual(merged.requirements[0],p.requirements[0]);assert.deepEqual(merged.coverage,p.coverage);
 assert.throws(()=>mergeCompactRepair(p,{updates:[{...delta.updates[0],requirementId:'a'}]},issues,prompt),/REPAIR_SCOPE/);
});
test('repeated observation is one event; provider repair failures retain semantic root',async()=>{
 const {GlobalFailureSupervisor}=await import('../src/harness/recovery/supervisor.js');const s=new GlobalFailureSupervisor({request:prompt,revision:'r',maxAttempts:4,maxDurationMs:1000,persist:async()=>{}});
 const root=await s.observe(Error('SEMANTIC_COVERAGE: MISSING_SEQUENTIAL_DEPENDENCY'),'semantic-coverage');
 const child=await s.observe(Error('OUTPUT_TRUNCATED'),'semantic-repair');const again=await s.observe(Error('OUTPUT_TRUNCATED'),'semantic-repair');
 assert.equal(again.id,child.id);assert.equal(s.report.events.length,2);assert.equal(child.rootEventId,root.id);assert.equal(s.report.originalFailure?.id,root.id);
});
