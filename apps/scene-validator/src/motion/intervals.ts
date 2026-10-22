import { intervalEnd } from "./time.js";
export type MotionLifecycle = "finite" | "continuous" | "settling" | "transition";
/** Validate mathematical intervals. A visible output window is not an animation boundary.
 * Retained signature for existing callers; clipping is decided by QA/Preview/export. */
export function intervalConflict(interval: {startFrame:number;durationFrames:number}, projectDuration:number, lifecycle:MotionLifecycle): {code:string;lifecycle:MotionLifecycle;endFrame:number;needsEndpoint:boolean;requiredDurationFrames:number;actualDurationFrames:number}|undefined {
  intervalEnd(interval);
  return undefined;
}
