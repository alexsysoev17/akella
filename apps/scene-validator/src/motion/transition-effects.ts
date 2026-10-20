import type { MotionState } from "./schema.js";
import type { Expression } from "../motion-library/expressions/registry.js";
import { inertialOvershoot, velocityAtTime, windowOffset } from "../motion-library/expressions/functions.js";
import { interpolateState, type StatePresentation } from "./transition-runtime.js";
import { expressionValue } from "./expressions.js";
import { evaluateAnimation } from "./evaluation.js";

/** Source geometry is supplied by the renderer/QA, never copied into a procedural effect.
 * Velocity samples the immutable interpolated canvas transform, excluding other modifiers. */
export function scopedExpressionValue(state: MotionState, e: Expression, frame: number, presentation: StatePresentation = {}): number {
  if (e.type !== "inertialOvershoot" || !e.transitionId)
    return expressionValue(e, frame, state.settings.fps, state.animations, evaluateAnimation);
  const t = state.objectTransitions?.find(t => t.transitionId === e.transitionId);
  if (!t) throw new Error("MISSING_TRANSITION_EFFECT_BASE");
  const fps = state.settings.fps, end = t.startFrame + t.durationFrames;
  const time = (frame - end) / fps;
  if (!e.enabled || time <= 0 || time >= e.durationFrames / fps) return 0;
  const states = presentation[t.logicalObjectId], a = states?.[t.fromSceneId], b = states?.[t.toSceneId];
  if (!a || !b) throw new Error("MISSING_TRANSITION_EFFECT_GEOMETRY");
  if (e.property !== "x" && e.property !== "y") throw new Error("UNSUPPORTED_TRANSITION_EFFECT_PROPERTY");
  const row = e.property === "x" ? 0 : 1;
  const velocity = velocityAtTime(
    seconds => interpolateState(a, b, t, seconds * fps).matrix[row][2],
    end / fps - 1 / (fps * 10), 1 / (fps * 1000),
    { start: t.startFrame / fps, end: end / fps },
  );
  return inertialOvershoot(time, velocity, e.parameters.amplitude, e.parameters.frequency, e.parameters.decay) * (e.parameters.settlingEnvelope === "smoothTail" ? windowOffset(time, e.durationFrames / fps, false) : 1);
}
