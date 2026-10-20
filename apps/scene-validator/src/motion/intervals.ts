/** Canonical temporal bounds, shared by tools and state validators.
 * A renderable endpoint is required for settling/state-transition completion;
 * a continuous effect may occupy the last visible frame without settling. */
export type MotionLifecycle = "finite" | "continuous" | "settling" | "transition";
export function intervalConflict(interval: { startFrame: number; durationFrames: number }, projectDuration: number, lifecycle: MotionLifecycle) {
  const endFrame = interval.startFrame + interval.durationFrames;
  const needsEndpoint = lifecycle === "settling" || lifecycle === "transition";
  const requiredDurationFrames = endFrame + (needsEndpoint ? 1 : 0);
  if (requiredDurationFrames <= projectDuration) return undefined;
  return { code: "TIMELINE_CONFLICT", lifecycle, endFrame, needsEndpoint, requiredDurationFrames, actualDurationFrames: projectDuration };
}
