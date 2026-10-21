import type { LoadedProject } from "../../types.js";
import type { MotionState, Animation } from "../schema.js";
import type { IntentRequirement, IntentPlan } from "./schema.js";
import type { RecentAction } from "../contextual-resolution.js";
import { resolveObjectReference } from "../object-resolution.js";
import { channels } from "../operations.js";
export function resolveTemporalReference(
  project: LoadedProject,
  state: MotionState,
  r: IntentRequirement,
  recentActions?: RecentAction[],
): Pick<Animation, "animationId" | "sceneId" | "targetId" | "startFrame" | "durationFrames"> | undefined {
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
  let candidates = state.animations.filter(
    (a) =>
      a.sceneId === found.target!.sceneId &&
      a.targetId === found.target!.sourceNodeId &&
      (!ref.effect || a.effect === ref.effect) &&
      (!ref.animationId || a.animationId === ref.animationId),
  );
  if (candidates.length > 1 && !ref.animationId && !ref.effect) {
    const enabled = candidates.filter(a=>a.enabled);
    if (enabled.length) candidates = enabled;
    // An object's compound entrance normally has a base movement plus Fade.
    // Select the unique base role; synchronized X/Y bases share one boundary.
    const primary = candidates.filter(a=>channels(a).some(c=>c!=="opacity"));
    if (primary.length) candidates = primary;
    const written = candidates.flatMap(channels);
    if (new Set(candidates.map(a=>`${a.startFrame}:${a.durationFrames}`)).size === 1 && new Set(written).size === written.length)
      candidates = [[...candidates].sort((a,b)=>a.animationId.localeCompare(b.animationId))[0]];
  }
  if (!candidates.length) {
    const transitions = state.objectTransitions?.filter(t => t.logicalObjectId === found.target!.logicalObjectId && (!ref.animationId || t.transitionId === ref.animationId) && (!ref.effect || ref.effect === "objectStateTransition"));
    if (transitions?.length === 1) {
      const t = transitions[0]; ref.resolvedAnimationId = t.transitionId;
      return { animationId: t.transitionId, sceneId: found.target.sceneId, targetId: found.target.sourceNodeId, startFrame: t.startFrame, durationFrames: t.durationFrames };
    }
    throw new Error(
      "MISSING_TEMPORAL_ANCHOR: " +
        JSON.stringify({
          object: found.target.sourceNodeId,
          scene: found.target.sceneId,
          effect: ref.effect,
          animationId: ref.animationId,
        }),
    );
  }
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
      ) || Boolean(state.objectTransitions?.some(t => t.transitionId === r.timing.reference!.resolvedAnimationId)),
    }));
}
