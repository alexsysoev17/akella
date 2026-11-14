import type { CanvasKit, Path, ContourMeasure } from "canvaskit-wasm";
import { NativeRenderError, number, list } from "./skia.js";
export interface ShapeNode {
  figmaNodeId: string;
  type: string;
  properties: Record<string, unknown>;
}
export function shapeData(n: ShapeNode): { data: string; evenOdd: boolean }[] {
  const p = n.properties,
    w = number(p.width),
    h = number(p.height);
  const paths = list(p.vectorPaths).length
    ? list(p.vectorPaths)
    : list(p.fillGeometry);
  if (paths.length)
    return paths.map((v) => ({
      data: String(v.data ?? ""),
      evenOdd: v.windingRule === "EVENODD",
    }));
  if (n.type === "LINE") return [{ data: `M0 0 L${w} ${h}`, evenOdd: false }];
  if (n.type === "ELLIPSE")
    return [
      {
        data: `M${w / 2} 0 A${w / 2} ${h / 2} 0 1 1 ${w / 2} ${h} A${w / 2} ${h / 2} 0 1 1 ${w / 2} 0 Z`,
        evenOdd: false,
      },
    ];
  if (["VECTOR", "POLYGON", "STAR", "BOOLEAN_OPERATION"].includes(n.type))
    throw new NativeRenderError(
      "SOURCE_GEOMETRY_MISSING",
      "No paths or native SVG asset",
      n.figmaNodeId,
    );
  const r = Math.min(w / 2, h / 2, number(p.cornerRadius)),
    [tl, tr, br, bl] = [
      "topLeftRadius",
      "topRightRadius",
      "bottomRightRadius",
      "bottomLeftRadius",
    ].map((k) => Math.min(w / 2, h / 2, number(p[k], r)));
  return [
    {
      data: `M${tl} 0 H${w - tr} A${tr} ${tr} 0 0 1 ${w} ${tr} V${h - br} A${br} ${br} 0 0 1 ${w - br} ${h} H${bl} A${bl} ${bl} 0 0 1 0 ${h - bl} V${tl} A${tl} ${tl} 0 0 1 ${tl} 0 Z`,
      evenOdd: false,
    },
  ];
}
export class PathResources {
  private paths = new Map<string, Path>();
  private measures = new Map<
    Path,
    { contours: ContourMeasure[]; length: number }
  >();
  constructor(private kit: CanvasKit) {}
  get(data: string, evenOdd = false) {
    const key = String(evenOdd) + data;
    let p = this.paths.get(key);
    if (!p) {
      p = this.kit.Path.MakeFromSVGString(data) ?? undefined;
      if (!p)
        throw new NativeRenderError("VECTOR_PATH_INVALID", data.slice(0, 100));
      if (evenOdd) {
        const b = new this.kit.PathBuilder(p);
        b.setFillType(this.kit.FillType.EvenOdd);
        p.delete();
        p = b.detach();
        b.delete();
      }
      this.paths.set(key, p);
    }
    return p;
  }
  measure(path: Path) {
    let m = this.measures.get(path);
    if (!m) {
      const it = new this.kit.ContourMeasureIter(path, false, 4),
        contours: ContourMeasure[] = [];
      let c;
      while ((c = it.next())) contours.push(c);
      it.delete();
      m = { contours, length: contours.reduce((n, c) => n + c.length(), 0) };
      this.measures.set(path, m);
    }
    return m;
  }
  /** Arc-length extraction, not scale, opacity, dash approximation or a rectangular reveal. */
  trim(path: Path, start: number, end: number) {
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end > 1 ||
      start > end
    )
      throw new NativeRenderError("TRIM_INTERVAL_INVALID", `${start}..${end}`);
    const m = this.measure(path),
      builder = new this.kit.PathBuilder();
    let offset = 0;
    for (const c of m.contours) {
      const size = c.length(),
        a = Math.max(0, start * m.length - offset),
        b = Math.min(size, end * m.length - offset);
      if (b > a) {
        const segment = c.getSegment(a, b, true);
        builder.addPath(segment);
        if (a === 0 && b === size && c.isClosed()) builder.close();
        segment.delete();
      }
      offset += size;
    }
    const result = builder.detach();
    builder.delete();
    return result;
  }
  dispose() {
    for (const m of this.measures.values())
      for (const c of m.contours) c.delete();
    for (const p of this.paths.values()) p.delete();
    this.paths.clear();
    this.measures.clear();
  }
  get size() {
    return this.paths.size;
  }
}
