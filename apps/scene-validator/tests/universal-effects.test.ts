import test from "node:test";
import assert from "node:assert/strict";
import { identityFixture, node } from "./identity-fixture.js";
import { objectRequirement } from "./intent-fixture.js";
import { validateIntentPlan } from "../src/motion/intent/planner.js";
import { compileTasks, compileRequirement } from "../src/motion/intent/compiler.js";
import { preflightIntentPlan } from "../src/motion/intent/execution.js";
import { applyOperations } from "../src/motion/operations.js";
import { evaluateMotion, evaluateAnimation } from "../src/motion/engine.js";
import { expressionValue } from "../src/motion/expressions.js";
import { validateExpressions } from "../src/motion/validate-expressions.js";
import { objectsIn } from "../src/motion/context.js";
import type { MotionState } from "../src/motion/schema.js";
import type { IntentPlan, IntentRequirement } from "../src/motion/intent/schema.js";
import { expressionRegistry } from "../src/motion-library/expressions/registry.js";
import { numericQA } from "../src/motion/qa/numeric.js";

async function fixture(count = 1) {
  const f = await identityFixture(count, scenes => {
    for (let i = 0; i < scenes.length; i++) scenes[i].children = [node(i ? (i === 1 ? "text-repeat" : "text-third") : "text", "Headline", 35, 20), node("parsley" + i, "петрушка 2", 80, 35)];
  });
  f.state.settings.durationFrames = count * 120;
  f.state.settings.fps = 30;
  f.state.blocks.forEach((b, i) => { b.startFrame = i * 120; b.durationFrames = 120; });
  f.state.animations = [{ animationId: "base", sceneId: "s0", targetId: "text", effect: "moveTo", startFrame: 0, durationFrames: 24, easing: "linear", enabled: true, parameters: { fromX: -40, toX: 0, fromY: 60, toY: 0 } }, { animationId: "fade", sceneId: "s0", targetId: "text", effect: "fadeIn", startFrame: 0, durationFrames: 24, easing: "linear", enabled: true, parameters: { from: 0, to: 1 } }];
  return f;
}
function plan(r: IntentRequirement): IntentPlan {
  return { schemaVersion: "1.0.0", requirements: [r], coverage: [{ sourceText: r.sourceText, requirementIds: [r.requirementId], classification: "executable", explanation: "fixture" }], assumptions: [] };
}
function execute(f: Awaited<ReturnType<typeof fixture>>, r: IntentRequirement, state = f.state) {
  const p = validateIntentPlan(f.project, r.sourceText, plan(r), 30, { state });
  preflightIntentPlan(f.project, state, p);
  let next = state;
  for (const task of compileTasks(f.project, p)) next = applyOperations(next, compileRequirement(f.project, next, p, task).operations, f.project);
  return next;
}
const request = (effects: IntentRequirement["techniques"], text = "Добавь эффект к Headline") => objectRequirement("r", "s0", "text", "Headline", effects, text);

test("existing motion resolution finds same logical animated instance, respects explicit scene/ID and rejects competing applicable instances", async () => {
  const f = await fixture(2);
  try {
    const r = objectRequirement("r", "s1", "text-repeat", "Headline", ["inertialOvershoot"], "Headline добавь очень сильные затухающие колебания");
    r.kind = "unsupported"; r.unresolvedReason = "BASE_POSITION_ANIMATION_MISSING";
    const events: unknown[] = [];
    const p = validateIntentPlan(f.project, r.sourceText, plan(r), 30, { state: f.state, selectedObjectId: "text-repeat", activeSceneId: "s1", onResolution: e => events.push(e) });
    assert.equal(p.requirements[0].target.sourceNodeId, "text");
    assert.equal(p.requirements[0].sceneId, "s0");
    assert.equal(p.requirements[0].parameters.intensity, "veryStrong");
    assert.match(JSON.stringify(events), /logical-existing-motion/);
    const task = compileTasks(f.project, p)[0];
    const next = applyOperations(f.state, compileRequirement(f.project, f.state, p, task).operations, f.project);
    assert.deepEqual(next.animations, f.state.animations);
    assert.equal(next.expressions?.length, 2);
    assert.ok(next.expressions?.every(e => e.parameters.amplitude === 0.8));
    for (const explicit of [{ ...r, targetScope: "instance" as const }, { ...r, sourceText: "В сцене 2 Headline добавь инерцию" }]) {
      const constrained = validateIntentPlan(f.project, explicit.sourceText, plan(explicit), 30, { state: f.state, selectedObjectId: "text-repeat", activeSceneId: "s1" });
      assert.equal(constrained.requirements[0].target.sourceNodeId, "text-repeat");
      assert.throws(() => preflightIntentPlan(f.project, f.state, constrained), /BASE_POSITION_ANIMATION_MISSING/);
    }
    const ambiguous = await fixture(3);
    try {
      ambiguous.state.animations.push({ ...ambiguous.state.animations[0], animationId: "other-base", sceneId: "s1", targetId: "text-repeat", startFrame: 120 });
      const target = { ...r, sceneId: "s2", target: { ...r.target, sourceNodeId: "text-third" }, targetScope: "logicalObject" as const };
      const p2 = validateIntentPlan(ambiguous.project, target.sourceText, plan(target), 30, { state: ambiguous.state });
      assert.equal(p2.requirements[0].unresolvedReason, "AMBIGUOUS_TARGET");
    } finally { await ambiguous.cleanup(); }
  } finally { await f.cleanup(); }
});

