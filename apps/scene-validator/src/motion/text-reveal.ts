const ns = "http://www.w3.org/2000/svg";
let sequence = 0;
const entries = new WeakMap<
  SVGGElement,
  {
    wrapper: SVGGElement;
    clip: SVGClipPathElement;
    rect: SVGRectElement;
    x: number;
    y: number;
    width: number;
    height: number;
  }
>();
/** Explicit text reveal only. Position/Fade never call this. Source masks and geometry stay inside the wrapper. */
export function textReveal(
  node: SVGGElement,
  progress: number | undefined,
  direction: "forward" | "reverse" | "leftToRight" | "rightToLeft" = "forward",
) {
  let e = entries.get(node);
  if (progress === undefined) {
    if (e) {
      e.wrapper.replaceWith(...e.wrapper.childNodes);
      e.clip.remove();
      entries.delete(node);
    }
    return;
  }
  if (!e) {
    if (!node.getClientRects().length || !node.getScreenCTM()) return;
    const box = node.getBBox(),
      ctm = node.getScreenCTM()!,
      inverse = new DOMMatrix([
        ctm.a,
        ctm.b,
        ctm.c,
        ctm.d,
        ctm.e,
        ctm.f,
      ]).inverse();
    let x = box.x,
      y = box.y,
      right = x + box.width,
      bottom = y + box.height;
    // HTML line boxes include font ascent/descent even when Figma's text frame is shorter.
    for (const span of node.querySelectorAll("foreignObject span"))
      for (const r of span.getClientRects())
        for (const [sx, sy] of [
          [r.left, r.top],
          [r.right, r.bottom],
          [r.right, r.top],
          [r.left, r.bottom],
        ]) {
          const p = new DOMPoint(sx, sy).matrixTransform(inverse);
          x = Math.min(x, p.x);
          y = Math.min(y, p.y);
          right = Math.max(right, p.x);
          bottom = Math.max(bottom, p.y);
        }
    if (right <= x || bottom <= y) return;
    const clip = document.createElementNS(ns, "clipPath"),
      rect = document.createElementNS(ns, "rect"),
      wrapper = document.createElementNS(ns, "g");
    clip.id = "motion-text-reveal-" + ++sequence;
    clip.setAttribute("clipPathUnits", "userSpaceOnUse");
    clip.append(rect);
    wrapper.setAttribute("data-motion-effect-mask", "textReveal");
    wrapper.append(...node.childNodes);
    node.append(clip, wrapper);
    e = { wrapper, clip, rect, x, y, width: right - x, height: bottom - y };
    entries.set(node, e);
  }
  progress = Math.max(0, Math.min(1, progress));
  const horizontal = direction === "leftToRight" || direction === "rightToLeft",
    width = horizontal ? e.width * progress : e.width,
    height = horizontal ? e.height : e.height * progress;
  e.rect.setAttribute(
    "x",
    String(direction === "rightToLeft" ? e.x + e.width - width : e.x),
  );
  e.rect.setAttribute(
    "y",
    String(direction === "forward" ? e.y + e.height - height : e.y),
  );
  e.rect.setAttribute("width", String(width));
  e.rect.setAttribute("height", String(height));
  if (progress >= 1) e.wrapper.removeAttribute("clip-path");
  else e.wrapper.setAttribute("clip-path", `url(#${e.clip.id})`);
}
