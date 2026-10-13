const ns = "http://www.w3.org/2000/svg";
let counter = 0;
interface RevealGeometry {
  mask: SVGMaskElement;
  wrapper: SVGGElement;
  reveal: SVGGeometryElement;
  length: number;
  forwardIsLeftToRight: boolean;
  start: DOMPoint;
  end: DOMPoint;
}
const masks = new WeakMap<SVGGeometryElement, RevealGeometry>();
/** An effect wrapper intersects with, rather than replaces, the source mask/clip.
 * Centerline and outline stay in the same local coordinates. Only the mask is animated. */
export function pathReveal(
  path: SVGGeometryElement,
  progress: number | undefined,
  direction:
    | boolean
    | "forward"
    | "reverse"
    | "leftToRight"
    | "rightToLeft" = false,
) {
  let entry = masks.get(path);
  if (progress === undefined) {
    if (entry) {
      entry.wrapper.replaceWith(path);
      entry.mask.remove();
      masks.delete(path);
    }
    return;
  }
  if (!entry) {
    const centerline = path.getAttribute("data-motion-centerline");
    if (centerline === "undefined" || centerline === "")
      throw new Error("Invalid source centerline");
    const source = centerline ? document.createElementNS(ns, "path") : path;
    if (centerline) source.setAttribute("d", centerline);
    if (((source.getAttribute("d") ?? "").match(/[Mm]/g)?.length ?? 0) > 1)
      throw new Error(
        "Compound subpaths require separate centerline paths; dash phase restarts at each subpath",
      );
    const length = source.getTotalLength();
    if (!Number.isFinite(length) || length <= 0)
      throw new Error("Path has no finite positive length");
    const style = getComputedStyle(path);
    const width =
      Number(path.getAttribute("data-motion-stroke-width")) ||
      parseFloat(style.strokeWidth) ||
      1;
    const cap =
      path.getAttribute("data-motion-stroke-cap") ||
      style.strokeLinecap ||
      "butt";
    const join =
      path.getAttribute("data-motion-stroke-join") ||
      style.strokeLinejoin ||
      "miter";
    const miter =
      Number(path.getAttribute("data-motion-stroke-miterlimit")) ||
      parseFloat(style.strokeMiterlimit) ||
      4;
    const mask = document.createElementNS(ns, "mask"),
      wrapper = document.createElementNS(ns, "g"),
      reveal = path.cloneNode(false) as SVGGeometryElement;
    mask.id = "motion-reveal-" + ++counter;
    mask.setAttribute("maskUnits", "userSpaceOnUse");
    mask.setAttribute("maskContentUnits", "userSpaceOnUse");
    mask.style.maskType = "alpha";
    // Scenes are initially display:none. getBBox() there returns zero in Chromium.
    // Measure source geometry once in an independent SVG viewport, never from its visibility state.
    const viewport = document.createElementNS(ns, "svg"),
      measurement = path.cloneNode(false) as SVGGeometryElement;
    viewport.style.cssText =
      "position:fixed;left:0;top:0;width:1px;height:1px;overflow:visible;visibility:hidden;pointer-events:none";
    for (const name of [
      "transform",
      "mask",
      "clip-path",
      "filter",
      "style",
      "id",
    ])
      measurement.removeAttribute(name);
    viewport.append(measurement);
    document.body.append(viewport);
    const box = measurement.getBBox();
    viewport.remove();
    // Filled outlines already include stroke extents; native stroke bounds need cap/join extents.
    const pad = centerline
      ? 0
      : (width / 2) *
        Math.max(
          join === "miter" ? miter : 1,
          cap === "square" ? Math.SQRT2 : 1,
        );
    const local = path.transform.baseVal.consolidate()?.matrix;
    const corners = [
      [box.x - pad, box.y - pad],
      [box.x + box.width + pad, box.y - pad],
      [box.x - pad, box.y + box.height + pad],
      [box.x + box.width + pad, box.y + box.height + pad],
    ].map(([x, y]) =>
      local
        ? {
            x: local.a * x + local.c * y + local.e,
            y: local.b * x + local.d * y + local.f,
          }
        : { x, y },
    );
    const x = Math.min(...corners.map((p) => p.x)),
      y = Math.min(...corners.map((p) => p.y));
    for (const [key, value] of Object.entries({
      x,
      y,
      width: Math.max(...corners.map((p) => p.x)) - x,
      height: Math.max(...corners.map((p) => p.y)) - y,
    }))
      mask.setAttribute(key, String(value));
    for (const name of [
      "id",
      "mask",
      "clip-path",
      "data-motion-trim",
      "pathLength",
      "style",
      "opacity",
      "stroke-opacity",
      "filter",
    ])
      reveal.removeAttribute(name);
    reveal.setAttribute("data-motion-reveal", "true");
    reveal.setAttribute("fill", "none");
    reveal.setAttribute("stroke", "white");
    reveal.setAttribute("stroke-width", String(width));
    reveal.setAttribute("stroke-linecap", cap);
    reveal.setAttribute("stroke-linejoin", join);
    reveal.setAttribute("stroke-miterlimit", String(miter));
    reveal.setAttribute("stroke-dasharray", `${length} ${length}`);
    if (centerline) reveal.setAttribute("d", centerline);
    mask.append(reveal);
    path.before(mask, wrapper);
    wrapper.append(path);
    wrapper.setAttribute("data-motion-effect-mask", "pathReveal");
    const start = source.getPointAtLength(0),
      end = source.getPointAtLength(length),
      ctm = path.getScreenCTM();
    entry = {
      mask,
      wrapper,
      reveal,
      length,
      start,
      end,
      forwardIsLeftToRight:
        (ctm ? ctm.a * end.x + ctm.c * end.y : end.x) >=
        (ctm ? ctm.a * start.x + ctm.c * start.y : start.x),
    };
    masks.set(path, entry);
  }
  // SVG local transforms remain available even when ancestor scenes are display:none.
  let ctm = new DOMMatrix();
  for (let parent: Element | null = path; parent; parent = parent.parentElement)
    if (parent instanceof SVGGraphicsElement) {
      const local = parent.transform.baseVal.consolidate()?.matrix;
      if (local)
        ctm = new DOMMatrix([
          local.a,
          local.b,
          local.c,
          local.d,
          local.e,
          local.f,
        ]).multiply(ctm);
    }
  entry.forwardIsLeftToRight =
    ctm.a * (entry.end.x - entry.start.x) +
      ctm.c * (entry.end.y - entry.start.y) >=
    0;
  progress = Math.max(0, Math.min(1, progress));
  const reverse =
    direction === true ||
    direction === "reverse" ||
    (direction === "leftToRight" && !entry.forwardIsLeftToRight) ||
    (direction === "rightToLeft" && entry.forwardIsLeftToRight);
  entry.reveal.setAttribute(
    "data-motion-reveal-direction",
    reverse ? "reverse" : "forward",
  );
  entry.reveal.setAttribute("data-motion-reveal-progress", String(progress));
  entry.reveal.setAttribute(
    "stroke-dashoffset",
    String((reverse ? -1 : 1) * (1 - progress) * entry.length),
  );
  entry.reveal.setAttribute("opacity", progress <= 0 ? "0" : "1");
  if (progress >= 1) entry.wrapper.removeAttribute("mask");
  else entry.wrapper.setAttribute("mask", `url(#${entry.mask.id})`);
}
