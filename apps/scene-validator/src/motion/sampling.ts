import type { Animation } from "./schema.js";
import type { Values } from "./engine.js";
import { velocityAtTime as derivative } from "../motion-library/expressions/functions.js";
export type BaseEvaluator = (animation: Animation, frame: number) => Values;
/** Common base sampling. It never composes expressions or rounds to a rendered frame. */
export function valueAtTime(
  animation: Animation,
  seconds: number,
  fps: number,
  evaluate: BaseEvaluator,
): Values {
  if (!Number.isFinite(seconds) || !Number.isFinite(fps) || fps <= 0)
    throw new Error("Invalid base sampling time/FPS");
  return evaluate(animation, seconds * fps);
}
export function velocityAtTime(
  animation: Animation,
  seconds: number,
  fps: number,
  evaluate: BaseEvaluator,
): Values {
  const frames =
    animation.effect === "keyframes"
      ? animation.parameters.points.map((p) => animation.startFrame + p.frame)
      : [animation.startFrame, animation.startFrame + animation.durationFrames];
  const time = seconds * fps;
  const values = valueAtTime(animation, seconds, fps, evaluate);
  const result: Values = {};
  const end = frames.findIndex((frame) => frame >= time);
  if (end <= 0) {
    for (const property of Object.keys(values) as (keyof Values)[])
      result[property] = 0;
    return result;
  }
  const bounds = { start: frames[end - 1] / fps, end: frames[end] / fps };
  for (const property of Object.keys(values) as (keyof Values)[])
    result[property] = derivative(
      (s) => valueAtTime(animation, s, fps, evaluate)[property] ?? 0,
      seconds,
      Math.min(1 / (fps * 1000), (bounds.end - bounds.start) / 1000),
      bounds,
    );
  return result;
}
