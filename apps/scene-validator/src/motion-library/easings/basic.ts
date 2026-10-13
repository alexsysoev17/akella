import { settle } from "./physical.js";
export type Evaluator = (t: number) => number;
const polynomial = (power: number) => ({
  in: (t: number) => t ** power,
  out: (t: number) => 1 - (1 - t) ** power,
  inOut: (t: number) =>
    t < 0.5 ? (2 * t) ** power / 2 : 1 - (-2 * t + 2) ** power / 2,
});
const bounceOut = (t: number) => {
  const n = 7.5625,
    d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};
const outBack = (t: number) =>
  1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
const outElastic = (t: number) =>
  settle(t, 2 ** (-10 * t) * Math.sin(((t * 10 - 0.75) * 2 * Math.PI) / 3) + 1);
const families = {
  Quad: polynomial(2),
  Cubic: polynomial(3),
  Quart: polynomial(4),
  Quint: polynomial(5),
  Sine: {
    in: (t: number) => 1 - Math.cos((t * Math.PI) / 2),
    out: (t: number) => Math.sin((t * Math.PI) / 2),
    inOut: (t: number) => (1 - Math.cos(Math.PI * t)) / 2,
  },
  Expo: {
    in: (t: number) => (2 ** (10 * t) - 1) / 1023,
    out: (t: number) => 1 - (2 ** (10 * (1 - t)) - 1) / 1023,
    inOut: (t: number) =>
      t < 0.5
        ? (2 ** (20 * t) - 1) / 2046
        : 1 - (2 ** (20 * (1 - t)) - 1) / 2046,
  },
  Circ: {
    in: (t: number) => 1 - Math.sqrt(1 - t * t),
    out: (t: number) => Math.sqrt(1 - (t - 1) ** 2),
    inOut: (t: number) =>
      t < 0.5
        ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2
        : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2,
  },
  Back: {
    out: outBack,
    in: (t: number) => 1 - outBack(1 - t),
    inOut: (t: number) =>
      t < 0.5 ? (1 - outBack(1 - 2 * t)) / 2 : (1 + outBack(2 * t - 1)) / 2,
  },
  Elastic: {
    out: outElastic,
    in: (t: number) => 1 - outElastic(1 - t),
    inOut: (t: number) =>
      t < 0.5
        ? (1 - outElastic(1 - 2 * t)) / 2
        : (1 + outElastic(2 * t - 1)) / 2,
  },
  Bounce: {
    out: bounceOut,
    in: (t: number) => 1 - bounceOut(1 - t),
    inOut: (t: number) =>
      t < 0.5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (1 + bounceOut(2 * t - 1)) / 2,
  },
};
export const standardEvaluators: Record<string, Evaluator> = {
  linear: (t) => t,
  overshoot: outBack,
  // Preserve historical node animation results; finite spring below is recommended for new work.
  springSoft: (t) => 1 - Math.exp(-7 * t) * Math.cos(10 * t),
  springStateLegacy: (t) =>
    1 - (1 - t) ** 2 * Math.exp(-4 * t) * Math.cos(10 * t),
};
for (const [family, variants] of Object.entries(families))
  for (const [direction, fn] of Object.entries(variants))
    standardEvaluators[
      `ease${direction[0].toUpperCase() + direction.slice(1)}${family}`
    ] = fn;
