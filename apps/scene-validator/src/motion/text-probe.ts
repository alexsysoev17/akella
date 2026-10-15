import { placeTextUnit } from "./text-animation.js";
import type { TextUnit } from "./text-layout.js";
const ns = "http://www.w3.org/2000/svg";
let active:
  | {
      svg: SVGSVGElement;
      unit: Parameters<typeof placeTextUnit>[0];
      background: string;
      htmlBackground: string;
      canvas: HTMLElement | null;
      visibility: string;
      legacy: boolean;
    }
  | undefined;
/** Controlled local render-transport probe. Never edits source geometry or project state. */
export function textRenderProbe(
  action: "start" | "offset" | "stop",
  options: {
    targetId?: string;
    sceneId?: string;
    unitIndex?: number;
    y?: number;
    legacy?: boolean;
  } = {},
) {
  if (action === "stop") {
    if (active) {
      active.svg.remove();
      document.body.style.background = active.background;
      document.documentElement.style.background = active.htmlBackground;
      if (active.canvas) active.canvas.style.visibility = active.visibility;
      active = undefined;
    }
    return null;
  }
  if (action === "start") {
    textRenderProbe("stop");
    const node = [
      ...document.querySelectorAll<SVGGElement>("[data-motion-target]"),
    ].find(
      (n) =>
        n.getAttribute("data-motion-target") === options.targetId &&
        n.closest<HTMLElement>("[data-motion-scene]")?.dataset.motionScene ===
          options.sceneId,
    );
    const original = node?.querySelectorAll<SVGGElement>(
      "[data-text-unit-bounds]",
    )[options.unitIndex ?? 0];
    if (!original) return null;
    const bounds = JSON.parse(
      original.getAttribute("data-text-unit-bounds")!,
    ) as TextUnit;
    const svg = document.createElementNS(ns, "svg"),
      clip = document.createElementNS(ns, "clipPath"),
      rect = document.createElementNS(ns, "rect");
    const width = Math.ceil(bounds.width) + 18,
      height = Math.ceil(bounds.height) + 18;
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute(
      "viewBox",
      `${Math.floor(bounds.x) - 8} ${Math.floor(bounds.y) - 8} ${width} ${height}`,
    );
    svg.style.cssText =
      "position:fixed;left:0;top:0;z-index:2147483647;visibility:visible;background:transparent";
    clip.id = "akella-text-raster-probe";
    clip.setAttribute("clipPathUnits", "userSpaceOnUse");
    for (const k of ["x", "y", "width", "height"] as const)
      rect.setAttribute(k, String(bounds[k]));
    clip.append(rect);
    const mover = original.cloneNode(true) as SVGGElement;
    mover.removeAttribute("data-text-unit-bounds");
    mover
      .querySelector("[clip-path]")!
      .setAttribute("clip-path", `url(#${clip.id})`);
    svg.append(clip, mover);
    const canvas = document.getElementById("canvas");
    active = {
      svg,
      unit: { mover, sliceRect: rect, bounds },
      background: document.body.style.background,
      htmlBackground: document.documentElement.style.background,
      canvas,
      visibility: canvas?.style.visibility ?? "",
      legacy:
        options.legacy ?? original.dataset.textRenderer !== "html-compositor",
    };
    if (canvas) canvas.style.visibility = "hidden";
    document.body.style.background = "transparent";
    document.documentElement.style.background = "transparent";
    document.body.append(svg);
    textRenderProbe("offset", { y: 0 });
    return {
      width,
      height,
      source:
        "actual cloned text render plane; alpha-centroid local transport probe",
      renderer: active.legacy ? "legacy-svg-transform" : "html-compositor",
    };
  }
  if (!active) return null;
  if (active.legacy) {
    const { mover, sliceRect, bounds } = active.unit;
    const html = mover.querySelector("foreignObject")!
      .firstElementChild as HTMLElement;
    html.style.transform = "none";
    html.style.willChange = "auto";
    html.style.opacity = "1";
    mover.setAttribute("transform", `translate(0 ${options.y ?? 0})`);
    mover.setAttribute("opacity", "1");
    sliceRect.setAttribute("x", String(bounds.x));
    sliceRect.setAttribute("y", String(bounds.y));
  } else placeTextUnit(active.unit, { x: 0, y: options.y ?? 0, opacity: 1 });
  return null;
}
