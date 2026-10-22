import { evaluateEasing } from "../motion-library/easings/registry.js";
import type { MotionState, ObjectTransition } from "./schema.js";
import {
  compose,
  decompose,
  inverse,
  multiply,
  svgMatrix,
  type Matrix,
} from "./geometry.js";
export interface PresentationState {
  sourceNodeId: string;
  normalized: Matrix;
  parentCanvas: Matrix;
  local: Matrix;
  width: number;
  height: number;
  opacity: number;
  visible: boolean;
}
export type StatePresentation = Record<
  string,
  Record<string, PresentationState>
>;
const clamp = (v: number) => Math.max(0, Math.min(1, v));
/** Windowed oscillation has value AND derivative zero at both endpoints. */
export function transitionProgress(t: ObjectTransition, frame: number) {
  const u = clamp((frame - t.startFrame) / t.durationFrames);
  // Historical state-transition spring differs from the old node spring; preserve its serialized meaning.
  let q = evaluateEasing(
    u,
    t.easing === "springSoft" ? "springStateLegacy" : t.easing,
  );
  for (const p of t.proceduralEffects)
    q +=
      p.amplitude *
      Math.sin(Math.PI * u) ** 2 *
      Math.sin(2 * Math.PI * p.cycles * u) *
      Math.exp(-p.damping * u);
  return u === 0 ? 0 : u === 1 ? 1 : q;
}
export function interpolateState(
  a: PresentationState,
  b: PresentationState,
  t: ObjectTransition,
  frame: number,
) {
  const q = transitionProgress(t, frame),
    u = clamp((frame - t.startFrame) / t.durationFrames),
    from = decompose(a.normalized),
    to = decompose(b.normalized);
  let angle = to.rotation - from.rotation;
  angle = Math.atan2(Math.sin(angle), Math.cos(angle));
  const mix = (a: number, b: number) => a + (b - a) * q;
  const values = {
    x: mix(from.x, to.x),
    y: mix(from.y, to.y),
    scaleX: Math.max(0.0001, mix(from.scaleX, to.scaleX)),
    scaleY:
      Math.sign(from.scaleY) *
      Math.max(0.0001, Math.sign(from.scaleY) * mix(from.scaleY, to.scaleY)),
    rotation: from.rotation + angle * q,
    shear: mix(from.shear, to.shear),
  };
  return {
    matrix: u === 0 ? a.normalized : u === 1 ? b.normalized : compose(values),
    opacity: clamp(mix(a.opacity, b.opacity)),
    progress: u,
  };
}
const initialOpacity = new WeakMap<Element, string | null>();
export function resetTransitionOpacity(root: Document) {
  for (const el of root.querySelectorAll("[data-node-id]")) {
    if (initialOpacity.has(el)) {
      const v = initialOpacity.get(el);
      if (v === null) el.removeAttribute("opacity");
      else el.setAttribute("opacity", v!);
    }
  }
  for (const el of root.querySelectorAll("[data-logical-object]"))
    el.removeAttribute("data-logical-object");
}
/** Render-only source trees for reference states absent from the authored video blocks.
 * These view IDs are never persisted or used as object identity. */
export function presentationBlocks(state: MotionState): MotionState["blocks"] {
  const blocks = state.blocks.map(b => ({ ...b }));
  if (state.settings.tailPolicy === "holdLastScene") {
    const last = [...blocks].sort((a,b) => a.startFrame-b.startFrame).at(-1);
    if (last) last.durationFrames = state.settings.durationFrames - last.startFrame;
  }
  for (const t of state.objectTransitions ?? []) {
    if (t.timelinePolicy !== "referenceStates") continue;
    for (const sceneId of [t.fromSceneId, t.toSceneId]) {
      if (blocks.some(b => b.sceneId === sceneId)) continue;
      let blockId = "reference:" + sceneId;
      while (blocks.some(b => b.blockId === blockId)) blockId += ":view";
      blocks.push({ blockId, sceneId, name: sceneId, startFrame: 0, durationFrames: state.settings.durationFrames, transition: { type: "cut", durationFrames: 0 } });
    }
  }
  return blocks;
}
export function presentedTransitions(state: MotionState, frame: number) {
  const started=(state.objectTransitions ?? []).filter(t=>frame>=t.startFrame);
  const latest=new Map<string,number>();
  for(const t of started)latest.set(t.logicalObjectId,Math.max(latest.get(t.logicalObjectId)??-Infinity,t.startFrame));
  return started.filter(t=>t.startFrame===latest.get(t.logicalObjectId));
}

/** Keep the selected source/target tree intact. One scene composite owns the entire pair
 * while a transition is active. This explicit cut fallback avoids flattening masks/groups. */
export function applyObjectTransitions(
  root: Document,
  state: MotionState,
  frame: number,
  presentation: StatePresentation,
  effects: Record<string, { x?: number; y?: number }> = {},
) {
  let active = presentedTransitions(state, frame);
  if (!active.length) return;
  const latest = Math.max(...active.map((t) => t.startFrame));
  active = active.filter((t) => t.startFrame === latest);
  const first = active[0],
    progress = (frame - first.startFrame) / first.durationFrames;
  const host =
    progress >= first.layerPolicy.switchProgress
      ? first.toSceneId
      : first.fromSceneId;
  for (const block of root.querySelectorAll<HTMLElement>(
    "[data-motion-block]",
  )) {
    if (
      first.timelinePolicy === "referenceStates" ||
      block.dataset.motionScene === first.fromSceneId ||
      block.dataset.motionScene === first.toSceneId
    ) {
      block.style.display =
        block.dataset.motionScene === host ? "block" : "none";
      block.style.opacity = "1";
    }
  }
  for (const t of active) {
    const states = presentation[t.logicalObjectId];
    if (!states?.[t.fromSceneId] || !states[t.toSceneId]) continue;
    const current = states[host],
      v = interpolateState(
        states[t.fromSceneId],
        states[t.toSceneId],
        t,
        frame,
      );
    for (const node of root.querySelectorAll<SVGGElement>(
      "[data-motion-target]",
    )) {
      const scene = node.closest<HTMLElement>("[data-motion-scene]")?.dataset
        .motionScene;
      if (scene !== host || node.dataset.motionTarget !== current.sourceNodeId)
        continue;
      // Parent * wrapper * local = interpolated canvas transform / geometry dimensions.
      const offset = effects[t.transitionId] ?? {};
      const visual = multiply([[1, 0, offset.x ?? 0], [0, 1, offset.y ?? 0]], v.matrix);
      const wrapper = multiply(
        multiply(multiply(inverse(current.parentCanvas), visual), [
          [1 / current.width, 0, 0],
          [0, 1 / current.height, 0],
        ]),
        inverse(current.local),
      );
      node.setAttribute("transform", svgMatrix(wrapper));
      node.setAttribute("data-logical-object", t.logicalObjectId);
      const content = node.firstElementChild;
      if (content) {
        if (!initialOpacity.has(content))
          initialOpacity.set(content, content.getAttribute("opacity"));
        content.setAttribute("opacity", String(v.opacity));
      }
    }
  }
}