test("continuous Wiggle creates independent deterministic X/Y channels through final frame and composes with Slide/Fade/inertia", async () => {
  const f = await fixture();
  try {
    const inertia = execute(f, request(["inertialOvershoot"]));
    const r = request(["wiggle"], "Headline всегда немного wiggle"); r.parameters.lifetime = "scene";
    const next = execute(f, r, inertia);
    assert.deepEqual(next.animations, inertia.animations);
    assert.deepEqual(next.expressions?.filter(e => e.type !== "wiggle"), inertia.expressions);
    const wiggles = next.expressions!.filter(e => e.type === "wiggle");
    assert.equal(wiggles.length, 2);
    assert.deepEqual(wiggles.map(e => e.property), ["x", "y"]);
    assert.ok(wiggles.every(e => e.durationFrames === 120));
    const samples = [1, 35.25, 119, 75, 35.25].map(frame => evaluateMotion(next, frame));
    assert.deepEqual(samples[1], samples[4]);
    assert.notEqual(expressionValue(wiggles[0], 119, 30, next.animations, evaluateAnimation), 0);
    assert.notEqual(wiggles[0].parameters.seed, wiggles[1].parameters.seed);
    assert.ok(numericQA(next).checks.every(c => c.status !== "FAILED"));
    const again = execute(f, r, next);
    assert.equal(again.expressions?.length, next.expressions?.length);
    assert.deepEqual(again, next);
    // Historical stored Wiggle retains its original windowed endpoint behavior.
    const legacy = { ...wiggles[0], parameters: { amplitude: 3, frequency: .8, seed: 123 } };
    assert.equal(expressionValue(legacy, 0, 30, next.animations, evaluateAnimation), 0);
    const objects = new Map(f.project.inspection.document.scenes.flatMap(objectsIn).map(o => [`${o.sceneId}/${o.targetId}`, o]));
    validateExpressions(next, objects);
    const finite = structuredClone(next); finite.expressions!.find(e => e.type === "inertialOvershoot")!.durationFrames = 120 - 24;
    assert.throws(() => validateExpressions(finite, objects), /INVALID_LIFECYCLE_INTERVAL.*settled endpoint/);
    assert.equal(expressionRegistry.find(e => e.id === "wiggle")?.lifecycle, "continuous");
  } finally { await f.cleanup(); }
});

test("effect parameter edits preserve IDs, base tracks and other parameters; remove/disable/enable are isolated", async () => {
  const f = await fixture();
  try {
    const inertia = execute(f, request(["inertialOvershoot"]));
    let state = execute(f, request(["wiggle"]), inertia);
    const original = structuredClone(state), ids = state.expressions!.filter(e => e.type === "wiggle").map(e => e.expressionId);
    const r = request(["wiggle"], "Headline сделай wiggle медленнее"); r.kind = "editAnimation";
    r.effectOperation = { storage: "expression", action: "update" }; r.parameters.frequencyFactor = .5;
    state = execute(f, r, state);
    for (const old of original.expressions!.filter(e => e.type === "wiggle")) {
      const now = state.expressions!.find(e => e.expressionId === old.expressionId)!;
      assert.equal(now.type, "wiggle");
      assert.deepEqual(now, { ...old, parameters: { ...old.parameters, frequency: old.parameters.frequency * .5 } });
    }
    const amplitude = request(["inertialOvershoot"], "Headline инерция в два раза сильнее"); amplitude.kind = "editAnimation"; amplitude.parameters.amplitudeFactor = 2;
    const stronger = execute(f, amplitude, state);
    assert.deepEqual(stronger.animations, original.animations);
    for (const old of state.expressions!.filter(e => e.type === "inertialOvershoot")) {
      const now = stronger.expressions!.find(e => e.expressionId === old.expressionId)!;
      assert.deepEqual(now, { ...old, parameters: { ...old.parameters, amplitude: old.parameters.amplitude * 2 } });
    }
    for (const action of ["disable", "enable", "remove"] as const) {
      const life = request(["wiggle"], "Headline действие wiggle " + action); life.kind = "editAnimation"; life.effectOperation = { storage: "expression", action };
      state = execute(f, life, state);
      assert.deepEqual(state.animations, original.animations);
      assert.deepEqual(state.expressions!.filter(e => e.type !== "wiggle"), original.expressions!.filter(e => e.type !== "wiggle"));
      if (action === "remove") assert.equal(state.expressions!.filter(e => ids.includes(e.expressionId)).length, 0);
      else assert.ok(state.expressions!.filter(e => ids.includes(e.expressionId)).every(e => e.enabled === (action === "enable")));
    }
  } finally { await f.cleanup(); }
});

