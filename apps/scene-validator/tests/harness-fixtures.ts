import { identityFixture, node } from "./identity-fixture.js";
import { intentFixture } from "./intent-fixture.js";
import type { AgentEval } from "../src/harness/evals.js";
import { readMotion, changeMotion } from "../src/motion/store.js";
export async function evalFixture(c: AgentEval) {
  if (c.fixture === "composite") return intentFixture();
  if (c.fixture === "six-inertia") {
    const f = await identityFixture(2, (scenes) => {
      scenes[0].children = Array.from({ length: 6 }, (_, i) =>
        node("n" + i, "Object " + i, 10 + i * 25, 40, 20, 20),
      );
    });
    const initial = await readMotion(f.project);
    const animations = Array.from({ length: 6 }, (_, i) => ({
      animationId: "base" + i,
      sceneId: "s0",
      targetId: "n" + i,
      effect: "slideUp" as const,
      startFrame: 0,
      durationFrames: 15,
      easing: "linear" as const,
      enabled: true,
      parameters: { distance: 40, mode: "in" as const },
    }));
    const expressions = animations.map((a, i) => ({
      expressionId: "e" + i,
      sceneId: a.sceneId,
      targetId: a.targetId,
      type: "inertialOvershoot" as const,
      property: "y" as const,
      sourceAnimationId: a.animationId,
      startFrame: 15,
      durationFrames: 36,
      enabled: true,
      parameters: {
        mode: "ae",
        amplitude: 0.25 + i * 0.02,
        frequency: 2.5,
        decay: 3,
        velocityLookbackFrames: 3,
      },
    }));
    const first = (
      await changeMotion(f.project.root, {
        expectedRevision: initial.revision,
        request: "seed unrelated group",
        operations: [
          ...animations.map((animation) => ({
            type: "addAnimation" as const,
            animation,
          })),
          ...expressions.slice(4).map((expression) => ({
            type: "setExpression" as const,
            expression,
          })),
        ],
      })
    ).document;
    await changeMotion(f.project.root, {
      expectedRevision: first.revision,
      request: "recent successfully applied inertia group",
      operations: expressions
        .slice(0, 4)
        .map((expression) => ({ type: "setExpression" as const, expression })),
    });
    return f;
  }
  if (c.fixture === "eight-object") {
    return identityFixture(3, (scenes) => {
      scenes[0].children = [node("background", "Background")];
      scenes[1].children = [
        node("plate", "тарелка", 10, 60, 30, 30),
        node("qr", "куар", 50, 60, 30, 30),
        node("logo1", "лого 1", 100, 60, 25, 25),
        node("logo2", "лого 2", 140, 60, 25, 25),
        node("text1", "текст 1", 20, 10, 100, 15),
      ];
      scenes[2].children = [
        node("text2", "текст 2", 20, 10, 100, 15),
        ...["лента 1", "лента 2"].map((name, i) => {
          const n = node("ribbon" + (i + 1), name, 10, 50 + i * 40, 170, 20);
          n.type = "VECTOR";
          n.properties = {
            ...n.properties,
            fills: [],
            strokeWeight: 2,
            strokeAlign: "CENTER",
            strokes: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
            vectorPaths: [
              { data: "M0 0 C50 30 110 -20 170 0", windingRule: "NONZERO" },
            ],
          };
          return n;
        }),
      ];
    });
  }
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
    if (c.fixture === "two-paths") {
      const second = structuredClone(line);
      second.figmaNodeId = "line2";
      second.name = "Vector Line 2";
      second.sceneTransform = [
        [1, 0, 10],
        [0, 1, 70],
      ];
      scenes[0].children.push(second);
    }
    if (c.fixture === "ambiguous")
      scenes[0].children.push(node("qrTwin", "QR", 70, 40, 30, 30));
    scenes[1].children = [
      node("qrNext", "QR", 120, 50, 50, 50),
      node("phoneNext", "Phone", 10, 20, 30, 70),
    ];
  });
  if (["trim-sequence", "trim-detached", "trim-only-second"].includes(c.seed)) {
    await changeMotion(f.project.root, {
      expectedRevision: "initial",
      request: "synthetic Trim Paths lifecycle seed",
      operations: [
        ...(c.seed === "trim-only-second" ? ["line2"] : ["line", "line2"]).map(
          (targetId, i) => ({
            type: "addAnimation" as const,
            animation: {
              animationId: "seed_trim_" + targetId,
              targetId,
              sceneId: "s0",
              effect: "trimPath" as const,
              startFrame:
                targetId === "line2" && c.seed !== "trim-sequence"
                  ? 35
                  : i * 21,
              durationFrames: 21,
              easing: "linear" as const,
              enabled: true,
              parameters: { from: 0, to: 1, direction: "forward" as const },
            },
          }),
        ),
        ...(c.seed !== "trim-sequence"
          ? []
          : [
              {
                type: "setTimingDependency" as const,
                dependency: {
                  dependencyId: "seed_ribbon_sequence",
                  animationId: "seed_trim_line2",
                  anchorAnimationId: "seed_trim_line",
                  relation: "after" as const,
                  offsetFrames: 0,
                },
              },
            ]),
      ],
    });
    return f;
  }
  if (c.seed === "fade-after-slide") {
    await changeMotion(f.project.root, {
      expectedRevision: "initial",
      request: "synthetic cross-effect timing seed",
      operations: [
        {
          type: "addAnimation",
          animation: {
            animationId: "A",
            sceneId: "s0",
            targetId: "qr",
            effect: "slideUp",
            startFrame: 0,
            durationFrames: 15,
            easing: "linear",
            enabled: true,
            parameters: { distance: 40, mode: "in" },
          },
        },
        {
          type: "addAnimation",
          animation: {
            animationId: "B",
            sceneId: "s0",
            targetId: "phone",
            effect: "fadeIn",
            startFrame: 35,
            durationFrames: 15,
            easing: "linear",
            enabled: true,
            parameters: { from: 0, to: 1 },
          },
        },
      ],
    });
    return f;
  }
  if (c.seed === "fade") {
    await changeMotion(f.project.root, {
      expectedRevision: "initial",
      request: "synthetic Fade lifecycle seed",
      operations: [
        {
          type: "addAnimation",
          animation: {
            animationId: "seed_fade",
            targetId: "qr",
            sceneId: "s0",
            effect: "fadeIn",
            startFrame: 0,
            durationFrames: 21,
            easing: "linear",
            enabled: true,
            parameters: { from: 0, to: 1 },
          },
        },
      ],
    });
    return f;
  }
  if (c.seed !== "none") {
    const base = {
      animationId: "seed_position",
      sceneId: "s0",
      targetId: "qr",
      effect: "slideUp" as const,
      startFrame: 0,
      durationFrames: 20,
      easing:
        c.seed === "linear-slide" || c.seed === "inertia"
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
                    mode: "ae",
                    amplitude: 0.25,
                    frequency: 2.5,
                    decay: 3,
                    velocityLookbackFrames: 3,
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
