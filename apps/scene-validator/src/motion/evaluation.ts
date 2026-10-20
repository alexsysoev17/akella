import { presentationBlocks } from "./transition-runtime.js";
import { inverse } from "./geometry.js";
import { scopedExpressionValue } from "./transition-effects.js";
import type { StatePresentation } from "./transition-runtime.js";
import {
  valueAtTime as sampleValue,
  velocityAtTime as sampleVelocity,
} from "./sampling.js";
import {
  evaluateEasing,
  type Easing,
} from "../motion-library/easings/registry.js";
import { expressionValue, composeExpressions } from "./expressions.js";
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
  trimStart?: number;
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
        ...(a.parameters.startFrom !== undefined ||
        a.parameters.startTo !== undefined
          ? {
              trimStart: clamp(
                (a.parameters.startFrom ?? 0) +
                  ((a.parameters.startTo ?? a.parameters.startFrom ?? 0) -
                    (a.parameters.startFrom ?? 0)) *
                    t,
              ),
            }
          : {}),
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
export function evaluateMotion(state: MotionState, frame: number, presentation: StatePresentation = {}) {
  frame = Math.max(
    0,
    Math.min(state.settings.durationFrames - 1, Math.floor(frame)),
  );
  const nodes: Record<string, Values> = {};
  const tracks = new Map<string, Animation[]>();
  // Non-overlapping effects on one property form a track: first initial value holds before entry;
  // latest started effect wins thereafter and holds its end value. Never depend on previous frames.
  for (const a of state.animations.filter(
    (a) => a.enabled && (!a.text || a.text.segmentation === "block"),
  )) {
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
  const segmented = new Set(
    state.animations
      .filter((a) => a.text && a.text.segmentation !== "block")
      .map((a) => a.animationId),
  );
  composeExpressions(
    {
      ...state,
      expressions: (state.expressions ?? []).filter(
        (e) =>
          !("sourceAnimationId" in e) || !segmented.has(e.sourceAnimationId),
      ),
    },
    frame,
    nodes,
    evaluateAnimation,
  );
  const blocks = presentationBlocks(state).sort((a, b) => a.startFrame - b.startFrame);
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
  const transitionEffects: Record<string, Values> = {};
  for (const e of [...(state.expressions ?? [])].sort((a, b) => a.expressionId.localeCompare(b.expressionId))) {
    if ((!e.transitionId && e.ownership?.scope !== "logicalObject") || !e.enabled) continue;
    const bindings = e.ownership?.scope === "logicalObject"
      ? (state.objectTransitions ?? []).filter(t => t.logicalObjectId === e.ownership!.logicalObjectId).map(t => t.transitionId)
      : e.transitionId ? [e.transitionId] : [];
    const offset = scopedExpressionValue(state, e, frame, presentation);
    if (e.ownership?.scope === "logicalObject") {
      const states = presentation[e.ownership.logicalObjectId!];
      if (!states) throw new Error("MISSING_LOGICAL_EFFECT_GEOMETRY");
      for (const [sceneId, s] of Object.entries(states)) {
        const parent = inverse(s.parentCanvas);
        const x = e.property === "x" ? offset : 0, y = e.property === "y" ? offset : 0;
        const v = nodes[JSON.stringify([sceneId, s.sourceNodeId])] ??= {};
        v.x = (v.x ?? 0) + parent[0][0] * x + parent[0][1] * y;
        v.y = (v.y ?? 0) + parent[1][0] * x + parent[1][1] * y;
      }
    }
    for (const id of bindings) {
      const v = transitionEffects[id] ??= {};
      v[e.property] = (v[e.property] ?? 0) + offset;
    }
  }
  return { frame, nodes, blocks: visible, transitionEffects };
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
