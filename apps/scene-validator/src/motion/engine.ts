import {
  valueAtTime as sampleValue,
  velocityAtTime as sampleVelocity,
} from "./sampling.js";
import { textReveal } from "./text-reveal.js";
import { pathReveal } from "./path-reveal.js";
import {
  evaluateEasing,
  type Easing,
} from "../motion-library/easings/registry.js";
import { composeExpressions } from "./expressions.js";
import {
  applyObjectTransitions,
  resetTransitionOpacity,
  type StatePresentation,
} from "./transition-runtime.js";
import type { Animation, MotionState } from "./schema.js";
export type Values = {
  x?: number;
  y?: number;
  opacity?: number;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  trim?: number;
  reveal?: number;
};
const clamp = (n: number) => Math.max(0, Math.min(1, n));
export const ease = (t: number, easing: Easing) => evaluateEasing(t, easing);
export function evaluateAnimation(a: Animation, frame: number): Values {
  const raw = clamp((frame - a.startFrame) / a.durationFrames),
    t = ease(raw, a.easing),
    p = a.parameters;
  switch (a.effect) {
    case "property":
      return {
        [a.parameters.property]:
          a.parameters.from + (a.parameters.to - a.parameters.from) * t,
      };
    case "fadeIn":
    case "fadeOut":
      return {
        opacity: clamp(
          a.parameters.from + (a.parameters.to - a.parameters.from) * t,
        ),
      };
    case "scaleIn":
    case "scaleOut":
      return {
        scale: Math.max(
          0.001,
          a.parameters.from + (a.parameters.to - a.parameters.from) * t,
        ),
      };
    case "rotation":
      return {
        rotation: a.parameters.from + (a.parameters.to - a.parameters.from) * t,
      };
    case "moveTo":
      return {
        x: a.parameters.fromX + (a.parameters.toX - a.parameters.fromX) * t,
        y: a.parameters.fromY + (a.parameters.toY - a.parameters.fromY) * t,
      };
    case "slideUp":
    case "slideDown":
    case "slideLeft":
    case "slideRight": {
      const direction =
        a.effect === "slideUp" || a.effect === "slideLeft" ? 1 : -1;
      const q = a.parameters.mode === "in" ? 1 - t : -t;
      return {
        [a.effect === "slideUp" || a.effect === "slideDown" ? "y" : "x"]:
          direction * a.parameters.distance * q,
      };
    }
    case "oscillation":
    case "dampedOscillation": {
      const p = a.parameters;
      const damping =
        a.effect === "dampedOscillation" ? Math.exp(-p.damping * raw) : 1;
      return {
        [p.property]:
          p.amplitude *
          Math.sin(2 * Math.PI * p.cycles * raw + p.phase) *
          damping,
      };
    }
    case "maskReveal":
      return {
        reveal: clamp(
          a.parameters.from + (a.parameters.to - a.parameters.from) * t,
        ),
      };
    case "trimPath":
      return {
        trim: clamp(
          a.parameters.from + (a.parameters.to - a.parameters.from) * t,
        ),
      };
    case "keyframes": {
      const p = a.parameters,
        local = raw * a.durationFrames;
      let i = 1;
      while (i < p.points.length - 1 && p.points[i].frame < local) i++;
      const from = p.points[i - 1],
        to = p.points[i];
      const q = ease((local - from.frame) / (to.frame - from.frame), a.easing);
      return { [p.property]: from.value + (to.value - from.value) * q };
    }
  }
}
export function evaluateMotion(state: MotionState, frame: number) {
  frame = Math.max(
    0,
    Math.min(state.settings.durationFrames - 1, Math.floor(frame)),
  );
  const nodes: Record<string, Values> = {};
  const tracks = new Map<string, Animation[]>();
  // Non-overlapping effects on one property form a track: first initial value holds before entry;
  // latest started effect wins thereafter and holds its end value. Never depend on previous frames.
  for (const a of state.animations.filter((a) => a.enabled)) {
    const values = evaluateAnimation(a, frame);
    for (const property of [
      ...new Set(
        Object.keys(values).flatMap((p) =>
          p === "scale" ? ["scale", "scaleX", "scaleY"] : [p],
        ),
      ),
    ]) {
      const key = JSON.stringify([a.sceneId, a.targetId, property]);
      const list = tracks.get(key) ?? [];
      list.push(a);
      tracks.set(key, list);
    }
  }
  for (const [key, track] of tracks) {
    const [sceneId, targetId, property] = JSON.parse(key) as string[];
    track.sort(
      (a, b) =>
        a.startFrame - b.startFrame ||
        a.animationId.localeCompare(b.animationId),
    );
    const chosen =
      track.filter((a) => a.startFrame <= frame).at(-1) ?? track[0];
    const nodeKey = JSON.stringify([sceneId, targetId]);
    nodes[nodeKey] ??= {};
    Object.assign(nodes[nodeKey], {
      [property]:
        evaluateAnimation(chosen, frame)[property as keyof Values] ??
        evaluateAnimation(chosen, frame).scale,
    });
  }
  composeExpressions(state, frame, nodes, evaluateAnimation);
  const blocks = [...state.blocks].sort((a, b) => a.startFrame - b.startFrame);
  const visible: Record<string, number> = {};
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (frame < b.startFrame || frame >= b.startFrame + b.durationFrames)
      continue;
    let opacity = 1;
    const previous = blocks[i - 1];
    if (
      previous?.transition.type === "crossfade" &&
      previous.startFrame + previous.durationFrames > frame
    ) {
      opacity = (frame - b.startFrame) / previous.transition.durationFrames;
    }
    visible[b.blockId] = clamp(opacity);
  }
  return { frame, nodes, blocks: visible };
}
/** Same DOM application is used in the iframe and Chromium video renderer. */
export function applyFrame(
  root: Document,
  state: MotionState,
  frame: number,
  presentation: StatePresentation = {},
) {
  resetTransitionOpacity(root);
  const result = evaluateMotion(state, frame);
  for (const element of root.querySelectorAll<HTMLElement>(
    "[data-motion-block]",
  )) {
    const opacity = result.blocks[element.dataset.motionBlock!];
    element.style.display = opacity === undefined ? "none" : "block";
    element.style.opacity = String(opacity ?? 0);
  }
  for (const node of root.querySelectorAll<SVGGElement>(
    "[data-motion-target]",
  )) {
    const sceneId = node.closest<HTMLElement>("[data-motion-scene]")!.dataset
        .motionScene!,
      targetId = node.getAttribute("data-motion-target")!;
    const v = result.nodes[JSON.stringify([sceneId, targetId])] ?? {};
    const x = Number(node.dataset.originX ?? 0),
      y = Number(node.dataset.originY ?? 0);
    node.setAttribute(
      "transform",
      `translate(${v.x ?? 0} ${v.y ?? 0}) translate(${x} ${y}) rotate(${v.rotation ?? 0}) scale(${v.scaleX ?? v.scale ?? 1} ${v.scaleY ?? v.scale ?? 1}) translate(${-x} ${-y})`,
    );
    node.setAttribute("opacity", String(clamp(v.opacity ?? 1)));
    const visibility = state.visibility.find(
      (o) => o.sceneId === sceneId && o.targetId === targetId,
    );
    node.style.display =
      (visibility?.visible ?? node.dataset.baseVisible !== "false")
        ? ""
        : "none";
    const reveals = state.animations
      .filter(
        (a) =>
          a.enabled &&
          a.effect === "maskReveal" &&
          a.sceneId === sceneId &&
          a.targetId === targetId,
      )
      .sort((a, b) => a.startFrame - b.startFrame);
    const reveal =
      reveals.filter((a) => a.startFrame <= result.frame).at(-1) ?? reveals[0];
    textReveal(
      node,
      v.reveal,
      reveal?.effect === "maskReveal" ? reveal.parameters.direction : "forward",
    );
    for (const path of node.querySelectorAll<SVGPathElement>(
      "[data-motion-trim]",
    )) {
      if (path.closest("[data-motion-target]") !== node) continue;
      const track = state.animations
        .filter(
          (a) =>
            a.enabled &&
            a.effect === "trimPath" &&
            a.sceneId === sceneId &&
            a.targetId === targetId,
        )
        .sort((a, b) => a.startFrame - b.startFrame);
      const active =
        track.filter((a) => a.startFrame <= result.frame).at(-1) ?? track[0];
      pathReveal(
        path,
        v.trim,
        active?.effect === "trimPath"
          ? (active.parameters.direction ?? "forward")
          : "forward",
      );
    }
  }
  applyObjectTransitions(root, state, result.frame, presentation);
  return result;
}

/** Public base-track sampling shared by expressions, diagnostics and tools. */
export const valueAtTime = (
  animation: Animation,
  seconds: number,
  fps: number,
) => sampleValue(animation, seconds, fps, evaluateAnimation);
export const velocityAtTime = (
  animation: Animation,
  seconds: number,
  fps: number,
) => sampleVelocity(animation, seconds, fps, evaluateAnimation);
