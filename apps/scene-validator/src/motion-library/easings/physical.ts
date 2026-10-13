export function smoothstep(t: number) {
  t = Math.max(0, Math.min(1, t));
  return t * t * t * (t * (6 * t - 15) + 10);
}
/** C2 settling window in the final quarter: finite endpoint without a last-frame snap. */
export const settle = (t: number, raw: number) =>
  raw + (1 - raw) * smoothstep((t - 0.75) / 0.25);
export function spring(
  t: number,
  p: { stiffness: number; damping: number; mass: number },
) {
  const w = Math.sqrt(p.stiffness / p.mass),
    z = p.damping / (2 * Math.sqrt(p.stiffness * p.mass));
  let displacement: number;
  if (Math.abs(z - 1) < 1e-5) displacement = Math.exp(-w * t) * (1 + w * t);
  else if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z);
    displacement =
      Math.exp(-z * w * t) *
      (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
  } else {
    const q = Math.sqrt(z * z - 1),
      r1 = -w / (z + q),
      r2 = -w * (z + q);
    displacement = (-r2 * Math.exp(r1 * t) + r1 * Math.exp(r2 * t)) / (r1 - r2);
  }
  return settle(t, 1 - displacement);
}
export function elastic(
  t: number,
  p: { amplitude: number; frequency: number; decay: number },
) {
  const phase = 2 * Math.PI * p.frequency * t;
  return settle(
    t,
    1 -
      Math.exp(-p.decay * t) *
        (Math.cos(phase) + p.amplitude * Math.sin(phase)),
  );
}
export function back(t: number, overshoot: number) {
  return 1 + (overshoot + 1) * (t - 1) ** 3 + overshoot * (t - 1) ** 2;
}
export function bounce(
  t: number,
  p: { restitution: number; bounceCount: number },
) {
  if (t < 0.4) return (t / 0.4) ** 2;
  const u = ((t - 0.4) / 0.6) * p.bounceCount,
    i = Math.min(p.bounceCount - 1, Math.floor(u)),
    f = u - i;
  return 1 - p.restitution ** (i + 1) * 4 * f * (1 - f);
}
