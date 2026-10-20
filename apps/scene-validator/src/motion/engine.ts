/** Browser compatibility adapter. The sole mathematical engine lives in evaluation.ts. */
export {
  ease,
  evaluateAnimation,
  evaluateMotion,
  valueAtTime,
  velocityAtTime,
} from "./evaluation.js";
export type { Values } from "./evaluation.js";
import { evaluateMotion } from "./evaluation.js";
import { applyTextAnimation } from "./text-animation.js";
import { textReveal } from "./text-reveal.js";
import { pathReveal } from "./path-reveal.js";
import {
  applyObjectTransitions,
  resetTransitionOpacity,
  type StatePresentation,
} from "./transition-runtime.js";
import type { MotionState } from "./schema.js";
/** Same DOM application is used in the iframe and Chromium video renderer. */
export function applyFrame(
  root: Document,
  state: MotionState,
  frame: number,
  presentation: StatePresentation = {},
) {
  resetTransitionOpacity(root);
  const result = evaluateMotion(state, frame, presentation);
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
    node.setAttribute(
      "opacity",
      String(Math.max(0, Math.min(1, v.opacity ?? 1))),
    );
    const visibility = state.visibility.find(
      (o) => o.sceneId === sceneId && o.targetId === targetId,
    );
    node.style.display =
      (visibility?.visible ?? node.dataset.baseVisible !== "false")
        ? ""
        : "none";
    applyTextAnimation(node, state, result.frame, (s, f) => evaluateMotion(s, f, presentation));
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
  applyObjectTransitions(root, state, result.frame, presentation, result.transitionEffects);
  return result;
}
