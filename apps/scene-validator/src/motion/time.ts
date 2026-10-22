import { z } from "zod";
/** Mathematical frame coordinates are signed safe integers. Output budgets are separate. */
export const globalFrameSchema = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
export const intervalDurationSchema = globalFrameSchema.min(1);
export const nonnegativeFrameSchema = globalFrameSchema.min(0);
// Skia matrices are float32. This is a representation limit, never a viewport clamp.
export const MAX_FLOAT32 = (2 - 2 ** -23) * 2 ** 127;
export const coordinateSchema = z.number().finite().min(-MAX_FLOAT32).max(MAX_FLOAT32);
export function safeFrame(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error("INVALID_GLOBAL_FRAME: expected signed safe integer");
  return value;
}
export function intervalEnd(interval: {startFrame: number; durationFrames: number}) {
  safeFrame(interval.startFrame);
  if (safeFrame(interval.durationFrames) < 1) throw new Error("INVALID_GLOBAL_INTERVAL: duration must be positive");
  return safeFrame(interval.startFrame + interval.durationFrames);
}
export function dependencyStart(target: {durationFrames:number}, anchor: {startFrame:number;durationFrames:number}, relation: "after"|"with"|"before"|"endWith", offset: number) {
  intervalEnd(anchor); safeFrame(offset);
  return safeFrame(anchor.startFrame + (relation === "after" ? anchor.durationFrames : relation === "endWith" ? anchor.durationFrames-target.durationFrames : relation === "before" ? -target.durationFrames : 0) + offset);
}
