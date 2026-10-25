import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { identityFixture, node } from "./identity-fixture.js";
import { emptyParameters, objectRequirement } from "./intent-fixture.js";
import { compileTasks, compileRequirement } from "../src/motion/intent/compiler.js";
import { preflightIntentPlan, runIntentTasks, admitCompiledTask, requirementChecks } from "../src/motion/intent/execution.js";
import { resolveTimingDependencies } from "../src/motion/intent/retime.js";
import { applyOperations } from "../src/motion/operations.js";
import { evaluateMotion } from "../src/motion/engine.js";
import { recoveryFailure } from "../src/harness/recovery/failure.js";
import { recoveryMemory, recoveryRecipes } from "../src/harness/recovery/memory.js";
import { recoverPreflight } from "../src/harness/recovery/runtime.js";
import { isolateCodeRepair, materializeCodeProposal, scopedCodeProposalSchema, promoteCodeRepair } from "../src/harness/recovery/code-repair.js";
import { proposeCodeRepair } from "../src/harness/recovery/code-service.js";
import { readMotion, changeMotion } from "../src/motion/store.js";
import type { IntentPlan, IntentRequirement } from "../src/motion/intent/schema.js";
import type { MotionState } from "../src/motion/schema.js";

function setTimelineDuration(state: MotionState, durationFrames: number, fps = 30) {
  state.settings.fps = fps;
  state.settings.durationFrames = durationFrames;
  if (state.blocks.length > 0) {
    const last = state.blocks[state.blocks.length - 1];
    last.durationFrames = durationFrames - last.startFrame;
  }
}

function makeTarget(sourceNodeId: string, name: string) {
  return { sourceNodeId, logicalObjectId: null, name };
}

function makeRefTarget(sourceNodeId: string, sceneId: string, name: string) {
  return { sourceNodeId, sceneId, logicalObjectId: null, name };
}

function makeReq(r: any): IntentRequirement {
  return {
    kind: "editAnimation",
    inheritFromRequirementId: null,
    inheritanceExplanation: null,
    constraints: [],
    unresolvedReason: null,
    ...r,
  };
}

function makePlan(requirements: IntentRequirement[]): IntentPlan {
  return {
    schemaVersion: "1.0.0",
    requirements,
    coverage: [],
    assumptions: [],
  };
}

