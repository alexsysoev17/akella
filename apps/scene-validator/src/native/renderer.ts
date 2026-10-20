import type {
  CanvasKit,
  Canvas,
  Image,
  Paint,
  Path,
  Shader,
  Surface,
} from "canvaskit-wasm";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { createHash } from "node:crypto";
import type { LoadedProject, Scene } from "../types.js";
import type { Animation, MotionState } from "../motion/schema.js";
import { evaluateMotion, type Values } from "../motion/evaluation.js";
import {
  canvasMatrix,
  inverse,
  matrix,
  multiply,
  unit,
  type Matrix,
} from "../motion/geometry.js";
import { statePresentation } from "../motion/transitions.js";
import { interpolateState, presentedTransitions, presentationBlocks } from "../motion/transition-runtime.js";
import { within, noSymlinkPath } from "../files.js";
import { fonts, projectFonts, type FontResources } from "./fonts.js";
import {
  skia,
  makeSurface,
  record,
  list,
  number as num,
  NativeRenderError,
} from "./skia.js";
import { PathResources, shapeData, type ShapeNode } from "./paths.js";
import {
  makeText,
  drawText,
  drawStableText,
  drawTextPlane,
  unitPictures,
  type NativeText,
  type TextUnit,
} from "./text.js";
export interface NativeNode extends ShapeNode {
  name?: string;
  sceneTransform: unknown;
  children: NativeNode[];
  text?: Record<string, unknown>;
  svgAssetId?: string;
  fallbackAssetId?: string;
}
export interface NativeFrame {
  png: Uint8Array;
  encoding: "png" | "rgba";
  frame: number;
  width: number;
  height: number;
  renderer: "skia-cpu/1";
  environment: { engine: string; fontFilesDigest: string };
  warnings: string[];
  fallbacks: { targetId: string; assetId: string; format: "SVG" | "RASTER" }[];
  hits: {
    sceneId: string;
    targetId: string;
    points: { x: number; y: number }[];
  }[];
  stats: {
    milliseconds: number;
    drawMs: number;
    encodeMs: number;
    textLayouts: number;
    paths: number;
    images: number;
  };
  fonts: {
    family: string;
    candidateFiles: { file: string; sha256: string }[];
  }[];
  text: {
    targetId: string;
    sceneId: string;
    lines: TextUnit[];
    units: number;
    offsets: { x: number; y: number; opacity: number }[];
  }[];
  paths: {
    targetId: string;
    length: number;
    start: number;
    end: number;
    contours: number;
  }[];
}
function fallbackId(n: NativeNode) {
  const p = n.properties ?? {},
    vector = ["VECTOR", "POLYGON", "STAR", "BOOLEAN_OPERATION"].includes(
      n.type,
    ),
    supported = [
      "FRAME",
      "GROUP",
      "COMPONENT",
      "INSTANCE",
      "TEXT",
      "RECTANGLE",
      "ELLIPSE",
      "LINE",
      "VECTOR",
      "POLYGON",
      "STAR",
      "BOOLEAN_OPERATION",
    ].includes(n.type);
  return (
    n.fallbackAssetId ??
    (!supported ||
    (vector &&
      (record(p.fills).mixed === true ||
        (!list(p.vectorPaths).length && !list(p.fillGeometry).length)))
      ? n.svgAssetId
      : undefined)
  );
}
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const affine = (m: Matrix) => [
  m[0][0],
  m[0][1],
  m[0][2],
  m[1][0],
  m[1][1],
  m[1][2],
  0,
  0,
  1,
];
function motionMatrix(v: Values, x = 0, y = 0): Matrix {
  const r = ((v.rotation ?? 0) * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r),
    sx = v.scaleX ?? v.scale ?? 1,
    sy = v.scaleY ?? v.scale ?? 1;
  return [
    [c * sx, -s * sy, (v.x ?? 0) + x - c * sx * x + s * sy * y],
    [s * sx, c * sy, (v.y ?? 0) + y - s * sx * x - c * sy * y],
  ];
}
export class NativeRenderer {
  readonly renderer = "skia-cpu/1" as const;
  private paths: PathResources;
  private images = new Map<string, Image>();
  private texts = new Map<string, NativeText>();
  private mipmaps = new Map<Image, Image>();
  private mipmapBytes = 0;
  /** Transform-aware sampling, retaining original decoded pixels and bounded native mipmaps. */
  private drawRaster(
    canvas: Canvas,
    image: Image,
    destination: Float32Array,
    paint: Paint,
    warnings: string[],
    label: string,
  ) {
    const k = this.kit,
      m = canvas.getTotalMatrix(),
      sx = (destination[2] - destination[0]) / image.width(),
      sy = (destination[3] - destination[1]) / image.height(),
      a = m[0] * sx,
      b = m[3] * sx,
      c = m[1] * sy,
      d = m[4] * sy,
      sum = a * a + b * b + c * c + d * d,
      det = a * d - b * c,
      hi = Math.sqrt(
        Math.max(
          0,
          (sum + Math.sqrt(Math.max(0, sum * sum - 4 * det * det))) / 2,
        ),
      ),
      lo = hi > 0 ? Math.abs(det) / hi : 0,
      source = k.XYWHRect(0, 0, image.width(), image.height());
    if (hi > 1.05)
      warnings.push(
        `RASTER_RESOLUTION: ${label}; source ${image.width()}x${image.height()}; maximum output scale ${hi.toFixed(3)}; ${(1 / hi).toFixed(3)} source pixels/output pixel`,
      );
    if (lo < 0.75) {
      let mip = this.mipmaps.get(image);
      if (!mip) {
        const bytes = Math.ceil((image.width() * image.height() * 4 * 4) / 3);
        if (bytes <= 64 * 1024 * 1024) {
          while (
            this.mipmapBytes + bytes > 64 * 1024 * 1024 &&
            this.mipmaps.size
          ) {
            const [key, old] = this.mipmaps.entries().next().value!;
            this.mipmapBytes -= Math.ceil(
              (key.width() * key.height() * 4 * 4) / 3,
            );
            old.delete();
            this.mipmaps.delete(key);
          }
          mip = image.makeCopyWithDefaultMipmaps();
          if (mip) {
            this.mipmaps.set(image, mip);
            this.mipmapBytes += bytes;
          }
        }
      }
      if (mip) {
        canvas.drawImageRectOptions(
          mip,
          source,
          destination,
          k.FilterMode.Linear,
          k.MipmapMode.Linear,
          paint,
        );
        return;
      }
      warnings.push(
        `RASTER_MIPMAP_LIMIT: ${label}; cubic filtering used within64MiB mipmap budget`,
      );
    }
    canvas.drawImageRectCubic(image, source, destination, 1 / 3, 1 / 3, paint);
  }
  private textDensity(canvas: Canvas, warnings: string[], target: string) {
    const m = canvas.getTotalMatrix(),
      sum = m[0] ** 2 + m[1] ** 2 + m[3] ** 2 + m[4] ** 2,
      det = m[0] * m[4] - m[1] * m[3],
      scale = Math.sqrt(
        Math.max(
          0,
          (sum + Math.sqrt(Math.max(0, sum * sum - 4 * det * det))) / 2,
        ),
      );
    if (scale > 4)
      warnings.push(
        `TEXT_RASTER_RESOLUTION: ${target}; transform ${scale.toFixed(3)} exceeds bounded glyph density4`,
      );
    return Math.max(1, Math.min(4, Math.ceil(2 * scale)));
  }
  private assetWarnings: string[] = [];
  private effectPlanes = new Map<
    string,
    { image: Image; pad: number; width: number; height: number }
  >();
  private effectBytes = 0;
  private disposed = false;
  private constructor(
    readonly kit: CanvasKit,
    readonly project: LoadedProject,
    readonly resources: FontResources,
  ) {
    this.paths = new PathResources(kit);
  }
  static async create(project: LoadedProject) {
    const kit = await skia(),
      resources = await fonts(kit, projectFonts(project)),
      renderer = new NativeRenderer(kit, project, resources);
    try {
      for (const scene of project.inspection.document.scenes)
        await renderer.prepare(scene as unknown as NativeNode);
      return renderer;
    } catch (e) {
      renderer.dispose();
      throw e;
    }
  }
  private async prepare(n: NativeNode): Promise<void> {
    if (n.type === "TEXT")
      this.texts.set(n.figmaNodeId, makeText(this.kit, this.resources, n));
    for (const paint of [
      ...list(n.properties?.fills),
      ...list(n.properties?.strokes),
    ])
      if (paint.type === "IMAGE" && typeof paint.assetId === "string")
        await this.image(paint.assetId);
    const fallback = fallbackId(n);
    if (fallback) await this.image(fallback);
    for (const c of n.children ?? []) await this.prepare(c);
  }
  private async image(id: string) {
    if (this.images.has(id)) return this.images.get(id)!;
    const a = this.project.inspection.document.assets.find(
      (a) => a.assetId === id,
    );
    if (
      !a ||
      a.path.startsWith("previews/") ||
      this.project.inspection.document.scenes.some((s) => s.preview === a.path)
    )
      throw new NativeRenderError("ASSET_INVALID", id);
    const file = within(path.dirname(this.project.scenePath), a.path);
    await noSymlinkPath(this.project.root, file);
    if ((await stat(file)).size > 128 * 1024 * 1024)
      throw new NativeRenderError("ASSET_SIZE_LIMIT", id);
    let bytes: Uint8Array = await readFile(file);
    if (/\.svg$/i.test(a.path)) {
      const svg = Buffer.from(bytes).toString("utf8");
      if (
        /<(?:foreignObject|script)[\s>]/i.test(svg) ||
        [
          ...svg.matchAll(/\b(?:href|xlink:href)\s*=\s*["']([^"']*)["']/gi),
        ].some(
          (match) =>
            !/^#|^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(match[1]),
        )
      )
        throw new NativeRenderError("SVG_EXTERNAL_OR_HTML_UNSUPPORTED", id);
      const decoder = new Resvg(Buffer.from(bytes), {
        font: { loadSystemFonts: true },
      });
      if (decoder.width * decoder.height > 33554432)
        throw new NativeRenderError("SVG_SIZE_LIMIT", id);
      bytes = decoder.render().asPng();
      this.assetWarnings.push(
        `SVG asset ${id} decoded by native resvg; animated Trim Paths never use this raster fallback`,
      );
    }
    const image = this.kit.MakeImageFromEncoded(bytes);
    if (!image) throw new NativeRenderError("IMAGE_DECODE_FAILED", id);
    if (image.width() * image.height() > 64e6) {
      image.delete();
      throw new NativeRenderError("IMAGE_TOO_LARGE", id);
    }
    // Decode once into premultiplied pixels BEFORE filtering. The encoded-image
    // decoder can expose Unpremul pixels; interpolating those produces dark fringes.
    const info = {
      width: image.width(),
      height: image.height(),
      colorType: this.kit.ColorType.RGBA_8888,
      alphaType: this.kit.AlphaType.Premul,
      colorSpace: this.kit.ColorSpace.SRGB,
    };
    let normalized: Image | null = null;
    try {
      const pixels = image.readPixels(0, 0, info);
      if (pixels instanceof Uint8Array) normalized = this.kit.MakeImage(info, pixels, info.width * 4);
    } finally {
      image.delete();
    }
    if (!normalized)
      throw new NativeRenderError("IMAGE_PREMULTIPLY_FAILED", id);
    this.images.set(id, normalized);
    return normalized;
  }
  private paint(v: Record<string, unknown>, n: NativeNode, stroke = false) {
    const k = this.kit,
      p = new k.Paint();
    p.setAntiAlias(true);
    const color = record(v.color);
    p.setColor(
      k.Color4f(
        num(color.r),
        num(color.g),
        num(color.b),
        num(color.a, 1) * num(v.opacity, 1),
      ),
    );
    const cleanup: { delete(): void }[] = [];
    try {
      if (String(v.type).startsWith("GRADIENT_")) {
        const stops = list(v.gradientStops),
          colors = stops.map((s) => {
            const c = record(s.color);
            return k.Color4f(num(c.r), num(c.g), num(c.b), num(c.a, 1));
          }),
          positions = stops.map((s) => num(s.position));
        const m = multiply(
          [
            [num(n.properties.width), 0, 0],
            [0, num(n.properties.height), 0],
          ],
          inverse(matrix(v.gradientTransform)),
        );
        let shader: Shader | null = null;
        if (v.type === "GRADIENT_LINEAR")
          shader = k.Shader.MakeLinearGradient(
            [0, 0.5],
            [1, 0.5],
            colors,
            positions,
            k.TileMode.Clamp,
            affine(m),
          );
        else if (v.type === "GRADIENT_RADIAL")
          shader = k.Shader.MakeRadialGradient(
            [0.5, 0.5],
            0.5,
            colors,
            positions,
            k.TileMode.Clamp,
            affine(m),
          );
        else
          throw new NativeRenderError(
            "PAINT_UNSUPPORTED",
            String(v.type),
            n.figmaNodeId,
          );
        if (!shader)
          throw new NativeRenderError(
            "GRADIENT_INVALID",
            "Cannot build gradient",
            n.figmaNodeId,
          );
        p.setShader(shader);
        p.setAlphaf(num(v.opacity, 1));
        cleanup.push(shader);
      } else if (v.type !== "SOLID" && v.type !== "IMAGE")
        throw new NativeRenderError(
          "PAINT_UNSUPPORTED",
          String(v.type),
          n.figmaNodeId,
        );
      if (stroke) {
        p.setStyle(k.PaintStyle.Stroke);
        p.setStrokeWidth(num(n.properties.strokeWeight, 1));
        p.setStrokeCap(
          n.properties.strokeCap === "ROUND"
            ? k.StrokeCap.Round
            : n.properties.strokeCap === "SQUARE"
              ? k.StrokeCap.Square
              : k.StrokeCap.Butt,
        );
        p.setStrokeJoin(
          n.properties.strokeJoin === "ROUND"
            ? k.StrokeJoin.Round
            : n.properties.strokeJoin === "BEVEL"
              ? k.StrokeJoin.Bevel
              : k.StrokeJoin.Miter,
        );
        p.setStrokeMiter(num(n.properties.strokeMiterLimit, 4));
        const dash = n.properties.dashPattern;
        if (Array.isArray(dash) && dash.length) {
          const effect = k.PathEffect.MakeDash(dash as number[], 0);
          if (effect) {
            p.setPathEffect(effect);
            cleanup.push(effect);
          }
        }
      }
      return {
        paint: p,
        dispose() {
          p.delete();
          for (const c of cleanup) c.delete();
        },
      };
    } catch (error) {
      p.delete();
      for (const resource of cleanup) resource.delete();
      throw error;
    }
  }
  private geometry(n: NativeNode, stroke = false) {
    const p = n.properties;
    if (stroke && list(p.strokeGeometry).length)
      return list(p.strokeGeometry).map((v) =>
        this.paths.get(String(v.data), v.windingRule === "EVENODD"),
      );
    return shapeData(n).map((v) => this.paths.get(v.data, v.evenOdd));
  }
  render(
    state: MotionState,
    requestedFrame: number,
    options: {
      scale?: number;
      transparent?: boolean;
      encoding?: "png" | "rgba";
    } = {},
  ): NativeFrame {
    if (this.disposed)
      throw new NativeRenderError("RENDERER_DISPOSED", "Session released");
    const started = performance.now(),
      k = this.kit,
      scale = options.scale ?? 1,
      width = Math.round(state.settings.width * scale),
      height = Math.round(state.settings.height * scale);
    if (
      !(scale > 0 && scale <= 4) ||
      width < 1 ||
      height < 1 ||
      width * height > 33554432
    )
      throw new NativeRenderError(
        "FRAME_SIZE_LIMIT",
        "Maximum 32M output pixels, scale <=4",
      );
    const surface = makeSurface(k, width, height);
    if (!surface)
      throw new NativeRenderError(
        "SURFACE_ALLOCATION_FAILED",
        `${width}x${height}`,
      );
    let canvas = surface.getCanvas();
    const evaluation = evaluateMotion(state, requestedFrame),
      frame = evaluation.frame,
      warnings = [...this.assetWarnings],
      fallbacks: NativeFrame["fallbacks"] = [],
      hits: NativeFrame["hits"] = [],
      textTrace: NativeFrame["text"] = [],
      pathTrace: NativeFrame["paths"] = [],
      usedFonts = new Set<string>();
    canvas.clear(options.transparent ? k.TRANSPARENT : k.BLACK);
    canvas.scale(scale, scale);
    const presentation = statePresentation(this.project, state),
      overrides = new Map<string, { wrapper: Matrix; opacity: number }>(),
      blocks = { ...evaluation.blocks };
    let transitions = presentedTransitions(state, frame);
    if (transitions.length) {
      const latest = Math.max(...transitions.map((t) => t.startFrame));
      transitions = transitions.filter((t) => t.startFrame === latest);
      const first = transitions[0],
        host =
          (frame - first.startFrame) / first.durationFrames >=
          first.layerPolicy.switchProgress
            ? first.toSceneId
            : first.fromSceneId;
      for (const b of presentationBlocks(state))
        if (first.timelinePolicy === "referenceStates" || [first.fromSceneId, first.toSceneId].includes(b.sceneId))
          blocks[b.blockId] = b.sceneId === host ? 1 : 0;
      for (const t of transitions) {
        const refs = presentation[t.logicalObjectId],
          current = refs?.[host];
        if (!current)
          throw new NativeRenderError(
            "TRANSITION_STATE_MISSING",
            t.logicalObjectId,
          );
        const v = interpolateState(
            refs[t.fromSceneId],
            refs[t.toSceneId],
            t,
            frame,
          ),
          offset = evaluation.transitionEffects[t.transitionId] ?? {},
          visual = multiply([[1, 0, offset.x ?? 0], [0, 1, offset.y ?? 0]], v.matrix),
          wrapper = multiply(
            multiply(multiply(inverse(current.parentCanvas), visual), [
              [1 / current.width, 0, 0],
              [0, 1 / current.height, 0],
            ]),
            inverse(current.local),
          );
        overrides.set(JSON.stringify([host, current.sourceNodeId]), {
          wrapper,
          opacity: v.opacity,
        });
      }
    }
    const layer = (
      opacity: number,
      draw: () => void,
      mode = k.BlendMode.SrcOver,
    ) => {
      const p = new k.Paint();
      p.setAlphaf(clamp(opacity));
      p.setBlendMode(mode);
      canvas.saveLayer(p);
      p.delete();
      try {
        draw();
      } finally {
        canvas.restore();
      }
    };
    const drawNode = (
      n: NativeNode,
      parent: Matrix,
      worldParent: Matrix,
      sceneId: string,
      maskOnly = false,
    ) => {
      const p = n.properties ?? {},
        key = JSON.stringify([sceneId, n.figmaNodeId]),
        visible =
          state.visibility.find(
            (v) => v.sceneId === sceneId && v.targetId === n.figmaNodeId,
          )?.visible ?? p.visible !== false;
      if (!visible) return;
      const local = multiply(inverse(parent), matrix(n.sceneTransform)),
        v = evaluation.nodes[key] ?? {},
        override = overrides.get(key),
        wrapper =
          override?.wrapper ?? motionMatrix(v, local[0][2], local[1][2]),
        combined = multiply(wrapper, local),
        world = multiply(worldParent, combined),
        opacity = (override?.opacity ?? num(p.opacity, 1)) * (v.opacity ?? 1);
      if (!maskOnly)
        hits.push({
          sceneId,
          targetId: n.figmaNodeId,
          points: [
            [0, 0],
            [num(p.width), 0],
            [num(p.width), num(p.height)],
            [0, num(p.height)],
          ].map(([x, y]) => ({
            x: world[0][0] * x + world[0][1] * y + world[0][2],
            y: world[1][0] * x + world[1][1] * y + world[1][2],
          })),
        });
      canvas.save();
      canvas.concat(affine(combined));
      const contents = () => {
        if (maskOnly && (p.maskType === "VECTOR" || !list(p.fills).length)) {
          const paint = this.paint(
            { type: "SOLID", color: { r: 1, g: 1, b: 1 } },
            n,
          );
          try {
            for (const shape of this.geometry(n))
              canvas.drawPath(shape, paint.paint);
          } finally {
            paint.dispose();
          }
          return;
        }

        if (p.clipsContent === true) {
          const path = this.geometry({ ...n, type: "RECTANGLE" })[0];
          canvas.clipPath(path, k.ClipOp.Intersect, true);
        }
        if (n.type === "TEXT") {
          const layout = this.texts.get(n.figmaNodeId)!;
          warnings.push(...layout.warnings);
          layout.fontFamilies.forEach((f) => usedFonts.add(f));
          const tracks = state.animations.filter(
            (a) =>
              a.enabled &&
              a.text &&
              a.text.segmentation !== "block" &&
              a.sceneId === sceneId &&
              a.targetId === n.figmaNodeId,
          );
          const reveal = state.animations
            .filter(
              (a) =>
                a.enabled &&
                a.effect === "maskReveal" &&
                a.sceneId === sceneId &&
                a.targetId === n.figmaNodeId,
            )
            .sort((a, b) => a.startFrame - b.startFrame)
            .filter((a) => a.startFrame <= frame)
            .at(-1);
          if (v.reveal !== undefined) {
            const progress = clamp(v.reveal),
              direction =
                reveal?.effect === "maskReveal"
                  ? reveal.parameters.direction
                  : "forward",
              horizontal = ["leftToRight", "rightToLeft"].includes(direction),
              w = num(p.width),
              h = Math.max(num(p.height), layout.height + layout.offsetY),
              cw = horizontal ? w * progress : w,
              ch = horizontal ? h : h * progress,
              x = direction === "rightToLeft" ? w - cw : 0,
              y = direction === "forward" ? h - ch : 0;
            canvas.clipRect(
              k.LTRBRect(x, y, x + cw, y + ch),
              k.ClipOp.Intersect,
              true,
            );
          }
          if (!tracks.length) {
            drawStableText(
              k,
              canvas,
              layout,
              num(p.width),
              this.textDensity(canvas, warnings, n.figmaNodeId),
            );
            textTrace.push({
              targetId: n.figmaNodeId,
              sceneId,
              lines: layout.lines,
              units: 1,
              offsets: [{ x: 0, y: 0, opacity: 1 }],
            });
          } else {
            const settings = tracks[0].text!,
              units =
                settings.segmentation === "paragraph"
                  ? layout.paragraphUnits
                  : settings.segmentation === "line"
                    ? layout.lines
                    : settings.segmentation === "word"
                      ? layout.words
                      : layout.characters,
              pictures = unitPictures(
                k,
                layout,
                settings.segmentation as
                  | "paragraph"
                  | "line"
                  | "word"
                  | "character",
              ),
              ids = new Set(tracks.map((a) => a.animationId)),
              expressions = (state.expressions ?? []).filter(
                (e) => "sourceAnimationId" in e && ids.has(e.sourceAnimationId),
              ),
              offsets: NativeFrame["text"][number]["offsets"] = [];
            for (let i = 0; i < units.length; i++) {
              const bounds = units[i],
                copies = tracks.map((a) => {
                  const step =
                      a.text!.timing === "simultaneous"
                        ? 0
                        : a.text!.timing === "sequential"
                          ? a.durationFrames / Math.max(1, units.length)
                          : a.text!.staggerFrames,
                    duration = a.durationFrames - step * (units.length - 1);
                  if (duration < 1)
                    throw new NativeRenderError(
                      "TEXT_STAGGER_EXCEEDS_DURATION",
                      a.animationId,
                    );
                  const order = a.text!.reverse ? units.length - 1 - i : i,
                    copy = {
                      ...a,
                      startFrame: a.startFrame + order * step,
                      durationFrames: duration,
                      text: undefined,
                    } as Animation;
                  if (
                    a.text!.origin === "outsideViewport" &&
                    a.effect.startsWith("slide")
                  ) {
                    const corners = [
                      [bounds.x, bounds.y],
                      [bounds.x + bounds.width, bounds.y],
                      [bounds.x, bounds.y + bounds.height],
                      [bounds.x + bounds.width, bounds.y + bounds.height],
                    ].map(([x, y]) => ({
                      x: world[0][0] * x + world[0][1] * y + world[0][2],
                      y: world[1][0] * x + world[1][1] * y + world[1][2],
                    }));
                    const dx =
                        a.effect === "slideRight"
                          ? -Math.max(...corners.map((p) => p.x)) - 1
                          : a.effect === "slideLeft"
                            ? state.settings.width -
                              Math.min(...corners.map((p) => p.x)) +
                              1
                            : 0,
                      dy =
                        a.effect === "slideDown"
                          ? -Math.max(...corners.map((p) => p.y)) - 1
                          : a.effect === "slideUp"
                            ? state.settings.height -
                              Math.min(...corners.map((p) => p.y)) +
                              1
                            : 0,
                      inv = inverse(world);
                    Object.assign(copy, {
                      effect: "moveTo",
                      parameters: {
                        fromX: inv[0][0] * dx + inv[0][1] * dy,
                        fromY: inv[1][0] * dx + inv[1][1] * dy,
                        toX: 0,
                        toY: 0,
                      },
                    });
                  }
                  return copy;
                });
              const localExpressions = expressions.map((e) => {
                const source = copies.find(
                    (a) =>
                      "sourceAnimationId" in e &&
                      a.animationId === e.sourceAnimationId,
                  )!,
                  original = tracks.find(
                    (a) => a.animationId === source.animationId,
                  )!;
                return {
                  ...e,
                  startFrame:
                    source.startFrame +
                    source.durationFrames +
                    e.startFrame -
                    original.startFrame -
                    original.durationFrames,
                };
              });
              const values =
                  evaluateMotion(
                    {
                      ...state,
                      animations: copies,
                      expressions: localExpressions,
                      objectTransitions: [],
                    },
                    frame,
                  ).nodes[key] ?? {},
                offset = {
                  x: values.x ?? 0,
                  y: values.y ?? 0,
                  opacity: values.opacity ?? 1,
                };
              offsets.push(offset);
              canvas.save();
              if (settings.origin === "masked")
                canvas.clipRect(
                  k.LTRBRect(
                    bounds.x,
                    bounds.y,
                    bounds.x + bounds.width,
                    bounds.y + bounds.height,
                  ),
                  k.ClipOp.Intersect,
                  true,
                );
              canvas.translate(offset.x, offset.y);
              layer(offset.opacity, () =>
                drawTextPlane(
                  k,
                  canvas,
                  layout,
                  settings.segmentation + ":" + i,
                  bounds,
                  (c) => c.drawPicture(pictures[i]),
                  this.textDensity(canvas, warnings, n.figmaNodeId),
                ),
              );
              canvas.restore();
            }
            textTrace.push({
              targetId: n.figmaNodeId,
              sceneId,
              lines: layout.lines,
              units: units.length,
              offsets,
            });
          }
        } else {
          const fallback = fallbackId(n),
            shape = fallback ? [] : this.geometry(n);
          if (fallback) {
            if (v.trim !== undefined)
              throw new NativeRenderError(
                "TRIM_REQUIRES_CENTERLINE",
                "Cannot trim rasterized SVG fallback",
                n.figmaNodeId,
              );
            fallbacks.push({
              targetId: n.figmaNodeId,
              assetId: fallback,
              format: this.project.inspection.document.assets
                .find((a) => a.assetId === fallback)
                ?.path.endsWith(".svg")
                ? "SVG"
                : "RASTER",
            });
            const image = this.images.get(fallback)!;
            const brush = new k.Paint();
            brush.setAntiAlias(true);
            try {
              this.drawRaster(
                canvas,
                image,
                k.XYWHRect(0, 0, num(p.width), num(p.height)),
                brush,
                warnings,
                `${n.figmaNodeId}/${fallback}`,
              );
            } finally {
              brush.delete();
            }
          } else
            for (const fill of list(p.fills)) {
              if (fill.visible === false) continue;
              const paint = this.paint(fill, n);
              try {
                if (fill.type === "IMAGE") {
                  const image = this.images.get(String(fill.assetId));
                  if (!image)
                    throw new NativeRenderError(
                      "IMAGE_ASSET_MISSING",
                      String(fill.assetId),
                      n.figmaNodeId,
                    );
                  if (fill.scaleMode === "TILE")
                    throw new NativeRenderError(
                      "IMAGE_TILE_UNSUPPORTED",
                      "Use explicit compatibility renderer",
                      n.figmaNodeId,
                    );
                  canvas.save();
                  const clipBuilder = new k.PathBuilder();
                  for (const s of shape) clipBuilder.addPath(s);
                  const imageClip = clipBuilder.detach();
                  clipBuilder.delete();
                  canvas.clipPath(imageClip, k.ClipOp.Intersect, true);
                  imageClip.delete();
                  const w = num(p.width),
                    h = num(p.height),
                    ratio =
                      fill.scaleMode === "FIT"
                        ? Math.min(w / image.width(), h / image.height())
                        : Math.max(w / image.width(), h / image.height()),
                    iw = image.width() * ratio,
                    ih = image.height() * ratio;
                  if (fill.scaleMode === "CROP") {
                    canvas.concat(
                      affine(
                        multiply(
                          multiply(
                            [
                              [w, 0, 0],
                              [0, h, 0],
                            ],
                            inverse(matrix(fill.imageTransform)),
                          ),
                          [
                            [1 / w, 0, 0],
                            [0, 1 / h, 0],
                          ],
                        ),
                      ),
                    );
                    this.drawRaster(
                      canvas,
                      image,
                      k.XYWHRect(0, 0, w, h),
                      paint.paint,
                      warnings,
                      `${n.figmaNodeId}/${fill.assetId}`,
                    );
                  } else
                    this.drawRaster(
                      canvas,
                      image,
                      k.XYWHRect((w - iw) / 2, (h - ih) / 2, iw, ih),
                      paint.paint,
                      warnings,
                      `${n.figmaNodeId}/${fill.assetId}`,
                    );
                  canvas.restore();
                  if (
                    Object.values(record(fill.filters)).some(
                      (v) => num(v) !== 0,
                    )
                  )
                    warnings.push(
                      `${n.figmaNodeId}: image color filters not implemented`,
                    );
                } else for (const s of shape) canvas.drawPath(s, paint.paint);
              } finally {
                paint.dispose();
              }
            }
          for (const stroke of list(p.strokes)) {
            if (stroke.visible === false) continue;
            const outlined = list(p.strokeGeometry).length > 0,
              paint = this.paint(stroke, n, !outlined);
            try {
              if (v.trim === undefined) {
                for (const s of this.geometry(n, true))
                  canvas.drawPath(s, paint.paint);
              } else {
                const source = shape,
                  chosen = state.animations
                    .filter(
                      (a) =>
                        a.enabled &&
                        a.effect === "trimPath" &&
                        a.sceneId === sceneId &&
                        a.targetId === n.figmaNodeId,
                    )
                    .sort((a, b) => a.startFrame - b.startFrame),
                  track =
                    chosen.filter((a) => a.startFrame <= frame).at(-1) ??
                    chosen[0],
                  dir =
                    track?.effect === "trimPath"
                      ? track.parameters.direction
                      : "forward";
                const reveal = () => {
                  for (const s of source) {
                    const m = this.paths.measure(s);
                    if (!m.length)
                      throw new NativeRenderError(
                        "TRIM_GEOMETRY_EMPTY",
                        "Zero path length",
                        n.figmaNodeId,
                      );
                    const first = m.contours[0]?.getPosTan(0),
                      last = m.contours
                        .at(-1)
                        ?.getPosTan(m.contours.at(-1)!.length()),
                      forward =
                        first && last
                          ? world[0][0] * (last[0] - first[0]) +
                              world[0][1] * (last[1] - first[1]) >=
                            0
                          : true,
                      reverse =
                        dir === "reverse" ||
                        (dir === "leftToRight" && !forward) ||
                        (dir === "rightToLeft" && forward),
                      start = reverse
                        ? 1 - clamp(v.trim!)
                        : clamp(v.trimStart ?? 0),
                      end = reverse
                        ? 1 - clamp(v.trimStart ?? 0)
                        : clamp(v.trim!),
                      trimmed = this.paths.trim(s, start, end);
                    pathTrace.push({
                      targetId: n.figmaNodeId,
                      length: m.length,
                      start,
                      end,
                      contours: m.contours.length,
                    });
                    const brush = outlined
                      ? this.paint(
                          { type: "SOLID", color: { r: 1, g: 1, b: 1 } },
                          n,
                          true,
                        )
                      : paint;
                    try {
                      canvas.drawPath(trimmed, brush.paint);
                    } finally {
                      trimmed.delete();
                      if (outlined) brush.dispose();
                    }
                  }
                };
                if (outlined) {
                  canvas.saveLayer();
                  for (const s of this.geometry(n, true))
                    canvas.drawPath(s, paint.paint);
                  layer(1, reveal, k.BlendMode.DstIn);
                  canvas.restore();
                } else reveal();
              }
            } finally {
              paint.dispose();
            }
          }
        }
        let mask: NativeNode | undefined;
        const children: { child: NativeNode; mask?: NativeNode }[] = [];
        for (const child of n.children ?? []) {
          if (child.properties?.isMask) {
            if (child.properties.visible !== false) mask = child;
            continue;
          }
          children.push({ child, mask });
        }
        if (p.itemReverseZIndex === true) children.reverse();
        for (const entry of children) {
          if (entry.mask) {
            canvas.saveLayer();
            drawNode(entry.child, matrix(n.sceneTransform), world, sceneId);
            const filter =
              entry.mask.properties.maskType === "LUMINANCE"
                ? k.ColorFilter.MakeLuma()
                : undefined;
            const mp = new k.Paint();
            mp.setBlendMode(k.BlendMode.DstIn);
            if (filter) mp.setColorFilter(filter);
            canvas.saveLayer(mp);
            mp.delete();
            filter?.delete();
            drawNode(
              entry.mask,
              matrix(n.sceneTransform),
              world,
              sceneId,
              true,
            );
            canvas.restore();
            canvas.restore();
          } else
            drawNode(entry.child, matrix(n.sceneTransform), world, sceneId);
        }
      };
      const effects = list(p.effects).filter((e) => e.visible !== false);
      let filter: ReturnType<typeof k.ImageFilter.MakeBlur> | null = null;
      try {
        for (const e of effects) {
          const old = filter;
          if (e.type === "DROP_SHADOW") {
            const c = record(e.color),
              o = record(e.offset);
            filter = k.ImageFilter.MakeDropShadow(
              num(o.x),
              num(o.y),
              num(e.radius) / 2,
              num(e.radius) / 2,
              k.Color4f(num(c.r), num(c.g), num(c.b), num(c.a, 1)),
              old,
            );
          } else if (e.type === "LAYER_BLUR")
            filter = k.ImageFilter.MakeBlur(
              num(e.radius) / 2,
              num(e.radius) / 2,
              k.TileMode.Decal,
              old,
            );
          else {
            warnings.push(
              `${n.figmaNodeId}: unsupported effect ${String(e.type)}`,
            );
            continue;
          }
          old?.delete();
        }
        const blend = String(p.blendMode ?? "NORMAL")
          .toLowerCase()
          .replace(/_(.)/g, (_, c: string) => c.toUpperCase());
        const mode =
          (
            {
              multiply: k.BlendMode.Multiply,
              screen: k.BlendMode.Screen,
              overlay: k.BlendMode.Overlay,
              darken: k.BlendMode.Darken,
              lighten: k.BlendMode.Lighten,
              colorDodge: k.BlendMode.ColorDodge,
              colorBurn: k.BlendMode.ColorBurn,
              hardLight: k.BlendMode.HardLight,
              softLight: k.BlendMode.SoftLight,
              exclusion: k.BlendMode.Exclusion,
              hue: k.BlendMode.Hue,
              saturation: k.BlendMode.Saturation,
              color: k.BlendMode.Color,
              luminosity: k.BlendMode.Luminosity,
              difference: k.BlendMode.Difference,
            } as Record<string, typeof k.BlendMode.SrcOver>
          )[blend] ?? k.BlendMode.SrcOver;
        if (
          filter &&
          !maskOnly &&
          n.type !== "TEXT" &&
          !(n.children ?? []).length &&
          v.trim === undefined &&
          v.reveal === undefined
        ) {
          const density = Math.max(1, Math.min(4, Math.ceil(scale))),
            key = n.figmaNodeId + ":" + density;
          let cached = this.effectPlanes.get(key);
          const pad = Math.ceil(
            Math.max(
              2,
              ...effects.map(
                (e) =>
                  num(e.radius) * 2 +
                  Math.max(
                    Math.abs(num(record(e.offset).x)),
                    Math.abs(num(record(e.offset).y)),
                  ),
              ),
            ) +
              num(p.strokeWeight) * num(p.strokeMiterLimit, 4),
          );
          const w = Math.ceil(num(p.width)) + 2 * pad,
            h = Math.ceil(num(p.height)) + 2 * pad,
            bytes = w * h * density * density * 4;
          if (
            !cached &&
            bytes > 0 &&
            this.effectBytes + bytes <= 128 * 1024 * 1024
          ) {
            const surface = makeSurface(k, w * density, h * density);
            if (surface) {
              const original = canvas;
              try {
                canvas = surface.getCanvas();
                canvas.clear(k.TRANSPARENT);
                canvas.scale(density, density);
                canvas.translate(pad, pad);
                const paint = new k.Paint();
                paint.setImageFilter(filter);
                canvas.saveLayer(paint);
                paint.delete();
                contents();
                canvas.restore();
                surface.flush();
                cached = {
                  image: surface.makeImageSnapshot(),
                  pad,
                  width: w,
                  height: h,
                };
                this.effectPlanes.set(key, cached);
                this.effectBytes += bytes;
              } finally {
                canvas = original;
                surface.dispose();
              }
            }
          }
          if (cached) {
            filter.delete();
            filter = null;
            layer(
              opacity,
              () =>
                canvas.drawImageRectOptions(
                  cached!.image,
                  k.XYWHRect(
                    0,
                    0,
                    cached!.image.width(),
                    cached!.image.height(),
                  ),
                  k.XYWHRect(
                    -cached!.pad,
                    -cached!.pad,
                    cached!.width,
                    cached!.height,
                  ),
                  k.FilterMode.Linear,
                  k.MipmapMode.None,
                ),
              mode,
            );
          } else {
            const paint = new k.Paint();
            paint.setAlphaf(clamp(opacity));
            paint.setImageFilter(filter);
            canvas.saveLayer(paint);
            paint.delete();
            filter.delete();
            filter = null;
            contents();
            canvas.restore();
          }
        } else if (filter) {
          const paint = new k.Paint();
          paint.setAlphaf(clamp(opacity));
          paint.setImageFilter(filter);
          paint.setBlendMode(mode);
          canvas.saveLayer(paint);
          paint.delete();
          filter.delete();
          filter = null;
          contents();
          canvas.restore();
        } else if (opacity !== 1 || mode !== k.BlendMode.SrcOver)
          layer(opacity, contents, mode);
        else contents();
      } finally {
        filter?.delete();
      }
      canvas.restore();
    };
    try {
      for (const block of presentationBlocks(state).sort(
        (a, b) => a.startFrame - b.startFrame,
      )) {
        const opacity = blocks[block.blockId] ?? 0;
        if (opacity <= 0) continue;
        const scene = this.project.inspection.document.scenes.find(
          (s) => s.sceneId === block.sceneId,
        )!;
        const fit = canvasMatrix(scene, state.settings);
        canvas.save();
        canvas.concat(affine(fit));
        canvas.clipRect(
          k.XYWHRect(0, 0, scene.width, scene.height),
          k.ClipOp.Intersect,
          true,
        );
        layer(opacity, () =>
          drawNode(scene as unknown as NativeNode, unit, fit, scene.sceneId),
        );
        canvas.restore();
      }
      const drawn = performance.now();
      surface.flush();
      const snapshot = surface.makeImageSnapshot();
      let png: Uint8Array;
      try {
        const bytes =
          options.encoding === "rgba"
            ? snapshot.readPixels(0, 0, {
                width,
                height,
                colorType: k.ColorType.RGBA_8888,
                alphaType: k.AlphaType.Unpremul,
                colorSpace: k.ColorSpace.SRGB,
              })
            : snapshot.encodeToBytes(k.ImageFormat.PNG, 100);
        if (!bytes)
          throw new NativeRenderError(
            "PNG_ENCODE_FAILED",
            "Skia returned no bytes",
          );
        png = Uint8Array.from(bytes);
      } finally {
        snapshot.delete();
      }
      return {
        png,
        encoding: options.encoding ?? "png",
        frame,
        width,
        height,
        renderer: this.renderer,
        environment: {
          engine: "canvaskit-wasm/0.42.0",
          fontFilesDigest: this.resources.catalogDigest,
        },
        warnings: [
          ...new Set([
            ...warnings,
            ...[...this.texts.values()].flatMap((t) => t.warnings),
          ]),
        ],
        fallbacks: [...new Map(fallbacks.map((f) => [f.targetId, f])).values()],
        hits,
        stats: {
          milliseconds: performance.now() - started,
          drawMs: drawn - started,
          encodeMs: performance.now() - drawn,
          textLayouts: this.texts.size,
          paths: this.paths.size,
          images: this.images.size,
        },
        fonts: [...usedFonts].map((family) => ({
          family,
          candidateFiles: this.resources.manifest
            .filter((f) => f.families.includes(family))
            .map(({ file, sha256 }) => ({ file, sha256 })),
        })),
        text: textTrace,
        paths: pathTrace,
      };
    } finally {
      surface.dispose();
    }
  }
  probeText(targetId: string) {
    const layout = this.texts.get(targetId);
    if (!layout) throw new NativeRenderError("TEXT_TARGET_NOT_FOUND", targetId);
    const width =
        Math.ceil(Math.max(1, ...layout.lines.map((l) => l.x + l.width))) + 24,
      height = Math.ceil(layout.height + layout.offsetY) + 24;
    if (width * height > 4e6)
      throw new NativeRenderError(
        "TEXT_PROBE_LIMIT",
        "Probe exceeds 4M pixels",
      );
    const k = this.kit,
      surface = makeSurface(k, width, height);
    if (!surface)
      throw new NativeRenderError("TEXT_PROBE_ALLOCATION_FAILED", targetId);
    const samples = [];
    try {
      for (const offset of [0, 0.25, 0.375, 0.5, 0.625, 0.75, -0.25]) {
        const c = surface.getCanvas();
        c.clear(k.TRANSPARENT);
        c.save();
        c.translate(8, 8 + offset);
        drawStableText(k, c, layout, width - 24, 2);
        c.restore();
        surface.flush();
        const image = surface.makeImageSnapshot();
        try {
          const pixels = image.readPixels(0, 0, {
            width,
            height,
            colorType: k.ColorType.RGBA_8888,
            alphaType: k.AlphaType.Unpremul,
            colorSpace: k.ColorSpace.SRGB,
          })!;
          let mass = 0,
            y = 0;
          for (let i = 3; i < pixels.length; i += 4) {
            mass += pixels[i];
            y += pixels[i] * Math.floor((i - 3) / 4 / width);
          }
          samples.push({ offset, mass, y: y / mass });
        } finally {
          image.delete();
        }
      }
      const first = samples[0];
      if (!first.mass)
        return {
          status: "NOT_TESTED",
          reason: "No visible glyph alpha",
          samples,
        };
      const maximumError = Math.max(
        ...samples.map((s) => Math.abs(s.y - first.y - s.offset)),
      );
      return {
        status: maximumError <= 0.125 ? "PASSED" : "FAILED",
        maximumError,
        tolerance: 0.125,
        samples,
        renderer: "native-glyph-plane",
      };
    } finally {
      surface.dispose();
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const image of this.mipmaps.values()) image.delete();
    this.mipmaps.clear();
    this.mipmapBytes = 0;
    for (const image of this.images.values()) image.delete();
    for (const text of this.texts.values()) text.dispose();
    this.paths.dispose();
    this.images.clear();
    this.texts.clear();
    for (const p of this.effectPlanes.values()) p.image.delete();
    this.effectPlanes.clear();
    this.resources.dispose();
  }
}
export const nativeDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
