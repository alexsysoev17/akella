import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAnimation, evaluateMotion } from "../src/motion/engine.js";
import { expressionValue } from "../src/motion/expressions.js";
import {
  inertialOvershoot,
  velocityAtTime,
  inertialVector,
} from "../src/motion-library/expressions/functions.js";
import {
  evaluateEasing,
  easingSchema,
} from "../src/motion-library/easings/registry.js";
import type { Animation } from "../src/motion/schema.js";
import type { Expression } from "../src/motion-library/expressions/registry.js";
import {
  aeReference,
  base,
  inertia,
  compareReference,
} from "./ae-reference.js";
test("AE reference A: exact expression math matches every supplied frame within 0.15px; Vector2/3 keep zero axes", () => {
  const result = compareReference();
  assert.ok(result.formulaMaxError <= 0.15);
  for (const row of result.rows) assert.ok(row.formulaError <= 0.15);
  assert.deepEqual(inertialVector(0.1, [0, -60.5], 0.1, 2, 4), [
    0,
    inertialOvershoot(0.1, -60.5, 0.1, 2, 4),
  ]);
  assert.equal(inertialVector(0.1, [0, -60.5, 0], 0.1, 2, 4)[2], 0);
});
test("AE reference B: temporal Easy Ease independently derives velocity; measured AE discrepancy stays explicit, not fitted", () => {
  const result = compareReference();
  const u = (0.5 - 1 / 300) / 0.5;
  const analytical = (-641 / 0.5) * 6 * u * (1 - u);
  assert.ok(Math.abs(result.computedVelocity - analytical) < 0.03);
  assert.equal(
    result.endToEndTolerancePassed,
    false,
    "Given reference is not reproduced by documented zero-speed 33.33% interpolation; do not pretend parity",
  );
  assert.ok(result.endToEndMaxError > 0.15);
  assert.ok(result.endToEndMaxError < 1);
  assert.equal(evaluateEasing(0.5, easingSchema.parse("aeEasyEase")), 0.5);
  assert.notEqual(
    evaluateEasing(0.25, "aeEasyEase"),
    evaluateEasing(0.25, "easeInOutCubic"),
  );
});
test("AE velocity is local, subframe and segment-bounded, never a six-frame average", () => {
  assert.ok(Math.abs(velocityAtTime((t) => t * t, 0.5, 1e-5) - 1) < 1e-8);
  let max = -Infinity;
  velocityAtTime(
    (t) => {
      max = Math.max(max, t);
      return t * t;
    },
    0.49999,
    0.0001,
    { start: 0, end: 0.5 },
  );
  assert.ok(max <= 0.5);
  assert.ok(Number.isFinite(evaluateAnimation(base, 14.9).y));
});
test("AE inertia responds to distance/duration/easing and amplitude edits without extra keyframes; legacy mode remains different", () => {
  const sample = (
    a: Animation,
    e: Extract<Expression, { type: "inertialOvershoot" }> = inertia,
  ) =>
    expressionValue(
      {
        ...e,
        sourceAnimationId: a.animationId,
        startFrame: a.startFrame + a.durationFrames,
      },
      a.startFrame + a.durationFrames + 3,
      30,
      [a],
      evaluateAnimation,
    );
  const original = sample(base);
  const twice = {
    ...base,
    parameters: {
      property: "y" as const,
      points: [
        { frame: 0, value: 2251.6 },
        { frame: 15, value: 969.6 },
      ],
    },
  };
  assert.ok(Math.abs(sample(twice) - original * 2) < 1e-6);
  const longer = {
    ...base,
    durationFrames: 30,
    parameters: {
      property: "y" as const,
      points: [
        { frame: 0, value: 1610.6 },
        { frame: 30, value: 969.6 },
      ],
    },
  };
  assert.ok(Math.abs(sample(longer)) < Math.abs(original));
  assert.notEqual(sample({ ...base, easing: "linear" }), original);
  const half = {
    ...inertia,
    parameters: { ...inertia.parameters, amplitude: 0.05 },
  };
  assert.ok(Math.abs(sample(base, half) - original / 2) < 1e-9);
  assert.equal(base.parameters.points.length, 2);
  assert.notEqual(
    sample(base, {
      ...inertia,
      parameters: { ...inertia.parameters, mode: "legacy" },
    }),
    original,
  );
});