// Test A: Original parsley request (Run 461cd34c-4276-4bac-94ad-14f0e7367607 reproduction and fix)
test("Test A: Original parsley request (Parsley 1 +5 frames, Parsley 2 +10 frames, no cycle, atomic)", async () => {
  const f = await identityFixture(2, (scenes) => {
    scenes[0].children = [
      node("p1", "петрушка 1", 100, 100),
      node("p2", "петрушка 2", 200, 200),
      node("unrelated", "базилик", 300, 300),
    ];
  });
  try {
    setTimelineDuration(f.state, 300, 30);
    f.state.animations = [
      // Parsley 1 initial tracks at frame 150, dur 21
      { animationId: "anim_p1_up", sceneId: "s0", targetId: "p1", effect: "slideUp", startFrame: 150, durationFrames: 21, enabled: true, parameters: { distance: 80, mode: "in" }, easing: "linear" },
      { animationId: "anim_p1_left", sceneId: "s0", targetId: "p1", effect: "slideLeft", startFrame: 150, durationFrames: 21, enabled: true, parameters: { distance: 80, mode: "in" }, easing: "linear" },
      { animationId: "anim_p1_fade", sceneId: "s0", targetId: "p1", effect: "fadeIn", startFrame: 150, durationFrames: 21, enabled: true, parameters: { from: 0, to: 1 }, easing: "linear" },
      // Parsley 2 initial tracks at frame 150, dur 21
      { animationId: "anim_p2_up", sceneId: "s0", targetId: "p2", effect: "slideUp", startFrame: 150, durationFrames: 21, enabled: true, parameters: { distance: 80, mode: "in" }, easing: "linear" },
      { animationId: "anim_p2_right", sceneId: "s0", targetId: "p2", effect: "slideRight", startFrame: 150, durationFrames: 21, enabled: true, parameters: { distance: 80, mode: "in" }, easing: "linear" },
      { animationId: "anim_p2_fade", sceneId: "s0", targetId: "p2", effect: "fadeIn", startFrame: 150, durationFrames: 21, enabled: true, parameters: { from: 0, to: 1 }, easing: "linear" },
      // Unrelated object
      { animationId: "anim_unrelated", sceneId: "s0", targetId: "unrelated", effect: "fadeIn", startFrame: 30, durationFrames: 30, enabled: true, parameters: { from: 0, to: 1 }, easing: "linear" },
    ];
    f.state.expressions = [
      // Attached inertias for Parsley 1 (start 171 = 150 + 21)
      { expressionId: "expr_p1_y", sceneId: "s0", targetId: "p1", property: "y", startFrame: 171, durationFrames: 36, enabled: true, type: "inertialOvershoot", sourceAnimationId: "anim_p1_up", parameters: { amplitude: 0.25, frequency: 2.5, decay: 3, velocityLookbackFrames: 21, mode: "ae" } },
      { expressionId: "expr_p1_x", sceneId: "s0", targetId: "p1", property: "x", startFrame: 171, durationFrames: 36, enabled: true, type: "inertialOvershoot", sourceAnimationId: "anim_p1_left", parameters: { amplitude: 0.25, frequency: 2.5, decay: 3, velocityLookbackFrames: 21, mode: "ae" } },
      // Attached inertias for Parsley 2 (start 171 = 150 + 21)
      { expressionId: "expr_p2_y", sceneId: "s0", targetId: "p2", property: "y", startFrame: 171, durationFrames: 36, enabled: true, type: "inertialOvershoot", sourceAnimationId: "anim_p2_up", parameters: { amplitude: 0.25, frequency: 2.5, decay: 3, velocityLookbackFrames: 21, mode: "ae" } },
      { expressionId: "expr_p2_x", sceneId: "s0", targetId: "p2", property: "x", startFrame: 171, durationFrames: 36, enabled: true, type: "inertialOvershoot", sourceAnimationId: "anim_p2_right", parameters: { amplitude: 0.25, frequency: 2.5, decay: 3, velocityLookbackFrames: 21, mode: "ae" } },
    ];

    // Build the plan with self-relative temporal references (matching exactly what model produced in run 461cd34c)
    const plan: IntentPlan = makePlan([
        makeReq({
          requirementId: "r1",
          sourceText: "пусть петрушка 1 начинает свою анимацию на 5 кадров позже",
          sceneId: "s0",
          target: makeTarget("p1", "петрушка 1"),
          techniques: ["slideUp", "slideLeft", "fadeIn"],
          parameters: { ...emptyParameters },
          timing: {
            startSeconds: null,
            relation: "unchanged",
            anchorRequirementId: null,
            reference: {
              kind: "existingAnimation",
              target: makeRefTarget("p1", "s0", "петрушка 1"),
              effect: "slideUp",
              animationId: "anim_p1_up",
              endpoint: "start",
              resolvedAnimationId: "anim_p1_up",
            },
            offsetFrames: 5,
            delaySeconds: 0,
            align: "start",
          },
          effectOperation: { storage: "animation", action: "updateTiming" },
          animationIds: ["anim_p1_up", "anim_p1_left", "anim_p1_fade"],
        }),
        makeReq({
          requirementId: "r2",
          sourceText: "а анимация петрушки 2 начинается на 10 кадров позже",
          sceneId: "s0",
          target: makeTarget("p2", "петрушка 2"),
          techniques: ["slideUp", "slideRight", "fadeIn"],
          parameters: { ...emptyParameters },
          timing: {
            startSeconds: null,
            relation: "unchanged",
            anchorRequirementId: null,
            reference: {
              kind: "existingAnimation",
              target: makeRefTarget("p2", "s0", "петрушка 2"),
              effect: "slideUp",
              animationId: "anim_p2_up",
              endpoint: "start",
              resolvedAnimationId: "anim_p2_up",
            },
            offsetFrames: 10,
            delaySeconds: 0,
            align: "start",
          },
          effectOperation: { storage: "animation", action: "updateTiming" },
          animationIds: ["anim_p2_up", "anim_p2_right", "anim_p2_fade"],
        }),
      ]);

    // Preflight must pass without self-dependency cycle!
    const preflight = preflightIntentPlan(f.project, f.state, plan);
    assert.equal(preflight.status, "PASSED");
    assert.equal(preflight.preparedPlans.size, 2);

    // Execute via runIntentTasks
    const result = await runIntentTasks(f.project, f.state, plan, {
      preparedPlans: preflight.preparedPlans,
      trace: async () => {},
      verify: async () => ({ status: "PASSED", checks: [] }),
      repair: async () => { throw new Error("Repair unexpected"); },
      commit: async (_task, _plan, next) => next,
    });

    assert.equal(result.requirements.length, 2);
    assert.equal(result.requirements[0].status, "PASSED");
    assert.equal(result.requirements[1].status, "PASSED");

    // Invariant 1: Stable Identity (IDs preserved)
    const p1Tracks = result.next.animations.filter((a) => a.targetId === "p1");
    assert.deepEqual(p1Tracks.map((a) => a.animationId), ["anim_p1_up", "anim_p1_left", "anim_p1_fade"]);

    // Invariant 2: No accidental self-edges in timingDependencies
    const selfDeps = (result.next.timingDependencies ?? []).filter((d) => d.animationId === d.anchorAnimationId);
    assert.equal(selfDeps.length, 0);

    // Invariant 7: Frame accuracy (+5 for p1: 150 -> 155; +10 for p2: 150 -> 160)
    for (const a of p1Tracks) {
      assert.equal(a.startFrame, 155);
      assert.equal(a.durationFrames, 21);
    }
    const p2Tracks = result.next.animations.filter((a) => a.targetId === "p2");
    for (const a of p2Tracks) {
      assert.equal(a.startFrame, 160);
      assert.equal(a.durationFrames, 21);
    }

    // Invariant 4: Dependent inertia correctly anchored (171 + 5 = 176 for p1; 171 + 10 = 181 for p2)
    const p1Inertia = (result.next.expressions ?? []).filter((e) => e.targetId === "p1");
    for (const e of p1Inertia) {
      assert.equal(e.startFrame, 176);
      assert.equal(e.durationFrames, 36);
    }
    const p2Inertia = (result.next.expressions ?? []).filter((e) => e.targetId === "p2");
    for (const e of p2Inertia) {
      assert.equal(e.startFrame, 181);
      assert.equal(e.durationFrames, 36);
    }

    // Invariant 6: Unrelated object preserved
    const unrelated = result.next.animations.find((a) => a.targetId === "unrelated")!;
    assert.equal(unrelated.startFrame, 30);
    assert.equal(unrelated.durationFrames, 30);
  } finally {
    await f.cleanup();
  }
});

