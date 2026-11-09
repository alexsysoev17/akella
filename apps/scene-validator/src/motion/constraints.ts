import type { MotionState } from "./schema.js";
export type ConstraintKind = "VALID" | "RECOVERABLE" | "UNSUPPORTED" | "INVALID" | "AMBIGUOUS";
export class TimelineConstraintError extends Error {
  readonly code = "DEPENDENT_EFFECT_EXCEEDS_TIMELINE";
  constructor(readonly requiredDurationFrames: number, readonly actualDurationFrames: number, readonly affectedIds: string[], message?: string) {
    super(message ?? `DEPENDENT_EFFECT_EXCEEDS_TIMELINE: need ${requiredDurationFrames} frames, have ${actualDurationFrames}`);
  }
}
export function requiredProjectFrames(state: MotionState) {
  return Math.max(state.settings.durationFrames,
    ...state.animations.map(a => a.startFrame + a.durationFrames),
    ...(state.objectTransitions ?? []).map(t => t.startFrame + t.durationFrames + 1),
    ...(state.expressions ?? []).map(e => e.startFrame + e.durationFrames + (["wiggle", "loop"].includes(e.type) ? 0 : 1)));
}
