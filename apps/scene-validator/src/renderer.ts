import { renderingMode } from "./native/client.js";
import { reconstructNativeProject } from "./native/reconstruct.js";
import { pathCapability } from "./motion-library/registry/path-capability.js";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import type { Asset, LoadedProject, Scene } from "./types.js";
import { within } from "./files.js";
export type Matrix = [[number, number, number], [number, number, number]];
const unit: Matrix = [
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
  if (Math.abs(det) < 1e-12) throw new Error("Singular transform");
  return [
    [d / det, -c / det, (c * y - d * x) / det],
    [-b / det, a / det, (b * x - a * y) / det],
  ];
}
const matrix = (v: unknown): Matrix => {
  if (
    !Array.isArray(v) ||
    v.length !== 2 ||
    v.some(
      (row) =>
        !Array.isArray(row) ||
        row.length !== 3 ||
        row.some((n) => typeof n !== "number" || !Number.isFinite(n)),
    )
  )
    throw new Error("Missing/invalid sceneTransform");
  return v as Matrix;
};
const svgMatrix = (m: Matrix) =>
  `matrix(${m[0][0]} ${m[1][0]} ${m[0][1]} ${m[1][1]} ${m[0][2]} ${m[1][2]})`;
export const escape = (v: unknown): string =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const num = (v: unknown, fallback = 0) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const list = (v: unknown) => (Array.isArray(v) ? v : []);
const cssName = (v: unknown) =>
  String(v ?? "").replace(/[^\p{L}\p{N} _-]/gu, "");