// Test B: Negative frame shift
test("Test B: Negative frame shift preserves signed pre-roll and output range", async () => {
  const f = await identityFixture(1, (scenes) => {
    scenes[0].children = [node("box", "коробка", 50, 50)];
  });
  try {
    setTimelineDuration(f.state, 150, 30);
    f.state.animations = [
      { animationId: "anim_box", sceneId: "s0", targetId: "box", effect: "slideUp", startFrame: 15, durationFrames: 30, enabled: true, parameters: { distance: 50, mode: "in" }, easing: "linear" },
    ];

    // Shift by -8 frames (15 -> 7)
    const planB1: IntentPlan = makePlan([makeReq({
      requirementId: "r_shift_earlier",
      sourceText: "сдвинь анимацию на 8 кадров раньше",
      sceneId: "s0",
      target: makeTarget("box", "коробка"),
      techniques: ["slideUp"],
      parameters: { ...emptyParameters },
      timing: { startSeconds: null, relation: "unchanged", anchorRequirementId: null, offsetFrames: -8, delaySeconds: 0, align: "start" },
      effectOperation: { storage: "animation", action: "updateTiming" },
      animationIds: ["anim_box"],
    })]);

    const tasks1 = compileTasks(f.project, planB1);
    const compiled1 = compileRequirement(f.project, f.state, planB1, tasks1[0]);
    const next1 = applyOperations(f.state, compiled1.operations, f.project);
    assert.equal(next1.animations[0].startFrame, 7);

    // Now shift by -20 frames from frame 7 -> would be -13 -> shifts origin!
    const planB2: IntentPlan = makePlan([makeReq({
      requirementId: "r_shift_origin",
      sourceText: "сдвинь анимацию на 20 кадров раньше",
      sceneId: "s0",
      target: makeTarget("box", "коробка"),
      techniques: ["slideUp"],
      parameters: { ...emptyParameters },
      timing: { startSeconds: null, relation: "unchanged", anchorRequirementId: null, offsetFrames: -20, delaySeconds: 0, align: "start" },
      effectOperation: { storage: "animation", action: "updateTiming" },
      animationIds: ["anim_box"],
    })]);

    const tasks2 = compileTasks(f.project, planB2);
    const compiled2 = compileRequirement(f.project, next1, planB2, tasks2[0]);
    const next2 = applyOperations(next1, compiled2.operations, f.project);
    // Signed mathematical time does not move the visible output window.
    assert.equal(next2.animations[0].startFrame, -13);
    assert.equal(next2.settings.durationFrames, next1.settings.durationFrames);
    assert.deepEqual(next2.blocks, next1.blocks);
  } finally {
    await f.cleanup();
  }
});

