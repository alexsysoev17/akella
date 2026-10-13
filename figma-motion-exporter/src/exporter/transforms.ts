import type { Matrix } from "../types/scene";
export const identity = (): Matrix => [
  [1, 0, 0],
  [0, 1, 0],
];
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    [
      a[0][0] * b[0][0] + a[0][1] * b[1][0],
      a[0][0] * b[0][1] + a[0][1] * b[1][1],
      a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2],
    ],
    [
      a[1][0] * b[0][0] + a[1][1] * b[1][0],
      a[1][0] * b[0][1] + a[1][1] * b[1][1],
      a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2],
    ],
  ];
}
export function inverse(m: Matrix): Matrix {
  const [[a, c, x], [b, d, y]] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12)
    throw new Error("Singular scene transform");
  return [
    [d / det, -c / det, (c * y - d * x) / det],
    [-b / det, a / det, (b * x - a * y) / det],
  ];
}
export const relativeToScene = (scene: Matrix, node: Matrix): Matrix =>
  multiply(inverse(scene), node);
