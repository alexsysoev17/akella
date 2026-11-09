import {transformPoint} from './anchor.js';
import type { MotionState } from "./schema.js";
import type { Expression } from "../motion-library/expressions/registry.js";
import { inertialOvershoot, velocityAtTime, averageVelocity, windowOffset } from "../motion-library/expressions/functions.js";
import { interpolateState, transitionProgress, type StatePresentation } from "./transition-runtime.js";
import { expressionValue } from "./expressions.js";
import { evaluateAnimation } from "./evaluation.js";
import {decompose} from './geometry.js';

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
  if (!["x","y","rotation","scaleX","scaleY","opacity"].includes(e.property)) throw new Error("UNSUPPORTED_TRANSITION_EFFECT_PROPERTY");
  const row = e.property === "x" ? 0 : 1;
  const sample = (seconds:number) => {const base={...t,proceduralEffects:[]},pose=interpolateState(a,b,base,seconds*fps,state);if(e.property==='opacity')return pose.opacity;if(e.property==='rotation'){const delta=decompose(b.normalized).rotation-decompose(a.normalized).rotation;return Math.atan2(Math.sin(delta),Math.cos(delta))*transitionProgress(base,seconds*fps)*180/Math.PI;}if(e.property==='scaleX'||e.property==='scaleY')return decompose(pose.matrix)[e.property]/decompose(b.normalized)[e.property];return pose.anchor?transformPoint(pose.matrix,pose.anchor)[e.property==='x'?'x':'y']:pose.matrix[row][2];};
  // Explicit momentum-window semantics, not a fabricated endpoint impulse.
  // Absence preserves serialized endpoint-velocity behavior exactly.
  const velocity = e.parameters.velocitySampling==='lookback'
    ? averageVelocity(sample,end/fps,Math.min(t.durationFrames,e.parameters.velocityLookbackFrames)/fps)
    : velocityAtTime(sample,
    end / fps - 1 / (fps * 10), 1 / (fps * 1000),
    { start: t.startFrame / fps, end: end / fps },
  );
  return inertialOvershoot(time, velocity, e.parameters.amplitude, e.parameters.frequency, e.parameters.decay) * (e.parameters.settlingEnvelope === "smoothTail" ? windowOffset(time, e.durationFrames / fps, false) : 1);
}