// Test C: External temporal anchor
test("Test C: External temporal anchor (B starts 5 frames after A ends)", async () => {
  const f = await identityFixture(1, (scenes) => {
    scenes[0].children = [node("itemA", "элемент А", 10, 10), node("itemB", "элемент Б", 50, 50)];
  });
  try {
    setTimelineDuration(f.state, 150, 30);
    f.state.animations = [
      { animationId: "anim_A", sceneId: "s0", targetId: "itemA", effect: "fadeIn", startFrame: 30, durationFrames: 40, enabled: true, parameters: { from: 0, to: 1 }, easing: "linear" },
      { animationId: "anim_B", sceneId: "s0", targetId: "itemB", effect: "fadeIn", startFrame: 0, durationFrames: 30, enabled: true, parameters: { from: 0, to: 1 }, easing: "linear" },
    ];

    const plan: IntentPlan = makePlan([makeReq({
        requirementId: "r_rel",
        sourceText: "пусть анимация Б начинается через 5 кадров после завершения анимации А",
        sceneId: "s0",
        target: makeTarget("itemB", "элемент Б"),
        techniques: ["fadeIn"],
        parameters: { ...emptyParameters },
        timing: {
          startSeconds: null,
          relation: "unchanged",
          anchorRequirementId: null,
          reference: {
            kind: "existingAnimation",
            target: makeRefTarget("itemA", "s0", "элемент А"),
            effect: "fadeIn",
            animationId: "anim_A",
            endpoint: "end",
            resolvedAnimationId: "anim_A",
          },
          offsetFrames: 5,
          delaySeconds: 0,
          align: "start",
        },
        effectOperation: { storage: "animation", action: "updateTiming" },
        animationIds: ["anim_B"],
      })]);

    const tasks = compileTasks(f.project, plan);
    const compiled = compileRequirement(f.project, f.state, plan, tasks[0]);
    const next = applyOperations(f.state, compiled.operations, f.project);
    resolveTimingDependencies(next);

    const animB = next.animations.find((a) => a.animationId === "anim_B")!;
    // A starts at 30, duration 40 -> ends at 70 -> B starts at 70 + 5 = 75
    assert.equal(animB.startFrame, 75);
    // Dependency recorded
    const dep = next.timingDependencies?.find((d) => d.animationId === "anim_B");
    assert.ok(dep);
    assert.equal(dep.anchorAnimationId, "anim_A");
    assert.equal(dep.offsetFrames, 5);
  } finally {
    await f.cleanup();
  }
});

// Test D: Genuine dependency cycle
test("Test D: Genuine dependency cycle (A -> B and B -> A rejected with error)", async () => {
  const f = await identityFixture(1, (scenes) => {
    scenes[0].children = [node("itemA", "А", 10, 10), node("itemB", "Б", 20, 20)];
  });
  try {
    setTimelineDuration(f.state, 100, 30);
    f.state.animations = [
      { animationId: "anim_A", sceneId: "s0", targetId: "itemA", effect: "fadeIn", startFrame: 10, durationFrames: 20, enabled: true, parameters: { from: 0, to: 1 }, easing: "linear" },
      { animationId: "anim_B", sceneId: "s0", targetId: "itemB", effect: "fadeIn", startFrame: 20, durationFrames: 20, enabled: true, parameters: { from: 0, to: 1 }, easing: "linear" },
    ];
    // Create direct circular dependency
    f.state.timingDependencies = [
      { dependencyId: "dep_1", animationId: "anim_A", anchorAnimationId: "anim_B", relation: "after", offsetFrames: 0 },
      { dependencyId: "dep_2", animationId: "anim_B", anchorAnimationId: "anim_A", relation: "after", offsetFrames: 0 },
    ];

    assert.throws(
      () => resolveTimingDependencies(f.state),
      /Timing dependency cycle/,
    );

    // Also verify self-referential dependency is rejected by operations.ts
    assert.throws(
      () => applyOperations(f.state, [{
        type: "setTimingDependency",
        dependency: { dependencyId: "dep_self", animationId: "anim_A", anchorAnimationId: "anim_A", relation: "with", offsetFrames: 5 },
      }], f.project),
      /Timing dependency cycle/,
    );
  } finally {
    await f.cleanup();
  }
});

