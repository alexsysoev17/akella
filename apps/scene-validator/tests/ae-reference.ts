import { evaluateAnimation } from "../src/motion/engine.js";
import { expressionValue } from "../src/motion/expressions.js";
import {
  inertialOvershoot,
  velocityAtTime,
} from "../src/motion-library/expressions/functions.js";
import type { Animation } from "../src/motion/schema.js";
import type { Expression } from "../src/motion-library/expressions/registry.js";
export const aeReference = [
  967.4, 966.2, 965.7, 966.1, 966.9, 968, 969, 970, 970.6, 970.9, 971, 970.7,
  970.4, 970, 969.6, 969.3, 969.1, 969.1, 969.1, 969.2, 969.4, 969.5, 969.6,
  969.7, 969.8, 969.8, 969.7, 969.7, 969.6,
];
export const base: Extract<Animation, { effect: "keyframes" }> = {
  animationId: "position-y",
  sceneId: "s0",
  targetId: "text",
  effect: "keyframes",
  parameters: {
    property: "y",
    points: [
      { frame: 0, value: 1610.6 },
      { frame: 15, value: 969.6 },
    ],
  },
  easing: "aeEasyEase",
  startFrame: 0,
  durationFrames: 15,
  enabled: true,
};
export const inertia: Extract<Expression, { type: "inertialOvershoot" }> = {
  expressionId: "ae-inertia",
  sceneId: "s0",
  targetId: "text",
  property: "y",
  type: "inertialOvershoot",
  sourceAnimationId: base.animationId,
  startFrame: 15,
  durationFrames: 30,
  enabled: true,
  parameters: {
    mode: "ae",
    amplitude: 0.1,
    frequency: 2,
    decay: 4,
    velocityLookbackFrames: 6,
  },
};
export function compareReference() {
  const sample = 0.5 - 1 / 300;
  const velocity = velocityAtTime(
    (s) => evaluateAnimation(base, s * 30).y!,
    sample,
    1 / 30000,
    { start: 0, end: 0.5 },
  );
  const rows = aeReference.map((expected, i) => {
    const frame = i + 16,
      formula = 969.6 + inertialOvershoot((frame - 15) / 30, -60.5, 0.1, 2, 4),
      endToEnd =
        evaluateAnimation(base, frame).y! +
        expressionValue(inertia, frame, 30, [base], evaluateAnimation);
    return {
      frame,
      expected,
      formula,
      endToEnd,
      formulaError: Math.abs(formula - expected),
      endToEndError: Math.abs(endToEnd - expected),
    };
  });
  return {
    sampleTime: sample,
    computedVelocity: velocity,
    rows,
    formulaMaxError: Math.max(...rows.map((r) => r.formulaError)),
    endToEndMaxError: Math.max(...rows.map((r) => r.endToEndError)),
    endToEndTolerancePassed: rows.every((r) => r.endToEndError <= 0.15),
  };
}
