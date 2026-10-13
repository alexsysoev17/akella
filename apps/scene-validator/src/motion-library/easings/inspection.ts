import { easingSchema, evaluateEasing } from "./registry.js";
export function curveData(input: unknown) {
  const easing = easingSchema.parse(input),
    samples = Array.from({ length: 161 }, (_, i) => ({
      t: i / 160,
      value: evaluateEasing(i / 160, easing),
    }));
  const min = Math.min(0, ...samples.map((p) => p.value)),
    max = Math.max(1, ...samples.map((p) => p.value));
  const y = (v: number) => 112 - ((v - min) / (max - min)) * 100;
  return {
    path: samples
      .map((p, i) => `${i ? "L" : "M"}${12 + p.t * 236},${y(p.value)}`)
      .join(" "),
    startY: y(0),
    endY: y(1),
    min,
    max,
    name: typeof easing === "string" ? easing : easing.type,
  };
}
