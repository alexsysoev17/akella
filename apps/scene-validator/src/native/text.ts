import type {
  CanvasKit,
  Canvas,
  Paragraph,
  TextStyle,
  SkPicture,
  Image,
} from "canvaskit-wasm";
import type { FontResources } from "./fonts.js";
import {
  record,
  number,
  list,
  NativeRenderError,
  makeSurface,
} from "./skia.js";
import type { ShapeNode } from "./paths.js";
export interface TextUnit {
  start: number;
  end: number;
  x: number;
  y: number;
  width: number;
  height: number;
  paragraph: number;
}
export interface NativeText {
  text: string;
  paragraphs: { paragraph: Paragraph; y: number; start: number; end: number }[];
  lines: TextUnit[];
  words: TextUnit[];
  characters: TextUnit[];
  paragraphUnits: TextUnit[];
  height: number;
  offsetY: number;
  warnings: string[];
  fontFamilies: string[];
  pictures: Map<string, SkPicture[]>;
  planes: Map<
    string,
    { image: Image; x: number; y: number; width: number; height: number }
  >;
  dispose(): void;
}
/** CanvasKit expects an Embind enum entity, never a numeric CSS weight. */
function nativeFontWeight(kit: CanvasKit, weight: number, warnings: string[]) {
  const values = [
    kit.FontWeight.Thin,
    kit.FontWeight.ExtraLight,
    kit.FontWeight.Light,
    kit.FontWeight.Normal,
    kit.FontWeight.Medium,
    kit.FontWeight.SemiBold,
    kit.FontWeight.Bold,
    kit.FontWeight.ExtraBold,
    kit.FontWeight.Black,
    kit.FontWeight.ExtraBlack,
  ];
  const resolved = values.reduce((a, b) =>
    Math.abs(b.value - weight) < Math.abs(a.value - weight) ? b : a,
  );
  if (resolved.value !== weight)
    warnings.push(
      `Font weight ${weight} mapped to supported Skia weight ${resolved.value}; variable axis fidelity requires review`,
    );
  return resolved;
}
export function makeText(
  kit: CanvasKit,
  resources: FontResources,
  node: ShapeNode & { text?: Record<string, unknown> },
): NativeText {
  const t = node.text ?? {},
    p = node.properties,
    text = String(t.characters ?? ""),
    w = number(p.width),
    h = number(p.height),
    warnings: string[] = [],
    families = new Set<string>();
  if (!Number.isFinite(w) || w <= 0)
    throw new NativeRenderError(
      "TEXT_BOX_INVALID",
      "Text requires a positive source width",
      node.figmaNodeId,
    );
  if (text.length > 16384)
    throw new NativeRenderError(
      "TEXT_LAYOUT_LIMIT",
      "Maximum 16384 UTF-16 source units",
      node.figmaNodeId,
    );
  if (number(t.paragraphIndent))
    (() => {
      throw new NativeRenderError(
        "TEXT_INDENT_UNSUPPORTED",
        "Use explicit compatibility renderer",
        node.figmaNodeId,
      );
    })();
  function style(v: Record<string, unknown>): TextStyle {
    const name = record(v.fontName ?? t.fontName),
      requested = String(name.family ?? "Arial"),
      label = String(name.style ?? "Regular"),
      size = number(v.fontSize, number(t.fontSize, 16)),
      line = record(v.lineHeight ?? t.lineHeight),
      space = record(v.letterSpacing ?? t.letterSpacing);
    let family = [...resources.families].find(
      (f) => f.toLowerCase() === requested.toLowerCase(),
    );
    if (!family) {
      family =
        ["Arial", "Helvetica", "DejaVu Sans", "Liberation Sans"].find((f) =>
          resources.families.has(f),
        ) ?? [...resources.families][0];
      warnings.push(
        `Missing font ${requested}; explicit fallback ${family}; Figma font fidelity NOT VERIFIED`,
      );
    }
    families.add(family);
    const fill = list(v.fills ?? p.fills).find((x) => x.visible !== false),
      color = record(fill?.color);
    if (fill && fill.type !== "SOLID")
      (() => {
        throw new NativeRenderError(
          "TEXT_PAINT_UNSUPPORTED",
          String(fill.type),
          node.figmaNodeId,
        );
      })();
    return {
      fontFamilies: [family],
      fontSize: size,
      fontStyle: {
        weight: nativeFontWeight(
          kit,
          number(
            v.fontWeight,
            number(t.fontWeight, /bold/i.test(label) ? 700 : 400),
          ),
          warnings,
        ),
        slant: /italic/i.test(label)
          ? kit.FontSlant.Italic
          : kit.FontSlant.Upright,
      },
      color: kit.Color4f(
        number(color.r),
        number(color.g),
        number(color.b),
        number(color.a, 1) * number(fill?.opacity, 1),
      ),
      heightMultiplier:
        line.unit === "PIXELS"
          ? number(line.value) / size
          : line.unit === "PERCENT"
            ? number(line.value, 100) / 100
            : undefined,
      halfLeading: true,
      letterSpacing:
        space.unit === "PERCENT"
          ? (number(space.value) * size) / 100
          : number(space.value),
      decoration:
        (v.textDecoration ?? t.textDecoration) === "UNDERLINE"
          ? kit.UnderlineDecoration
          : (v.textDecoration ?? t.textDecoration) === "STRIKETHROUGH"
            ? kit.LineThroughDecoration
            : 0,
    };
  }
  const base = style(t),
    segments = list(t.segments),
    paras: NativeText["paragraphs"] = [],
    lines: TextUnit[] = [],
    words: TextUnit[] = [],
    characters: TextUnit[] = [],
    paragraphUnits: TextUnit[] = [];
  let position = 0,
    y = 0;
  for (const [index, content] of text.split("\n").entries()) {
    const start = position,
      end = start + content.length;
    position = end + 1;
    const builder = kit.ParagraphBuilder.Make(
      new kit.ParagraphStyle({
        textStyle: base,
        textAlign:
          t.textAlignHorizontal === "CENTER"
            ? kit.TextAlign.Center
            : t.textAlignHorizontal === "RIGHT"
              ? kit.TextAlign.Right
              : t.textAlignHorizontal === "JUSTIFIED"
                ? kit.TextAlign.Justify
                : kit.TextAlign.Left,
        disableHinting: true,
        applyRoundingHack: false,
      }),
      resources.manager,
    );
    const boundaries = new Set([start, end]);
    for (const s of segments) {
      const a = Math.max(start, number(s.start)),
        b = Math.min(end, number(s.end, end));
      if (b > a) {
        boundaries.add(a);
        boundaries.add(b);
      }
    }
    const cuts = [...boundaries].sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i],
        b = cuts[i + 1],
        s =
          segments.find(
            (s) => number(s.start) <= a && number(s.end, text.length) >= b,
          ) ?? t;
      let value = text.slice(a, b);
      const casing = s.textCase ?? t.textCase;
      if (casing === "UPPER") value = value.toUpperCase();
      else if (casing === "LOWER") value = value.toLowerCase();
      else if (casing === "TITLE")
        value = value.replace(/\b\p{L}/gu, (v) => v.toUpperCase());
      if (value.length !== b - a)
        warnings.push(
          "Length-changing text case cannot preserve original segmentation indices",
        );
      const runStyle = style({ ...t, ...s }),
        foreground = new kit.Paint(),
        background = new kit.Paint();
      try {
        foreground.setAntiAlias(true);
        foreground.setColor(runStyle.color ?? kit.BLACK);
        background.setColor(kit.TRANSPARENT);
        builder.pushPaintStyle(
          new kit.TextStyle(runStyle),
          foreground,
          background,
        );
        builder.addText(value);
        builder.pop();
      } finally {
        foreground.delete();
        background.delete();
      }
    }
    if (!content) builder.addText("\u200b");
    const paragraph = builder.build();
    builder.delete();
    paragraph.layout(w);
    const height = paragraph.getHeight();
    paras.push({ paragraph, y, start, end });
    const bounds = (a: number, b: number): TextUnit[] =>
      paragraph
        .getRectsForRange(
          a - start,
          b - start,
          kit.RectHeightStyle.Tight,
          kit.RectWidthStyle.Tight,
        )
        .map((v) => ({
          start: a,
          end: b,
          x: v.rect[0],
          y: v.rect[1] + y,
          width: v.rect[2] - v.rect[0],
          height: v.rect[3] - v.rect[1],
          paragraph: index,
        }));
    for (const m of paragraph.getLineMetrics())
      lines.push({
        start: start + m.startIndex,
        end: Math.min(end, start + m.endExcludingWhitespaces),
        x: m.left,
        y: y + m.baseline - m.ascent,
        width: m.width,
        height: m.ascent + m.descent,
        paragraph: index,
      });
    for (const part of new Intl.Segmenter("und", {
      granularity: "word",
    }).segment(content))
      if (!/^\s+$/u.test(part.segment))
        words.push(
          ...bounds(
            start + part.index,
            start + part.index + part.segment.length,
          ),
        );
    for (const part of new Intl.Segmenter("und", {
      granularity: "grapheme",
    }).segment(content))
      if (!/^\s+$/u.test(part.segment))
        characters.push(
          ...bounds(
            start + part.index,
            start + part.index + part.segment.length,
          ),
        );
    paragraphUnits.push({
      start,
      end,
      x: 0,
      y,
      width: w,
      height,
      paragraph: index,
    });
    y +=
      height +
      (index < text.split("\n").length - 1 ? number(t.paragraphSpacing) : 0);
  }
  const offsetY =
    t.textAlignVertical === "CENTER"
      ? Math.max(0, (h - y) / 2)
      : t.textAlignVertical === "BOTTOM"
        ? Math.max(0, h - y)
        : 0;
  for (const set of [lines, words, characters, paragraphUnits])
    for (const u of set) u.y += offsetY;
  const pictures = new Map<string, SkPicture[]>(),
    planes: NativeText["planes"] = new Map();
  return {
    text,
    paragraphs: paras,
    lines,
    words,
    characters,
    paragraphUnits,
    height: y,
    offsetY,
    warnings: [...new Set(warnings)],
    fontFamilies: [...families],
    pictures,
    planes,
    dispose() {
      for (const p of paras) p.paragraph.delete();
      for (const set of pictures.values())
        for (const picture of set) picture.delete();
      pictures.clear();
      for (const plane of planes.values()) plane.image.delete();
      planes.clear();
    },
  };
}
export function drawText(kit: CanvasKit, canvas: Canvas, layout: NativeText) {
  for (const p of layout.paragraphs)
    canvas.drawParagraph(p.paragraph, 0, p.y + layout.offsetY);
}
/** Record shared shaped paragraph slices once. No HTML clones or per-frame layout. */
export function unitPictures(
  kit: CanvasKit,
  layout: NativeText,
  kind: "line" | "word" | "character" | "paragraph",
) {
  let pictures = layout.pictures.get(kind);
  if (pictures) return pictures;
  const units =
    kind === "line"
      ? layout.lines
      : kind === "word"
        ? layout.words
        : kind === "paragraph"
          ? layout.paragraphUnits
          : layout.characters;
  if (units.length > 512)
    throw new NativeRenderError(
      "TEXT_SEGMENT_LIMIT",
      "Maximum 512 native shaped units",
    );
  if (kind === "character" || kind === "word")
    layout.warnings.push(
      "Glyph cluster slicing may split cross-grapheme ligatures or connected scripts; shaping retained but independent cluster animation requires visual review",
    );
  pictures = units.map((u) => {
    const recorder = new kit.PictureRecorder(),
      canvas = recorder.beginRecording(
        kit.LTRBRect(u.x, u.y, u.x + u.width, u.y + u.height),
      );
    canvas.clipRect(
      kit.LTRBRect(u.x, u.y, u.x + u.width, u.y + u.height),
      kit.ClipOp.Intersect,
      true,
    );
    const p = layout.paragraphs[u.paragraph];
    canvas.drawParagraph(p.paragraph, 0, p.y + layout.offsetY);
    const pic = recorder.finishRecordingAsPicture();
    recorder.delete();
    return pic;
  });
  layout.pictures.set(kind, pictures);
  return pictures;
}