test("duration and easing edits preserve expression identity and timing dependencies, invalid parameter edits fail atomically", async () => {
  const f = await fixture();
  try {
    let state = execute(f, request(["inertialOvershoot"]));
    const original = structuredClone(state);
    const duration = request(["wiggle"]); duration.parameters.durationSeconds = 1;
    state = execute(f, duration, state);
    const r = request(["wiggle"], "Headline измени только длительность wiggle"); r.kind = "editAnimation"; r.parameters.durationFactor = 2;
    const next = execute(f, r, state);
    for (const e of state.expressions!.filter(e => e.type === "wiggle"))
      assert.deepEqual(next.expressions!.find(n => n.expressionId === e.expressionId), { ...e, durationFrames: 60 });
    const easing = request(["moveTo"], "Headline измени easing движения"); easing.kind = "editAnimation"; easing.parameters.easing = "easeInOutCubic";
    const eased = execute(f, easing, next);
    assert.deepEqual(eased.expressions, next.expressions);
    assert.equal(eased.animations.find(a => a.animationId === "base")?.easing, "easeInOutCubic");
    assert.deepEqual(eased.animations.find(a => a.animationId === "fade"), original.animations.find(a => a.animationId === "fade"));
    const invalid = request(["inertialOvershoot"], "Headline инерция слишком сильная"); invalid.kind = "editAnimation"; invalid.parameters.amplitude = 100001;
    const before = structuredClone(eased);
    assert.throws(() => execute(f, invalid, eased), /INVALID_EFFECT_PARAMETER/);
    assert.deepEqual(eased, before);
  } finally { await f.cleanup(); }
});

test("explicit four-target Wiggle binds canonical source IDs and leaves the similarly named ribbon alone", async () => {
  const f = await identityFixture(1, scenes => { scenes[0].children = [node("63:1467", "петрушка 1"), node("63:1472", "морковь"), node("63:1462", "петрушка 2"), node("63:1471", "базилик"), node("63:1463", "лента 2")]; });
  try {
    f.state.settings.durationFrames = 90; f.state.blocks[0].durationFrames = 90;
    const text = "петрушка 1 морковь петрушка 2 базилик всегда немного wiggle";
    const requirements = [["63:1467", "петрушка 1"], ["63:1472", "морковь"], ["63:1462", "петрушка 2"], ["63:1471", "базилик"]].map(([id, name], i) => {
      const r = objectRequirement("r" + i, "s0", id, name, ["wiggle"], text); r.parameters.lifetime = "scene"; return r;
    });
    const p = validateIntentPlan(f.project, text, { schemaVersion: "1.0.0", requirements, coverage: [{ sourceText: text, requirementIds: requirements.map(r => r.requirementId), classification: "executable", explanation: "fixture" }], assumptions: [] }, 12, { state: f.state, selectedObjectId: "63:1463" });
    let state = f.state;
    for (const task of compileTasks(f.project, p)) state = applyOperations(state, compileRequirement(f.project, state, p, task).operations, f.project);
    assert.deepEqual(new Set(state.expressions!.map(e => e.targetId)), new Set(requirements.map(r => r.target.sourceNodeId)));
    assert.equal(state.expressions!.length, 8);
    assert.ok(state.expressions!.every(e => e.durationFrames === 90));
  } finally { await f.cleanup(); }
});

test("disabled effects stay editable without implicit enabling; base enable/disable preserves unrelated tracks", async () => {
  const f = await fixture();
  try {
    let state = execute(f, request(["wiggle"]));
    const life = request(["wiggle"], "Headline выключи wiggle"); life.kind = "editAnimation"; life.effectOperation = { storage: "expression", action: "disable" };
    state = execute(f, life, state);
    const edit = request(["wiggle"], "Headline измени амплитуду wiggle"); edit.kind = "editAnimation"; edit.effectOperation = { storage: "expression", action: "update" }; edit.parameters.amplitude = 4;
    state = execute(f, edit, state);
    assert.ok(state.expressions!.every(e => !e.enabled && e.parameters.amplitude === 4));
    const base = request(["moveTo"], "Headline выключи движение"); base.kind = "editAnimation"; base.effectOperation = { storage: "animation", action: "disable" };
    const disabled = execute(f, base, state);
    assert.equal(disabled.animations.find(a => a.animationId === "base")!.enabled, false);
    assert.deepEqual(disabled.animations.find(a => a.animationId === "fade"), state.animations.find(a => a.animationId === "fade"));
    base.effectOperation.action = "enable";
    const enabled = execute(f, base, disabled);
    assert.deepEqual(enabled, state);
  } finally { await f.cleanup(); }
});
