import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { identityFixture, node } from "./identity-fixture.js";
import { motionQA } from "../src/motion/qa/render.js";
import { numericQA } from "../src/motion/qa/numeric.js";
import {
  intentRequirements,
  validateTechnique,
} from "../src/motion/qa/technical.js";
import { runAutonomous } from "../src/motion/autonomy.js";
import { applyOperations } from "../src/motion/operations.js";
import { motionKnowledge } from "../src/motion-library/knowledge.js";
import { capabilityRegistry } from "../src/motion-library/registry/capabilities.js";
import { inventory, fingerprint } from "../src/files.js";
import type { Animation, MotionState } from "../src/motion/schema.js";
import type { Expression } from "../src/motion-library/expressions/registry.js";
const base: Animation = {
  animationId: "move",
  sceneId: "s0",
  targetId: "qr",
  effect: "property",
  parameters: { property: "x", from: -30, to: 0 },
  startFrame: 0,
  durationFrames: 24,
  easing: "linear",
  enabled: true,
};
const inertia: Expression = {
  expressionId: "inertia",
  sceneId: "s0",
  targetId: "qr",
  property: "x",
  startFrame: 24,
  durationFrames: 60,
  enabled: true,
  type: "inertialOvershoot",
  sourceAnimationId: "move",
  parameters: {
    amplitude: 0.1,
    frequency: 3,
    decay: 3,
    velocityLookbackFrames: 6,
  },
};
const trim: Animation = {
  animationId: "draw",
  sceneId: "s0",
  targetId: "line",
  effect: "trimPath",
  parameters: { from: 0, to: 1, direction: "forward" },
  startFrame: 0,
  durationFrames: 60,
  easing: "linear",
  enabled: true,
};
async function fixture() {
  const f = await identityFixture(1, (scenes) => {
    const qr = node("qr", "QR", 150, 10, 20, 20),
      line = node("line", "Линия", 0, 0, 140, 100);
    line.type = "VECTOR";
    line.properties = {
      ...line.properties,
      fills: [],
      strokes: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
      strokeAlign: "CENTER",
      strokeWeight: 3,
      strokeCap: "ROUND",
      dashPattern: [5, 2],
      vectorPaths: [
        { data: "M10 70 C30 10 70 110 120 40", windingRule: "NONZERO" },
        { data: "M10 95 L100 95", windingRule: "NONZERO" },
      ],
    };
    scenes[0].children = [qr, line];
  });
  f.state.settings = { ...f.state.settings, fps: 30, durationFrames: 120 };
  f.state.blocks[0].durationFrames = 120;
  return f;
}
test("knowledge entries link actual evaluators and schemas; intent rejects keyframe/scale imitations", async () => {
  const f = await fixture();
  try {
    const knowledge = await motionKnowledge(
      "Линия Trim Paths и инерционные колебания",
      false,
    );
    assert.ok(knowledge.techniques.some((t) => t.id === "trimPaths"));
    for (const t of knowledge.techniques)
      assert.ok(
        capabilityRegistry.some(
          (c) =>
            c.id === t.implementationId && typeof c.evaluator === "function",
        ),
      );
    const req = intentRequirements(
      f.project,
      f.state,
      "Линия должна прорисовываться как Trim Paths",
      { runtimeTarget: { sceneId: "s0", targetId: "line" } },
    );
    assert.throws(
      () =>
        validateTechnique(
          { ...f.state, animations: [{ ...base, targetId: "line" }] },
          req,
        ),
      /TECHNIQUE_MISMATCH/,
    );
    assert.doesNotThrow(() =>
      validateTechnique({ ...f.state, animations: [trim] }, req),
    );
    const existing = {
      ...f.state,
      animations: [trim, base],
      expressions: [inertia],
    };
    const combined = intentRequirements(
      f.project,
      existing,
      "Колебания сделай в два раза слабее, а линию прорисовывай медленнее.",
      { runtimeTarget: { sceneId: "s0", targetId: "qr" } },
    );
    assert.deepEqual(
      combined.find((r) => r.technique === "trimPaths")?.targets,
      [{ sceneId: "s0", targetId: "line" }],
    );
    assert.doesNotThrow(() => validateTechnique(existing, combined));
    const inertial = intentRequirements(
      f.project,
      f.state,
      "QR инерционные колебания после движения",
      { runtimeTarget: { sceneId: "s0", targetId: "qr" } },
    );
    assert.throws(
      () => validateTechnique({ ...f.state, animations: [base] }, inertial),
      /TECHNIQUE_MISMATCH/,
    );
  } finally {
    await f.cleanup();
  }
});
test("numerical inertia QA catches zero motion, aliasing, measures frequency/decay and finite endpoints", async () => {
  const f = await fixture();
  try {
    const state = { ...f.state, animations: [base], expressions: [inertia] };
    const good = numericQA(state);
    assert.equal(
      good.checks.filter((c) => c.status === "FAILED").length,
      0,
      JSON.stringify(good.checks),
    );
    for (const field of ["amplitude", "incomingImpulse"]) {
      const e = structuredClone(inertia);
      if (field === "amplitude") e.parameters.amplitude = 0;
      else e.parameters.incomingImpulse = -37.5;
      assert.ok(
        numericQA({ ...state, expressions: [e] }).checks.some(
          (c) => c.name === "visibleOscillation" && c.status === "FAILED",
        ),
      );
    }
    const fast = structuredClone(inertia);
    fast.parameters.frequency = 20;
    assert.ok(
      numericQA({ ...state, expressions: [fast] }).checks.some(
        (c) => c.name === "samplingRate" && c.status === "FAILED",
      ),
    );
    const jump = {
      ...base,
      animationId: "jump",
      startFrame: 24,
      parameters: { property: "x" as const, from: 100, to: 0 },
    };
    assert.ok(
      numericQA({ ...f.state, animations: [base, jump] }).checks.some(
        (c) => c.name === "trackJunction" && c.status === "FAILED",
      ),
    );
    assert.ok(
      numericQA(
        { ...f.state, animations: [base, jump] },
        "Резкий скачок",
      ).checks.some(
        (c) => c.name === "trackJunction" && c.status === "WARNING",
      ),
    );
    const huge = structuredClone(inertia);
    huge.parameters.amplitude = 1.5;
    assert.equal(
      numericQA({ ...state, expressions: [huge] }).checks.filter(
        (c) => c.status === "FAILED",
      ).length,
      0,
    );
  } finally {
    await f.cleanup();
  }
});
test("actual renderer QA verifies curved multi-path reveal, reverse direction, immutable geometry and real inertia pixels", async () => {
  const f = await fixture();
  try {
    const before = fingerprint(await inventory(f.project.sourceRoot));
    const state = applyOperations(
      f.state,
      [
        { type: "addAnimation", animation: trim },
        { type: "addAnimation", animation: base },
        { type: "setExpression", expression: inertia },
      ],
      f.project,
    );
    const report = await motionQA(
      f.project,
      state,
      "motion/qa/test-forward",
      "QA",
      f.state,
    );
    assert.notEqual(report.status, "FAILED", JSON.stringify(report.checks));
    for (const name of [
      "renderedPathReveal",
      "immutableGeometry",
      "renderedOscillation",
      "continuousEndpoints",
    ])
      assert.ok(
        report.checks.some((c) => c.name === name && c.status === "PASSED"),
        name,
      );
    assert.ok(report.checks.some((c) => c.status === "NOT_TESTED"));
    const reverse = structuredClone(state);
    const a = reverse.animations.find((a) => a.effect === "trimPath")!;
    if (a.effect === "trimPath") a.parameters.direction = "reverse";
    const reversed = await motionQA(
      f.project,
      reverse,
      "motion/qa/test-reverse",
      "reverse",
      state,
    );
    assert.notEqual(reversed.status, "FAILED", JSON.stringify(reversed.checks));
    assert.ok(
      (
        await readFile(
          path.join(f.project.root, "motion/qa/test-forward/contact-sheet.png"),
        )
      ).length > 100,
    );
    assert.equal(before, fingerprint(await inventory(f.project.sourceRoot)));
  } finally {
    await f.cleanup();
  }
});
test("repair consumes actual QA report, replaces failed candidate, stops at limit and preserves source/current state", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const snapshot = JSON.stringify(f.state);
    const generated = await runAutonomous(
      f.project,
      f.state,
      { runtimeTarget: { sceneId: "s0", targetId: "qr" } },
      "QR инерционные колебания после движения",
      async (context) => {
        calls++;
        if (calls > 1)
          assert.equal(
            (context as { runtimeFeedback: { qaReport: { status: string } } })
              .runtimeFeedback.qaReport.status,
            "FAILED",
          );
        const e = structuredClone(inertia);
        e.parameters.amplitude = calls === 1 ? 0 : 0.1;
        return {
          status: "ready",
          summary: "Fixture provider",
          assumptions: [],
          warnings: [],
          operations: [
            { type: "addAnimation", animation: base },
            { type: "setExpression", expression: e },
          ],
        };
      },
      async () => {},
      (state, attempt) =>
        motionQA(
          f.project,
          state,
          "motion/qa/repair-" + attempt,
          "QA",
          f.state,
        ),
    );
    assert.equal(generated.attempts, 2);
    assert.equal(JSON.stringify(f.state), snapshot);
    calls = 0;
    await assert.rejects(
      runAutonomous(f.project, f.state, {}, "Trim Paths", async () => {
        calls++;
        return {
          status: "ready",
          summary: "invalid fixture",
          assumptions: [],
          warnings: [],
          operations: [{ type: "addAnimation", animation: base }],
        };
      }),
      /3 попыток/,
    );
    assert.equal(calls, 3);
    assert.equal(JSON.stringify(f.state), snapshot);
  } finally {
    await f.cleanup();
  }
});