const rgb = (v: unknown) => {
  const c = obj(v);
  return `rgb(${Math.round(num(c.r) * 255)},${Math.round(num(c.g) * 255)},${Math.round(num(c.b) * 255)})`;
};
const rgba = (v: unknown) => {
  const c = obj(v);
  return `rgba(${Math.round(num(c.r) * 255)},${Math.round(num(c.g) * 255)},${Math.round(num(c.b) * 255)},${num(c.a, 1)})`;
};
export interface RenderStats {
  structuredNodes: number;
  svgFallbacks: string[];
  rasterFallbacks: string[];
  warnings: string[];
  fonts: {
    alias: string;
    family: string;
    style: string;
    size: number;
    weight: number;
  }[];
}
interface RenderNode {
  figmaNodeId: string;
  type: string;
  sceneTransform: unknown;
  properties: Record<string, unknown>;
  children: RenderNode[];
  text?: Record<string, unknown>;
  svgAssetId?: string;
  fallbackAssetId?: string;
}
export async function buildSceneSvg(
  scene: Scene,
  assets: Asset[],
  readAsset: (asset: Asset) => Promise<Uint8Array>,
  options: { motion?: boolean } = {},
): Promise<{ svg: string; stats: RenderStats; fontCss: string }> {
  const stats: RenderStats = {
    structuredNodes: 0,
    svgFallbacks: [],
    rasterFallbacks: [],
    warnings: [],
    fonts: [],
  };
  const definitions: string[] = [];
  const assetMap = new Map(assets.map((a) => [a.assetId, a]));
  const cache = new Map<string, string>();
  let counter = 0;
  const warn = (node: RenderNode, text: string) =>
    stats.warnings.push(`${node.figmaNodeId}: ${text}`);
  const uri = async (id: string): Promise<string> => {
    if (cache.has(id)) return cache.get(id)!;
    const asset = assetMap.get(id);
    if (!asset) throw new Error(`Missing asset: ${id}`);
    if (asset.path.startsWith("previews/") || asset.path === scene.preview)
      throw new Error("Previews cannot be renderer inputs");
    const bytes = await readAsset(asset);
    const ext = path.extname(asset.path);
    const mime = (
      {
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
      } as Record<string, string>
    )[ext];
    if (!mime) throw new Error(`Unsupported image format: ${asset.path}`);
    const result = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
    cache.set(id, result);
    return result;
  };
  function shape(node: RenderNode, attributes: string): string {
    const p = node.properties,
      w = num(p.width, scene.width),
      h = num(p.height, scene.height);
    if (node.type === "ELLIPSE")
      return `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" ${attributes}/>`;
    if (node.type === "LINE")
      return `<line x1="0" y1="0" x2="${w}" y2="${h}" ${attributes}/>`;
    const paths = list(p.vectorPaths).length
      ? list(p.vectorPaths)
      : list(p.fillGeometry);
    if (paths.length)
      return paths
        .map((v) => {
          const item = obj(v);
          return `<path d="${escape(item.data)}" fill-rule="${item.windingRule === "EVENODD" ? "evenodd" : "nonzero"}" ${attributes}/>`;
        })
        .join("");
    const radius = Math.min(w / 2, h / 2, num(p.cornerRadius));
    const corners = [
      "topLeftRadius",
      "topRightRadius",
      "bottomRightRadius",
      "bottomLeftRadius",
    ].map((k) => Math.min(w / 2, h / 2, num(p[k], radius)));
    const [tl, tr, br, bl] = corners;
    if (corners.some((r) => r > 0))
      return `<path d="M ${tl} 0 H ${w - tr} A ${tr} ${tr} 0 0 1 ${w} ${tr} V ${h - br} A ${br} ${br} 0 0 1 ${w - br} ${h} H ${bl} A ${bl} ${bl} 0 0 1 0 ${h - bl} V ${tl} A ${tl} ${tl} 0 0 1 ${tl} 0 Z" ${attributes}/>`;
    return `<rect width="${w}" height="${h}" ${attributes}/>`;
  }
  function brush(paint: Record<string, unknown>, node: RenderNode): string {
    if (paint.type === "SOLID") return rgb(paint.color);
    if (paint.type === "GRADIENT_LINEAR" || paint.type === "GRADIENT_RADIAL") {
      const id = `gradient-${++counter}`;
      const p = node.properties;
      const transformed = multiply(
        [
          [num(p.width, scene.width), 0, 0],
          [0, num(p.height, scene.height), 0],
        ],
        inverse(matrix(paint.gradientTransform)),
      );
      const stops = list(paint.gradientStops)
        .map((v) => {
          const s = obj(v);
          return `<stop offset="${num(s.position)}" stop-color="${rgb(s.color)}" stop-opacity="${num(obj(s.color).a, 1)}"/>`;
        })
        .join("");
      definitions.push(
        paint.type === "GRADIENT_LINEAR"
          ? `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0.5" x2="1" y2="0.5" gradientTransform="${svgMatrix(transformed)}">${stops}</linearGradient>`
          : `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0.5" cy="0.5" r="0.5" gradientTransform="${svgMatrix(transformed)}">${stops}</radialGradient>`,
      );
      return `url(#${id})`;
    }
    warn(node, `Unsupported paint ${String(paint.type)}`);
    return "none";
  }
  async function paints(node: RenderNode): Promise<string> {
    const p = node.properties,
      w = num(p.width, scene.width),
      h = num(p.height, scene.height);
    let result = "";
    for (const item of list(p.fills)) {
      const paint = obj(item);
      if (paint.visible === false) continue;
      const opacity = num(paint.opacity, 1) * num(obj(paint.color).a, 1);
      if (paint.type === "IMAGE") {
        if (typeof paint.assetId !== "string") {
          warn(node, "Original image unavailable");
          continue;
        }
        const id = `image-clip-${++counter}`;
        definitions.push(
          `<clipPath id="${id}">${shape(node, 'fill="white"')}</clipPath>`,
        );
        let transform = "";
        let ratio =
          paint.scaleMode === "FIT" ? "xMidYMid meet" : "xMidYMid slice";
        if (paint.scaleMode === "CROP") {
          const normalized = inverse(matrix(paint.imageTransform));
          transform = ` transform="${svgMatrix(
            multiply(
              multiply(
                [
                  [w, 0, 0],
                  [0, h, 0],
                ],
                normalized,
              ),
              [
                [1 / w, 0, 0],
                [0, 1 / h, 0],
              ],
            ),
          )}"`;
          ratio = "none";
          warn(
            node,
            "CROP reconstructed using normalized transform; requires visual comparison.",
          );
        }
        if (paint.scaleMode === "TILE")
          warn(node, "TILE currently approximated as FILL.");
        if (num(paint.rotation) !== 0)
          warn(node, "Image paint rotation is not implemented.");
        if (Object.values(obj(paint.filters)).some((v) => num(v) !== 0))
          warn(node, "Image color filters are not implemented.");
        result += `<g clip-path="url(#${id})"><image width="${w}" height="${h}" preserveAspectRatio="${ratio}" href="${await uri(paint.assetId)}" opacity="${opacity}"${transform}/></g>`;
      } else
        result += shape(
          node,
          `fill="${brush(paint, node)}" opacity="${opacity}"`,
        );
    }
    for (const item of list(p.strokes)) {
      const paint = obj(item);
      if (paint.visible === false) continue;
      const color = brush(paint, node);
      const geometry = list(p.strokeGeometry);
      const trimAttributes =
        options.motion &&
        pathCapability(node.type, p, "browser-compat").supported
          ? ` data-motion-trim="true" data-motion-stroke-width="${num(p.strokeWeight, 1)}" data-motion-stroke-cap="${p.strokeCap === "ROUND" ? "round" : p.strokeCap === "SQUARE" ? "square" : "butt"}" data-motion-stroke-miterlimit="${num(p.strokeMiterLimit, 4)}" data-motion-stroke-join="${p.strokeJoin === "ROUND" ? "round" : p.strokeJoin === "BEVEL" ? "bevel" : "miter"}"${geometry.length ? ` data-motion-centerline="${escape(node.type === "LINE" ? `M0 0 L${w} ${h}` : obj(list(p.vectorPaths)[0]).data)}"` : ""}`
          : "";

      if (geometry.length)
        result += geometry
          .map(
            (v) =>
              `<path${trimAttributes} d="${escape(obj(v).data)}" fill="${color}" fill-rule="${obj(v).windingRule === "EVENODD" ? "evenodd" : "nonzero"}" opacity="${num(paint.opacity, 1)}"/>`,
          )
          .join("");
      else {
        if (p.strokeAlign && p.strokeAlign !== "CENTER")
          warn(node, "Stroke alignment approximated as CENTER.");
        result += shape(
          node,
          `${trimAttributes} fill="none" stroke="${color}" stroke-width="${num(p.strokeWeight, 1)}" stroke-linecap="${String(p.strokeCap ?? "BUTT").toLowerCase() === "round" ? "round" : p.strokeCap === "SQUARE" ? "square" : "butt"}" stroke-linejoin="${p.strokeJoin === "ROUND" ? "round" : p.strokeJoin === "BEVEL" ? "bevel" : "miter"}" stroke-miterlimit="${num(p.strokeMiterLimit, 4)}" stroke-dasharray="${list(
            p.dashPattern,
          )
            .map((v) => num(v))
            .join(" ")}" opacity="${num(paint.opacity, 1)}"`,
        );
      }
    }
    return result;
  }
  function text(node: RenderNode): string {
    const t = node.text ?? {},
      p = node.properties,
      w = num(p.width),
      h = num(p.height);
    const characters = String(t.characters ?? p.characters ?? "");
    const segments = list(t.segments).length
      ? list(t.segments).map(obj)
      : [
          {
            ...t,
            characters,
            start: 0,
            end: characters.length,
            fills: p.fills,
          },
        ];
    function style(segment: Record<string, unknown>): string {
      const font = obj(segment.fontName),
        family = cssName(font.family) || "Arial",
        fontStyle = cssName(font.style) || "Regular",
        weight = num(
          segment.fontWeight,
          fontStyle.toLowerCase().includes("bold") ? 700 : 400,
        ),
        size = num(segment.fontSize, num(t.fontSize, 16));
      let spec = stats.fonts.find(
        (f) =>
          f.family === family && f.style === fontStyle && f.weight === weight,
      );
      if (!spec) {
        spec = {
          alias: `motion-font-${stats.fonts.length}`,
          family,
          style: fontStyle,
          size,
          weight,
        };
        stats.fonts.push(spec);
      }
      const line = obj(segment.lineHeight ?? t.lineHeight),
        spacing = obj(segment.letterSpacing ?? t.letterSpacing);
      const visiblePaint = list(segment.fills ?? p.fills)
        .map(obj)
        .find((v) => v.visible !== false);
      if (visiblePaint && visiblePaint.type !== "SOLID")
        warn(node, "Text paint approximated; only solid text fills supported.");
      return `font-family:'${spec.alias}','${family}',Arial,sans-serif;font-size:${size}px;font-weight:${weight};font-style:${fontStyle.toLowerCase().includes("italic") ? "italic" : "normal"};line-height:${line.unit === "PIXELS" ? num(line.value) + "px" : line.unit === "PERCENT" ? num(line.value, 100) / 100 : "normal"};letter-spacing:${spacing.unit === "PERCENT" ? (num(spacing.value) * size) / 100 : num(spacing.value)}px;color:${visiblePaint ? rgba({ ...obj(visiblePaint.color), a: num(visiblePaint.opacity, 1) * num(obj(visiblePaint.color).a, 1) }) : "black"};text-decoration:${segment.textDecoration === "UNDERLINE" ? "underline" : segment.textDecoration === "STRIKETHROUGH" ? "line-through" : "none"};text-transform:${segment.textCase === "UPPER" ? "uppercase" : segment.textCase === "LOWER" ? "lowercase" : segment.textCase === "TITLE" ? "capitalize" : "none"}`;
    }
    // Split explicit paragraphs while retaining UTF-16 styled ranges and natural wrapping.
    let position = 0;
    const paragraphs = characters
      .split("\n")
      .map((paragraph, i, all) => {
        const start = position,
          end = start + paragraph.length;
        position = end + 1;
        const spans =
          segments
            .map((s) => {
              const a = Math.max(start, num(s.start)),
                b = Math.min(end, num(s.end, characters.length));
              return b > a
                ? `<span data-text-start="${a}" style="${escape(style(s))}">${escape(characters.slice(a, b))}</span>`
                : "";
            })
            .join("") || "<br/>";
        return `<div style="margin-bottom:${i < all.length - 1 ? num(t.paragraphSpacing) : 0}px">${spans}</div>`;
      })
      .join("");
    return `<foreignObject data-text-geometry="true" data-text-source="${escape(characters)}" width="${w}" height="${h}" overflow="visible"><div xmlns="http://www.w3.org/1999/xhtml" style="${options.motion ? "will-change:transform,opacity;opacity:1;transform:translate3d(0,0,0);transform-origin:0 0;" : ""}overflow:visible;width:${w}px;min-height:${h}px;display:flex;flex-direction:column;justify-content:${t.textAlignVertical === "CENTER" ? "center" : t.textAlignVertical === "BOTTOM" ? "flex-end" : "flex-start"};white-space:pre-wrap;overflow-wrap:normal;text-align:${t.textAlignHorizontal === "CENTER" ? "center" : t.textAlignHorizontal === "RIGHT" ? "right" : t.textAlignHorizontal === "JUSTIFIED" ? "justify" : "left"}"><div style="overflow:visible">${paragraphs}</div></div></foreignObject>`;
  }
  async function children(node: RenderNode): Promise<string> {
    let result = "",
      activeMask: string | undefined;
    const ordered: { child: RenderNode; mask?: string }[] = [];
    for (const child of node.children ?? []) {
      if (
        child.properties?.visible === false &&
        (!options.motion || child.properties?.isMask)
      )
        continue;
      if (child.properties?.isMask === true) {
        const id = `mask-${++counter}`;
        const local = multiply(
          inverse(matrix(node.sceneTransform)),
          matrix(child.sceneTransform),
        );
        const maskType = child.properties.maskType;
        let content =
          maskType === "VECTOR"
            ? shape(child, 'fill="white"')
            : await paints(child);
        if (!content) content = shape(child, 'fill="white"');
        definitions.push(
          `<mask id="${id}" maskUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000" style="mask-type:${maskType === "LUMINANCE" ? "luminance" : "alpha"}"><g transform="${svgMatrix(local)}" opacity="${num(child.properties.opacity, 1)}">${content}</g></mask>`,
        );
        activeMask = id;
        stats.structuredNodes++;
        continue;
      }
      ordered.push({ child, mask: activeMask });
    }
    // Mask scope follows source sibling order; Auto Layout reverses painting, not scope.
    if (node.properties?.itemReverseZIndex === true) ordered.reverse();
    for (const { child, mask } of ordered) {
      const content = await render(child, matrix(node.sceneTransform));
      result += mask ? `<g mask="url(#${mask})">${content}</g>` : content;
    }
    return result;
  }
  async function render(node: RenderNode, parent: Matrix): Promise<string> {
    const p = node.properties ?? {};
    node.properties = p;
    if (p.visible === false && !options.motion) return "";
    const transform = multiply(inverse(parent), matrix(node.sceneTransform));
    let body = "";
    if (node.type === "TEXT") body = text(node);
    else if (
      ["VECTOR", "POLYGON", "STAR", "BOOLEAN_OPERATION"].includes(node.type) &&
      (obj(p.fills).mixed === true ||
        (!list(p.vectorPaths).length && !list(p.fillGeometry).length)) &&
      node.svgAssetId
    ) {
      body = `<image width="${num(p.width)}" height="${num(p.height)}" href="${await uri(node.svgAssetId)}"/>`;
      stats.svgFallbacks.push(node.figmaNodeId);
      warn(
        node,
        obj(p.fills).mixed === true
          ? "Mixed vector paints rendered from exported SVG asset."
          : "Path geometry unavailable; rendered from exported SVG asset.",
      );
      if (
        Math.abs(matrix(node.sceneTransform)[0][1]) > 1e-8 ||
        Math.abs(matrix(node.sceneTransform)[1][0]) > 1e-8
      )
        warn(
          node,
          "Rotated SVG fallback export bounds may differ; inspect visually.",
        );
    } else {
      body = await paints(node);
      if (
        ![
          "FRAME",
          "GROUP",
          "INSTANCE",
          "COMPONENT",
          "RECTANGLE",
          "ELLIPSE",
          "LINE",
          "VECTOR",
          "POLYGON",
          "STAR",
          "BOOLEAN_OPERATION",
        ].includes(node.type)
      ) {
        const id = node.svgAssetId ?? node.fallbackAssetId;
        if (id) {
          body = `<image width="${num(p.width)}" height="${num(p.height)}" href="${await uri(id)}"/>`;
          (node.svgAssetId ? stats.svgFallbacks : stats.rasterFallbacks).push(
            node.figmaNodeId,
          );
        }
        warn(node, `Unsupported node ${node.type}; fallback when available.`);
      }
    }
    stats.structuredNodes++;
    body += await children(node);
    let clip = "";
    if (p.clipsContent === true) {
      const id = `frame-clip-${++counter}`;
      definitions.push(
        `<clipPath id="${id}">${shape({ ...node, type: "RECTANGLE" }, 'fill="white"')}</clipPath>`,
      );
      clip = ` clip-path="url(#${id})"`;
    }
    let filter = "";
    for (const e of list(p.effects).map(obj)) {
      if (e.visible === false) continue;
      if (e.type === "DROP_SHADOW") {
        const offset = obj(e.offset);
        filter += `drop-shadow(${num(offset.x)}px ${num(offset.y)}px ${num(e.radius) / 2}px ${rgba(e.color)}) `;
        if (num(e.spread) !== 0) warn(node, "Shadow spread not implemented.");
      } else warn(node, `Effect ${String(e.type)} not implemented.`);
    }
    if (num(p.cornerSmoothing) !== 0)
      warn(node, "Corner smoothing not implemented.");
    if (
      node.type === "ELLIPSE" &&
      obj(p.arcData).endingAngle !== undefined &&
      num(obj(p.arcData).endingAngle) !== Math.PI * 2
    )
      warn(node, "Partial ellipse arc approximated as full ellipse.");
    const blend = String(p.blendMode ?? "NORMAL")
      .toLowerCase()
      .replaceAll("_", "-");
    const allowed = [
      "multiply",
      "screen",
      "overlay",
      "darken",
      "lighten",
      "color-dodge",
      "color-burn",
      "hard-light",
      "soft-light",
      "difference",
      "exclusion",
      "hue",
      "saturation",
      "color",
      "luminosity",
    ];
    const rendered = `<g data-node-id="${escape(node.figmaNodeId)}" transform="${svgMatrix(transform)}" opacity="${num(p.opacity, 1)}" style="${filter ? `filter:${filter};` : ""}${allowed.includes(blend) ? `mix-blend-mode:${blend};` : ""}"><g${clip}${clip ? ' data-clip-reason="source"' : ""}>${body}</g></g>`;
    if (!options.motion) return rendered;
    const motionBody = rendered;
    return `<g data-motion-target="${escape(node.figmaNodeId)}" data-origin-x="${transform[0][2]}" data-origin-y="${transform[1][2]}" data-center-x="${transform[0][2]+transform[0][0]*num(p.width)/2+transform[0][1]*num(p.height)/2}" data-center-y="${transform[1][2]+transform[1][0]*num(p.width)/2+transform[1][1]*num(p.height)/2}" data-base-visible="${p.visible !== false}">${motionBody}</g>`;
  }
  const body = await render(scene as unknown as RenderNode, unit);
  const fontCss = stats.fonts
    .map(
      (f) =>
        `@font-face{font-family:'${f.alias}';src:local('${f.family} ${f.style}'),local('${f.family.replaceAll(" ", "")}-${f.style.replaceAll(" ", "")}');font-weight:${f.weight};font-style:${f.style.toLowerCase().includes("italic") ? "italic" : "normal"};font-display:block}`,
    )
    .join("");
  stats.warnings = [...new Set(stats.warnings)];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}" data-clip-reason="scene"><defs>${definitions.join("")}</defs>${body}</svg>`;
  return { svg, stats, fontCss };
}
export function sceneFileId(sceneId: string): string {
  return Buffer.from(sceneId).toString("hex");
}
export async function reconstructProject(
  project: LoadedProject,
  output: string,
): Promise<
  Map<string, { png: string; html: string; stats: RenderStats; error?: string }>