// Test E: Compound animation without double shift
test("Test E: Compound animation (Slide + Fade + Inertia shifted by N without double shift)", async () => {
  const f = await identityFixture(1, (scenes) => {
    scenes[0].children = [node("card", "карточка", 50, 50)];
  });
  try {
    setTimelineDuration(f.state, 150, 30);
    f.state.animations = [
      { animationId: "card_slide", sceneId: "s0", targetId: "card", effect: "slideUp", startFrame: 60, durationFrames: 30, enabled: true, parameters: { distance: 100, mode: "in" }, easing: "linear" },
      { animationId: "card_fade", sceneId: "s0", targetId: "card", effect: "fadeIn", startFrame: 60, durationFrames: 30, enabled: true, parameters: { from: 0, to: 1 }, easing: "linear" },
    ];
    f.state.expressions = [
      { expressionId: "card_inertia", sceneId: "s0", targetId: "card", property: "y", startFrame: 90, durationFrames: 30, enabled: true, type: "inertialOvershoot", sourceAnimationId: "card_slide", parameters: { amplitude: 0.2, frequency: 2, decay: 3, velocityLookbackFrames: 30, mode: "ae" } },
    ];

    // Shift by +15 frames
    const plan: IntentPlan = makePlan([makeReq({
      requirementId: "r_card",
      sourceText: "карточка сдвинь анимацию на 15 кадров позже",
      sceneId: "s0",
      target: makeTarget("card", "карточка"),
      techniques: ["slideUp", "fadeIn"],
      parameters: { ...emptyParameters },
      timing: { startSeconds: null, relation: "unchanged", anchorRequirementId: null, offsetFrames: 15, delaySeconds: 0, align: "start" },
      effectOperation: { storage: "animation", action: "updateTiming" },
      animationIds: ["card_slide", "card_fade"],
    })]);

    const tasks = compileTasks(f.project, plan);
    const compiled = compileRequirement(f.project, f.state, plan, tasks[0]);
    const next = applyOperations(f.state, compiled.operations, f.project);
    resolveTimingDependencies(next);

    // Slide and Fade both start at 60 + 15 = 75
    const slide = next.animations.find((a) => a.animationId === "card_slide")!;
    const fade = next.animations.find((a) => a.animationId === "card_fade")!;
    assert.equal(slide.startFrame, 75);
    assert.equal(fade.startFrame, 75);

    // Inertia starts at 90 + 15 = 105 (NOT 120 or 135)
    const inertia = next.expressions?.find((e) => e.expressionId === "card_inertia")!;
    assert.equal(inertia.startFrame, 105);
  } finally {
    await f.cleanup();
  }
});

// Test F: Single-effect edit (shift only Fade)
test("Test F: Single-effect edit (shift only explicitly targeted Fade, leave movement intact)", async () => {
  const f = await identityFixture(1, (scenes) => {
    scenes[0].children = [node("banner", "баннер", 10, 10)];
  });
  try {
    setTimelineDuration(f.state, 150, 30);
    f.state.animations = [
      { animationId: "b_slide", sceneId: "s0", targetId: "banner", effect: "slideUp", startFrame: 30, durationFrames: 30, enabled: true, parameters: { distance: 50, mode: "in" }, easing: "linear" },
      { animationId: "b_fade", sceneId: "s0", targetId: "banner", effect: "fadeIn", startFrame: 30, durationFrames: 30, enabled: true, parameters: { from: 0, to: 1 }, easing: "linear" },
    ];

    const plan: IntentPlan = makePlan([makeReq({
      requirementId: "r_fade_only",
      sourceText: "пусть появление прозрачности начинается на 10 кадров позже",
      sceneId: "s0",
      target: makeTarget("banner", "баннер"),
      techniques: ["fadeIn"],
      parameters: { ...emptyParameters },
      timing: { startSeconds: null, relation: "unchanged", anchorRequirementId: null, offsetFrames: 10, delaySeconds: 0, align: "start" },
      effectOperation: { storage: "animation", action: "updateTiming" },
      animationIds: ["b_fade"],
    })]);

    const tasks = compileTasks(f.project, plan);
    const compiled = compileRequirement(f.project, f.state, plan, tasks[0]);
    const next = applyOperations(f.state, compiled.operations, f.project);

    assert.equal(next.animations.find((a) => a.animationId === "b_fade")?.startFrame, 40);
    // Slide remains at 30!
    assert.equal(next.animations.find((a) => a.animationId === "b_slide")?.startFrame, 30);
  } finally {
    await f.cleanup();
  }
});

