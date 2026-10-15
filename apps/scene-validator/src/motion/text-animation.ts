import { snapshotText, type TextLayout, type TextUnit } from "./text-layout.js";
import type { Animation, MotionState } from "./schema.js";
import type { Values } from "./engine.js";
const ns = "http://www.w3.org/2000/svg";
let sequence = 0;
type Entry = {
  source: SVGForeignObjectElement;
  layout: TextLayout;
  root: SVGGElement;
  units: { mover: SVGGElement; mask: SVGRectElement; bounds: TextUnit }[];
  signature: string;
  track: Animation;
  ctm: DOMMatrix | null;
  viewport: { x: number; y: number; width: number; height: number };
};
const cache = new WeakMap<SVGGElement, Entry>();
let snapshots = new WeakMap<
  SVGForeignObjectElement,
  { layout: TextLayout; ctm: DOMMatrix | null }
>();
export function invalidateTextLayouts(root: Document) {
  for (const node of root.querySelectorAll<SVGGElement>("[data-motion-target]"))
    clearTextAnimation(node);
  snapshots = new WeakMap();
}
export function textSchedule(
  total: number,
  count: number,
  settings: NonNullable<Animation["text"]>,
) {
  const step =
    settings.timing === "simultaneous"
      ? 0
      : settings.timing === "sequential"
        ? total / Math.max(1, count)
        : settings.staggerFrames;
  const duration = total - step * (count - 1);
  if (duration < 1) throw new Error("TEXT_STAGGER_EXCEEDS_DURATION");
  return { step, duration };
}
export function clearTextAnimation(node: SVGGElement) {
  const entry = cache.get(node);
  if (entry) {
    entry.root.remove();
    entry.source.style.visibility = "";
    cache.delete(node);
    node.removeAttribute("data-text-layout");
    node.removeAttribute("data-text-frame-ms");
  }
}
export function prepareTextAnimation(node: SVGGElement, state: MotionState) {
  const tracks = state.animations.filter(
    (a) =>
      a.enabled &&
      a.text &&
      a.text.segmentation !== "block" &&
      a.targetId === node.getAttribute("data-motion-target") &&
      a.sceneId ===
        node.closest<HTMLElement>("[data-motion-scene]")?.dataset.motionScene,
  );
  if (!tracks.length) {
    clearTextAnimation(node);
    return;
  }
  const signature = JSON.stringify(
    tracks.map((a) => [a.animationId, a.durationFrames, a.text]),
  );
  if (cache.get(node)?.signature === signature) return;
  clearTextAnimation(node);
  const source = node.querySelector<SVGForeignObjectElement>(
    "foreignObject[data-text-source]",
  );
  if (!source) throw new Error("TEXT_NATIVE_LAYOUT_REQUIRED");
  if ((source.getAttribute("data-text-source") ?? "").length > 4096)
    throw new Error("TEXT_LAYOUT_LIMIT: maximum 4096 UTF-16 source units");
  let saved = snapshots.get(source);
  if (!saved) {
    saved = { layout: snapshotText(source), ctm: source.getCTM() };
    snapshots.set(source, saved);
  }
  const layout = saved.layout,
    track = tracks[0],
    settings = track.text!;
  const units =
    settings.segmentation === "line"
      ? layout.lines
      : settings.segmentation === "word"
        ? layout.words
        : layout.characters;
  if (units.length > 512)
    throw new Error("TEXT_SEGMENT_LIMIT: maximum 512 shaped slices");
  if (!units.length) return;
  textSchedule(track.durationFrames, units.length, settings);
  const root = document.createElementNS(ns, "g");
  root.setAttribute("data-text-animation", "true");
  root.setAttribute("aria-hidden", "true");
  const entries = units.map((bounds) => {
    const clip = document.createElementNS(ns, "clipPath"),
      rect = document.createElementNS(ns, "rect");
    clip.id = "motion-text-unit-" + ++sequence;
    clip.setAttribute("clipPathUnits", "userSpaceOnUse");
    for (const key of ["x", "y", "width", "height"] as const)
      rect.setAttribute(key, String(bounds[key]));
    clip.append(rect);
    const mover = document.createElementNS(ns, "g"),
      slice = document.createElementNS(ns, "g"),
      mask = document.createElementNS(ns, "g");
    mover.setAttribute("data-text-unit-bounds", JSON.stringify(bounds));
    slice.setAttribute("clip-path", `url(#${clip.id})`);
    const clone = source.cloneNode(true) as SVGForeignObjectElement;
    clone.style.visibility = "visible";
    slice.append(clone);
    mover.append(slice);
    mask.append(mover);
    root.append(clip, mask);
    if (settings.origin === "masked") {
      const maskClip = clip.cloneNode(true) as SVGClipPathElement;
      maskClip.id = clip.id + "-fixed";
      root.append(maskClip);
      mask.setAttribute("clip-path", `url(#${maskClip.id})`);
    }
    return { mover, mask: rect, bounds };
  });
  source.style.visibility = "hidden";
  source.parentNode!.appendChild(root);
  node.setAttribute("data-text-layout", JSON.stringify(layout));
  const box = node.closest("svg")!.viewBox.baseVal;
  cache.set(node, {
    source,
    layout,
    root,
    units: entries,
    signature,
    track,
    ctm: saved.ctm,
    viewport: { x: box.x, y: box.y, width: box.width, height: box.height },
  });
}
/** Local segment motion never writes source typography. Re-seeking only assigns absolute transforms. */
export function applyTextAnimation(
  node: SVGGElement,
  state: MotionState,
  frame: number,
  evaluate: (
    state: MotionState,
    frame: number,
  ) => { nodes: Record<string, Values> },
) {
  const begin = performance.now();
  prepareTextAnimation(node, state);
  const entry = cache.get(node);
  if (!entry) return;
  const selected = state.animations.filter(
    (a) =>
      a.enabled &&
      a.text &&
      a.text.segmentation !== "block" &&
      a.targetId === entry.track.targetId &&
      a.sceneId === entry.track.sceneId,
  );
  const selectedIds = new Set(selected.map((a) => a.animationId));
  const expressions = (state.expressions ?? []).filter(
    (e) => "sourceAnimationId" in e && selectedIds.has(e.sourceAnimationId),
  );
  const end = Math.max(
    ...selected.map((a) => a.startFrame + a.durationFrames),
    ...expressions.map((e) => e.startFrame + e.durationFrames),
  );
  // At rest, restore the original shaped text exactly, including spaces, kerning and overhangs.
  if (frame >= end) {
    entry.source.style.visibility = "";
    entry.root.style.display = "none";
    return;
  }
  entry.source.style.visibility = "hidden";
  entry.root.style.display = "";
  entry.units.forEach((unit, index) => {
    const tracks = selected.map((a) => {
      const schedule = textSchedule(
        a.durationFrames,
        entry.units.length,
        a.text!,
      );
      const order = a.text!.reverse ? entry.units.length - 1 - index : index;
      const copy = {
        ...a,
        startFrame: a.startFrame + order * schedule.step,
        durationFrames: schedule.duration,
        text: undefined,
      } as Animation;
      if (
        a.text!.origin === "outsideViewport" &&
        a.effect.startsWith("slide")
      ) {
        // Bounds include all ancestor/base transforms; inverse maps the viewport displacement to the local text plane.
        const box = entry.viewport,
          ctm = entry.ctm;
        if (ctm) {
          const corners = [
            [unit.bounds.x, unit.bounds.y],
            [unit.bounds.x + unit.bounds.width, unit.bounds.y],
            [unit.bounds.x, unit.bounds.y + unit.bounds.height],
            [
              unit.bounds.x + unit.bounds.width,
              unit.bounds.y + unit.bounds.height,
            ],
          ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(ctm));
          const delta =
            a.effect === "slideDown"
              ? { x: 0, y: box.y - Math.max(...corners.map((p) => p.y)) - 1 }
              : a.effect === "slideUp"
                ? {
                    x: 0,
                    y:
                      box.y +
                      box.height -
                      Math.min(...corners.map((p) => p.y)) +
                      1,
                  }
                : a.effect === "slideRight"
                  ? {
                      x: box.x - Math.max(...corners.map((p) => p.x)) - 1,
                      y: 0,
                    }
                  : {
                      x:
                        box.x +
                        box.width -
                        Math.min(...corners.map((p) => p.x)) +
                        1,
                      y: 0,
                    };
          const inv = ctm.inverse();
          const local = {
            x: inv.a * delta.x + inv.c * delta.y,
            y: inv.b * delta.x + inv.d * delta.y,
          };
          Object.assign(copy, {
            effect: "moveTo",
            parameters: { fromX: local.x, fromY: local.y, toX: 0, toY: 0 },
          });
        }
      }
      return copy;
    });
    const localExpressions = expressions.map((e) => {
      const source = tracks.find(
        (a) =>
          "sourceAnimationId" in e && a.animationId === e.sourceAnimationId,
      )!;
      const original = selected.find(
        (a) => a.animationId === source.animationId,
      )!;
      return {
        ...e,
        startFrame:
          source.startFrame +
          source.durationFrames +
          (e.startFrame - original.startFrame - original.durationFrames),
      };
    });
    const v =
      evaluate(
        {
          ...state,
          animations: tracks,
          expressions: localExpressions,
          objectTransitions: [],
        },
        frame,
      ).nodes[JSON.stringify([entry.track.sceneId, entry.track.targetId])] ??
      {};
    unit.mover.setAttribute("transform", `translate(${v.x ?? 0} ${v.y ?? 0})`);
    unit.mover.setAttribute("opacity", String(v.opacity ?? 1));
  });
  node.setAttribute("data-text-frame-ms", String(performance.now() - begin));
}
