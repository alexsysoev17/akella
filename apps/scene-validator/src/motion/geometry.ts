/** Affine matrices act on column vectors. Geometry origin is the Figma local (0,0). */
export type Matrix = [[number, number, number], [number, number, number]];
export const unit: Matrix = [
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
  const [[a, c, x], [b, d, y]] = m,
    det = a * d - b * c;
  if (Math.abs(det) < 1e-12) throw new Error("Вырожденная матрица состояния");
  return [
    [d / det, -c / det, (c * y - d * x) / det],
    [-b / det, a / det, (b * x - a * y) / det],
  ];
}
export function matrix(v: unknown): Matrix {
  if (
    !Array.isArray(v) ||
    v.length !== 2 ||
    v.some(
      (r) =>
        !Array.isArray(r) ||
        r.length !== 3 ||
        r.some((n) => typeof n !== "number" || !Number.isFinite(n)),
    )
  )
    throw new Error("Отсутствует корректный sceneTransform");
  return v as Matrix;
}
export const svgMatrix = (m: Matrix) =>
  `matrix(${m[0][0]} ${m[1][0]} ${m[0][1]} ${m[1][1]} ${m[0][2]} ${m[1][2]})`;
export function decompose(m: Matrix) {
  const [[a, c, x], [b, d, y]] = m,
    sx = Math.hypot(a, b);
  if (sx < 1e-10) throw new Error("Нулевой масштаб состояния");
  return {
    x,
    y,
    scaleX: sx,
    scaleY: (a * d - b * c) / sx,
    rotation: Math.atan2(b, a),
    shear: (a * c + b * d) / sx,
  };
}
export function compose(v: ReturnType<typeof decompose>): Matrix {
  const c = Math.cos(v.rotation),
    s = Math.sin(v.rotation);
  return [
    [c * v.scaleX, c * v.shear - s * v.scaleY, v.x],
    [s * v.scaleX, s * v.shear + c * v.scaleY, v.y],
  ];
}
export function canvasMatrix(
  scene: { width: number; height: number },
  settings: { width: number; height: number },
): Matrix {
  const s = Math.min(
    settings.width / scene.width,
    settings.height / scene.height,
  );
  return [
    [s, 0, (settings.width - scene.width * s) / 2],
    [0, s, (settings.height - scene.height * s) / 2],
  ];
}

/** A scene-space displacement is a vector: inverse translation must not participate. */
export function parentLocalDelta(parent: Matrix, x: number, y: number) {
  const m = inverse(parent);
  return { x: m[0][0] * x + m[0][1] * y, y: m[1][0] * x + m[1][1] * y };
}

/** Canvas translation/rotation; scale uses the explicitly selected basis about the same origin. */
export function transitionOffsetMatrix(base:Matrix,offset:{x?:number;y?:number;rotation?:number;scaleX?:number;scaleY?:number},origin?:{x:number;y:number},scaleBasis:'canvas'|'local'='canvas'):Matrix {
 const angle=(offset.rotation??0)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),sx=Math.max(.001,1+(offset.scaleX??0)),sy=Math.max(.001,1+(offset.scaleY??0));
 const x=origin?.x??base[0][2],y=origin?.y??base[1][2];
 // R(delta) * baseLinear * S(local), retaining the same world-space pivot.
 // Scaling in canvas axes first gives the wrong corner velocity for rotated poses.
 if(scaleBasis==='local'){
  const determinant=base[0][0]*base[1][1]-base[0][1]*base[1][0];
  if(Math.abs(determinant)>1e-12){
   const dx=x-base[0][2],dy=y-base[1][2];
   const ax=(base[1][1]*dx-base[0][1]*dy)/determinant,ay=(-base[1][0]*dx+base[0][0]*dy)/determinant;
   const a=(c*base[0][0]-s*base[1][0])*sx,b=(c*base[0][1]-s*base[1][1])*sy;
   const d=(s*base[0][0]+c*base[1][0])*sx,e=(s*base[0][1]+c*base[1][1])*sy;
   return [[a,b,x+(offset.x??0)-a*ax-b*ay],[d,e,y+(offset.y??0)-d*ax-e*ay]];
  }
 }
 return multiply([[c*sx,-s*sy,x+(offset.x??0)-c*sx*x+s*sy*y],[s*sx,c*sy,y+(offset.y??0)-s*sx*x-c*sy*y]],base);
}

/** Explicit version flag: old canvas-axis effect composition remains unchanged. */
export function poseScaleBasis(easing:unknown):'canvas'|'local'{
 const e=easing as {type?:string;parameters?:{poseScaleBasis?:string}}|undefined;
 return e?.type==='inertiaHandoff'&&e.parameters?.poseScaleBasis==='local'?'local':'canvas';
}
