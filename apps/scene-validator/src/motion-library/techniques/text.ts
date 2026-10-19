import type { Animation } from "../../motion/schema.js";
/** Declarative readable-entry policy; explicit positive frame intervals are never replaced. */
export const textMotionDefaults = {
  version: "text-rhythm/1",
  gapSeconds: { paragraph: 0.12, line: 0.08, word: 0.045, character: 0.025, block: 0 },
  localDistanceEm: 0.85,
  minimumUnitSeconds: 0.35,
};
export function resolveTextSettings(
  text: NonNullable<Animation["text"]>,
  fps: number,
  durationFrames: number,
): NonNullable<Animation["text"]> {
  if (
    text.timing !== "staggered" ||
    text.staggerFrames > 0 ||
    text.segmentation === "block"
  )
    return { ...text };
  return {
    ...text,
    staggerFrames: Math.max(
      1,
      Math.min(
        Math.round(fps * textMotionDefaults.gapSeconds[text.segmentation]),
        Math.floor(durationFrames * 0.12),
      ),
    ),
  };
}
