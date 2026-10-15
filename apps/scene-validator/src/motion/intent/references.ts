import type { LoadedProject } from "../../types.js";
import type { MotionState, Animation } from "../schema.js";
import type { IntentRequirement, IntentPlan } from "./schema.js";
import type { RecentAction } from "../contextual-resolution.js";
import { resolveObjectReference } from "../object-resolution.js";
export function resolveTemporalReference(
  project: LoadedProject,
  state: MotionState,
  r: IntentRequirement,
  recentActions?: RecentAction[],
): Animation | undefined {
  const ref = r.timing.reference;
  if (!ref) return undefined;
  if (
    ref.kind !== "existingAnimation" &&
    ref.kind !== "recentCommittedAnimation"
  )
    throw new Error("TEMPORAL_ANCHOR_KIND_UNSUPPORTED: " + ref.kind);
  if (ref.kind === "recentCommittedAnimation") {
    const action = recentActions?.find(
      (a) =>
        (!ref.recentActionId || a.actionId === ref.recentActionId) &&
        (!ref.effect || a.effect === ref.effect) &&
        a.animationIds?.length,
    );
    const tracks = state.animations.filter(
      (a) =>
        action?.animationIds?.includes(a.animationId) &&
        (!ref.target.sourceNodeId || a.targetId === ref.target.sourceNodeId) &&
        (!ref.target.sceneId || a.sceneId === ref.target.sceneId),
    );
    if (!tracks.length)
      throw new Error("MISSING_TEMPORAL_ANCHOR_RECENT_ACTION");
    if (tracks.length !== 1)
      throw new Error(
        "AMBIGUOUS_TEMPORAL_ANCHOR: " +
          tracks.map((a) => a.animationId).join(" -> "),
      );
    ref.kind = "existingAnimation";
    ref.animationId = tracks[0].animationId;
    ref.target = {
      sourceNodeId: tracks[0].targetId,
      sceneId: tracks[0].sceneId,
    };
    ref.resolvedFromActionId = action!.actionId;
  }
  const found = resolveObjectReference(project, state, {
    ...ref.target,
    sceneId: ref.target.sceneId ?? r.sceneId,
    referenceText: r.sourceText,
    techniques: [],
    preferExisting: true,
  });
  if (!found.target)
    throw new Error(
      found.status === "AMBIGUOUS_TARGET"
        ? "AMBIGUOUS_TEMPORAL_ANCHOR_OBJECT"
        : "MISSING_TEMPORAL_ANCHOR_OBJECT",
    );
  const candidates = state.animations.filter(
    (a) =>
      a.sceneId === found.target!.sceneId &&
      a.targetId === found.target!.sourceNodeId &&
      (!ref.effect || a.effect === ref.effect) &&
      (!ref.animationId || a.animationId === ref.animationId),
  );
  if (!candidates.length)
    throw new Error(
      "MISSING_TEMPORAL_ANCHOR: " +
        JSON.stringify({
          object: found.target.sourceNodeId,
          scene: found.target.sceneId,
          effect: ref.effect,
          animationId: ref.animationId,
        }),
    );
  if (candidates.length !== 1)
    throw new Error(
      "AMBIGUOUS_TEMPORAL_ANCHOR: " +
        candidates.map((a) => a.animationId).join(" -> "),
    );
  const anchor = candidates[0];
  ref.target = {
    sourceNodeId: anchor.targetId,
    sceneId: anchor.sceneId,
    name: found.target.canonicalName,
  };
  ref.resolvedAnimationId = anchor.animationId;
  return anchor;
}
export function referenceDiagnostics(plan: IntentPlan, state: MotionState) {
  return plan.requirements
    .filter((r) => r.timing.reference)
    .map((r) => ({
      requirementId: r.requirementId,
      readSet: [r.timing.reference!.resolvedAnimationId],
      writeSet: r.animationIds ?? [],
      reference: r.timing.reference,
      projectAnimationPresent: state.animations.some(
        (a) => a.animationId === r.timing.reference!.resolvedAnimationId,
      ),
    }));
}
