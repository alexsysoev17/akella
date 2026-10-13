import {
  identityFixture,
  node,
} from "../apps/scene-validator/tests/identity-fixture.ts";
import { intentFixture } from "../apps/scene-validator/tests/intent-fixture.ts";
import type { AgentEval } from "../apps/scene-validator/src/harness/evals.ts";
import { changeMotion } from "../apps/scene-validator/src/motion/store.ts";
export async function evalFixture(c: AgentEval) {
  if (c.fixture === "composite") return intentFixture();
  const f = await identityFixture(2, (scenes) => {
    scenes[0].children = [
      node("qr", "QR", 20, 30, 30, 30),
      node("phone", "Phone", 120, 20, 30, 70),
      node("text", "Text", 20, 10, 50, 10),
    ];
    const line = node("line", "Vector Line", 10, 110, 170, 20);
    line.type = "VECTOR";
    line.properties = {
      ...line.properties,
      fills: [],
      strokeWeight: 2,
      strokeAlign: "CENTER",
      strokes: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
      vectorPaths: [
        { data: "M0 0 C50 30 110 -20 170 0", windingRule: "NONZERO" },
      ],
    };
    scenes[0].children.push(line);
    scenes[1].children = [
      node("qrNext", "QR", 120, 50, 50, 50),
      node("phoneNext", "Phone", 10, 20, 30, 70),
    ];
  });
  if (c.seed !== "none") {
    const base = {
      animationId: "seed_position",
      sceneId: "s0",
      targetId: "qr",
      effect: "slideUp" as const,
      startFrame: 0,
      durationFrames: 20,
      easing:
        c.seed === "linear-slide"
          ? ("linear" as const)
          : ("easeOutCubic" as const),
      enabled: true,
      parameters: { distance: 60, mode: "in" as const },
    };
    await changeMotion(f.project.root, {
      expectedRevision: "initial",
      request: "synthetic eval seed, not AI-generated",
      operations: [
        { type: "addAnimation", animation: base },
        {
          type: "addAnimation",
          animation: {
            ...base,
            animationId: "seed_phone",
            targetId: "phone",
            effect: "slideLeft",
            parameters: { distance: 20, mode: "in" },
          },
        },
        ...(c.seed === "inertia"
          ? [
              {
                type: "setExpression" as const,
                expression: {
                  expressionId: "seed_inertia",
                  sceneId: "s0",
                  targetId: "qr",
                  property: "y" as const,
                  type: "inertialOvershoot" as const,
                  sourceAnimationId: base.animationId,
                  startFrame: 20,
                  durationFrames: 30,
                  enabled: true,
                  parameters: {
                    amplitude: 0.25,
                    frequency: 2.5,
                    decay: 3,
                    velocityLookbackFrames: 20,
                  },
                },
              },
            ]
          : []),
      ],
    });
  }
  return f;
}
