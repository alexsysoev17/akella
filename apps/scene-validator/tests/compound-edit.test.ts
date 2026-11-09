import test from "node:test";
import assert from "node:assert/strict";
import { identityFixture, node } from "./identity-fixture.js";
import { objectRequirement } from "./intent-fixture.js";
import { validateIntentPlan } from "../src/motion/intent/planner.js";
import {
  compileRequirement,
  compileTasks,
} from "../src/motion/intent/compiler.js";
import {
  requirementChecks,
  runIntentTasks,
} from "../src/motion/intent/execution.js";
import { applyOperations } from "../src/motion/operations.js";
import { registerProvider } from "../src/harness/providers/index.js";
import { readMotion, changeMotion } from "../src/motion/store.js";
import { executeMotion } from "../src/motion/service.js";
import { resolveBaseMotion } from "../src/motion/base-motion.js";
import type { IntentPlan } from "../src/motion/intent/schema.js";
const prompt =
  "Убери easing у image текст куар лого и сделай затухающую инерцию в конце движения сильнее";
async function fixture() {
  const f = await identityFixture(1, (s) => {
    s[0].children = ["image", "текст", "куар", "лого"].map((n, i) =>
      node("n" + i, n, 10 + 30 * i, 20),
    );
  });
  f.state.settings.fps = 30;
  f.state.settings.durationFrames = 150;
  f.state.blocks[0].durationFrames = 150;
  f.state.animations = ["n0", "n1", "n2", "n3"].map((targetId, i) => ({
    animationId: "base" + i,
    targetId,
    sceneId: "s0",
    effect: i % 2 ? "slideDown" : "slideUp",
    parameters: { distance: 80, mode: "in" },
    easing: "easeOutCubic",
    startFrame: 30,
    durationFrames: 21,
    enabled: true,
  }));
  return f;
}
function plan(): IntentPlan {
  return {
    schemaVersion: "1.0.0",
    requirements: ["image", "текст", "куар", "лого"].map((name, i) => {
      const r = objectRequirement(
        "r" + i,
        "s0",
        "n" + i,
        name,
        [i % 2 ? "slideDown" : "slideUp", "inertialOvershoot"],
        prompt,
      );
      r.kind = "editAnimation";
      r.parameters.easing = "linear";
      r.parameters.property = "y";
      r.timing.relation = "unchanged";
      return r;
    }),
    coverage: [
      {
        sourceText: prompt,
        requirementIds: ["r0", "r1", "r2", "r3"],
        classification: "executable",
        explanation: "synthetic saved-run structure",
      },
    ],
    assumptions: [],
  };
}
test("compound easing + new inertia compiles eight actions, samples UPDATED linear velocity and preserves every other base field", async () => {
  const f = await fixture();
  try {
    const p = validateIntentPlan(f.project, prompt, plan(), 30, {
      state: f.state,
    });
    let state = f.state;
    for (const task of compileTasks(f.project, p)) {
      const compiled = compileRequirement(f.project, state, p, task);
      assert.deepEqual(
        compiled.operations.map((o) => o.type),
        ["updateAnimation", "setExpression"],
      );
      const previous = state;
      state = applyOperations(state, compiled.operations, f.project);
      assert.ok(
        requirementChecks(
          state,
          p.requirements.find(
            (r) => r.requirementId === task.requirementIds[0],
          )!,
          p,
          previous,
        ).every((c) => c.status === "PASSED"),
      );
    }
    assert.equal(state.expressions!.length, 4);
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(state.animations[i], {
        ...f.state.animations[i],
        easing: "linear",
      });
      const base = resolveBaseMotion(state, "s0", "n" + i);
      assert.ok(Math.abs(base.tracks[0].incomingVelocity.y!) > 100);
      assert.equal(state.expressions![i].startFrame, 51);
      assert.equal(state.expressions![i].parameters.amplitude, 0.4);
    }
    const duration = structuredClone(p);
    duration.requirements = duration.requirements.slice(0, 1);
    duration.requirements[0].parameters.durationFactor = 2;
    const next = applyOperations(
      f.state,
      compileRequirement(
        f.project,
        f.state,
        duration,
        compileTasks(f.project, duration)[0],
      ).operations,
      f.project,
    );
    assert.equal(next.expressions![0].startFrame, 72);
    assert.equal(next.animations[0].durationFrames, 42);
    const easingOnly = structuredClone(duration);
    easingOnly.requirements[0].techniques = ["slideUp"];
    assert.deepEqual(
      compileRequirement(
        f.project,
        f.state,
        easingOnly,
        compileTasks(f.project, easingOnly)[0],
      ).operations.map((o) => o.type),
      ["updateAnimation"],
    );
  } finally {
    await f.cleanup();
  }
});
test("missing expression uses qualitative default; existing expression strengthened once without duplicate and frequency edit composes", async () => {
  const f = await fixture();
  try {
    const p = validateIntentPlan(f.project, prompt, plan(), 30, {
      state: f.state,
    });
    const t = compileTasks(f.project, p)[0];
    let state = applyOperations(
      f.state,
      compileRequirement(f.project, f.state, p, t).operations,
      f.project,
    );
    const r = p.requirements[0];
    r.techniques = ["inertialOvershoot"];
    r.parameters.easing = null;
    r.parameters.intensity = null;
    r.parameters.amplitudeFactor = 1.5;
    r.parameters.frequencyFactor = 1.2;
    const next = applyOperations(
      state,
      compileRequirement(f.project, state, p, compileTasks(f.project, p)[0])
        .operations,
      f.project,
    );
    assert.equal(next.expressions!.length, 1);
    assert.equal(
      next.expressions![0].expressionId,
      state.expressions![0].expressionId,
    );
    assert.ok(
      Math.abs(next.expressions![0].parameters.amplitude - 0.6) < 1e-10,
    );
    assert.equal(
      (next.expressions![0].parameters as { frequency: number }).frequency,
      3,
    );
    assert.deepEqual(next.animations, state.animations);
  } finally {
    await f.cleanup();
  }
});
test("production compound workflow: one mock semantic call, real Chromium QA, four atomic commits, no repair and operation coverage", async () => {
  const f = await fixture();
  let calls = 0;
  const stop = registerProvider("compound-mock", () => ({
    id: "compound-mock",
    mode: "mock",
    capabilities: () => ({
      structuredOutput: true,
      nativeToolCalling: false,
      cancellation: true,
      usage: false,
      nativeOutputTokenLimit: false,
    }),
    generate: async () => {
      calls++;
      return {
        output: plan(),
        usage: null,
        estimatedCost: null,
        latencyMs: 0,
        diagnostics: ["mock, not live E2E"],
        toolCalls: [],
      };
    },
  }));
  try {
    let doc = await readMotion(f.project);
    doc = (
      await changeMotion(f.project.root, {
        expectedRevision: doc.revision,
        request: "synthetic seed",
        operations: [
          { type: "setProjectSettings", settings: f.state.settings },
          { type: "setBlocks", blocks: f.state.blocks },
          ...f.state.animations.map((animation) => ({
            type: "addAnimation" as const,
            animation,
          })),
        ],
      })
    ).document;
    const result = await executeMotion(f.project, {
      mode: "edit",
      request: prompt,
      expectedRevision: doc.revision,
      settings: { provider: "compound-mock", model: "" },
    });
    assert.equal(
      result.reconciliation?.status,
      "SUCCESS",
      JSON.stringify(result.reconciliation),
    );
    assert.equal(calls, 1);
    assert.equal(result.tasks!.length, 4);
    for (const t of result.tasks!) {
      assert.equal((t.qaResult as { status: string }).status, "PASSED");
      assert.equal(
        (t.operationCoverage as { status: string }).status,
        "PASSED",
      );
      assert.equal(t.generatedOperations!.length, 2);
      assert.equal(t.repairHistory.length, 1);
    }
    const after = await readMotion(f.project);
    assert.equal(after.state.expressions!.length, 4);
    assert.deepEqual(after.state.blocks, doc.state.blocks);
  } finally {
    stop();
    await f.cleanup();
  }
});

