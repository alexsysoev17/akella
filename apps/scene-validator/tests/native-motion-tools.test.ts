import test from "node:test";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { semanticGraphSchema } from "../src/motion/intent/graph.js";
import { identityFixture, node } from "./identity-fixture.js";
import { objectRequirement } from "./intent-fixture.js";
import { registerProvider } from "../src/harness/providers/index.js";
import { executeMotion } from "../src/motion/service.js";
import { readMotion, changeMotion } from "../src/motion/store.js";
import { lowerMotionTool, prepareMotionTools, inspectAnimations } from "../src/motion/tools.js";
import { renderProjectFrame } from "../src/native/service.js";
import { renderNativeFrame, closeNativeRenderer } from "../src/native/client.js";
import { exportVideo } from "../src/motion/video.js";
import { interpolateState, presentedTransitions } from "../src/motion/transition-runtime.js";
import { statePresentation } from "../src/motion/transitions.js";
import { applyOperations } from "../src/motion/operations.js";
import { logicalId } from "../src/motion/registry.js";
process.env.AKELLA_RENDERER = "native";
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function graph(prompt: string, technique: string, kind = "objectAnimation", parameters: { key: string; value: string | number }[] = [], extra: object = {}) {
  return { schemaVersion: "semantic-graph/1.0", clauses: [{ clauseId: "c", text: prompt }], actions: [{ actionId: "a", clauseId: "c", kind, scene: "s0", targets: ["c0"], techniques: [technique], parameters, constraints: [], unresolvedReason: null, ...extra }], assumptions: [] };
}
async function circleFixture() {
  const f = await identityFixture(2, scenes => {
    scenes.forEach((s, i) => { const c = node("c" + i, "Circle", i ? 135 : 25, i ? 65 : 25, 24, 24); c.type = "ELLIPSE"; s.children = [c]; });
  });
  f.state.settings.fps = 12; f.state.settings.durationFrames = 48;
  f.state.blocks.forEach((b, i) => { b.startFrame = i * 24; b.durationFrames = 24; });
  let doc = await readMotion(f.project);
  await changeMotion(f.project.root, { expectedRevision: doc.revision, request: "synthetic fixture", operations: [{ type: "setProjectSettings", settings: f.state.settings }, { type: "setBlocks", blocks: f.state.blocks }] });
  return f;
}

