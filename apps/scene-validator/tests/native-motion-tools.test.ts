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
  const turn = async (prompt: string, output: unknown) => {
    response = output; const before = await readMotion(f.project), previousCalls = calls;
    const result = await executeMotion(f.project, { mode: "edit", request: prompt, selectedObjectId: "c0", activeSceneId: "s0", expectedRevision: before.revision, settings: { provider: "circle-tools-fixture", model: "" } }, () => {}, { config: { maxLLMCalls: 1, maxRepairAttempts: 0 } });
    assert.equal(result.reconciliation?.status, "SUCCESS", JSON.stringify(result.reconciliation));
    assert.equal(calls - previousCalls, 1);
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
    doc = await turn(weaker, { schemaVersion: "1.0.0", requirements: [edit], coverage: [{ sourceText: weaker, requirementIds: ["r"], classification: "executable", explanation: "live-provider selector shape" }], assumptions: [] });
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

test("typed tools return structured timeline conflicts, preserve failed candidates, extend only explicitly and keep legacy transition rules", async () => {
  const f = await circleFixture();
  try {
    const doc = await readMotion(f.project), t = { transitionId: "t", logicalObjectId: logicalId("Circle"), fromSceneId: "s0", toSceneId: "s1", startFrame: 0, durationFrames: 60, easing: "linear" as const, timelinePolicy: "referenceStates" as const, proceduralEffects: [], layerPolicy: { type: "switch" as const, switchProgress: 1 } };
    const old = structuredClone(doc.state);
    const failed = prepareMotionTools(f.project, doc.state, [{ tool: "createStateTransition", transition: t }]);
    assert.equal(failed.ok, false); if (failed.ok) throw Error("must fail");
    assert.equal(failed.issue.code, "TIMELINE_CONFLICT"); assert.ok(failed.issue.allowedActions.includes("adjustTimeline"));
    assert.deepEqual(doc.state, old);
    const success = prepareMotionTools(f.project, doc.state, [{ tool: "adjustTimeline", policy: "extendProject", durationFrames: 61 }, { tool: "createStateTransition", transition: t }]);
    assert.ok(success.ok); assert.equal(success.candidate.settings.durationFrames, 61);
    assert.equal(inspectAnimations(f.project, success.candidate).find(e => e.id === "t")?.composition, "state");
    const { timelinePolicy, ...legacy } = { ...t, durationFrames: 12 };
    assert.throws(() => applyOperations(doc.state, [{ type: "animateObjectStateTransition", ...legacy }], f.project), /исходном блоке/);
    const independent = applyOperations(doc.state, lowerMotionTool(f.project, doc.state, { tool: "createStateTransition", transition: { ...t, durationFrames: 12 } }), f.project);
    assert.equal(presentedTransitions(independent, 40)[0].transitionId, "t");
    const withLaterScene = { ...independent, blocks: [...independent.blocks, { ...independent.blocks[0], blockId: "later", sceneId: "unrelated", startFrame: 36, durationFrames: 12 }] };
    assert.equal(presentedTransitions(withLaterScene, 40).length, 0, "presentation holds cannot suppress a later unrelated authored scene");
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
