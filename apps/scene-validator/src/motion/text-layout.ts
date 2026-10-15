/** Snapshot the shaped source once, in an untransformed fixed-size SVG. No glyph-width summation. */
export type TextBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type TextUnit = TextBounds & {
  start: number;
  end: number;
  text: string;
  line: number;
};
export type TextLayout = {
  text: string;
  characters: TextUnit[];
  words: TextUnit[];
  lines: TextUnit[];
  explicitBreaks: number[];
  preparationMs: number;
  warnings: string[];
};
const ns = "http://www.w3.org/2000/svg";
export function snapshotText(source: SVGForeignObjectElement): TextLayout {
  const begin = performance.now(),
    text = source.getAttribute("data-text-source") ?? source.textContent ?? "";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", source.getAttribute("width") ?? "1");
  svg.setAttribute("height", source.getAttribute("height") ?? "1");
  svg.style.cssText =
    "position:fixed;left:0;top:0;opacity:0;pointer-events:none;overflow:visible;transform:none";
  const clone = source.cloneNode(true) as SVGForeignObjectElement;
  svg.append(clone);
  document.body.append(svg);
  try {
    const origin = svg.getBoundingClientRect();
    const spans = [...clone.querySelectorAll<HTMLElement>("[data-text-start]")];
    const units: TextUnit[] = [];
    const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
    for (const segment of segmenter.segment(text)) {
      const start = segment.index,
        end = start + segment.segment.length;
      if (/^[\r\n]+$/u.test(segment.segment)) continue;
      const rects: DOMRect[] = [];
      for (const span of spans) {
        const base = Number(span.dataset.textStart),
          leaf = span.firstChild;
        if (!leaf || leaf.nodeType !== Node.TEXT_NODE) continue;
        const a = Math.max(0, start - base),
          b = Math.min(leaf.textContent!.length, end - base);
        if (b <= a) continue;
        const range = document.createRange();
        range.setStart(leaf, a);
        range.setEnd(leaf, b);
        rects.push(...range.getClientRects());
      }
      if (!rects.length) continue;
      const x = Math.min(...rects.map((r) => r.left)) - origin.left,
        y = Math.min(...rects.map((r) => r.top)) - origin.top;
      units.push({
        start,
        end,
        text: segment.segment,
        x,
        y,
        width: Math.max(...rects.map((r) => r.right)) - origin.left - x,
        height: Math.max(...rects.map((r) => r.bottom)) - origin.top - y,
        line: 0,
      });
    }
    const lines: TextUnit[] = [];
    // Range top differs for mixed font sizes; overlapping vertical line boxes share a line.
    for (const unit of units) {
      let index = lines.findIndex(
        (l) =>
          Math.min(l.y + l.height, unit.y + unit.height) -
            Math.max(l.y, unit.y) >
            Math.min(l.height, unit.height) * 0.5 &&
          !text.slice(l.end, unit.start).includes("\n"),
      );
      if (index < 0) {
        index = lines.length;
        lines.push({ ...unit });
      } else lines[index] = union(lines[index], unit, text);
      lines[index].line = index;
      unit.line = index;
    }
    const words: TextUnit[] = [];
    for (const word of new Intl.Segmenter("und", {
      granularity: "word",
    }).segment(text)) {
      if (/^\s+$/u.test(word.segment)) continue;
      const members = units.filter(
        (u) =>
          u.start >= word.index && u.start < word.index + word.segment.length,
      );
      for (const line of new Set(members.map((u) => u.line))) {
        const group = members.filter((u) => u.line === line);
        if (group.length) words.push(group.reduce((a, b) => union(a, b, text)));
      }
    }
    return {
      text,
      characters: units.filter((u) => !/^\s+$/u.test(u.text)),
      words,
      lines,
      explicitBreaks: [...text.matchAll(/\n/g)].map((m) => m.index!),
      preparationMs: performance.now() - begin,
      warnings: [
        "Bounds are browser Range line boxes, not glyph outlines or exact baselines. Character clipping cannot guarantee independent ligature/complex-script glyph clusters.",
      ],
    };
  } finally {
    svg.remove();
  }
}
function union(a: TextUnit, b: TextUnit, text: string): TextUnit {
  const start = Math.min(a.start, b.start),
    end = Math.max(a.end, b.end),
    x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return {
    start,
    end,
    text: text.slice(start, end),
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
    line: a.line,
  };
}