test("invalid compound expression is atomic; unsupported expression combination stops as compiler coverage error without AI repair", async () => {
  const f = await fixture();
  try {
    for (const invalidAmplitude of [true, false]) {
      const p = validateIntentPlan(f.project, prompt, plan(), 30, {
        state: f.state,
      });
      p.requirements = p.requirements.slice(0, 1);
      p.coverage[0].requirementIds = ["r0"];
      if (invalidAmplitude) p.requirements[0].parameters.amplitude = -1;
      else p.requirements[0].techniques = ["slideUp", "wiggle"];
      let repairs = 0,
        commits = 0,
        qa = 0;
      const result = await runIntentTasks(f.project, f.state, p, {
        repair: async () => {
          repairs++;
          throw new Error("Unexpected AI repair");
        },
        verify: async () => {
          qa++;
          return { status: "PASSED" };
        },
        commit: async (_t, _p, next) => {
          commits++;
          return next;
        },
        trace: async () => {},
      });
      assert.equal(result.tasks[0].status, "FAILED");
      assert.equal(commits, 0);
      assert.equal(repairs, 0);
      assert.equal(qa, 0);
      assert.ok(
        result.tasks[0].error!.includes(
          invalidAmplitude
            ? "OPERATION_VALIDATION_ERROR"
            : "COMPILER_COVERAGE_ERROR",
        ),
      );
      assert.equal(f.state.animations[0].easing, "easeOutCubic");
    }
  } finally {
    await f.cleanup();
  }
});