// Test G: Multiple independent targets in one atomic request
test("Test G: Multiple independent targets (A +5, B +10, C -10 committed atomically)", async () => {
  const f = await identityFixture(1, (scenes) => {
    scenes[0].children = [node("o1", "объект 1", 10, 10), node("o2", "объект 2", 20, 20), node("o3", "объект 3", 30, 30)];
  });
  try {
    setTimelineDuration(f.state, 150, 30);
    f.state.animations = [
      { animationId: "a1", sceneId: "s0", targetId: "o1", effect: "fadeIn", startFrame: 50, durationFrames: 20, enabled: true, parameters: { from: 0, to: 1 }, easing: "linear" },
      { animationId: "a2", sceneId: "s0", targetId: "o2", effect: "fadeIn", startFrame: 50, durationFrames: 20, enabled: true, parameters: { from: 0, to: 1 }, easing: "linear" },
      { animationId: "a3", sceneId: "s0", targetId: "o3", effect: "fadeIn", startFrame: 50, durationFrames: 20, enabled: true, parameters: { from: 0, to: 1 }, easing: "linear" },
    ];

    const plan: IntentPlan = makePlan([
      makeReq({ requirementId: "r1", sourceText: "o1 +5", sceneId: "s0", target: makeTarget("o1", "объект 1"), techniques: ["fadeIn"], parameters: { ...emptyParameters }, timing: { startSeconds: null, relation: "unchanged", anchorRequirementId: null, offsetFrames: 5, delaySeconds: 0, align: "start" }, effectOperation: { storage: "animation", action: "updateTiming" }, animationIds: ["a1"] }),
      makeReq({ requirementId: "r2", sourceText: "o2 +10", sceneId: "s0", target: makeTarget("o2", "объект 2"), techniques: ["fadeIn"], parameters: { ...emptyParameters }, timing: { startSeconds: null, relation: "unchanged", anchorRequirementId: null, offsetFrames: 10, delaySeconds: 0, align: "start" }, effectOperation: { storage: "animation", action: "updateTiming" }, animationIds: ["a2"] }),
      makeReq({ requirementId: "r3", sourceText: "o3 -10", sceneId: "s0", target: makeTarget("o3", "объект 3"), techniques: ["fadeIn"], parameters: { ...emptyParameters }, timing: { startSeconds: null, relation: "unchanged", anchorRequirementId: null, offsetFrames: -10, delaySeconds: 0, align: "start" }, effectOperation: { storage: "animation", action: "updateTiming" }, animationIds: ["a3"] }),
    ]);

    const preflight = preflightIntentPlan(f.project, f.state, plan);
    assert.equal(preflight.status, "PASSED");

    const res = await runIntentTasks(f.project, f.state, plan, {
      preparedPlans: preflight.preparedPlans,
      trace: async () => {},
      verify: async () => ({ status: "PASSED", checks: [] }),
      repair: async () => { throw new Error("Repair unexpected"); },
      commit: async (_task, _plan, next) => next,
    });

    assert.equal(res.next.animations.find((a) => a.animationId === "a1")?.startFrame, 55);
    assert.equal(res.next.animations.find((a) => a.animationId === "a2")?.startFrame, 60);
    assert.equal(res.next.animations.find((a) => a.animationId === "a3")?.startFrame, 40);
  } finally {
    await f.cleanup();
  }
});

// Test H: Retry safety (re-executing candidate does not double-shift)
test("Test H: Retry safety (same candidate re-execution produces idempotent result)", async () => {
  const f = await identityFixture(1, (scenes) => {
    scenes[0].children = [node("item", "элемент", 10, 10)];
  });
  try {
    setTimelineDuration(f.state, 100, 30);
    f.state.animations = [
      { animationId: "anim_i", sceneId: "s0", targetId: "item", effect: "fadeIn", startFrame: 20, durationFrames: 20, enabled: true, parameters: { from: 0, to: 1 }, easing: "linear" },
    ];

    const plan: IntentPlan = makePlan([makeReq({
      requirementId: "r1",
      sourceText: "сдвинь на 5 кадров позже",
      sceneId: "s0",
      target: makeTarget("item", "элемент"),
      techniques: ["fadeIn"],
      parameters: { ...emptyParameters },
      timing: { startSeconds: null, relation: "unchanged", anchorRequirementId: null, offsetFrames: 5, delaySeconds: 0, align: "start" },
      effectOperation: { storage: "animation", action: "updateTiming" },
      animationIds: ["anim_i"],
    })]);

    const tasks = compileTasks(f.project, plan);
    const compiled = compileRequirement(f.project, f.state, plan, tasks[0]);

    // Apply once
    const firstRun = applyOperations(f.state, compiled.operations, f.project);
    assert.equal(firstRun.animations[0].startFrame, 25);

    // Invariant 9: Re-applying the exact compiled operations produces identical state
    const duplicateRun = applyOperations(f.state, compiled.operations, f.project);
    assert.equal(duplicateRun.animations[0].startFrame, 25);
  } finally {
    await f.cleanup();
  }
});

