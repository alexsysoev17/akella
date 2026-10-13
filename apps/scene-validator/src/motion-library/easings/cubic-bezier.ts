/** Time is X, not the Bezier parameter. Bracketed Newton plus bisection handles flat tangents. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  if (
    ![x1, y1, x2, y2].every(Number.isFinite) ||
    x1 < 0 ||
    x1 > 1 ||
    x2 < 0 ||
    x2 > 1
  )
    throw new Error("Invalid cubic Bezier control points");
  const coordinate = (u: number, a: number, b: number) =>
    3 * (1 - u) ** 2 * u * a + 3 * (1 - u) * u * u * b + u ** 3;
  const derivative = (u: number, a: number, b: number) =>
    3 * (1 - u) ** 2 * a + 6 * (1 - u) * u * (b - a) + 3 * u * u * (1 - b);
  return (t: number) => {
    if (!Number.isFinite(t)) throw new Error("Non-finite easing time");
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0,
      hi = 1,
      u = t;
    for (let i = 0; i < 32; i++) {
      const x = coordinate(u, x1, x2),
        error = x - t;
      if (Math.abs(error) < 1e-10) break;
      if (error < 0) lo = u;
      else hi = u;
      const d = derivative(u, x1, x2),
        next = u - error / d;
      u =
        i < 8 && Math.abs(d) > 1e-8 && next > lo && next < hi
          ? next
          : (lo + hi) / 2;
    }
    return coordinate(u, y1, y2);
  };
}