test("compound edits compose duration/easing across position+opacity, scale+spring, and reveal direction+duration", async () => {
  const f = await identityFixture(1, (s) => {
    const n = node("n0", "текст", 20, 20);
    n.type = "TEXT";
    s[0].children = [n];
  });
  try {
    f.state.settings.fps = 30;
    f.state.settings.durationFrames = 150;
    f.state.blocks[0].durationFrames = 150;
    const common = {
      animationId: "base",
      sceneId: "s0",
      targetId: "n0",
      startFrame: 0,
      durationFrames: 20,
      easing: "linear" as const,
      enabled: true,
    };
    const r = objectRequirement(
      "r",
      "s0",
      "n0",
      "текст",
      ["slideUp", "fadeIn"],
      "текст движение и фейд медленнее без изинга",
    );
    r.kind = "editAnimation";
    r.timing.relation = "unchanged";
    r.parameters.durationFactor = 2;
    r.parameters.easing = "linear";
    const p: IntentPlan = {
      schemaVersion: "1.0.0",
      requirements: [r],
      coverage: [
        {
          sourceText: r.sourceText,
          requirementIds: ["r"],
          classification: "executable",
          explanation: "synthetic compound",
        },
      ],
      assumptions: [],
    };
    f.state.animations = [
      {
        ...common,
        effect: "slideUp",
        parameters: { distance: 40, mode: "in" },
      },
      {
        ...common,
        animationId: "fade",
        effect: "fadeIn",
        parameters: { from: 0, to: 1 },
      },
    ];
    let next = applyOperations(
      f.state,
      compileRequirement(f.project, f.state, p, compileTasks(f.project, p)[0])
        .operations,
      f.project,
    );
    assert.equal(next.animations.length, 2);
    assert.ok(next.animations.every((a) => a.durationFrames === 40));
    f.state.animations = [
      { ...common, effect: "scaleIn", parameters: { from: 0.8, to: 1 } },
    ];
    r.techniques = ["scaleIn", "spring"];
    r.parameters.scaleTo = 1.5;
    r.parameters.easing = {
      type: "spring",
      parameters: { stiffness: 100, damping: 12, mass: 1 },
    };
    next = applyOperations(
      f.state,
      compileRequirement(f.project, f.state, p, compileTasks(f.project, p)[0])
        .operations,
      f.project,
    );
    assert.equal(next.animations[0].durationFrames, 40);
    assert.deepEqual(next.animations[0].easing, r.parameters.easing);
    assert.equal((next.animations[0].parameters as { to: number }).to, 1.5);
    f.state.animations = [
      {
        ...common,
        effect: "maskReveal",
        parameters: { from: 0, to: 1, direction: "forward" },
      },
    ];
    r.techniques = ["maskReveal"];
    r.parameters.scaleTo = null;
    r.parameters.easing = "linear";
    r.parameters.direction = "reverse";
    next = applyOperations(
      f.state,
      compileRequirement(f.project, f.state, p, compileTasks(f.project, p)[0])
        .operations,
      f.project,
    );
    assert.equal(next.animations[0].durationFrames, 40);
    assert.equal(
      (next.animations[0].parameters as { direction: string }).direction,
      "reverse",
    );
  } finally {
    await f.cleanup();
  }
});