/** Ephemeral Skia glyph planes, not exported image substitutes. Layout/text remain editable.
 * SkParagraph CPU glyphs snap baselines; caching their native raster once and sampling
 * the glyph plane linearly preserves fractional movement without changing glyph shape.
 */
export function drawTextPlane(
  kit: CanvasKit,
  canvas: Canvas,
  layout: NativeText,
  key: string,
  bounds: { x: number; y: number; width: number; height: number },
  draw: (canvas: Canvas) => void,
  density = 2,
) {
  density = Math.max(1, Math.min(4, Math.ceil(density)));
  const cacheKey = key + ":" + density;
  let plane = layout.planes.get(cacheKey);
  if (!plane) {
    const pad = 2,
      x = Math.floor(bounds.x) - pad,
      y = Math.floor(bounds.y) - pad,
      width = Math.ceil(bounds.width) + 2 * pad,
      height = Math.ceil(bounds.height) + 2 * pad;
    const used = [...layout.planes.values()].reduce(
      (n, p) => n + p.image.width() * p.image.height() * 4,
      0,
    );
    if (used + width * height * density * density * 4 > 64 * 1024 * 1024)
      throw new NativeRenderError(
        "TEXT_GLYPH_CACHE_LIMIT",
        "Native glyph planes exceed 64MiB per text layout",
      );
    const surface = makeSurface(
      kit,
      Math.max(1, Math.ceil(width * density)),
      Math.max(1, Math.ceil(height * density)),
    );
    if (!surface) throw new NativeRenderError("TEXT_GLYPH_SURFACE_FAILED", key);
    try {
      const c = surface.getCanvas();
      c.clear(kit.TRANSPARENT);
      c.scale(density, density);
      c.translate(-x, -y);
      draw(c);
      surface.flush();
      plane = { image: surface.makeImageSnapshot(), x, y, width, height };
      layout.planes.set(cacheKey, plane);
    } finally {
      surface.dispose();
    }
  }
  const paint = new kit.Paint();
  paint.setAntiAlias(true);
  try {
    canvas.drawImageRectOptions(
      plane.image,
      kit.XYWHRect(0, 0, plane.image.width(), plane.image.height()),
      kit.XYWHRect(plane.x, plane.y, plane.width, plane.height),
      kit.FilterMode.Linear,
      kit.MipmapMode.None,
      paint,
    );
  } finally {
    paint.delete();
  }
}
export function drawStableText(
  kit: CanvasKit,
  canvas: Canvas,
  layout: NativeText,
  width: number,
  density = 2,
) {
  drawTextPlane(
    kit,
    canvas,
    layout,
    "block",
    {
      x: Math.min(0, ...layout.lines.map((u) => u.x)),
      y: Math.min(0, ...layout.lines.map((u) => u.y)),
      width: Math.max(width, ...layout.lines.map((u) => u.x + u.width)),
      height: layout.height + layout.offsetY,
    },
    (c) => drawText(kit, c, layout),
    density,
  );
}
