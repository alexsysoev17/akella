export interface CurvePoint {
  t: number;
  value: number;
  slope?: number | null;
}
/** One tangent per knot means Hermite segments share the same velocity (C1). */
export function piecewise(
  t: number,
  points: CurvePoint[],
  interpolation: "linear" | "hermite",
) {
  if (t <= 0) return points[0].value;
  if (t >= 1) return points.at(-1)!.value;
  let i = 1;
  while (i < points.length - 1 && t > points[i].t) i++;
  const a = points[i - 1],
    b = points[i],
    h = b.t - a.t,
    u = (t - a.t) / h;
  if (interpolation === "linear") return a.value + (b.value - a.value) * u;
  const slope = (i: number) =>
    points[i].slope ??
    (i === 0 || i === points.length - 1
      ? 0
      : (points[i + 1].value - points[i - 1].value) /
        (points[i + 1].t - points[i - 1].t));
  return (
    (2 * u ** 3 - 3 * u * u + 1) * a.value +
    (u ** 3 - 2 * u * u + u) * h * slope(i - 1) +
    (-2 * u ** 3 + 3 * u * u) * b.value +
    (u ** 3 - u * u) * h * slope(i)
  );
}
