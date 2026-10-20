import type { LoadedProject } from "../types.js";
import type { MotionState } from "./schema.js";
import { objectsIn } from "./context.js";
import { buildRegistry } from "./registry.js";
import { channels } from "./operations.js";
import {
  objectNameMatch,
  objectMentionRanges,
  normalizeObjectName,
} from "./object-aliases.js";
export interface ObjectCandidate {
  sceneId: string;
  sourceNodeId: string;
  logicalObjectId: string | null;
  canonicalName: string;
  referenceText: string;
  resolutionMethod: string;
  existingAnimationIds: string[];
  existingExpressionIds: string[];
  existingTransitionIds: string[];
}
export interface ObjectResolution {
  status: "RESOLVED" | "AMBIGUOUS_TARGET" | "TARGET_UNRESOLVED";
  target?: ObjectCandidate;
  candidates: ObjectCandidate[];
  rejectedCandidates: { candidate: ObjectCandidate; reason: string }[];
  normalizedReference: string;
  ambiguityReason?: string;
}
export function resolveObjectReference(
  project: LoadedProject,
  state: MotionState,
  input: {
    referenceText: string;
    name?: string | null;
    sceneId?: string | null;
    sourceNodeId?: string | null;
    logicalObjectId?: string | null;
    activeSceneId?: string;
    selectedObjectId?: string;
    techniques?: string[];
    preferExisting?: boolean;
    allowLogicalFallback?: boolean;
  },
): ObjectResolution {
  const registry = buildRegistry(
    project.inspection.document,
    project.inspection.fingerprint,
  );
  const roots = new Set(
    project.inspection.document.scenes.map((s) => s.figmaNodeId),
  );
  const instances = new Map(
    registry.objects.flatMap((o) =>
      o.sourceInstances.map(
        (i) => [i.sceneId + "/" + i.sourceNodeId, o] as const,
      ),
    ),
  );
  const rejected: ObjectResolution["rejectedCandidates"] = [];
  let candidates: ObjectCandidate[] = project.inspection.document.scenes
    .flatMap(objectsIn)
    .filter((o) => o.parentId && !roots.has(o.targetId))
    .flatMap((o) => {
      const logical = instances.get(o.sceneId + "/" + o.targetId);
      const ranges = objectMentionRanges(o.name, input.referenceText);
      const nameMatch = input.name ? objectNameMatch(o.name, input.name) : null;
      const explicitId = Boolean(input.sourceNodeId || input.logicalObjectId);
      if (
        explicitId &&
        ((input.sourceNodeId && o.targetId !== input.sourceNodeId) ||
          (input.logicalObjectId &&
            logical?.logicalObjectId !== input.logicalObjectId))
      )
        return [];
      if (!explicitId && (input.name ? !nameMatch : !ranges.length)) return [];
      const reference =
        input.name ??
        (ranges[0]
          ? input.referenceText.slice(ranges[0].start, ranges[0].end)
          : input.referenceText);
      return [
        {
          sceneId: o.sceneId,
          sourceNodeId: o.targetId,
          logicalObjectId: logical?.logicalObjectId ?? null,
          canonicalName: o.name,
          referenceText: reference,
          resolutionMethod: explicitId
            ? "canonical-id"
            : (nameMatch ??
              objectNameMatch(o.name, reference) ??
              "morphological"),
          existingTransitionIds: (state.objectTransitions ?? []).filter(t => t.logicalObjectId === logical?.logicalObjectId && (!input.techniques?.length || input.techniques.includes("objectStateTransition"))).map(t => t.transitionId),
          existingAnimationIds: state.animations
            .filter(
              (a) =>
                a.enabled &&
                a.sceneId === o.sceneId &&
                a.targetId === o.targetId &&
                (!input.techniques?.length ||
                  input.techniques.includes(a.effect) ||
                  (input.techniques.includes("inertialOvershoot") &&
                    !["oscillation", "dampedOscillation"].includes(a.effect) &&
                    channels(a).some((c) => c === "x" || c === "y"))),
            )
            .map((a) => a.animationId),
          existingExpressionIds: (state.expressions ?? [])
            .filter(
              (e) =>
                e.enabled &&
                e.sceneId === o.sceneId &&
                e.targetId === o.targetId &&
                (!input.techniques?.length ||
                  input.techniques.includes(e.type)),
            )
            .map((e) => e.expressionId),
        },
      ];
    });
  if (input.allowLogicalFallback && candidates.length === 1 &&
      !candidates[0].existingAnimationIds.length && !candidates[0].existingExpressionIds.length &&
      candidates[0].logicalObjectId) {
    const logical = candidates[0].logicalObjectId;
    const alternatives = resolveObjectReference(project, state, {
      referenceText: input.referenceText, logicalObjectId: logical,
      techniques: input.techniques, preferExisting: true,
    });
    const applicable = alternatives.candidates.filter(c => c.existingAnimationIds.length || c.existingExpressionIds.length);
    if (applicable.length) {
      rejected.push({ candidate: candidates[0], reason: "selected-instance-has-no-compatible-motion" });
      candidates = applicable.map(c => ({ ...c, resolutionMethod: "logical-existing-motion" }));
    }
  }
  const restrict = (
    reason: string,
    test: (c: ObjectCandidate) => boolean,
    hard = false,
  ) => {
    const matched = candidates.filter(test);
    if (hard || matched.length) {
      candidates
        .filter((c) => !test(c))
        .forEach((candidate) => rejected.push({ candidate, reason }));
      candidates = matched;
    }
  };
  if (input.sceneId && !input.allowLogicalFallback)
    restrict("requested-scene", (c) => c.sceneId === input.sceneId, true);
  // Never use registry order or spelling similarity to guess among canonical instances.
  // Alias-equivalent canonical spellings remain ambiguous unless state/selection disambiguates.
  if (candidates.length > 1 && input.selectedObjectId)
    restrict(
      "selected-object",
      (c) => c.sourceNodeId === input.selectedObjectId && (!input.preferExisting ||
        Boolean(c.existingAnimationIds.length || c.existingExpressionIds.length || c.existingTransitionIds.length)),
    );
  if (candidates.length > 1 && input.preferExisting)
    restrict("existing-motion", (c) =>
      Boolean(c.existingAnimationIds.length || c.existingExpressionIds.length || c.existingTransitionIds.length),
    );
  if (candidates.length > 1 && input.activeSceneId && !input.allowLogicalFallback)
    restrict("active-scene", (c) => c.sceneId === input.activeSceneId);
  if (candidates.length > 1 && input.techniques?.length)
    restrict("existing-technique", (c) =>
      Boolean(c.existingAnimationIds.length || c.existingExpressionIds.length || c.existingTransitionIds.length),
    );
  const status =
    candidates.length === 1
      ? "RESOLVED"
      : candidates.length
        ? "AMBIGUOUS_TARGET"
        : "TARGET_UNRESOLVED";
  return {
    status,
    target: status === "RESOLVED" ? candidates[0] : undefined,
    candidates,
    rejectedCandidates: rejected,
    normalizedReference: normalizeObjectName(input.name ?? input.referenceText),
    ambiguityReason:
      status === "AMBIGUOUS_TARGET"
        ? "Multiple canonical instances remain after scene/selection/technique constraints"
        : undefined,
  };
}
export function resolveExistingAnimation(
  state: MotionState,
  target: ObjectCandidate,
  techniques: string[],
) {
  const animations = state.animations.filter(
    (a) =>
      a.enabled &&
      a.sceneId === target.sceneId &&
      a.targetId === target.sourceNodeId &&
      techniques.includes(a.effect),
  );
  const expressions = (state.expressions ?? []).filter(
    (e) =>
      e.enabled &&
      e.sceneId === target.sceneId &&
      e.targetId === target.sourceNodeId &&
      techniques.includes(e.type),
  );
  const transitions = (state.objectTransitions ?? []).filter(t => t.logicalObjectId === target.logicalObjectId && techniques.includes("objectStateTransition"));
  return {
    transitions,
    status:
      transitions.length === 1 ||
      (animations.length === 0 && expressions.length > 0 &&
       new Set(expressions.map(e => `${e.type}/${e.property}`)).size === expressions.length) ||
      animations.length + expressions.length === 1
        ? "RESOLVED"
        : animations.length + expressions.length
          ? "AMBIGUOUS_ANIMATION"
          : "EXISTING_ANIMATION_NOT_FOUND",
    animations,
    expressions,
    dependencies: (state.timingDependencies ?? []).filter((d) =>
      animations.some(
        (a) =>
          a.animationId === d.animationId ||
          a.animationId === d.anchorAnimationId,
      ),
    ),
  };
}
