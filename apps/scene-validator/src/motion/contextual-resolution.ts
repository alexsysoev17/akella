import { semanticBindings } from "../motion-library/techniques/registry.js";
import { createHash } from "node:crypto";
import type { MotionDocument } from "./store.js";
import type { MotionState } from "./schema.js";
import type { LoadedProject } from "../types.js";
import type { IntentPlan, IntentRequirement } from "./intent/schema.js";
import { objectsIn } from "./context.js";
import { objectMentionRanges } from "./object-aliases.js";
import { resolveObjectReference } from "./object-resolution.js";
import { channels } from "./operations.js";
/** A single synchronized action may span independent property tracks (e.g. slide + fade).
 * Distinct intervals or competing writers still require an explicit effect selection. */
export function isSynchronizedTrackSet(tracks: MotionState["animations"]): boolean {
  if (!tracks.length) return false;
  const first = tracks[0], written = new Set<string>();
  return tracks.every(track => {
    if (track.sceneId !== first.sceneId || track.targetId !== first.targetId ||
        track.startFrame !== first.startFrame ||
        track.durationFrames !== first.durationFrames ||
        track.enabled !== first.enabled) return false;
    const properties = channels(track);
    if (!properties.length || properties.some(property => written.has(property))) return false;
    properties.forEach(property => written.add(property));
    return true;
  });
}
export interface RecentAction {
  actionId: string;
  editIds: string[];
  createdAt: string;
  effect: string;
  expressionIds: string[];
  animationIds?: string[];
  targets: { sceneId: string; targetId: string }[];
}
const projectFilter =
  /все(?:х|м)?\s+(?:об[ъь]?ект|сло|элемент)|всех\s+с\s+(?:инерц|колеб)|об[ъь]?ект\S*[\s\S]*(?:которых\s+есть|с\s+(?:инерц|колеб|анимац))/iu;
const contextualGroup =
  /эти(?:х|м)?(?:\s|$|[,;:])|предыдущ|тех\s+же|те\s+же|выделенн|selected/iu;
const explicitProjectFilter = (text: string) =>
  projectFilter.test(text) && !contextualGroup.test(text);
