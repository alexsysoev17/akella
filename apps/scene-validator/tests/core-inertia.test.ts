import test from "node:test";
import assert from "node:assert/strict";
import { identityFixture, node } from "./identity-fixture.js";
import {
  evaluateAnimation,
  valueAtTime,
  velocityAtTime,
} from "../src/motion/engine.js";
import { expressionValue } from "../src/motion/expressions.js";
import { applyOperations } from "../src/motion/operations.js";
import { instantiatePreset } from "../src/motion-library/presets/registry.js";
import { capabilityRegistry } from "../src/motion-library/registry/capabilities.js";
import { retrieveTechniques } from "../src/motion-library/techniques/registry.js";
import type { MotionState, Animation } from "../src/motion/schema.js";
import type { Expression } from "../src/motion-library/expressions/registry.js";
const source: Animation = {
  animationId: "move",
  sceneId: "s0",
  targetId: "qr",
  effect: "moveTo",
  parameters: { fromX: 0, toX: 0, fromY: 80, toY: 0 },
  easing: "linear",
  startFrame: 0,
  durationFrames: 15,
  enabled: true,
};
const expression: Expression = {
  expressionId: "inertia",
  sceneId: "s0",
  targetId: "qr",
  type: "inertialOvershoot",
  property: "y",
  sourceAnimationId: "move",
  startFrame: 15,
  durationFrames: 30,
  enabled: true,
  parameters: {
    amplitude: 0.1,
    frequency: 2.5,
    decay: 4,
    velocityLookbackFrames: 6,
  },
};
test("Core subframe value/velocity sampling returns independent components from eased BASE, not expressions", () => {
  assert.equal(valueAtTime(source, 0.25, 30).y, 40);
  const v = velocityAtTime(source, 0.5 - 1 / 300, 30);
  assert.equal(v.x, 0);
  assert.ok(Math.abs(v.y! + 160) < 1e-6);
  const c = capabilityRegistry.find((c) => c.id === "inertialOvershoot");
  assert.equal(c?.evaluator, expressionValue);
  for (const prompt of [
    "Сделай инерцию после движения",
    "Добавь затухающие колебания",
    "Пусть объект немного покачается после остановки",
  ])
    assert.ok(
      retrieveTechniques(prompt).some((t) => t.id === "inertialOvershoot"),
    );
});
test("Operations create modern inertia by default, preserve stored legacy on edits, and presets select same evaluator version", async () => {
  const f = await identityFixture(1, (scenes) => {
    scenes[0].children = [node("qr", "QR")];
  });
  try {
    const state = {
      ...f.state,
      settings: { ...f.state.settings, fps: 30, durationFrames: 120 },
      blocks: [{ ...f.state.blocks[0], durationFrames: 120 }],
      animations: [source],
      expressions: [] as Expression[],
    };
    const created = applyOperations(
      state,
      [{ type: "setExpression", expression }],
      f.project,
    );
    assert.equal(created.expressions![0].type, "inertialOvershoot");
    if (created.expressions![0].type === "inertialOvershoot")
      assert.equal(created.expressions![0].parameters.mode, "ae");
    const legacy = { ...state, expressions: [expression] };
    const baseline = expressionValue(
      expression,
      42,
      30,
      [source],
      evaluateAnimation,
    );
    const changed = applyOperations(
      legacy,
      [
        {
          type: "setExpression",
          expression: {
            ...expression,
            parameters: { ...expression.parameters, amplitude: 0.05 },
          },
        },
      ],
      f.project,
    );
    assert.ok(!("mode" in changed.expressions![0].parameters));
    assert.ok(
      Math.abs(
        expressionValue(
          changed.expressions![0],
          42,
          30,
          [source],
          evaluateAnimation,
        ) -
          baseline * 0.5,
      ) < 1e-9,
    );
    assert.deepEqual(changed.animations, legacy.animations);
    const preset = instantiatePreset(
      "smooth-overshoot",
      "p",
      "s0",
      "qr",
      0,
      30,
    );
    assert.ok(
      preset.expressions.some(
        (e) => e.type === "inertialOvershoot" && e.parameters.mode === "ae",
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("Intent compiler defaults all new inertia to modern version for arbitrary easing, with no AE request", async () => {
  const f = await identityFixture(1, (scenes) => {
    scenes[0].children = [node("qr", "QR")];
  });
  try {
    const { objectRequirement } = await import("./intent-fixture.js");
    const { compileTasks, compileRequirement } = await import(
      "../src/motion/intent/compiler.js"
    );
    const state = {
      ...f.state,
      settings: { ...f.state.settings, fps: 30, durationFrames: 120 },
      blocks: [{ ...f.state.blocks[0], durationFrames: 120 }],
      animations: [source],
      expressions: [],
    };
    for (const easing of [
      "linear",
      "easeOutCubic",
      "easeInOutCubic",
    ] as const) {
      const request = objectRequirement(
        "r",
        "s0",
        "qr",
        "QR",
        ["inertialOvershoot"],
        "Добавь затухающие колебания",
      );
      const plan = {
        schemaVersion: "1.0.0" as const,
        requirements: [request],
        coverage: [],
        assumptions: [],
      };
      const base: MotionState = {
        ...state,
        animations: [{ ...source, easing }],
      };
      const task = compileTasks(f.project, plan)[0],
        result = applyOperations(
          base,
          compileRequirement(f.project, base, plan, task).operations,
          f.project,
        );
      assert.deepEqual(result.animations, base.animations);
      assert.ok(
        result.expressions!.every(
          (e) => e.type === "inertialOvershoot" && e.parameters.mode === "ae",
        ),
      );
    }
  } finally {
    await f.cleanup();
  }
});