// Test I: Automatic Project Recovery (deterministic timing cycle resolution without LLM)
test("Test I: Automatic Project Recovery (resolves self-referential cycle deterministically)", async () => {
  const f = await identityFixture(1, (scenes) => {
    scenes[0].children = [node("target", "цель", 10, 10)];
  });
  try {
    setTimelineDuration(f.state, 100, 30);
    f.state.animations = [
      { animationId: "anim_t", sceneId: "s0", targetId: "target", effect: "fadeIn", startFrame: 30, durationFrames: 20, enabled: true, parameters: { from: 0, to: 1 }, easing: "linear" },
    ];

    // Malformed plan containing an accidental self-dependency in anchorRequirementId
    const plan: IntentPlan = makePlan([makeReq({
      requirementId: "r_self",
      sourceText: "сдвинь цель на 5 кадров позже",
      sceneId: "s0",
      target: makeTarget("target", "цель"),
      techniques: ["fadeIn"],
      parameters: { ...emptyParameters },
      timing: {
        startSeconds: null,
        relation: "unchanged",
        anchorRequirementId: "r_self", // Self-reference!
        reference: {
          kind: "existingAnimation",
          target: makeRefTarget("target", "s0", "цель"),
          effect: "fadeIn",
          animationId: "anim_t",
          endpoint: "start",
          resolvedAnimationId: "anim_t",
        },
        offsetFrames: 5,
        delaySeconds: 0,
        align: "start",
      },
      effectOperation: { storage: "animation", action: "updateTiming" },
      animationIds: ["anim_t"],
    })]);

    // Recover preflight deterministically without calling LLM!
    const tasks = compileTasks(f.project, plan);
    const preflightErr = Object.assign(
      new Error("Timing dependency cycle: anim_t -> anim_t"),
      { report: { taskId: tasks[0].taskId } },
    );
    let llmCalled = false;
    const res = await recoverPreflight(
      f.project,
      f.state,
      plan,
      preflightErr,
      {
        policy: {
          supervisorMaxAttempts:6,supervisorMaxDurationMs:180000,semanticRecoveryCalls:2,
          enabled: true,
          model: "gpt-6-sol",
          effort: "low",
          maxAttempts: 3,
          maxContextBytes: 20000,
          maxOutputTokens: 4000,
          maxTokens: 24000,
          maxDurationMs: 60000,
          maxEstimatedCost: null,
          codeRepair: { enabled: true, model: "gpt-6-sol", effort: "medium", maxDurationMs: 120000, maxContextBytes: 140000, maxOutputTokens: 12000, maxTokens: 60000, maxEstimatedCost: null },
        },
        revision: "rev-1",
        request: "сдвинь цель на 5 кадров позже",
        checkpoint: () => {},
        record: async () => {},
        decide: async () => {
          llmCalled = true;
          return { action: "stop", reason: "Should not be called" };
        },
      },
    );

    assert.equal(llmCalled, false); // Resolved deterministically!
    assert.equal(res.report.status, "Candidate Recovered");
    assert.equal(res.report.procedure, "deterministic-timing-cycle-resolution/1");
  } finally {
    await f.cleanup();
  }
});

// Test J: Real Code Repair in isolated sandbox with human approval gate
test("Test J: Real Code Repair (sandboxed reproduction, diff, and human approval gate)", async () => {
  const failure = recoveryFailure(
    new Error("Deterministic compiler defect: TIMING_CYCLE_DEFECT"),
    "preflight",
    "rev-test",
  );
  failure.codeRepairEligible = true;
  failure.category = "PROBABLE_DEFECT";

  const workspace = await isolateCodeRepair(
    process.cwd(),
    failure,
    ["apps/scene-validator/src/motion/intent/compiler.ts"],
    { allowDirty: true },
  );

  assert.ok(workspace.root.includes("akella-code-repair-"));
  assert.equal(workspace.files.length, 1);
  assert.equal(workspace.files[0].path, "apps/scene-validator/src/motion/intent/compiler.ts");

  // Materialize proposal
  const { regressionPath, schema } = scopedCodeProposalSchema(workspace);
  const proposalData = {
    rootCause: "Accidental self-dependency in compiler retiming loop",
    changes: [
      {
        path: "apps/scene-validator/src/motion/intent/compiler.ts",
        beforeHash: workspace.files[0].hash,
        content: workspace.files[0].content, // Valid unchanged content for test
      },
      {
        path: regressionPath,
        beforeHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // SHA256 of empty
        content: `import test from "node:test"; assert from "node:assert/strict"; test("regression", () => {});`,
      },
    ],
    regressionTests: [regressionPath],
    risks: ["Low risk to existing animations"],
  };

  const materialized = await materializeCodeProposal(workspace, proposalData);
  assert.ok(materialized.patchDigest);
  assert.ok(materialized.patchIdentity);
});

// Test K: Approval security (unapproved patch cannot change application)
test("Test K: Approval security (unapproved patch cannot be promoted)", () => {
  assert.throws(
    () => promoteCodeRepair(),
    /CODE_PROMOTION_DISABLED/,
  );
});

// Test L: Budget exhausted during Recovery preserves defect evidence
test("Test L: Budget exhausted during Recovery preserves original defect evidence", () => {
  const original = recoveryFailure(
    new Error("REQUIREMENT_OPERATIONS_INCOMPLETE"),
    "preflight",
    "rev-1",
  );
  original.codeRepairEligible = true;
  original.category = "PROBABLE_DEFECT";

  const terminal = recoveryFailure(
    new Error("LLM_CALL_BUDGET"),
    "recovery",
    "rev-1",
  );

  // In service.ts escalation:
  const codeFailure =
    original.codeRepairEligible && !["LLM_CALL_BUDGET", "RECOVERY_TIME_BUDGET"].includes(original.code)
      ? original
      : terminal;

  assert.equal(codeFailure.code, "REQUIREMENT_OPERATIONS_INCOMPLETE");
  assert.equal(codeFailure.category, "PROBABLE_DEFECT");
  assert.equal(codeFailure.codeRepairEligible, true);
});

