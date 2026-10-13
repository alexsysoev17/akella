import {
  smoothstep,
  spring as springProgress,
  bounce as bounceProgress,
} from "../easings/physical.js";
export const valueAtTime = (
  sample: (seconds: number) => number,
  time: number,
) => sample(time);
/** Local derivative in property units/second. Bounds keep samples within one keyframe segment. */
export function velocityAtTime(
  sample: (seconds: number) => number,
  time: number,
  step = 1e-5,
  bounds?: { start: number; end: number },
) {
  if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(time))
    throw new Error("Invalid velocity sample");
  const start = bounds?.start ?? -Infinity,
    end = bounds?.end ?? Infinity;
  const h = Math.min(
    step,
    Number.isFinite(end - start) ? (end - start) / 4 : step,
  );
  if (h <= 0) return 0;
  if (time - h < start)
    return (
      (-3 * sample(time) + 4 * sample(time + h) - sample(time + 2 * h)) /
      (2 * h)
    );
  if (time + h > end)
    return (
      (3 * sample(time) - 4 * sample(time - h) + sample(time - 2 * h)) / (2 * h)
    );
  return (sample(time + h) - sample(time - h)) / (2 * h);
}
/** Compatibility mode for saved projects: this is a secant, not instantaneous velocity. */
export function averageVelocity(
  sample: (seconds: number) => number,
  time: number,
  window: number,
) {
  return (sample(time) - sample(time - window)) / window;
}
export type MotionVector =
  | readonly [number, number]
  | readonly [number, number, number];
export function inertialVector(
  time: number,
  velocity: MotionVector,
  amplitude: number,
  frequency: number,
  decay: number,
) {
  return velocity.map((component) =>
    inertialOvershoot(time, component, amplitude, frequency, decay),
  );
}
export function nearestKey(keys: readonly number[], time: number) {
  if (!keys.length) return null;
  return keys.reduce(
    (best, k) => (Math.abs(k - time) < Math.abs(best - time) ? k : best),
    keys[0],
  );
}
function hash(index: number, seed: number) {
  let h = (index ^ seed) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (((h ^ (h >>> 16)) >>> 0) / 0xffffffff) * 2 - 1;
}
export function wiggle(
  time: number,
  amplitude: number,
  frequency: number,
  seed: number,
) {
  const t = time * frequency,
    i = Math.floor(t),
    f = smoothstep(t - i);
  return amplitude * (hash(i, seed) + (hash(i + 1, seed) - hash(i, seed)) * f);
}
export function inertialOvershoot(
  time: number,
  velocity: number,
  amplitude: number,
  frequency: number,
  decay: number,
) {
  return (
    velocity *
    amplitude *
    Math.sin(2 * Math.PI * frequency * time) *
    Math.exp(-decay * time)
  );
}
export const dampedOscillation = (
  time: number,
  amplitude: number,
  frequency: number,
  decay: number,
) =>
  amplitude *
  Math.sin(2 * Math.PI * frequency * time) *
  Math.exp(-decay * time);
export const spring = (
  t: number,
  amplitude: number,
  parameters: { stiffness: number; damping: number; mass: number },
) => amplitude * (springProgress(t, parameters) - smoothstep(t));
export const bounce = (
  t: number,
  amplitude: number,
  parameters: { restitution: number; bounceCount: number },
) => amplitude * (bounceProgress(t, parameters) - smoothstep(t));
export function loop(time: number, period: number, mode: "cycle" | "pingPong") {
  if (period <= 0 || !Number.isFinite(period))
    throw new Error("Invalid loop period");
  const cycle = (((time / period) % 2) + 2) % 2;
  return mode === "pingPong"
    ? (cycle <= 1 ? cycle : 2 - cycle) * period
    : ((time % period) + period) % period;
}
/** All finite expressions return to zero smoothly. No dependency on playback history. */
export function windowOffset(time: number, duration: number, fadeIn: boolean) {
  if (time <= 0 || time >= duration) return 0;
  const out = 1 - smoothstep((time / duration - 0.75) / 0.25);
  return out * (fadeIn ? smoothstep(time / Math.min(0.1, duration * 0.15)) : 1);
}
