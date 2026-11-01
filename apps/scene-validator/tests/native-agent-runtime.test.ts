import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { identityFixture, node } from './identity-fixture.js';
import { readMotion, changeMotion } from '../src/motion/store.js';
import { executeMotion } from '../src/motion/service.js';
import { registerProvider } from '../src/harness/providers/index.js';
import { WorkingRevision } from '../src/motion/working-revision.js';
import { evaluateProgram, programSchema } from '../src/motion-library/expressions/program.js';
import { evaluateMotion } from '../src/motion/evaluation.js';
import { statePresentation } from '../src/motion/transitions.js';
import { renderNativeFrame, closeNativeRenderer } from '../src/native/client.js';
import { exportVideo } from '../src/motion/video.js';
import { logicalId } from '../src/motion/registry.js';
after(() => closeNativeRenderer());
const call = (tool: string, args: unknown, id = randomUUID()) => ({ tool, argumentsJson: JSON.stringify(args), callId: id });
const answer = (calls: unknown[]) => ({ calls, disposition: 'CONTINUE', message: 'Изменения проверены', assumptions: [] });
async function fixture() { const f = await identityFixture(1, s => { s[0].children = [1, 2, 3].map(i => node('star' + i, 'звезда ' + i, 30 * i, 30, 16, 16)); }); let d = await readMotion(f.project); d = (await changeMotion(f.project.root, { expectedRevision: d.revision, request: 'setup', operations: [{ type: 'setProjectSettings', settings: { ...d.state.settings, width: 160, height: 100, fps: 30, durationFrames: 90 } }, { type: 'setBlocks', blocks: d.state.blocks.map(b => ({ ...b, startFrame: 0, durationFrames: 90 })) }, ...[1, 2, 3].map(i => ({ type: 'addAnimation', animation: { animationId: 'in' + i, sceneId: 's0', targetId: 'star' + i, startFrame: 0, durationFrames: 20, effect: 'slideUp', parameters: { distance: 25, mode: 'in' }, easing: 'linear', enabled: true } })), ...[1, 2, 3].map(i => ({ type: 'setExpression', expression: { expressionId: 'spin' + i, type: 'wiggle', sceneId: 's0', targetId: 'star' + i, property: 'rotation', startFrame: 0, durationFrames: 90, enabled: true, parameters: { amplitude: 3, frequency: 1, seed: i, temporalMode: 'continuous' } } }))] })).document; return { ...f, doc: d }; }
function provider(fn: (n: number, r: any) => unknown) { let calls = 0; const id = 'agent-fixture-' + randomUUID().slice(0, 8), stop = registerProvider(id, () => ({ id, mode: 'mock', capabilities: () => ({ structuredOutput: true, nativeToolCalling: false, cancellation: true, usage: false, nativeOutputTokenLimit: false }), generate: async (r) => ({ output: await fn(++calls, r), usage: null, estimatedCost: null, latencyMs: 0, diagnostics: ['mock understanding; real runtime/tools/render/storage'], toolCalls: [] }) })); return { id, stop, calls: () => calls }; }
async function run(f: Awaited<ReturnType<typeof fixture>>, p: ReturnType<typeof provider>, request: string, maxLLMCalls = 3) { return executeMotion(f.project, { editId: randomUUID(), mode: 'edit', request, expectedRevision: (await readMotion(f.project)).revision, settings: { provider: p.id, model: '' } }, () => { }, { executionRuntime: 'agent', config: { maxLLMCalls, maxRepairAttempts: 0 } }); }
const targets = [1, 2, 3].map(i => logicalId('звезда ' + i));
test('agent inspects three targets, removes actual rotation, adds positional wiggle, renders, checks final state and commits once with Undo/Redo', async () => { const f = await fixture(), request = 'Добавь wiggle звёздам 1, 2, 3 и убери вращение'; const p = provider(n => n === 1 ? answer([call('listObjects', {}), call('describeTool', { kind: 'check' })]) : n === 2 ? answer(targets.map(logicalObjectId => call('inspectAnimations', { logicalObjectId }))) : answer([call('defineChecks', { targets, checks: [...[1, 2, 3].map(i => ({ checkId: 'remove' + i, sourceText: request, assertion: { kind: 'absent', entity: 'expression', id: 'spin' + i } })), ...[1, 2, 3].map(i => ({ checkId: 'position' + i, sourceText: request, assertion: { kind: 'motionVaries', sceneId: 's0', targetId: 'star' + i, property: 'x', frames: [30, 40, 50, 60], minimumRange: .01 } })), { checkId: 'preserve', sourceText: request, assertion: { kind: 'basePreserved', animationIds: ['in1', 'in2', 'in3'] } }] }), call('applyEdit', { operations: [...[1, 2, 3].map(i => ({ type: 'removeExpression', expressionId: 'spin' + i })), ...[1, 2, 3].flatMap(i => ['x', 'y'].map(property => ({ type: 'setExpression', expression: { expressionId: property + i, type: 'wiggle', sceneId: 's0', targetId: 'star' + i, property, startFrame: 0, durationFrames: 90, enabled: true, parameters: { amplitude: 4, frequency: 1, seed: i, temporalMode: 'continuous' } } })))] }), call('renderFrame', { frames: [30, 40] }), call('runFocusedQA', {}), call('commitRevision', {})])); try {
    const source = await readFile(f.project.scenePath), r = await run(f, p, request);
    assert.equal(r.status, 'applied');
    assert.equal(p.calls(), 3);
    let d = await readMotion(f.project);
    assert.equal(d.history.length, f.doc.history.length + 1);
    assert.deepEqual(d.state.animations, f.doc.state.animations);
    assert.equal(d.state.expressions?.length, 6);
    assert.ok(d.state.expressions?.every(e => ['x', 'y'].includes(e.property)));
    assert.deepEqual(await readFile(f.project.scenePath), source);
    await changeMotion(f.project.root, { expectedRevision: d.revision, request: 'undo', action: 'undo' });
    d = await readMotion(f.project);
    assert.deepEqual(d.state, f.doc.state);
    await changeMotion(f.project.root, { expectedRevision: d.revision, request: 'redo', action: 'redo' });
    assert.equal((await readMotion(f.project)).state.expressions?.length, 6);
}
finally {
    p.stop();
    await f.cleanup();
} });
test('three +5 requirements reject delta zero, correction preserves working transaction and commits exact final starts', async () => { const f = await fixture(), request = 'Пусть текст 2, текст 3 и текст 32 появляются на пять кадров позже'; const p = provider(n => answer(n === 1 ? [call('defineChecks', { targets, checks: [1, 2, 3].map(i => ({ checkId: 'delay' + i, sourceText: request, assertion: { kind: 'startDelta', animationId: 'in' + i, frames: 5 } })) }), ...[1, 2, 3].map(i => call('edit', { tool: 'updateAnimation', animationId: 'in' + i, patch: { startFrame: i === 3 ? 0 : 5 } })), call('runFocusedQA', {}), call('commitRevision', {})] : [call('edit', { tool: 'updateAnimation', animationId: 'in3', patch: { startFrame: 5 } }), call('runFocusedQA', {}), call('commitRevision', {})])); try {
    const r = await run(f, p, request);
    assert.equal(r.status, 'applied');
    assert.equal(p.calls(), 2);
    const savedRun=JSON.parse(await readFile(f.project.root+'/motion/harness/runs/'+r.id+'/run.json','utf8'));assert.equal(savedRun.metrics.repairAttempts,1);
    const d = await readMotion(f.project);
    assert.deepEqual(d.state.animations.map(a => a.startFrame), [5, 5, 5]);
    assert.equal(d.history.length, f.doc.history.length + 1);
    assert.deepEqual(d.state.expressions, f.doc.state.expressions);
}
finally {
    p.stop();
    await f.cleanup();
} });
test('novel mathematical motion uses safe program, shared native Preview and actual video without technique registration', async () => { const f = await fixture(), request = 'Пусть первая звезда двигается по необычной затухающей синусоиде'; const program = { version: 1 as const, instructions: [{ op: 'input' as const, name: 'time' as const }, { op: 'constant' as const, value: 9 }, { op: 'mul' as const }, { op: 'sin' as const }, { op: 'input' as const, name: 'time' as const }, { op: 'neg' as const }, { op: 'exp' as const }, { op: 'mul' as const }] }; const p = provider(() => answer([call('defineChecks', { targets: [targets[0]], checks: [{ checkId: 'motion', sourceText: request, assertion: { kind: 'motionVaries', sceneId: 's0', targetId: 'star1', property: 'x', frames: [21, 25, 30, 35, 40], minimumRange: 1 } }, { checkId: 'base', sourceText: request, assertion: { kind: 'basePreserved', animationIds: ['in1', 'in2', 'in3'] } }] }), call('applyEdit', { operations: [{ type: 'setExpression', expression: { expressionId: 'novel', type: 'procedural', sceneId: 's0', targetId: 'star1', property: 'x', startFrame: 20, durationFrames: 65, enabled: true, program, parameters: { amplitude: 8 } } }] }), call('runFocusedQA', {}), call('commitRevision', {})])); try {
    await run(f, p, request);
    const d = await readMotion(f.project), a = await renderNativeFrame(f.project, d.state, 25), b = await renderNativeFrame(f.project, d.state, 25);
    assert.deepEqual(a.png, b.png);
    const e = d.state.expressions!.find(e => e.expressionId === 'novel')!;
    assert.equal(e.type, 'procedural');
    const video = await exportVideo(f.project.root);
    assert.ok(video);
    assert.ok('frameDigests' in video);
    for (const proof of video.frameDigests) {
        const frame = await renderNativeFrame(f.project, d.state, proof.frame, { encoding: 'rgba' });
        assert.equal(createHash('sha256').update(frame.png).digest('hex'), proof.sha256);
    }
    assert.deepEqual((await readMotion(f.project)).state.animations, f.doc.state.animations);
}
finally {
    p.stop();
    await f.cleanup();
} });
test('working scope, check immutability, bounded program safety and stale revision protect project', async () => { const f = await fixture(); try {
    const request = 'первую звезду позже', w = new WorkingRevision(f.project, f.doc.revision, f.doc.state, request);
    w.defineChecks([{ checkId: 'a', sourceText: request, assertion: { kind: 'startDelta', animationId: 'in1', frames: 5 } }], [targets[0]]);
    assert.throws(() => w.apply({ tool: 'updateAnimation', animationId: 'in2', patch: { startFrame: 5 } }, 'x', true), /OUTSIDE_DECLARED_SCOPE/);
    w.apply({ tool: 'updateAnimation', animationId: 'in1', patch: { startFrame: 0 } }, 'a', true);
    assert.equal((await w.validate()).status, 'FAILED');
    assert.throws(() => w.assertReady(), /NOT_VERIFIED/);
    assert.throws(() => w.defineChecks([{ checkId: 'a', sourceText: request, assertion: { kind: 'startDelta', animationId: 'in1', frames: 0 } }], [targets[0]]), /PRECEDE_EDITS/);
    assert.throws(() => evaluateProgram(programSchema.parse({ version: 1, instructions: [{ op: 'div' }] }), { time: 0, progress: 0, fps: 30, sample: () => 0 }), /UNDERFLOW/);
    assert.throws(() => programSchema.parse({ version: 1, instructions: [{ op: 'eval', value: 'process.env' }] }));
    assert.throws(() => evaluateProgram({ version: 1, instructions: [{ op: 'constant', value: 1 }, { op: 'constant', value: 0 }, { op: 'div' }] }, { time: 0, progress: 0, fps: 30, sample: () => 0 }), /NUMERIC_DOMAIN/);
    assert.deepEqual((await readMotion(f.project)).state, f.doc.state);
}
finally {
    await f.cleanup();
} });
test('exact damped inertia ADD remains zero-call within the new working revision, repeat does not duplicate', async () => { const f = await fixture(), p = provider(() => { throw Error('provider must not run'); }); try {
    const request = 'добавь к звезда 1, звезда 2, звезда 3 эффект затухающих колебаний после движения';
    await run(f, p, request);
    const first = (await readMotion(f.project)).state;
    assert.equal(first.expressions?.filter(e => e.type === 'inertialOvershoot').length, 3);
    await run(f, p, request);
    assert.equal(p.calls(), 0);
    assert.deepEqual((await readMotion(f.project)).state, first);
}
finally {
    p.stop();
    await f.cleanup();
} });
test('dependency policy permits only derived start shifts, direct writes to dependent objects remain forbidden', async () => { const f = await fixture(); try {
    let d = (await changeMotion(f.project.root, { expectedRevision: f.doc.revision, request: 'dependency', operations: [{ type: 'setTimingDependency', dependency: { dependencyId: 'chain', animationId: 'in2', anchorAnimationId: 'in1', relation: 'after', offsetFrames: 0 } }] })).document;
    const w = new WorkingRevision(f.project, d.revision, d.state, 'звезда 1 позже');
    w.defineChecks([{ checkId: 'shift', sourceText: 'звезда 1 позже', assertion: { kind: 'startDelta', animationId: 'in1', frames: 5 } }], [targets[0]], false, 'preserve-relative');
    w.apply({ tool: 'updateAnimation', animationId: 'in1', patch: { startFrame: 5 } }, 'shift', true);
    assert.equal(w.state.animations.find(a => a.animationId === 'in2')?.startFrame, 25);
    assert.throws(() => w.apply({ tool: 'updateAnimation', animationId: 'in2', patch: { easing: 'easeOutCubic' } }, 'bad', true), /OUTSIDE_DECLARED_SCOPE/);
    w.revert();
    assert.deepEqual(w.state, d.state);
}
finally {
    await f.cleanup();
} });
test('nonconflicting concurrent revision rebases once, preserving the other edit and committing atomically', async () => { const f = await fixture(), request = 'Первую звезду сдвинь на пять кадров'; let changed = false; const p = provider(async () => { if (!changed) {
    changed = true;
    await changeMotion(f.project.root, { expectedRevision: f.doc.revision, request: 'concurrent user edit', operations: [{ type: 'updateAnimation', animationId: 'in2', animation: { ...f.doc.state.animations[1], easing: 'easeOutCubic' } }] });
} return answer([call('defineChecks', { targets: [targets[0]], checks: [{ checkId: 'delay', sourceText: request, assertion: { kind: 'startDelta', animationId: 'in1', frames: 5 } }] }), call('edit', { tool: 'updateAnimation', animationId: 'in1', patch: { startFrame: 5 } }), call('runFocusedQA', {}), call('commitRevision', {})]); }); try {
    await run(f,p,request);
    const d = await readMotion(f.project);
    assert.equal(d.state.animations[0].startFrame, 5);
    assert.equal(d.state.animations[1].easing, 'easeOutCubic');
    assert.equal(d.history.length, f.doc.history.length + 2);
}
finally {
    p.stop();
    await f.cleanup();
} });
test('resource stop never commits a partially edited candidate and uses no Code Repair', async () => { const f = await fixture(), request = 'Первую звезду позже и обязательно сохрани после проверки', p = provider(() => answer([call('defineChecks', { targets: [targets[0]], checks: [{ checkId: 'delay', sourceText: request, assertion: { kind: 'startDelta', animationId: 'in1', frames: 5 } }] }), call('edit', { tool: 'updateAnimation', animationId: 'in1', patch: { startFrame: 5 } })])); try {
    await assert.rejects(() => run(f, p, request, 1), (e: any) => e.agentDisposition === 'RESOURCE_LIMIT_REACHED');
    const after = await readMotion(f.project);
    assert.equal(after.revision, f.doc.revision);
    assert.deepEqual(after.state, f.doc.state);
    assert.equal(p.calls(), 1);
}
finally {
    p.stop();
    await f.cleanup();
} });
test('malformed tool envelope gets focused feedback and recovers without any semantic plan', async () => { const f = await fixture(), request = 'Первую звезду сдвинь на пять кадров'; const p = provider((n, r) => { assert.ok(!JSON.stringify(r.responseSchema).includes('requirements')); return n === 1 ? { edits: [] } : answer([call('defineChecks', { targets: [targets[0]], checks: [{ checkId: 'delta', sourceText: request, assertion: { kind: 'startDelta', animationId: 'in1', frames: 5 } }] }), call('edit', { tool: 'updateAnimation', animationId: 'in1', patch: { startFrame: 5 } }), call('runFocusedQA', {}), call('commitRevision', {})]); }); try {
    await run(f, p, request, 2);
    assert.equal(p.calls(), 2);
    assert.equal((await readMotion(f.project)).state.animations[0].startFrame, 5);
}
finally {
    p.stop();
    await f.cleanup();
} });
test('procedural programs have deterministic random access, explicit base dependencies and bounded numerical behavior', () => { const p = programSchema.parse({ version: 1, instructions: [{ op: 'input', name: 'time' }, { op: 'noise', seed: 7 }, { op: 'constant', value: 2 }, { op: 'mul' }] }); const value = (time: number) => evaluateProgram(p, { time, progress: time / 3, fps: 30, sample: () => 0 }); const a = [2, .1, 1, .25, 2].map(value); assert.equal(a[0], a[4]); assert.ok(a.every(v => Number.isFinite(v) && Math.abs(v) <= 2)); assert.throws(() => programSchema.parse({ version: 2, instructions: [{ op: 'constant', value: 0 }] })); assert.throws(() => evaluateProgram({ version: 1, instructions: Array.from({ length: 65 }, () => ({ op: 'constant', value: 0 })) }, { time: 0, progress: 0, fps: 30, sample: () => 0 }), /STACK_LIMIT/); });
test('external cancellation interrupts the actual provider turn, leaves no commit and preserves source state', async () => { const f = await fixture(), controller = new AbortController(); const p = provider(async (_n, r) => { setTimeout(() => controller.abort(), 20); return await new Promise((_resolve, reject) => r.signal.addEventListener('abort', () => reject(Error('CANCELLED')), { once: true })); }); try {
    await assert.rejects(() => executeMotion(f.project, { mode: 'edit', request: 'Добавь первой звезде необычное движение', expectedRevision: f.doc.revision, settings: { provider: p.id, model: '' } }, () => { }, { executionRuntime: 'agent', signal: controller.signal, config: { maxLLMCalls: 1 } }), /CANCELLED|abort/i);
    assert.equal(p.calls(), 1);
    assert.deepEqual((await readMotion(f.project)).state, f.doc.state);
}
finally {
    p.stop();
    await f.cleanup();
} });
test('tools canonicalize known logical targets and expose procedural base dependencies without artistic admission', async () => { const f = await fixture(); const { lowerMotionTool, inspectDependencies } = await import('../src/motion/tools.js'); try {
    const ops = lowerMotionTool(f.project, f.doc.state, { tool: 'createAnimation', animation: { ...f.doc.state.animations[0], animationId: 'new', targetId: targets[0], startFrame: 40 } });
    assert.equal(ops[0].type, 'addAnimation');
    assert.equal((ops[0] as any).animation.targetId, 'star1');
    const state = structuredClone(f.doc.state);
    state.expressions!.push({ expressionId: 'sampled', type: 'procedural', sceneId: 's0', targetId: 'star1', property: 'x', startFrame: 0, durationFrames: 90, enabled: true, parameters: { amplitude: 1 }, program: { version: 1, instructions: [{ op: 'sample', animationId: 'in2', property: 'y', offsetSeconds: 0 }] } });
    assert.ok(inspectDependencies(state, 'in2').expressions.some(e => e.expressionId === 'sampled'));
    assert.throws(() => lowerMotionTool(f.project, state, { tool: 'removeAnimation', animationId: 'in2', dependentPolicy: 'reject' }), /DEPENDENT_EFFECTS_REQUIRE_POLICY/);
}
finally {
    await f.cleanup();
} });
test('native result check measures real rendered displacement and rejects an offset baseline jump',async()=>{const f=await fixture();try{const d=(await changeMotion(f.project.root,{expectedRevision:f.doc.revision,request:'stable rotation-free fixture',operations:[{type:'removeExpression',expressionId:'spin1'}]})).document,w=new WorkingRevision(f.project,d.revision,d.state,'Передвинь звезду на 25');w.defineChecks([{checkId:'rendered',sourceText:'Передвинь звезду на 25',assertion:{kind:'renderedDelta',logicalObjectId:targets[0],beforeFrame:0,afterFrame:59,property:'x',delta:25*Math.min(d.state.settings.width/Number(f.project.inspection.document.scenes[0].width),d.state.settings.height/Number(f.project.inspection.document.scenes[0].height)),tolerance:.001}}],[targets[0]]);w.apply({tool:'createAnimation',animation:{animationId:'horizontal',sceneId:'s0',targetId:'star1',startFrame:0,durationFrames:59,easing:'linear',enabled:true,effect:'keyframes',parameters:{property:'x',points:[{frame:0,value:0},{frame:59,value:25}]}}},'new',true);const pass=await w.validate();assert.equal(pass.status,'PASSED',JSON.stringify(pass));const a=w.state.animations.find(a=>a.animationId==='horizontal')!;w.apply([{type:'updateAnimation',animationId:a.animationId,animation:{...a,parameters:{property:'x',points:[{frame:0,value:30},{frame:59,value:55}]}}}],'wrong-offset');assert.equal((await w.validate()).status,'FAILED');assert.throws(()=>w.assertReady(),/NOT_VERIFIED/);}finally{await f.cleanup();}});
test('wire schema factoring is lossless and keeps strict schema validation',async()=>{const {compactProviderSchema,validateProviderSchema}=await import('../src/harness/providers/schema.js');const field={type:'string',minLength:1,maxLength:180};const schema={type:'object',properties:Object.fromEntries(Array.from({length:30},(_,i)=>['id'+i,structuredClone(field)])),required:Array.from({length:30},(_,i)=>'id'+i),additionalProperties:false};const compact=compactProviderSchema(schema) as any;assert.ok(JSON.stringify(compact).length<JSON.stringify(schema).length);validateProviderSchema(compact);const expand=(v:any):any=>Array.isArray(v)?v.map(expand):v&&typeof v==='object'?v.$ref?expand(compact.$defs[v.$ref.split('/').at(-1)]):Object.fromEntries(Object.entries(v).filter(([k])=>k!=='$defs').map(([k,x])=>[k,expand(x)])):v;assert.deepEqual(expand(compact),schema);});
test('a changed read target is a genuine rebase conflict and cannot overwrite the concurrent animation',async()=>{const f=await fixture(),request='Сдвинь первую звезду на пять кадров';const p=provider(async()=>{await changeMotion(f.project.root,{expectedRevision:f.doc.revision,request:'same-target concurrent change',operations:[{type:'updateAnimation',animationId:'in1',animation:{...f.doc.state.animations[0],easing:'easeOutCubic'}}]});return answer([call('defineChecks',{targets:[targets[0]],checks:[{checkId:'delta',sourceText:request,assertion:{kind:'startDelta',animationId:'in1',frames:5}}]}),call('edit',{tool:'updateAnimation',animationId:'in1',patch:{startFrame:5}}),call('runFocusedQA',{}),call('commitRevision',{})]);});try{await assert.rejects(()=>run(f,p,request),(e:any)=>e.code==='STALE_PROJECT_REVISION_CONFLICT');const d=await readMotion(f.project);assert.equal(d.state.animations[0].startFrame,0);assert.equal(d.state.animations[0].easing,'easeOutCubic');assert.equal(d.history.length,f.doc.history.length+1);}finally{p.stop();await f.cleanup();}});
test('keyframe constructor derives duration without redundant model arithmetic and keeps canonical identity',async()=>{const f=await fixture();try{const {motionToolSchema,lowerMotionTool}=await import('../src/motion/tools.js');const command=motionToolSchema.parse({tool:'createAnimation',animation:{animationId:'derived',sceneId:'s0',targetId:targets[0],startFrame:30,easing:'linear',enabled:true,effect:'keyframes',parameters:{property:'x',points:[{frame:0,value:0},{frame:17,value:25}]}}});const ops=lowerMotionTool(f.project,f.doc.state,command);assert.equal(ops[0].type,'addAnimation');if(ops[0].type!=='addAnimation')throw Error('animation expected');assert.equal(ops[0].animation.durationFrames,17);assert.equal(ops[0].animation.targetId,'star1');}finally{await f.cleanup();}});
test('legacy local ambiguity cannot veto the agent: existing mixed effects are inspected and ensured through typed tools',async()=>{const f=await fixture(),request='добавь к объектам звезда 1, звезда 2, звезда 3 эффект колебаний';let calls=0;const p=provider((_n,r)=>{calls++;const context=JSON.parse(r.messages[1].content).context;assert.equal(context.localOptimizationIssue.code,'AMBIGUOUS_EFFECT_TYPE');return {...answer([call('defineChecks',{targets,checks:[1,2,3].map(i=>({checkId:'inertia'+i,sourceText:request,assertion:{kind:'entryField',entity:'expression',id:'damp'+i,path:['type'],value:'inertialOvershoot'}}))}),...[1,2,3].map(i=>call('edit',{tool:'updateEffect',expressionId:'damp'+i,patch:{enabled:true}})),call('runFocusedQA',{}),call('commitRevision',{})]),assumptions:['Использована существующая инерция после движения.']};});try{let d=(await changeMotion(f.project.root,{expectedRevision:f.doc.revision,request:'both effects',operations:[1,2,3].map(i=>({type:'setExpression',expression:{expressionId:'damp'+i,type:'inertialOvershoot',sceneId:'s0',targetId:'star'+i,property:'y',sourceAnimationId:'in'+i,startFrame:20,durationFrames:30,enabled:true,parameters:{amplitude:.25,frequency:2.5,decay:3,velocityLookbackFrames:6,mode:'ae'}}}))})).document;const {writeFile}=await import('node:fs/promises');await writeFile(f.project.root+'/motion/motion.json',JSON.stringify({...d,history:[],cursor:0}));const before=await readMotion(f.project);await run(f,p,request,1);assert.equal(calls,1);assert.deepEqual((await readMotion(f.project)).state,before.state);}finally{p.stop();await f.cleanup();}});
test('outcome selectors check actual target data without predicting model-generated IDs',async()=>{const f=await fixture();try{const w=new WorkingRevision(f.project,f.doc.revision,f.doc.state,'Сохрани существующие колебания первой звезды');w.defineChecks([{checkId:'found',sourceText:'Сохрани существующие колебания первой звезды',assertion:{kind:'entryMatches',entity:'expression',targetId:'star1',sceneId:'s0',where:[{path:['type'],value:'wiggle'},{path:['enabled'],value:true}],minimumCount:1}}],[targets[0]]);assert.equal(w.evaluate()[0].status,'PASSED');w.apply([{type:'removeExpression',expressionId:'spin1'}],'remove');assert.equal(w.evaluate()[0].status,'FAILED');assert.ok(w.state.expressions?.some(e=>e.expressionId==='spin2'));}finally{await f.cleanup();}});
test('default HTTP execution uses agent tools, publishes native preview and carries meaningful blocked disposition',async()=>{const f=await fixture(),request='Первую звезду перемести позже на пять кадров';const previous=process.env.AKELLA_MOTION_RUNTIME;process.env.AKELLA_MOTION_RUNTIME='agent';const {servePlatform}=await import('../src/platform-server.js'),path=(await import('node:path')).default;const p=provider((_n,r)=>JSON.parse(r.messages[1].content).userRequest==='Уточни объект'?{calls:[],disposition:'NEEDS_USER_INPUT',message:'Какой объект нужно изменить?',assumptions:[]}:answer([call('defineChecks',{targets:[targets[0]],checks:[{checkId:'shift',sourceText:request,assertion:{kind:'startDelta',animationId:'in1',frames:5}}]}),call('edit',{tool:'updateAnimation',animationId:'in1',patch:{startFrame:5}}),call('runFocusedQA',{}),call('commitRevision',{})]));const server=await servePlatform(path.dirname(f.project.root),0);try{const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port+'/api/projects/'+f.project.config.projectId+'/motion';const turn=async(text:string)=>{const response=await fetch(base+'/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'edit',request:text,expectedRevision:(await readMotion(f.project)).revision,settings:{provider:p.id,model:''}})});assert.equal(response.status,202);const receipt=await response.json() as {jobId:string};for(let n=0;n<1000;n++){const job=await(await fetch(base+'/jobs/'+receipt.jobId)).json() as any;if(job.status!=='running')return job;await new Promise(r=>setTimeout(r,5));}throw Error('test job timeout');};const success=await turn(request);assert.equal(success.status,'completed',JSON.stringify(success));assert.equal(success.result.agentRuntime,'agent-native/1');assert.equal((await readMotion(f.project)).state.animations[0].startFrame,5);const frame=await fetch(base+'/frame?frame=10&scale=.25');assert.equal(frame.status,200);assert.ok((await frame.arrayBuffer()).byteLength>0);const revision=(await readMotion(f.project)).revision,blocked=await turn('Уточни объект');assert.equal(blocked.status,'failed');assert.equal(blocked.agentDisposition,'NEEDS_USER_INPUT');assert.equal(blocked.error,'Какой объект нужно изменить?');assert.equal((await readMotion(f.project)).revision,revision);}finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));p.stop();if(previous===undefined)delete process.env.AKELLA_MOTION_RUNTIME;else process.env.AKELLA_MOTION_RUNTIME=previous;await f.cleanup();}});
test('typed keyframe/program updates preserve identity, easing, base tracks and all unrelated parameters',async()=>{const f=await fixture();const {applyOperations}=await import('../src/motion/operations.js'),{lowerMotionTool}=await import('../src/motion/tools.js');try{let state=applyOperations(f.doc.state,[{type:'addAnimation',animation:{animationId:'keys',sceneId:'s0',targetId:'star1',startFrame:30,durationFrames:17,easing:'easeInOutCubic',enabled:true,effect:'keyframes',parameters:{property:'x',points:[{frame:0,value:0},{frame:17,value:25}]}}},{type:'setExpression',expression:{expressionId:'program-edit',type:'procedural',sceneId:'s0',targetId:'star1',property:'x',startFrame:50,durationFrames:30,enabled:true,program:{version:1,instructions:[{op:'input',name:'time'},{op:'sin'}]},parameters:{amplitude:4}}}],f.project);const before=structuredClone(state);state=applyOperations(state,lowerMotionTool(f.project,state,{tool:'updateAnimation',animationId:'keys',patch:{keyframes:[{frame:0,value:0},{frame:21,value:30}]}}),f.project);assert.equal(state.animations.find(a=>a.animationId==='keys')?.durationFrames,21);assert.equal(state.animations.find(a=>a.animationId==='keys')?.easing,'easeInOutCubic');const base=structuredClone(state.animations);state=applyOperations(state,lowerMotionTool(f.project,state,{tool:'updateEffect',expressionId:'program-edit',patch:{program:{version:1,instructions:[{op:'input',name:'time'},{op:'constant',value:2},{op:'mul'},{op:'sin'}]}}}),f.project);assert.deepEqual(state.animations,base);const after=state.expressions!.find(e=>e.expressionId==='program-edit')!,old=before.expressions!.find(e=>e.expressionId==='program-edit')!;assert.equal(after.expressionId,old.expressionId);assert.deepEqual(after.parameters,old.parameters);assert.equal(after.startFrame,old.startFrame);assert.equal(after.durationFrames,old.durationFrames);assert.deepEqual(state.expressions!.filter(e=>e.expressionId!=='program-edit'),before.expressions!.filter(e=>e.expressionId!=='program-edit'));}finally{await f.cleanup();}});
