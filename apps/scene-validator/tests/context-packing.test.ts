import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { semanticContext } from '../src/harness/semantic-context.js';
import { packContext, unpackContext, contextEncodingInstructions } from '../src/harness/context-packing.js';
import { providerBudget, prepareProviderRequest, serializedRequestBytes } from '../src/harness/providers/budget.js';
import { ProviderError, type ProviderAdapter, type ProviderRequest } from '../src/harness/providers/types.js';
import { HarnessRun } from '../src/harness/runtime.js';
import { intentFixture } from './intent-fixture.js';
import { semanticPlan, SemanticProvider } from '../src/motion/intent/planner.js';
import { CodexProvider } from '../src/motion/provider.js';
import { registerProvider } from '../src/harness/providers/index.js';
import { compileTasks } from '../src/motion/intent/compiler.js';
import { inspectorRun } from '../src/harness/inspector.js';
const adapter: ProviderAdapter = { id: 'packing-fixture', mode: 'mock', capabilities: () => ({ structuredOutput: true, nativeToolCalling: false, cancellation: true, usage: false, nativeOutputTokenLimit: false }), generate: async () => { throw Error('unexpected network'); } };
const input = (context: unknown, userRequest = 'полный исходный запрос'): ProviderRequest => ({ purpose: 'semantic-planning', messages: [{ role: 'system', content: 'Required instructions' }, { role: 'user', content: JSON.stringify({ mode: 'semantic-planning', context, userRequest }) }], responseSchema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'], additionalProperties: false }, timeoutMs: 10000, maxOutputTokens: 1000 });
function largeContext() {
    const scenes = Array.from({ length: 4 }, (_, i) => ({ sceneId: 'scene_canonical_' + i, index: i, name: 'Сцена ' + (i + 1) }));
    const objects = scenes.flatMap((s, i) => Array.from({ length: 10 }, (_, j) => ({ name: 'Объект ' + j, sceneId: s.sceneId, sourceNodeId: i + ':' + j, logicalObjectId: 'object_' + String(j).padStart(64, '0'), objectType: 'RECTANGLE', aliases: ['Объект ' + j], existingAnimations: [], existingExpressions: [] })));
    return { project: { fps: 30, width: 1920, height: 1080, durationFrames: 300 }, sceneIndex: scenes, objectIndex: objects, logicalObjects: Array.from({ length: 10 }, (_, j) => ({ logicalObjectId: objects[j].logicalObjectId, name: objects[j].name, sourceInstances: scenes.map((s, i) => ({ sceneId: s.sceneId, sourceNodeId: i + ':' + j })), states: scenes.map((s, i) => ({ sceneId: s.sceneId, sourceNodeId: i + ':' + j, transform: [[1, 0, 500.25 + j], [0, 1, 320.75 + i]], width: 100, height: 40, opacity: 1, visible: true })) })), mentions: objects.map((o, i) => ({ displayName: o.name, logicalObjectId: o.logicalObjectId, sceneId: o.sceneId, sourceNodeId: o.sourceNodeId, start: i * 20, end: i * 20 + 10 })), motion: { settings: { fps: 30, durationFrames: 300 }, animations: [], expressions: [], objectTransitions: [{ transitionId: "move-between-states", logicalObjectId: objects[0].logicalObjectId, fromSceneId: scenes[0].sceneId, toSceneId: scenes[1].sceneId, startFrame: 60, durationFrames: 30, easing: { type: "cubicBezier", parameters: { x1: .85, y1: 0, x2: .15, y2: 1 } } }], timingDependencies: [{ dependencyId: 'dep', animationId: 'second', anchorAnimationId: 'first', relation: 'after', offsetFrames: 20 }] }, motionKnowledge: { techniques: Array.from({ length: 30 }, (_, i) => ({ id: 'technique_' + i, description: 'Supported Position Fade Scale inertialOvershoot Trim Paths custom easing and per-line text. '.repeat(13) })) } };
}
test('lossless tables/dictionaries preserve canonical IDs, fractional values, state, dependency edges and escaped marker keys', () => {
    const value = { ...largeContext(), reserved: [{ $s: 0 }, { $columns: ['x'], $rows: [[2]] }, { $object: [['x', 1]] }], mixed: [null, 1, 'текст'], empty: [], different: [{ a: 1 }, { b: null }] };
    const before = structuredClone(value), packed = packContext(value);
    assert.deepEqual(unpackContext(packed.value), before);
    assert.deepEqual(value, before);
    assert.ok(packed.packedBytes < packed.originalBytes * .65);
    assert.ok(packed.changedCategories.includes('objectIndex'));
    assert.ok(packed.changedCategories.includes('motionKnowledge'));
    for (let i = 0; i < 50; i++) {
        const sample = { rows: Array.from({ length: 2 + i % 8 }, (_, j) => ({ id: 'canonical_' + j, text: 'русский\u00a0текст '.repeat(i % 5), v: j / 3, nullable: null })), metadata: { $s: i } };
        assert.deepEqual(unpackContext(packContext(sample).value), sample);
    }
});
test('reproduce 68KB startup failure, pack full request below 60KB, preserve full Russian timeline and every context value', () => {
    const prompt = "на 0 секунде фон проявляется через фейд\nна 1 секунде лого появляется снизу через фейд с колебаниями\nна 2 секунде лого отправляется наверх и уменьшается в размере и стоит как в состоянии на сцене 2, телефон появляется снизу из-за кадра через фейд с колебаниями, лигал текст появляется просто снизу\nспустя 20 кадров 500б и 700б появляются снизу из-за кадра с колебаниями, салат появляется снизу справа с колебаниями и груша появляется снизу слева с колебаниями, текст 1 анимируется построчно появляется снизу через фейд с колебаниями\nна 5 секунде текст 1 уходит влево через фейд типа пропадает, лого уходит влево с колебаниями и встает как в сцене 3, 500б и салат и телефон и груша встают в положение как на сцене 3 с кривой анимации в начале и конце оч медленно и плавно а в середине очень резко, куар появляется снизу через фейд с колебаниями, текст 2 появляется построчно снизу через фейд, куар телефона появляется спустя секунду\nна 8 секунде текст 2 уходит влево за кадр через фейд, 500б и салат и груша и 700б уходят вниз за кадр через фейд, телефон и куар телефона увеличиваются в размере и становятся как в сцене 4, звезда 3 и звезда 2 и звезда 1 появляются снизу через фейд с колебаниями причем анимация кривой медленно в начале и конце посередине резко\nтекст 3 появляются снизу через фейд, текст 32 появляется чуть позже сверху через фейд  причем анимация кривой медленно в начале и конце посередине резко\nна 9 секунде куар телефона увеличивается на 30 процентов а потом встает на место причем анимация  медленно в начале и конце посередине резко\n\n\n ";
    const context = largeContext();
    const req = input(context, prompt);
    assert.ok(serializedRequestBytes(req) > 68000);
    assert.throws(() => providerBudget(adapter, req, 60000), /CONTEXT_EXHAUSTED/);
    const { request, budget, report } = prepareProviderRequest(adapter, req, 60000);
    assert.ok(budget.totalBytes < 60000);
    assert.equal(budget.totalBytes, serializedRequestBytes(request));
    assert.deepEqual(request.responseSchema, req.responseSchema);
    assert.equal(request.messages[0].content, req.messages[0].content + contextEncodingInstructions);
    const decoded = JSON.parse(request.messages[1].content);
    assert.equal(decoded.userRequest, prompt);
    assert.deepEqual(unpackContext(decoded.context), context);
    assert.equal(report.beforeBytes, serializedRequestBytes(req));
    assert.equal(report.afterBytes, budget.totalBytes);
    assert.equal(report.requirementCount, null);
    assert.equal(report.lossless, true);
    const extended = { ...req, model: 'model-id', reasoningEffort: 'high' as const };
    assert.ok(serializedRequestBytes(extended) > serializedRequestBytes(req));
    console.log(JSON.stringify({ fixture: 'synthetic context', before: report.beforeBytes, after: report.afterBytes, budget: 60000, liveCalls: 0 }));
});
test('impossible mandatory prompt/schema: zero calls, one semantic attempt, precise persisted admission diagnostics and unchanged project', async () => {
    const f = await intentFixture();
    const run = await HarnessRun.start(f.project, randomUUID(), 'synthetic', adapter.id, '', undefined, { maxContextBytes: 4000 });
    let attempts = 0, calls = 0;
    const a = { ...adapter, generate: async () => { calls++; throw Error('unexpected call'); } };
    try {
        const prompt = 'требование '.repeat(1200);
        await assert.rejects(() => semanticPlan(f.project, prompt, {}, { interpret: async () => { attempts++; await run.invoke(a, input({ objectIndex: [] }, prompt)); throw Error('unreachable'); }, audit: async () => { throw Error('unexpected audit'); } }, async () => { }, { auditAlways: false, maxAttempts: 2 }), /MANDATORY_REQUEST_EXCEEDS_BUDGET/);
        assert.equal(attempts, 1);
        assert.equal(calls, 0);
        assert.equal(run.calls.length, 0);
        await run.finish('FAILED');
        const trace = JSON.parse(await readFile(path.join(f.project.root, 'motion/harness/runs', run.runId, 'trace.json'), 'utf8'));
        const admission = trace.find((t: {
            stage: string;
        }) => t.stage === 'context-admission').data;
        assert.equal(admission.status, 'REJECTED');
        assert.equal(admission.llmCalls, 0);
        assert.ok(admission.afterBytes > 4000);
        const view = await inspectorRun(f.project.root, run.runId);
        assert.ok(view.contextAdmission);
    }
    finally {
        await run.finish('FAILED');
        await f.cleanup();
    }
});
test('short requests unchanged; model-specific window remains enforced after packing', () => {
    const request = input({ objects: [] });
    const ready = prepareProviderRequest(adapter, request, 60000);
    assert.deepEqual(ready.request, request);
    assert.deepEqual(ready.report.compactedCategories, []);
    assert.throws(() => prepareProviderRequest(adapter, input(largeContext()), 60000, [{ provider: adapter.id, model: '', contextWindowTokens: 100, maxOutputTokens: 100, transportOverheadTokens: 50 }]), /CONTEXT_EXHAUSTED/);
});
test('production semantic provider/runtime keeps complete multi-scene compound contract and resolves real targets after packing in ONE mock call', async () => {
    const f = await intentFixture();
    let calls = 0;
    const clauses = ['сцена 2: image 1926988171 снизу через фейд с колебаниями и плавной кривой. ', 'куар уменьшается через scale. ', 'сцена 3: лента 1 рисуется. ', 'лента 2 рисуется после ленты 1. ', 'сцена 2: Абонементы на любимую еду и напитки построчно снизу через фейд с колебаниями.'];
    const request = clauses.join('');
    const graph = { schemaVersion: 'semantic-graph/1.0', clauses: clauses.map((text, i) => ({ clauseId: 'c' + i, text })), actions: [{ actionId: 'image', clauseId: 'c0', kind: 'objectAnimation', scene: 's1', targets: ['image 1926988171'], techniques: ['slideUp', 'fadeIn', 'inertialOvershoot', 'customCurve'], parameters: [{ key: 'easing', value: { type: 'cubicBezier', parameters: { x1: .85, y1: 0, x2: .15, y2: 1 } } }], constraints: [], unresolvedReason: null }, { actionId: 'qr', clauseId: 'c1', kind: 'objectAnimation', scene: 's1', targets: ['куар'], techniques: ['scaleIn'], parameters: [{ key: 'scaleFrom', value: 1 }, { key: 'scaleTo', value: .5 }], constraints: [], unresolvedReason: null }, ...[0, 1].map(i => ({ actionId: 'ribbon' + i, clauseId: 'c' + (i + 2), kind: 'objectAnimation', scene: 's2', targets: ['лента ' + (i + 1)], techniques: ['trimPath'], parameters: [], ...(i ? { dependsOn: 'ribbon0', inheritFrom: 'ribbon0' } : {}), constraints: [], unresolvedReason: null })), { actionId: 'text', clauseId: 'c4', kind: 'objectAnimation', scene: 's1', targets: ['Абонементы на любимую еду и напитки'], techniques: ['slideUp', 'fadeIn', 'inertialOvershoot'], parameters: [{ key: 'text', value: { segmentation: 'line', timing: 'staggered', staggerFrames: 2, reverse: false, origin: 'local' } }, { key: 'easing', value: 'easeInOutCubic' }], constraints: [], unresolvedReason: null }], assumptions: [] };
    const { agentContext } = await import('../src/harness/context.js');
    const { harnessConfig } = await import('../src/harness/config.js');
    const full = (await agentContext(f.project, f.state, { request }, [], await harnessConfig(f.project.root))).value;
    // Repeated relevant capability contracts simulate the archived >68KB request.
    const context = { ...full, motionKnowledge: { ...full.motionKnowledge, techniques: largeContext().motionKnowledge.techniques } };
    const stop = registerProvider(adapter.id, () => ({ ...adapter, generate: async (req) => { calls++; assert.ok(serializedRequestBytes(req) <= 60000); const wire = JSON.parse(req.messages.find(m => m.role === 'user')!.content); assert.equal(wire.userRequest, request); const original = unpackContext(wire.context) as typeof context; assert.deepEqual(original.objectIndex, context.objectIndex); assert.deepEqual(original.logicalObjects, JSON.parse(JSON.stringify(semanticContext(context))).logicalObjects); return { output: graph, usage: null, estimatedCost: null, latencyMs: 0, diagnostics: ['mock semantic output, real production planning/admission/compiler'], toolCalls: [] }; } }));
    const run = await HarnessRun.start(f.project, randomUUID(), request, adapter.id, '');
    try {
        const provider = new SemanticProvider(async () => { const dir = path.join(run.directory, 'provider'); await mkdir(dir, { recursive: true }); return new CodexProvider({ provider: adapter.id, model: '' }, dir, run.providerRuntime()); });
        const plan = await semanticPlan(f.project, request, context, provider, async () => { }, { auditAlways: false, maxAttempts: 2, motionState: f.state });
        assert.equal(calls, 1);
        assert.equal(plan.requirements.length, 5);
        assert.deepEqual(plan.requirements.find(r => r.target.name === 'image 1926988171')!.parameters.easing, { type: 'cubicBezier', parameters: { x1: .85, y1: 0, x2: .15, y2: 1 } });
        assert.equal(plan.requirements.find(r => r.target.name === 'лента 2')!.timing.anchorRequirementId, plan.requirements.find(r => r.target.name === 'лента 1')!.requirementId);
        assert.ok(plan.requirements.filter(r => r.techniques.includes('inertialOvershoot')).every(r => r.techniques.includes('fadeIn') && r.techniques.includes('slideUp')));
        const tasks = compileTasks(f.project, plan);
        assert.equal(tasks.length, 5);
        assert.ok(tasks.every(t => t.targetReference?.targetId));
        assert.ok(run.calls[0].inputBudget!.totalBytes <= 60000);
    }
    finally {
        stop();
        await run.finish('SUCCESS');
        await f.cleanup();
    }
});