test("outlined single centerline and gradient stroke use a following mask without replacing source paint", async () => {
  const f = await identityFixture(1, (scenes) => {
    const line = node("line", "Линия", 0, 0, 140, 80);
    line.type = "VECTOR";
    line.properties = {
      ...line.properties,
      fills: [],
      strokeAlign: "CENTER",
      strokeWeight: 4,
      strokes: [
        {
          type: "GRADIENT_LINEAR",
          gradientTransform: [
            [1, 0, 0],
            [0, 1, 0],
          ],
          gradientStops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
          ],
        },
      ],
      vectorPaths: [{ data: "M10 40 L130 40", windingRule: "NONZERO" }],
      strokeGeometry: [
        { data: "M10 38 L130 38 L130 42 L10 42 Z", windingRule: "NONZERO" },
      ],
    };
    scenes[0].children = [line];
  });
  try {
    f.state.settings = { ...f.state.settings, fps: 30, durationFrames: 90 };
    f.state.blocks[0].durationFrames = 90;
    const state = applyOperations(
      f.state,
      [{ type: "addAnimation", animation: trim }],
      f.project,
    );
    const report = await motionQA(
      f.project,
      state,
      "motion/qa/outlined-gradient",
      "Trim Paths",
      f.state,
    );
    assert.notEqual(report.status, "FAILED", JSON.stringify(report.checks));
    assert.ok(
      report.checks.some(
        (c) => c.name === "immutableGeometry" && c.status === "PASSED",
      ),
    );
  } finally {
    await f.cleanup();
  }
});