test("AI semantic graph → typed motion tools → atomic state → native Preview/video, five-turn circle lifecycle", async () => {
  const f = await circleFixture();
  let response: unknown, calls = 0;
  const stop = registerProvider("circle-tools-fixture", () => ({ id: "circle-tools-fixture", mode: "mock", capabilities: () => ({ structuredOutput: true, nativeToolCalling: false, cancellation: true, usage: false, nativeOutputTokenLimit: false }), generate: async () => { calls++; return { output: response, usage: null, estimatedCost: null, latencyMs: 0, diagnostics: ["mock semantics; real native execution/QA/render/FFmpeg"], toolCalls: [] }; } }));
  const turn = async (prompt: string, output: unknown, expectedCalls=1) => {
    response = output; const before = await readMotion(f.project), previousCalls = calls;
    const result = await executeMotion(f.project, { mode: "edit", request: prompt, selectedObjectId: "c0", activeSceneId: "s0", expectedRevision: before.revision, settings: { provider: "circle-tools-fixture", model: "" } }, () => {}, { config: { maxLLMCalls: 1, maxRepairAttempts: 0 } });
    assert.equal(result.reconciliation?.status, "SUCCESS", JSON.stringify(result.reconciliation));
    assert.equal(calls - previousCalls, expectedCalls);
    const tasks = JSON.parse(await readFile(path.join(f.project.root, "motion/ai", result.id, "tasks.json"), "utf8"));
    assert.ok(tasks.tasks.every((t: { compilationSource: string }) => t.compilationSource === "validated-preflight"));
    const after = await readMotion(f.project);
    assert.equal(after.cursor, before.cursor + 1, "one Undo transaction per user instruction");
    return after;
  };
  try {
    const prompt = "Переведи Circle из первого состояния во второе за одну секунду линейно, начиная с нулевого кадра.";
    let doc = await turn(prompt, graph(prompt, "objectStateTransition", "objectAnimation", [{ key: "fromSceneId", value: "s0" }, { key: "toSceneId", value: "s1" }, { key: "durationSeconds", value: 1 }, { key: "easing", value: "linear" }], { start: { unit: "frames", value: 0 } }));
    const linear = structuredClone(doc.state.objectTransitions![0]);
    assert.equal(linear.durationFrames, 12); assert.equal(linear.startFrame, 0);
    assert.equal(linear.timelinePolicy, "referenceStates");
    assert.equal(doc.state.blocks[1].startFrame, 24, "Figma reference states do not move video blocks");
    const preview0 = await renderProjectFrame(f.project, 0, { encoding: "rgba" });
    const preview12 = await renderProjectFrame(f.project, 12, { encoding: "rgba" });
    const held = await renderProjectFrame(f.project, 20, { encoding: "rgba" });
    assert.notDeepEqual(preview0.png, preview12.png); assert.deepEqual(held.png, preview12.png);
    const p = statePresentation(f.project, doc.state)[linear.logicalObjectId];
    const midpoint = interpolateState(p.s0, p.s1, linear, 6).matrix;
    assert.equal(midpoint[0][2], (p.s0.normalized[0][2] + p.s1.normalized[0][2]) / 2);
    const easing = "Измени только easing перехода Circle на easeInOutCubic.";
    doc = await turn(easing, graph(easing, "objectStateTransition", "editAnimation", [{ key: "easing", value: "easeInOutCubic" }], { effectOperation: { storage: "animation", action: "update" } }));
    assert.deepEqual(doc.state.objectTransitions![0], { ...linear, easing: "easeInOutCubic" });
    const base = structuredClone(doc.state.objectTransitions);
    const add = "Добавь Circle непрерывный плавный Wiggle на весь ролик.";
    doc = await turn(add, graph(add, "wiggle", "objectAnimation", [{ key: "lifetime", value: "project" }, { key: "amplitude", value: 3 }, { key: "frequency", value: .8 }]));
    assert.deepEqual(doc.state.objectTransitions, base);
    assert.equal(doc.state.expressions?.length, 2);
    assert.ok(doc.state.expressions!.every(e => e.transitionId === linear.transitionId));
    const animated = await renderProjectFrame(f.project, 47, { encoding: "rgba" });
    const without = await renderNativeFrame(f.project, { ...doc.state, expressions: [] }, 47, { encoding: "rgba" });
    assert.notDeepEqual(animated.png, without.png, "continuous Wiggle visible through the final project frame");
    const video = await exportVideo(f.project.root, () => {}, { renderer: "native" });
    assert.ok("frameDigests" in video);
    assert.equal(video.frameDigests.find(d => d.frame === 47)?.sha256, hash(animated.png));
    const ffmpeg: unknown = createRequire(import.meta.url)("ffmpeg-static");
    assert.equal(typeof ffmpeg, "string");
    const decoded = (await promisify(execFile)(ffmpeg as string, ["-v", "error", "-i", path.join(f.project.root, "renders", video.file), "-vf", "select=eq(n\\,47)", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { encoding: "buffer", maxBuffer: 2 * 1024 * 1024 })).stdout;
    assert.equal(decoded.byteLength, animated.png.byteLength);
    const meanError = decoded.reduce((n, v, i) => n + Math.abs(v - animated.png[i]), 0) / decoded.length;
    assert.ok(meanError < 4, `decoded native MP4 differs by ${meanError}/255`);

    const old = structuredClone(doc.state.expressions);
    const weaker = "Уменьши амплитуду Wiggle Circle вдвое.";
    const edit = objectRequirement("r", "s0", "c0", "Circle", ["wiggle"], weaker);
    edit.kind = "editAnimation"; edit.sceneId = null;
    edit.target = { sourceNodeId: null, logicalObjectId: logicalId("Circle"), name: "Circle" };
    edit.selector = { type: "explicitObject", effect: "wiggle" };
    edit.effectOperation = { storage: "expression", action: "update" }; edit.parameters.amplitudeFactor = .5;
    edit.timing.relation = "unchanged";
    doc = await turn(weaker, { schemaVersion: "1.0.0", requirements: [edit], coverage: [{ sourceText: weaker, requirementIds: ["r"], classification: "executable", explanation: "live-provider selector shape" }], assumptions: [] },0);
    assert.deepEqual(doc.state.objectTransitions, base);
    assert.deepEqual(doc.state.expressions, old!.map(e => ({ ...e, parameters: { ...e.parameters, amplitude: 1.5 } })));
    const remove = "Удали только Wiggle Circle, сохрани переход.";
    doc = await turn(remove, graph(remove, "wiggle", "editAnimation", [], { expressionAction: "remove", effectOperation: { storage: "expression", action: "remove" }, relation: "unchanged" }));
    assert.deepEqual(doc.state.objectTransitions, base); assert.equal(doc.state.expressions!.length, 0);
    assert.equal(doc.state.animations.length, 0, "easing/effects never create a replacement position track");
    const undo = await changeMotion(f.project.root, { expectedRevision: doc.revision, request: "Undo", action: "undo" });
    assert.equal(undo.document.state.expressions?.length, 2);
    const redo = await changeMotion(f.project.root, { expectedRevision: undo.document.revision, request: "Redo", action: "redo" });
    assert.deepEqual(redo.document.state, doc.state);
    console.log(JSON.stringify({ mockProviderCalls: calls, turns: 5, realNativeQA: true, ffmpegFrames: video.frames, finalFrameDigest: hash(animated.png), originalProject: "synthetic-only" }));
  } finally { stop(); await closeNativeRenderer(); await f.cleanup(); }
});

test("typed tools accept global intervals, reject invalid durations atomically and extend output only explicitly", async () => {
  const f = await circleFixture();
  try {
    const doc = await readMotion(f.project), t = { transitionId: "t", logicalObjectId: logicalId("Circle"), fromSceneId: "s0", toSceneId: "s1", startFrame: 0, durationFrames: 60, easing: "linear" as const, timelinePolicy: "referenceStates" as const, proceduralEffects: [], layerPolicy: { type: "switch" as const, switchProgress: 1 } };
    const old = structuredClone(doc.state);
    const outside=prepareMotionTools(f.project,doc.state,[{tool:"createStateTransition",transition:t}]);
    assert.ok(outside.ok);assert.equal(outside.candidate.settings.durationFrames,doc.state.settings.durationFrames);
    const failed=prepareMotionTools(f.project,doc.state,[{tool:"createStateTransition",transition:{...t,durationFrames:0}}]);
    assert.equal(failed.ok,false);assert.deepEqual(doc.state,old);
    const success = prepareMotionTools(f.project, doc.state, [{ tool: "adjustTimeline", policy: "extendProject", durationFrames: 61 }, { tool: "createStateTransition", transition: t }]);
    assert.ok(success.ok); assert.equal(success.candidate.settings.durationFrames, 61);
    assert.equal(inspectAnimations(f.project, success.candidate).find(e => e.id === "t")?.composition, "state");
    const { timelinePolicy, ...legacy } = { ...t, durationFrames: 12 };
    assert.equal(applyOperations(doc.state, [{type:"animateObjectStateTransition",...legacy}],f.project).objectTransitions![0].durationFrames,12);
    const independent = applyOperations(doc.state, lowerMotionTool(f.project, doc.state, { tool: "createStateTransition", transition: { ...t, durationFrames: 12 } }), f.project);
    assert.equal(presentedTransitions(independent, 40)[0].transitionId, "t");
    const withLaterScene = { ...independent, blocks: [...independent.blocks, { ...independent.blocks[0], blockId: "later", sceneId: "unrelated", startFrame: 36, durationFrames: 12 }] };
    assert.equal(presentedTransitions(withLaterScene,40).length,1,"logical pose persists; native rendering detaches its subtree from unrelated scene backgrounds");
    const noTargetBlock = { ...doc.state, blocks: [{ ...doc.state.blocks[0], durationFrames: 48 }] };
    const referencesOnly = applyOperations(noTargetBlock, lowerMotionTool(f.project, noTargetBlock, { tool: "createStateTransition", transition: { ...t, durationFrames: 12 } }), f.project);
    const referenceFrame = await renderNativeFrame(f.project, referencesOnly, 40, { encoding: "rgba" });
    const scheduledFrame = await renderNativeFrame(f.project, independent, 40, { encoding: "rgba" });
    assert.deepEqual(referenceFrame.png, scheduledFrame.png, "the target Figma state needs no video timeline block");
    assert.equal(referencesOnly.blocks.length, 1);

  } finally { await f.cleanup(); }
});


test("semantic enum parameters are advertised from canonical schemas, preventing intensity/lifetime schema drift", () => {
  const prompt = "Circle очень сильная инерция";
  assert.ok(semanticGraphSchema.safeParse(graph(prompt, "inertialOvershoot", "objectAnimation", [{ key: "intensity", value: "veryStrong" }])).success);
  assert.equal(semanticGraphSchema.safeParse(graph(prompt, "inertialOvershoot", "objectAnimation", [{ key: "intensity", value: "extreme-unregistered" }])).success, false);
  assert.equal(semanticGraphSchema.safeParse(graph(prompt, "wiggle", "objectAnimation", [{ key: "lifetime", value: "unbounded" }])).success, false);
});

test("cross-scene identity and additive transition inertia persist through nine production turns", async () => {
  const f = await circleFixture();
  let response: unknown;
  const stop = registerProvider("cross-circle", () => ({ id: "cross-circle", mode: "mock", capabilities: () => ({ structuredOutput: true, nativeToolCalling: false, cancellation: true, usage: false, nativeOutputTokenLimit: false }), generate: async () => ({ output: response, usage: null, estimatedCost: null, latencyMs: 0, diagnostics: ["prepared semantics; production execution and native QA"], toolCalls: [] }) }));
  const turn = async (prompt: string, output: unknown) => {
    response = output; const before = await readMotion(f.project);
    const result = await executeMotion(f.project, { mode: "edit", request: prompt, expectedRevision: before.revision, settings: { provider: "cross-circle", model: "" } }, () => {}, { config: { maxLLMCalls: 1, maxRepairAttempts: 0 } });
    assert.equal(result.reconciliation?.status, "SUCCESS", JSON.stringify(result.reconciliation));
    const after = await readMotion(f.project); assert.equal(after.cursor, before.cursor + 1); return after;
  };
  const action = (prompt: string, technique: string, kind: string, parameters: { key: string; value: string | number }[] = [], extra: object = {}) => graph(prompt, technique, kind, parameters, { scene: null, targets: ["Circle"], targetScope: "logicalObject", ...extra });
  try {
    let text = "Circle в начале видео за секунду перемещается в положение как на сцене 2 - анимация линейная";
    let doc = await turn(text, action(text, "objectStateTransition", "objectAnimation", [{ key: "durationSeconds", value: 1 }, { key: "easing", value: "linear" }, { key: "toSceneId", value: "s1" }], { scene: "s0", targets: ["c0"], start: { unit: "frames", value: 0 } }));
    const base = structuredClone(doc.state.objectTransitions![0]);
    for (const easing of ["easeInOutCubic", "linear"]) {
      text = easing === "linear" ? "пусть Circle двигается линейно" : "сделай очень медленное начало и конец, резко в середине";
      doc = await turn(text, action(text, "objectStateTransition", "editAnimation", [{ key: "easing", value: easing }], { effectOperation: { storage: "transition", action: "update" } }));
      assert.deepEqual(doc.state.objectTransitions, [{ ...base, easing }]);
    }
    text = "добавь затухающие колебания после конца движения";
    doc = await turn(text, action(text, "inertialOvershoot", "objectAnimation", [], { temporalReference: { kind: "existingAnimation", target: { name: "Circle" }, effect: "objectStateTransition", endpoint: "end" } }));
    assert.equal(doc.state.expressions!.length, 2);
    assert.ok(doc.state.expressions!.every(e => e.type === "inertialOvershoot" && e.startFrame === 12 && e.transitionId === base.transitionId));
    const before = structuredClone(doc.state.expressions!);
    text = "сделай колебания сильнее";
    doc = await turn(text, action(text, "inertialOvershoot", "editAnimation", [{ key: "amplitudeFactor", value: 1.6 }], { selector: { type: "recentSuccessfulTargets", effect: "inertialOvershoot" }, effectOperation: { storage: "expression", action: "update" }, relation: "unchanged" }));
    assert.deepEqual(doc.state.expressions!.map(e => e.expressionId), before.map(e => e.expressionId));
    assert.ok(doc.state.expressions!.every((e, i) => e.parameters.amplitude === before[i].parameters.amplitude * 1.6));
    const inertia = structuredClone(doc.state.expressions);
    text = "добавь к Circle эффект wiggle";
    doc = await turn(text, action(text, "wiggle", "objectAnimation"));
    const wiggles = doc.state.expressions!.filter(e => e.type === "wiggle");
    assert.equal(wiggles.length, 2); assert.ok(wiggles.every(e => e.ownership?.scope === "logicalObject" && e.durationFrames === 48));
    const { evaluateMotion } = await import("../src/motion/evaluation.js");
    const presentation = statePresentation(f.project, doc.state);
    for (const frame of [11, 23, 24, 28, 47]) {
      const evaluated = evaluateMotion(doc.state, frame, presentation).transitionEffects[base.transitionId];
      assert.ok(Number.isFinite(evaluated.x) && Number.isFinite(evaluated.y));
      const image = await renderNativeFrame(f.project, doc.state, frame, { encoding: "rgba" });
      const plain = await renderNativeFrame(f.project, { ...doc.state, expressions: inertia }, frame, { encoding: "rgba" });
      assert.notDeepEqual(image.png, plain.png, `Wiggle is visible at ${frame}`);
      assert.deepEqual(image.png, (await renderNativeFrame(f.project, doc.state, frame, { encoding: "rgba" })).png);
    }
    const { scopedExpressionValue } = await import("../src/motion/transition-effects.js");
    for (const e of doc.state.expressions!) assert.ok(Math.abs(scopedExpressionValue(doc.state, e, 24 - 1e-5, presentation) - scopedExpressionValue(doc.state, e, 24 + 1e-5, presentation)) < .001);
    const originalWiggles=structuredClone(wiggles);
    text = "сделай wiggle медленнее и слабее";
    doc = await turn(text, action(text, "wiggle", "editAnimation", [{ key: "frequencyFactor", value: .5 }, { key: "amplitudeFactor", value: .5 }], { effectOperation: { storage: "expression", action: "update" }, relation: "unchanged" }));
    assert.deepEqual(doc.state.expressions!.filter(e => e.type === "inertialOvershoot"), inertia);
    for(const e of doc.state.expressions!.filter(e=>e.type==="wiggle")){const old=originalWiggles.find(x=>x.expressionId===e.expressionId)!;assert.equal(e.parameters.amplitude,old.parameters.amplitude*.5);if(e.type==="wiggle"&&old.type==="wiggle")assert.equal(e.parameters.frequency,old.parameters.frequency*.5);}
    text = "убери wiggle, но сохрани всю остальную анимацию";
    doc = await turn(text, action(text, "wiggle", "editAnimation", [], { effectOperation: { storage: "expression", action: "remove" }, relation: "unchanged" }));
    assert.deepEqual(doc.state.expressions, inertia); assert.deepEqual(doc.state.objectTransitions, [base]);
    text = "пусть Circle двигается линейно также пусть у него будут затухающие колебания инерция после конца движения";
    const compound = action(text, "objectStateTransition", "editAnimation", [{ key: "easing", value: "linear" }], { effectOperation: { storage: "transition", action: "update" } });
    compound.actions.push({ ...compound.actions[0], actionId: "post", techniques: ["inertialOvershoot"], kind: "objectAnimation", parameters: [], effectOperation: undefined, relation: "afterRequirement", dependsOn: "a" } as typeof compound.actions[number]);
    doc = await turn(text, compound);
    assert.equal(doc.state.expressions!.length, 2); assert.deepEqual(doc.state.objectTransitions, [base]);
    const video = await exportVideo(f.project.root, () => {}, { renderer: "native" });
    assert.ok("frameDigests" in video);
    const image = await renderNativeFrame(f.project, doc.state, 24, { encoding: "rgba" });
    assert.equal(video.frameDigests.find(d => d.frame === 24)?.sha256, hash(image.png));
  } finally { stop(); await closeNativeRenderer(); await f.cleanup(); }
});

test("logical ownership validates source identity, preserves absolute noise phase without transitions and retimes transition inertia", async () => {
  const f = await circleFixture();
  try {
    let doc = await readMotion(f.project);
    const effect = { expressionId: "logical-noise", sceneId: "s0", targetId: "c0", type: "wiggle" as const, property: "x" as const, startFrame: 0, durationFrames: 48, enabled: true, ownership: { scope: "logicalObject" as const, logicalObjectId: logicalId("Circle") }, parameters: { amplitude: 5, frequency: .7, seed: 42, temporalMode: "continuous" as const } };
    const state = applyOperations(doc.state, [{ type: "setExpression", expression: effect }], f.project);
    const { evaluateMotion } = await import("../src/motion/evaluation.js");
    const p = statePresentation(f.project, state);
    for (const frame of [0, 23, 24, 47]) {
      const values = evaluateMotion(state, frame, p).nodes;
      assert.equal(values['["s0","c0"]'].x, values['["s1","c1"]'].x, "one owner and one global noise phase");
      const animated = await renderNativeFrame(f.project, state, frame, { encoding: "rgba" });
      const original = await renderNativeFrame(f.project, doc.state, frame, { encoding: "rgba" });
      assert.notDeepEqual(animated.png, original.png);
    }
    assert.throws(() => applyOperations(doc.state, [{ type: "setExpression", expression: { ...effect, ownership: { ...effect.ownership, logicalObjectId: "unknown" } } }], f.project), /EFFECT_OWNER_MISMATCH/);
    const t = { transitionId: "test-base", timelinePolicy: "referenceStates" as const, logicalObjectId: logicalId("Circle"), fromSceneId: "s0", toSceneId: "s1", startFrame: 0, durationFrames: 12, easing: "linear" as const, proceduralEffects: [], layerPolicy: { type: "switch" as const, switchProgress: 1 } };
    let withInertia = applyOperations(doc.state, [{ type: "animateObjectStateTransition", ...t }, { type: "setExpression", expression: { expressionId: "inertia", transitionId: t.transitionId, ownership: { scope: "transition", logicalObjectId: t.logicalObjectId }, sceneId: "s0", targetId: "c0", type: "inertialOvershoot", property: "x", sourceAnimationId: t.transitionId, startFrame: 12, durationFrames: 14, enabled: true, parameters: { mode: "ae", amplitude: .25, frequency: 2.5, decay: 3, velocityLookbackFrames: 6 } } }], f.project);
    const original = structuredClone(withInertia);
    withInertia = applyOperations(withInertia, lowerMotionTool(f.project, withInertia, { tool: "updateAnimation", animationId: t.transitionId, patch: { durationFrames: 18 } }), f.project);
    assert.equal(withInertia.expressions![0].startFrame, 18);
    assert.equal(original.expressions![0].startFrame, 12);
    const { timelinePolicy, ...legacyTransition } = { ...t, startFrame: 18 };
    const legacyEffect = { ...original.expressions![0], startFrame: 30 };
    const legacyState = applyOperations(doc.state, [{ type: "animateObjectStateTransition", ...legacyTransition }, { type: "setExpression", expression: legacyEffect }], f.project);
    assert.ok(presentedTransitions(legacyState, 32).length, "legacy reference transition remains presented during attached inertia");
    const legacyPixels = await renderNativeFrame(f.project, legacyState, 32, { encoding: "rgba" });
    const legacyBase = await renderNativeFrame(f.project, { ...legacyState, expressions: [] }, 32, { encoding: "rgba" });
    assert.notDeepEqual(legacyPixels.png, legacyBase.png);
    assert.throws(() => applyOperations(withInertia, [{ type: "removeObjectStateTransition", transitionId: t.transitionId }], f.project), /DEPENDENT_EXPRESSION/);
  } finally { await closeNativeRenderer(); await f.cleanup(); }
});

test("global preflight: exact retime, unchanged output window, dependent deletion, undo and recreation", async () => {
  const f = await circleFixture(); let response: unknown;
  const stop = registerProvider("recover-circle", () => ({ id: "recover-circle", mode: "mock", capabilities: () => ({ structuredOutput: true, nativeToolCalling: false, cancellation: true, usage: false, nativeOutputTokenLimit: false }), generate: async () => ({ output: response, usage: null, estimatedCost: null, latencyMs: 0, diagnostics: ["mock semantics, real execution"], toolCalls: [] }) }));
  const turn = async (prompt: string, technique: string, kind: string, parameters: {key:string;value:string|number}[] = [], extra: object = {}, fixed = false) => {
    response = { ...graph(prompt, technique, kind, parameters, { scene: "s0", targets: ["c0"], targetScope: "logicalObject", ...extra }), ...(fixed ? { timelineExtension: "fixed" } : {}) };
    const before = await readMotion(f.project);
    const result = await executeMotion(f.project, { mode:"edit", request:prompt, expectedRevision:before.revision, settings:{provider:"recover-circle",model:""} }, () => {}, {config:{maxLLMCalls:1,maxRepairAttempts:0}});
    assert.equal(result.reconciliation?.status,"SUCCESS",await readFile(path.join(f.project.root,"motion/ai",result.id,"tasks.json"),"utf8"));
    const doc = await readMotion(f.project); assert.equal(doc.cursor,before.cursor+1); return {doc,run:result.id};
  };
  try {
    await turn("Circle движется линейно за секунду", "objectStateTransition", "objectAnimation", [{key:"durationSeconds",value:1},{key:"easing",value:"linear"},{key:"toSceneId",value:"s1"}], {start:{unit:"frames",value:0}});
    await turn("Circle поменяй только easing", "objectStateTransition", "editAnimation", [{key:"easing",value:"easeInCubic"}], {effectOperation:{storage:"transition",action:"update"}});
    await turn("Circle добавь инерцию после движения", "inertialOvershoot", "objectAnimation");
    const before = await readMotion(f.project), blocks = structuredClone(before.state.blocks);
    const timing = { start:{unit:"seconds",value:1}, effectOperation:{storage:"transition",action:"updateTiming"} };
    await assert.rejects(changeMotion(f.project.root,{expectedRevision:before.revision,request:"invalid zero duration",operations:[{type:"animateObjectStateTransition",...before.state.objectTransitions![0],durationFrames:0}]}));
    assert.deepEqual((await readMotion(f.project)).state,before.state);
    const moved = await turn("Circle движение с 1 до 3 секунд", "objectStateTransition", "editAnimation", [{key:"durationSeconds",value:2}], timing, true);
    assert.equal(moved.doc.state.objectTransitions![0].startFrame,12); assert.equal(moved.doc.state.objectTransitions![0].durationFrames,24);
    assert.ok(moved.doc.state.expressions!.every(e=>e.startFrame===36));
    assert.equal(moved.doc.state.settings.durationFrames,48); assert.deepEqual(moved.doc.state.blocks,blocks);
    const last = moved.doc.state.settings.durationFrames - 1;
    const tail = await renderProjectFrame(f.project,last,{encoding:"rgba"});
    assert.ok(tail.hits.some(h=>h.targetId==="c1"),"extended tail holds the actual destination object");
    const video = await exportVideo(f.project.root,()=>{},{renderer:"native"});assert.ok("frameDigests" in video);assert.equal(video.frames,moved.doc.state.settings.durationFrames);assert.equal(video.frameDigests.find(d=>d.frame===last)?.sha256,hash(tail.png));
    const report = JSON.parse(await readFile(path.join(f.project.root,"motion/ai",moved.run,"compilation-preflight.json"),"utf8"));
    assert.equal(report.classification,"VALID"); assert.equal(report.recoveries.length,0);
    await turn("Circle инерция вдвое слабее", "inertialOvershoot", "editAnimation", [{key:"amplitudeFactor",value:.5}], {effectOperation:{storage:"expression",action:"update"},relation:"unchanged"});
    await turn("Circle добавь wiggle", "wiggle", "objectAnimation");
    await turn("Circle wiggle слабее", "wiggle", "editAnimation", [{key:"amplitudeFactor",value:.5}], {effectOperation:{storage:"expression",action:"update"},relation:"unchanged"});
    await turn("Circle убери wiggle", "wiggle", "editAnimation", [], {effectOperation:{storage:"expression",action:"remove"},relation:"unchanged"});
    const removed = await turn("Circle убери всю анимацию вместе с инерцией", "objectStateTransition", "editAnimation", [], {effectOperation:{storage:"transition",action:"remove"},dependentPolicy:"removeDependents"});
    assert.equal(removed.doc.state.objectTransitions!.length,0); assert.equal(removed.doc.state.expressions!.length,0);
    const image = await renderProjectFrame(f.project,0,{encoding:"rgba"}); assert.ok(image.hits.some(h=>h.targetId==="c0"),"Figma object is not deleted");
    const undo = await changeMotion(f.project.root,{expectedRevision:removed.doc.revision,request:"Undo",action:"undo"});
    assert.equal(undo.document.state.objectTransitions!.length,1); assert.ok(undo.document.state.expressions!.length);
    await changeMotion(f.project.root,{expectedRevision:undo.document.revision,request:"Redo",action:"redo"});
    await turn("Circle снова линейное движение за секунду", "objectStateTransition", "objectAnimation", [{key:"durationSeconds",value:1},{key:"toSceneId",value:"s1"},{key:"easing",value:"linear"}],{start:{unit:"frames",value:0}});
  } finally { stop();await closeNativeRenderer();await f.cleanup(); }
});

test("one bounded agent tool decision repairs a stale unsupported transition-removal interpretation", async () => {
  const f = await circleFixture(); let calls=0;
  let doc=await readMotion(f.project);
  const transition={transitionId:"agent-base",logicalObjectId:logicalId("Circle"),fromSceneId:"s0",toSceneId:"s1",timelinePolicy:"referenceStates" as const,startFrame:0,durationFrames:12,easing:"linear" as const,proceduralEffects:[],layerPolicy:{type:"switch" as const,switchProgress:1}};
  await changeMotion(f.project.root,{expectedRevision:doc.revision,request:"Fixture base",operations:[{type:"animateObjectStateTransition",...transition}]});
  const prompt="убери анимацию у Circle";
  const legacy=graph(prompt,"objectStateTransition","unsupported",[],{scene:null,targets:["Circle"],targetScope:"logicalObject",unresolvedReason:"objectTransition removal unavailable in old capability contract"});
  const stop=registerProvider("recover-decision",()=>({id:"recover-decision",mode:"mock",capabilities:()=>({structuredOutput:true,nativeToolCalling:false,cancellation:true,usage:false,nativeOutputTokenLimit:false}),generate:async()=>({output:++calls===1?legacy:{action:"removeAnimation",dependentPolicy:"removeDependents",reason:"User explicitly requested removing this object's motion"},usage:null,estimatedCost:null,latencyMs:0,diagnostics:["prepared semantic and tool decision"],toolCalls:[]})}));
  try {
    doc=await readMotion(f.project);
    const result=await executeMotion(f.project,{mode:"edit",request:prompt,expectedRevision:doc.revision,settings:{provider:"recover-decision",model:""}},()=>{},{config:{maxLLMCalls:2,maxRepairAttempts:1}});
    assert.equal(result.reconciliation?.status,"SUCCESS",JSON.stringify(result)); assert.equal(calls,2);
    const after=await readMotion(f.project);assert.equal(after.state.objectTransitions!.length,0);assert.equal(after.cursor,doc.cursor+1);
    const decision=JSON.parse(await readFile(path.join(f.project.root,"motion/ai",result.id,"preflight-resolution.json"),"utf8"));assert.equal(decision.action,"removeAnimation");
  } finally {stop();await closeNativeRenderer();await f.cleanup();}
});

test("compound entrance retiming and inertia edit preserve IDs, start and unrelated motion through production execution", async () => {
  const f = await circleFixture();
  let response: unknown;
  const stop = registerProvider("compound-edit-fixture", () => ({ id: "compound-edit-fixture", mode: "mock", capabilities: () => ({ structuredOutput: true, nativeToolCalling: false, cancellation: true, usage: false, nativeOutputTokenLimit: false }), generate: async () => ({ output: response, usage: null, estimatedCost: null, latencyMs: 0, diagnostics: ["prepared semantics"], toolCalls: [] }) }));
  async function turn(prompt: string, output: unknown) {
    response = output;
    const before = await readMotion(f.project);
    const result = await executeMotion(f.project, { mode: "edit", request: prompt, expectedRevision: before.revision, settings: { provider: "compound-edit-fixture", model: "" } }, () => {}, { config: { maxLLMCalls: 1, maxRepairAttempts: 0 } });
    assert.equal(result.reconciliation?.status, "SUCCESS", JSON.stringify(result.reconciliation));
    return readMotion(f.project);
  }
  try {
    const create = "Circle появляется снизу через fade линейно с затухающей инерцией.";
    const initialGraph = graph(create, "slideUp", "objectAnimation", [{ key: "easing", value: "linear" }, { key: "durationSeconds", value: .5 }], { start: { unit: "frames", value: 3 } });
    initialGraph.actions[0].techniques = ["slideUp", "fadeIn", "inertialOvershoot"];
    let before = await turn(create, initialGraph);
    const slide = before.state.animations.find(a => a.effect === "slideUp")!;
    const fade = before.state.animations.find(a => a.effect === "fadeIn")!;
    await changeMotion(f.project.root, { expectedRevision: before.revision, request: "fixture synchronized timing dependency", operations: [{ type: "setTimingDependency", dependency: { dependencyId: "entrance-sync", animationId: fade.animationId, anchorAnimationId: slide.animationId, relation: "with", offsetFrames: 0 } }] });
    before = await readMotion(f.project);
    const prompt = "Появление Circle быстрее, колебания чуть слабее.";
    const edit = graph(prompt, "", "editAnimation", [{ key: "durationFactor", value: .8 }], { effectOperation: { storage: "animation", action: "updateTiming" } });
    edit.actions[0].techniques = [];
    edit.actions.push({ ...edit.actions[0], actionId: "b", techniques: ["inertialOvershoot"], parameters: [{ key: "amplitudeFactor", value: .8 }], effectOperation: { storage: "expression", action: "update" } } as typeof edit.actions[number]);
    const after = await turn(prompt, edit);
    assert.equal(after.cursor, before.cursor + 1);
    for (const track of before.state.animations) {
      assert.deepEqual(after.state.animations.find(a => a.animationId === track.animationId), { ...track, durationFrames: Math.round(track.durationFrames * .8) });
    }
    for (const effect of before.state.expressions ?? []) {
      const current = after.state.expressions!.find(e => e.expressionId === effect.expressionId)!;
      assert.equal(current.parameters.amplitude, Number(effect.parameters.amplitude) * .8);
      assert.deepEqual(current.parameters, { ...effect.parameters, amplitude: Number(effect.parameters.amplitude) * .8 });
      assert.equal(current.startFrame, 3 + Math.round(6 * .8));
    }
    assert.deepEqual(after.state.timingDependencies, before.state.timingDependencies);
    const finalFrame = after.state.settings.durationFrames - 1;
    const preview = await renderProjectFrame(f.project, finalFrame, { encoding: "rgba" });
    const video = await exportVideo(f.project.root, () => {}, { renderer: "native" });
    assert.ok("frameDigests" in video);
    assert.equal(video.frameDigests.find(d => d.frame === finalFrame)?.sha256, hash(preview.png));
  } finally { stop(); await closeNativeRenderer(); await f.cleanup(); }
});

test("completed transition hands off to neutral destination exit and scale phases, preserving native pixels", async () => {
  const f = await circleFixture();
  try {
    const doc = await readMotion(f.project);
    const base = applyOperations(doc.state, [{type:"animateObjectStateTransition",transitionId:"handoff",logicalObjectId:logicalId("Circle"),fromSceneId:"s0",toSceneId:"s1",timelinePolicy:"referenceStates",startFrame:0,durationFrames:12,easing:"linear",proceduralEffects:[],layerPolicy:{type:"switch",switchProgress:1}}], f.project);
    const exit = {animationId:"exit",sceneId:"s1",targetId:"c1",effect:"slideDown" as const,parameters:{distance:100,mode:"out" as const},startFrame:24,durationFrames:12,easing:"linear" as const,enabled:true};
    const candidate = applyOperations(base,[{type:"addAnimation",animation:exit}],f.project);
    const {nativeMotionQA}=await import("../src/native/qa.js");
    let renders=0;
    const qa=await nativeMotionQA(f.project,candidate,"motion/qa/handoff-incremental","Circle exits",base,{sceneId:"s1",targetId:"c1"},{beforeRender:()=>{renders++;}});
    assert.notEqual(qa.status,"FAILED",JSON.stringify(qa.checks));
    assert.deepEqual(qa.samples.map(s=>s.frame),[24,30,36],"raster samples cover changed interval, not old transition or project endpoints");
    assert.equal(renders,4,"three interval frames plus one uncached determinism replay against the actual saved sample; dense numerical QA is retained");
    assert.equal(qa.checks.find(c=>c.name==="NATIVE_RANDOM_ACCESS_DETERMINISM")?.status,"PASSED");
    assert.ok(qa.renderMetrics.reusedRequests>=1,"existing raster baseline is reused, not the independent replay");
    const removalQA=await nativeMotionQA(f.project,base,"motion/qa/handoff-removal","Remove exit",candidate,{sceneId:"s1",targetId:"c1"});
    assert.notEqual(removalQA.status,"FAILED");
    assert.deepEqual(removalQA.samples.map(s=>s.frame),[24,30,36],"removed effect interval is still rendered, not only output endpoints");
    const start = await renderNativeFrame(f.project,candidate,24,{encoding:"rgba"});
    const reference = await renderNativeFrame(f.project,base,24,{encoding:"rgba"});
    assert.deepEqual(start.png,reference.png,"handoff preserves exact arrival pose");
    const middle = await renderNativeFrame(f.project,candidate,30,{encoding:"rgba"});
    assert.notDeepEqual(middle.png,start.png,"post-transition movement is actually rendered");
    assert.deepEqual((await renderNativeFrame(f.project,candidate,24,{encoding:"rgba"})).png,start.png,"seek is deterministic");
    assert.throws(()=>applyOperations(base,[{type:"addAnimation",animation:{...exit,startFrame:6}}],f.project),/конфликтует/);
    assert.throws(()=>applyOperations(base,[{type:"addAnimation",animation:{...exit,parameters:{distance:100,mode:"in"}}}],f.project),/конфликтует/);
    const grow={...exit,animationId:"grow",effect:"scaleIn" as const,parameters:{from:1,to:1.3}};
    const back={...grow,animationId:"back",startFrame:36,parameters:{from:1.3,to:1}};
    const scaled=applyOperations(base,[{type:"addAnimation",animation:grow},{type:"addAnimation",animation:back}],f.project);
    assert.notDeepEqual((await renderNativeFrame(f.project,scaled,36,{encoding:"rgba"})).png,reference.png);
    assert.deepEqual((await renderNativeFrame(f.project,scaled,48,{encoding:"rgba"})).png,(await renderNativeFrame(f.project,base,48,{encoding:"rgba"})).png);
    const saved=await changeMotion(f.project.root,{expectedRevision:doc.revision,request:"transition then exit",operations:[{type:"animateObjectStateTransition",...base.objectTransitions![0]},{type:"addAnimation",animation:exit}]});
    assert.ok(saved.document.state.animations.some(a=>a.animationId==="exit"));
    const preview=await renderProjectFrame(f.project,30,{encoding:"rgba"});
    assert.deepEqual(preview.png,middle.png);
    const video=await exportVideo(f.project.root,()=>{},{renderer:"native"});
    assert.ok("frameDigests" in video);
    assert.equal(video.frameDigests.find(d=>d.frame===24)?.sha256,hash((await renderProjectFrame(f.project,24,{encoding:"rgba"})).png));
  } finally { await closeNativeRenderer(); await f.cleanup(); }
});
