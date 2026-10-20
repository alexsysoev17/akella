import { velocityAtTime as baseVelocity } from "./sampling.js";
import type { Animation, MotionState } from "./schema.js";
import type { Expression } from "../motion-library/expressions/registry.js";
import * as math from "../motion-library/expressions/functions.js";
import type { Values } from "./engine.js";
export function expressionValue(
  e: Expression,
  frame: number,
  fps: number,
  animations: Animation[],
  evaluate: (a: Animation, frame: number) => Values,
): number {
  let time = (frame - e.startFrame) / fps;
  const duration = e.durationFrames / fps;
  const continuous = e.type === "wiggle" && e.parameters.temporalMode === "continuous";
  if (!e.enabled || (continuous ? time < 0 : time <= 0) || time >= duration) return 0;
  const p = e.parameters,
    source =
      "sourceAnimationId" in e
        ? animations.find((a) => a.animationId === e.sourceAnimationId)
        : undefined;
  const get = (frame: number) => {
    const values = evaluate(source!, frame);
    return (
      values[e.property] ??
      (e.property === "scaleX" || e.property === "scaleY"
        ? values.scale
        : undefined) ??
      0
    );
  };
  let value = 0;
  switch (e.type) {
    case "wiggle":
      value = math.wiggle(
        time,
        e.parameters.amplitude,
        e.parameters.frequency,
        e.parameters.seed,
      );
      break;
    case "dampedOscillation":
      value = math.dampedOscillation(
        time,
        e.parameters.amplitude,
        e.parameters.frequency,
        e.parameters.decay,
      );
      break;
    case "inertialOvershoot": {
      if (!source) throw new Error("Missing expression source track");
      const end = (source.startFrame + source.durationFrames) / fps;
      let velocity =
        e.parameters.mode === "ae"
          ? 0
          : math.averageVelocity(
              (s) => get(s * fps),
              end,
              e.parameters.velocityLookbackFrames / fps,
            );
      if (e.parameters.mode === "ae") {
        const keys =
          source.effect === "keyframes"
            ? source.parameters.points.map((p) => source.startFrame + p.frame)
            : [source.startFrame, source.startFrame + source.durationFrames];
        const index = keys.reduce(
          (index, key, i) => (key <= frame ? i : index),
          -1,
        );
        if (index <= 0) return 0;
        const key = keys[index];
        time = (frame - key) / fps;
        if (time < 0 || time >= duration) return 0;
        const sampleTime = key / fps - 1 / (fps * 10);
        const values = baseVelocity(source, sampleTime, fps, evaluate);
        velocity =
          values[e.property] ??
          (e.property === "scaleX" || e.property === "scaleY"
            ? values.scale
            : undefined) ??
          0;
      }
      value = math.inertialOvershoot(
        time,
        velocity +
          (e.parameters.mode === "ae"
            ? 0
            : (e.parameters.incomingImpulse ?? 0)),
        e.parameters.amplitude,
        e.parameters.frequency,
        e.parameters.decay,
      );
      break;
    }
    case "spring":
      value = math.spring(
        time / duration,
        e.parameters.amplitude,
        e.parameters,
      );
      break;
    case "bounce":
      value = math.bounce(
        time / duration,
        e.parameters.amplitude,
        e.parameters,
      );
      break;
    case "loop": {
      if (!source) throw new Error("Missing loop source");
      const local = math.loop(
        time,
        source.durationFrames / fps,
        e.parameters.mode,
      );
      const sampleFrame =
        e.parameters.mode === "pingPong"
          ? source.startFrame + source.durationFrames - local * fps
          : source.startFrame + local * fps;
      value =
        (get(sampleFrame) - get(source.startFrame + source.durationFrames)) *
        e.parameters.amplitude;
      break;
    }
  }
  const result =
    value *
    (continuous || (e.type === "inertialOvershoot" && e.parameters.mode === "ae")
      ? 1
      : math.windowOffset(
          time,
          duration,
          !["inertialOvershoot", "spring", "loop"].includes(e.type),
        ));
  if (!Number.isFinite(result)) throw new Error("Non-finite expression result");
  return result;
}
export function composeExpressions(
  state: MotionState,
  frame: number,
  nodes: Record<string, Values>,
  evaluate: (a: Animation, frame: number) => Values,
) {
  // Addition is in stable expressionId order; expressions sample BASE tracks, never other expressions.
  for (const e of [...(state.expressions ?? [])].sort((a, b) =>
    a.expressionId.localeCompare(b.expressionId),
  )) {
    if (
      !e.enabled ||
      Boolean(e.transitionId) ||
      frame < e.startFrame ||
      frame > e.startFrame + e.durationFrames
    )
      continue;
    const key = JSON.stringify([e.sceneId, e.targetId]),
      v = (nodes[key] ??= {});
    const base =
      v[e.property] ??
      (["scaleX", "scaleY"].includes(e.property)
        ? (v.scale ?? 1)
        : e.property === "opacity"
          ? 1
          : 0);
    v[e.property] =
      base +
      expressionValue(e, frame, state.settings.fps, state.animations, evaluate);
  }
  for (const v of Object.values(nodes)) {
    if (v.opacity !== undefined)
      v.opacity = Math.max(0, Math.min(1, v.opacity));
    for (const key of ["scale", "scaleX", "scaleY"] as const)
      if (v[key] !== undefined) v[key] = Math.max(0.001, v[key]!);
    for (const value of Object.values(v))
      if (!Number.isFinite(value))
        throw new Error("Non-finite composed motion");
  }
}
