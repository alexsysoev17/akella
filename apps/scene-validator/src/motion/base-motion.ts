import type { MotionState, Animation } from "./schema.js";
import { channels } from "./operations.js";
import { evaluateAnimation } from "./engine.js";
import { valueAtTime, velocityAtTime } from "./sampling.js";
const endpoint = (a: Animation) =>
  a.startFrame +
  (a.effect === "keyframes"
    ? a.parameters.points.at(-1)!.frame
    : a.durationFrames);

/** Resolve the latest finite base movement independently for each position channel. */
export function resolveBaseMotion(
  state: MotionState,
  sceneId: string,
  targetId: string,
) {
  const checkedTracks = state.animations.filter(
    (a) => a.sceneId === sceneId && a.targetId === targetId,
  );
  const candidates = checkedTracks.filter(
    (a) =>
      a.enabled &&
      !["oscillation", "dampedOscillation"].includes(a.effect) &&
      channels(a).some((c) => c === "x" || c === "y"),
  );
  const selected = new Map<
    string,
    { animation: (typeof candidates)[number]; properties: ("x" | "y")[] }
  >();
  let ambiguous = false;
  for (const property of ["x", "y"] as const) {
    const matches = candidates
      .filter((a) => channels(a).includes(property))
      .sort((a, b) => endpoint(b) - endpoint(a));
    if (!matches.length) continue;
    const a = matches[0];
    if (matches[1] && endpoint(a) === endpoint(matches[1])) {
      ambiguous = true;
      continue;
    }
    const entry = selected.get(a.animationId) ?? {
      animation: a,
      properties: [],
    };
    entry.properties.push(property);
    selected.set(a.animationId, entry);
  }
  const tracks = [...selected.values()].map(({ animation, properties }) => {
    const endFrame = endpoint(animation);
    return {
      animation,
      properties,
      endFrame,
      evaluationInterval: { startFrame: animation.startFrame, endFrame },
      valueAtTime: (seconds: number) =>
        valueAtTime(animation, seconds, state.settings.fps, evaluateAnimation),
      incomingVelocity: velocityAtTime(
        animation,
        (endFrame - 0.1) / state.settings.fps,
        state.settings.fps,
        evaluateAnimation,
      ),
      dependencies: (state.timingDependencies ?? []).filter(
        (d) =>
          d.animationId === animation.animationId ||
          d.anchorAnimationId === animation.animationId,
      ),
    };
  });
  return {
    status: ambiguous
      ? "ANIMATION_RESOLUTION_FAILED"
      : tracks.length
        ? "RESOLVED"
        : "BASE_POSITION_ANIMATION_MISSING",
    tracks,
    checkedTracks: checkedTracks.map((a) => ({
      animationId: a.animationId,
      effect: a.effect,
      channels: channels(a),
      enabled: a.enabled,
      reason: candidates.includes(a)
        ? "position base candidate"
        : "disabled or not a finite position base",
    })),
  };
}
