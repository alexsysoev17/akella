import {segmentAnimation,segmentExpression,segmentExpressionSource} from '../motion/text-segment.js';
import {anchorBinding,anchorLocal,anchoredMotion,transformPoint,motionTransform} from '../motion/anchor.js';
import {transitionOffsetMatrix} from "../motion/geometry.js";
import {textViewportOffset} from "../motion/text-clearance.js";
import {buildRegistry} from "../motion/registry.js";
import {motionPresentationHosts} from "../motion/presentation-lifetime.js";
import {MAX_FLOAT32} from "../motion/time.js";
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
import { evaluateMotion } from "../motion/evaluation.js";
import {
  canvasMatrix,
  inverse,
  matrix,
  multiply,
  unit,
  type Matrix,
} from "../motion/geometry.js";
import { statePresentation } from "../motion/transitions.js";
import { interpolateState, presentedTransitions, presentationBlocks, compositionSceneWeights } from "../motion/transition-runtime.js";
import { staticObjectMembers, staticObjectReference } from "../motion/static-object.js";
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
    transform?:Matrix; parentTransform?:Matrix; anchor?:{x:number;y:number};anchorLocal?:{x:number;y:number};bounds?:{width:number;height:number};
  }[];
  coverageRegion?: {x:number;y:number;width:number;height:number;canvasWidth:number;canvasHeight:number};
  composition?: {
    activeScenes: {sceneId:string;opacity:number}[];
    transitions: {transitionId:string;logicalObjectId:string;fromSceneId:string;toSceneId:string;hostSceneId:string;progress:number;active:boolean}[];
    instances: {sceneId:string;targetId:string;logicalObjectId?:string;parentId?:string;transform?:Matrix;opacity?:number;parentOpacity?:number;effectiveOpacity?:number;visible:boolean;zOrder?:number;reason?:string;animationIds:string[];transitionId?:string;opaqueCover?:boolean}[];
  };
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
    offsets: { x: number; y: number; opacity: number; scaleX?: number; scaleY?: number; rotation?: number; segmentId?: string }[];
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
      diagnostics?: boolean;
      coverageProbe?: {focus:{sceneId:string;targetId:string}[];ignore:{sceneId:string;targetId:string}[];roi?:boolean};
    } = {},
  ): NativeFrame {
    if(options.coverageProbe&&(options.encoding!=="rgba"||(options.scale??1)!==1))throw new NativeRenderError("COVERAGE_ENCODING_REQUIRED","Coverage probes use raw RGBA only");
    if (this.disposed)
      throw new NativeRenderError("RENDERER_DISPOSED", "Session released");
    const started = performance.now(),
      k = this.kit,
      scale = options.scale ?? 1,
      width = Math.max(1,Math.round(state.settings.width * scale)),
      height = Math.max(1,Math.round(state.settings.height * scale));
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
    const cropProbe=options.coverageProbe?.roi!==false&&Boolean(options.coverageProbe);
    let canvas = surface.getCanvas();
    const probePoints:{x:number;y:number}[]=[];
    let coverageRegion:NativeFrame["coverageRegion"];
    let effectPadding=8;
    if(cropProbe){const visit=(n:NativeNode)=>{for(const e of list(n.properties?.effects))if(e.visible!==false){const o=record(e.offset);effectPadding+=3*(num(e.radius)+num(e.spread)+Math.abs(num(o.x))+Math.abs(num(o.y)));}(n.children??[]).forEach(visit);};for(const scene of this.project.inspection.document.scenes)visit(scene as unknown as NativeNode);}
    const presentation = statePresentation(this.project, state);
    const evaluation = evaluateMotion(state, requestedFrame, presentation),
      frame = evaluation.frame,
      warnings = [...this.assetWarnings],
      fallbacks: NativeFrame["fallbacks"] = [],
      hits: NativeFrame["hits"] = [],
      textTrace: NativeFrame["text"] = [],
      pathTrace: NativeFrame["paths"] = [],
      usedFonts = new Set<string>();
    canvas.clear(options.transparent ? k.TRANSPARENT : k.BLACK);
    canvas.scale(scale, scale);
    const registry=buildRegistry(this.project.inspection.document,this.project.inspection.fingerprint);
    const identities=new Map(registry.objects.flatMap(o=>o.sourceInstances.map(i=>[JSON.stringify([i.sceneId,i.sourceNodeId]),o.logicalObjectId] as const)));
    const probe=options.coverageProbe;
    const probeFocus=new Set(probe?.focus.map(i=>JSON.stringify([i.sceneId,i.targetId])));
    const probeIgnore=new Set(probe?.ignore.map(i=>JSON.stringify([i.sceneId,i.targetId])));
    const probeAncestors=new Set<string>();
    if(probe)for(const scene of this.project.inspection.document.scenes){const walk=(n:NativeNode):boolean=>{const key=JSON.stringify([scene.sceneId,n.figmaNodeId]);const child=(n.children??[]).map(walk).some(Boolean);if(child)probeAncestors.add(key);return probeFocus.has(key)||child;};walk(scene as unknown as NativeNode);}
    let probeDepth=0,probePainted=false;
    const trace=new Map<string,NonNullable<NativeFrame["composition"]>["instances"][number]>();
    let sceneOpacity=1,drawOrder=0;
    const overrides = new Map<string, { wrapper: Matrix; opacity: number; composeInstance: boolean;anchor?:{x:number;y:number} }>(),
      blocks = compositionSceneWeights(state, frame, evaluation.blocks);
    let transitions = presentedTransitions(state, frame);
    const detachedTransitions=new Set<string>();
    if (transitions.length) {
      for (const t of transitions) {
        const host=(frame-t.startFrame)/t.durationFrames>=t.layerPolicy.switchProgress?t.toSceneId:t.fromSceneId;
        if(!presentationBlocks(state).some(b=>b.sceneId===host&&(blocks[b.blockId]??0)>0))detachedTransitions.add(t.transitionId);
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
            frame,state,
          ),
          offset = evaluation.transitionEffects[t.transitionId] ?? {},
          visual = transitionOffsetMatrix(v.matrix,offset,v.anchor?transformPoint(v.matrix,v.anchor):undefined),
          wrapper = multiply(
            multiply(multiply(inverse(current.parentCanvas), visual), [
              [1 / current.width, 0, 0],
              [0, 1 / current.height, 0],
            ]),
            inverse(current.local),
          );
        overrides.set(JSON.stringify([host, current.sourceNodeId]), {
          wrapper,
          opacity: clamp(v.opacity+(offset.opacity??0)),anchor:v.anchor,
          composeInstance: frame >= t.startFrame + t.durationFrames,
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
    const frozenMembers = new Set((state.staticObjects ?? []).flatMap(o => [...staticObjectMembers(this.project, o.logicalObjectId).members]));
    let drawingStatic = false, currentStaticRoot: string | null = null, onlyActive = false;
    const visibleScenes=new Set(presentationBlocks(state).filter(b=>(blocks[b.blockId]??0)>0).map(b=>b.sceneId));
    const hosts=motionPresentationHosts(state,frame,buildRegistry(this.project.inspection.document,this.project.inspection.fingerprint).objects.filter(o=>!transitions.some(t=>t.logicalObjectId===o.logicalObjectId)).flatMap(o=>o.ambiguousScenes.length?o.sourceInstances.map(i=>({sourceInstances:[i]})):[o]),visibleScenes);
    for(const t of transitions.filter(t=>detachedTransitions.has(t.transitionId))) {
      const object=buildRegistry(this.project.inspection.document,this.project.inspection.fingerprint).objects.find(o=>o.logicalObjectId===t.logicalObjectId);
      const chosen=object?.sourceInstances.find(i=>overrides.has(JSON.stringify([i.sceneId,i.sourceNodeId])));
      if(chosen)for(const i of object!.sourceInstances)hosts.set(JSON.stringify([i.sceneId,i.sourceNodeId]),chosen);
    }
    const globalRoots=new Set([...hosts.values()].map(i=>JSON.stringify([i.sceneId,i.sourceNodeId])));
    const globalScenes=new Set([...hosts.values()].map(i=>i.sceneId));
    const activeTree=new Set<string>(), globalContent=new Set<string>();
    for (const scene of this.project.inspection.document.scenes) {
      const walk=(n:NativeNode,inside=false):boolean=>{
        const key=JSON.stringify([scene.sceneId,n.figmaNodeId]);
        inside ||= globalRoots.has(key);
        if(inside) globalContent.add(key);
        const children=(n.children ?? []).map(c=>walk(c,inside));
        const active=inside||children.some(Boolean);
        if(active) activeTree.add(key);
        return active;
      };
      walk(scene as unknown as NativeNode);
    }
    const drawNode = (
      n: NativeNode,
      parent: Matrix,
      worldParent: Matrix,
      sceneId: string,
      maskOnly = false,
    ) => {
      const nodeKey=JSON.stringify([sceneId,n.figmaNodeId]);
      if(probe&&!maskOnly&&probeIgnore.has(nodeKey))return;
      const probeInk=probe&&!maskOnly&&probeDepth===0&&!probeAncestors.has(nodeKey)?(probeFocus.has(nodeKey)?"white":"black"):undefined;
      if(probeInk==="black"&&!probePainted&&[undefined,"NORMAL","PASS_THROUGH"].includes(n.properties?.blendMode as string|undefined))return;
      if(probeInk==="white")probePainted=true;
      if(probe&&!maskOnly&&probeAncestors.has(nodeKey))n={...n,properties:{...n.properties,fills:[],strokes:[]}};
      const diagnostic=options.diagnostics ? {sceneId,targetId:n.figmaNodeId,logicalObjectId:identities.get(nodeKey),parentId:(n as NativeNode & {parentId?:string}).parentId,visible:false,animationIds:state.animations.filter(a=>a.enabled&&a.sceneId===sceneId&&a.targetId===n.figmaNodeId).map(a=>a.animationId)} : undefined;
      const exclude=(reason:string)=>{if(diagnostic&&!trace.get(nodeKey)?.visible)trace.set(nodeKey,{...diagnostic,reason});};
      if (onlyActive && !maskOnly && !activeTree.has(nodeKey)) {exclude("INACTIVE_REFERENCE_SUBTREE");return;}
      const globalHost=hosts.get(nodeKey);
      if (!drawingStatic && globalHost && (globalHost.sceneId!==sceneId || globalHost.sourceNodeId!==n.figmaNodeId)) {exclude("OTHER_INSTANCE_OWNS_PRESENTATION");return;}
      if (onlyActive && !globalContent.has(nodeKey)) n={...n,properties:{...n.properties,fills:[],strokes:[]}};
      const p = n.properties ?? {},
        key = JSON.stringify([sceneId, n.figmaNodeId]),
        visible =
          state.visibility.find(
            (v) => v.sceneId === sceneId && v.targetId === n.figmaNodeId,
          )?.visible ?? p.visible !== false;
      if (!drawingStatic && frozenMembers.has(`${sceneId}/${n.figmaNodeId}`)) {exclude("STATIC_OBJECT_OWNS_PRESENTATION");return;}
      if (!visible && currentStaticRoot !== key) {exclude("EXPLICIT_OR_SOURCE_VISIBILITY");return;}
      const local = multiply(inverse(parent), matrix(n.sceneTransform)),
        binding=anchorBinding(state.anchors,identities.get(key)??"",sceneId,frame,state.anchorDefault),
        override = overrides.get(key),
        pivot=override?.anchor?{x:override.anchor.x*num(p.width),y:override.anchor.y*num(p.height)}:anchorLocal(binding,num(p.width),num(p.height)),
        v = evaluation.nodes[key] ?? {},
        wrapper =
          override ? (override.composeInstance ? multiply(anchoredMotion(v,local,binding,num(p.width),num(p.height)), override.wrapper) : override.wrapper) : anchoredMotion(v,local,binding,num(p.width),num(p.height)),
        combined = override&&!override.composeInstance&&binding?multiply(motionTransform(binding.transform??{},transformPoint(multiply(wrapper,local),pivot),binding.compensation),multiply(wrapper,local)):multiply(wrapper, local),
        world = multiply(worldParent, combined),
        opacity = (override?.opacity ?? num(p.opacity, 1)) * (v.opacity ?? 1);
      if(diagnostic&&!maskOnly){
        const parentOpacity=diagnostic.parentId ? trace.get(JSON.stringify([sceneId,diagnostic.parentId]))?.effectiveOpacity??sceneOpacity : sceneOpacity;
        trace.set(nodeKey,{...diagnostic,transform:world,opacity,parentOpacity,effectiveOpacity:parentOpacity*opacity,visible:parentOpacity*opacity>0,opaqueCover:parentOpacity*opacity===1&&["RECTANGLE","FRAME"].includes(n.type)&&!p.cornerRadius&&!p.isMask&&!list(p.effects).length&&list(p.fills).some(f=>f.type==="SOLID"&&f.visible!==false&&num(f.opacity,1)===1&&num(record(f.color).a,1)===1),zOrder:drawOrder++,transitionId:transitions.find(t=>overrides.has(nodeKey)&&presentation[t.logicalObjectId]?.[sceneId]?.sourceNodeId===n.figmaNodeId)?.transitionId});
      }
      if (!maskOnly)
        hits.push({
          sceneId,
          targetId: n.figmaNodeId,
          transform:world,parentTransform:worldParent,anchor:transformPoint(world,pivot),anchorLocal:pivot,bounds:{width:num(p.width),height:num(p.height)},
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
      if (![...combined.flat(), ...world.flat()].every(v=>Number.isFinite(v)&&Math.abs(v)<=MAX_FLOAT32))
        throw new NativeRenderError("NUMERIC_TRANSFORM_OVERFLOW", n.figmaNodeId);
      canvas.save();
      canvas.concat(affine(combined));
      if(probeInk){const p=new k.Paint(),filter=k.ColorFilter.MakeBlend(probeInk==="white"?k.WHITE:k.BLACK,k.BlendMode.SrcIn);p.setColorFilter(filter);canvas.saveLayer(p);filter.delete();p.delete();probeDepth++;}
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

        if (p.clipsContent === true && n.figmaNodeId !== this.project.inspection.document.scenes.find(s=>s.sceneId===sceneId)?.figmaNodeId) {
          const path = this.geometry({ ...n, type: "RECTANGLE" })[0];
          canvas.clipPath(path, k.ClipOp.Intersect, true);
        }
        if (n.type === "TEXT") {
          const layout = this.texts.get(n.figmaNodeId)!;
          warnings.push(...layout.warnings);
          const captureProbe=(offsets:{x:number;y:number}[]=[])=>{
            if(!cropProbe||!probeFocus.has(key))return;
            const pad=effectPadding+2*num(record(n.text).fontSize,48),
              x=Math.min(0,...layout.lines.map(l=>l.x))-pad,y=Math.min(0,layout.offsetY,...layout.lines.map(l=>l.y))-pad,
              right=Math.max(num(p.width),...layout.lines.map(l=>l.x+l.width))+pad,bottom=Math.max(num(p.height),layout.height+layout.offsetY,...layout.lines.map(l=>l.y+l.height))+pad;
            for(const offset of offsets.length?offsets:[{x:0,y:0}])for(const [px,py] of [[x,y],[right,y],[right,bottom],[x,bottom]])probePoints.push({x:world[0][0]*(px+offset.x)+world[0][1]*(py+offset.y)+world[0][2],y:world[1][0]*(px+offset.x)+world[1][1]*(py+offset.y)+world[1][2]});
          };
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
            captureProbe();
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
                (e) => Boolean(segmentExpressionSource(e)&&ids.has(segmentExpressionSource(e)!)),
              ),
              offsets: NativeFrame["text"][number]["offsets"] = [];
            for (let i = 0; i < units.length; i++) {
              const bounds = units[i],
                copies = tracks.map((a) => {
                  const copy = segmentAnimation(a, units.length, i);
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
                    const mode = "mode" in a.parameters ? a.parameters.mode : "in";
                    const delta=textViewportOffset(corners,{x:0,y:0,width:state.settings.width,height:state.settings.height},a.effect,mode);
                    const inv=inverse(world);
                    const local={x:inv[0][0]*delta.x+inv[0][1]*delta.y,y:inv[1][0]*delta.x+inv[1][1]*delta.y};
                    Object.assign(copy, {
                      effect: "moveTo",
                      parameters: mode === "out" ? {fromX:0,fromY:0,toX:local.x,toY:local.y} : {fromX:local.x,fromY:local.y,toX:0,toY:0},
                    });
                  }
                  return copy;
                });
              const localExpressions = expressions.map((e) => {
                const source = copies.find(
                    (a) =>
                      a.animationId === segmentExpressionSource(e),
                  )!,
                  original = tracks.find(
                    (a) => a.animationId === source.animationId,
                  )!;
                return segmentExpression(e,source,original);
              });
              const values =
                  evaluateMotion(
                    {
                      ...state,
                      animations: copies,
                      expressions: localExpressions,
                      objectTransitions: [],
                    },
                    frame,{},[...copies,...state.animations.filter(a=>!ids.has(a.animationId)&&localExpressions.some(e=>e.type==='procedural'&&e.program.instructions.some(i=>i.op==='sample'&&i.animationId===a.animationId)))],
                  ).nodes[key] ?? {},
                offset = {
                  x: values.x ?? 0,
                  y: values.y ?? 0,
                  opacity: values.opacity ?? 1,
                  scaleX: values.scaleX ?? values.scale ?? 1,
                  scaleY: values.scaleY ?? values.scale ?? 1,
                  rotation: values.rotation ?? 0,
                  segmentId: `${sceneId}/${n.figmaNodeId}/${settings.segmentation}/${i}`,
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
              if(offset.rotation!==0||offset.scaleX!==1||offset.scaleY!==1){
                const cx=bounds.x+bounds.width/2,cy=bounds.y+bounds.height/2;
                canvas.translate(cx,cy);
                canvas.rotate(offset.rotation,0,0);
                canvas.scale(offset.scaleX,offset.scaleY);
                canvas.translate(-cx,-cy);
              }
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
            captureProbe(offsets);
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
      if(probeInk){probeDepth--;canvas.restore();}
      canvas.restore();
    };
    try {
      const renderBlocks=presentationBlocks(state);
      for(const scene of this.project.inspection.document.scenes)
        if(!renderBlocks.some(b=>b.sceneId===scene.sceneId)&&globalScenes.has(scene.sceneId))
          renderBlocks.push({blockId:"motion-reference:"+scene.sceneId,sceneId:scene.sceneId,name:scene.name,startFrame:0,durationFrames:0,transition:{type:"cut",durationFrames:0}});
      const orderedBlocks=renderBlocks.sort((a,b)=>a.startFrame-b.startFrame);
      const paintScene=(block:typeof renderBlocks[number],scene:NativeNode,partial:boolean)=>{
        const opacity=blocks[block.blockId]??0;
        onlyActive=partial;sceneOpacity=opacity>0?opacity:1;
        const fit=canvasMatrix(this.project.inspection.document.scenes.find(s=>s.sceneId===block.sceneId)!,state.settings);
        canvas.save();canvas.concat(affine(fit));
        layer(opacity>0?opacity:1,()=>drawNode(scene,unit,fit,block.sceneId));
        canvas.restore();onlyActive=false;
      };
      const detached=orderedBlocks.some(b=>(blocks[b.blockId]??0)<=0&&globalScenes.has(b.sceneId));
      if(!detached){
        for(const block of orderedBlocks)if((blocks[block.blockId]??0)>0)
          paintScene(block,this.project.inspection.document.scenes.find(s=>s.sceneId===block.sceneId)! as unknown as NativeNode,false);
      }else{
        // Merge source-tree layer slots instead of painting a foreign scene's
        // opaque background over an already composed scene. Keep mask chains
        // together and preserve every group's descendants/ancestor clipping.
        const layers:{block:typeof renderBlocks[number];scene:NativeNode;partial:boolean;rank:number;order:number}[]=[];
        const base=orderedBlocks.find(b=>(blocks[b.blockId]??0)>0);
        const baseScene=this.project.inspection.document.scenes.find(s=>s.sceneId===base?.sceneId);
        const baseChildren=(baseScene?.children??[]) as NativeNode[];
        const baseOrder=new Map(baseChildren.map((n,i)=>[n.name,record(baseScene?.properties).itemReverseZIndex===true?baseChildren.length-1-i:i]));
        for(const [order,block] of orderedBlocks.entries()){
          const partial=(blocks[block.blockId]??0)<=0;
          if(partial&&!globalScenes.has(block.sceneId))continue;
          const source=this.project.inspection.document.scenes.find(s=>s.sceneId===block.sceneId)! as unknown as NativeNode;
          if(!partial)paintScene(block,{...source,children:[]},false);
          if(num(source.properties.opacity,1)!==1||list(source.properties.effects).some(e=>e.visible!==false)||![undefined,"NORMAL","PASS_THROUGH"].includes(source.properties.blendMode as string|undefined))
            warnings.push("COMPOSITION_ROOT_ISOLATION_REQUIRES_REVIEW: "+block.sceneId+"; detached subtree composition retains source styles per layer; whole-frame group blend/effect equivalence is not verified");
          let mask:NativeNode|undefined;
          for(const [index,child] of source.children.entries()){
            if(child.properties?.isMask){if(child.properties.visible!==false)mask=child;continue;}
            const rank=baseOrder.get(child.name??"")??(source.properties.itemReverseZIndex===true?source.children.length-1-index:index);
            layers.push({block,partial,rank,order,scene:{...source,properties:{...source.properties,fills:[],strokes:[]},children:mask?[mask,child]:[child]}});
          }
        }
        for(const entry of layers.sort((a,b)=>a.rank-b.rank||a.order-b.order))paintScene(entry.block,entry.scene,entry.partial);
      }
      // Persistent objects have one immutable source presentation across every
      // scene. Original instances are suppressed above, including transitions.
      for (const entry of state.staticObjects ?? []) {
        const scene = this.project.inspection.document.scenes.find(s => s.sceneId === entry.sceneId)!;
        const find = (nodes: NativeNode[]): NativeNode | undefined => {
          for (const n of nodes) { if (n.figmaNodeId === entry.targetId) return n; const child = find(n.children ?? []); if (child) return child; }
        };
        const source = find(scene.children as NativeNode[]);
        if (!source) throw new NativeRenderError("STATIC_SOURCE_NOT_FOUND", entry.targetId);
        const fit = canvasMatrix(scene, state.settings);
        drawingStatic = true; currentStaticRoot = JSON.stringify([entry.sceneId, entry.targetId]);
        const reference = staticObjectReference(this.project,entry);
        const originalOpacity = num(source.properties.opacity,1) * reference.inheritedOpacity;
        canvas.save(); canvas.concat(affine(fit));
        canvas.clipRect(k.XYWHRect(0,0,scene.width,scene.height),k.ClipOp.Intersect,true);
        drawNode({ ...source, properties: { ...source.properties, visible: true, opacity: originalOpacity > 0 ? originalOpacity : 1 } }, unit, fit, entry.sceneId);
        canvas.restore(); drawingStatic = false; currentStaticRoot = null;
      }
      if(cropProbe){
        const x=Math.max(0,Math.min(width-1,Math.floor(Math.min(...probePoints.map(p=>p.x),width-1)*scale))),y=Math.max(0,Math.min(height-1,Math.floor(Math.min(...probePoints.map(p=>p.y),height-1)*scale))),right=Math.min(width,Math.max(x+1,Math.ceil(Math.max(...probePoints.map(p=>p.x),0)*scale))),bottom=Math.min(height,Math.max(y+1,Math.ceil(Math.max(...probePoints.map(p=>p.y),0)*scale)));
        coverageRegion={x,y,width:right-x,height:bottom-y,canvasWidth:width,canvasHeight:height};

      }
      const drawn = performance.now();
      surface.flush();
      const snapshot = surface.makeImageSnapshot();
      let png: Uint8Array;
      try {
        const bytes =
          options.encoding === "rgba"
            ? snapshot.readPixels(coverageRegion?.x??0, coverageRegion?.y??0, {
                width:coverageRegion?.width??width,
                height:coverageRegion?.height??height,
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
        width:coverageRegion?.width??width,
        height:coverageRegion?.height??height,
        coverageRegion,
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
        composition:options.diagnostics ? {
          activeScenes:presentationBlocks(state).filter(b=>(blocks[b.blockId]??0)>0).map(b=>({sceneId:b.sceneId,opacity:blocks[b.blockId]})),
          transitions:transitions.map(t=>({transitionId:t.transitionId,logicalObjectId:t.logicalObjectId,fromSceneId:t.fromSceneId,toSceneId:t.toSceneId,hostSceneId:frame>=t.startFrame+t.durationFrames*t.layerPolicy.switchProgress?t.toSceneId:t.fromSceneId,progress:Math.max(0,Math.min(1,(frame-t.startFrame)/t.durationFrames)),active:frame<t.startFrame+t.durationFrames})),
          instances:this.project.inspection.document.scenes.flatMap(scene=>{const visit=(n:NativeNode,parentId?:string):NonNullable<NativeFrame["composition"]>["instances"]=>{const key=JSON.stringify([scene.sceneId,n.figmaNodeId]);return [trace.get(key)??{sceneId:scene.sceneId,targetId:n.figmaNodeId,parentId,logicalObjectId:identities.get(key),visible:false,reason:visibleScenes.has(scene.sceneId)?"PARENT_EXCLUDED":"SCENE_INACTIVE",animationIds:[]},...(n.children??[]).flatMap(c=>visit(c,n.figmaNodeId))];};return visit(scene as unknown as NativeNode);}),
        }:undefined,
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