> {
  if (renderingMode() === "native")
    return reconstructNativeProject(project, output);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    throw new Error(
      `Renderer browser unavailable. Run: node node_modules/playwright/cli.js install chromium. ${String(error)}`,
    );
  }
  const results = new Map<
    string,
    { png: string; html: string; stats: RenderStats; error?: string }
  >();
  try {
    for (const scene of project.inspection.document.scenes) {
      try {
        if (scene.width > 16384 || scene.height > 16384)
          throw new Error(
            `Scene ${scene.sceneId} exceeds 16384px render limit`,
          );
        const built = await buildSceneSvg(
          scene,
          project.inspection.document.assets,
          (asset) =>
            readFile(within(path.dirname(project.scenePath), asset.path)),
        );
        const fileId = sceneFileId(scene.sceneId);
        const html = `<!doctype html><html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}${built.fontCss}</style><body>${built.svg}</body></html>`;
        const htmlRelative = `reconstructed/${fileId}.html`,
          pngRelative = `reconstructed/${fileId}.png`;
        await writeFile(path.join(output, htmlRelative), html);
        const page = await browser.newPage({
          viewport: {
            width: Math.ceil(scene.width),
            height: Math.ceil(scene.height),
          },
          deviceScaleFactor: 1,
        });
        try {
          const errors: string[] = [];
          page.on("pageerror", (e) => errors.push(e.message));
          await page.route("**/*", (route) =>
            route.request().url().startsWith("file:") ||
            route.request().url().startsWith("data:")
              ? route.continue()
              : route.abort(),
          );
          await page.goto(pathToFileURL(path.join(output, htmlRelative)).href, {
            waitUntil: "load",
          });
          const missing = await page.evaluate(async (fonts) => {
            const missing: string[] = [];
            for (const font of fonts) {
              try {
                const loaded = await document.fonts.load(
                  `${font.weight} ${font.size}px "${font.alias}"`,
                );
                if (!loaded.length)
                  missing.push(`${font.family} ${font.style}`);
              } catch {
                missing.push(`${font.family} ${font.style}`);
              }
            }
            await document.fonts.ready;
            return missing;
          }, built.stats.fonts);
          for (const font of missing)
            built.stats.warnings.push(
              `Font unavailable locally: ${font}. Browser fallback used.`,
            );
          if (errors.length) throw new Error(errors.join("; "));
          // Wait for SVG image resources as well as fonts before capturing pixels.
          const imageProblems = await page.evaluate(async () => {
            const images = Array.from(document.querySelectorAll("svg image"));
            const errors: string[] = [];
            await Promise.all(
              images.map(async (element) => {
                const source = element.getAttribute("href");
                if (!source) return;
                const image = new Image();
                image.src = source;
                try {
                  await image.decode();
                } catch {
                  errors.push("An asset image could not be decoded");
                }
              }),
            );
            return errors;
          });
          if (imageProblems.length) throw new Error(imageProblems.join("; "));
          await page.screenshot({
            path: path.join(output, pngRelative),
            omitBackground: true,
          });
          results.set(scene.sceneId, {
            png: pngRelative,
            html: htmlRelative,
            stats: built.stats,
          });
        } finally {
          await page.close();
        }
      } catch (error) {
        const fileId = sceneFileId(scene.sceneId);
        await Promise.all(
          [`${fileId}.png`, `${fileId}.html`].map((name) =>
            rm(path.join(output, "reconstructed", name), { force: true }),
          ),
        );
        results.set(scene.sceneId, {
          png: "",
          html: "",
          stats: {
            structuredNodes: 0,
            svgFallbacks: [],
            rasterFallbacks: [],
            warnings: [],
            fonts: [],
          },
          error: String(error),
        });
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}
