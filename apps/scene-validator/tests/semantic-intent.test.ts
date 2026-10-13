import test from "node:test";
import assert from "node:assert/strict";
import {
  intentFixture,
  compositeRequest,
  objectRequirement,
  emptyParameters,
} from "./intent-fixture.js";
import {
  runIntentTasks,
  assertIntentScope,
  requirementChecks,
} from "../src/motion/intent/execution.js";
import {
  compileTasks,
  compileRequirement,
  expandInheritance,
} from "../src/motion/intent/compiler.js";
import {
  semanticPlan,
  validateIntentPlan,
} from "../src/motion/intent/planner.js";
import { readMotion, changeMotion } from "../src/motion/store.js";
import { applyOperations } from "../src/motion/operations.js";
import { numericQA } from "../src/motion/qa/numeric.js";
import { motionQA } from "../src/motion/qa/render.js";

test("EVAL_MULTI_SCENE_COMPOSITE_REQUEST: ten requirements, timing at FPS, six slide/fades, four inertia, ribbons dependency, persisted per-task scope", async () => {
  const f = await intentFixture();
  try {
    let doc = await readMotion(f.project);
    const source = structuredClone(doc.state);
    const result = await runIntentTasks(f.project, doc.state, f.plan, {
      repair: async () => {
        throw new Error("No model repair expected");
      },
      verify: async (t, next) => {
        const report = numericQA(next);
        assert.equal(
          report.checks.filter((c) => c.status === "FAILED").length,
          0,
        );
        return { status: "PASSED", checks: report.checks };
      },
      commit: async (t, p) => {
        doc = (
          await changeMotion(f.project.root, {
            expectedRevision: doc.revision,
            operations: p.operations,
            request: t.taskId,
          })
        ).document;
        return doc.state;
      },
      trace: async (tasks) => {
        assert.doesNotThrow(() => JSON.stringify(tasks));
      },
    });
    assert.equal(
      result.reconciliation.status,
      "SUCCESS",
      JSON.stringify(result.requirements),
    );
    assert.equal(result.reconciliation.requested, 10);
    assert.equal(result.reconciliation.taskCount, 9);
    assert.equal(doc.history.length, 9);
    const s = doc.state;
    assert.equal(s.blocks[1].startFrame, s.settings.fps);
    assert.equal(s.blocks[2].startFrame, 3 * s.settings.fps);
    for (const id of ["image", "text", "qr", "logo", "discount", "shape"]) {
      assert.ok(
        s.animations.some((a) => a.targetId === id && a.effect === "slideUp"),
      );
      assert.ok(
        s.animations.some((a) => a.targetId === id && a.effect === "fadeIn"),
      );
    }
    assert.equal(
      s.expressions?.filter((e) => e.type === "inertialOvershoot").length,
      4,
    );
    assert.equal(s.animations.filter((a) => a.effect === "trimPath").length, 2);
    assert.ok(
      !s.animations.some(
        (a) => a.targetId === "logo" && a.effect === "trimPath",
      ),
    );
    const ribbon1 = s.animations.find((a) => a.targetId === "ribbon1")!,
      ribbon2 = s.animations.find((a) => a.targetId === "ribbon2")!;
    assert.equal(
      ribbon2.startFrame,
      ribbon1.startFrame + ribbon1.durationFrames,
    );
    const updated = applyOperations(
      s,
      [
        {
          type: "setDuration",
          animationId: ribbon1.animationId,
          durationFrames: ribbon1.durationFrames + 3,
        },
      ],
      f.project,
    );
    assert.equal(
      updated.animations.find((a) => a.targetId === "ribbon2")!.startFrame,
      ribbon2.startFrame + 3,
    );
    assert.equal(source.blocks[1].startFrame, 60);
  } finally {
    await f.cleanup();
  }
});
test("semantic coverage audit restores omitted fade and timing before operations; original snippets validated", async () => {
  const f = await intentFixture();
  try {
    let audited = 0;
    const incomplete = structuredClone(f.plan);
    incomplete.requirements = incomplete.requirements.filter(
      (r) => r.kind !== "sceneTiming",
    );
    incomplete.requirements[0].techniques = ["slideUp", "inertialOvershoot"];
    const plan = await semanticPlan(
      f.project,
      compositeRequest,
      {},
      {
        interpret: async () => incomplete,
        audit: async () => {
          audited++;
          return f.plan;
        },
      },
      async () => {},
    );
    assert.equal(audited, 1);
    assert.equal(plan.requirements.length, 10);
    assert.ok(
      plan.requirements
        .find((r) => r.target.sourceNodeId === "image")!
        .techniques.includes("fadeIn"),
    );
    const invalid = structuredClone(f.plan);
    invalid.requirements[0].sourceText = "paraphrase not in request";
    assert.throws(
      () => validateIntentPlan(f.project, compositeRequest, invalid),
      /verbatim/,
    );
  } finally {
    await f.cleanup();
  }
});
test("explicit request scope permits fade and scene timing while target repair rejects unrelated object", async () => {
  const f = await intentFixture();
  try {
    const doc = await readMotion(f.project),
      tasks = compileTasks(f.project, f.plan),
      timing = tasks[0],
      retimed = applyOperations(
        doc.state,
        compileRequirement(f.project, doc.state, f.plan, timing).operations,
        f.project,
      );
    assert.doesNotThrow(() =>
      assertIntentScope(f.project, doc.state, retimed, f.plan, timing),
    );
    const task = tasks.find((t) => t.targetReference.targetId === "logo")!,
      next = applyOperations(
        retimed,
        compileRequirement(f.project, retimed, f.plan, task).operations,
        f.project,
      );
    assert.doesNotThrow(() =>
      assertIntentScope(f.project, retimed, next, f.plan, task),
    );
    next.blocks[1].startFrame++;
    assert.throws(
      () => assertIntentScope(f.project, retimed, next, f.plan, task),
      /SCOPE/,
    );
  } finally {
    await f.cleanup();
  }
});
test("retiming shifts existing tracks/inertia, compresses shortened scene and preserves identity", async () => {
  const f = await intentFixture();
  try {
    const doc = await readMotion(f.project);
    const task = compileTasks(f.project, f.plan).find(
      (t) => t.targetReference.targetId === "qr",
    )!;
    const populated = applyOperations(
      doc.state,
      compileRequirement(f.project, doc.state, f.plan, task).operations,
      f.project,
    );
    const moved = applyOperations(
      populated,
      [
        {
          type: "retimeScenes",
          starts: [
            { sceneId: "s1", startFrame: 30 },
            { sceneId: "s2", startFrame: 90 },
          ],
        },
      ],
      f.project,
    );
    assert.equal(
      moved.animations[0].startFrame,
      populated.animations[0].startFrame - 30,
    );
    assert.equal(
      moved.expressions![0].startFrame,
      populated.expressions![0].startFrame - 30,
    );
    assert.throws(
      () =>
        applyOperations(
          moved,
          [
            {
              type: "retimeScenes",
              starts: [{ sceneId: "s2", startFrame: 20 }],
            },
          ],
          f.project,
        ),
      /order/,
    );
  } finally {
    await f.cleanup();
  }
});
test("one failed requirement preserves independent changes and final count stays ten, not six", async () => {
  const f = await intentFixture();
  try {
    let current = (await readMotion(f.project)).state;
    const result = await runIntentTasks(f.project, current, f.plan, {
      repair: async (feedback) => {
        const repair = (
          feedback as {
            repairFeedback: {
              targetId: string;
              expectedTechnique: string;
              failedChecks: { name: string }[];
            };
          }
        ).repairFeedback;
        assert.equal(repair.targetId, "ribbon2");
        assert.ok(repair.expectedTechnique.includes("trimPath"));
        if (repair.failedChecks.length)
          assert.equal(repair.failedChecks[0].name, "renderedPathReveal");
        throw new Error("fixture impossible path");
      },
      verify: async (task) => ({
        status:
          task.targetReference.targetId === "ribbon2" ? "FAILED" : "PASSED",
        checks: [],
      }),
      commit: async (t, p, next) => (current = next),
      trace: async () => {},
    });
    assert.equal(result.reconciliation.status, "PARTIAL_SUCCESS");
    assert.equal(result.reconciliation.completed, 9);
    assert.equal(result.reconciliation.requested, 10);
    assert.ok(
      current.animations.some(
        (a) => a.targetId === "discount" && a.effect === "fadeIn",
      ),
    );
  } finally {
    await f.cleanup();
  }
});
test("inheritance copies character not coordinates; faster modifier; edit softens existing movement without adding IDs", async () => {
  const f = await intentFixture();
  try {
    const input = structuredClone(f.plan);
    const qr = input.requirements.find((r) => r.target.sourceNodeId === "qr")!,
      logo = input.requirements.find((r) => r.target.sourceNodeId === "logo")!;
    logo.inheritFromRequirementId = qr.requirementId;
    logo.techniques = [];
    logo.parameters.durationFactor = 0.5;
    const expanded = expandInheritance(input);
    assert.deepEqual(
      expanded.requirements.find((r) => r.requirementId === logo.requirementId)!
        .techniques,
      qr.techniques,
    );
    let state = (await readMotion(f.project)).state;
    const task = compileTasks(f.project, input).find(
      (t) => t.targetReference.targetId === "logo",
    )!;
    state = applyOperations(
      state,
      compileRequirement(f.project, state, input, task).operations,
      f.project,
    );
    const ids = state.animations.map((a) => a.animationId);
    const edit = structuredClone(input);
    edit.requirements = [
      {
        ...logo,
        kind: "editAnimation",
        inheritFromRequirementId: null,
        techniques: ["slideUp"],
        parameters: { ...emptyParameters, easing: "easeOutQuad" },
        timing: { ...logo.timing, relation: "unchanged" },
      },
    ];
    const et = compileTasks(f.project, edit)[0];
    const next = applyOperations(
      state,
      compileRequirement(f.project, state, edit, et).operations,
      f.project,
    );
    assert.deepEqual(
      next.animations.map((a) => a.animationId),
      ids,
    );
    assert.equal(
      next.animations.find((a) => a.effect === "slideUp")!.easing,
      "easeOutQuad",
    );
  } finally {
    await f.cleanup();
  }
});
test("actual Chromium QA: clipped/reversed centerline and compositing do not require monotonic pixel count", async () => {
  const f = await intentFixture();
  try {
    let doc = await readMotion(f.project);
    const tasks = compileTasks(f.project, f.plan);
    const timing = tasks[0];
    doc.state = applyOperations(
      doc.state,
      compileRequirement(f.project, doc.state, f.plan, timing).operations,
      f.project,
    );
    const task = tasks.find((t) => t.targetReference.targetId === "ribbon2")!,
      r = f.plan.requirements.find((r) => r.requirementId === "ribbon2")!;
    r.inheritFromRequirementId = null;
    r.techniques = ["trimPath"];
    r.timing = {
      ...r.timing,
      relation: "sceneStart",
      anchorRequirementId: null,
    };
    r.parameters.direction = "rightToLeft";
    const before = doc.state,
      next = applyOperations(
        before,
        compileRequirement(f.project, before, f.plan, task).operations,
        f.project,
      );
    const qa = await motionQA(
      f.project,
      next,
      "motion/qa/semantic-trim",
      r.sourceText,
      before,
      task.targetReference,
    );
    assert.notEqual(qa.status, "FAILED", JSON.stringify(qa.checks));
    assert.ok(
      qa.checks.some(
        (c) => c.name === "revealParameters" && c.status === "PASSED",
      ),
    );
    assert.ok(
      qa.checks.some(
        (c) => c.name === "renderedPathReveal" && c.status === "PASSED",
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("scope comparison is independent of existing expression order and fails missing requested fade", async () => {
  const f = await intentFixture();
  try {
    let current = (await readMotion(f.project)).state;
    const tasks = compileTasks(f.project, f.plan);
    current = applyOperations(
      current,
      compileRequirement(f.project, current, f.plan, tasks[0]).operations,
      f.project,
    );
    for (const id of ["text", "qr", "image"]) {
      const task = tasks.find((t) => t.targetReference.targetId === id)!;
      current = applyOperations(
        current,
        compileRequirement(f.project, current, f.plan, task).operations,
        f.project,
      );
    }
    const task = tasks.find((t) => t.targetReference.targetId === "text")!,
      next = applyOperations(
        current,
        compileRequirement(f.project, current, f.plan, task).operations,
        f.project,
      );
    assert.doesNotThrow(() =>
      assertIntentScope(f.project, current, next, f.plan, task),
    );
    const broken = structuredClone(next);
    broken.animations = broken.animations.filter(
      (a) => a.targetId !== "text" || a.effect !== "fadeIn",
    );
    assert.ok(
      requirementChecks(
        broken,
        f.plan.requirements.find((r) => r.target.sourceNodeId === "text")!,
        f.plan,
      ).some((c) => c.status === "FAILED"),
    );
  } finally {
    await f.cleanup();
  }
});

test("intent retiming uses project FPS at 24 and 60, and temporal dependencies move with duration", async () => {
  const f = await intentFixture();
  try {
    for (const fps of [24, 60]) {
      let state = (await readMotion(f.project)).state;
      state.settings.fps = fps;
      state.settings.durationFrames = fps * 6;
      state.blocks.forEach((b, i) => {
        b.startFrame = i * fps * 2;
        b.durationFrames = fps * 2;
      });
      const tasks = compileTasks(f.project, f.plan);
      state = applyOperations(
        state,
        compileRequirement(f.project, state, f.plan, tasks[0]).operations,
        f.project,
      );
      assert.equal(state.blocks[1].startFrame, fps);
      assert.equal(state.blocks[2].startFrame, 3 * fps);
      for (const id of ["ribbon1", "ribbon2"]) {
        const task = tasks.find((t) => t.targetReference.targetId === id)!;
        state = applyOperations(
          state,
          compileRequirement(f.project, state, f.plan, task).operations,
          f.project,
        );
      }
      const first = state.animations.find((a) => a.targetId === "ribbon1")!,
        second = state.animations.find((a) => a.targetId === "ribbon2")!;
      assert.equal(second.startFrame, first.startFrame + first.durationFrames);
    }
  } finally {
    await f.cleanup();
  }
});
