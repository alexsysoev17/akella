import type { MotionState } from "../schema.js";
/** Retimes a group of explicit scene starts atomically. Unspecified starts remain fixed.
 * Intervals follow existing block order; scene-local tracks shift together. Shortened
 * scenes compress existing intervals consistently, rather than leaving stale frames. */
export function retimeScenes(
  state: MotionState,
  starts: { sceneId: string; startFrame: number }[],
) {
  const before = structuredClone(state.blocks),
    ordered = [...state.blocks].sort((a, b) => a.startFrame - b.startFrame);
  const seen = new Set<string>();
  for (const ref of starts) {
    if (seen.has(ref.sceneId)) throw new Error("Duplicate scene timing");
    seen.add(ref.sceneId);
    const blocks = ordered.filter((b) => b.sceneId === ref.sceneId);
    if (blocks.length !== 1)
      throw new Error("Scene timing requires one unambiguous block");
    blocks[0].startFrame = ref.startFrame;
  }
  if (ordered[0].startFrame !== 0)
    throw new Error("First scene must start at frame zero");
  for (let i = 0; i < ordered.length; i++) {
    const b = ordered[i],
      next = ordered[i + 1];
    if (next && next.startFrame <= b.startFrame)
      throw new Error("Scene starts must preserve storyboard order");
    if (b.startFrame >= state.settings.durationFrames)
      throw new Error("Scene start outside project duration");
    const duration =
      (next?.startFrame ?? state.settings.durationFrames) - b.startFrame;
    if (b.transition.durationFrames >= duration)
      b.transition = { type: "cut", durationFrames: 0 };
    b.durationFrames = duration + (next ? b.transition.durationFrames : 0);
  }
  for (const old of before) {
    const next = ordered.find((b) => b.blockId === old.blockId)!;
    const scale = Math.min(1, next.durationFrames / old.durationFrames),
      delta = next.startFrame - old.startFrame;
    const map = (frame: number) =>
      next.startFrame + Math.round((frame - old.startFrame) * scale);
    if (!delta && scale === 1) continue;
    for (const a of state.animations.filter((a) => a.sceneId === old.sceneId)) {
      const end = map(a.startFrame + a.durationFrames);
      a.startFrame = Math.max(0, map(a.startFrame));
      a.durationFrames = Math.max(1, end - a.startFrame);
      if (a.effect === "keyframes") {
        a.parameters.points = a.parameters.points.map((k) => ({
          ...k,
          frame: Math.round(k.frame * scale),
        }));
        if (
          a.parameters.points.some(
            (k, i) => i && k.frame <= a.parameters.points[i - 1].frame,
          )
        )
          throw new Error("Retiming collapses keyframe intervals");
      }
    }
    for (const e of state.expressions?.filter(
      (e) => e.sceneId === old.sceneId,
    ) ?? []) {
      const end = map(e.startFrame + e.durationFrames);
      e.startFrame = Math.max(0, map(e.startFrame));
      e.durationFrames = Math.max(1, end - e.startFrame);
      if (e.type === "inertialOvershoot")
        e.parameters.velocityLookbackFrames = Math.min(
          e.parameters.velocityLookbackFrames,
          state.animations.find((a) => a.animationId === e.sourceAnimationId)
            ?.durationFrames ?? 1,
        );
    }
    for (const t of state.objectTransitions?.filter(
      (t) => t.fromSceneId === old.sceneId,
    ) ?? []) {
      const end = map(t.startFrame + t.durationFrames);
      t.startFrame = Math.max(0, map(t.startFrame));
      t.durationFrames = Math.max(1, end - t.startFrame);
    }
  }
}
export function resolveTimingDependencies(state: MotionState) {
  const edges = state.timingDependencies ?? [],
    byTarget = new Map(edges.map((d) => [d.animationId, d.anchorAnimationId]));
  const visited = new Set<string>(),
    stack: string[] = [];
  const visit = (id: string) => {
    const index = stack.indexOf(id);
    if (index >= 0)
      throw new Error(
        "Timing dependency cycle: " + [...stack.slice(index), id].join(" -> "),
      );
    if (visited.has(id)) return;
    stack.push(id);
    const next = byTarget.get(id);
    if (next) visit(next);
    stack.pop();
    visited.add(id);
  };
  for (const id of byTarget.keys()) visit(id);
  const pending = [...(state.timingDependencies ?? [])],
    completed = new Set<string>();
  while (pending.length) {
    const i = pending.findIndex(
      (d) =>
        !pending.some((other) => other.animationId === d.anchorAnimationId),
    );
    if (i < 0) throw new Error("Timing dependency cycle");
    const [d] = pending.splice(i, 1);
    if (completed.has(d.animationId))
      throw new Error("Multiple timing dependencies for one animation");
    completed.add(d.animationId);
    const a = state.animations.find((a) => a.animationId === d.animationId),
      anchor = state.animations.find(
        (a) => a.animationId === d.anchorAnimationId,
      );
    if (!a || !anchor)
      throw new Error("Timing dependency refers to a missing animation");
    const start =
      anchor.startFrame +
      (d.relation === "after"
        ? anchor.durationFrames
        : d.relation === "endWith"
          ? anchor.durationFrames - a.durationFrames
        : d.relation === "before"
          ? -a.durationFrames
          : 0) +
      d.offsetFrames;
    if (start < 0) throw new Error("Timing dependency precedes project");
    const delta = start - a.startFrame;
    a.startFrame = start;
    for (const e of state.expressions ?? [])
      if ("sourceAnimationId" in e && e.sourceAnimationId === a.animationId)
        e.startFrame += delta;
  }
}