/** Derived from the effective committed history; never from model proposals or failed runs. */
export function recentSuccessfulActions(
  doc: MotionDocument,
  includeAnimations = false,
): RecentAction[] {
  const groups = new Map<string, RecentAction>();
  for (const entry of doc.history.slice(0, doc.cursor)) {
    const group =
      entry.request.match(/^\[([a-f0-9-]{36})\//)?.[1] ?? entry.editId;
    for (const op of includeAnimations ? entry.operations : []) {
      const id =
        op.type === "addAnimation" || op.type === "updateAnimation"
          ? op.animation.animationId
          : ["setDuration", "setStartFrame", "shiftAnimation"].includes(
                op.type,
              ) && "animationId" in op
            ? op.animationId
            : undefined;
      const a = id
        ? entry.after.animations.find((a) => a.animationId === id)
        : undefined;
      if (!a) continue;
      const key = group + "/" + a.effect;
      const action = groups.get(key) ?? {
        actionId: group,
        editIds: [],
        createdAt: entry.createdAt,
        effect: a.effect,
        expressionIds: [],
        animationIds: [],
        targets: [],
      };
      if (!action.editIds.includes(entry.editId))
        action.editIds.push(entry.editId);
      action.animationIds ??= [];
      if (!action.animationIds.includes(a.animationId)) {
        action.animationIds.push(a.animationId);
        action.targets.push({ sceneId: a.sceneId, targetId: a.targetId });
      }
      groups.delete(key);
      groups.set(key, action);
    }
    for (const op of entry.operations) {
      const ids =
        op.type === "setExpression"
          ? [op.expression.expressionId]
          : op.type === "scaleExpressionParameter"
            ? [op.expressionId]
            : [];
      for (const id of ids) {
        const e = entry.after.expressions?.find((e) => e.expressionId === id);
        if (!e) continue;
        const key = group + "/" + e.type,
          action = groups.get(key) ?? {
            actionId: group,
            editIds: [],
            createdAt: entry.createdAt,
            effect: e.type,
            expressionIds: [],
            targets: [],
          };
        if (!action.editIds.includes(entry.editId))
          action.editIds.push(entry.editId);
        if (!action.expressionIds.includes(id)) {
          action.expressionIds.push(id);
          action.targets.push({ sceneId: e.sceneId, targetId: e.targetId });
        }
        action.createdAt = entry.createdAt;
        groups.delete(key);
        groups.set(key, action);
      }
    }
  }
  return [...groups.values()].slice(-20).reverse();
}
export interface ReferenceContext {
  recentActions?: RecentAction[];
  projectRevision?: string;
  selectedObjectId?: string;
  selectedObjectIds?: string[];
  activeSceneId?: string;
}
/** Compatibility for old provider outputs only; new outputs use explicit structured selectors. */
function legacySelector(r: IntentRequirement): IntentRequirement["selector"] {
  if (
    r.target.sourceNodeId ||
    r.target.logicalObjectId ||
    (r.target.name &&
      !/^(их|эти|они|её|его|те же|предыдущие)$/iu.test(r.target.name.trim()))
  )
    return undefined;
  if (
    !r.techniques.includes("inertialOvershoot") ||
    (r.parameters.amplitudeFactor == null &&
      r.parameters.amplitude == null &&
      r.parameters.intensity == null)
  )
    return undefined;
  const text = r.sourceText;
  if (/выделенн/iu.test(text))
    return {
      type: "currentSelection" as const,
      effect: "inertialOvershoot" as const,
    };
  if (explicitProjectFilter(text))
    return {
      type: "byExistingEffect" as const,
      effect: "inertialOvershoot" as const,
      sceneId: /сцен|scene|фрейм|frame|здесь|тут/iu.test(text)
        ? r.sceneId
        : null,
    };
  if (r.sceneId && /сцен|scene|фрейм|frame|здесь|тут/iu.test(text))
    return {
      type: "byScene" as const,
      effect: "inertialOvershoot" as const,
      sceneId: r.sceneId,
    };
  return {
    type: "recentSuccessfulTargets" as const,
    effect: "inertialOvershoot" as const,
  };
}
export function resolveIntentSelectors(
  project: LoadedProject,
  state: MotionState,
  plan: IntentPlan,
  context: ReferenceContext,
  onResolution?: (v: unknown) => void,
) {
  // Revalidate a resolved plan from scratch; provider-supplied membership is never authority.
  const parents = new Map<string, IntentRequirement>();
  const aliases = new Map<string, string>();
  plan.requirements = plan.requirements.filter((r) => {
    if (!r.selectionRequirementId) return true;
    const parent = r.selectionRequirementId;
    aliases.set(r.requirementId, parent);
    if (parents.has(parent)) return false;
    parents.set(parent, r);
    r.requirementId = parent;
    r.selectionRequirementId = undefined;
    r.expressionIds = undefined;
    r.animationIds = undefined;
    r.target = { sourceNodeId: null, logicalObjectId: null, name: null };
    return true;
  });
  for (const row of plan.coverage)
    row.requirementIds = [
      ...new Set(row.requirementIds.map((id) => aliases.get(id) ?? id)),
    ];
  const expanded: IntentRequirement[] = [],
    objects = project.inspection.document.scenes.flatMap(objectsIn);
  const replacements = new Map<string, string[]>();
  for (const r of plan.requirements) {
    if (r.motionAction === "freezeProject") { expanded.push(r); continue; }
    const trackMembers = resolveTrackLifecycle(
      project,
      state,
      r,
      context,
      onResolution,
    );
    if (trackMembers) {
      expanded.push(...trackMembers);
      replacements.set(
        r.requirementId,
        trackMembers.map((m) => m.requirementId),
      );
      continue;
    }
    if (
      r.kind === "unsupported" &&
      r.unresolvedReason &&
      /unsupported (?:technique|operation|capability)|неподдерживаем|geometry|геометр|easing|keyframe|scope.*forbid/i.test(
        r.unresolvedReason,
      )
    ) {
      expanded.push(r);
      continue;
    }
    let selector = r.selector ?? legacySelector(r);
    if (selector && !selector.property && r.parameters.property)
      selector = { ...selector, property: r.parameters.property };
    const requestedSelector = r.selector;
    if (selector?.type === "explicitObject" && !selector.targetIds?.length &&
        (r.target.sourceNodeId || r.target.logicalObjectId || r.target.name)) {
      const found = resolveObjectReference(project, state, {
        referenceText: r.sourceText, name: r.target.name, sourceNodeId: r.target.sourceNodeId,
        logicalObjectId: r.target.logicalObjectId, sceneId: selector.sceneId ?? r.sceneId,
        selectedObjectId: context.selectedObjectId, activeSceneId: context.activeSceneId,
        techniques: r.techniques, preferExisting: true,
      });
      if (!found.target) {
        r.kind = "unsupported";
        r.unresolvedReason = found.status;
        expanded.push(r);
        onResolution?.({ event: "EXPLICIT_SELECTOR_BINDING", requirementId: r.requirementId, ...found });
        continue;
      }
      selector = { ...selector, sceneId: found.target.sceneId, targetIds: [found.target.sourceNodeId] };
      onResolution?.({ event: "EXPLICIT_SELECTOR_BINDING", requirementId: r.requirementId, ...found });
    }

    if (
      selector &&
      explicitProjectFilter(r.sourceText) &&
      (selector.type === "recentSuccessfulTargets" ||
        selector.type === "currentSelection" ||
        selector.base === "recentSuccessfulTargets" ||
        selector.base === "currentSelection")
    ) {
      selector = {
        ...selector,
        type: "byExistingEffect",
        base: "project",
        effect:
          selector.effect ??
          (r.techniques.includes("inertialOvershoot")
            ? "inertialOvershoot"
            : r.techniques.includes("wiggle")
              ? "wiggle"
              : undefined),
      };
    }
    if (
      selector?.type === "recentSuccessfulTargets" &&
      r.target.name &&
      objects.some(
        (o) => o.parentId && objectMentionRanges(o.name, r.sourceText).length,
      )
    ) {
      const named = resolveObjectReference(project, state, {
        referenceText: r.sourceText,
        name: r.target.name,
        sceneId: r.sceneId,
        sourceNodeId: r.target.sourceNodeId,
        activeSceneId: context.activeSceneId,
        selectedObjectId: context.selectedObjectId,
        techniques: r.techniques,
        preferExisting: true,
      });
      if (named.target)
        selector = {
          type: "explicitObject",
          effect: selector.effect,
          sceneId: named.target.sceneId,
          targetIds: [named.target.sourceNodeId],
        };
      else {
        r.kind = "unsupported";
        r.unresolvedReason =
          named.status === "AMBIGUOUS_TARGET"
            ? "AMBIGUOUS_CONTEXTUAL_REFERENCE"
            : "TARGET_NOT_FOUND";
        r.selector = selector;
        expanded.push(r);
        onResolution?.({
          event: "CONTEXTUAL_TARGET_RESOLUTION",
          requirementId: r.requirementId,
          status: r.unresolvedReason,
          source: "explicit-reference",
          candidates: named.candidates,
        });
        continue;
      }
    }
    if (
      !r.selector &&
      selector?.type === "recentSuccessfulTargets" &&
      objects.some(
        (o) => o.parentId && objectMentionRanges(o.name, r.sourceText).length,
      )
    ) {
      expanded.push(r);
      continue;
    }
    if (!selector || r.selectionRequirementId) {
      expanded.push(r);
      continue;
    }
    let matches = (state.expressions ?? []).filter(
      (e) =>
        (e.enabled || r.effectOperation?.storage === "expression") &&
        r.techniques.includes(
          e.type as IntentRequirement["techniques"][number],
        ) &&
        (!selector.effect || e.type === selector.effect) &&
        (!selector.property || e.property === selector.property),
    );
    const scene =
      selector.sceneId ?? (selector.type === "byScene" ? r.sceneId : undefined);
    if (scene) matches = matches.filter((e) => e.sceneId === scene);
    let actionId: string | undefined,
      reason: string | undefined,
      source: string = selector.type;
    if (
      ["byExistingEffect", "byAnimatedProperty", "filteredSet"].includes(
        selector.type,
      ) &&
      !scene &&
      selector.base !== "currentSelection" &&
      selector.base !== "recentSuccessfulTargets" &&
      ((selector.type === "byExistingEffect" && !selector.effect) ||
        !explicitProjectFilter(r.sourceText))
    )
      reason = "SELECTOR_SCOPE_NOT_AUTHORIZED";
    if (
      selector.type === "byScene" &&
      !/сцен|scene|здесь|тут/iu.test(r.sourceText)
    )
      reason = "SELECTOR_SCOPE_NOT_AUTHORIZED";
    if (
      selector.type === "explicitObject" &&
      selector.targetIds?.some(
        (id) =>
          !objects.some(
            (o) =>
              o.targetId === id &&
              (r.sourceText.includes(id) ||
                objectMentionRanges(o.name, r.sourceText).length),
          ),
      )
    )
      reason = "SELECTOR_SCOPE_NOT_AUTHORIZED";
    if (
      selector.type === "currentSelection" ||
      selector.base === "currentSelection"
    ) {
      const selected = new Set(
        context.selectedObjectIds ??
          (context.selectedObjectId ? [context.selectedObjectId] : []),
      );
      const selectionScene = context.selectedObjectIds?.length
        ? undefined
        : context.activeSceneId;
      matches = matches.filter(
        (e) =>
          selected.has(e.targetId) &&
          (!selectionScene || e.sceneId === selectionScene),
      );
    } else if (selector.type === "explicitObject") {
      matches = matches.filter((e) => selector.targetIds?.includes(e.targetId));
    } else if (
      selector.type === "recentSuccessfulTargets" ||
      selector.base === "recentSuccessfulTargets"
    ) {
      const recent = context.recentActions?.find((a) =>
        selector.effect
          ? a.effect === selector.effect
          : r.techniques.includes(
              a.effect as IntentRequirement["techniques"][number],
            ),
      );
      if (recent) {
        actionId = recent.actionId;
        const ids = new Set(recent.expressionIds);
        matches = matches.filter((e) => ids.has(e.expressionId));
      } else if (
        context.selectedObjectIds?.length ||
        context.selectedObjectId
      ) {
        const ids = new Set(
          context.selectedObjectIds ?? [context.selectedObjectId!],
        );
        matches = matches.filter((e) => ids.has(e.targetId));
        source = "currentSelection";
      } else {
        const local = context.activeSceneId
          ? matches.filter((e) => e.sceneId === context.activeSceneId)
          : matches;
        const targets = new Set(local.map((e) => e.sceneId + "/" + e.targetId));
        if (targets.size === 1) {
          matches = local;
          source = context.activeSceneId
            ? "activeSceneUniqueTarget"
            : "uniqueExistingTarget";
        } else {
          reason = targets.size
            ? "AMBIGUOUS_CONTEXTUAL_REFERENCE"
            : "IMPLICIT_REFERENCE_UNRESOLVED";
          matches = [];
        }
      }
    } else if (
      ![
        "byExistingEffect",
        "byAnimatedProperty",
        "byScene",
        "filteredSet",
      ].includes(selector.type)
    )
      reason = "SELECTOR_UNSUPPORTED";
    if (selector.type === "byScene" && !scene) reason = "SELECTOR_UNSUPPORTED";
    if (selector.type === "byAnimatedProperty" && !selector.property)
      reason = "SELECTOR_UNSUPPORTED";
    if (
      selector.type === "filteredSet" &&
      !selector.effect &&
      !selector.property &&
      !scene
    )
      reason = "SELECTOR_UNSUPPORTED";
    if (!matches.length && !reason) reason = "NO_MATCHING_EXISTING_EFFECTS";
    if (
      matches.some(
        (e) =>
          !objects.some(
            (o) => o.sceneId === e.sceneId && o.targetId === e.targetId,
          ),
      )
    )
      reason = "TARGET_NOT_FOUND";
    const sets = new Map<string, typeof matches>();
    for (const e of matches) {
      const key = e.sceneId + "/" + e.targetId;
      sets.set(key, [...(sets.get(key) ?? []), e]);
    }
    if (sets.size > 200) {
      reason = "SELECTOR_UNSUPPORTED_BATCH_LIMIT";
      sets.clear();
    }
    const diagnostic = {
      requirementId: r.requirementId,
      referenceType:
        selector.type === "recentSuccessfulTargets" ||
        selector.base === "recentSuccessfulTargets"
          ? "IMPLICIT"
          : "EXPLICIT_SELECTOR",
      selector,
      requestedSelector,
      source,
      actionId,
      projectRevision: context.projectRevision,
      status: reason ?? "RESOLVED",
      selectedObjectCount: reason ? 0 : sets.size,
      selectedExpressionCount: reason ? 0 : matches.length,
      candidateExpressionCount: matches.length,
      members: matches.map((e) => ({
        sceneId: e.sceneId,
        targetId: e.targetId,
        canonicalName: objects.find(
          (o) => o.sceneId === e.sceneId && o.targetId === e.targetId,
        )?.name,
        expressionId: e.expressionId,
        oldAmplitude: e.parameters.amplitude,
        newAmplitude:
          r.parameters.amplitudeFactor != null
            ? e.parameters.amplitude * r.parameters.amplitudeFactor
            : r.parameters.amplitude,
        property: e.property,
      })),
    };
    onResolution?.({ event: "CONTEXTUAL_TARGET_RESOLUTION", ...diagnostic });
    if (reason) {
      r.kind = "unsupported";
      r.unresolvedReason = reason;
      r.selector = selector;
      expanded.push(r);
      continue;
    }
    const ids: string[] = [];
    for (const [key, expressions] of sets) {
      const e = expressions[0],
        object = objects.find(
          (o) => o.sceneId === e.sceneId && o.targetId === e.targetId,
        );
      if (!object) {
        reason = "TARGET_NOT_FOUND";
        break;
      }
      const id =
        r.requirementId.slice(0, 70) +
        "_" +
        createHash("sha256").update(key).digest("hex").slice(0, 16);
      ids.push(id);
      expanded.push({
        ...structuredClone(r),
        requirementId: id,
        kind: "editAnimation",
        sceneId: e.sceneId,
        target: {
          sourceNodeId: e.targetId,
          logicalObjectId: null,
          name: object.name,
        },
        selector,
        selectionRequirementId: r.requirementId,
        expressionIds: expressions.map((e) => e.expressionId),
        unresolvedReason: null,
        timing: { ...r.timing, relation: "unchanged" },
      });
    }
    replacements.set(r.requirementId, ids);
  }
  plan.requirements = expanded;
  for (const row of plan.coverage) {
    row.requirementIds = row.requirementIds.flatMap(
      (id) => replacements.get(id) ?? [id],
    );
    if (
      row.classification === "unsupported" &&
      row.requirementIds.every(
        (id) =>
          expanded.find((r) => r.requirementId === id)?.kind !== "unsupported",
      )
    )
      row.classification = "executable";
  }
  return plan;
}

/** Storage routing uses the canonical capability bindings, never the presence of expressions. */
function resolveTrackLifecycle(
  project: LoadedProject,
  state: MotionState,
  r: IntentRequirement,
  context: ReferenceContext,
  onResolution?: (v: unknown) => void,
): IntentRequirement[] | false {
  const kinds = new Set(r.techniques.map((t) => semanticBindings[t]));
  // A logical state transition is a canonical animation entry, not a node animation track.
  if (kinds.has("transition") && !kinds.has("animation")) {
    if (r.effectOperation?.action === "update" && r.effectOperation.storage === "animation")
      r.effectOperation = { storage: "transition", action: "update" };
    if (r.effectOperation?.storage === "transition") return false;
  }

  if (r.effectOperation?.storage === "expression") {
    if (kinds.has("animation")) {
      r.kind = "unsupported";
      r.unresolvedReason =
        "UNSUPPORTED_EFFECT_OPERATION: capability storage mismatch";
      return [r];
    }
    r.expressionAction = r.effectOperation.action;
  }
  // Historical graph encoded all deletions as expressionAction; migrate only provably track-only intents.
  if (
    !r.effectOperation &&
    r.expressionAction &&
    kinds.size === 1 &&
    kinds.has("animation")
  ) {
    r.effectOperation = { storage: "animation", action: r.expressionAction };
    delete r.expressionAction;
  }
  if (r.effectOperation?.storage !== "animation") return false;
  const fail = (status: string) => {
    r.kind = "unsupported";
    r.unresolvedReason = status;
    onResolution?.({
      event: "EFFECT_LIFECYCLE_RESOLUTION",
      requirementId: r.requirementId,
      status,
      storage: "animation",
      objects: targets.map((o) => ({
        sceneId: o.sceneId,
        targetId: o.targetId,
      })),
      objectResolution: {
        status: targets.length ? "RESOLVED" : "OBJECT_NOT_FOUND",
        count: targets.length,
      },
      effectResolution: {
        storage: "animation",
        status,
        matchedAnimationIds: [],
      },
      selectedObjectCount: targets.length,
      selectedAnimationCount: 0,
      expressionLookup: "NOT_APPLICABLE",
    });
    return [r];
  };
  let targets = project.inspection.document.scenes
    .flatMap(objectsIn)
    .filter((o) => o.parentId);
  let selector = r.selector;
  if (selector?.targetIds?.length && (r.target.name || r.target.sourceNodeId)) {
    const resolved = resolveObjectReference(project, state, {
      name: r.target.name,
      sourceNodeId: r.target.sourceNodeId,
      sceneId: r.sceneId,
      referenceText: r.sourceText,
      techniques: r.techniques,
      preferExisting: true,
    });
    if (
      resolved.target &&
      selector.targetIds.includes(resolved.target.sourceNodeId)
    )
      selector = {
        type: "explicitObject",
        targetIds: [resolved.target.sourceNodeId],
        sceneId: resolved.target.sceneId,
        effect: selector.effect,
      };
  }
  let recentIds: Set<string> | undefined;
  if (
    selector?.effect &&
    !r.techniques.includes(
      selector.effect as IntentRequirement["techniques"][number],
    )
  )
    return fail("UNSUPPORTED_EFFECT_OPERATION");
  if (
    selector?.type === "filteredSet" ||
    selector?.type === "byAnimatedProperty"
  )
    return fail("SELECTOR_UNSUPPORTED");
  const scene = selector?.sceneId ?? r.sceneId;
  if (scene) targets = targets.filter((o) => o.sceneId === scene);
  if (r.target.sourceNodeId)
    targets = targets.filter((o) => o.targetId === r.target.sourceNodeId);
  else if (selector?.type === "explicitObject")
    targets = targets.filter((o) => selector.targetIds?.includes(o.targetId));
  else if (selector?.type === "currentSelection")
    targets = targets.filter((o) =>
      (context.selectedObjectIds ?? [context.selectedObjectId]).includes(
        o.targetId,
      ),
    );
  else if (selector?.type === "recentSuccessfulTargets") {
    const recent = context.recentActions?.find(
      (a) =>
        r.techniques.includes(
          a.effect as IntentRequirement["techniques"][number],
        ) && a.animationIds?.length,
    );
    if (!recent) return fail("IMPLICIT_REFERENCE_UNRESOLVED");
    recentIds = new Set(recent.animationIds);
    targets = targets.filter((o) =>
      recent.targets.some(
        (t) => t.targetId === o.targetId && t.sceneId === o.sceneId,
      ),
    );
  } else if (
    selector?.type === "byExistingEffect" ||
    selector?.type === "byScene"
  ) {
    if (
      selector.type === "byScene"
        ? !scene || !/сцен|scene|здесь|тут/iu.test(r.sourceText)
        : !explicitProjectFilter(r.sourceText)
    )
      return fail("SELECTOR_SCOPE_NOT_AUTHORIZED");
    const matching = targets.filter((o) =>
      state.animations.some(
        (a) =>
          a.sceneId === o.sceneId &&
          a.targetId === o.targetId &&
          r.techniques.includes(
            a.effect as IntentRequirement["techniques"][number],
          ),
      ),
    );
    if (!matching.length) return fail("ANIMATION_TRACK_NOT_FOUND");
    targets = matching;
  } else {
    const result = resolveObjectReference(project, state, {
      name: r.target.name,
      sourceNodeId: r.target.sourceNodeId,
      sceneId: r.sceneId,
      referenceText: r.sourceText,
      activeSceneId: context.activeSceneId,
      selectedObjectId: context.selectedObjectId,
      techniques: r.techniques,
      preferExisting: true,
    });
    if (!result.target) {
      targets = [];
      return fail(
        result.status === "AMBIGUOUS_TARGET"
          ? "AMBIGUOUS_EFFECT_MATCH"
          : "OBJECT_NOT_FOUND",
      );
    }
    targets = targets.filter(
      (o) =>
        o.targetId === result.target!.sourceNodeId &&
        o.sceneId === result.target!.sceneId,
    );
  }
  if (recentIds)
    targets = targets.filter((o) =>
      state.animations.some(
        (a) =>
          recentIds!.has(a.animationId) &&
          a.sceneId === o.sceneId &&
          a.targetId === o.targetId,
      ),
    );
  if (r.techniques.length && (kinds.size !== 1 || !kinds.has("animation")))
    return fail("UNSUPPORTED_EFFECT_OPERATION");
  if (!targets.length) return fail("OBJECT_NOT_FOUND");
  if (targets.length > 200) return fail("SELECTOR_UNSUPPORTED_BATCH_LIMIT");
  const members: IntentRequirement[] = [];
  for (const target of targets) {
    const tracks = state.animations.filter(
      (a) =>
        a.sceneId === target.sceneId &&
        a.targetId === target.targetId &&
        (!r.techniques.length ||
          r.techniques.includes(
            a.effect as IntentRequirement["techniques"][number],
          )),
    );
    if (r.techniques.some((t) => !tracks.some((a) => a.effect === t)))
      return fail("ANIMATION_TRACK_NOT_FOUND");
    // Multiple tracks for an effect have independent intervals; never silently pick or delete one.
    if (
      r.techniques.some((t) => tracks.filter((a) => a.effect === t).length > 1)
    )
      return fail("AMBIGUOUS_EFFECT_MATCH");
    if (!r.techniques.length) {
      if (tracks.length !== 1 &&
          !(r.effectOperation?.action === "updateTiming" && isSynchronizedTrackSet(tracks)))
        return fail("AMBIGUOUS_EFFECT_MATCH");
      if (
        !(tracks[0].effect in semanticBindings) &&
        r.effectOperation?.action !== "updateTiming"
      )
        return fail("UNSUPPORTED_EFFECT_OPERATION");
    }
    const member = structuredClone(r);
    if (!member.techniques.length)
      member.techniques = [...new Set(tracks
        .filter(track => track.effect in semanticBindings)
        .map(track => track.effect as IntentRequirement["techniques"][number]))];
    member.kind = "editAnimation";
    member.unresolvedReason = null;
    member.sceneId = target.sceneId;
    member.target = {
      sourceNodeId: target.targetId,
      name: target.name,
      logicalObjectId: r.target.logicalObjectId,
    };
    member.animationIds = tracks.map((a) => a.animationId);
    delete member.expressionAction;
    delete member.expressionIds;
    if (targets.length > 1) {
      member.selectionRequirementId = r.requirementId;
      member.requirementId =
        "trackset_" +
        createHash("sha256")
          .update(
            r.requirementId + "/" + target.sceneId + "/" + target.targetId,
          )
          .digest("hex")
          .slice(0, 24);
    }
    members.push(member);
    onResolution?.({
      event: "EFFECT_LIFECYCLE_RESOLUTION",
      requirementId: r.requirementId,
      status: "RESOLVED",
      storage: "animation",
      objectResolution: { status: "RESOLVED", count: 1 },
      effectResolution: {
        storage: "animation",
        status: "RESOLVED",
        matchedAnimationIds: member.animationIds,
      },
      selectedObjectCount: 1,
      selectedAnimationCount: tracks.length,
      objects: [{ targetId: target.targetId, sceneId: target.sceneId }],
      animationIds: member.animationIds,
      expressionLookup: "NOT_APPLICABLE",
      operation: r.effectOperation.action,
      dependencies: state.timingDependencies?.filter(
        (d) =>
          member.animationIds!.includes(d.animationId) ||
          member.animationIds!.includes(d.anchorAnimationId),
      ),
    });
  }
  return members;
}