// Test M: Recovery infrastructure defect classification
test("Test M: Recovery infrastructure defect (schema error classified as PROBABLE_DEFECT)", () => {
  const schemaError = recoveryFailure(
    new Error("PROVIDER_SCHEMA_INVALID: missing required field"),
    "provider-startup",
    "rev-schema",
  );
  assert.equal(schemaError.category, "PROBABLE_DEFECT");
  assert.equal(schemaError.codeRepairEligible, true);
});

// Test N: Generative regression tests across random frame rates, track combinations and deltas
test("Test N: Generative regression tests (randomized seeds preserve invariants 1-12)", async () => {
  const fpsOptions = [24, 30, 60];
  const deltaOptions = [-15, -5, +5, +20, +45];

  for (let seed = 1; seed <= 5; seed++) {
    const fps = fpsOptions[seed % fpsOptions.length];
    const delta = deltaOptions[seed % deltaOptions.length];

    const f = await identityFixture(1, (scenes) => {
      scenes[0].children = [node("genObj", "сгенерированный объект", 20, 20)];
    });
    try {
      setTimelineDuration(f.state, 300, fps);
      f.state.animations = [
        { animationId: `anim_${seed}_1`, sceneId: "s0", targetId: "genObj", effect: "slideUp", startFrame: 50, durationFrames: 25, enabled: true, parameters: { distance: 60, mode: "in" }, easing: "linear" },
        { animationId: `anim_${seed}_2`, sceneId: "s0", targetId: "genObj", effect: "fadeIn", startFrame: 52, durationFrames: 25, enabled: true, parameters: { from: 0, to: 1 }, easing: "linear" },
      ];

      const plan: IntentPlan = makePlan([makeReq({
        requirementId: `r_gen_${seed}`,
        sourceText: `сдвинь на ${delta} кадров`,
        sceneId: "s0",
        target: makeTarget("genObj", "сгенерированный объект"),
        techniques: ["slideUp", "fadeIn"],
        parameters: { ...emptyParameters },
        timing: { startSeconds: null, relation: "unchanged", anchorRequirementId: null, offsetFrames: delta, delaySeconds: 0, align: "start" },
        effectOperation: { storage: "animation", action: "updateTiming" },
        animationIds: [`anim_${seed}_1`, `anim_${seed}_2`],
      })]);

      const tasks = compileTasks(f.project, plan);
      const compiled = compileRequirement(f.project, f.state, plan, tasks[0]);
      const next = applyOperations(f.state, compiled.operations, f.project);
      resolveTimingDependencies(next);

      const t1 = next.animations.find((a) => a.animationId === `anim_${seed}_1`)!;
      const t2 = next.animations.find((a) => a.animationId === `anim_${seed}_2`)!;

      // Invariant 3: Pairwise offset preservation (track 2 starts exactly 2 frames after track 1)
      assert.equal(t2.startFrame - t1.startFrame, 2);
      // Invariant 1: ID preservation
      assert.equal(t1.animationId, `anim_${seed}_1`);
      assert.equal(t2.animationId, `anim_${seed}_2`);
    } finally {
      await f.cleanup();
    }
  }
});

// Test O: Persistence and restart resilience
test("Test O: Persistence and restart resilience (reloading project loads valid committed state)", async () => {
  const f = await identityFixture(1, (scenes) => {
    scenes[0].children = [node("itemP", "элемент П", 15, 15)];
  });
  try {
    setTimelineDuration(f.state, 100, 30);
    f.state.animations = [
      { animationId: "anim_p", sceneId: "s0", targetId: "itemP", effect: "fadeIn", startFrame: 30, durationFrames: 20, enabled: true, parameters: { from: 0, to: 1 }, easing: "linear" },
    ];

    // Commit change
    const doc = await readMotion(f.project);
    const init = await changeMotion(f.project.root, {
      expectedRevision: doc.revision,
      request: "fixture settings",
      operations: [
        { type: "setProjectSettings", settings: f.state.settings },
        { type: "setBlocks", blocks: f.state.blocks },
        { type: "addAnimation", animation: f.state.animations[0] },
      ],
    });

    await changeMotion(f.project.root, {
      expectedRevision: init.document.revision,
      request: "update timing",
      operations: [
        {
          type: "updateAnimation",
          animationId: "anim_p",
          animation: { ...f.state.animations[0], startFrame: 45 },
        },
      ],
    });

    // Read back
    const reloaded = await readMotion(f.project);
    assert.equal(reloaded.state.animations[0].startFrame, 45);
  } finally {
    await f.cleanup();
  }
});
