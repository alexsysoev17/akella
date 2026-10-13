import { chromium, type Page } from "playwright";
import { motionHtml } from "../presentation.js";
import type { LoadedProject } from "../../types.js";
import type { MotionState } from "../schema.js";
/** Developer diagnostics. Retains source ancestor clipping/masks; hides sibling paint, not definitions. */
export async function isolateObject(
  page: Page,
  sceneId: string,
  targetId: string,
) {
  return page.evaluate(
    ({ sceneId, targetId }) => {
      const target = [
        ...document.querySelectorAll<SVGGElement>("[data-motion-target]"),
      ].find(
        (e) =>
          e.getAttribute("data-motion-target") === targetId &&
          e
            .closest("[data-motion-scene]")
            ?.getAttribute("data-motion-scene") === sceneId,
      );
      if (!target) throw new Error("Isolated target not found");
      for (const el of [
        document.documentElement,
        document.body,
        document.getElementById("canvas")!,
      ])
        el.style.background = "transparent";
      const pending: Element[] = [document.getElementById("canvas")!];
      while (pending.length) {
        const branch = pending.pop()!;
        for (const child of [...branch.children]) {
          if (
            ["defs", "style", "script", "mask", "clipPath"].includes(
              child.localName,
            )
          )
            continue;
          if (child === target || target.contains(child)) continue;
          if (child.contains(target)) pending.push(child);
          else (child as HTMLElement).style.display = "none";
        }
      }
      return target.getBoundingClientRect().toJSON();
    },
    { sceneId, targetId },
  );
}
export async function inspectObject(
  page: Page,
  sceneId: string,
  targetId: string,
) {
  return page.evaluate(
    ({ sceneId, targetId }) => {
      const el = [
        ...document.querySelectorAll<SVGGElement>("[data-motion-target]"),
      ].find(
        (e) =>
          e.getAttribute("data-motion-target") === targetId &&
          e
            .closest("[data-motion-scene]")
            ?.getAttribute("data-motion-scene") === sceneId,
      );
      if (!el) throw new Error("Diagnostic target missing");

      const ancestors = [];
      for (let p: Element | null = el; p; p = p.parentElement)
        if (p instanceof SVGGraphicsElement)
          ancestors.push({
            nodeId: p.getAttribute("data-node-id"),
            clip: p.getAttribute("clip-path"),
            mask: p.getAttribute("mask"),
            matrix: Object.fromEntries(
              ["a", "b", "c", "d", "e", "f"].map((k) => [
                k,
                p.getScreenCTM()?.[k as keyof SVGMatrix],
              ]),
            ),
          });
      return {
        sceneId,
        targetId,
        renderedBounds: el.getBoundingClientRect().toJSON(),
        localBounds: Object.fromEntries(
          ["x", "y", "width", "height"].map((k) => [
            k,
            el.getBBox()[k as keyof DOMRect],
          ]),
        ),
        matrix: Object.fromEntries(
          ["a", "b", "c", "d", "e", "f"].map((k) => [
            k,
            el.getScreenCTM()?.[k as keyof SVGMatrix],
          ]),
        ),
        hierarchy: ancestors,
        paths: [
          ...el.querySelectorAll<SVGGeometryElement>("[data-motion-trim]"),
        ].map((p) => ({
          outline: p.getAttribute("d"),
          centerline: p.getAttribute("data-motion-centerline"),
          sourceMask: p.getAttribute("mask"),
          sourceClip: p.getAttribute("clip-path"),
          matrix: Object.fromEntries(
            ["a", "b", "c", "d", "e", "f"].map((k) => [
              k,
              p.getScreenCTM()?.[k as keyof SVGMatrix],
            ]),
          ),
          bounds: Object.fromEntries(
            ["x", "y", "width", "height"].map((k) => [
              k,
              p.getBBox()[k as keyof DOMRect],
            ]),
          ),
        })),
        masks: [...el.querySelectorAll("mask")].map((m) => ({
          x: m.getAttribute("x"),
          y: m.getAttribute("y"),
          width: m.getAttribute("width"),
          height: m.getAttribute("height"),
          units: m.getAttribute("maskUnits"),
          reveal: [...m.querySelectorAll("[data-motion-reveal]")].map((p) => ({
            d: p.getAttribute("d"),
            strokeWidth: p.getAttribute("stroke-width"),
            offset: p.getAttribute("stroke-dashoffset"),
            cap: p.getAttribute("stroke-linecap"),
            join: p.getAttribute("stroke-linejoin"),
          })),
        })),
        text: [...el.querySelectorAll("foreignObject span")].map((span) => {
          const style = getComputedStyle(span),
            canvas = document.createElement("canvas"),
            ctx = canvas.getContext("2d")!;
          ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const glyph = ctx.measureText(span.textContent ?? "");
          return {
            text: span.textContent,
            font: ctx.font,
            lineHeight: style.lineHeight,
            bounds: span.getBoundingClientRect().toJSON(),
            ascent: glyph.actualBoundingBoxAscent,
            descent: glyph.actualBoundingBoxDescent,
          };
        }),
      };
    },
    { sceneId, targetId },
  );
}
export async function renderIsolatedObject(
  project: LoadedProject,
  state: MotionState,
  sceneId: string,
  targetId: string,
  frame: number,
  baseline = false,
) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: state.settings.width, height: state.settings.height },
    });
    const targetState = baseline
      ? {
          ...state,
          animations: state.animations.filter(
            (a) => a.sceneId !== sceneId || a.targetId !== targetId,
          ),
          expressions: state.expressions?.filter(
            (a) => a.sceneId !== sceneId || a.targetId !== targetId,
          ),
        }
      : state;
    await page.setContent((await motionHtml(project, targetState)).html);
    await page.evaluate(() => window.motionReady);
    await page.evaluate((f) => window.motionFrame(f), frame);
    const diagnostic = await inspectObject(page, sceneId, targetId);
    await isolateObject(page, sceneId, targetId);
    return { png: await page.screenshot({ omitBackground: true }), diagnostic };
  } finally {
    await browser.close();
  }
}
