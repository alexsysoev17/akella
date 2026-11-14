import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { identityFixture, node } from './identity-fixture.js';
import { applyOperations } from '../src/motion/operations.js';
import { compileSemanticEdit, ruleObjects } from '../src/motion/rules.js';
import { semanticEditSchema } from '../src/motion/rule-contract.js';
import { closeNativeRenderer, renderNativeFrame } from '../src/native/client.js';
import { ruleQA } from '../src/motion/rule-qa.js';
import { expressionValue } from '../src/motion/expressions.js';
import { evaluateAnimation } from '../src/motion/evaluation.js';
import { readMotion, changeMotion } from '../src/motion/store.js';
import { createHash } from 'node:crypto';
after(() => closeNativeRenderer());
async function fixture() { const f = await identityFixture(2, scenes => scenes.forEach((s, j) => { s.children = ['Phone', 'Star 1', 'Star 2', 'Star 3'].map((name, i) => ({ ...node('n' + j + i, name, 20 + i * 55 + j * 10, 25 + i * 10, 30, 25), properties: { width: 30, height: 25, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] } })); s.width = 320; s.height = 180; s.properties = { width: 320, height: 180, clipsContent: true, fills: [] }; })); f.state.settings = { ...f.state.settings, width: 320, height: 180, fps: 30, durationFrames: 180 }; f.state.blocks[0].durationFrames = 90; f.state.blocks[1].startFrame = 90; f.state.blocks[1].durationFrames = 90; return f; }
function edit(f: Awaited<ReturnType<typeof fixture>>, state: typeof f.state, input: unknown, text = 'Rule test') { return applyOperations(state, compileSemanticEdit(f.project, state, semanticEditSchema.parse(input), text), f.project); }
const scope = { selector: 'objects', logicalObjectIds: [], phase: 'all' };
const wiggle = (targets: string[], parameters = { amplitude: 4, frequency: 1 }) => ({ operation: 'ADD_RULE', effect: 'wiggle', targets, scope, parameters });
function move(id: string, target = 'n00', start = 0) { return { type: 'addAnimation' as const, animation: { animationId: id, sceneId: 's0', targetId: target, startFrame: start, durationFrames: 15, easing: 'linear' as const, enabled: true, effect: 'slideUp' as const, parameters: { distance: 30, mode: 'in' as const } } }; }
test('persistent inertia applies to every movement including future operations, not fade-only; idempotent IDs', async () => { const f = await fixture(); try {
    let base = applyOperations(f.state, [move('m1'), move('m2', 'n00', 60), { type: 'addAnimation', animation: { ...move('fade').animation, animationId: 'fade', effect: 'fadeIn', parameters: { from: 0, to: 1 } } }], f.project);
    let state = edit(f, base, { operation: 'ADD_RULE', effect: 'inertialOvershoot', targets: ['Phone'], scope, parameters: { amplitude: .25 } });
    assert.equal(state.expressions?.length, 2);
    assert.deepEqual(state.animations, base.animations);
    state = applyOperations(state, [move('m3', 'n00', 120)], f.project);
    assert.equal(state.expressions?.length, 3);
    const ids = state.expressions!.map(e => e.expressionId);
    const again = edit(f, state, { operation: 'ADD_RULE', effect: 'inertialOvershoot', targets: ['Phone'], scope, parameters: { amplitude: .25 } });
    assert.deepEqual(again.expressions!.map(e => e.expressionId), ids);
    assert.equal((await ruleQA(f.project, again)).status, 'PASSED');
    const e = again.expressions![0];
    const values = Array.from({ length: 61 }, (_, i) => expressionValue(e, e.startFrame + i / 2, 30, again.animations, evaluateAnimation));
    assert.ok(values.some(v => v > 0) && values.some(v => v < 0));
    assert.equal(values[0], 0);
    assert.equal(values.at(-1), 0);
}
finally {
    await f.cleanup();
} });
test('group wiggle, one-object removal, relative amplitude edit, repeated addition preserve neighbours and base', async () => { const f = await fixture(); try {
    const base = applyOperations(f.state, [move('base', 'n01')], f.project);
    let state = edit(f, base, wiggle(['Star 1', 'Star 2', 'Star 3']));
    const third = state.expressions!.find(e => e.targetId === 'n03')!;
    const secondId = state.expressions!.find(e => e.targetId === 'n02')!.expressionId;
    state = edit(f, state, { operation: 'REMOVE_EFFECT', effect: 'wiggle', targets: ['Star 1'], scope, parameters: {} });
    assert.ok(!state.expressions!.some(e => e.targetId === 'n01'));
    state = edit(f, state, { operation: 'MODIFY_EFFECT', effect: 'wiggle', targets: ['Star 2'], scope, parameters: {}, amplitudeFactor: .5 });
    assert.equal(state.expressions!.find(e => e.targetId === 'n02')!.parameters.amplitude, 2);
    assert.equal(state.expressions!.find(e => e.targetId === 'n02')!.expressionId, secondId);
    state = edit(f, state, { operation: 'MODIFY_EFFECT', effect: 'wiggle', targets: ['Star 2'], scope, parameters: {}, amplitudeFactor: .5 });
    assert.equal(state.expressions!.find(e => e.targetId === 'n02')!.parameters.amplitude, 1);
    assert.deepEqual(state.expressions!.find(e => e.targetId === 'n03'), third);
    assert.deepEqual(state.animations, base.animations);
    assert.equal(state.motionRules?.length, 3);
    assert.equal((await ruleQA(f.project, state)).status, 'PASSED');
    const hashes = [];
    for (const frame of [20, 40, 20])
        hashes.push(createHash('sha256').update((await renderNativeFrame(f.project, state, frame, { cache: false })).png).digest('hex'));
    assert.equal(hashes[0], hashes[2]);
    assert.notEqual(hashes[0], hashes[1]);
}
finally {
    await f.cleanup();
} });
test('explicit project scope, exceptions and scoped easing preserve unrelated tracks and restore on removal', async () => { const f = await fixture(); try {
    const base = applyOperations(f.state, [move('a'), move('b', 'n01'), { type: 'addAnimation', animation: { ...move('fade1').animation, animationId: 'fade1', effect: 'fadeIn', parameters: { from: 0, to: 1 } } }, { type: 'addAnimation', animation: { ...move('fade2', 'n01').animation, animationId: 'fade2', effect: 'fadeIn', parameters: { from: 0, to: 1 } } }], f.project);
    let state = edit(f, base, { operation: 'REMOVE_EFFECT', effect: 'fade', targets: [], excludedTargets: ['Phone'], scope: { selector: 'project' }, parameters: {} });
    assert.equal(state.animations.find(a => a.animationId === 'fade1')!.enabled, true);
    assert.equal(state.animations.find(a => a.animationId === 'fade2')!.enabled, false);
    state = edit(f, state, { operation: 'ADD_RULE', effect: 'easing', targets: ['Phone'], scope, parameters: { easing: 'easeInOutCubic' } });
    assert.equal(state.animations[0].easing, 'easeInOutCubic');
    assert.deepEqual(state.animations[1], base.animations[1]);
    const rule = state.motionRules!.find(r => r.effect === 'easing')!;
    state = edit(f, state, { operation: 'REMOVE_RULE', ruleId: rule.ruleId, effect: 'easing', scope, parameters: {} });
    assert.deepEqual(state.animations[0], base.animations[0]);
    assert.throws(() => edit(f, base, { operation: 'ADD_RULE', effect: 'wiggle', scope, parameters: {} }), /EXPLICIT_SCOPE/);
}
finally {
    await f.cleanup();
} });
test('cross-scene transition inertia uses real transition velocity; native seek is stable', async () => { const f = await fixture(); try {
    const id = ruleObjects(f.project).find(o => o.name === 'Phone')!.logicalObjectId;
    const base = applyOperations(f.state, [{ type: 'animateObjectStateTransition', transitionId: 't', logicalObjectId: id, fromSceneId: 's0', toSceneId: 's1', startFrame: 60, durationFrames: 30, easing: 'linear', proceduralEffects: [], layerPolicy: { type: 'switch', switchProgress: .5 }, timelinePolicy: 'referenceStates' }], f.project);
    const state = edit(f, base, { operation: 'ADD_RULE', effect: 'inertialOvershoot', targets: ['Phone'], scope, parameters: {} });
    assert.equal(state.expressions!.length, 2);
    assert.ok(state.expressions!.every(e => e.transitionId === 't'));
    assert.deepEqual(state.objectTransitions, base.objectTransitions);
    assert.equal((await ruleQA(f.project, state)).status, 'PASSED');
    for (const frame of [95, 70, 110, 95])
        assert.ok((await renderNativeFrame(f.project, state, frame, { cache: false })).png.length);
}
finally {
    await f.cleanup();
} });
test('save reopen, FPS change, Undo/Redo preserve rule parameters, speed and canonical ownership', async () => { const f = await fixture(); try {
    let doc = await readMotion(f.project);
    doc = (await changeMotion(f.project.root, { expectedRevision: doc.revision, request: 'setup', operations: [{ type: 'setProjectSettings', settings: f.state.settings }, { type: 'setBlocks', blocks: f.state.blocks }, move('a')] })).document;
    const ops = compileSemanticEdit(f.project, doc.state, semanticEditSchema.parse(wiggle(['Star 1', 'Star 2', 'Star 3'])), 'Group wiggle');
    const saved = (await changeMotion(f.project.root, { expectedRevision: doc.revision, request: 'Group wiggle', operations: ops })).document;
    assert.deepEqual((await readMotion(f.project)).state, saved.state);
    const fps = (await changeMotion(f.project.root, { expectedRevision: saved.revision, request: '60FPS', operations: [{ type: 'setProjectTime', fps: 60 }] })).document;
    assert.ok(fps.state.expressions!.every(e => e.type === "wiggle" && e.durationFrames === 360 && e.parameters.frequency === 1));
    const undo = (await changeMotion(f.project.root, { expectedRevision: fps.revision, request: 'undo', action: 'undo' })).document;
    assert.deepEqual(undo.state, saved.state);
    const redo = (await changeMotion(f.project.root, { expectedRevision: undo.revision, request: 'redo', action: 'redo' })).document;
    assert.deepEqual(redo.state, fps.state);
}
finally {
    await f.cleanup();
} });
test('production semantic graph → resolution → preflight → native QA → atomic commit, subsequent removal preserves group (mock provider)', async () => {
    const f = await fixture();
    const { registerProvider } = await import('../src/harness/providers/index.js');
    const { executeMotion } = await import('../src/motion/service.js');
    let calls = 0;
    let turn = 0;
    const prompts = ['У звезды Star 1, Star 2 и Star 3 постоянный wiggle', 'Убери wiggle у Star 1', 'Сделай wiggle у Star 2 вдвое слабее'];
    const stop = registerProvider('rules-fixture', () => ({ id: 'rules-fixture', mode: 'mock', capabilities: () => ({ structuredOutput: true, nativeToolCalling: false, cancellation: true, usage: false, nativeOutputTokenLimit: false }), generate: async () => { calls++; const remove = turn === 1; return { output: { schemaVersion: 'semantic-graph/1.0', clauses: [{ clauseId: 'c', text: prompts[turn] }], actions: [{ actionId: 'rule', clauseId: 'c', kind: 'editAnimation', scene: 's0', targets: [turn === 2 ? 'n02' : 'n01'], techniques: ['wiggle'], parameters: turn === 2 ? [{ key: 'amplitudeFactor', value: .5 }] : [], relation: 'unchanged', ...(turn === 2 ? {} : { semanticEdit: { ...wiggle(remove ? ['Star 1'] : ['Star 1', 'Star 2', 'Star 3']), operation: remove ? 'REMOVE_EFFECT' : 'ADD_RULE' } }), constraints: [], unresolvedReason: null }], assumptions: [] }, usage: null, estimatedCost: null, latencyMs: 0, diagnostics: ['mock semantic interpretation'], toolCalls: [] }; } }));
    try {
        let doc = await readMotion(f.project);
        doc = (await changeMotion(f.project.root, { expectedRevision: doc.revision, request: 'setup', operations: [{ type: 'setProjectSettings', settings: f.state.settings }, { type: 'setBlocks', blocks: f.state.blocks }, move('base', 'n01')] })).document;
        for (turn = 0; turn < 3; turn++) {
            const result = await executeMotion(f.project, { mode: 'create', request: prompts[turn], expectedRevision: doc.revision, settings: { provider: 'rules-fixture', model: '' } }, () => { }, { config: { maxLLMCalls: 1, maxRepairAttempts: 0 } });
            assert.equal(result.reconciliation?.status, 'SUCCESS', JSON.stringify(result));
            doc = await readMotion(f.project);
            assert.equal(doc.state.expressions!.length, turn ? 2 : 3);
            assert.equal(doc.state.animations.length, 1);
        }
        assert.equal(calls, 1, "initial semantics uses provider; exact named remove/halve execute locally");
        assert.equal(doc.state.motionRules!.length, 3);
        assert.equal(doc.state.expressions!.find(e => e.targetId === 'n02')!.parameters.amplitude, 2);
        assert.ok(!doc.state.expressions!.some(e => e.targetId === 'n01'));
        assert.equal(doc.state.animations[0].animationId, 'base');
    }
    finally {
        stop();
        await closeNativeRenderer();
        await f.cleanup();
    }
});
test('entrance-only override suppresses later inertia, explicit exceptions restore group without duplicates', async () => {
    const f = await fixture();
    try {
        let state = applyOperations(f.state, [move('in'), { type: 'addAnimation', animation: { animationId: 'later', targetId: 'n00', sceneId: 's0', startFrame: 60, durationFrames: 15, effect: 'moveTo', parameters: { fromX: 0, fromY: 0, toX: 20, toY: 30 }, easing: 'linear', enabled: true } }], f.project);
        state = edit(f, state, { operation: 'ADD_RULE', effect: 'inertialOvershoot', targets: ['Phone'], scope, parameters: {} });
        assert.equal(state.expressions!.length, 3);
        state = edit(f, state, { operation: 'MODIFY_EFFECT', effect: 'inertialOvershoot', targets: ['Phone'], scope: { ...scope, phase: 'entrance' }, parameters: {} });
        assert.equal(state.expressions!.length, 1);
        assert.equal(state.expressions![0].type === 'inertialOvershoot' && state.expressions![0].sourceAnimationId, 'in');
        state = edit(f, state, wiggle(['Star 1', 'Star 2', 'Star 3']));
        const rule = state.motionRules!.find(r => r.effect === 'wiggle')!;
        state = edit(f, state, { operation: 'ADD_EXCEPTION', ruleId: rule.ruleId, effect: 'wiggle', targets: ['Star 1'], scope, parameters: {} });
        assert.equal(state.expressions!.filter(e => e.type === 'wiggle').length, 2);
        state = edit(f, state, { operation: 'REMOVE_EXCEPTION', ruleId: rule.ruleId, effect: 'wiggle', targets: ['Star 1'], scope, parameters: {} });
        assert.equal(state.expressions!.filter(e => e.type === 'wiggle').length, 3);
    }
    finally {
        await f.cleanup();
    }
});
test('time-scoped wiggle and rotation during cross-scene state transition render deterministic offsets once', async () => {
    const f = await fixture();
    try {
        const id = ruleObjects(f.project).find(o => o.name === 'Star 1')!.logicalObjectId;
        let state = applyOperations(f.state, [{ type: 'animateObjectStateTransition', transitionId: 'rotate-transition', logicalObjectId: id, fromSceneId: 's0', toSceneId: 's1', startFrame: 60, durationFrames: 30, easing: 'linear', proceduralEffects: [], layerPolicy: { type: 'switch', switchProgress: .5 }, timelinePolicy: 'referenceStates' }], f.project);
        const base = structuredClone(state);
        state = edit(f, state, { ...wiggle(['Star 1']), scope: { ...scope, startSeconds: 1, endSeconds: 5 } });
        const { evaluateMotion } = await import('../src/motion/evaluation.js');
        const { statePresentation } = await import('../src/motion/transitions.js');
        const presentation = statePresentation(f.project, state);
        for (const frame of [0, 50, 75, 95, 149, 170]) {
            const evaluation = evaluateMotion(state, frame, presentation);
            assert.ok(Object.values(evaluation.nodes).every(v => Object.values(v).every(Number.isFinite)));
            const r = await renderNativeFrame(f.project, state, frame, { cache: false });
            const b = await renderNativeFrame(f.project, base, frame, { cache: false });
            if (frame === 0 || frame === 170)
                assert.deepEqual(r.png, b.png);
            else
                assert.notDeepEqual(r.png, b.png);
            if (frame === 95)
                assert.equal(evaluation.nodes[JSON.stringify(['s1', 'n11'])]?.rotation ?? 0, 0, 'logical effect is composed by the transition exactly once');
        }
    }
    finally {
        await f.cleanup();
    }
});
test('native preview/export parity and actual MP4 decode after persistent rule editing', async () => {
    const f = await fixture();
    try {
        let doc = await readMotion(f.project);
        const settings = { ...f.state.settings, durationFrames: 60 };
        const blocks = [{ ...f.state.blocks[0], durationFrames: 60 }];
        doc = (await changeMotion(f.project.root, { expectedRevision: doc.revision, request: 'setup', operations: [{ type: 'setProjectSettings', settings }, { type: 'setBlocks', blocks }, move('a', 'n01')] })).document;
        doc = (await changeMotion(f.project.root, { expectedRevision: doc.revision, request: 'wiggle', operations: compileSemanticEdit(f.project, doc.state, semanticEditSchema.parse(wiggle(['Star 1'])), 'wiggle') })).document;
        const { exportVideo } = await import('../src/motion/video.js');
        const video = await exportVideo(f.project.root, () => { }, { renderer: 'native' });
        assert.ok('frameDigests' in video);
        for (const d of video.frameDigests) {
            const p = await renderNativeFrame(f.project, doc.state, d.frame, { encoding: 'rgba' });
            assert.equal(createHash('sha256').update(p.png).digest('hex'), d.sha256);
        }
        const { createRequire } = await import('node:module');
        const ffmpeg = createRequire(import.meta.url)('ffmpeg-static');
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const path = (await import('node:path')).default;
        await promisify(execFile)(ffmpeg, ['-v', 'error', '-i', path.join(f.project.root, 'renders', video.file), '-f', 'null', '-']);
    }
    finally {
        await f.cleanup();
    }
});
test('explicit project relative edit respects distinct current amplitudes and does not re-enable an excluded object', async () => { const f = await fixture(); try {
    let state = edit(f, f.state, wiggle(['Star 1', 'Star 2', 'Star 3']));
    state = edit(f, state, { operation: 'MODIFY_EFFECT', effect: 'wiggle', targets: ['Star 2'], scope, parameters: { amplitude: 8 } });
    state = edit(f, state, { operation: 'REMOVE_EFFECT', effect: 'wiggle', targets: ['Star 1'], scope, parameters: {} });
    state = edit(f, state, { operation: 'MODIFY_EFFECT', effect: 'wiggle', scope: { selector: 'project' }, parameters: {}, amplitudeFactor: .5 });
    assert.equal(state.expressions!.find(e => e.targetId === 'n02')!.parameters.amplitude, 4);
    assert.equal(state.expressions!.find(e => e.targetId === 'n03')!.parameters.amplitude, 2);
    assert.ok(!state.expressions!.some(e => e.targetId === 'n01'));
    assert.throws(() => applyOperations(state, [{ type: 'removeExpression', expressionId: state.expressions![0].expressionId }], f.project), /RULE_OWNED_EFFECT/);
}
finally {
    await f.cleanup();
} });