test("AE keyframe updates retime linked expression and nearest-key evaluation samples only the incoming segment", async () => {
  const { identityFixture, node } = await import("./identity-fixture.js");
  const { applyOperations } = await import("../src/motion/operations.js");
  const f = await identityFixture(1, (scenes) => {
    scenes[0].children = [node("text", "Text")];
  });
  try {
    f.state.settings = { ...f.state.settings, fps: 30, durationFrames: 120 };
    f.state.blocks[0].durationFrames = 120;
    const source = { ...base, targetId: "text" };
    const expression = { ...inertia, targetId: "text" };
    const state = {
      ...f.state,
      animations: [source],
      expressions: [expression],
    };
    const updated = applyOperations(
      state,
      [
        {
          type: "updateAnimation",
          animationId: source.animationId,
          animation: {
            ...source,
            durationFrames: 30,
            parameters: {
              property: "y",
              points: [
                { frame: 0, value: 1610.6 },
                { frame: 30, value: 969.6 },
              ],
            },
          },
        },
      ],
      f.project,
    );
    assert.equal(updated.expressions![0].startFrame, 30);
    assert.equal(updated.expressions![0].parameters.amplitude, 0.1);
    const keys: Animation = {
      ...source,
      durationFrames: 30,
      parameters: {
        property: "y",
        points: [
          { frame: 0, value: 0 },
          { frame: 15, value: 100 },
          { frame: 30, value: 50 },
        ],
      },
    };
    const e: Expression = { ...expression, startFrame: 0, durationFrames: 60 };
    assert.ok(expressionValue(e, 18, 30, [keys], evaluateAnimation) > 0);
    assert.ok(expressionValue(e, 33, 30, [keys], evaluateAnimation) < 0);
  } finally {
    await f.cleanup();
  }
});

test("AE sampling uses actual project FPS at 24/30/60, and incoming influence changes the derivative", () => {
  for (const fps of [24, 30, 60]) {
    const linear = { ...base, easing: "linear" as const };
    const actual = expressionValue(
      inertia,
      16,
      fps,
      [linear],
      evaluateAnimation,
    );
    const velocity = (-641 * fps) / 15;
    const expected = inertialOvershoot(1 / fps, velocity, 0.1, 2, 4);
    assert.ok(Math.abs(actual - expected) < 1e-6);
  }
  const custom = {
    ...base,
    easing: {
      type: "aeEasyEase" as const,
      parameters: { outInfluence: 33.33, inInfluence: 60 },
    },
  };
  assert.notEqual(
    expressionValue(inertia, 18, 30, [custom], evaluateAnimation),
    expressionValue(inertia, 18, 30, [base], evaluateAnimation),
  );
});

test("AE numerical QA checks continuity and records literal cutoff residual instead of applying a hidden envelope", async () => {
  const { identityFixture, node } = await import("./identity-fixture.js");
  const { numericQA } = await import("../src/motion/qa/numeric.js");
  const f = await identityFixture(1, (scenes) => {
    scenes[0].children = [node("text", "Text")];
  });
  try {
    const state = {
      ...f.state,
      settings: { ...f.state.settings, fps: 30, durationFrames: 90 },
      blocks: [{ ...f.state.blocks[0], durationFrames: 90 }],
      animations: [base],
      expressions: [inertia],
    };
    const qa = numericQA(state);
    assert.equal(
      qa.checks.find((c) => c.name === "continuousEndpoints")?.status,
      "PASSED",
    );
    assert.equal(
      qa.checks.find((c) => c.name === "aeDurationCutoff")?.status,
      "PASSED",
    );
    const discontinuous = {
      ...state,
      expressions: [
        { ...inertia, parameters: { ...inertia.parameters, frequency: 2.25 } },
      ],
    };
    const report = numericQA(discontinuous);
    assert.equal(
      report.checks.find((c) => c.name === "aeDurationCutoff")?.status,
      "WARNING",
    );
    assert.equal(
      report.checks.find((c) => c.name === "continuousEndpoints")?.status,
      "WARNING",
    );
  } finally {
    await f.cleanup();
  }
});

test("Intent editing preserves keyframe values/easing, rescales key times and edits inertia amplitude without losing retiming", async () => {
  const { identityFixture, node } = await import("./identity-fixture.js");
  const { objectRequirement } = await import("./intent-fixture.js");
  const { compileTasks, compileRequirement } = await import(
    "../src/motion/intent/compiler.js"
  );
  const { applyOperations } = await import("../src/motion/operations.js");
  const f = await identityFixture(1, (scenes) => {
    scenes[0].children = [node("text", "Text")];
  });
  try {
    const state = {
      ...f.state,
      settings: { ...f.state.settings, fps: 30, durationFrames: 120 },
      blocks: [{ ...f.state.blocks[0], durationFrames: 120 }],
      animations: [base],
      expressions: [{ ...inertia, startFrame: 18 }],
    };
    const r = objectRequirement(
      "edit",
      "s0",
      "text",
      "Text",
      ["customCurve", "inertialOvershoot"],
      "Сделай движение дольше, а колебания вдвое слабее",
    );
    r.kind = "editAnimation";
    r.parameters.durationFactor = 2;
    r.parameters.amplitudeFactor = 0.5;
    const plan = {
      schemaVersion: "1.0.0" as const,
      requirements: [r],
      coverage: [],
      assumptions: [],
    };
    const task = compileTasks(f.project, plan)[0];
    const ops = compileRequirement(f.project, state, plan, task);
    const next = applyOperations(state, ops.operations, f.project);
    const a = next.animations[0];
    assert.equal(a.effect, "keyframes");
    if (a.effect === "keyframes")
      assert.deepEqual(a.parameters.points, [
        { frame: 0, value: 1610.6 },
        { frame: 30, value: 969.6 },
      ]);
    assert.equal(a.easing, "aeEasyEase");
    assert.equal(next.expressions![0].startFrame, 33);
    assert.equal(next.expressions![0].parameters.amplitude, 0.05);
  } finally {
    await f.cleanup();
  }
});
